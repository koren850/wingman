"use strict";
// Reads the results of `snapshot.sh --check` (one <name>.png.json per snapshot, written by clipcheck.js) and fails on the rules below.
// Usage: node snapcheck.cjs <outDir>. Exit 0 when every rule holds. Pure file reading: no Electron here (see rules() for the unit test).

/** The problems of one result. name = snapshot name (idle-*, keys-*, live-*, golden-*, ended-*, waiting-*, error-*, settings-*, narrow-*); r = the clipcheck JSON. */
function rules(name, r) {
  const out = [];
  const base = name.replace(/^narrow-/, "");
  const he = /-he-/.test(name);
  if (!r || typeof r !== "object") return ["no result"];
  for (const p of r.problems || []) out.push(p);
  if (r.dir !== (he ? "rtl" : "ltr")) out.push(`direction is ${r.dir}, expected ${he ? "rtl" : "ltr"}`);
  if (r.lang !== (he ? "he" : "en")) out.push(`language is ${r.lang}`);
  if (r.envNames > 0) out.push(`${r.envNames} env var names or keys.env show in the window text`);
  if (r.rawKeys && r.rawKeys.length) out.push(`a text key shows instead of its text: ${r.rawKeys.join(", ")}`);
  if (r.pendingPill) out.push("the permanent 'cards to rate' pill is back in the header");
  if (r.lowContrast && r.lowContrast.length) out.push(`low contrast: ${r.lowContrast.slice(0, 3).join("; ")}`);
  if (/^(live|golden|waiting)-/.test(base) && r.liveDelete) out.push("Delete this call is on the live card (it belongs in Calls)");
  if (/^idle-/.test(base) && r.startDisabled) out.push("Start is disabled on a ready Home");
  if (/^error-/.test(base) && !(r.startDisabled && r.startWhy)) out.push("Start is not disabled with a reason when the check failed");
  if (/^error-/.test(base) && !r.fixIt) out.push("Start has no Fix it button beside the reason");
  if (/^nokeys-/.test(base) && !(r.startDisabled && r.startWhy && r.fixIt)) out.push("without keys, Start is not disabled with a reason and a Fix it button");
  if (/^nokeys-/.test(base) && !r.practiceBesideStart) out.push("the practice call is not next to Start on a first run");
  if (/^ended-/.test(base) && !r.openSummary) out.push("the ended banner has no Open summary button");
  if (/^settings-/.test(base) && r.settingsTabs !== 5)
    out.push(`Settings has ${r.settingsTabs} tabs, expected 5 (Basics, Keys, Help engine, Privacy, Advanced)`);
  if (/^settings-/.test(base) && r.classicNew) out.push("Classic / New engine switch shows outside Advanced");
  if (/^revstart-/.test(base) && !(r.reviewStep && r.reviewRows > 0 && r.reviewKind && r.reviewSources > 0 && r.reviewSkip))
    out.push("the review step is missing roster, kind, sources or Start without review");
  if (/^revconf-/.test(base) && !r.reviewWarn) out.push("the review step shows no conflict warning for conflicting facts");
  if (/^revstart-/.test(base) && r.reviewWarn) out.push("the review step warns although the facts do not conflict");
  if (/^idle-/.test(base) && r.primaries !== 1) out.push(`idle Home has ${r.primaries} primary buttons, expected 1`);
  if (/^idle-|^waiting-/.test(base) && r.dupWait > 0) out.push(`${r.dupWait} duplicate rows in Waiting for you`);
  if (/^edit-/.test(base) && !r.understood) out.push("the Wingman understood line is not in the context editor");
  if (/^edit-/.test(base) && !r.sources) out.push("the web page and calendar controls are not in the context editor");
  if (/^review-/.test(base) && !r.review) out.push("the Review part of the call page did not draw");
  if (/^keys-/.test(base) && !r.sheet) out.push("the keys sheet did not open");
  if (/^golden-/.test(base) && r.sample) out.push("a Sample badge shows on real (golden) data");
  if (/^(live|golden)-/.test(base) && !r.pills) out.push("the Note / Ask pills were not found");
  return out;
}
module.exports = { rules };

if (require.main === module) {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node snapcheck.cjs <outDir>");
    process.exit(2);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png.json"));
  let bad = 0;
  for (const f of files.sort()) {
    const name = f.replace(/\.png\.json$/, "");
    let r = null;
    try {
      r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      /* reported below */
    }
    const p = rules(name, r);
    if (p.length) bad++;
    console.log((p.length ? "FAIL " : "ok   ") + name + (p.length ? "\n       " + p.join("\n       ") : ""));
  }
  if (!files.length) {
    console.log("FAIL no snapshots were written");
    process.exit(1);
  }
  console.log(`${files.length} snapshots, ${bad} failing`);
  process.exit(bad ? 1 : 0);
}
