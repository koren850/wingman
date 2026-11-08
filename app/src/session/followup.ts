// The follow-up draft: a short message to the other side, written from the session memory (decisions, promises, open questions) with no model call.
// It passes the same sentence guard as the summary email: a price, a date or a promise becomes a "[fill in: ...]" placeholder for the user to complete.
// `wingman followup` prints it. A model-written draft in summary.json (written after the call) is preferred when it exists; it is guarded again.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { callLanguage, type CallLang } from "../calllang.ts";
import { ht, type UiLang } from "../htext.ts";
import { guardEmail, placeholders } from "../summary-email.ts";
import type { Commitment } from "./types.ts";
import { openLoops } from "./loops.ts";
import { loadMemory } from "./store.ts";
import { isEmptyMemory, type SessionMemory } from "./types.ts";

export type Followup = { text: string; lang: CallLang; source: "summary" | "memory" | "none"; replaced: number; rules: string[] };

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The draft from memory. Empty text when the memory holds nothing worth writing. */
export function followupFromMemory(mem: SessionMemory, lang?: CallLang): Followup {
  const l: CallLang = lang ?? callLanguage([mem.summary, ...mem.decisions.map((d) => d.text), ...mem.commitments.map((c) => c.what)].join("\n"));
  const ui = l as UiLang;
  const loops = openLoops(mem);
  const decided = mem.decisions.map((d) => oneLine(d.text));
  // A due date is never copied: the sentence guard would drop the whole line. The user fills the date in.
  const what = (c: Commitment) => oneLine(c.what) + (c.due ? ` ${placeholders(l).date}` : "");
  const steps = [...loops.youPromised.map((c) => `- ${what(c)}`), ...loops.theyPromised.map((c) => `- ${oneLine(c.who)}: ${what(c)}`)];
  // what the other side asked and is waiting for, and what is still unanswered
  const open = [...loops.askedOfYou, ...loops.otherOpen];
  if (isEmptyMemory(mem) || (!decided.length && !steps.length && !open.length)) return { text: "", lang: l, source: "none", replaced: 0, rules: [] };
  const out = [ht(ui, "fu.hello"), ""];
  if (decided.length) out.push(ht(ui, "fu.thanks"), ...decided.map((d) => `- ${d}`), "");
  if (steps.length) out.push(ht(ui, "fu.next"), ...steps, "");
  if (open.length) out.push(ht(ui, "fu.open"), ...open.map((q) => `- ${oneLine(q.text)}`), "");
  out.push(ht(ui, "fu.bye"));
  const g = guardEmail(out.join("\n"), undefined, l);
  return { text: g.text, lang: l, source: "memory", replaced: g.replaced, rules: g.rules };
}

/** The draft of a saved call folder: summary.json's email when there is one, else the memory draft (session.json). */
export function followupForCall(dir: string, lang?: CallLang): Followup {
  const sum = join(dir, "summary.json");
  if (existsSync(sum)) {
    try {
      const j = JSON.parse(readFileSync(sum, "utf8")) as { followUpEmail?: unknown };
      const email = typeof j.followUpEmail === "string" ? j.followUpEmail.trim() : "";
      if (email) {
        const l: CallLang = lang ?? callLanguage(email);
        const g = guardEmail(email, undefined, l);
        return { text: g.text, lang: l, source: "summary", replaced: g.replaced, rules: g.rules };
      }
    } catch {
      /* a broken summary file: fall back to the memory */
    }
  }
  const mem = loadMemory(dir).mem;
  return followupFromMemory(mem, lang);
}
