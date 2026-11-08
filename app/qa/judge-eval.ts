// The model judge inside `pnpm eval`. It reads verdicts from a judge cassette that `scripts/cassette-record.ts --judge` wrote next to the engine cassette:
//   data/cassettes/dev.cassette.json  ->  data/cassettes/dev.judge.cassette.json
// The judge only makes sense for a recorded run (`pnpm eval --cassette <file>`): its prompts carry the cards the real model wrote, so scripted cards would not
// be in the file. Without the file the eval says so in one line and uses the rubric judge only. A card the cassette does not know counts as unjudged, not as bad.
import { existsSync } from "node:fs";
import { Cassette, CassetteMiss } from "../src/providers/cassette.ts";
import { ModelJudge, type ModelVerdict } from "./judge.ts";
import type { Golden } from "./grade-golden.ts";
import type { MeetingRun } from "../src/e2e/v2-kit.ts";

export const judgeCassettePath = (engineCassette: string) => engineCassette.replace(/\.cassette\.json$/, ".judge.cassette.json");

export type ModelJudgeSummary =
  | { status: "no-cassette"; path: string }
  | {
      status: "ok";
      path: string;
      cards: number;
      judged: number;
      good: number;
      unjudged: number;
      rate: number;
      bad: { meeting: string; text: string; reason: string }[];
    };

export async function modelJudgeSummary(pairs: { golden: Golden; run: MeetingRun }[], path: string): Promise<ModelJudgeSummary> {
  if (!existsSync(path)) return { status: "no-cassette", path };
  const judge = new ModelJudge({ cassette: new Cassette(path) });
  let cards = 0,
    judged = 0,
    good = 0;
  const bad: { meeting: string; text: string; reason: string }[] = [];
  for (const { golden, run } of pairs) {
    for (const c of [...run.cards].sort((a, b) => a.atMs - b.atMs)) {
      cards++;
      let v: ModelVerdict;
      try {
        v = await judge.judge(golden, c);
      } catch (e) {
        if (e instanceof CassetteMiss) continue;
        throw e;
      }
      judged++;
      if (v.good) good++;
      else bad.push({ meeting: golden.id, text: c.text.slice(0, 80), reason: v.reason });
    }
  }
  return { status: "ok", path, cards, judged, good, unjudged: cards - judged, rate: judged ? good / judged : 0, bad };
}
