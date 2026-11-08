// A "live-shaped" run of a golden meeting: what the answer window and the Wingman window would have received during the call.
// No engine and no model: the scripted replies of the golden file go through the real parsers (moments/parse.ts, session/patch.ts, session/seed.ts).
//   goldenLiveRun(g)   -> every card row (v2 shape), view row, memory state and transcript line, in time order
//   liveFixtureSet()   -> the small JSON the snapshot tools read (src/testkit/fixtures/live-golden.json); a test keeps the file equal to a fresh build
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { ROOT } from "../env.ts";
import { parseMoment } from "../moments/parse.ts";
import { applyPatch } from "../session/patch.ts";
import { seedFromDigest, type Digest } from "../session/seed.ts";
import { toView } from "../session/view.ts";
import type { SessionMemory } from "../session/types.ts";
import type { Golden } from "./golden-types.ts";

const require = createRequire(import.meta.url);
const MV = require("../../shared/memview.js") as {
  overlayViewRow(src: unknown, o?: { ai?: string; at?: number; meNames?: string[] }): Record<string, unknown>;
  recapFromMemory(m: unknown, o?: { meNames?: string[] }): Record<string, unknown>;
};

export type LiveCard = Record<string, unknown> & { id: string; at: number };
export type LiveStep = { t: number; atLine: string; mem: SessionMemory };
export type LiveRun = {
  id: string;
  lang: string;
  lines: { t: number; ch: "me" | "them"; text: string; name?: string }[];
  cards: LiveCard[]; // card rows and close rows, in time order
  steps: LiveStep[]; // the memory after each patch
  finalMem: SessionMemory;
};

const KIND_OF: Record<string, { kind: "answer" | "prompt" | "check" | "fact"; badge: string }> = {
  ANS: { kind: "answer", badge: "ai" },
  REPLY: { kind: "answer", badge: "ai" },
  PROMPT: { kind: "prompt", badge: "tip" },
  CHECK: { kind: "check", badge: "careful" },
  TERM: { kind: "fact", badge: "info" },
  NOTE: { kind: "fact", badge: "info" },
};

export function goldenLiveRun(g: Golden): LiveRun {
  const script = g.script ?? [];
  const cards: LiveCard[] = [];
  const steps: LiveStep[] = [];
  let mem: SessionMemory | undefined;
  const digest = script.find((s) => s.role === "digest");
  if (digest) {
    try {
      mem = seedFromDigest(JSON.parse(digest.reply) as Digest, 0);
    } catch {
      /* a bad scripted digest: start empty */
    }
  }
  mem ??= seedFromDigest(undefined, 0);
  for (const [i, line] of g.lines.entries()) {
    for (const s of script.filter((x) => x.whenLastLine === line.id)) {
      const at = line.t + (s.ms ?? 1200);
      if (s.role === "memory") {
        try {
          const r = applyPatch(mem, JSON.parse(s.reply), { now: at });
          if (r.applied) {
            mem = r.mem;
            steps.push({ t: at, atLine: line.id, mem });
          }
        } catch {
          /* a bad scripted patch is dropped, as the engine does */
        }
      } else if (s.role === "moment") {
        const m = parseMoment(s.reply).moment;
        const k = KIND_OF[m.tag];
        if (!k || m.aim === "other" || !m.say) continue;
        const id = `${g.id}-${line.id}`;
        cards.push({
          type: "card",
          id,
          turnId: `t-${line.id}`,
          badge: k.badge,
          kind: k.kind,
          value: m.value,
          question: k.kind === "answer" ? line.text : "",
          say: m.say,
          why: m.why,
          more: m.more,
          ...(m.ref ? { ref: m.ref } : {}),
          facts: [],
          at,
        });
        // the next line is the user's own: the card closes as answered
        const next = g.lines[i + 1];
        if ((k.kind === "answer" || k.kind === "prompt") && next && next.side === "me" && next.t - line.t < 20_000)
          cards.push({ type: "card", id, closes: "answered", at: next.t + 800 });
      }
    }
  }
  cards.sort((a, b) => a.at - b.at);
  return {
    id: g.id,
    lang: g.lang,
    lines: g.lines.map((l) => ({ t: l.t, ch: l.side, text: l.text, ...(l.speaker ? { name: l.speaker } : {}) })),
    cards,
    steps,
    finalMem: mem,
  };
}

const read = (id: string): Golden => JSON.parse(readFileSync(join(ROOT, "data", "meetings", "dev", id + ".json"), "utf8")) as Golden;

/** The meetings the snapshots use: the pricing meeting in English and in Hebrew (it holds all four card kinds). */
export const LIVE_MEETINGS = ["dev-support-en", "dev-support-he"] as const;

export type LiveFixture = {
  id: string;
  lang: string;
  /** Card rows to replay, then the state at the end of the call. */
  cards: LiveCard[];
  /** The view row for the answer window after the last patch. */
  view: Record<string, unknown>;
  /** The notes recap (what the sheet shows with no AI). */
  recap: Record<string, unknown>;
  /** The memory (full) after the last patch and half way. */
  mem: SessionMemory;
  midMem: SessionMemory;
  lines: LiveRun["lines"];
  /** The view as the relay carries it. */
  memView: ReturnType<typeof toView>;
};

export function liveFixtureSet(): Record<string, LiveFixture> {
  const out: Record<string, LiveFixture> = {};
  for (const id of LIVE_MEETINGS) {
    const g = read(id);
    const run = goldenLiveRun(g);
    const me = [g.profile?.userName ?? "me"];
    const mid = run.steps[Math.floor(run.steps.length / 2)]?.mem ?? run.finalMem;
    out[id] = {
      id,
      lang: g.lang,
      cards: run.cards,
      view: MV.overlayViewRow(run.finalMem, { at: 0, meNames: me }),
      recap: MV.recapFromMemory(run.finalMem, { meNames: me }),
      mem: run.finalMem,
      midMem: mid,
      lines: run.lines.slice(-6),
      memView: toView(run.finalMem),
    };
  }
  return out;
}

export const LIVE_FIXTURE_FILE = join(ROOT, "src", "testkit", "fixtures", "live-golden.json");
