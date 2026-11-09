// End to end, no network: "ask the call" and "Catch me up" through the real call loop (src/run.ts) with scripted speech and the policy fake model.
// The control channel (stdin lines `ask <text>` and `recap`) is what the tray app writes when the user presses the hotkey or the CLI sends a command.
// The test writes session.json into the call folder (the memory loop of another package does that in a real call).
import "../test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWav } from "../audio.ts";
import { policyModel, error } from "../testkit/policy-model.ts";
import { registerRole } from "../testkit/prompt.ts";
import { ASK_MARK, RECAP_MARK } from "../session/ask.ts";
import { applyPatch } from "../session/patch.ts";
import { saveMemory } from "../session/store.ts";
import { emptyMemory } from "../session/types.ts";
import { callDir, Q, readRows, runEngine, scriptFile, sleep, until } from "./helpers.ts";

registerRole("ask", ASK_MARK);
registerRole("ask", RECAP_MARK);

const MEM = applyPatch(
  emptyMemory(1, "client"),
  {
    topic: "Warehouse move",
    add: {
      facts: [{ text: "The Dover warehouse closes for inventory on the ninth of March" }],
      commitments: [{ who: "me", what: "send the plan" }],
      openQuestions: [{ asker: "them", text: "Can the old site stay online?" }],
    },
  },
  { now: 2 },
).mem;

async function run(rules: (pm: ReturnType<typeof policyModel>) => void, extraEnv: Record<string, string> = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "wingman-e2e-ask-"));
  const calls = join(tmp, "calls");
  const wav = join(tmp, "silence.wav");
  await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 14), 2);
  const pm = policyModel({ strict: false, fallback: "SKIP" });
  rules(pm);
  const policy = join(tmp, "policy.json");
  writeFileSync(policy, JSON.stringify(pm.toJSON()));
  const e = runEngine(
    ["--file", wav, "--set", "ui.language=en"],
    {
      WINGMAN_CONTROL: "1",
      WINGMAN_STT_SCRIPT: scriptFile(tmp, [Q("them", "The warehouse inventory is on the ninth.", 600), Q("me", "Good, I will send the plan.", 1800)]),
      WINGMAN_POLICY_FILE: policy,
      WINGMAN_POLICY_LOG: join(tmp, "policy-calls.jsonl"),
      WINGMAN_CALLS_DIR: calls,
      ...extraEnv,
    },
    "e2e-policy",
  );
  // wait for the call folder and two transcript lines, give the engine its memory, then send the commands the tray would send
  await until(() => existsSync(calls) && !!callDir(calls) && readRows(callDir(calls), "transcript.jsonl").length >= 2, 12_000);
  const dir = callDir(calls);
  saveMemory(dir, MEM);
  return { tmp, dir, e, send: (l: string) => e.p.stdin!.write(l + "\n"), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

test(
  "e2e: recap and a typed ask are answered from the memory, the cards and rows are written, cost is booked under role ask",
  { timeout: 60_000 },
  async () => {
    const r = await run((pm) => {
      pm.reply(
        { role: "ask", user: "Catch me up" },
        "WHERE: Planning the warehouse move\nDECIDED: NONE\nOPEN: Can the old site stay online?\nPROMISED: send the plan\nASKED: Can the old site stay online?\n",
        { ms: 100 },
      );
      pm.reply({ role: "ask", user: "Dover" }, "SRC: call\nANSWER: The Dover warehouse closes on the ninth of March.", { ms: 100 });
    });
    try {
      r.send("recap");
      r.send("ask when does the Dover warehouse close?");
      const code = await r.e.done;
      assert.equal(code, 0, r.e.out());
      const ev = readRows(r.dir, "events.jsonl");
      const rc = ev.find((x) => x.type === "recap.done");
      assert.ok(rc, "recap.done written");
      assert.equal(rc.ai, true);
      assert.deepEqual(rc.recap.promised, ["send the plan"]);
      const ad = ev.find((x) => x.type === "ask.done");
      assert.ok(ad, "ask.done written");
      assert.match(ad.text, /ninth of March/);
      const cards = readRows(r.dir, "cards.jsonl");
      assert.ok(
        cards.some((c) => c.type === "card" && /ninth of March/.test(c.say) && c.done),
        "the answer card is on screen",
      );
      const views = cards.filter((c) => c.type === "view" && c.recap);
      assert.ok(views.length >= 1 && views.at(-1).recap.where === "Planning the warehouse move" && views.at(-1).showRecap === true, "the overlay sheet row");
      const usage = readRows(r.dir, "usage.jsonl").filter((u) => u.role === "ask");
      assert.equal(usage.length, 2, "two ask-role model calls");
      const calls = readRows(r.tmp, "policy-calls.jsonl").filter((c) => c.role === "ask");
      assert.equal(calls.length, 2);
    } finally {
      r.cleanup();
    }
  },
);

test("e2e: with the model returning 529 an ask still shows a card from the notes, never an empty screen", { timeout: 60_000 }, async () => {
  const r = await run((pm) => pm.on({ role: "ask" }, error(529)));
  try {
    r.send("ask when does the Dover warehouse close?");
    r.send("recap");
    await until(
      () => readRows(r.dir, "events.jsonl").some((x) => x.type === "ask.done") && readRows(r.dir, "events.jsonl").some((x) => x.type === "recap.done"),
      20_000,
    );
    await sleep(100);
    const ev = readRows(r.dir, "events.jsonl");
    const ad = ev.find((x) => x.type === "ask.done");
    assert.equal(ad.ai, false);
    assert.match(ad.text, /^AI offline: from notes: .*Dover/);
    const cards = readRows(r.dir, "cards.jsonl");
    assert.ok(cards.some((c) => c.type === "card" && /AI offline: from notes/.test(c.say)));
    const rc = ev.find((x) => x.type === "recap.done");
    assert.equal(rc.ai, false);
    assert.deepEqual(rc.recap.promised, ["send the plan"]);
    r.e.p.kill("SIGINT");
    await r.e.done;
  } finally {
    r.cleanup();
  }
});

test("e2e: an ask that is still being answered when Stop comes puts no card on the screen afterwards", { timeout: 60_000 }, async () => {
  const r = await run(
    (pm) => pm.reply({ role: "ask", user: "Dover" }, "SRC: call\nANSWER: The Dover warehouse closes on the ninth of March.", { ms: 1500 }),
    { WINGMAN_TEST_SLOW_STOPS: "1x3500" }, // Stop takes 3.5 s, so the answer would land in the middle of it
  );
  try {
    r.send("ask when does the Dover warehouse close?");
    await sleep(200);
    r.send("stop");
    const code = await r.e.done;
    assert.equal(code, 0, r.e.out());
    const askCards = readRows(r.dir, "cards.jsonl").filter((c) => c.type === "card" && String(c.id).endsWith("-me"));
    assert.deepEqual(askCards, [], "no ask card was written after Stop");
  } finally {
    r.cleanup();
  }
});
