// How an ask and a recap reach the screen, and how the hotkey and the control socket reach the engine. No engine process, no real hotkey:
// the flow gets plain functions, the tray controller gets a fake child, the socket is a temp socket.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import net from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "./providers/llm.ts";
import type { Keys } from "./env.ts";
import { policyModel, error, hang, type PolicyModel } from "./testkit/policy-model.ts";
import { registerRole } from "./testkit/prompt.ts";
import { ASK_MARK, RECAP_MARK, type AskEnv } from "./session/ask.ts";
import { answerAsk, showRecap, viewRow, type FlowDeps } from "./session/askflow.ts";
import { applyPatch } from "./session/patch.ts";
import { emptyMemory } from "./session/types.ts";
import { audienceByCues, decideAudience } from "./assist.ts";
import { ROOT } from "./env.ts";
import type { Card } from "./engine/cards.ts";

registerRole("ask", ASK_MARK);
registerRole("ask", RECAP_MARK);

const REF = "anthropic:claude-haiku-5-5";
const reg = (pm: PolicyModel) => new ModelRegistry({ anthropic: "k" } as unknown as Keys, async () => ({ createAnthropic: () => () => pm.model }));
const mem = applyPatch(
  emptyMemory(1, "client"),
  {
    topic: "Hosting",
    add: {
      facts: [{ text: "The shop has 1,200 products" }],
      commitments: [{ who: "me", what: "send the plan" }],
      openQuestions: [{ asker: "them", text: "Can the old site stay up?" }],
    },
  },
  { now: 2 },
).mem;

function rig(pm: PolicyModel, o: { models?: string[]; memory?: typeof mem; timeoutMs?: number } = {}) {
  const cards: Card[] = [],
    rows: { stream: string; row: Record<string, unknown> }[] = [],
    costs: string[] = [];
  let n = 0;
  const labels = {
    offline: "AI offline: from notes",
    noCall: "Not in the call.",
    nothing: "Nothing to search.",
    error: "Could not answer.",
    recapEmpty: "Nothing yet.",
  };
  const env = (): AskEnv => ({
    registry: reg(pm),
    models: o.models ?? [REF],
    memory: o.memory ?? mem,
    lines: [{ side: "them", text: "The shop has about 1,200 products." }],
    labels,
    cfg: { timeoutMs: o.timeoutMs ?? 2000 },
  });
  const d: FlowDeps = {
    env,
    emit: (c) => cards.push({ ...c }),
    log: (stream, row) => rows.push({ stream, row }),
    addCost: (role) => (costs.push(role), { usd: 0.0003 }),
    now: () => Date.now(),
    seq: () => ++n,
    labels,
    recapLabel: (k) => k,
    throttleMs: 0,
  };
  return { d, cards, rows, costs };
}

// ---------- ask: always a card ----------
test("ask flow: a streamed answer, a done card, one cost row under role ask, an ask.done event", async () => {
  const pm = policyModel({ usage: { input: 1500, output: 25 } });
  pm.reply({ role: "ask" }, "SRC: call\nANSWER: About 1,200 products.", { chunks: 3, chunkMs: 5 });
  const r = rig(pm);
  await answerAsk(r.d, "how many products?");
  const last = r.cards.at(-1)!;
  assert.equal(last.say, "About 1,200 products.");
  assert.equal(last.done, true);
  assert.equal(last.badge, "me");
  assert.equal(last.forMe, true);
  assert.ok(r.cards.length >= 2 && r.cards[0].done === false, "streamed updates came first");
  assert.equal(new Set(r.cards.map((c) => c.id)).size, 1, "one card, updated");
  assert.deepEqual(r.costs, ["ask"]);
  assert.equal(r.rows.find((x) => x.stream === "events" && x.row.type === "ask.done")?.row.ai, true);
  const u = r.rows.find((x) => x.stream === "usage")!.row;
  assert.equal(u.role, "ask");
  assert.ok((u.ctx as { role: string }).role === "ask", "the context record is logged");
});

test("ask flow: a 529, a hang, no models and garbage each end in a card", async () => {
  for (const [name, setup, opts] of [
    ["529", (pm: PolicyModel) => pm.on({ role: "ask" }, error(529)), {}],
    ["hang", (pm: PolicyModel) => pm.on({ role: "ask" }, hang()), { timeoutMs: 60 }],
    ["garbage", (pm: PolicyModel) => pm.reply({ role: "ask" }, "I cannot do that."), {}],
    ["no models", () => {}, { models: [] }],
  ] as [string, (pm: PolicyModel) => void, { models?: string[]; timeoutMs?: number }][]) {
    const pm = policyModel();
    setup(pm);
    const r = rig(pm, opts);
    await answerAsk(r.d, "how many products does the shop have?");
    assert.ok(r.cards.length >= 1, name);
    const c = r.cards.at(-1)!;
    assert.equal(c.done, true, name);
    assert.ok(c.say.length > 0, name);
    assert.match(c.say, /^AI offline: from notes: .*1,200/, name);
    assert.equal(r.rows.find((x) => x.row.type === "ask.done")?.row.ai, false, name);
  }
});

test("ask flow: nothing in the notes says so; arithmetic is local with no model; an empty question gets a line; the last net catches a thrown error", async () => {
  const pm = policyModel();
  pm.on({ role: "ask" }, error(529));
  const a = rig(pm);
  await answerAsk(a.d, "zebra giraffe");
  assert.equal(a.cards.at(-1)!.say, "Nothing to search.");
  const b = rig(pm);
  await answerAsk(b.d, "what is 12 times 3?");
  assert.equal(b.cards.at(-1)!.source, "calc");
  assert.equal(pm.callsFor("ask").length, 1, "only the first ask reached the model; the arithmetic and the empty question did not");
  const c = rig(pm);
  await answerAsk(c.d, "   ");
  assert.equal(c.cards.at(-1)!.say, "Nothing to search.");
  const d = rig(pm);
  d.d.env = () => {
    throw new Error("boom");
  };
  await answerAsk(d.d, "anything");
  assert.equal(d.cards.at(-1)!.say, "Could not answer.");
  assert.equal(d.rows.find((x) => x.row.type === "ask.error")?.stream, "events");
});

// ---------- recap rows ----------
test("recap flow: view rows stream in (open the sheet), a final row, recap.done; no card when it worked", async () => {
  const pm = policyModel();
  pm.reply({ role: "ask" }, "WHERE: Hosting\nDECIDED: NONE\nOPEN: Can the old site stay up?\nPROMISED: send the plan\nASKED: Can the old site stay up?\n", {
    chunks: 5,
    chunkMs: 5,
  });
  const r = rig(pm);
  await showRecap(r.d);
  const views = r.rows.filter((x) => x.stream === "cards" && x.row.type === "view").map((x) => x.row);
  assert.ok(views.length >= 3, "line by line");
  assert.ok(views.every((v) => v.showRecap === true));
  const last = views.at(-1)! as { recap: { where: string; promised: string[] }; ai: string; open: string[]; promises: string[] };
  assert.equal(last.recap.where, "Hosting");
  assert.deepEqual(last.recap.promised, ["send the plan"]);
  assert.equal(last.ai, "ok");
  assert.deepEqual(last.open, ["Can the old site stay up?"], "the view row also carries the memory chips");
  assert.deepEqual(last.promises, ["send the plan"]);
  assert.equal(
    r.rows.some((x) => x.row.type === "recap.done"),
    true,
  );
  assert.equal(r.cards.length, 0);
  assert.deepEqual(r.costs, ["ask"]);
});

test("recap flow: AI down gives the sheet from the memory plus one card that says so; an empty call says there is nothing", async () => {
  const pm = policyModel();
  pm.on({ role: "ask" }, error(529));
  const r = rig(pm);
  await showRecap(r.d);
  const last = r.rows.filter((x) => x.row.type === "view").at(-1)!.row as { ai: string; recap: { promised: string[] } };
  assert.equal(last.ai, "offline");
  assert.deepEqual(last.recap.promised, ["send the plan"]);
  assert.equal(r.cards.length, 1);
  assert.match(r.cards[0].say, /^AI offline: from notes\n/);
  const e = rig(pm, { memory: emptyMemory(0) });
  e.d.env = () => ({ ...rig(pm, { memory: emptyMemory(0) }).d.env(), lines: [] });
  await showRecap(e.d);
  assert.equal(e.cards.at(-1)!.say, "Nothing yet.");
});

test("viewRow: the shape the overlay's normView reads", () => {
  const row = viewRow(mem, { where: "W", decided: [], open: [], promised: ["x"], asked: [] }, "ok", 5, true);
  const v2 = createRequire(import.meta.url)("../overlay/v2.js") as {
    normView(r: unknown): { topic: string; open: string[]; promises: string[]; recap: { where: string; promised: string[] }; ai: string };
  };
  const n = v2.normView(row);
  assert.equal(n.topic, "Hosting");
  assert.deepEqual(n.open, ["Can the old site stay up?"]);
  assert.deepEqual(n.promises, ["send the plan"]);
  assert.equal(n.recap.where, "W");
  assert.equal(n.ai, "ok");
});

// ---------- who is it for: the model decides, the lists are the offline fallback ----------
test("audience: with a model the phrase lists do not decide; offline they still do", () => {
  const he = "מה דעתך על המחיר";
  const en = "can you send me the offer?";
  assert.equal(audienceByCues(he).audience, "other", "default (lists on): unchanged");
  assert.equal(audienceByCues(en).audience, "other");
  for (const t of [he, en, "what does DNS mean", "how do you say invoice in Hebrew"]) {
    const c = audienceByCues(t, { useLists: false });
    assert.equal(c.audience, "unsure", t);
    assert.equal(c.reason, "model");
  }
  // language-free cues still work without the lists
  assert.equal(audienceByCues("anything", { forced: true, useLists: false }).audience, "assistant");
  assert.equal(audienceByCues("12 times 3", { useLists: false }).audience, "assistant");
  assert.equal(audienceByCues("hey wingman what time is it", { useLists: false }).audience, "assistant");
  // the model's verdict then decides
  const cue = audienceByCues(en, { useLists: false });
  assert.equal(decideAudience(cue, { verdict: "OTHER", themQuietMs: 0, solo: false, quietNeededMs: 4000 }).answer, false);
  assert.equal(decideAudience(cue, { verdict: "ASSIST", themQuietMs: 0, solo: false, quietNeededMs: 4000 }).answer, true);
});

// ---------- the hotkey and the control socket ----------
const req = createRequire(import.meta.url);
const { createController } = req("../tray/controller.cjs");
const { createControlServer } = req("../tray/control-socket.cjs");
const trayLib = req("../tray/lib.cjs");
const { createPlanStore } = req("../tray/plans.cjs");

function fakeChild() {
  const c: any = new EventEmitter();
  c.pid = 1;
  c.written = [] as string[];
  c.stdin = Object.assign(new EventEmitter(), { writable: true, write: (s: string) => (c.written.push(s), true) });
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => {};
  c.say = (ev: string, data: object = {}) => c.stdout.emit("data", Buffer.from(`\n@@wingman ${JSON.stringify({ ev, ...data })}\n`));
  return c;
}

test("hotkey path: the recap key calls ctl.recap, which writes 'recap' to the engine, only while live", () => {
  const child = fakeChild();
  const dir = mkdtempSync(join(tmpdir(), "wm-recap-"));
  const ctl = createController({
    spawn: () => child,
    root: ROOT,
    tmpDir: dir,
    setTimeout: () => 0,
    kill: () => {},
    logPath: "",
    plans: createPlanStore({ dir: join(dir, "b"), pdftotext: "" }),
  });
  assert.equal(ctl.recap(), false, "no call");
  assert.equal(ctl.start({ quick: true }), true);
  child.say("consented");
  assert.equal(ctl.getState().phase, "live");
  assert.equal(ctl.recap(), true);
  assert.deepEqual(child.written.slice(-1), ["recap\n"]);
  assert.equal(trayLib.KEYS.recap, "Control+Alt+U");
  assert.ok(!trayLib.OVERLAY_KEYS.includes(trayLib.KEYS.recap), "not a key of the answer window (Ctrl+Opt+R is rewind)");
  assert.equal(new Set(Object.values(trayLib.KEYS)).size, Object.keys(trayLib.KEYS).length, "every tray key is different");
  // the tray main registers the key and a menu item (electron is not loaded here)
  const main = readFileSync(join(ROOT, "tray", "main.cjs"), "utf8");
  assert.match(main, /globalShortcut\.register\(KEYS\.recap, \(\) => ctl\.recap\(\)\)/);
  assert.match(main, /label: t\("recap"\)/);
});

test("control socket: recap is an allowed command with no arguments; refused when no call is live", async () => {
  const child = fakeChild();
  const dir = mkdtempSync(join(tmpdir(), "wm-recap-sock-"));
  const sock = join(dir, "run", "control.sock");
  const plans = createPlanStore({ dir: join(dir, "b"), pdftotext: "" });
  const ctl = createController({ spawn: () => child, root: ROOT, tmpDir: dir, setTimeout: () => 0, kill: () => {}, logPath: "", plans });
  let t = 5_000_000;
  const server = createControlServer({
    controller: ctl,
    lib: trayLib,
    plans,
    socketPath: sock,
    log: () => {},
    now: () => (t += 2000),
    info: () => ({ pid: 1, version: "t" }),
    askCliStart: async () => false,
    confirm: {},
  });
  await server.start();
  const raw = (line: string) =>
    new Promise<{ ok: boolean; code?: string }>((res) => {
      const s = net.createConnection(req("../tray/control-socket.cjs").endpointFor(sock));
      let b = "";
      s.on("connect", () => s.write(line));
      s.on("data", (d) => (b += d));
      s.on("close", () => res(JSON.parse(b)));
    });
  try {
    assert.equal((await raw('{"v":1,"cmd":"recap"}\n')).code, "refused", "no live call");
    ctl.start({ quick: true });
    child.say("consented");
    assert.equal((await raw('{"v":1,"cmd":"recap","args":{"x":1}}\n')).code, "bad_args");
    assert.equal((await raw('{"v":1,"cmd":"recap"}\n')).ok, true);
    assert.deepEqual(child.written.slice(-1), ["recap\n"], "the engine got the command through the socket");
  } finally {
    await server.stop();
  }
});

test("the engine understands 'recap' and routes a typed 'ask <text>' to the ask-the-call job (source check; the process test is in e2e/ask-call)", () => {
  const ctl = readFileSync(join(ROOT, "src", "engine", "control.ts"), "utf8");
  assert.match(ctl, /cmd === "recap"/);
  assert.match(ctl, /catchMeUp\(\)/);
  const me = readFileSync(join(ROOT, "src", "engine", "me.ts"), "utf8");
  assert.match(me, /export function askTyped[\s\S]*askTheCall\(text\)/);
  assert.match(me, /useLists: !canMeAi\(\)/);
});
