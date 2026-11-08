// Round 12, r3-app-ux: first run, plain readiness, Start with a reason, settings tabs, the review step before Start, call kind, tray text.
// Pure logic (the helper libraries of the window), no browser. The window snapshots with the clip and contrast checks are the opt-in test at the end.
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
const I = req("../dashboard/i18n.js");
const en: Record<string, string> = req("../dashboard/strings.en.js");
const he: Record<string, string> = req("../dashboard/strings.he.js");
const E = req("../dashboard/errors.js");
const K = req("../dashboard/knowslib.js");
const HL = req("../dashboard/homelib.js");
const SL = req("../dashboard/setuplib.js");
const SS = req("../dashboard/settingslib.js");
const MT = req("../tray/menu-text.cjs");
const PT = req("../tray/prompt-text.js");
const SC = req("../dashboard/snapcheck.cjs");
const DASH = join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard");
const HEB = /[֐-׿]/;
/** An upper-case name with an underscore (DEEPGRAM_API_KEY, WINGMAN_DATA_DIR) or a file that holds secrets. */
const ENV_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|keys\.env|\.env\b/;

// ---- first run ----
test("first run: from the first launch to the first practice card is at most 5 steps, and none of them needs a key", () => {
  const first = SL.stepsToFirstCard({});
  assert.deepEqual(first, ["connect", "allow", "try"]);
  assert.ok(first.length + 0 <= SL.MAX_FIRST_CARD_STEPS, "steps on screen");
  // each step the person does is one click or one choice; the practice call is the last click. Keys can be skipped: the step is settled, not done.
  const skipKeys = SL.plan({ done: { try: true }, skipped: { connect: true } });
  assert.equal(skipKeys.next, "allow", "skipping keys moves on to the microphone step");
  assert.equal(SL.plan({ done: { allow: true }, skipped: { connect: true } }).next, "try", "the practice call is the step that is left");
  const clicks = [
    "keys: skip",
    "microphone: allow",
    "practice: try a practice call", // the practice call is offline and free: it needs no key
  ];
  assert.ok(clicks.length <= SL.MAX_FIRST_CARD_STEPS);
  assert.equal(SL.stepsToFirstCard({ done: { connect: true, allow: true } }).join(), "try");
  assert.equal(SL.stepsToFirstCard({ done: { connect: true, allow: true, try: true } }).length, 0);
});

test("first run: the practice button sits next to Start until the first call is saved (Home source order is checked in the window snapshot)", () => {
  const has = (k: string) => k in en && k in he;
  for (const k of ["home.practice", "home.practiceWith", "home.quickCall", "start.why.keys"]) assert.ok(has(k), k);
  assert.match(en["start.why.keys"], /practice call works without them/i);
});

// ---- plain readiness: no env var names anywhere the person reads ----
test("plain words: no catalog text, tray menu text, note-window text or error table text has an env var name", () => {
  for (const [k, v] of Object.entries(en)) assert.doesNotMatch(v, ENV_NAME, "en " + k);
  for (const [k, v] of Object.entries(he)) assert.doesNotMatch(v, ENV_NAME, "he " + k);
  for (const [k, row] of Object.entries<string[]>(MT.T)) for (const v of row) assert.doesNotMatch(v, ENV_NAME, "menu " + k);
  for (const [k, row] of Object.entries<string[]>(PT.T)) for (const v of row) assert.doesNotMatch(v, ENV_NAME, "prompt " + k);
});

test("plain words: readiness lines from the command-line check are said in plain words (env names, files, terminal)", () => {
  const raw = [
    "ANTHROPIC_API_KEY is missing: add it to ~/.config/wingman/keys.env",
    "DEEPGRAM_API_KEY missing. Run wingman keys set in your terminal",
    "GOOGLE_GENERATIVE_AI_API_KEY is not set",
    "WINGMAN_USER_SETTINGS points to a file that does not exist",
    "MY_NEW_THING_KEY rejected (401)",
  ];
  for (const r of raw) {
    const t = HL.niceFix(r);
    assert.doesNotMatch(t, ENV_NAME, r + " -> " + t);
  }
  assert.equal(HL.niceFix(raw[0]), "The Anthropic key is missing: add it in Settings, Keys");
  assert.match(HL.niceFix(raw[1]), /^The Deepgram key missing/);
  assert.equal(HL.plainText("Nothing to change"), "Nothing to change");
  // a line that did not name a variable is not touched
  assert.equal(HL.niceFix("microphone is silent"), "microphone is silent");
});

test("errors: every code in the table has its text, next step and button in English and Hebrew, with no env names", () => {
  assert.ok(E.TABLE.length >= 25);
  for (const e of E.TABLE) {
    for (const [lang, L] of [
      ["en", en],
      ["he", he],
    ] as const) {
      const d = E.describe((k: string, v?: object) => I.t(lang, k, v), e.code);
      assert.equal(d.code, e.code);
      for (const part of [d.what, d.next, d.btn]) {
        assert.ok(part && part !== `err.${e.code}.what`, `${lang} ${e.code} text`);
        assert.doesNotMatch(part, ENV_NAME, `${lang} ${e.code}`);
      }
      if (lang === "he") assert.match(d.what + d.next + d.btn, HEB, e.code);
      assert.ok(L[`err.${e.code}.what`] && L[`err.${e.code}.next`] && L[`err.${e.code}.btn`], `${lang} ${e.code} keys`);
    }
    assert.ok(E.ACTIONS.includes(e.action), e.code + " action");
  }
});

// ---- Start is disabled with a reason ----
test("start state: missing keys or a failed check disable Start with a plain reason; not checked and busy never block", () => {
  const ready = HL.startState(null, []);
  assert.deepEqual([ready.ready, ready.disabled], [true, false]);
  assert.equal(HL.startState({ ok: true, verdict: "READY", failing: [] }, []).disabled, false);
  assert.equal(HL.startState({ ok: false, verdict: "BUSY", failing: [] }, []).disabled, false, "busy is not a failure");

  const keys = HL.startState(null, ["Anthropic"]);
  assert.deepEqual([keys.disabled, keys.why, keys.code], [true, "start.why.keys", "key-anthropic"]);
  assert.equal(HL.startState(null, ["Deepgram", "Anthropic"]).code, "key-deepgram");
  assert.ok(en[keys.why] && he[keys.why], "the reason is in both languages");
  assert.equal(E.fixOf(keys.code).action, "keys", "the Fix it button opens the keys sheet");

  const bad = HL.startState({ ok: false, verdict: "NOT READY", failing: [{ text: "DEEPGRAM_API_KEY missing", fix: "add it to keys.env" }] }, []);
  assert.equal(bad.disabled, true);
  assert.doesNotMatch(bad.raw, ENV_NAME);
  assert.match(bad.raw, /Deepgram key/);
  assert.equal(E.classify(bad.rawSource).code, "key-deepgram", "the line maps to an error code, so the Fix it button knows what to do");
  assert.equal(HL.startState({ ok: false, verdict: "NOT READY", failing: [] }, []).raw, "", "no first failing line: still disabled, generic reason");
});

test("shortcuts: symbols on macOS, words elsewhere, and the word is kept as the tooltip", () => {
  assert.equal(HL.keySym("Ctrl", true), "⌃");
  assert.equal(HL.keySym("Opt", true), "⌥");
  assert.equal(HL.keySym("Return", true), "↩");
  assert.equal(HL.keySym("A", true), "A");
  assert.equal(HL.keySym("Ctrl", false), "Ctrl");
  assert.equal(HL.keyName("Opt"), "Option");
  assert.equal(HL.keyName("Ctrl"), "Control");
  assert.equal(HL.keyName("Z"), "Z");
});

// ---- live view and after the call (the catalog side; the drawn page is checked in the snapshot test) ----
test("live view: the plain-word tooltips exist in both languages, and the labels say what they count", () => {
  for (const k of ["decided", "open", "promises", "cover"]) {
    assert.ok(en[`sofar.${k}.tip`] && he[`sofar.${k}.tip`], k);
    assert.match(he[`sofar.${k}.tip`], HEB);
  }
  assert.match(en["sofar.open"], /Open questions/);
  assert.match(en["sofar.cover"], /Still to cover/);
});

test("after the call: the ended banner has Open summary; the pending-rating pill strings are gone", () => {
  assert.equal(en["after.openSummary"], "Open summary");
  assert.match(he["after.openSummary"], HEB);
  for (const k of ["pend.one", "pend.other", "pend.aria", "pend.title", "live.deleteCall", "live.deleteNote"])
    assert.ok(!(k in en) && !(k in he), k + " is gone");
  assert.equal(en["tab.followup"], "Summary");
});

// ---- settings tabs ----
test("settings tabs: Basics, Keys, Help engine, Privacy, Advanced, in this order, with the engine switch only under Advanced", () => {
  assert.deepEqual(SS.TAB_IDS, ["basics", "keys", "engine", "privacy", "advanced"]);
  for (const id of SS.TAB_IDS) assert.ok(en["set.tab." + id] && he["set.tab." + id], id);
  const items = [
    { key: "stt.language" },
    { key: "run.noAi" },
    { key: "cards.quiet" },
    { key: "privacy.requireConsentAck" },
    { key: "moments.engine" },
    { key: "moments.windowSeconds", advanced: true },
    { key: "overlay.display" },
    { key: "ui.language" },
  ];
  assert.equal(SS.tabOf("moments.engine", items[4]), "advanced");
  assert.equal(SS.tabOf("moments.windowSeconds", items[5]), "advanced");
  assert.equal(SS.tabOf("run.noAi", items[1]), "engine");
  assert.equal(SS.tabOf("privacy.requireConsentAck", items[3]), "privacy");
  assert.equal(SS.tabOf("privacy.somethingNew"), "privacy");
  assert.equal(SS.tabOf("stt.language"), "basics");
  assert.equal(SS.tabOf("anything.unlisted"), "advanced");
  // no tab but Advanced lists the engine switch, even if the catalog does not mark it
  for (const id of SS.TAB_IDS.filter((x: string) => x !== "advanced")) assert.ok(!SS.tabKeys(id, items).includes("moments.engine"), id);
  assert.deepEqual(SS.tabKeys("basics", items), ["stt.language", "@mic", "overlay.display", "ui.language"]);
  // every key of the old main page is on exactly one tab
  for (const k of SS.MAIN_ORDER.filter((x: string) => !x.startsWith("@"))) assert.notEqual(SS.tabOf(k), "advanced", k + " must stay off Advanced");
  const seen = SS.TABS.flatMap((t: { keys: string[] }) => t.keys);
  assert.equal(new Set(seen).size, seen.length, "no key on two tabs");
  assert.equal(SS.tabFromFocus("tab-keys"), "keys");
  assert.equal(SS.tabFromFocus("advanced"), "advanced");
  assert.equal(SS.tabFromFocus("mic"), "basics");
  assert.equal(SS.tabFromFocus("zzz"), "basics");
});

// ---- the review step before Start ----
test("review: roster, call type and facts with their source lines come from the digest model; no context skips the step", () => {
  const digest = K.fromDigest({
    kind: "client",
    roster: [{ name: "Dana Levi", role: "client" }],
    agenda: ["Hosting move"],
    facts: [{ text: "12 WordPress sites", source: "We run 12 WordPress sites" }, "Contract renews in March"],
  });
  assert.equal(K.kindOf(digest), "client");
  assert.equal(digest.sections.roster[0].text, "Dana Levi");
  assert.equal(digest.sections.facts[0].source, "We run 12 WordPress sites");
  assert.equal(K.hasContext(digest), true);
  assert.equal(K.hasContext(null), false);
  assert.equal(K.hasContext(K.fromSaved({})), false, "an empty meeting has nothing to review");
  assert.equal(K.kindOf(K.fromDigest({ kind: "made-up-kind", roster: [{ name: "A" }] })), "", "an unknown kind shows as nothing");
  assert.equal(K.kindOf({ kind: "other" }), "other");
  const mem = K.fromMemory({ kind: "support", facts: [], decisions: [], openQuestions: [], commitments: [], mustCover: [] });
  assert.equal(K.kindOf(mem), "support");
  for (const kind of K.KINDS) assert.ok(en["kind." + kind] && he["kind." + kind], kind);
});

test("review: unticking and editing a line gives the edits for the call, and Start without review sends none", () => {
  const m = K.fixture("before", "en");
  const r = K.applyReview(m, { off: { f2: true }, text: { f1: "  13 WordPress sites ", p1: "Dana Levi" } });
  assert.equal(r.ops.length, 2);
  const byId = Object.fromEntries(r.ops.map((o: { id: string }) => [o.id, o]));
  assert.deepEqual(byId.f2, { op: "remove", id: "f2", was: "The current contract renews in March." });
  assert.deepEqual(byId.f1, { op: "edit", id: "f1", text: "13 WordPress sites", was: "12 WordPress sites on one server." });
  assert.deepEqual(K.toEdit(byId.f1), { op: "edit", id: "f1", text: "13 WordPress sites" }, "the guard text is not sent to the main process");
  assert.equal(byId.p1, undefined, "the same text is not an edit");
  assert.ok(!r.model.sections.facts.some((x: { id: string }) => x.id === "f2"), "the unticked line is out of the model");
  assert.equal(r.model.sections.facts.find((x: { id: string }) => x.id === "f1").text, "13 WordPress sites");
  assert.equal(m.sections.facts.length, 2, "the original is not changed");
  // what the call receives is valid for the main process: toEdit accepts both kinds
  for (const o of r.ops) assert.ok(K.toEdit(o), JSON.stringify(o));
  assert.deepEqual(K.applyReview(m, { off: {}, text: {} }).ops, [], "nothing changed: nothing to send");
  assert.deepEqual(K.applyReview(m, undefined).ops, []);
  assert.deepEqual(K.applyReview(m, { text: { f1: "   " } }).ops, [], "an empty edit is ignored");
});

test("review: conflicting numbers and yes/no facts show a warning (fixtures, English and Hebrew); matching facts do not", () => {
  for (const lang of ["en", "he"]) {
    const c = K.conflicts(K.fixtureConflict(lang));
    assert.equal(c.length, 1, lang);
    assert.equal(c[0].kind, "number");
    assert.deepEqual([c[0].a.id, c[0].b.id], ["f3", "f4"]);
    assert.equal(K.conflicts(K.fixture("before", lang)).length, 0, lang + " clean fixture");
    assert.equal(K.conflicts(K.fixture("live", lang)).length, 0, lang + " live fixture");
  }
  const neg = K.conflicts({
    sections: {
      facts: [
        { id: "a", text: "The backup is included in the plan" },
        { id: "b", text: "The backup is not included in the plan" },
      ],
    },
  });
  assert.deepEqual(
    neg.map((x: { kind: string }) => x.kind),
    ["negation"],
  );
  const heNeg = K.conflicts({
    sections: {
      facts: [
        { id: "a", text: "הגיבוי כלול בחבילה הרגילה" },
        { id: "b", text: "הגיבוי לא כלול בחבילה הרגילה" },
      ],
    },
  });
  assert.deepEqual(
    heNeg.map((x: { kind: string }) => x.kind),
    ["negation"],
  );
  // the same number twice, or different things, are fine
  assert.equal(
    K.conflicts({
      sections: {
        facts: [
          { id: "a", text: "Price is 400 dollars" },
          { id: "b", text: "Price is 400 dollars a month" },
        ],
      },
    }).length,
    0,
  );
  assert.equal(
    K.conflicts({
      sections: {
        facts: [
          { id: "a", text: "12 WordPress sites" },
          { id: "b", text: "Contract renews in March 2027" },
        ],
      },
    }).length,
    0,
  );
  assert.equal(K.conflicts(null).length, 0);
  // fixing it clears the warning: unticking one of the pair
  const fixed = K.applyReview(K.fixtureConflict("en"), { off: { f4: true } }).model;
  assert.equal(K.conflicts(fixed).length, 0);
  for (const k of ["review.conflict.title", "review.conflict.number", "review.conflict.negation", "review.start", "review.skip", "review.cancel", "knows.kind"])
    assert.ok(en[k] && he[k], k);
});

// ---- tray text ----
test("tray menu text: every item is in English and Hebrew with the same placeholders, and tt fills them", () => {
  const ph = (s: string) =>
    [...s.matchAll(/\{(\w+)\}/g)]
      .map((m) => m[1])
      .sort()
      .join();
  const keys = Object.keys(MT.T);
  assert.ok(keys.length >= 27);
  for (const k of keys) {
    const [e, h] = MT.T[k];
    assert.ok(e && h, k);
    assert.doesNotMatch(e, HEB, "en " + k);
    assert.match(h, HEB, "he " + k);
    assert.equal(ph(e), ph(h), k + " placeholders");
  }
  assert.equal(MT.tt("en", "quick"), "Start quick call");
  assert.equal(MT.tt("he", "quick"), "התחל שיחה מהירה");
  assert.equal(MT.tt("en", "confirmClient", { name: "Dana" }), "Confirm client: Dana");
  assert.equal(MT.tt("he", "askLeft", { left: "0:08" }), "נשארו 0:08");
  assert.equal(MT.tt("en", "askLeft"), " left", "a missing placeholder becomes empty text, never 'undefined'");
  assert.equal(MT.tt("en", "no-such-key"), "no-such-key");
});

test("tray menu text: the menu in tray/main.cjs only uses keys that exist, and every key is used", () => {
  const src = readFileSync(join(DASH, "..", "tray", "main.cjs"), "utf8");
  const used = new Set([...src.matchAll(/\b(?:t|tt)\((?:uiLanguage\(\), )?"(\w+)"/g)].map((m) => m[1]));
  for (const k of used) assert.ok(k in MT.T, "used but missing: " + k);
  const unused = Object.keys(MT.T).filter((k) => !used.has(k));
  assert.deepEqual(unused, [], "texts nobody shows");
});

test("note window text: the same keys in English and Hebrew, and every data-t in prompt.html exists", () => {
  for (const k of Object.keys(PT.T)) {
    const [e, h] = PT.T[k];
    assert.ok(e && h, k);
    assert.doesNotMatch(e, HEB, k);
    assert.match(h, HEB, k);
  }
  const html = readFileSync(join(DASH, "..", "tray", "prompt.html"), "utf8");
  for (const m of html.matchAll(/data-t="([\w.]+)"/g)) assert.ok(m[1] in PT.T, m[1]);
  assert.equal(PT.pt("he", "cancel"), "ביטול");
  assert.equal(PT.pt("en", "cancel"), "Cancel");
  assert.equal(PT.pt("fr", "cancel"), "Cancel", "an unknown language is English");
});

// ---- snapshot rules (the pure part of snapshot.sh --check) ----
test("snapshot rules: a window result with the old problems fails, a clean one passes", () => {
  const ok = (extra = {}) => ({ problems: [], dir: "ltr", lang: "en", primaries: 1, dupWait: 0, envNames: 0, pendingPill: false, ...extra });
  assert.deepEqual(SC.rules("idle-en-light", ok()), []);
  assert.match(SC.rules("idle-en-light", ok({ envNames: 2 })).join(), /env/i);
  assert.match(SC.rules("idle-en-light", ok({ pendingPill: true })).join(), /rate/i);
  assert.match(SC.rules("live-en-dark", ok({ liveDelete: true, pills: 1 })).join(), /Delete/);
  assert.match(SC.rules("error-en-light", ok({ startDisabled: false, startWhy: false })).join(), /Start/);
  assert.deepEqual(SC.rules("error-en-light", ok({ startDisabled: true, startWhy: true, fixIt: true, primaries: 1 })), []);
  assert.match(SC.rules("settings-en-light", ok({ settingsTabs: 3 })).join(), /tabs/);
  assert.match(SC.rules("settings-en-light", ok({ settingsTabs: 5, classicNew: true })).join(), /Classic/);
  assert.match(SC.rules("idle-en-light", ok({ lowContrast: ["x"] })).join(), /contrast/i);
});

// ---- window snapshots (Electron, hidden window): opt-in, because they start the Electron runtime ----
const SNAP = process.env.WINGMAN_DASH_SNAP === "1" && process.platform === "darwin" && existsSync(join(DASH, "..", "node_modules", ".bin", "electron"));
test("window snapshots: the whole gate matrix passes the clip, contrast and r3 checks (EN, HE, light, dark)", { skip: !SNAP, timeout: 900_000 }, () => {
  const out = mkdtempSync(join(tmpdir(), "wingman-r3-snaps-"));
  execFileSync(join(DASH, "snapshot.sh"), ["--check", out], { timeout: 850_000, stdio: "pipe" });
  const prompt = join(DASH, "..", "tray", "prompt-snapshot.cjs");
  for (const kind of ["note", "brief"])
    execFileSync(join(DASH, "..", "node_modules", ".bin", "electron"), [prompt, out, kind], { timeout: 120_000, stdio: "ignore" });
  for (const lang of ["en", "he"])
    for (const theme of ["light", "dark"]) {
      const r = JSON.parse(readFileSync(join(out, `prompt-note-${lang}-${theme}.json`), "utf8"));
      assert.equal(r.overflow, false);
      assert.deepEqual(r.clipped, []);
      assert.ok(r.minContrast >= 4.5, `prompt ${lang} ${theme} contrast ${r.minContrast}`);
      assert.equal(r.dir, lang === "he" ? "rtl" : "ltr");
    }
});

test("review: digest ids match the memory ids when names or past lines repeat (seed.ts keeps one per name / text)", () => {
  const d = {
    roster: [{ name: "Dana" }, { name: "dana" }, { name: "Eli" }],
    facts: ["A", "B"],
    past: [{ text: "Old" }, { text: "old" }, { text: "Other" }],
  };
  const m = K.fromDigest(d);
  assert.deepEqual(
    m.sections.roster.map((x: { id: string }) => x.id),
    ["p1", "p2"],
  );
  assert.deepEqual(
    m.sections.past.map((x: { id: string; text: string }) => x.id + x.text),
    ["f3Old", "f4Other"],
  );
});

test("review: conflicts and applyReview survive empty or odd models", () => {
  assert.deepEqual(K.conflicts(null), []);
  assert.deepEqual(K.conflicts({}), []);
  assert.deepEqual(K.applyReview(null, { off: { a: true } }).ops, []);
  assert.equal(K.hasContext(null), false);
  assert.equal(K.kindOf({ kind: "nonsense" }), "");
});
