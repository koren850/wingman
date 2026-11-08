// The memory a call starts with: the prepared meeting (agenda, notes), the saved digest (people, facts) and "Last time" facts about people met before.
// One function, used by the engine at call start (engine/coach.ts, engine/moments.ts). No model call. With no digest and no past calls the result is
// exactly what the engine built before (agenda from the plan, notes as facts), so a call without context behaves as it did.
import { readDigestNear } from "./digest-file.ts";
import { indexFinishedCalls, namesForCall, pastFactsFor, type PastFact } from "./people.ts";
import { emptyDigest, seedFromDigest, type Digest } from "./seed.ts";
import { cleanText } from "./patch.ts";
import type { SessionMemory } from "./types.ts";

export type CallSeedInput = {
  /** the plan's must-cover lines and who joins */
  mustCover?: string[];
  who?: string;
  /** the plan's notes and typed notes, one fact each */
  notes: string[];
  /** the plan's brief.yaml path: digest.json is read next to it */
  briefFile?: string;
  /** a digest already in hand (tests) */
  digest?: Digest;
  now: number;
  /** context.pastCalls */
  pastCalls: boolean;
  callsDir: string;
  peopleFile: string;
  /** the running call's folder name (never indexed) */
  callId?: string;
};

const dedupe = (xs: string[]): string[] => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.trim().toLowerCase();
    return k && !seen.has(k) && !!seen.add(k);
  });
};

/** The "Last time" facts for a call, or []. Updates the people index first (cheap: it reads only calls that ended since the last run). */
export function pastForCall(o: Pick<CallSeedInput, "who" | "pastCalls" | "callsDir" | "peopleFile" | "callId">, roster: Digest["roster"]): PastFact[] {
  if (!o.pastCalls) return [];
  const names = namesForCall(roster, o.who);
  if (!names.length) return [];
  indexFinishedCalls({ callsDir: o.callsDir, file: o.peopleFile, ...(o.callId ? { skipId: o.callId } : {}) });
  return pastFactsFor(names, { file: o.peopleFile, ...(o.callId ? { exclude: o.callId } : {}) });
}

export function seedForCall(o: CallSeedInput): SessionMemory {
  const saved = o.digest ?? readDigestNear(o.briefFile) ?? emptyDigest();
  const facts = [...saved.facts, ...o.notes.map((t) => cleanText(t, 300) ?? "").filter(Boolean)];
  const d: Digest = {
    ...saved,
    agenda: dedupe([...(o.mustCover ?? []), ...saved.agenda]),
    facts,
  };
  return seedFromDigest(d, o.now, pastForCall(o, saved.roster));
}
