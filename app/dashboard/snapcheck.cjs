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
  if (/^idle-/.test(base) && r.primaries !== 1) out.push(`idle Home has ${r.primaries} primary buttons, expected 1`);
  if (/^idle-|^waiting-/.test(base) && r.dupWait > 0) out.push(`${r.dupWait} duplicate rows in Waiting for you`);
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
