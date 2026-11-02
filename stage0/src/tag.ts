// pnpm tag [callId]: rate each card of a call as useful or not (feeds the usefulness gate, STRUCTURE.md §13).
import { readFileSync, existsSync, readdirSync, writeFileSync, realpathSync } from "node:fs";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";
import { CALLS } from "./env.ts";

const arg = process.argv[2];
const dir = arg ? join(CALLS, arg) : existsSync(join(CALLS, "latest")) ? realpathSync(join(CALLS, "latest")) : join(CALLS, readdirSync(CALLS).filter((d) => d !== "latest").sort().at(-1) ?? "");
const read = (f: string) => existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const cardsById = new Map<string, any>();
for (const c of read("cards.jsonl")) {
  if (c.type === "capture" || !c.id) continue;
  if (c.withdraw) { cardsById.delete(c.id); continue; }
  if (c.badge !== "info" && !c.health) cardsById.set(c.id, c); // last version of each card wins
}
const cards = [...cardsById.values()];
if (!cards.length) { console.log(`No cards in ${dir}`); process.exit(0); }

const prev = new Map<string, string>(read("tags.jsonl").map((t: any) => [t.id, t.useful]));
const rl = createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator](); // works for typing and for piped input
const ask = async (q: string) => { process.stdout.write(q); const r = await lines.next(); return r.done ? "q" : String(r.value); };
console.log(`Call ${basename(dir)} · ${cards.length} cards. For each: y = useful, n = not useful, s = skip, q = quit\n`);
const tags: { id: string; useful: string; badge: string }[] = [];
for (const [i, c] of cards.entries()) {
  if (prev.has(c.id)) { tags.push({ id: c.id, useful: prev.get(c.id)!, badge: c.badge }); continue; }
  console.log(`(${i + 1}/${cards.length}) [${c.badge}${c.hidden ? ` · hidden:${c.hiddenReason}` : ""}] Q: ${c.question}\n   → ${c.say}`);
  const a = (await ask("   useful? [y/n/s/q] ")).trim().toLowerCase();
  if (a === "q") break;
  if (a === "y" || a === "n") tags.push({ id: c.id, useful: a, badge: c.badge });
}
rl.close();
writeFileSync(join(dir, "tags.jsonl"), tags.map((t) => JSON.stringify(t)).join("\n") + "\n");

// Usefulness gate numbers: useful cards per hour, and the share of questions the bank answered.
const events = read("events.jsonl"), lat = read("latency.jsonl");
const times = events.map((e: any) => e.t).filter(Boolean);
const hours = times.length ? Math.max((Math.max(...times) - Math.min(...times)) / 3_600_000, 1 / 60) : 1;
const useful = tags.filter((t) => t.useful === "y").length;
const questions = lat.length, bankHits = lat.filter((l: any) => l.bankAt).length;
console.log(`\nUseful ${useful}/${tags.length} rated · ${(useful / hours).toFixed(1)} useful cards/hour (gate: >= 2) · bank answered ${questions ? Math.round((100 * bankHits) / questions) : 0}% of ${questions} questions`);
console.log(`Saved ${join(dir, "tags.jsonl")}`);
