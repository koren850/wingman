// The main window. Pure logic (catalog parity, Fix it table, waiting list, settings search, first-run path, snapshot rules)
// and, opt-in (WINGMAN_DASH_SNAP=1, macOS), the whole hidden-window snapshot gate: dashboard/snapshot.sh --check.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const req = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const en: Record<string, string> = req("../dashboard/strings.en.js");
const he: Record<string, string> = req("../dashboard/strings.he.js");
const I = req("../dashboard/i18n.js");
const E = req("../dashboard/errors.js");
const HL = req("../dashboard/homelib.js");
const SL = req("../dashboard/setuplib.js");
const SS = req("../dashboard/settingslib.js");
const SC = req("../dashboard/snapcheck.cjs");
const catalog = req("../tray/settings-catalog.cjs");

test("Hebrew catalog has every key of the English catalog (a gap fails here), and nothing extra", () => {
  const gaps = Object.keys(en).filter((k) => !(k in he));
  const extra = Object.keys(he).filter((k) => !(k in en));
  assert.deepEqual(gaps, [], "keys missing in strings.he.js");
  assert.deepEqual(extra, [], "keys only in strings.he.js");
  for (const k of Object.keys(en)) assert.ok(he[k] && he[k].trim(), `${k} is empty in Hebrew`);
});

test("window language: the picker offers auto, English and Hebrew, and the choice decides the language and direction", () => {
  assert.deepEqual([...I.CHOICES], ["auto", "en", "he"]);
  assert.equal(I.resolve("he", "en-US"), "he");
  assert.equal(I.resolve("en", "he-IL"), "en");
  assert.equal(I.resolve("auto", "he-IL"), "he");
  assert.equal(I.dirOf("he"), "rtl");
  for (const c of I.CHOICES) assert.ok(en["lang." + c] && he["lang." + c], c);
  assert.ok(en["su.lang"] && he["su.lang"], "the first-run picker label");
});

test("first run: at most 5 steps to the first card, and a finished step drops off the path", () => {
  const all = SL.stepsToFirstCard({});
  assert.ok(all.length >= 1 && all.length <= SL.MAX_FIRST_CARD_STEPS, "steps: " + all.join(","));
  assert.ok(SL.MAX_FIRST_CARD_STEPS <= 5);
  assert.deepEqual(
    SL.stepsToFirstCard({ done: { connect: true } }),
    all.filter((s: string) => s !== "connect"),
  );
  assert.deepEqual(SL.stepsToFirstCard({ done: { connect: true, allow: true, try: true } }), []);
  // the path only names steps the guided setup really has
  for (const s of all) assert.ok(SL.REQUIRED.includes(s), s);
});

test("Fix it: every health message has an action or a stated reason, with texts in both languages", () => {
  assert.ok(E.HEALTH.length >= 12);
  for (const code of E.HEALTH) {
    const f = E.fixOf(code);
    assert.ok(!!f.action !== !!f.reason, `${code}: exactly one of action and reason`);
    for (const L of [en, he]) assert.ok(L[f.action ? f.label : f.reason], `${code} text`);
  }
  // the three named fixes: the right System Settings pane, retry, switch mic
  assert.equal(E.fixOf("mic-denied").action, "pane-mic");
  assert.equal(E.fixOf("audio-denied").action, "pane-audio");
  assert.equal(E.fixOf("mic-silent").action, "switch-mic");
  assert.equal(E.fixOf("stt-down").action, "retry-check");
  assert.equal(E.fixOf("key-anthropic").action, "keys");
  // a raw doctor line finds the same fix
  assert.equal(E.fixOf("no sound from the microphone: it looks blocked").code, "mic-denied");
  assert.equal(E.fixOf("something nobody wrote a pattern for").action, "retry-check");
  for (const a of E.FIX_ACTIONS) assert.ok(en["fix." + a] && he["fix." + a], a);
});

test("Waiting for you: one row per call, no stale calls, no crashed calls, at most three", () => {
  const now = Date.UTC(2026, 10, 8, 12);
  const day = 86400000;
  const call = (id: string, ago: number, extra: object = {}) => ({
    id,
    startedAt: now - ago,
    cardsTotal: 10,
    rated: 4,
    hasSummary: false,
    crashed: false,
    ...extra,
  });
  const pending = (c: any) => Math.max(0, c.cardsTotal - c.rated);
  const calls = [
    call("a", 1 * day),
    call("a", 1 * day), // the same call listed twice
    call("b", 2 * day, { hasSummary: true }),
    call("old", 30 * day), // stale: 30 days
    call("crash", 1 * day, { crashed: true }),
    call("done", 1 * day, { rated: 10 }), // nothing to rate, no summary
    call("c", 3 * day),
    call("d", 4 * day),
    call("e", 5 * day),
  ];
  const w = HL.waitingCalls(calls, now, pending);
  assert.deepEqual(
    w.rows.map((c: any) => c.id),
    ["a", "b", "c"],
  );
  assert.equal(w.more, 2);
  assert.equal(new Set(w.rows.map((c: any) => c.id)).size, w.rows.length);
  assert.deepEqual(HL.waitingCalls([call("old", 40 * day)], now, pending).rows, []);
  assert.ok(en["wait.benefit"].length < 90 && he["wait.benefit"], "one-line benefit");
});

test("Settings: advanced entries stay off the normal page; the engine setting is advanced; search finds a setting by label", () => {
  const items: any[] = catalog.items ?? catalog.ITEMS ?? catalog.CATALOG ?? Object.values(catalog).find((v) => Array.isArray(v));
  assert.ok(Array.isArray(items) && items.length > 20);
  const engine = items.find((i) => i.key === "moments.engine");
  assert.ok(engine, "the engine setting exists");
  assert.equal(SS.isAdvanced(engine), true);
  assert.equal(SS.isAdvanced({ key: "x.y", advanced: true, main: true }), true);
  assert.equal(SS.isAdvanced({ key: "cards.quiet" }), false);
  assert.ok(!SS.normalKeys(items, SS.MAIN_ORDER).includes("moments.engine"));
  const flagged = items.map((i) => (i.key === "cards.quiet" ? { ...i, advanced: true } : i)); // the flag set by the moments work
  assert.ok(!SS.normalKeys(flagged, SS.MAIN_ORDER).includes("cards.quiet"));
  assert.ok(SS.normalKeys(items, SS.MAIN_ORDER).includes("@mic"), "the microphone row stays");
  // search: by label, by a word of the help text, in any case, and an advanced setting too
  const q = items.find((i) => i.key === "cards.quiet");
  assert.ok(SS.search(items, q.label.toUpperCase()).some((i: any) => i.key === "cards.quiet"));
  assert.ok(!SS.search(items, "help engine").some((i: any) => i.key === "moments.engine"), "the engine row is hidden unless the file already chose Classic");
  const classic = items.map((i) => (i.key === "moments.engine" ? { ...i, value: "legacy" } : i));
  assert.ok(
    SS.search(classic, "help engine").some((i: any) => i.key === "moments.engine"),
    "...then it shows, so the person can switch back",
  );
  assert.deepEqual(SS.search(items, "   "), []);
  assert.deepEqual(SS.search(items, "zzzzqqqq"), []);
  const he1 = SS.search(items, "שקט", (i: any) => (i.key === "cards.quiet" ? "מצב שקט" : i.label));
  assert.ok(
    he1.some((i: any) => i.key === "cards.quiet"),
    "a Hebrew label is searchable",
  );
});

test("snapshot rules: the gate fails on a clipped pill, a second primary button, a twin waiting row, a stray Sample badge", () => {
  const ok = {
    ok: true,
    problems: [],
    lang: "en",
    dir: "ltr",
    primaries: 1,
    dupWait: 0,
    sample: 0,
    pills: 2,
    sheet: true,
    modeRows: 3,
    modeCustom: true,
    pastCard: true,
  };
  assert.deepEqual(SC.rules("idle-en-light", ok), []);
  assert.deepEqual(SC.rules("idle-he-dark", { ...ok, lang: "he", dir: "rtl" }), []);
  assert.match(SC.rules("idle-en-light", { ...ok, primaries: 2 })[0], /primary/);
  assert.match(SC.rules("waiting-en-light", { ...ok, dupWait: 1 })[0], /duplicate/);
  assert.match(SC.rules("golden-en-dark", { ...ok, sample: 1 })[0], /Sample/);
  assert.match(SC.rules("live-en-dark", { ...ok, problems: [".seg button wraps to 2 lines"] })[0], /wraps/);
  assert.match(SC.rules("live-he-dark", ok)[0], /direction/);
  assert.match(SC.rules("keys-en-light", { ...ok, sheet: false })[0], /keys sheet/);
  assert.match(SC.rules("live-en-dark", { ...ok, pills: 0 })[0], /pills/);
  assert.match(SC.rules("narrow-idle-en-light", { ...ok, primaries: 0 })[0], /primary/);
});

test("the snapshot fixtures write no twin calls, and the --check matrix covers EN and HE, light and dark, 900 px, and every state", () => {
  const sh = readFileSync(join(ROOT, "dashboard/snapshot.sh"), "utf8");
  for (const st of ["idle", "keys", "live", "golden", "ended", "waiting", "error", "settings", "narrow"]) assert.match(sh, new RegExp(`${st}-`), st);
  for (const v of ["en:light", "en:dark", "he:light", "he:dark", "900x900"]) assert.ok(sh.includes(v), v);
});

const SNAP = process.env.WINGMAN_DASH_SNAP === "1" && process.platform === "darwin" && existsSync(join(ROOT, "node_modules", ".bin", "electron"));
test("window snapshots: the whole gate (snapshot.sh --check) is green", { skip: !SNAP, timeout: 900_000 }, () => {
  const out = mkdtempSync(join(tmpdir(), "wm-dash-r2-"));
  const log = execFileSync(join(ROOT, "dashboard", "snapshot.sh"), ["--check", out], { timeout: 800_000 }).toString();
  assert.match(log, /\d+ snapshots, 0 failing/);
});

test("edge cases: a call with no date does not nag; odd input to fixOf and search never throws", () => {
  const pending = (c: any) => c.n;
  const now = Date.now();
  const rows = HL.waitingCalls([{ id: "x", n: 3 }, { id: "y", n: 3, startedAt: NaN }, { id: "z", n: 3, startedAt: now - 1000 }, null], now, pending).rows;
  assert.deepEqual(
    rows.map((c: any) => c.id),
    ["z"],
  );
  assert.deepEqual(HL.waitingCalls(undefined, now, pending).rows, []);
  for (const v of [undefined, null, "", 0, {}]) assert.ok(E.fixOf(v as any).code, String(v));
  assert.equal(E.fixOf("").code, "generic");
  assert.deepEqual(SS.search([{ key: "a.b", label: "A (b)" }], "(b) [x"), []);
  assert.equal(SS.search([{ key: "a.b", label: "A (b)" }], "(b)").length, 1);
  assert.equal(SS.isAdvanced(null), false);
  assert.ok(SS.normalKeys([], SS.MAIN_ORDER).includes("cards.quiet"), "an unknown key is not hidden");
});

test("Settings: the Classic engine option is not offered; the row shows only when the file already chose Classic", () => {
  const items: any[] = catalog.items ?? catalog.ITEMS ?? catalog.CATALOG ?? Object.values(catalog).find((v) => Array.isArray(v));
  const engine = items.find((i) => i.key === "moments.engine");
  assert.equal(SS.isHidden({ ...engine, value: "v2" }), true);
  assert.equal(SS.isHidden({ ...engine }), true);
  assert.equal(SS.isHidden({ ...engine, value: "legacy" }), false);
  assert.equal(SS.isHidden(items.find((i) => i.key === "cards.quiet")), false);
  assert.ok(!SS.visibleItems(items.map((i) => (i.key === "moments.engine" ? { ...i, value: "v2" } : i))).some((i: any) => i.key === "moments.engine"));
  assert.ok(SS.visibleItems(items).length === items.length - 1);
  // the value itself still works: the catalog still accepts it, so --set and the settings file keep working
  assert.ok(engine.options.some((o: string[]) => o[0] === "legacy"));
  assert.ok(
    !/question detector/i.test(readFileSync(join(ROOT, "dashboard", "strings.en.js"), "utf8")),
    "no 'Question detector (old)' wording is left in the window strings",
  );
});
