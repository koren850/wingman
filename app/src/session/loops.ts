// Open loops: what is still hanging at this point of the call, read from the session memory. Pure. No model, no words lists:
// a person is "me" when the roster says so (or the name is the user's own), a question is "for me" when it was asked by the other side
// and is addressed to me or to nobody in particular.
import { isMeLabel } from "../profile.ts";
import type { Commitment, OpenQuestion, Objection, SessionMemory } from "./types.ts";

/** Does this name mean the user? The roster side wins; the profile name and "me" count too. */
export function isMine(who: string | undefined, mem: SessionMemory): boolean {
  const w = String(who ?? "")
    .trim()
    .toLowerCase();
  if (!w) return false;
  const p = mem.roster.find((r) => r.name.trim().toLowerCase() === w);
  if (p) return p.side === "me";
  return isMeLabel(w);
}

export type Loops = {
  /** what the user promised and has not done */
  youPromised: Commitment[];
  /** what the other side promised and has not done */
  theyPromised: Commitment[];
  /** questions from the other side, for the user (or for nobody in particular), still open */
  askedOfYou: OpenQuestion[];
  /** other open questions (the user's own, or between the other people) */
  otherOpen: OpenQuestion[];
  objections: Objection[];
  coverLeft: { id: string; text: string }[];
};

export function openLoops(mem: SessionMemory): Loops {
  const open = mem.commitments.filter((c) => c.status === "open");
  const qs = mem.openQuestions.filter((q) => q.status === "open");
  const forMe = (q: OpenQuestion) => !isMine(q.asker, mem) && (!q.to || isMine(q.to, mem));
  return {
    youPromised: open.filter((c) => isMine(c.who, mem)),
    theyPromised: open.filter((c) => !isMine(c.who, mem)),
    askedOfYou: qs.filter(forMe),
    otherOpen: qs.filter((q) => !forMe(q)),
    objections: mem.objections.filter((o) => !o.handled),
    coverLeft: mem.mustCover.filter((m) => !m.done).map((m) => ({ id: m.id, text: m.text })),
  };
}

const dueText = (c: Commitment) => (c.due ? ` (${c.due})` : "");
/** One short line per promise, e.g. "send the plan (Friday)". */
export const promiseLine = (c: Commitment): string => `${c.what}${dueText(c)}`;
