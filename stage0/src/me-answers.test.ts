// End-to-end, no network: Dan's own questions (the "me" channel) through the real call loop with scripted STT and a scripted model.
//   "כמה זה 36 ועוד 42?"        -> a "For you" card with 78 (local arithmetic, no model)
//   "מה התקציב שלכם?"           -> asked to the other person: no card
//   "מה ההבדל בין CDN ל-DNS?"   -> a "For you" AI card
//   the ask key (stdin: ask)    -> the next sentence is for Wingman even though its words say "other person"
//   the other side asks "כמה זה 12 כפול 3?" -> a calc card, never the price stall line; "כמה זה עולה לאתר" still gets the stall
//   a Telugu final             -> dropped and counted
//   a "For you" answer within 15 s of a card for the other side -> held back
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./env.ts";
import { writeWav } from "./audio.ts";
import { tsx } from "./test-platform.ts";

test("e2e: answers for Dan's own questions, the ask key, math is not a price, foreign script dropped", { timeout: 80_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wingman-e2e-me-"));
  const wav = join(tmp, "silence.wav"),
    CALLS = join(tmp, "calls"); // own calls folder: other test runs on this machine delete from the shared one
  await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 16), 2);
  const child = spawn(...tsx([join(ROOT, "src", "run.ts"), "--profile", "e2e-me", "--file", wav, "--no-brief"]), {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      WINGMAN_CONTROL: "1",
      WINGMAN_STT_SCRIPT: join(ROOT, "data", "test", "e2e-me-call.json"),
      WINGMAN_SCRIPT_GAP_MS: "1100",
      WINGMAN_CALL_APP: "none",
      WINGMAN_CALLS_DIR: CALLS,
    },
  });
  let out = "",
    err = "",
    asked = false;
  child.stdout.on("data", (d) => {
    out += d.toString();
    // The ask key is pressed once the CDN answer is on screen; the next sentence ("can you tell me about the flight to Tokyo") then belongs to Wingman.
    if (!asked && /CDN מפיץ/.test(out)) {
      asked = true;
      child.stdin.write("ask\n");
    }
  });
  child.stderr.on("data", (d) => (err += d.toString()));
  const code: number | null = await new Promise((res) => child.on("exit", res));
  assert.equal(code, 0, `run.ts exited ${code}\n${out}\n${err}`);
  const dir = join(CALLS, readlinkSync(join(CALLS, "latest")));
  try {
    const rows = (f: string) =>
      existsSync(join(dir, f))
        ? readFileSync(join(dir, f), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
    const cards = rows("cards.jsonl"),
      events = rows("events.jsonl"),
      transcript = rows("transcript.jsonl");
    const me = cards.filter((c) => c.type === "card" && c.badge === "me" && !c.withdraw);
    const decisions = events.filter((e) => e.type === "me.decision");

    // 78
    const calc = me.find((c) => c.source === "calc");
    assert.ok(
      calc && /36 \+ 42 = 78/.test(calc.say) && calc.forMe === true && /^m\d+$/.test(calc.turnId),
      `a For-you card with 78: ${JSON.stringify(me.map((c) => c.say))}\n${dir}\n${out}\n${err}`,
    );
    // a question for the other person: no card, decision logged
    assert.ok(!me.some((c) => /התקציב/.test(c.question)), "no card for a question asked to the other person");
    assert.ok(
      decisions.some((d) => /התקציב/.test(d.text) && d.decision === "skip" && /^other:/.test(d.why)),
      `skipped as other: ${JSON.stringify(decisions)}`,
    );
    // a general-knowledge question: AI card
    const cdn = me.find((c) => /CDN/.test(c.say));
    assert.ok(cdn && cdn.source === "ai", "an AI For-you card for the CDN question");
    // the ask key
    assert.ok(
      events.some((e) => e.type === "ask.armed"),
      "ask armed",
    );
    const askRows = cards.filter((c) => c.type === "ask");
    assert.ok(askRows.length >= 2 && askRows[0].on === true && askRows.at(-1).on === false, "overlay ask rows: on, then off once used");
    const tokyo = me.find((c) => /טוקיו/.test(c.say));
    assert.ok(tokyo, "the asked sentence got an answer although its words address the other person");
    assert.ok(
      decisions.some((d) => /טוקיו/.test(d.text) && d.decision === "answer" && d.why === "hotkey"),
      "decision: hotkey",
    );
    // math from the other side is a calc card, not the price stall; a real price question still stalls
    const themCalc = cards.find((c) => c.type === "card" && c.source === "calc" && c.badge === "ai");
    assert.ok(themCalc && /12 × 3 = 36/.test(themCalc.say), "calc card for the other side's arithmetic");
    const mathTurn = themCalc.turnId;
    assert.ok(!cards.some((c) => c.type === "card" && c.turnId === mathTurn && (c.badge === "stall" || c.badge === "bank")), "no price stall on arithmetic");
    assert.ok(
      cards.some((c) => c.type === "card" && c.badge === "bank" && /המחיר תלוי|הצעה/.test(c.say)),
      "the price stall card still fires for a real price question",
    );
    // a For-you answer right after a card for the other side is held back
    assert.ok(
      decisions.some((d) => /הבירה/.test(d.text) && d.decision === "skip" && d.why === "protect-them"),
      `held back: ${JSON.stringify(decisions.filter((d) => /הבירה/.test(d.text)))}`,
    );
    assert.ok(!me.some((c) => /קנברה/.test(c.say)), "no Canberra card");
    // Telugu is dropped, counted and never in the transcript
    assert.ok(
      events.some((e) => e.type === "stt.foreign-script"),
      "foreign-script event",
    );
    assert.equal(events.find((e) => e.type === "foreign.summary")?.dropped, 1);
    assert.ok(!transcript.some((t) => /[ఀ-౿]/.test(t.text)), "no Telugu in the transcript");
    // the model only saw one For-you question per card (cost row exists) and the call closed cleanly
    assert.ok(
      events.some((e) => e.type === "me.summary" && e.answers >= 3),
      "me.summary",
    );
    assert.ok(
      events.some((e) => e.type === "speed.summary"),
      "closed cleanly",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
