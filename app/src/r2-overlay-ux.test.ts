// Answer window, round 2 (r2-overlay-ux): the three-tier cards, freshness, the content-sized window, display follow and hotkey notes.
// The model (overlay/v2.js) and the window rules (overlay/window.cjs) are tested as plain code with injected clocks, screens and shortcut objects.
// The page itself is tested through the hidden snapshot tool (overlay/snap2.cjs), on macOS only like the other snapshot tests.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT } from "./env.ts";
import { MAC } from "./test-platform.ts";

const require = createRequire(import.meta.url);
const V = require("../overlay/v2.js");
const W = require("../overlay/window.cjs");
const strings = require("../overlay/strings.js");

const T0 = 1_000_000;
const row = (o: Record<string, unknown>) => ({ type: "card", id: "x", say: "Say this", at: T0, ...o });

// ---- labels, age, fade ----
test("label: the model's label wins (2 to 4 words, never cut inside a word); with none the label is empty and the page shows the kind word", () => {
  assert.equal(V.labelOf({ label: "PHP version" }), "PHP version");
  assert.equal(V.labelOf({}), "", "the first words of the line are not a label any more");
  assert.equal(V.labelOf({ label: "Backups, and how long they stay." }), "Backups, and how long");
  assert.equal(V.labelOf({ label: "" }), "");
  // a long label stops at a word boundary inside 28 characters
  const l = V.labelOf({ label: "Internationalization of the checkout flow" });
  assert.ok(l.length <= 28 && "Internationalization of the checkout flow".startsWith(l), l);
  assert.equal(V.labelOf({ label: "Internationalization of the checkout flow" }).endsWith(" "), false);
  // a single very long word stays whole (the page never cuts a word)
  assert.equal(V.labelOf({ label: "Supercalifragilisticexpialidocious" }), "Supercalifragilisticexpialidocious");
});

test("age: now, seconds in steps of five, minutes; stale levels at 3 and 6 minutes", () => {
  assert.deepEqual(V.ageParts(3000), { unit: "now", n: 0 });
  assert.deepEqual(V.ageParts(21_000), { unit: "s", n: 20 });
  assert.deepEqual(V.ageParts(59_000), { unit: "s", n: 55 }, "never shows 60 s");
  assert.deepEqual(V.ageParts(60_000), { unit: "min", n: 1 });
  assert.deepEqual(V.ageParts(200_000), { unit: "min", n: 3 });
  assert.deepEqual(
    [0, 59_999, 60_000, 179_999, 180_000, 359_999, 360_000].map((ms) => V.staleLevel(ms)),
    [0, 0, 0, 0, 1, 1, 2],
  );
});

// ---- rail ----
test("rail: at most three labelled chips, checks first, the rest counted for +N", () => {
  const b = new V.Board();
  b.apply(row({ id: "h", kind: "check", value: 3, at: T0 + 100, label: "Launch date" }), T0 + 100);
  for (let i = 0; i < 4; i++) b.apply(row({ id: "w" + i, kind: "answer", value: 1, at: T0 + i, label: "Topic " + i }), T0 + i);
  b.apply(row({ id: "f", kind: "fact", at: T0 + 50, label: "Their stack", src: "brief" }), T0 + 50);
  b.apply(row({ id: "c2", kind: "check", value: 1, at: T0 + 10, label: "Old check", ref: "other" }), T0 + 10);
  assert.equal(b.hero.id, "h");
  const { shown, more } = b.rail();
  assert.equal(shown.length, 3);
  assert.equal(shown[0].id, "c2", "a check leads the rail");
  assert.equal(shown[0].label, "Old check");
  assert.equal(shown.length + more.length, b.chips.length);
  assert.ok(more.length >= 1);
  assert.equal(b.cards.get("f").src, "brief");
});

test("rail: a fact keeps its source tag; a bad source is dropped", () => {
  const e1 = V.makeEntry(row({ kind: "fact", src: "past" }), T0);
  const e2 = V.makeEntry(row({ kind: "fact", src: "bogus" }), T0);
  assert.equal(e1.src, "past");
  assert.equal(e2.src, "");
  for (const s of V.SRC) assert.ok(strings.STRINGS.en["v2.src." + s] && strings.STRINGS.he["v2.src." + s], s);
});

// ---- checks: capped, merged, only the newest takes the hero ----
test("checks: open checks are capped at three and the oldest goes to history", () => {
  const b = new V.Board();
  for (let i = 0; i < 5; i++) b.apply(row({ id: "c" + i, kind: "check", value: 2, ref: "r" + i, at: T0 + i }), T0 + i);
  const open = [...b.cards.values()].filter((e: { kind: string }) => e.kind === "check");
  assert.equal(open.length, V.MAX_CHECKS);
  assert.equal(b.hero.id, "c4");
  assert.deepEqual(
    b.history.map((h: { id: string }) => h.id),
    ["c1", "c0"],
  );
});

test("checks: a check about the same ref or the same words replaces the older one", () => {
  const b = new V.Board();
  b.apply(row({ id: "c1", kind: "check", ref: "date", say: "You said Friday.", at: T0 }), T0);
  b.apply(row({ id: "c2", kind: "check", ref: "date", say: "You said Friday again.", at: T0 + 5 }), T0 + 5);
  b.apply(row({ id: "c3", kind: "check", say: "You said 2,400.", at: T0 + 6 }), T0 + 6);
  b.apply(row({ id: "c4", kind: "check", say: "you said  2,400.", at: T0 + 7 }), T0 + 7);
  const ids = [...b.cards.keys()].sort();
  assert.deepEqual(ids, ["c2", "c4"]);
  assert.equal(b.history.length, 0, "a merged check is not an earlier card");
});

test("checks: only the newest check can take the hero; an older one that arrives late waits", () => {
  const b = new V.Board();
  b.apply(row({ id: "c1", kind: "check", value: 1, ref: "a", at: T0 + 10 }), T0 + 10);
  b.apply(row({ id: "c0", kind: "check", value: 3, ref: "b", at: T0 + 5 }), T0 + 5);
  assert.equal(b.hero.id, "c1", "the newer check keeps the seat even when the older one has a higher value");
  b.apply(row({ id: "c2", kind: "check", value: 1, ref: "c", at: T0 + 20 }), T0 + 20);
  assert.equal(b.hero.id, "c2");
  // an answer never takes the seat from a check
  b.apply(row({ id: "a", kind: "answer", value: 3, at: T0 + 30 }), T0 + 30);
  assert.equal(b.hero.id, "c2");
});

// ---- freshness ----
test("new dot: a rail chip is new until it was on the rail for SEEN_MS, or tapped", () => {
  const b = new V.Board();
  b.apply(row({ id: "h", kind: "answer", value: 3, at: T0 + 9 }), T0 + 9);
  b.apply(row({ id: "a", kind: "answer", value: 1, at: T0 + 5 }), T0 + 5);
  b.apply(row({ id: "b", kind: "answer", value: 1, at: T0 + 4 }), T0 + 4);
  assert.equal(b.cards.get("a").seen, false);
  assert.equal(b.markSeen(T0), false, "the first look only starts the clock");
  assert.equal(b.markSeen(T0 + V.SEEN_MS - 1), false);
  assert.equal(b.markSeen(T0 + V.SEEN_MS), true);
  assert.equal(b.cards.get("a").seen, true);
  assert.equal(b.cards.get("b").seen, true);
  b.apply(row({ id: "n", kind: "answer", value: 1, at: T0 + 8 }), T0 + 8);
  assert.equal(b.cards.get("n").seen, false, "a new chip starts new");
  b.promote("n");
  assert.equal(b.cards.get("n").seen, true, "a tap clears it");
  // an update of the same card keeps what was seen
  b.apply(row({ id: "a", kind: "answer", value: 1, say: "More text", at: T0 + 5 }), T0 + 9000);
  assert.equal(b.cards.get("a").seen, true);
});

test("new dot: a chip behind +N does not run the clock", () => {
  const b = new V.Board();
  b.apply(row({ id: "h", kind: "answer", value: 3, at: T0 + 100 }), T0 + 100);
  for (let i = 0; i < 4; i++) b.apply(row({ id: "w" + i, kind: "answer", value: 1, at: T0 + i }), T0 + i);
  b.markSeen(T0);
  b.markSeen(T0 + V.SEEN_MS + 1);
  const { more } = b.rail();
  assert.equal(more.length, 1);
  assert.equal(more[0].seen, false);
});

// ---- dim by reason, undo ----
test("dim time follows the reason: answered is short, topic and time stay longer", () => {
  assert.ok(V.DIM_BY.answered < V.DIM_BY.topic && V.DIM_BY.topic < V.DIM_BY.time);
  const b = new V.Board();
  b.apply(row({ id: "a", kind: "answer", at: T0 }), T0);
  b.apply(row({ id: "t", kind: "answer", at: T0 - 5, ref: "t" }), T0);
  b.apply({ type: "card", id: "a", closes: "answered", at: T0 }, T0);
  b.apply({ type: "card", id: "t", closes: "topic", at: T0 }, T0);
  b.tick(T0 + V.DIM_BY.answered);
  assert.equal(b.has("a"), false);
  assert.equal(b.has("t"), true, "the topic card is still there when the answered one has gone");
  b.tick(T0 + V.DIM_BY.topic);
  assert.equal(b.has("t"), false);
});

test("undo: the card that left comes back within 30 s, not after", () => {
  const b = new V.Board();
  b.apply(row({ id: "a", kind: "answer", at: T0 }), T0);
  b.remove("a", "dismissed", T0 + 1000);
  assert.equal(b.has("a"), false);
  const back = b.restoreLast(T0 + 1000 + V.UNDO_MS);
  assert.equal(back.id, "a");
  assert.equal(b.hero.id, "a");
  assert.equal(b.history.length, 0);
  b.remove("a", "dismissed", T0 + 2000);
  assert.equal(b.restoreLast(T0 + 2000 + V.UNDO_MS + 1), null, "too late");
});

test("undo: a restored check takes the hero seat; a restored answer waits behind a live hero", () => {
  const b = new V.Board();
  b.apply(row({ id: "a", kind: "answer", value: 1, at: T0 }), T0);
  b.apply(row({ id: "b", kind: "answer", value: 3, at: T0 + 1 }), T0 + 1);
  b.remove("a", "time", T0 + 2);
  b.restoreLast(T0 + 3);
  assert.equal(b.hero.id, "b");
  assert.ok(b.chips.some((e: { id: string }) => e.id === "a"));
});

// ---- window bounds ----
const WORK = { x: 0, y: 25, width: 1920, height: 1055 };
test("fitBounds: the height follows the content, the window stays inside the work area", () => {
  const small = W.fitBounds({ content: 120, work: WORK });
  assert.equal(small.height, 120);
  assert.ok(W.inside(small, WORK));
  assert.equal(small.x + small.width, WORK.width - 20, "top right corner by default");
  const huge = W.fitBounds({ content: 9000, work: WORK });
  assert.ok(huge.height <= WORK.height - 16 && W.inside(huge, WORK));
  const tiny = W.fitBounds({ content: 3, work: WORK });
  assert.equal(tiny.height, W.MIN_H, "never thinner than a bar of pills");
  // a window the user dragged off the screen is pulled back; one that grows past the bottom is moved up
  const off = W.fitBounds({ content: 400, work: WORK, current: { x: 5000, y: 5000 } });
  assert.ok(W.inside(off, WORK));
  const narrow = W.fitBounds({ content: 300, work: { x: 0, y: 0, width: 500, height: 800 }, width: 760 });
  assert.equal(narrow.width, 500);
});

// ---- display follow with an injected screen ----
type Disp = { id: number; workArea: { x: number; y: number; width: number; height: number } };
function rig(displays: Disp[], cfg: Record<string, unknown> = {}) {
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const state = { displays: displays.slice(), primaryId: displays[0]!.id };
  const screen = {
    getAllDisplays: () => state.displays,
    getPrimaryDisplay: () => state.displays.find((d) => d.id === state.primaryId) ?? state.displays[0]!,
    on: (n: string, f: (...a: unknown[]) => void) => (handlers[n] = f),
  };
  const calls: string[] = [];
  let bounds = { x: 0, y: 0, width: 760, height: 300 };
  let visible = true;
  const win = {
    isDestroyed: () => false,
    hide: () => (calls.push("hide"), (visible = false)),
    showInactive: () => (calls.push("showInactive"), (visible = true)),
    setBounds: (b: typeof bounds) => (calls.push("setBounds"), (bounds = b)),
    getBounds: () => bounds,
    isVisible: () => visible,
  };
  const notes: string[] = [];
  const follow = W.createDisplayFollow({ screen, win, cfg: { display: "secondary", allowPrimary: false, ...cfg }, note: (k: string) => notes.push(k) });
  return {
    follow,
    state,
    handlers,
    calls,
    notes,
    get bounds() {
      return bounds;
    },
    get visible() {
      return visible;
    },
  };
}
const PRIMARY: Disp = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const SECOND: Disp = { id: 2, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } };

test("display follow: unplugging the chosen display hides the window and writes a note; plugging it back restores it", () => {
  const r = rig([PRIMARY, SECOND]);
  const d = r.follow.start();
  assert.equal(d.id, 2);
  r.follow.attach();
  r.follow.fit(300);
  assert.ok(W.inside(r.bounds, SECOND.workArea));
  // unplug
  r.state.displays = [PRIMARY];
  r.handlers["display-removed"]!({}, SECOND);
  assert.equal(r.visible, false, "hidden");
  assert.deepEqual(r.notes, ["removed"]);
  assert.equal(r.follow.hidden, true);
  const before = r.calls.filter((c) => c === "setBounds").length;
  r.follow.fit(500); // the page keeps reporting heights: nothing may move while hidden
  assert.equal(r.calls.filter((c) => c === "setBounds").length, before, "no move to the primary screen");
  assert.equal(r.visible, false);
  // plug it back (the same id, a new resolution)
  const back: Disp = { id: 2, workArea: { x: 1440, y: 0, width: 2560, height: 1440 } };
  r.state.displays = [PRIMARY, back];
  r.handlers["display-added"]!({}, back);
  assert.equal(r.visible, true);
  assert.ok(W.inside(r.bounds, back.workArea), JSON.stringify(r.bounds));
  assert.equal(r.notes.at(-1), "", "the note is cleared");
  assert.equal(r.calls.at(-1), "showInactive", "shown without focus");
  assert.equal(r.calls.includes("show"), false);
});

test("display follow: removing a display that is not the chosen one changes nothing", () => {
  const third: Disp = { id: 3, workArea: { x: 3360, y: 0, width: 1920, height: 1080 } };
  const r = rig([PRIMARY, SECOND, third]);
  r.follow.start();
  r.state.displays = [PRIMARY, SECOND];
  r.follow.removed(third);
  assert.equal(r.visible, true);
  assert.deepEqual(r.notes, []);
});

test("display follow: with a third screen the window may move to another non-primary screen, never to the primary one", () => {
  const third: Disp = { id: 3, workArea: { x: 3360, y: 0, width: 1920, height: 1080 } };
  const r = rig([PRIMARY, SECOND, third]);
  r.follow.start();
  assert.equal(r.follow.chosen, 2);
  r.state.displays = [PRIMARY, third];
  r.follow.removed(SECOND);
  assert.equal(r.follow.chosen, 3);
  assert.ok(W.inside(r.bounds, third.workArea));
  assert.equal(r.visible, true);
  r.state.displays = [PRIMARY];
  r.follow.removed(third);
  assert.equal(r.visible, false);
});

test("display follow: one display refuses; allowPrimary is the only way onto the primary screen", () => {
  const one = rig([PRIMARY]);
  assert.equal(one.follow.start(), null);
  assert.equal(
    W.pickDisplay({ getAllDisplays: () => [PRIMARY], getPrimaryDisplay: () => PRIMARY }, { allowPrimary: false, display: "secondary" }).warn,
    "single",
  );
  const ok = rig([PRIMARY], { allowPrimary: true });
  assert.equal(ok.follow.start().id, 1);
  // unplugging the second screen with allowPrimary false and only the primary left: hidden, not moved
  const r = rig([PRIMARY, SECOND]);
  r.follow.start();
  r.state.displays = [PRIMARY];
  r.follow.removed(SECOND);
  assert.equal(r.follow.hidden, true);
  r.follow.added(); // an added event with no fitting display
  assert.equal(r.follow.hidden, true);
  assert.equal(r.visible, false);
});

test("display follow: a resolution change keeps the window inside the chosen display", () => {
  const r = rig([PRIMARY, SECOND]);
  r.follow.start();
  r.follow.fit(400);
  const smaller: Disp = { id: 2, workArea: { x: 1440, y: 0, width: 1000, height: 600 } };
  r.state.displays = [PRIMARY, smaller];
  r.follow.metrics(smaller);
  assert.ok(W.inside(r.bounds, smaller.workArea), JSON.stringify(r.bounds));
});

// ---- hotkeys ----
test("hotkeys: a key another app owns is reported, not swallowed", () => {
  const taken = new Set(["Control+Alt+S"]);
  const gs = { register: (a: string) => !taken.has(a) };
  const r = W.registerHotkeys(gs, [
    { name: "pin", accel: "Control+Alt+S", run: () => {} },
    { name: "dismiss", accel: "Control+Alt+D", run: () => {} },
  ]);
  assert.deepEqual(r.ok, ["dismiss"]);
  assert.deepEqual(r.failed, [{ name: "pin", accel: "Control+Alt+S", why: "taken" }]);
  const note = W.hotkeyNote(r.failed, (k: string, v: Record<string, string>) => strings.t("en", k, v));
  assert.match(note, /Ctrl\+Opt\+S/);
  assert.match(note, /Pin/);
  assert.match(note, /another app/);
  const he = W.hotkeyNote(r.failed, (k: string, v: Record<string, string>) => strings.t("he", k, v));
  assert.match(he, /Ctrl\+Opt\+S/);
  assert.match(he, /תפוס/);
});

test("hotkeys: a register that throws or a duplicate key is a failure, an empty key is skipped, all-good gives no note", () => {
  const gs = {
    register: (a: string) => {
      if (a === "bad") throw new Error("invalid accelerator");
      return true;
    },
  };
  const r = W.registerHotkeys(gs, [
    { name: "a", accel: "bad", run: () => {} },
    { name: "b", accel: "Control+Alt+B", run: () => {} },
    { name: "c", accel: "Control+Alt+B", run: () => {} },
    { name: "d", accel: "", run: () => {} },
  ]);
  assert.deepEqual(r.ok, ["b"]);
  assert.deepEqual(
    r.failed.map((f: { name: string; why: string }) => [f.name, f.why]),
    [
      ["a", "invalid"],
      ["c", "duplicate"],
    ],
  );
  assert.equal(
    W.hotkeyNote([], () => ""),
    "",
  );
});

test("strings: the note and hotkey names exist in both languages and the placeholders match", () => {
  const keys = Object.keys(strings.STRINGS.en).filter((k) => k.startsWith("note.") || k.startsWith("hk."));
  assert.ok(keys.length >= 14);
  for (const k of keys) {
    assert.ok(k in strings.STRINGS.he, k);
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    assert.equal(ph(strings.STRINGS.he[k]), ph(strings.STRINGS.en[k]), k);
  }
  for (const n of ["clear", "pause", "rewind", "copy", "checklist", "more", "pin", "useful", "notUseful", "dismiss", "restore", "recap"])
    assert.ok("hk." + n in strings.STRINGS.en, n);
});

// ---- snapshots: the page itself ----
const HAVE_ELECTRON = existsSync(join(ROOT, "node_modules/.bin/electron"));
const SNAP = { ...MAC, skip: MAC.skip || (!HAVE_ELECTRON && "electron is not installed") };
type Probe = {
  hero: string;
  heroClass: string;
  heroDir: string;
  age: string;
  labels: string[];
  newDots: number;
  chipAges: string[];
  more: string;
  sources: string[];
  pillX: number | null;
  ctlX: number | null;
  heroX: number;
  heroW: number;
  pillsX: number[];
  railX: number[];
  because: { text: string; bidi: string } | null;
  ask: string;
  note: string;
  strips: string[];
  menuOpen: boolean;
  skeleton: number;
  recapSections: number;
  recapTop: number | null;
  captionBottom: number | null;
  bar: boolean;
  iconOnly: boolean;
};
type Res = {
  spec: string;
  png: string;
  issues: { type: string; sel: string; detail: string }[];
  metrics: { chipRows: number; minContrast: number };
  probe: Probe;
  animations: number;
  heroAnim: string;
  live: string;
  focusable: boolean;
  focused: boolean;
  ipc: [string, unknown][];
  fit?: { reported: number; after: number; inner: number; stable: boolean };
};
function snap(lang: "en" | "he", specs: string[]): Res[] {
  const out = mkdtempSync(join(tmpdir(), "wm-r2-"));
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

for (const lang of ["en", "he"] as const) {
  test(`snapshots (${lang}): busy call, long text, aged card and restore pass the checks; at most 2 chip rows; labels whole`, SNAP, () => {
    const rs = snap(lang, ["v2-busy", "v2-busy:light,l", "v2-busy-open", "v2-long", "v2-aged", "v2-rtl", "v2-restore", "v2-mixed"]);
    for (const r of rs) assert.deepEqual(r.issues, [], r.spec + " " + JSON.stringify(r.issues));
    for (const r of rs) assert.ok(r.metrics.chipRows <= 2, `${r.spec}: ${r.metrics.chipRows} chip rows`);
    const busy = by(rs, "v2-busy").probe;
    assert.ok(busy.labels.length <= 3 && busy.labels.length >= 1, "rail: " + busy.labels.join(" | "));
    assert.match(busy.more, /\+\d/, "the rest sit behind +N");
    assert.ok(busy.newDots >= 1, "new dots on fresh chips");
    assert.equal(by(rs, "v2-busy").probe.hero.length > 0, true);
    // labels are whole words of the label or of the line, never a cut
    for (const l of busy.labels) assert.ok(!/[…]$/.test(l) && l.trim().length > 0, l);
    assert.equal(busy.iconOnly, true, "thumbs and menu are icon-only buttons with a label");
    // the 6 minute old answer is a chip that says how old it is (the stale and collapse rules are tested in r3-cards-overlay.test.ts)
    const aged = by(rs, "v2-aged").probe;
    assert.ok(
      aged.chipAges.some((a: string) => (lang === "en" ? /6 min/ : /6 דק/).test(a)),
      aged.chipAges.join("|"),
    );
    // restore: dismissed, then the restore key: the hero is back
    assert.ok(by(rs, "v2-restore").probe.hero.length > 0, "the dismissed card came back");
    // the Because label is its own isolate
    const ans = by(rs, "v2-mixed").probe;
    assert.equal(ans.because?.bidi, "isolate");
    // nothing of this takes the focus
    for (const r of rs) assert.equal(r.focusable || r.focused, false);
  });

  test(`snapshots (${lang}): the live announcement, the prompt as speech, the fact source tag, both speakers, the note banner`, SNAP, () => {
    const rs = snap(lang, ["v2-answer", "v2-prompt", "v2-fact", "v2-both", "v2-note"]);
    for (const r of rs) assert.deepEqual(r.issues, [], r.spec + " " + JSON.stringify(r.issues));
    const a = by(rs, "v2-answer");
    assert.ok(a.live.includes(a.probe.hero), "aria-live polite announces the new hero: " + a.live);
    assert.ok(by(rs, "v2-prompt").probe.ask.startsWith(lang === "en" ? "Ask:" : "שאל:"), "a prompt reads as speech");
    assert.deepEqual(by(rs, "v2-fact").probe.sources, [strings.t(lang, "v2.src.brief")], "a fact chip shows where it comes from");
    const both = by(rs, "v2-both").probe.strips;
    assert.ok(both[0]!.length > 0 && both[1]!.length > 0, "both speakers are on screen: " + JSON.stringify(both));
    assert.match(by(rs, "v2-note").probe.note, /Ctrl\+Opt\+S/);
  });

  test(`snapshots (${lang}): reduced motion runs no animation, normal motion pulses the new hero`, SNAP, () => {
    const rs = snap(lang, ["v2-answer", "v2-answer:reduce"]);
    assert.ok(rs[0]!.animations >= 1 || rs[0]!.heroAnim === "hpulse", "the border pulse runs");
    assert.equal(rs[1]!.animations, 0, "reduced motion: nothing runs");
    assert.equal(rs[1]!.heroAnim, "none", "reduced motion: no pulse on the hero");
  });

  test(`snapshots (${lang}): Catch me up shows skeleton rows for sections that have not come, and never covers the caption`, SNAP, () => {
    const rs = snap(lang, ["v2-live-stream", "v2-live-recapdone"]);
    for (const r of rs) assert.deepEqual(r.issues, [], r.spec + " " + JSON.stringify(r.issues));
    const stream = by(rs, "v2-live-stream").probe;
    assert.ok(stream.skeleton >= 1, "skeleton rows while streaming");
    assert.ok(stream.skeleton < stream.recapSections, "the sections that came are already drawn");
    assert.ok(stream.recapTop! >= stream.captionBottom!, "the sheet sits below the caption");
    assert.equal(by(rs, "v2-live-recapdone").probe.skeleton, 0);
  });

  test(`snapshots (${lang}): the window height follows the content and folds to a bar when idle`, SNAP, () => {
    const rs = snap(lang, ["v2-fit-empty", "v2-fit-idle", "v2-fit-answer", "v2-fit-recap"]);
    for (const r of rs) assert.deepEqual(r.issues, [], r.spec + " " + JSON.stringify(r.issues));
    const h = (n: string) => by(rs, n).fit!;
    for (const n of ["v2-fit-empty", "v2-fit-idle", "v2-fit-answer", "v2-fit-recap"]) assert.equal(h(n).stable, true, n + " is stable (no feedback loop)");
    assert.equal(by(rs, "v2-fit-idle").probe.bar, true, "idle folds to a bar");
    assert.equal(by(rs, "v2-fit-answer").probe.bar, false);
    assert.ok(h("v2-fit-idle").reported < h("v2-fit-answer").reported, "a card makes the window taller");
    assert.ok(h("v2-fit-idle").reported <= 200, "the bar is thin: " + h("v2-fit-idle").reported);
    assert.ok(h("v2-fit-answer").reported <= 520 && h("v2-fit-answer").reported >= 200, "answer: " + h("v2-fit-answer").reported);
    assert.ok(h("v2-fit-recap").reported >= h("v2-fit-answer").reported, "the open sheet is part of the content");
    for (const r of rs) assert.equal(r.focusable || r.focused, false);
  });
}

test("snapshots (he): the card follows its own direction: pill on the right, controls on the left, the pills row mirrored", SNAP, () => {
  const rs = snap("he", ["v2-answer", "v2-busy"]);
  const p = by(rs, "v2-answer").probe;
  assert.equal(p.heroDir, "rtl");
  assert.ok(p.pillX! > p.ctlX!, `pill ${p.pillX} should be right of the controls ${p.ctlX}`);
  // the pills row starts on the right: the first pill is the right-most
  const b = by(rs, "v2-busy").probe;
  assert.ok(b.pillsX[0]! > b.pillsX[1]!, "first pill is right-most: " + b.pillsX.join(","));
  assert.ok(b.railX[0]! > b.railX[1]!, "first chip is right-most: " + b.railX.join(","));
  assert.equal(p.because?.bidi, "isolate");
});

test("snapshots (en): the same card is left to right, and an English window with a Hebrew card mirrors only the card", SNAP, () => {
  const rs = snap("en", ["v2-answer", "v2-rtl"]);
  const a = by(rs, "v2-answer").probe;
  assert.equal(a.heroDir, "ltr");
  assert.ok(a.pillX! < a.ctlX!);
  const h = by(rs, "v2-rtl").probe;
  assert.equal(h.heroDir, "rtl");
  assert.ok(h.pillX! > h.ctlX!);
  assert.ok(h.pillsX[0]! < h.pillsX[1]!, "the chrome follows the window language");
});

test("review: fitBounds survives bad input and tiny screens; the hotkey note text names the key and the action", () => {
  for (const content of [NaN, -5, Infinity, undefined, "12"]) {
    const b = W.fitBounds({ content, work: WORK });
    assert.ok(W.inside(b, WORK), `inside for ${String(content)}`);
    assert.ok(b.height >= W.MIN_H);
  }
  const tiny = { x: 100, y: 50, width: 300, height: 120 };
  assert.ok(W.inside(W.fitBounds({ content: 5000, work: tiny }), tiny));
  const t = (k: string, v?: Record<string, string>) => strings.t("en", k, v);
  const note = W.hotkeyNote([{ name: "dismiss", accel: "Control+Alt+D", why: "taken" }], t);
  assert.match(note, /Ctrl\+Opt\+D/);
  assert.match(note, /Dismiss/);
});

// ---- pre-release polish: idle copy, offline frame, sentence cut, one time unit, key bar, context panel ----
const TX = require("../overlay/text.js");
const FX = require("../overlay/fixtures-v2.cjs");

test("idle copy is about cards, not only questions (en and he)", () => {
  assert.equal(strings.t("en", "state.listening.sub"), "Listening. Cards appear when something needs your attention.");
  assert.match(strings.t("he", "state.listening.sub"), /כרטיסים יופיעו/);
  for (const l of ["en", "he"]) assert.doesNotMatch(strings.t(l, "state.listening.sub"), /Nobody|אף אחד/);
});

test("time units: one style, a number, a space, then the unit (s, min); no glued '23s'", () => {
  assert.equal(strings.t("en", "age.seconds", { n: 23 }), "23 s ago");
  assert.equal(strings.t("en", "age.minutes", { n: 2 }), "2 min ago");
  assert.equal(strings.t("en", "ask.seconds", { n: 20 }), "20 s");
  assert.equal(strings.t("en", "v2.age.s", { n: 50 }), "50 s");
  assert.equal(strings.t("en", "v2.age.min", { n: 2 }), "2 min");
  for (const k of ["age.seconds", "age.minutes", "ask.seconds", "v2.age.s", "v2.age.min"]) assert.doesNotMatch(strings.t("en", k, { n: 7 }), /\d[a-z]/i, k);
  for (const k of ["age.seconds", "age.minutes", "ask.seconds", "v2.age.s", "v2.age.min"]) assert.doesNotMatch(strings.t("he", k, { n: 7 }), /\d[a-z]|sec/i, k);
});

test("sentences: split at . ! ? and the Hebrew mark; a number like 3.9 is not an end", () => {
  assert.deepEqual(TX.sentences("It costs 3.9 today. Setup takes two days! Is that fine?"), ["It costs 3.9 today.", "Setup takes two days!", "Is that fine?"]);
  assert.deepEqual(TX.sentences("  "), []);
  assert.deepEqual(TX.sentences("no end mark"), ["no end mark"]);
  assert.deepEqual(TX.sentences("כן, אפשר. זה לוקח יומיים."), ["כן, אפשר.", "זה לוקח יומיים."]);
});

test("sentencePrefix: the longest run of whole sentences that fits; empty when the first one alone does not", () => {
  const t = "One is short. Two is a bit longer. Three is the longest of them all.";
  assert.equal(
    TX.sentencePrefix(t, (c: string) => c.length <= 40),
    "One is short. Two is a bit longer.",
  );
  assert.equal(
    TX.sentencePrefix(t, (c: string) => c.length <= 14),
    "One is short.",
  );
  assert.equal(
    TX.sentencePrefix(t, (c: string) => c.length <= 5),
    "",
  );
  assert.equal(
    TX.sentencePrefix("Only one sentence here.", () => false),
    "",
  );
});

test("the offline fixture shows prepared cards only: no 'AI unverified' card beside the 'AI offline' bar", () => {
  const T = FX.TXT ? FX.TXT.en : null;
  const sc = FX.SCENARIOS["v2-offline"];
  assert.ok(sc && T, "scenario and text are exported");
  const rows = sc(T).rows;
  assert.ok(rows.some((r: { type: string; ai?: string }) => r.type === "view" && r.ai === "offline"));
  assert.ok(!rows.some((r: { badge?: string }) => r.badge === "ai"), "no AI-badged card while the AI is offline");
  assert.ok(rows.some((r: { badge?: string }) => r.badge === "bank"));
});

test("page: a long collapsed card ends at a sentence end; Hebrew key bar reads left to right; context headings line up", { ...SNAP, timeout: 200_000 }, () => {
  for (const lang of ["en", "he"] as const) {
    const rs = snap(lang, ["v2-long", "v2-answer", "v2-context"]);
    const long = by(rs, "v2-long").probe;
    assert.match(long.hero, /[.!?]$/, lang + ": the collapsed card does not end mid-sentence: " + long.hero);
    assert.equal((long as Probe & { heroCut: boolean }).heroCut, false, lang + ": nothing is cut by the line clamp");
    for (const r of rs) assert.deepEqual(r.issues, [], lang + " " + r.spec);
    const p = by(rs, "v2-answer").probe as Probe & { keysDir: string; firstKeyText: string };
    assert.equal(p.keysDir, "ltr", lang + ": key caps read left to right");
    assert.match(p.firstKeyText, /^Ctrl\+Opt\+/, lang + ": the chord leads the row");
  }
});
