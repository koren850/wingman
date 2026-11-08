// People across calls: a small local index of finished calls by the names on their roster, so a new call can start with a few "Last time" facts
// about people you have met before (open promises, the last topic). Everything is local and needs no model call.
//   indexFinishedCalls(o)  reads the calls that ended since the last run (calls/<id>/call.json + session.json) and updates people.json
//   pastFactsFor(names, o) up to 5 facts for the names, newest first, open promises before topics (src "past" once they are in a memory)
// The index holds short strings that came from the user's own saved calls. It lives in the data folder (mode 600) and is never sent anywhere
// except inside the call memory, like any other fact. Turn it off with context.pastCalls.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanText } from "./patch.ts";
import { loadMemory } from "./store.ts";
import type { SessionMemory } from "./types.ts";

export const PEOPLE_FILE = "people.json";
export const MAX_PAST_FACTS = 5;
const MAX_PEOPLE = 300;
const MAX_CALLS_PER_PERSON = 3;
const MAX_DONE = 600;
const MAX_SCAN = 300;
const MAX_PROMISES = 3;

export type PastCall = { id: string; at: number; topic?: string; promises: { who: string; text: string }[] };
export type PersonRec = { name: string; calls: PastCall[] };
export type PeopleIndex = { v: 1; people: Record<string, PersonRec>; done: string[] };
/** A fact about an earlier call, before it becomes a memory fact. `at` is the end of that call (epoch ms). */
export type PastFact = { text: string; who: string; at: number; callId: string; kind: "promise" | "topic" };

const empty = (): PeopleIndex => ({ v: 1, people: {}, done: [] });

/** Lower case, no accents or punctuation, single spaces. Works for Hebrew and Latin letters. */
export const normName = (n: string): string =>
  String(n ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
const tokenSet = (n: string) =>
  new Set(
    normName(n)
      .split(" ")
      .filter((t) => t.length >= 2),
  );
/** Same person: equal names, or every word of the shorter name is in the longer one ("Dana" and "Dana Levi"). One-letter words never count. */
export function sameName(a: string, b: string): boolean {
  const na = normName(a),
    nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = tokenSet(a),
    tb = tokenSet(b);
  if (!ta.size || !tb.size) return false;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  return [...small].every((t) => big.has(t));
}

export function readIndex(file: string): PeopleIndex {
  try {
    if (!existsSync(file) || statSync(file).size > 2_000_000) return empty();
    const j = JSON.parse(readFileSync(file, "utf8")) as Partial<PeopleIndex>;
    if (!j || j.v !== 1 || typeof j.people !== "object" || !j.people) return empty();
    const people: Record<string, PersonRec> = {};
    for (const [k, p] of Object.entries(j.people)) {
      if (!p || typeof p.name !== "string" || !Array.isArray(p.calls)) continue;
      const calls = p.calls.flatMap((c): PastCall[] => {
        if (!c || typeof c.id !== "string" || !Number.isFinite(c.at)) return [];
        const topic = cleanText(c.topic, 120);
        const promises = (Array.isArray(c.promises) ? c.promises : []).flatMap((x) => {
          const who = cleanText(x?.who, 60),
            text = cleanText(x?.text, 140);
          return who && text ? [{ who, text }] : [];
        });
        return [{ id: c.id.slice(0, 60), at: c.at, ...(topic ? { topic } : {}), promises: promises.slice(0, MAX_PROMISES) }];
      });
      const name = cleanText(p.name, 80);
      if (name && calls.length) people[k] = { name, calls: calls.slice(0, MAX_CALLS_PER_PERSON) };
    }
    return { v: 1, people, done: Array.isArray(j.done) ? j.done.filter((x) => typeof x === "string").slice(-MAX_DONE) : [] };
  } catch {
    return empty();
  }
}
function writeIndex(file: string, idx: PeopleIndex): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(idx), { mode: 0o600 });
  renameSync(tmp, file);
}

const ME = /^(me|i|myself|אני|אנכי)$/i;
const isMe = (who: string) => ME.test(who.trim());

/** What one finished call says about the people on its roster (the other side only): the last topic and the promises still open. Null when there is nothing to remember. */
export function summarizeCall(id: string, at: number, mem: SessionMemory): { names: string[]; call: PastCall } | null {
  const names = mem.roster.filter((p) => p.side !== "me").map((p) => p.name);
  if (!names.length) return null;
  const topic = cleanText(mem.topic.now || mem.topic.history.at(-1)?.label, 120);
  const promises = mem.commitments
    .filter((c) => c.status === "open")
    .slice(-MAX_PROMISES)
    .flatMap((c) => {
      const text = cleanText(c.what, 140);
      return text ? [{ who: isMe(c.who) ? "me" : (cleanText(c.who, 60) ?? "?"), text }] : [];
    });
  if (!topic && !promises.length) return null;
  return { names, call: { id, at, ...(topic ? { topic } : {}), promises } };
}

export type IndexOptions = {
  callsDir: string;
  file: string;
  /** a call that is running now (its folder is skipped) */
  skipId?: string;
};
/**
 * Adds the calls that have ended since the last run to the index. Only real calls (mode "live") with endedAt are read, newest first, at most 300 a run.
 * Returns how many calls were new. Never throws.
 */
export function indexFinishedCalls(o: IndexOptions): number {
  try {
    mkdirSync(join(o.file, ".."), { recursive: true, mode: 0o700 });
    const idx = readIndex(o.file);
    const done = new Set(idx.done);
    let ids: string[] = [];
    try {
      ids = readdirSync(o.callsDir).filter((n) => n !== "latest" && n !== o.skipId && !done.has(n));
    } catch {
      return 0;
    }
    ids = ids.sort().reverse().slice(0, MAX_SCAN);
    let added = 0;
    for (const id of ids) {
      const dir = join(o.callsDir, id);
      let meta: { mode?: string; endedAt?: string; startedAt?: string };
      try {
        meta = JSON.parse(readFileSync(join(dir, "call.json"), "utf8"));
      } catch {
        continue; // not a call folder yet: look again next time
      }
      if (!meta.endedAt) continue; // still running, or it crashed: look again next time
      idx.done.push(id);
      if (meta.mode !== "live") continue;
      const at = Date.parse(meta.endedAt) || Date.parse(meta.startedAt ?? "") || 0;
      if (!at) continue;
      const s = summarizeCall(id, at, loadMemory(dir, at).mem);
      if (!s) continue;
      for (const name of s.names) {
        const k = normName(name);
        if (!k) continue;
        const rec = idx.people[k] ?? { name, calls: [] };
        rec.calls = [s.call, ...rec.calls.filter((c) => c.id !== id)].sort((a, b) => b.at - a.at).slice(0, MAX_CALLS_PER_PERSON);
        idx.people[k] = rec;
      }
      added++;
    }
    idx.done = idx.done.slice(-MAX_DONE);
    const keys = Object.keys(idx.people);
    if (keys.length > MAX_PEOPLE) {
      keys.sort((a, b) => (idx.people[b].calls[0]?.at ?? 0) - (idx.people[a].calls[0]?.at ?? 0));
      for (const k of keys.slice(MAX_PEOPLE)) delete idx.people[k];
    }
    if (added || ids.length) writeIndex(o.file, idx);
    return added;
  } catch {
    return 0;
  }
}

const HE = /[֐-׿]/;
/** "Last time" wording. Neutral about gender. Language: Hebrew when the remembered text is Hebrew, else English. */
export function pastText(kind: "promise" | "topic", name: string, text: string, who?: string): string {
  const he = HE.test(text);
  if (kind === "topic") return he ? `בפעם הקודמת עם ${name}: ${text}` : `Last time with ${name}: ${text}`;
  if (who && isMe(who)) return he ? `בפעם הקודמת, הבטחה פתוחה שלך: ${text}` : `Last time, you promised: ${text}`;
  return he ? `בפעם הקודמת, הבטחה פתוחה של ${who || name}: ${text}` : `Last time, open promise from ${who || name}: ${text}`;
}

/**
 * Up to 5 facts about people you met before, for the names on a new call. Open promises come first (they can be acted on), then the last topic of
 * each person, newest call first. One call's facts are not repeated for two names. `exclude` is a call folder to leave out (the call itself).
 */
export function pastFactsFor(names: string[], o: { file: string; max?: number; exclude?: string }): PastFact[] {
  const idx = readIndex(o.file);
  const recs = Object.values(idx.people);
  const promises: PastFact[] = [],
    topics: PastFact[] = [];
  const usedCalls = new Set<string>();
  const seenPerson = new Set<string>();
  for (const name of names) {
    const hits = recs.filter((r) => sameName(name, r.name)).sort((a, b) => (b.calls[0]?.at ?? 0) - (a.calls[0]?.at ?? 0));
    const rec = hits[0];
    if (!rec || seenPerson.has(normName(rec.name))) continue;
    seenPerson.add(normName(rec.name));
    const call = rec.calls.find((c) => c.id !== o.exclude);
    if (!call || usedCalls.has(call.id + "|" + normName(rec.name))) continue;
    usedCalls.add(call.id + "|" + normName(rec.name));
    for (const p of call.promises) promises.push({ text: pastText("promise", name, p.text, p.who), who: name, at: call.at, callId: call.id, kind: "promise" });
    if (call.topic) topics.push({ text: pastText("topic", name, call.topic), who: name, at: call.at, callId: call.id, kind: "topic" });
  }
  const byNew = (a: PastFact, b: PastFact) => b.at - a.at;
  return [...promises.sort(byNew), ...topics.sort(byNew)].slice(0, Math.max(0, o.max ?? MAX_PAST_FACTS));
}

/** Names on the roster of a digest and in "who joins" ("Dana Levi, Noam Bar"), without the user, duplicates removed. */
export function namesForCall(roster: { name: string; side?: string }[] | undefined, who: string | undefined): string[] {
  const out: string[] = [];
  const add = (n: string | undefined) => {
    const c = cleanText(n, 80);
    if (c && !isMe(c) && !out.some((x) => sameName(x, c))) out.push(c);
  };
  for (const p of roster ?? []) if (p.side !== "me") add(p.name);
  for (const w of String(who ?? "").split(/[,;\n]/)) add(w.replace(/\(.*?\)/g, ""));
  return out.slice(0, 12);
}
