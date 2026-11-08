"use strict";
// Fixture data for the hidden window snapshots (dashboard/snapshot.sh): invented meetings in a scratch data folder, so no real data is ever shown.
// Usage: node snapshot-fixtures.cjs <dataDir>. Writes <dataDir>/briefs/plans/... through the real plan store, and creates an empty calls folder.
const fs = require("node:fs");
const path = require("node:path");
const { createPlanStore } = require("../tray/plans.cjs");

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
