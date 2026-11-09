// The golden dev meetings through the real v2 engine (in-process, virtual clock, the policy fake serving the meetings' own scripted replies).
// Scores are labelled SCRIPTED: the replies were written by hand next to the moments, so this proves the plumbing (hint, observer window, scheduler,
// guards, card kinds, timing), not the model. Also: cost per role against the planned table.
import "./test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupEngine, type Engine } from "./testkit/engine-inproc.ts";
import { loadSplit } from "../qa/golden-load.ts";
import { gradeGolden, poolGrades, type TimelineCard } from "../qa/grade-golden.ts";
import { guard } from "./guards.ts";
import type { Golden } from "./testkit/golden-types.ts";

let e: Engine;
before(async () => {
  e = await setupEngine();
});
after(() => e?.stop());

type Played = { golden: Golden; cards: TimelineCard[]; calls: { role: string; usd: number }[] };

/** Plays one meeting. Returns the card timeline (ms from the start of the meeting) and the model calls with their price. */
async function play(g: Golden): Promise<Played> {
  await e.reset();
  const textOf = new Map(g.lines.map((l) => [l.id, l.text]));
  for (const s of g.script ?? []) {
    if (s.role !== "moment") continue;
    const t = textOf.get(s.whenLastLine);
    if (!t) continue;
    e.pm.reply({ role: ["moment", "observer"], lastLine: t }, s.reply, { ms: s.ms ?? 800 });
  }
  const t0 = Date.now();
  let prev = 0;
  for (const l of g.lines) {
    await e.vc.advance(Math.max(0, l.t - prev));
    prev = l.t;
    e.say(l.side, l.text);
  }
  await e.vc.advance(15_000);
  const first = new Map<string, number>();
  for (const r of e.rows) if (r.type === "card" && !r.health && !r.hidden && !r.withdraw && !first.has(r.id)) first.set(r.id, r.t - t0);
  const cards: TimelineCard[] = e.screen().map((c) => ({
    atMs: first.get(c.id) ?? 0,
    // A card without a kind: a prepared (bank), calc or stall card answers a question; an amber "careful" or red "fix" card checks what the user said.
    kind:
      (c.kind as TimelineCard["kind"]) ?? (c.badge === "careful" || c.badge === "fix" ? "check" : c.badge === "info" || c.badge === "tip" ? "fact" : "answer"),
    text: [c.say, ...((c.more as string[]) ?? [])].join(" "),
  }));
  return { golden: g, cards, calls: e.pm.calls.map((c) => ({ role: c.view.role, usd: 0 })) };
}

const dev = loadSplit("dev").filter((g) => g.type !== "interview"); // a practice interview keeps the classic engine

test("golden dev through the v2 engine (SCRIPTED): the planned moments show, silent windows stay quiet, guards hold", { timeout: 120_000 }, async () => {
  const grades = [];
  const lines: string[] = [];
  for (const g of dev) {
    const p = await play(g);
    const grade = gradeGolden(g, p.cards, { guard: (t) => !guard(t).ok });
    grades.push({ golden: g, grade });
    lines.push(
      `${g.id.padEnd(22)} recall ${(grade.recall * 100).toFixed(0).padStart(3)}% prec ${(grade.precision * 100).toFixed(0).padStart(3)}% direct ${(grade.directRecall * 100).toFixed(0).padStart(3)}% ttc p50 ${grade.ttcP50 ?? "-"} silent ${grade.silentCards} dup ${grade.duplicates} guard ${grade.guardBreaches} calls ${p.calls.length}`,
    );
  }
  const pooled = poolGrades(grades);
  console.log(lines.join("\n"));
  console.log(
    `POOLED scripted: recall ${(pooled.recall * 100).toFixed(1)}% precision ${(pooled.precision * 100).toFixed(1)}% direct ${(pooled.directRecall * 100).toFixed(1)}% silent cpm ${pooled.silentCpm.toFixed(2)}`,
  );
  assert.ok(grades.length >= 14, "the dev set is loaded (the practice interviews are left out)");
  assert.ok(pooled.recall >= 0.6, `recall ${pooled.recall}`);
  assert.ok(pooled.directRecall >= 0.7, `direct recall ${pooled.directRecall}`);
  assert.ok(pooled.precision >= 0.6, `precision ${pooled.precision}`);
  assert.equal(pooled.guardBreaches, 0, "no card breaks the price, date or promise guard");
});

// ---------------------------------------------------------------- cost
// Estimates per call (USD, Haiku list prices): moment 0.00016, observer 0.00013. The cost test fails at +20 percent per role.
// The observer reads a little more per call (the LABEL line, windows that carry lines back after a dropped silence look): 0.00014.
// Round 14: the moment rules grew by five rules (language, no coaching in SAY, no thinking aloud, bank ids, direct questions). This test counts the role
// instructions at the plain price, although they are served from the prompt cache; measured 0.000168 per call, so the observer table is 0.00015.
// The per-hour gate (v2-cost, USD 0.25) is the real limit.
const TABLE = { moment: 0.00016, observer: 0.00015 };
test("cost: usage rows of golden dev meetings, per role, stay within the planned table (+20 percent)", { timeout: 120_000 }, async () => {
  const { readFileSync } = await import("node:fs");
  const usageRows = () =>
    readFileSync(e.boot.log.dir + "/usage.jsonl", "utf8")
      .split("\n")
      .filter(Boolean);
  const before = usageRows().length; // earlier tests of this file wrote rows too
  const replyTokens: Record<string, number[]> = {}; // tokens of each reply the fake served, per role, in call order (a SKIP is short, a card is not)
  for (const id of ["dev-sales-en", "dev-pricing-he", "dev-support-en"]) {
    const g = dev.find((x) => x.id === id)!;
    await play(g);
    for (const c of e.pm.calls) {
      const a = c.action as { text?: string } | undefined;
      (replyTokens[c.view.role] ??= []).push(Math.ceil((a?.text ?? "SKIP").length / 4));
    }
  }
  const rows = usageRows()
    .slice(before)
    .map((l) => JSON.parse(l) as { role: string; ctx?: { parts: Record<string, number>; tokens: number }; aborted?: boolean });
  const price = e.boot.S.budget.prices.llm["anthropic:claude-haiku-5-5"];
  const SHARED = new Set(["rules", "profile", "houseStyle", "bankIndex", "digest", "memory"]); // blocks A and B: served from the prompt cache at steady state
  const per: Record<string, number[]> = {};
  const seen: Record<string, number> = {};
  for (const r of rows) {
    if (!r.ctx || (r.role !== "moment" && r.role !== "observer")) continue;
    const OUT = replyTokens[r.role]?.[(seen[r.role] = (seen[r.role] ?? -1) + 1)] ?? 60;
    const cached = Object.entries(r.ctx.parts).reduce((a, [k, v]) => a + (SHARED.has(k) ? v : 0), 0);
    const plain = r.ctx.tokens - cached;
    if (process.env.COST_DEBUG) console.log("PARTS", r.role, JSON.stringify(r.ctx.parts));
    (per[r.role] ??= []).push((plain * price.inUsdPerM + cached * (price.cacheReadUsdPerM ?? price.inUsdPerM) + OUT * price.outUsdPerM) / 1e6);
  }
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  for (const role of ["moment", "observer"] as const) {
    assert.ok(per[role]?.length >= 5, `${role}: usage rows with a context record (${per[role]?.length ?? 0})`);
    const a = avg(per[role]);
    console.log(`COST ${role}: ${per[role].length} calls, average ${a.toFixed(6)} USD per call (table ${TABLE[role]})`);
    assert.ok(a <= TABLE[role] * 1.2, `${role}: ${a.toFixed(6)} USD per call is over the table ${TABLE[role]} + 20 percent`);
  }
});
