// Cards of a cassette replay, split by kind, source (direct / observer / tips ...), VALUE, CONF, silent window, language and meeting type, with the recorded model-judge verdict.
// Usage (from app/): ./node_modules/.bin/tsx scripts/card-breakdown.ts [rows.json] [cassette]. Writes every card as a row to rows.json (default qa/out/rows.json). No API call.
import "../src/test-setup.ts";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadSplit } from "../qa/golden-load.ts";
import { play, v2Meetings } from "../qa/eval-v2.ts";
import { Cassette, CassetteMiss } from "../src/providers/cassette.ts";
import { ModelJudge } from "../qa/judge.ts";
const C = resolve(process.argv[3] ?? "data/cassettes/dev.cassette.json");
const ms = v2Meetings(loadSplit("dev"));
const plan = await play(ms, { split: (g) => g.split, replay: C });
const judge = new ModelJudge({ cassette: new Cassette(C.replace(".cassette.json", ".judge.cassette.json")) });
type Row = {
  m: string;
  lang: string;
  type: string;
  kind: string;
  src: string;
  value: unknown;
  conf: unknown;
  silent: boolean;
  v: string;
  at: number;
  text: string;
};
const rows: Row[] = [];
for (const run of plan.clean) {
  const g = ms.find((x) => x.id === run.id)!;
  const idx = new Map(g.lines.map((l, i) => [l.id, i]));
  const wins = g.silent.map((s) => ({ from: g.lines[idx.get(s.fromLine)!].t, to: g.lines[idx.get(s.toLine)! + 1]?.t ?? g.lines[idx.get(s.toLine)!].t + 3000 }));
  const sorted = run.cards.map((c, i) => ({ c, i }));
  for (const { c, i } of sorted) {
    const s = run.screen[i];
    let v = "none";
    try {
      v = (await judge.judge(g, c)).good ? "good" : "bad";
    } catch (e) {
      if (!(e instanceof CassetteMiss)) throw e;
    }
    const t = String(s?.turnId);
    rows.push({
      m: g.id,
      lang: g.lang,
      type: g.type,
      kind: c.kind,
      src: /^q/.test(t) ? "direct" : /^o/.test(t) ? "observer" : t,
      value: s?.value,
      conf: s?.conf,
      silent: wins.some((w) => c.atMs >= w.from && c.atMs < w.to),
      v,
      at: c.atMs,
      text: c.text.slice(0, 90),
    });
  }
}

writeFileSync(process.argv[2] ?? "qa/out/rows.json", JSON.stringify(rows));
const by = (f: (r: Row) => string) => {
  const a: Record<string, [number, number, number]> = {};
  for (const r of rows) {
    const k = f(r);
    a[k] ??= [0, 0, 0];
    a[k][0]++;
    if (r.v === "good") a[k][1]++;
    if (r.v === "none") a[k][2]++;
  }
  return Object.entries(a)
    .sort()
    .map(([k, [n, g, u]]) => `${k.padEnd(28)} n=${n} useful=${g} unjudged=${u} notuseful=${n - g - u}`)
    .join("\n");
};
for (const [n, f] of [
  ["kind", (r: Row) => r.kind],
  ["source", (r: Row) => r.src],
  ["value", (r: Row) => String(r.value)],
  ["conf", (r: Row) => String(r.conf)],
  ["silent", (r: Row) => String(r.silent)],
  ["lang", (r: Row) => r.lang],
  ["type", (r: Row) => r.type],
  ["src+kind+value", (r: Row) => `${r.src}/${r.kind}/v${r.value}/${r.conf}`],
] as const)
  console.log(`-- by ${n}\n${by(f)}`);
