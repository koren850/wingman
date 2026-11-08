// Main window in Hebrew (round 12, d1): string catalogs (parity), the error table, "What Wingman knows" data, setup path length.
// Pure logic, no browser. The window screenshots, the clipping check and the keyboard path run in Electron: see the opt-in test at the end.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, mkdtempSync, existsSync } from "node:fs";
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
const DASH = join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard");
const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const HEB = /[֐-׿]/;

test("catalogs: every key exists in English and Hebrew, with the same placeholders, and no empty text", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(he).sort());
  for (const k of Object.keys(en)) {
    assert.ok(en[k].length && he[k].length, k + " is empty");
    if (!k.endsWith(".one")) assert.deepEqual(ph(en[k]), ph(he[k]), k + " placeholders"); // Hebrew "one" forms say the number in words
  }
});

test("catalogs: English has no Hebrew, Hebrew has Hebrew (except names that stay as they are)", () => {
  const same = new Set(["lang.en", "lang.he"]);
  for (const k of Object.keys(en)) {
    if (k !== "lang.he") assert.doesNotMatch(en[k], HEB, k + " English text has Hebrew");
    if (!same.has(k)) assert.match(he[k], HEB, k + " Hebrew text has no Hebrew");
  }
});

test("catalogs: every literal T('key') the window code uses exists, and the key families built in code are complete", () => {
  const used = new Set<string>();
  for (const f of readdirSync(DASH).filter((n) => n.endsWith(".js") && !n.startsWith("strings.")))
    for (const m of readFileSync(join(DASH, f), "utf8").matchAll(/\bT\(\s*"([A-Za-z0-9_.-]+)"/g))
      if (/^[a-z]+\.[A-Za-z0-9_.-]*[A-Za-z0-9]$/.test(m[1])) used.add(m[1]); // a key ends with a letter (names like "kind." are built in code)
  assert.ok(used.size > 150, "found " + used.size);
  const missing = [...used].filter((k) => !(k in en));
  assert.deepEqual(missing, [], "keys used in the window but not in the catalog");
  const fam: string[] = [];
  for (const c of ["client", "support", "vendor", "team", "consult", "personal", "interview", "other"]) fam.push("kind." + c);
  for (const p of ["waiting", "live", "stopping", "starting"]) fam.push("live.phase." + p);
  for (const b of ["bank", "ai", "stall", "tip", "me", "careful", "fix", "calc"]) fam.push(`badge.${b}.label`, `badge.${b}.meaning`);
  for (const s of ["roster", "agenda", "facts", "mustCover", "soFar", "decisions", "open", "promises"]) fam.push("knows.sec." + s);
  for (const s of ["fixture", "saved", "digest", "memory"]) fam.push("knows.source." + s);
  for (const c of I.CHOICES) fam.push("lang." + c);
  for (const b of ["home.mustChip", "home.fileChip", "home.usedChip", "live.notes"]) fam.push(b + ".one", b + ".other");
  for (const m of ["note", "ask"]) for (const f of ["label", "button", "placeholder", "sent"]) fam.push(`compose.${m}.${f}`);
  assert.deepEqual(
    fam.filter((k) => !(k in en)),
    [],
  );
});

test("i18n: language choice, direction, placeholders, plurals, fallback to English then to the key", () => {
  assert.equal(I.resolve("auto", "he-IL"), "he");
  assert.equal(I.resolve("auto", "iw"), "he");
  assert.equal(I.resolve("auto", "en-US"), "en");
  assert.equal(I.resolve("auto", undefined), "en");
  assert.equal(I.resolve("he", "en-US"), "he");
  assert.equal(I.resolve("en", "he-IL"), "en");
  assert.equal(I.dirOf("he"), "rtl");
  assert.equal(I.dirOf("en"), "ltr");
  assert.equal(I.t("he", "when.today", { time: "14:30" }), "היום 14:30");
  assert.equal(I.t("en", "when.today", { time: "14:30" }), "Today 14:30");
  assert.equal(I.t("en", "when.today"), "Today {time}", "a missing value stays as written");
  assert.equal(I.t("en", "no.such.key"), "no.such.key");
  assert.equal(I.plural("en", "home.fileChip", 1), "1 file");
  assert.equal(I.plural("en", "home.fileChip", 3), "3 files");
  assert.equal(I.plural("he", "home.fileChip", 3), "3 קבצים");
});

test("plain words: the window no longer says Plan / Prepared meeting; one word Follow-up", () => {
  const bad = /\b(prepared meetings?|plan a call|\bplan\b)/i;
  for (const [k, v] of Object.entries(en)) {
    if (k.startsWith("kb.") || k.startsWith("err.")) continue;
    assert.doesNotMatch(v, /prepared meeting/i, k);
    if (k.startsWith("ctx.") || k.startsWith("home.") || k.startsWith("after.") || k.startsWith("knows."))
      assert.doesNotMatch(v, /\bplan\b/i, k + " says Plan");
  }
  void bad;
  assert.match(en["after.openFollow"], /^Open follow-up$/);
  assert.match(en["after.followReady"], /^Follow-up ready/);
  assert.doesNotMatch(en["after.openFollow"], /email/i);
  assert.match(he["after.followReady"], /מעקב/);
});

test("english text of the home helpers is unchanged (they now read the catalog)", () => {
  assert.equal(HL.stopSteps({ stopPhase: "summary" })[2].label, "Writing the summary");
  assert.equal(HL.practiceLabel(null), "Practice call (offline, free)");
  assert.equal(HL.composer("ask").button, "Ask");
  const t = (k: string, v?: object) => I.t("he", k, v);
  assert.equal(HL.stopSteps({ stopPhase: "summary" }, t)[2].label, "כותב את הסיכום");
  assert.equal(HL.composer("note", t).label, "הערה ל-AI");
  assert.match(HL.askStatus({ askArmed: true, askUntil: 7000 }, 0, t), /^מקשיב לשאלה שלך/);
  const NOW = new Date(2026, 10, 3, 9, 0).getTime();
  assert.equal(HL.formatWhen(new Date(2026, 10, 3, 14, 30).getTime(), NOW, t, "he"), "היום 14:30");
  assert.equal(HL.formatWhen(new Date(2026, 10, 4, 9, 0).getTime(), NOW, t, "he"), "מחר 09:00");
  assert.match(HL.formatWhen(new Date(2026, 10, 9, 9, 0).getTime(), NOW, t, "he"), /09:00$/);
});

// ---- the error table ----
test("errors: every entry says what happened, the next step, and has a button with a known action, in both languages", () => {
  const codes = new Set<string>();
  for (const e of E.TABLE) {
    assert.ok(!codes.has(e.code), "duplicate code " + e.code);
    codes.add(e.code);
    assert.ok(E.ACTIONS.includes(e.action), `${e.code}: unknown action ${e.action}`);
    const k = E.keysOf(e.code);
    for (const [name, cat] of [
      ["en", en],
      ["he", he],
    ] as const)
      for (const part of ["what", "next", "btn"] as const) {
        const text = cat[k[part]];
        assert.ok(text && text.trim().length > 1, `${e.code}.${part} (${name}) is missing`);
      }
    assert.ok(en[k.btn].length <= 28 && he[k.btn].length <= 28, `${e.code}: the button text must be short`);
    assert.match(en[k.next], /[.]$/, `${e.code}: the next step is a sentence`);
  }
  assert.equal(E.TABLE[E.TABLE.length - 1].code, "generic", "generic comes last");
  assert.equal(E.TABLE.filter((e: { match: unknown }) => !e.match).length, 1, "only generic has no pattern");
  const orphan = Object.keys(en).filter((k) => k.startsWith("err.") && k !== "err.dismiss" && !codes.has(k.split(".")[1]));
  assert.deepEqual(orphan, [], "catalog texts with no table entry");
});

test("errors: raw messages from the engine and from file import reach the right entry", () => {
  const code = (s: string) => E.classify(s).code;
  assert.equal(code("Deepgram key missing"), "key-deepgram");
  assert.equal(code("Anthropic API key is invalid (401)"), "key-anthropic");
  assert.equal(code("Microphone permission denied"), "mic-denied");
  assert.equal(code("System Audio Recording is not allowed"), "audio-denied");
  assert.equal(code("Hearing only you. For answers to the other side, join the call or play its audio."), "mic-silent");
  assert.equal(code("Speech service is not answering"), "stt-down");
  assert.equal(code("fetch failed ENOTFOUND api.example.test"), "offline");
  assert.equal(code("No answer window: only one screen is connected"), "one-screen");
  assert.equal(
    code("A .docx file cannot be read here. Wingman reads .txt, .md, .pdf and .ics files. Paste the text instead, or save the file as one of those."),
    "file-type",
  );
  assert.equal(code("PDF needs the pdftotext tool, which is not installed on this Mac. Paste the text instead, or use a .txt or .md file."), "pdf-missing");
  assert.equal(code("Files can be 2 MB at most."), "file-big");
  assert.equal(code("That file has no readable text."), "file-empty");
  assert.equal(code("The background limit is reached. Remove a file first."), "file-limit");
  assert.equal(code("Fill in at least one field."), "plan-empty");
  assert.equal(code("At most 50 plans. Delete one you do not need first."), "plan-limit");
  assert.equal(code("Start did not work right now."), "call-start");
  assert.equal(code("This is a preview, nothing was changed."), "preview");
  assert.equal(code("something nobody has seen before"), "generic");
  assert.equal(code("plan-save"), "plan-save", "a code works as well as a message");
  const d = E.describe((k: string, v?: object) => I.t("he", k, v), "Deepgram key missing");
  assert.deepEqual([d.code, d.action], ["key-deepgram", "keys"]);
  assert.match(d.btn, HEB);
});

test("errors: the backend messages the window can show are all covered by the table (no message ends as generic by accident)", () => {
  const msgs = [
    ...[...readFileSync(join(DASH, "..", "tray", "attachments.cjs"), "utf8").matchAll(/error: "([^"]{12,})"/g)].map((m) => m[1]),
    ...[...readFileSync(join(DASH, "..", "tray", "plans.cjs"), "utf8").matchAll(/error: [`"]([^`"]{12,})[`"]/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, "50")),
  ].filter((m) => !/^(Bad |No such|That id|Could not make an id|That meeting|A meeting cannot)/.test(m));
  assert.ok(msgs.length > 8);
  const generic = msgs.filter((m) => E.classify(m).code === "generic");
  assert.deepEqual(generic, [], "these messages would get the generic text");
});

// ---- What Wingman knows ----
test("knows: fixtures have every section in both languages; edit, remove and add are validated and never change the old model", () => {
  for (const mode of ["before", "live"] as const)
    for (const lang of ["en", "he"]) {
      const m = K.fixture(mode, lang);
      assert.equal(m.mode, mode);
      assert.ok(K.count(m) >= 6);
      for (const sec of K.SECTIONS[mode]) assert.ok(Array.isArray(m.sections[sec]), `${mode}.${sec}`);
      if (lang === "he") assert.match(JSON.stringify(m), HEB);
    }
  const m = K.fixture("live", "en");
  const before = JSON.stringify(m);
  const r = K.editItem(m, "open", "q1", "  Is the backup‮ included?  ");
  assert.ok(r.ok);
  assert.equal(r.model.sections.open[0].text, "Is the backup included?", "bidi controls out, trimmed");
  assert.equal(K.editItem(m, "open", "q1", "   ").ok, false);
  assert.equal(K.editItem(m, "nope", "q1", "x").ok, false);
  assert.equal(K.editItem(m, "open", "zzz", "x").ok, false);
  const rm = K.removeItem(m, "promises", "c1");
  assert.equal(rm.sections.promises.length, m.sections.promises.length - 1);
  assert.equal(K.removeItem(m, "promises", "nope"), m);
  const ad = K.addItem(m, "open", "Who signs?");
  assert.ok(ad.ok && ad.model.sections.open.at(-1).src === "user");
  assert.equal(K.addItem(m, "open", "").ok, false);
  assert.equal(K.addItem(m, "bogus", "x").ok, false);
  assert.equal(K.clean("x".repeat(500)).length, K.MAX_TEXT);
  assert.equal(JSON.stringify(m), before, "the original model is never changed");
});

test("knows: from saved details only people and must-cover are filled; nothing is invented", () => {
  const m = K.fromSaved({ who: "Dana Levi, Noam Bar", goal: "Agree a date", mustCover: "Price\nDowntime window" });
  assert.equal(m.source, "saved");
  assert.deepEqual(
    m.sections.roster.map((x: { text: string }) => x.text),
    ["Dana Levi", "Noam Bar"],
  );
  assert.deepEqual(
    m.sections.mustCover.map((x: { text: string }) => x.text),
    ["Price", "Downtime window"],
  );
  assert.deepEqual([m.sections.agenda.length, m.sections.facts.length], [0, 0]);
  assert.equal(K.count(K.fromSaved({})), 0);
});

test("knows: the text shown as 'what the AI reads' is deterministic, ordered, and follows edits", () => {
  const m = K.fixture("before", "en");
  const t = K.toModelText(m);
  assert.equal(t, K.toModelText(JSON.parse(JSON.stringify(m))), "same input, same text");
  const order = ["People:", "Agenda:", "Facts:", "Must cover:"].map((h) => t.indexOf(h));
  assert.ok(
    order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])),
    "fixed section order",
  );
  assert.match(t, /- Dana Levi \(client, studio owner\)/);
  assert.match(t, /\[ \] Price/);
  const t2 = K.toModelText(K.removeItem(m, "facts", "f1"));
  assert.doesNotMatch(t2, /12 WordPress sites/);
  assert.match(K.toModelText(K.fixture("live", "en")), /Promises:\n- me: I will send an updated offer/);
  assert.equal(K.toModelText(null), "");
});

// ---- first real card path ----
test("setup: the path to the first real card is at most five steps on screen (keys, permissions with the restart hint, practice)", () => {
  assert.ok(SL.REQUIRED.length <= 5);
  assert.deepEqual([...SL.FIRST_CARD_PATH].sort(), ["allow", "connect", "try"]);
  for (const id of SL.FIRST_CARD_PATH) assert.ok(SL.REQUIRED.includes(id), id);
  assert.match(en["su.restartHint"], /quit Wingman/i, "the restart hint is on the permission step");
  assert.equal(SL.progressText(1, 3), "1 of 3");
  assert.equal(SL.progressText(1, 3, he["su.progress"]), "1 מתוך 3");
});

test("html shell: the catalogs, errors and knows scripts load before the code that uses them; no inline script", () => {
  const html = readFileSync(join(DASH, "index.html"), "utf8");
  const at = (f: string) => html.indexOf(`src="${f}"`);
  for (const [a, b] of [
    ["i18n.js", "strings.en.js"],
    ["strings.he.js", "errors.js"],
    ["errors.js", "app.js"],
    ["knowslib.js", "app.js"],
    ["app.js", "errui.js"],
    ["home.js", "knows.js"],
    ["home.js", "context.js"],
    ["context.js", "boot.js"],
  ])
    assert.ok(at(a) > 0 && at(b) > at(a), `${a} before ${b}`);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, "no inline script (the page policy allows only files)");
  assert.match(html, /id="err-slot"/);
});

// ---- window snapshots (Electron, hidden window): opt-in, because they start the Electron runtime ----
const SNAP = process.env.WINGMAN_DASH_SNAP === "1" && process.platform === "darwin" && existsSync(join(DASH, "..", "node_modules", ".bin", "electron"));
test(
  "window snapshots: English, Hebrew/RTL, light and dark have no clipping; the Meeting context box has a good keyboard path",
  { skip: !SNAP, timeout: 600_000 },
  () => {
    const out = mkdtempSync(join(tmpdir(), "wingman-dash-snaps-"));
    const run = (specs: string[], env: Record<string, string> = {}) =>
      execFileSync(join(DASH, "snapshot.sh"), [out, ...specs], { env: { ...process.env, WINGMAN_DASHBOARD_SIZE: "1100x1500", ...env }, timeout: 300_000 });
    const specs = [
      "home-en-dark:en:dark:home:-:-",
      "home-en-light:en:light:home:-:-",
      "home-he-dark:he:dark:home:-:-",
      "home-he-light:he:light:home:-:-",
      "edit-en-light:en:light:home:-:edit",
      "edit-he-dark:he:dark:home:-:edit",
      "live-en-dark:en:dark:home:live:-",
      "live-he-light:he:light:home:live:-",
    ];
    run(specs);
    for (const s of specs) {
      const r = JSON.parse(readFileSync(join(out, s.split(":")[0] + ".png.json"), "utf8"));
      assert.deepEqual(r.problems, [], s);
      assert.equal(r.dir, s.split(":")[1] === "he" ? "rtl" : "ltr");
    }
    const focus = ["edit-en-dark:en:dark:home:-:edit", "edit-he-dark:he:dark:home:-:edit"];
    run(focus, { WINGMAN_SNAP_EVAL: join(DASH, "focuscheck.js") });
    for (const s of focus) {
      const r = JSON.parse(readFileSync(join(out, s.split(":")[0] + ".png.json"), "utf8"));
      assert.deepEqual(r.problems, [], s);
      assert.equal(r.closedByEscape, true);
    }
  },
);
