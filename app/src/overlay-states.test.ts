// Answer window state machines: the sheet value, the recap request, pause owned by main, late rows after the call ended,
// tip timers, the live-line strips and pinned cards. The model parts run as plain code; the page parts replay a sequence of events
// through the hidden snapshot tool (overlay/snap2.cjs, scenarios "v2-seq-*" in overlay/fixtures-v2.cjs) on macOS only, like the other snapshot tests.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT } from "./env.ts";
import { MAC } from "./test-platform.ts";

const require = createRequire(import.meta.url);
const V = require("../overlay/v2.js");
const W = require("../overlay/window.cjs");
const A = require("../overlay/act.cjs");

const T0 = 1_000_000;
const row = (o: Record<string, unknown>) => ({ type: "card", id: "a1", kind: "answer", value: 2, say: "Say this", at: T0, ...o });

// ---- the board: a pinned card closed by the engine ----
test("board: a close that arrives while the card is pinned is kept, and unpinning dims the card with that reason", () => {
  const b = new V.Board();
  b.apply(row({}), T0);
  b.togglePin("a1");
  b.apply(row({ closes: "answered" }), T0 + 1000);
  const e = b.cards.get("a1");
  assert.equal(e.state, "live", "pinned: it stays");
  assert.equal(e.closedReason, "answered", "the close is remembered");
  b.apply(row({ say: "Say this, longer" }), T0 + 2000);
  assert.equal(b.cards.get("a1").closedReason, "answered", "an update row does not forget it");
  b.togglePin("a1");
  const d = b.cards.get("a1");
  assert.equal(d.state, "dim");
  assert.equal(d.reason, "answered");
  assert.equal(d.closedReason, "");
  b.tick(T0 + 2000 + V.DIM_MS + 1);
  assert.equal(b.cards.has("a1"), false, "and it leaves after the usual time");
});

test("board: pin, unpin without a close changes nothing else; a dismiss still removes a pinned card", () => {
  const b = new V.Board();
  b.apply(row({}), T0);
  b.togglePin("a1");
  b.togglePin("a1");
  assert.equal(b.cards.get("a1").state, "live");
  b.togglePin("a1");
  b.apply(row({ closes: "dismissed" }), T0 + 10);
  assert.equal(b.cards.has("a1"), false);
});

test("board: pins restored after a reload start pinned, so a replayed close does not take the card away", () => {
  const b = new V.Board();
  b.setPins(["a1"]);
  b.apply(row({}), T0);
  assert.equal(b.cards.get("a1").pinned, true);
  b.apply(row({ closes: "topic" }), T0 + 5);
  assert.equal(b.cards.get("a1").state, "live");
  b.clear();
  assert.equal(b.pins.size, 0, "a new call starts with no pins");
});

test("act: pinnedIds folds the pin, unpin and dismiss events of a call", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-r16-"));
  const ev = [
    { name: "pin", cardId: "a" },
    { name: "pin", cardId: "b" },
    { name: "unpin", cardId: "a" },
    { name: "pin", cardId: "c" },
    { name: "dismiss", cardId: "c" },
    { name: "pin", cardId: "d" },
    { name: "recap", cardId: "" },
  ];
  writeFileSync(join(dir, "overlay-events.jsonl"), ev.map((e) => JSON.stringify({ t: 1, type: "overlay", ...e })).join("\n") + "\nnot json\n");
  assert.deepEqual(A.pinnedIds(dir), ["b", "d"]);
  assert.deepEqual(A.pinnedIds(join(dir, "none")), [], "no file, no pins");
});

// ---- pause is owned by main ----
test("hotkeys: the pause key runs main's own handler when it is given, and only tells the page otherwise", () => {
  const sent: string[] = [];
  const page = (ch: string) => () => sent.push(ch);
  let toggled = 0;
  const own = W.hotkeyItems(W.DEFAULT_HOTKEYS, { page, copyLast: () => {}, pause: () => toggled++ });
  own.find((i: { name: string }) => i.name === "pause").run();
  assert.equal(toggled, 1);
  assert.deepEqual(sent, [], "the page is not told by the key itself: main sends the full state");
  const fallback = W.hotkeyItems(W.DEFAULT_HOTKEYS, { page, copyLast: () => {} });
  fallback.find((i: { name: string }) => i.name === "pause").run();
  assert.deepEqual(sent, ["pause"]);
});

// ---- the page, through the hidden snapshot tool ----
const HAVE_ELECTRON = existsSync(join(ROOT, "node_modules/.bin/electron"));
const SNAP = { ...MAC, skip: MAC.skip || (!HAVE_ELECTRON && "electron is not installed"), timeout: 200_000 };
type Probe = Record<string, any>;
type Res = { spec: string; issues: { type: string; detail: string }[]; probe: Probe; live: string };
function snap(lang: "en" | "he", specs: string[]): Res[] {
  const out = mkdtempSync(join(tmpdir(), "wm-r16s-"));
  mkdirSync(out, { recursive: true });
  const r = spawnSync(join(ROOT, "node_modules/.bin/electron"), [join(ROOT, "overlay/snap2.cjs"), out, "--check", ...specs], {
    env: { ...process.env, WINGMAN_OVERLAY_LANG: lang },
    encoding: "utf8",
    timeout: 170_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const res = r.stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Res);
  assert.equal(res.length, specs.length, "every spec ran: " + r.stderr.slice(-400));
  for (const x of res) assert.deepEqual(x.issues, [], x.spec + " " + JSON.stringify(x.issues));
  return res;
}
const by = (rs: Res[], name: string) => rs.find((x) => x.spec === name)!.probe;

for (const lang of ["en", "he"] as const) {
  test(`page (${lang}): the Catch me up sheet stays closed after a close, ignores replayed and late rows, and stays open while cards arrive`, SNAP, () => {
    const rs = snap(lang, ["v2-seq-recap-closed", "v2-seq-recap-replayed", "v2-seq-recap-ended", "v2-seq-recap-stays", "v2-recap"]);
    assert.equal(by(rs, "v2-seq-recap-closed").recapOpen, false, "closed while streaming: the next delta and done rows do not open it");
    assert.equal(by(rs, "v2-seq-recap-replayed").recapOpen, false, "recap rows nobody asked for do not open it");
    const ended = by(rs, "v2-seq-recap-ended");
    assert.equal(ended.recapOpen, false, "a recap row after the call ended");
    assert.equal(ended.ended, true);
    assert.equal(by(rs, "v2-seq-recap-stays").recapOpen, true, "an asked recap stays open through card rows");
    assert.equal(by(rs, "v2-recap").recapOpen, true, "the hotkey still opens it");
  });

  test(`page (${lang}): rewind and recap are never open together; the last one opened wins`, SNAP, () => {
    const rs = snap(lang, ["v2-seq-sheets", "v2-seq-sheets-back"]);
    assert.deepEqual([by(rs, "v2-seq-sheets").rewindOpen, by(rs, "v2-seq-sheets").recapOpen], [false, true]);
    assert.deepEqual([by(rs, "v2-seq-sheets-back").rewindOpen, by(rs, "v2-seq-sheets-back").recapOpen], [true, false]);
  });

  test(`page (${lang}): pause is the state main sends; a new call does not start paused; late rows after the end change nothing`, SNAP, () => {
    const rs = snap(lang, ["v2-seq-pause-next-call", "v2-seq-pause-state", "v2-seq-pause-off", "v2-seq-late-ended"]);
    const next = by(rs, "v2-seq-pause-next-call");
    assert.equal(next.paused, false, "paused at the end of call A, call B runs");
    assert.equal(next.heroShown, true, "the first card of call B is on screen");
    assert.equal(by(rs, "v2-seq-pause-state").paused, true, "main says paused: twice in a row stays paused (no toggle)");
    assert.equal(by(rs, "v2-seq-pause-state").heroShown, false);
    assert.equal(by(rs, "v2-seq-pause-off").paused, false);
    const late = by(rs, "v2-seq-late-ended");
    assert.equal(late.stateWord.length > 0 && late.ended, true);
    assert.equal(late.youOn, false, "no addressed alert on the ended screen");
    assert.equal(late.moreBtnText, "", "no More button from a late frame or tip");
    assert.equal(late.nudge, "");
    assert.equal(late.askOn, false);
    assert.deepEqual(late.strips, ["", ""]);
  });

  test(`page (${lang}): a tip timer never removes a newer tip with the same id; an empty partial hides only its own strip`, SNAP, () => {
    const rs = snap(lang, ["v2-seq-tip-reuse", "v2-seq-tip-next-call", "v2-seq-strips"]);
    const reuse = by(rs, "v2-seq-tip-reuse");
    assert.equal(reuse.tipCount, 2, "two tips on screen");
    assert.match(reuse.moreBtnText, /2/, "and the More count agrees: " + reuse.moreBtnText);
    const next = by(rs, "v2-seq-tip-next-call");
    assert.equal(next.tipCount, 1);
    assert.match(next.moreBtnText, /1/, "the new call's tip is still counted: " + next.moreBtnText);
    const strips = by(rs, "v2-seq-strips").strips;
    assert.ok(strips[0].length > 0, "the other side's line is still there after an empty me partial");
    assert.equal(strips[1], "");
  });

  test(`page (${lang}): a pinned card closed by the engine dims when it is unpinned, and a pin restored on replay survives a replayed close`, SNAP, () => {
    const rs = snap(lang, ["v2-seq-pin-closed", "v2-seq-pin-closed-unpin", "v2-seq-pin-replay"]);
    const pinned = by(rs, "v2-seq-pin-closed");
    assert.deepEqual([pinned.heroPinned, pinned.heroDim], [true, false], "pinned: the close does not touch it");
    const un = by(rs, "v2-seq-pin-closed-unpin");
    assert.deepEqual([un.heroPinned, un.heroDim], [false, true], "unpinned: the kept close applies");
    const replay = by(rs, "v2-seq-pin-replay");
    assert.deepEqual([replay.heroPinned, replay.heroDim], [true, false]);
  });
}
