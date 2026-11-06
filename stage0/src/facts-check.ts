// pnpm factscheck: false-hit check of the client/domain snapshot (entities.json in the Wingman data folder, EntitySpotter) against ordinary
// call speech (gold sentences, question corpus, bank, synthetic call). Every HIT printed here is a false positive to fix.
// Needs a private snapshot, so it only works on a machine that has one. Prints only; the exit code is always 0.
import { DATA, ENTITIES_FILE } from "./env.ts";
import { readPack } from "./pack.ts";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { EntitySpotter, loadSnapshot } from "./entities.ts";
const snap = loadSnapshot(ENTITIES_FILE)!;
const s = new EntitySpotter(snap, { sslWarnDays: 30, minAliasLen: 4 });
const D = DATA + "/";
const texts: string[] = [
  ...(JSON.parse(readFileSync(D + "gold/terms.json", "utf8")) as { sentence: string }[]).map((x) => x.sentence),
  ...readFileSync(D + "questions.tsv", "utf8").split("\n").map((l) => l.split("\t")[0]),
  ...(YAML.parse(readPack("bank.yaml")) as { say: string; facts: string[]; triggers: string[] }[]).flatMap((c) => [c.say, ...c.facts, ...c.triggers]),
  ...(JSON.parse(readFileSync(D + "synthetic/call1.json", "utf8")) as { turns?: { text: string }[] }).turns?.map((t) => t.text) ?? [],
];
let hits = 0;
for (const t of texts) for (const f of s.spot(t ?? "")) { hits++; console.log("HIT", f.key, "|", f.title, "|", t); }
console.log(`${texts.length} ordinary lines, ${hits} hits`);
// Lines that SHOULD hit: edit them to name clients from your own snapshot (kept generic here on purpose).
const real = ["אני מתקשר מאקמה", "זה מהסטודיו, יש בעיה באתר", "היי, מדבר מהמועצה המקומית", "האתר של העירייה לא עולה"];
for (const t of real) console.log("REAL", t, "=>", s.spot(t).map((f) => f.title + " | " + (f.lines[0] ?? "(no domains)")).join(" ;; ") || "none");
