// Child process for the Wingman window (dashboard/window.cjs): the parts of round 12 / r3-features that need TypeScript code.
// stdin: one JSON object { op, ... }. stdout: one JSON line { ok: true, ... } or { ok: false, reason }. It never prints call text except the answers it was asked for.
//   learn.summary                       what the app learned about the user's ratings (counts only)
//   learn.reset                         forget it (deletes learn.json)
//   learn.wanted { tag }                a held-back moment of this kind was rated "I wanted this" (learn.ts lowers the raised step by one rating)
//   past.list                           what is stored about people from earlier calls, per person
//   past.forget { key, callId? }        delete one person (or one call of a person)
//   past.search { q }                   search finished calls (summaries, facts); offline answer with call date and source
//   past.recap { title, who, topic, goal }   an earlier call that looks like this meeting (names, then company or topic words): the offer for a recurring meeting
//   lookup { term }                     look one term up (needs lookup.enabled); never runs when the setting is off
//   modes.list                          custom modes from the pack (id and label), for the mode picker
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { CALLS, USER_DATA } from "./env.ts";
import { learnSummary, noteWanted, resetLearning } from "./moments/learn.ts";
import { MOMENT_TAGS, type MomentTag } from "./moments/types.ts";
import { PEOPLE_FILE, forgetPast, indexFinishedCalls, listPast, meetingWords, namesForCall, pastCallsLike, pastFactsFor } from "./session/people.ts";
import { askPast } from "./session/past.ts";
import { lookup } from "./session/lookup.ts";
import { loadSettings } from "./settings.ts";
import { packDirs } from "./pack.ts";
import YAML from "yaml";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const peopleFile = join(USER_DATA, PEOPLE_FILE);
const str = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

/** Custom modes from the pack file modes.yaml: [{ id, label }], at most 6. The id is letters, digits, dash and underscore; the text of a mode never leaves this file. */
export function readModes(dirs: string[] = packDirs()): { id: string; label: string }[] {
  for (const d of dirs) {
    const f = join(d, "modes.yaml");
    if (!existsSync(f)) continue;
    try {
      const y = YAML.parse(readFileSync(f, "utf8")) as unknown;
      const list = Array.isArray(y)
        ? y
        : y && typeof y === "object" && Array.isArray((y as { modes?: unknown }).modes)
          ? (y as { modes: unknown[] }).modes
          : [];
      return list
        .flatMap((m): { id: string; label: string }[] => {
          const o = m as { id?: unknown; label?: unknown };
          const id = typeof o?.id === "string" && /^[A-Za-z0-9_-]{1,20}$/.test(o.id) ? o.id : "";
          const label = str(o?.label, 40) || id;
          return id ? [{ id, label }] : [];
        })
        .slice(0, 6);
    } catch {
      return [];
    }
  }
  return [];
}

export async function handle(i: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (i.op) {
    case "learn.summary":
      return { ok: true, ...learnSummary() };
    case "learn.reset":
      resetLearning();
      return { ok: true };
    case "learn.wanted": {
      const tag = String(i.tag);
      if (!(MOMENT_TAGS as readonly string[]).includes(tag) || tag === "SKIP") return { ok: false, reason: "bad-input" };
      noteWanted(tag as MomentTag);
      return { ok: true };
    }
    case "past.list":
      return { ok: true, people: listPast(peopleFile) };
    case "past.forget": {
      const key = str(i.key, 100),
        callId = str(i.callId, 60);
      if (!key) return { ok: false, reason: "bad-input" };
      return { ok: true, removed: forgetPast(peopleFile, key, callId || undefined) };
    }
    case "past.search": {
      const q = str(i.q, 300);
      if (!q) return { ok: false, reason: "bad-input" };
      const r = await askPast(CALLS, q, { peopleFile });
      return {
        ok: true,
        found: r.found,
        text: r.text,
        offline: r.offline,
        hits: r.hits.map((h) => ({ text: h.text, callId: h.callId, at: h.at, source: h.source, people: h.people })),
      };
    }
    case "past.recap": {
      const who = str(i.who, 300);
      indexFinishedCalls({ callsDir: CALLS, file: peopleFile });
      const names = namesForCall(undefined, who);
      const byName = names.length ? pastFactsFor(names, { file: peopleFile, max: 5 }) : [];
      if (byName.length) return { ok: true, by: "name", facts: byName.map((f) => ({ text: f.text, at: f.at, callId: f.callId })) };
      const like = pastCallsLike(meetingWords({ title: str(i.title, 120), who, topic: str(i.topic, 120), goal: str(i.goal, 200) }), {
        file: peopleFile,
        max: 1,
      })[0];
      if (!like) return { ok: true, by: "none", facts: [] };
      return {
        ok: true,
        by: "topic",
        person: like.person,
        facts: [
          ...(like.topic ? [{ text: like.topic, at: like.at, callId: like.id }] : []),
          ...like.promises.map((p) => ({ text: `${p.who}: ${p.text}`, at: like.at, callId: like.id })),
        ],
      };
    }
    case "lookup": {
      const s = loadSettings({ env: process.env, argv: [] }).settings;
      const r = await lookup(str(i.term, 200), { enabled: s.lookup.enabled, maxUsd: s.lookup.maxUsdPerCall });
      return r.ok ? { ...r } : { ok: false, reason: r.code, message: r.message };
    }
    case "modes.list":
      return { ok: true, modes: readModes() };
    default:
      return { ok: false, reason: "bad-input" };
  }
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  (async () => {
    let raw = "";
    for await (const c of process.stdin) raw += c;
    try {
      const i = JSON.parse(raw) as unknown;
      if (!i || typeof i !== "object" || Array.isArray(i)) return out({ ok: false, reason: "bad-input" });
      out(await handle(i as Record<string, unknown>));
    } catch {
      out({ ok: false, reason: "failed" });
    }
  })();
}
