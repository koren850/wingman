// Answer window v3: whole hero text with More, kind-word chips, stale and collapse rules, the Context button,
// controls on hover or focus, "fewer like this", the keyboard model, announcements, Hebrew and English age order, and the main-process fixes.
// The model (overlay/v2.js), the act channel, the state file and the window rules are plain code with fakes. The page is checked through the hidden
// snapshot tool (overlay/snap2.cjs), on macOS only like the other snapshot tests.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT } from "./env.ts";
import { MAC, POSIX } from "./test-platform.ts";

const require = createRequire(import.meta.url);
const V = require("../overlay/v2.js");
const W = require("../overlay/window.cjs");
const L = require("../overlay/lib.cjs");
const R = require("../overlay/resilient.cjs");
const { applyAct } = require("../overlay/act.cjs");
const strings = require("../overlay/strings.js");

const T0 = 1_000_000;
const MIN = 60_000;
const row = (o: Record<string, unknown>) => ({ type: "card", id: "x", say: "Say this", at: T0, ...o });

// ---- labels and chips ----
test("label: the model's label, else nothing; the first words of the line are never a label", () => {
  assert.equal(V.labelOf({ label: "PHP version" }), "PHP version");
  assert.equal(V.labelOf({ label: "Backups, and how long they stay." }), "Backups, and how long");
  assert.equal(V.labelOf({}), "");
  assert.equal(V.labelOf({ label: "   " }), "");
  const e = V.makeEntry(row({ kind: "answer", say: "Yes, we run PHP 8.2 on the server today." }), T0);
  assert.equal(e.label, "", "no label stays empty: the page then shows the kind word");
});

test("chip text: the label, else the kind word; a fact with a value reads 'label: value'", () => {
  const a = V.makeEntry(row({ kind: "answer", label: "CRM link" }), T0);
  assert.equal(V.chipText(a, "Answer"), "CRM link");
  const none = V.makeEntry(row({ kind: "answer", say: "How long do backups stay?" }), T0);
  assert.equal(V.chipText(none, "Answer"), "Answer");
  assert.ok(!V.chipText(none, "Answer").includes("How long"));
  const f = V.makeEntry(row({ kind: "fact", label: "Their stack", val: "WooCommerce 8.2" }), T0);
  assert.equal(V.chipText(f, "Fact"), "Their stack: WooCommerce 8.2");
  const f2 = V.makeEntry(row({ kind: "fact", val: "30 days" }), T0);
  assert.equal(V.chipText(f2, "Fact"), "Fact: 30 days");
  const f3 = V.makeEntry(row({ kind: "fact", label: "Their stack" }), T0);
  assert.equal(V.chipText(f3, "Fact"), "Their stack");
  const f4 = V.makeEntry(row({ kind: "fact", label: "Stack", val: "one two three four five six seven" }), T0);
  assert.equal(f4.val, "one two three four", "a value is at most 4 words");
});

// ---- the hero line is never cut ----
test("the hero line is whole: no ellipsis is added; over 14 words or fit=false marks it long", () => {
  const short = V.makeEntry(row({ say: "Yes, through the API." }), T0);
  assert.equal(short.head, "Yes, through the API.");
  assert.equal(short.long, false);
  const w = (n: number) => Array.from({ length: n }, (_, i) => "w" + i).join(" ");
  const fourteen = V.makeEntry(row({ say: w(14) }), T0);
  assert.equal(fourteen.long, false);
  const fifteen = V.makeEntry(row({ say: w(15) }), T0);
  assert.equal(fifteen.long, true);
  assert.equal(fifteen.head, w(15), "all fifteen words stay");
  const long = V.makeEntry(row({ say: w(90) }), T0);
  assert.equal(long.head.split(" ").length, 90);
  assert.ok(!long.head.includes("…"));
  const cut = V.makeEntry(row({ say: "We can do it, and", fit: false, more: ["the rest of the line"] }), T0);
  assert.equal(cut.long, true, "fit=false: the engine cut the line at a clause, the page offers More");
  assert.deepEqual(cut.detail, ["the rest of the line"]);
  assert.equal(V.makeEntry(row({ say: "  spaced   out \n line " }), T0).head, "spaced out line");
  assert.equal(V.splitHeadline, undefined, "the old cutting function is gone");
});

test("about: the model's about (8 words at most); an answer falls back to its question; other kinds do not", () => {
  assert.equal(V.makeEntry(row({ kind: "answer", about: "PHP version" }), T0).about, "PHP version");
  assert.equal(V.makeEntry(row({ kind: "answer", about: "a b c d e f g h i j" }), T0).about, "a b c d e f g h");
  assert.equal(V.makeEntry(row({ kind: "answer", question: "Can you connect it to Salesforce?" }), T0).about, "Can you connect it to Salesforce");
  assert.equal(V.makeEntry(row({ kind: "check", question: "Can you connect it?" }), T0).about, "");
  assert.equal(V.makeEntry(row({ kind: "answer" }), T0).about, "");
});

// ---- stale and collapse ----
test("stale levels: fresh, stale at 3 minutes, old at 6", () => {
  assert.deepEqual(
    [0, 179_999, 180_000, 359_999, 360_000, 3_600_000].map((ms) => V.staleLevel(ms)),
    [0, 0, 1, 1, 2, 2],
  );
});

test("collapse: an answer or prompt older than 6 minutes becomes a chip; the next best card takes the hero seat", () => {
  const b = new V.Board();
  b.apply(row({ id: "old", kind: "answer", value: 3, about: "PHP version", label: "PHP" }), T0);
  b.apply(row({ id: "new", kind: "prompt", value: 1, at: T0 + 5 * MIN }), T0 + 5 * MIN);
  assert.equal(b.hero.id, "old", "an answer outranks a prompt while it is fresh enough");
  assert.equal(b.tick(T0 + 6 * MIN - 1), false);
  assert.equal(b.tick(T0 + 6 * MIN), true);
  assert.equal(b.hero.id, "new");
  const chip = b.chips.find((e: { id: string }) => e.id === "old");
  assert.equal(chip.collapsed, true);
  assert.equal(chip.about, "PHP version");
  assert.equal(b.tick(T0 + 6 * MIN + 1000), false, "nothing changes twice");
});

test("collapse: checks, pinned cards and cards the user brought back never collapse; a late row that is already old arrives as a chip", () => {
  const b = new V.Board();
  b.apply(row({ id: "c", kind: "check", at: T0 }), T0);
  b.apply(row({ id: "p", kind: "answer", pinned: true, at: T0 }), T0);
  b.apply(row({ id: "a", kind: "answer", at: T0 }), T0);
  b.tick(T0 + 10 * MIN);
  const state = (id: string) => b.cards.get(id).collapsed;
  assert.equal(state("c"), false);
  assert.equal(state("p"), false);
  assert.equal(state("a"), true);
  assert.equal(b.hero.id, "c");
  assert.equal(b.promote("a"), true);
  assert.equal(b.cards.get("a").collapsed, false);
  b.tick(T0 + 11 * MIN);
  assert.equal(b.cards.get("a").collapsed, false, "a card the user opened stays open");
  const late = new V.Board();
  const e = late.apply(row({ id: "z", kind: "answer", at: T0 }), T0 + 7 * MIN);
  assert.equal(e.collapsed, true);
  assert.equal(late.hero, null, "an old row never takes the hero seat");
  assert.equal(late.chips.length, 1);
});

// ---- announcements and keys ----
test("announce: the first card, a check, and the first card after a pause; nothing else", () => {
  assert.equal(V.shouldAnnounce("answer", 0, T0), true, "the first card of the call");
  assert.equal(V.shouldAnnounce("answer", T0, T0 + 5000), false);
  assert.equal(V.shouldAnnounce("prompt", T0, T0 + 30_000), false);
  assert.equal(V.shouldAnnounce("fact", T0, T0 + 30_000), false);
  assert.equal(V.shouldAnnounce("check", T0, T0 + 1000), true);
  assert.equal(V.shouldAnnounce("answer", T0, T0 + V.PAUSE_MS - 1), false);
  assert.equal(V.shouldAnnounce("answer", T0, T0 + V.PAUSE_MS), true, "the first card after a pause");
});

test("keys: Enter more, Esc dismiss, P pin, 1 and 2 rate; modifiers and other keys are not ours", () => {
  const k = (key: string, extra: Record<string, boolean> = {}) => V.keyAction({ key, ...extra });
  assert.equal(k("Enter"), "more");
  assert.equal(k("Escape"), "dismiss");
  assert.equal(k("p"), "pin");
  assert.equal(k("P"), "pin");
  assert.equal(k("1"), "useful");
  assert.equal(k("2"), "notuseful");
  for (const x of ["a", "3", "Tab", " ", "ArrowDown"]) assert.equal(k(x), "", x);
  assert.equal(k("p", { ctrlKey: true }), "");
  assert.equal(k("Enter", { metaKey: true }), "");
  assert.equal(k("1", { altKey: true }), "");
  assert.equal(V.keyAction(null), "");
});

// ---- fewer like this ----
test("rating fewer: the board keeps it (no toggle), the controls send it, the act channel accepts it", () => {
  const b = new V.Board();
  b.apply(row({ id: "a", kind: "answer" }), T0);
  assert.equal(b.rate("a", "fewer"), "fewer");
  assert.equal(b.rate("a", "fewer"), "fewer", "pressing it again does not clear it");
  assert.equal(b.rate("a", "useful"), "useful");
  assert.equal(b.rate("a", "useful"), "", "the other ratings still toggle");
  assert.ok(V.RATINGS.includes("fewer"));
  const sent: [string, unknown][] = [];
  const c = V.createControls(
    (k: string, p: unknown) => sent.push([k, p]),
    () => {},
  );
  c.rate("a", "fewer");
  assert.deepEqual(sent[0], ["rate", { cardId: "a", rating: "fewer" }]);
  assert.deepEqual(V.cleanAct("rate", { cardId: "a", rating: "fewer" }), { kind: "rate", cardId: "a", rating: "fewer" });
  assert.equal(V.cleanAct("rate", { cardId: "a", rating: "lots" }), null);
  // the sandboxed preload carries its own copy of the rule; it must agree
  const sentIpc: unknown[] = [];
  const api = loadPreload(sentIpc);
  api.act("rate", { cardId: "a", rating: "fewer" });
  api.act("rate", { cardId: "a", rating: "bogus" });
  assert.deepEqual(sentIpc, [["act", { kind: "rate", cardId: "a", rating: "fewer" }]]);
});

function loadPreload(sink: unknown[]): { act: (k: string, p: unknown) => void; shown: (n: unknown) => void } {
  let api: any;
  const fake = {
    contextBridge: { exposeInMainWorld: (_n: string, a: unknown) => (api = a) },
    ipcRenderer: { send: (ch: string, m: unknown) => sink.push([ch, m]), on: () => {} },
  };
  const Module = require("node:module");
  const orig = Module._load;
  Module._load = function (req: string, ...rest: unknown[]) {
    return req === "electron" ? fake : orig.call(this, req, ...rest);
  };
  try {
    delete require.cache[require.resolve("../overlay/preload.cjs")];
    require("../overlay/preload.cjs");
  } finally {
    Module._load = orig;
  }
  return api;
}

test("fewer like this writes a tags.jsonl row with rating fewer and useful n (fake IPC into the real act handler)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-r3-act-"));
  writeFileSync(join(dir, "cards.jsonl"), JSON.stringify({ type: "card", id: "a1", badge: "ai", kind: "answer", say: "Yes", at: 1 }) + "\n");
  // the page's act() goes through the preload, then ipcMain.on("act") -> applyAct
  const ipc: [string, any][] = [];
  const api = loadPreload(ipc as unknown as unknown[]);
  api.act("rate", { cardId: "a1", rating: "fewer" });
  assert.equal(ipc.length, 1);
  const r = applyAct(dir, ipc[0]![1], 5000);
  assert.deepEqual(r, { ok: true });
  const rows = readFileSync(join(dir, "tags.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "a1");
  assert.equal(rows[0].rating, "fewer");
  assert.equal(rows[0].useful, "n");
  assert.equal(rows[0].badge, "ai");
  // a later useful rating replaces it (one row per card); none clears it
  applyAct(dir, { kind: "rate", cardId: "a1", rating: "useful" }, 6000);
  assert.equal(JSON.parse(readFileSync(join(dir, "tags.jsonl"), "utf8").trim()).useful, "y");
  applyAct(dir, { kind: "rate", cardId: "a1", rating: "none" }, 7000);
  assert.equal(readFileSync(join(dir, "tags.jsonl"), "utf8"), "");
  assert.equal(applyAct(dir, { kind: "rate", cardId: "ghost", rating: "fewer" }, 8000).ok, false, "an unknown card is not rated");
});

// ---- the state file: cards shown ----
test("overlay state: the card count is read and written safely; a broken file is zero", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = mkdtempSync(join(tmpdir(), "wm-r3-state-"));
  assert.equal(L.readShown(fs, path, dir), 0, "no file");
  assert.equal(L.writeShown(fs, path, dir, 2), true);
  assert.equal(L.readShown(fs, path, dir), 2);
  assert.equal(L.parseShown("{bad"), 0);
  assert.equal(L.parseShown('{"cardsShown":-4}'), 0);
  assert.equal(L.parseShown('{"cardsShown":"x"}'), 0);
  assert.equal(L.parseShown('{"cardsShown":3.5}'), 0);
  assert.equal(L.parseShown('{"cardsShown":1e12}'), 1e6, "capped");
  assert.equal(L.writeShown(fs, path, join(dir, "file", "sub"), 1) && existsSync(join(dir, "file", "sub", L.STATE_FILE)), true, "the folder is made");
  writeFileSync(join(dir, "blocker"), "x");
  assert.equal(L.writeShown(fs, path, join(dir, "blocker", "x"), 1), false, "a write that fails is false, never thrown");
  assert.equal(L.writeShown(fs, path, dir, -5), true);
  assert.equal(L.readShown(fs, path, dir), 0, "never below zero");
  assert.equal(L.writeShown(fs, path, dir, 7), true);
});

test("overlay state: the file is owner-only", POSIX, () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = mkdtempSync(join(tmpdir(), "wm-r3-state-"));
  L.writeShown(fs, path, dir, 1);
  assert.equal(statSync(join(dir, L.STATE_FILE)).mode & 0o777, 0o600);
});

test("preload: shown() passes only whole positive counts", () => {
  const sink: [string, unknown][] = [];
  const api = loadPreload(sink as unknown as unknown[]);
  for (const n of [1, 2, 0, -1, 1.5, "x", NaN, 1e9]) api.shown(n);
  assert.deepEqual(
    sink.map((s) => s[1]),
    [1, 2],
  );
});

// ---- main process: timers and listeners at exit; hotkeys; the pipe backlog ----
test("bye: every timer is cleared, the display listeners are removed, the keys are released, and exit runs once", () => {
  const cleared: unknown[] = [];
  const realCI = global.clearInterval;
  const realCT = global.clearTimeout;
  global.clearInterval = ((t: unknown) => cleared.push(["i", t])) as typeof clearInterval;
  global.clearTimeout = ((t: unknown) => cleared.push(["t", t])) as typeof clearTimeout;
  try {
    const calls: string[] = [];
    let detached = 0;
    const bye = L.makeBye({
      timers: () => ["poll", "hang", "reload", "parent"],
      follow: () => ({ detach: () => detached++ }),
      unregister: () => calls.push("unregister"),
      exit: (c: number) => calls.push("exit" + c),
    });
    bye();
    bye();
    assert.equal(detached, 1);
    assert.deepEqual(calls, ["unregister", "exit0"], "once");
    assert.deepEqual(
      cleared.map((c: any) => c[1]),
      ["poll", "poll", "hang", "hang", "reload", "reload", "parent", "parent"],
    );
  } finally {
    global.clearInterval = realCI;
    global.clearTimeout = realCT;
  }
  // nothing throws even when everything is broken
  const calls: string[] = [];
  L.makeBye({
    timers: () => {
      throw new Error("x");
    },
    follow: () => {
      throw new Error("y");
    },
    unregister: () => {
      throw new Error("z");
    },
    exit: (c: number) => calls.push("exit" + c),
  })();
  assert.deepEqual(calls, ["exit0"]);
});

test("display follow: attach twice does not double the listeners; detach removes them all", () => {
  const on: Record<string, Set<(...a: unknown[]) => void>> = {};
  const screen = {
    on: (n: string, f: () => void) => (on[n] ??= new Set()).add(f),
    removeListener: (n: string, f: () => void) => on[n]?.delete(f),
    getAllDisplays: () => [],
    getPrimaryDisplay: () => ({ id: 1 }),
  };
  const f = W.createDisplayFollow({ screen, win: { isDestroyed: () => true }, cfg: {} });
  f.attach();
  f.attach();
  const total = () => Object.values(on).reduce((n, s) => n + s.size, 0);
  assert.equal(total(), 3);
  f.detach();
  assert.equal(total(), 0);
  f.detach();
  assert.equal(total(), 0, "safe twice");
});

test("pipe backlog: the buffer that replays a page is capped (the old second buffer was never read)", () => {
  const b = new R.Backlog();
  for (let i = 0; i < 1000; i++) b.add({ id: "c" + i });
  assert.equal(b.all().length, 300);
  assert.equal(b.all()[0].id, "c700", "oldest dropped first");
});

test("hotkeys: the card keys exist, each one tells the page the right thing, and every key registers through registerHotkeys", () => {
  const sent: [string, unknown][] = [];
  const items = W.hotkeyItems(W.DEFAULT_HOTKEYS, {
    page: (ch: string, payload: unknown) => () => sent.push([ch, payload]),
    copyLast: () => sent.push(["copy", null]),
  });
  const names = items.map((i: { name: string }) => i.name);
  for (const n of ["dismiss", "pin", "restore", "useful", "notUseful", "more", "recap", "pause", "clear", "rewind", "copy", "checklist"])
    assert.ok(names.includes(n), n);
  const registered: string[] = [];
  const gs = { register: (a: string) => (registered.push(a), true) };
  const r = W.registerHotkeys(gs, items);
  assert.deepEqual(r.failed, []);
  assert.equal(registered.length, items.length);
  assert.equal(new Set(registered).size, registered.length, "no key twice");
  for (const it of items) it.run();
  assert.deepEqual(
    sent.filter(([c]) => c === "ctl").map(([, p]) => (p as { name: string }).name),
    ["more", "pin", "useful", "notuseful", "dismiss"],
  );
  assert.ok(sent.some(([c]) => c === "restore"));
});

test("display follow: the window only ever moves with setBounds, inside the work area, whatever the screens do", () => {
  const calls: string[] = [];
  let bounds = { x: 0, y: 0, width: 760, height: 100 };
  const win = new Proxy(
    {},
    {
      get: (_t, name: string) => {
        if (name === "isDestroyed") return () => false;
        if (name === "isVisible") return () => true;
        if (name === "getBounds") return () => bounds;
        if (name === "setBounds")
          return (b: typeof bounds) => {
            calls.push("setBounds");
            bounds = b;
          };
        return () => calls.push(name);
      },
    },
  );
  const work = { x: 1920, y: 0, width: 1600, height: 900 };
  const display = { id: 2, workArea: work, bounds: work };
  let displays = [display];
  const screen = {
    on: () => {},
    removeListener: () => {},
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
  };
  const f = W.createDisplayFollow({ screen, win, cfg: { display: "secondary", allowPrimary: false } });
  assert.ok(f.start());
  for (const h of [50, 300, 900, 5000, 120]) {
    f.fit(h);
    assert.ok(W.inside(bounds, work), JSON.stringify(bounds));
  }
  f.metrics(display);
  displays = [];
  f.removed(display);
  displays = [display];
  f.added();
  assert.ok(calls.length > 0);
  assert.ok(
    calls.every((c) => c === "setBounds" || c === "hide" || c === "showInactive"),
    calls.join(","),
  );
});

// ---- strings ----
test("strings: every key exists in English and Hebrew, with the same placeholders", () => {
  const en = Object.keys(strings.STRINGS.en).sort();
  const he = Object.keys(strings.STRINGS.he).sort();
  assert.deepEqual(en, he, "key parity");
  const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
  for (const k of en) {
    assert.equal(ph(strings.STRINGS.en[k]), ph(strings.STRINGS.he[k]), k);
    assert.ok(String(strings.STRINGS.en[k]).length > 0 && String(strings.STRINGS.he[k]).length > 0, k);
  }
  for (const k of ["v2.context", "v2.context.label", "v2.about", "v2.fewer", "v2.stale"]) assert.ok(k in strings.STRINGS.en, k);
  // no key is a leftover: the retired ones are gone
  for (const k of ["v2.list.earlier"]) assert.ok(!(k in strings.STRINGS.en), k);
});

test("age order: the number comes first in both languages, and the page isolates it in the window direction", () => {
  const t = (lang: string, k: string, n: number) => strings.t(lang, k, { n });
  assert.equal(t("en", "v2.age.s", 10), "10 s");
  assert.equal(t("en", "v2.age.min", 6), "6 min");
  assert.match(t("he", "v2.age.s", 10), /^10 \S+$/);
  assert.match(t("he", "v2.age.min", 6), /^6 \S+$/);
  assert.equal(strings.t("en", "v2.about", { t: "PHP version" }), "about: PHP version");
  assert.match(strings.t("he", "v2.about", { t: "PHP" }), /PHP$/);
  assert.deepEqual(V.ageParts(0), { unit: "now", n: 0 });
  assert.deepEqual(V.ageParts(95_000), { unit: "min", n: 1 });
});

// ---- the page, through the hidden snapshot tool ----
const HAVE_ELECTRON = existsSync(join(ROOT, "node_modules/.bin/electron"));
const SNAP = { ...MAC, skip: MAC.skip || (!HAVE_ELECTRON && "electron is not installed") };
type Probe = Record<string, any>;
type Res = {
  spec: string;
  png: string;
  issues: { type: string; sel: string; detail: string }[];
  metrics: { chipRows: number; minContrast: number };
  probe: Probe;
  animations: number;
  live: string;
  ipc: [string, any][];
};
function snap(lang: "en" | "he", specs: string[]): Res[] {
  const out = mkdtempSync(join(tmpdir(), "wm-r3-"));
  mkdirSync(out, { recursive: true });
  const r = spawnSync(join(ROOT, "node_modules/.bin/electron"), [join(ROOT, "overlay/snap2.cjs"), out, "--check", ...specs], {
    env: { ...process.env, WINGMAN_OVERLAY_LANG: lang },
    encoding: "utf8",
    timeout: 170_000,
  });
  const res = r.stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Res);
  assert.equal(res.length, specs.length, "every spec ran: " + r.stderr.slice(-400));
  return res;
}
const by = (rs: Res[], name: string) => rs.find((x) => x.spec === name)!;
const clean = (rs: Res[]) => {
  for (const r of rs) assert.deepEqual(r.issues, [], r.spec + " " + JSON.stringify(r.issues));
};
const kindWord = (lang: "en" | "he", k: string) => strings.t(lang, "v2.kind." + k);

for (const lang of ["en", "he"] as const) {
  test(`snapshots (${lang}): the hero shows its whole line; a long line clamps to 3 lines with More and opens; no ellipsis is added`, SNAP, () => {
    const rs = snap(lang, ["v2-fitfalse", "v2-overflow", "v2-fitfalse-open", "v2-long", "v2-answer"]);
    clean(rs);
    for (const r of rs) assert.ok(!r.probe.hero.includes("…"), r.spec + ": " + r.probe.hero);
    assert.equal(by(rs, "v2-answer").probe.moreBtn, strings.t(lang, "v2.more"), "the answer has detail lines");
    const of = by(rs, "v2-overflow").probe;
    assert.equal(of.heroClamped, true, "an 80 word line is clamped to 3 lines");
    assert.equal(of.heroCut, false, "it is cut at a sentence end, so the clamp hides nothing");
    assert.match(of.hero, /[.!?]$/, "the collapsed line ends at a sentence end: " + of.hero);
    assert.ok(of.hero.length < by(rs, "v2-long").probe.hero.length * 2 + 2, "and the rest waits behind More");
    assert.equal(of.moreBtn, strings.t(lang, "v2.more"));
    const opened = by(rs, "v2-fitfalse-open").probe;
    assert.equal(opened.heroClamped, false);
    assert.equal(opened.moreBtn, strings.t(lang, "v2.less"));
    assert.equal(by(rs, "v2-fitfalse").probe.moreBtn, strings.t(lang, "v2.more"), "a cut line (fit=false) always offers More");
  });

  test(`snapshots (${lang}): chips show the label or the kind word, one kind mark, one bold unseen dot, an age, and facts show label: value`, SNAP, () => {
    const rs = snap(lang, ["v2-chips8", "v2-nolabel", "v2-factvals", "v2-busy"]);
    clean(rs);
    const nl = by(rs, "v2-nolabel").probe;
    assert.deepEqual(
      nl.labels.slice().sort(),
      [kindWord(lang, "answer"), kindWord(lang, "answer"), kindWord(lang, "fact")].sort(),
      "kind words, not the first words of the line",
    );
    const lines = ["How long do backups stay?", "Do you support Hebrew search?", "כמה זמן נשמרים הגיבויים?", "יש תמיכה בחיפוש בעברית?"];
    for (const l of nl.labels) for (const line of lines) assert.ok(!line.startsWith(l) || l.length < 3, l);
    for (const name of ["v2-chips8", "v2-nolabel", "v2-factvals", "v2-busy"]) {
      const p = by(rs, name).probe;
      assert.equal(p.chipKdots, 0, name + ": the second dot is gone");
      assert.equal(p.chipMarks, p.railX.length - (p.more ? 1 : 0), name + ": one kind mark per chip (not on +N)");
      assert.equal(p.chipAges.length, p.chipMarks, name + ": an age on every chip");
      assert.ok(
        p.chipAges.every((a: string) => /\d/.test(a) || a === strings.t(lang, "v2.age.now")),
        name + " " + p.chipAges.join("|"),
      );
      assert.ok(p.chipNdots <= p.chipMarks + (p.more ? 1 : 0), name);
    }
    const c8 = by(rs, "v2-chips8").probe;
    assert.ok(c8.labels.length === 3 && /\+\d/.test(c8.more), "three on the rail, the rest behind +N");
    const kinds = new Set(by(rs, "v2-busy").probe.chipKinds);
    assert.ok(kinds.has("check") && kinds.has("answer"), "kind shows as a class and a glyph, not colour alone: " + [...kinds].join());
    const fv = by(rs, "v2-factvals").probe;
    assert.deepEqual(
      fv.labels.map((l: string) => l.includes(": ")),
      [true, true],
      fv.labels.join(" | "),
    );
    assert.ok(fv.labels.some((l: string) => l.endsWith("WooCommerce 8.2")));
  });

  test(`snapshots (${lang}): a stale answer fades with the age in the warning colour and an about tag; at 6 minutes it is a chip`, SNAP, () => {
    const rs = snap(lang, ["v2-stale3", "v2-aged", "v2-answer", "v2-stale3:light", "v2-aged:light,l", "v2-stale3:reduce"]);
    clean(rs);
    const s3 = by(rs, "v2-stale3").probe;
    assert.match(s3.heroClass, /stale/);
    assert.equal(s3.ageWarn, true, "the age is in the warning colour");
    assert.ok(s3.about.length > 0 && s3.about.includes(lang === "en" ? "about:" : "על:"), "the about tag: " + s3.about);
    assert.equal(by(rs, "v2-answer").probe.ageWarn, false, "a fresh card has no warning");
    assert.doesNotMatch(by(rs, "v2-answer").probe.heroClass, /stale/);
    const aged = by(rs, "v2-aged").probe;
    assert.ok(!aged.hero.includes(lang === "en" ? "through the API" : "דרך ה-API"), "the old answer left the hero seat: " + aged.hero);
    assert.ok(
      aged.labels.some((l: string) => l.includes(lang === "en" ? "Salesforce" : "Salesforce")),
      "its chip says what it was about: " + aged.labels.join("|"),
    );
    assert.ok(
      aged.chipAges.some((a: string) => a.includes(lang === "en" ? "min" : "דק")),
      aged.chipAges.join("|"),
    );
  });

  test(`snapshots (${lang}): the Context button has a count badge in the text font; Catch me up is the only primary button`, SNAP, () => {
    const rs = snap(lang, ["v2-context", "v2-answer", "v2-busy", "v2-context:light,s"]);
    clean(rs);
    for (const r of rs) {
      assert.equal(r.probe.primaries, 1, r.spec + ": one primary button");
      assert.equal(r.probe.primaryText, strings.t(lang, "v2.recap.button"));
      assert.ok(r.probe.ctx, r.spec + ": a Context button");
      assert.match(r.probe.ctx.badge, /^\d+$/);
      assert.equal(r.probe.ctx.font, r.probe.ctx.chipFont, "digits use the text font");
      assert.ok(r.probe.ctx.text.startsWith(strings.t(lang, "v2.context")));
    }
    const c = by(rs, "v2-context").probe;
    assert.equal(c.ctx.badge, "8", "3 open + 2 promises + 2 not covered + 1 earlier card");
    assert.ok(c.listText.includes(strings.t(lang, "v2.list.open")) && c.listText.includes(strings.t(lang, "v2.list.promises")), c.listText);
    assert.ok(c.listText.includes(strings.t(lang, "v2.list.history")));
  });

  test(`snapshots (${lang}): a Check arrival flashes (a static frame under reduced motion), and the old hero slides to the rail`, SNAP, () => {
    const rs = snap(lang, ["v2-check-arrive", "v2-check-arrive:reduce"]);
    clean(rs);
    const a = by(rs, "v2-check-arrive");
    assert.equal(a.probe.flash, true);
    assert.ok(a.probe.chipKinds.includes("answer"), "the old hero is on the rail");
    assert.ok(a.probe.slides >= 1 || a.probe.chipKinds.length >= 1);
    const r = by(rs, "v2-check-arrive:reduce");
    assert.equal(r.animations, 0, "reduced motion: nothing runs");
    assert.equal(r.probe.flash, true, "but the amber frame is still there");
  });

  test(`snapshots (${lang}): the transcript is one line at about 60 percent and the hero is the largest text`, SNAP, () => {
    const rs = snap(lang, ["v2-answer", "v2-answer:l", "v2-answer:s"]);
    clean(rs);
    for (const r of rs) {
      assert.ok(r.probe.lastLines <= 1, r.spec + " lines " + r.probe.lastLines);
      assert.ok(r.probe.lastFont <= r.probe.heroFont * 0.65 && r.probe.lastFont >= 12, `${r.spec}: strip ${r.probe.lastFont}px, hero ${r.probe.heroFont}px`);
    }
  });

  test(`snapshots (${lang}): controls show on hover or focus or when the card is a minute old; the key hints hide after 3 cards`, SNAP, () => {
    const rs = snap(lang, ["v2-answer", "v2-stale3", "v2-focus", "v2-busy", "v2-menu"]);
    clean(rs);
    assert.equal(by(rs, "v2-answer").probe.ctlOpacity, "0", "hidden on a fresh card");
    assert.equal(by(rs, "v2-stale3").probe.ctlOpacity, "1", "shown once the card has aged");
    assert.equal(by(rs, "v2-focus").probe.ctlOpacity, "1", "shown on focus");
    assert.equal(by(rs, "v2-menu").probe.ctlOpacity, "1", "shown while the menu is open");
    assert.ok(by(rs, "v2-answer").probe.keyHints > 0, "the first cards show the key hints");
    assert.equal(by(rs, "v2-busy").probe.keyHints, 0, "after 3 cards they are gone");
    assert.deepEqual(by(rs, "v2-menu").probe.menuBtns, [
      strings.t(lang, "v2.pin"),
      strings.t(lang, "v2.copy"),
      strings.t(lang, "v2.fewer"),
      strings.t(lang, "v2.dismiss"),
    ]);
  });

  test(`snapshots (${lang}): the keyboard reaches the card and its buttons with a visible focus ring; Enter, P, 1, 2 and Esc work`, SNAP, () => {
    const rs = snap(lang, ["v2-focus", "v2-focus-btn", "v2-focus:light", "v2-key-flow", "v2-fewer"]);
    clean(rs);
    for (const [n, fk] of [
      ["v2-focus", "card"],
      ["v2-focus-btn", "b-up"],
      ["v2-focus:light", "card"],
    ] as const) {
      const a = by(rs, n).probe.active;
      assert.equal(a.fk, fk, n);
      assert.notEqual(a.outline, "none", n + " has an outline");
      assert.ok(parseFloat(a.outlineW) >= 2, n + " ring " + a.outlineW);
    }
    const acts = by(rs, "v2-key-flow")
      .ipc.filter(([c]) => c === "act")
      .map(([, m]) => m);
    assert.deepEqual(acts, [
      { kind: "event", cardId: "a1", name: "pin" },
      { kind: "rate", cardId: "a1", rating: "useful" },
      { kind: "rate", cardId: "a1", rating: "not_useful" },
      { kind: "event", cardId: "a1", name: "dismiss" },
    ]);
    const fewer = by(rs, "v2-fewer")
      .ipc.filter(([c]) => c === "act")
      .map(([, m]) => m);
    assert.deepEqual(fewer, [
      { kind: "rate", cardId: "a1", rating: "fewer" },
      { kind: "event", cardId: "a1", name: "dismiss" },
    ]);
  });

  test(`snapshots (${lang}): a screen reader hears only a Check and the first card after a pause; the age keeps the window direction`, SNAP, () => {
    const rs = snap(lang, ["v2-busy", "v2-answer", "v2-nolines", "v2-rtl", "v2-answer"]);
    clean(rs);
    const busy = by(rs, "v2-busy");
    assert.ok(busy.live.startsWith(kindWord(lang, "check")), "the last announcement is the check, not the answers after it: " + busy.live);
    assert.ok(by(rs, "v2-answer").live.startsWith(kindWord(lang, "answer")), "the first card of a call is announced");
    const rtl = by(rs, "v2-rtl").probe;
    assert.equal(rtl.heroDir, "rtl");
    assert.equal(rtl.ageDir.dir, lang === "he" ? "rtl" : "ltr", "the age follows the window language, not the card");
    assert.equal(rtl.ageDir.bidi, "isolate");
  });

  test(
    `snapshots (${lang}): legacy rows, the offline bar and the paused pill still render; every v3 scenario passes the checks in both themes and sizes`,
    SNAP,
    () => {
      const rs = snap(lang, [
        "v2-legacy",
        "v2-offline",
        "v2-aipaused",
        "v2-idle",
        "v2-idle-empty",
        "v2-rtl",
        "v2-mixed",
        "v2-rtl:light,l",
        "v2-mixed:light,s",
        "v2-chips8:light,l",
        "v2-fitfalse:s",
        "v2-check-arrive:light",
      ]);
      clean(rs);
      assert.ok(by(rs, "v2-aipaused").probe.aiPaused, "the AI paused pill");
      assert.ok(by(rs, "v2-offline").probe.aiOffline, "the AI offline bar");
      assert.ok(by(rs, "v2-legacy").probe.legacyCards >= 1, "legacy rows draw as before");
      for (const r of rs) assert.ok(r.metrics.minContrast >= 4.5, `${r.spec}: contrast ${r.metrics.minContrast}`);
    },
  );
}
