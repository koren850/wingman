"use strict";
// Fixture data for the hidden window snapshots (dashboard/snapshot.sh): invented meetings in a scratch data folder, so no real data is ever shown.
// Usage: node snapshot-fixtures.cjs <dataDir>. Writes <dataDir>/briefs/plans/... through the real plan store, and creates an empty calls folder.
const fs = require("node:fs");
const path = require("node:path");
const { createPlanStore } = require("../tray/plans.cjs");
const K = require("./knowslib.js");

/** The golden-run set (src/testkit/fixtures/live-golden.json): memory, cards and lines of a invented support call, English and Hebrew. Null when the file is missing. */
function golden(lang) {
  try {
    return require("../src/testkit/fixtures/live-golden.json")[lang === "he" ? "dev-support-he" : "dev-support-en"];
  } catch {
    return null;
  }
}
/** The golden memory plus one invented "Last time" fact (src past), so the panel shows that section and its source line. */
function withPast(mem, lang) {
  const he = lang === "he";
  const m = JSON.parse(JSON.stringify(mem));
  m.facts = [
    ...(m.facts || []),
    {
      id: "f90",
      text: he ? "בפעם הקודמת, הבטחה פתוחה שלך: לשלוח את הגיבוי לפני העדכון." : "Last time, you promised: send the backup before the update.",
      at: Date.now() - 9 * 86400_000,
      src: "past",
    },
  ];
  return m;
}
/** The live "What Wingman knows" model and AI state for a snapshot: kind "golden" | "golden-paused" | "golden-offline" | "empty". */
function knowsFixture(kind, lang) {
  const g = golden(lang);
  if (!g || kind === "empty") return { model: null, ai: "ok" };
  return { model: K.fromMemory(withPast(g.mem, lang)), ai: kind === "golden-paused" ? "paused" : kind === "golden-offline" ? "offline" : "ok" };
}
/** A finished call folder from the golden run: transcript, v2 cards, the call memory (session.json), and optionally a summary. Returns the call id. */
function writeCall(dataDir, lang, o = {}) {
  const g = golden(lang);
  if (!g) return "";
  const id = ("01SNAPGOLDEN" + lang.toUpperCase() + (o.summary ? "B" : "A") + "0".repeat(26)).slice(0, 26);
  const d = path.join(dataDir, "calls", id);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const t0 = Date.now() - 3600_000 - (o.summary ? 26 * 3600_000 : 0); // the call with a summary is a day older, so the list has no twin rows
  const w = (f, rows) => fs.writeFileSync(path.join(d, f), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  fs.writeFileSync(
    path.join(d, "call.json"),
    JSON.stringify({ mode: "live", startedAt: new Date(t0).toISOString(), endedAt: new Date(t0 + 480_000).toISOString(), profile: "" }),
    { mode: 0o600 },
  );
  w(
    "transcript.jsonl",
    g.lines.map((l) => ({ t: t0 + l.t, ch: l.ch, text: l.text, ...(l.name ? { name: l.name } : {}) })),
  );
  w(
    "cards.jsonl",
    g.cards.map((c) => ({ ...c, at: t0 + c.at })),
  );
  // moment.* rows (invented) for the Review part of the Details tab
  w("events.jsonl", [
    { type: "start", t: t0 },
    { type: "moment.skip", t: t0 + 20_000, turnId: "t1", source: "observer", why: "model-skip" },
    { type: "moment.skip", t: t0 + 40_000, turnId: "t2", source: "direct", why: "model-skip" },
    { type: "moment.drop", t: t0 + 60_000, turnId: "t3", source: "direct", why: "stale-turn", tag: "ANS" },
    { type: "moment.drop", t: t0 + 80_000, turnId: "t4", source: "observer", why: "guard:price", tag: "ANS" },
    { type: "moment.chip", t: t0 + 100_000, turnId: "t5", source: "observer", why: "per-minute-cap", tag: "NOTE" },
  ]);
  fs.writeFileSync(path.join(d, "session.json"), JSON.stringify(withPast(g.mem, lang)), { mode: 0o600 });
  if (o.summary) {
    const he = lang === "he";
    fs.writeFileSync(
      path.join(d, "summary.json"),
      JSON.stringify({
        v: 1,
        generatedAt: new Date(t0 + 500_000).toISOString(),
        model: "fixture",
        summary: [he ? "שגיאת קופה אחרי עדכון של תוסף התשלום." : "A checkout error after a payment plugin update."],
        decisions: [he ? "החזרנו את הגרסה הקודמת על העותק." : "Rolled the plugin back on the copy."],
        nextSteps: [{ who: "אני", what: he ? "להחיל את החזרה על האתר החי." : "Apply the rollback to the live site." }],
        openQuestions: [],
        coaching: { talkSharePct: 41, longestMonologueSec: 95, questionsAsked: 6, paceWpm: { me: 142, them: 128 }, interruptions: 2 },
        followUpEmail: he ? "שלום לנה,\nהחזרנו את התוסף לגרסה הקודמת על העותק.\nתודה, דן" : "Hi Lena,\nWe rolled the plugin back on the copy.\nThanks, Dan",
      }),
      { mode: 0o600 },
    );
  }
  return id;
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node snapshot-fixtures.cjs <dataDir>");
    process.exit(2);
  }
  fs.mkdirSync(path.join(dir, "calls"), { recursive: true, mode: 0o700 });
  const briefs = path.join(dir, "briefs");
  fs.mkdirSync(briefs, { recursive: true, mode: 0o700 });
  const store = createPlanStore({ dir: briefs, pdftotext: "" });
  const soon = Date.now() + 90 * 60_000;
  const a = store.create({
    title: "Hosting move with Dana",
    who: "Dana Levi, Noam Bar",
    goal: "Agree a move date",
    mustCover: ["Price", "Downtime window"],
    at: soon,
    context:
      "Dana runs Levi Studio, 12 WordPress sites on one old server. The contract renews in March and the price rises 4% each year. She prefers WhatsApp. Ask about daily backups and who handles the security certificate.",
  });
  store.create({
    title: "פגישת היכרות עם נועה",
    who: "נועה כהן",
    goal: "להבין מה היא צריכה",
    context: "נועה מנהלת חנות אונליין לנעליים. היא רוצה אתר מהיר יותר ותמיכה בעברית.",
  });
  store.create({ who: "Beta Ltd, Ron Katz", context: "A short check-in. Invented example data only." });
  const m = store.get(a.meeting.id);
  store.markLive(m.id, "01SNAPSHOTCALL");
  store.confirmUsed(m.id, "01SNAPSHOTCALL");
  console.log(dir);
  // Calls only in the window language of the snapshot (argv[3]); without it both languages, as before.
  const only = process.argv[3] === "he" || process.argv[3] === "en" ? [process.argv[3]] : ["en", "he"];
  for (const lang of only) {
    writeCall(dir, lang);
    writeCall(dir, lang, { summary: true });
  }
}
module.exports = { golden, knowsFixture, writeCall };
