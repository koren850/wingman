// Home helpers (dashboard/homelib.js): stop steps from the real phase, the AI mode line, the Start gate, practice label, the Ask/Note input, doctor wording.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const H = req("../dashboard/homelib.js");
const lib = req("../tray/lib.cjs");

const states = (call: any) => H.stopSteps(call).map((s: any) => `${s.key}:${s.state}`).join(" ");

test("stop steps follow state.stopPhase (saving -> summary -> done)", () => {
  assert.equal(states({ stopPhase: "saving" }), "listening:done saving:now summary:todo");
  assert.equal(states({ stopPhase: "summary" }), "listening:done saving:done summary:now");
  assert.equal(states({ stopPhase: "done" }), "listening:done saving:done summary:done");
});

test("stop steps fall back to the old inference when no phase has arrived", () => {
  assert.equal(states({ stopPhase: "" }), "listening:done saving:now summary:now");
  assert.equal(states({}), "listening:done saving:now summary:now");
  assert.equal(states({ summaryOk: true }), "listening:done saving:now summary:done");
  assert.equal(states({ endedCleanly: true }), "listening:done saving:done summary:done");
  assert.equal(states(null), "listening:done saving:now summary:now");
});

test("the controller reducer feeds the stop steps: stopphase events, reset on a new call", () => {
  let s = lib.reduce(lib.initialState(), { ev: "starting" });
  s = lib.reduce(s, { ev: "consented" }); s = lib.reduce(s, { ev: "stopping" });
  assert.equal(states(s), "listening:done saving:now summary:now");
  s = lib.reduce(s, { ev: "stopphase", phase: "summary" });
  assert.equal(states(s), "listening:done saving:done summary:now");
  s = lib.reduce(s, { ev: "stopphase", phase: "bogus" });
  assert.equal(s.stopPhase, "summary");
  s = lib.reduce(lib.reduce(s, { ev: "exit", code: 0 }), { ev: "starting" });
  assert.equal(s.stopPhase, "");
});

const row = (key: string, value: any) => ({ key, value });
test("AI mode line reads the effective settings", () => {
  const base = [row("run.noAi", true), row("assist.answerMe", "hotkey"), row("reflex.allowAns", true), row("cards.quiet", false)];
  assert.deepEqual(H.aiMode(base), { on: true, text: "AI on · answers your questions: hotkey only" });
  assert.equal(H.aiMode([...base.slice(0, 1), row("assist.answerMe", "always"), row("reflex.allowAns", false), row("cards.quiet", true)]).text, "AI on · answers your questions: always · other side: Prepared cards only · starts in quiet mode");
  assert.equal(H.aiMode([row("run.noAi", true), row("assist.answerMe", "off")]).text, "AI on · your own questions: only with the hotkey");
  const off = H.aiMode([row("run.noAi", false), row("assist.answerMe", "always")]);
  assert.equal(off.on, false); assert.match(off.text, /^AI off in Settings/);
  assert.equal(H.aiMode([]), null); assert.equal(H.aiMode(null), null);
  assert.equal(H.aiMode([row("assist.answerMe", "always")]), null);
});

test("AI mode matches the real catalog rows (inverted run.noAi)", () => {
  const cat = req("../tray/settings-catalog.cjs");
  const values: any = { "run.noAi": false, "assist.answerMe": "hotkey", "reflex.allowAns": true, "cards.quiet": false };
  const defaults: any = {}; for (const i of cat.ITEMS) defaults[i.key] = i.kind === "bool" && i.invert ? true : 0;
  for (const i of cat.ITEMS) if (!(i.key in values)) values[i.key] = defaults[i.key];
  const rows = cat.describe({ values, defaults: values, changed: [] });
  assert.equal(H.aiMode(rows).on, true);          // stored noAi=false means the AI is used
  values["run.noAi"] = true;
  assert.equal(H.aiMode(cat.describe({ values, defaults: values, changed: [] })).on, false);
});

test("Start is only blocked by a NOT READY result", () => {
  assert.equal(H.blockedBy(null), null);
  assert.equal(H.blockedBy({ ok: true, verdict: "READY" }), null);
  assert.equal(H.blockedBy({ ok: false, verdict: "BUSY" }), null);
  const d = { ok: false, verdict: "NOT READY", failing: [] };
  assert.equal(H.blockedBy(d), d);
});

test("practice says it uses the plan only when one is ready", () => {
  assert.equal(H.planReady(null, { briefReady: false }), false);
  assert.equal(H.planReady({ who: "x" }, null), true);
  assert.equal(H.planReady(null, { briefReady: true }), true);
  assert.equal(H.practiceLabel(false), "Practice call (offline, free)");
  assert.equal(H.practiceLabel(true), "Practice call · uses your plan");
});

test("Ask/Note input: two clear modes, unknown mode means note, the armed state is spelled out", () => {
  assert.equal(H.composer("ask").button, "Ask"); assert.equal(H.composer("note").button, "Add note");
  assert.equal(H.composer("whatever").label, "Note for the AI"); assert.equal(H.composer(undefined).label, "Note for the AI");
  assert.notEqual(H.composer("ask").placeholder, H.composer("note").placeholder);
  assert.equal(H.askStatus({ askArmed: true }), "Listening for your question. Say it now.");
  assert.equal(H.askStatus({ askArmed: false }), ""); assert.equal(H.askStatus(null), "");
});

test("doctor text speaks to the app user: Keychain, Wingman, readiness check", () => {
  assert.equal(H.niceFix("add it to ~/.config/wingman/keys.env"), "add it in Settings → Keys");
  assert.equal(H.niceFix("grant Microphone to your terminal app, restart it"), "grant Microphone to Wingman, restart it");
  assert.equal(H.niceFix("run doctor again"), "run readiness check again");
  assert.equal(H.keyRelated({ text: "DEEPGRAM_API_KEY missing", fix: "" }), true);
  assert.equal(H.keyRelated({ text: "mic silent", fix: "grant Microphone" }), false);
});

test("focus key: id first, then data-fk", () => {
  assert.equal(H.focusKey({ id: "a", getAttribute: () => "b" }), "a");
  assert.equal(H.focusKey({ id: "", getAttribute: () => "b" }), "b");
  assert.equal(H.focusKey(null), "");
});

// ---- static guards for the Home work ----
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./env.ts";
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

test("the unused skins are gone: no skins.css, no ?skin= param, no SK() branches, no data-skin selector", () => {
  assert.equal(existsSync(join(ROOT, "dashboard/skins.css")), false);
  assert.doesNotMatch(read("dashboard/index.html"), /skins\.css/);
  for (const f of readdirSync(join(ROOT, "dashboard")).filter((x) => /\.(js|cjs|css|html)$/.test(x))) {
    const t = read("dashboard/" + f);
    assert.doesNotMatch(t, /data-skin|\bSK\(\)|WINGMAN_DASHBOARD_SKIN|DEFAULT_SKIN|searchParams|get\("skin"\)/, f + " still mentions skins");
  }
  assert.match(read("dashboard/app.css"), /\.tip:focus-visible::after/);   // base rules the default look needs moved here
  assert.match(read("dashboard/app.css"), /\.sheet-ov \{/);
});

test("the live Ask/Note input goes through validated, fixed commands only", () => {
  const w = read("dashboard/window.cjs"), p = read("dashboard/preload.cjs");
  assert.match(w, /case "ask": if \(typeof arg !== "string" \|\| !arg\.trim\(\) \|\| arg\.length > 2000\) throw new Error\("bad argument"\); return \{ ok: controller\.ask\(arg\) \}/);
  assert.match(w, /case "askWingman": return \{ ok: controller\.askWingman\(\) \}/);
  assert.match(p, /ask: \(text\) => ipcRenderer\.invoke\("call:cmd", "ask", String\(text\)\)/);
  assert.match(p, /askWingman: \(\) => ipcRenderer\.invoke\("call:cmd", "askWingman"\)/);
});

test("the snapshot doctor fixtures never mention keys.env or a terminal (the app stores keys in the Keychain)", () => {
  const w = read("dashboard/window.cjs");
  const fx = w.slice(w.indexOf("const FAKE_DOCTOR"), w.indexOf("/** The sender must be"));
  assert.ok(fx.length > 100);
  assert.doesNotMatch(fx, /keys\.env|terminal/i);
});

test("visible dashboard text follows the glossary (no consent, briefing, bank, stall, doctor wording)", () => {
  for (const f of ["dashboard/home.js", "dashboard/live.js", "dashboard/app.js", "dashboard/settings.js", "dashboard/boot.js", "tray/settings-catalog.cjs"]) {
    const t = read(f);
    assert.doesNotMatch(t, /Waiting for consent|Consent given|consent line|Check everything|Stop and delete|"Bank"|"Stall"|Briefing\b|"Calc"|(?<!run)Doctor\b/, f);
  }
});

test("the practice button and the Start card are wired to the plan and the settings read", () => {
  const t = read("dashboard/home.js");
  assert.match(t, /HL\.practiceLabel\(usePlan\)/);
  assert.match(t, /api\.getSettings\(\)\.then\(\(r\) => \{ H\.ai = r && r\.ok \? HL\.aiMode\(r\.items\)/);
  assert.match(t, /HL\.stopSteps\(s\)/);
});

test("one badge legend: both windows get the card hues from shared/tokens.css, none of their own", () => {
  const tok = read("shared/tokens.css"), css = read("dashboard/app.css"), ov = read("overlay/index.html"), dh = read("dashboard/index.html");
  // one definition: dark and light hues for every card type live in the shared file
  for (const k of ["prep", "ai", "stall", "tip", "me", "fact"]) assert.match(tok, new RegExp(`--t-${k}:#[0-9a-f]{6}`, "i"), `--t-${k} missing in tokens.css`);
  for (const [n, f] of [["dashboard", css], ["answer window", ov]] as const) assert.ok(!/--t-(prep|ai|stall|tip|me|fact):\s*#/i.test(f), `${n} redefines a card hue`);
  // both pages load it, and the answer window's CSP lets the stylesheet in and stays dark
  assert.match(dh, /<link rel="stylesheet" href="\.\.\/shared\/tokens\.css">/);
  assert.match(ov, /<link rel="stylesheet" href="\.\.\/shared\/tokens\.css">/);
  assert.match(ov, /style-src [^;]*file:/); assert.match(ov, /<html[^>]*data-theme="dark"/);
  // the answer window's own hex values are neutrals, tints and its two brighter alert tones only
  const root = /:root \{([^}]*)\}/.exec(ov)![1];
  const names = [...root.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]);
  for (const n of names) assert.ok(["--bg", "--card", "--card2", "--raised", "--line", "--text", "--soft", "--muted", "--t-prep-bg", "--t-me-bg", "--t-ai-bg", "--t-stall-bg", "--red-bg", "--fault", "--advisory", "--say-pt"].includes(n), `answer window defines ${n}: put shared colours in tokens.css`);
});

test("recent plans: newest first, no duplicates, capped, junk dropped", () => {
  const D = req("../dashboard/lib.cjs");
  const p = (who: string, goal = "", notes = "", mustCover = "") => ({ who, goal, notes, mustCover });
  let l: any[] = [];
  for (const w of ["a", "b", "c", "d", "e", "f"]) l = D.recentAdd(l, p(w, "g"));
  assert.deepEqual(l.map((x) => x.who), ["f", "e", "d", "c", "b"]); assert.equal(l.length, D.RECENT_MAX);
  l = D.recentAdd(l, p("D", "G", "new notes"));                         // same who and goal (any case): moved to the front, not doubled
  assert.deepEqual(l.map((x) => x.who), ["D", "f", "e", "c", "b"]); assert.equal(l[0].notes, "new notes");
  assert.deepEqual(D.recentAdd(l, p("", "", "", "")), l);              // an empty plan is not remembered
  assert.equal(D.cleanPlan({ who: 1, goal: "", notes: "", mustCover: "" }), null);
  assert.equal(D.cleanPlan({ who: "x".repeat(1501), goal: "", notes: "", mustCover: "" }), null);
  assert.equal(D.cleanPlan([]), null); assert.equal(D.cleanPlan(null), null);
  assert.deepEqual(D.recentClean([p("ok"), { who: 5 }, "junk", null]), [p("ok")]);
  assert.deepEqual(D.recentClean("nope"), []);
  assert.equal(D.cleanPlan(p("a\u0000b")).who, "ab");
});

test("recent plans are read and written only by the main process, in the private plan folder, owner-only", () => {
  const w = read("dashboard/window.cjs");
  assert.match(w, /handle\("brief:recent"/); assert.match(w, /handle\("brief:forgetRecent"/);
  assert.match(w, /const RECENT = path\.join\(BRIEFS, "recent\.json"\)/);
  assert.match(w, /writeFileSync\(RECENT, JSON\.stringify\(list\), \{ mode: 0o600 \}\)/);
});
