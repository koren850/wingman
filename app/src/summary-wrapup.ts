// The post-call summary built from the call memory instead of the whole transcript (the default for a Live reading call). summary.ts holds the
// transcript summary and the shared types; this file builds on it.
import { Output } from "ai";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { generateOnce, providerOptionsFor } from "./providers/llm.ts";
import { isMeLabel, ME_LABEL } from "./profile.ts";
import { buildContext } from "./context/build.ts";
import { DEFAULT_BUDGETS, type Budgets } from "./context/budget.ts";
import { renderMemory } from "./session/render.ts";
import { isEmptyMemory, type SessionMemory } from "./session/types.ts";
import { eventError } from "./errtext.ts";
import { callLanguage, type CallLang } from "./calllang.ts";

import {
  type CallData,
  type CallSummary,
  type Fields,
  type NextStep,
  type RunOpts,
  type RunResult,
  coachingField,
  fieldsSchema,
  fixGreeting,
  kindGuidance,
  parseSummary,
  summarySystem,
} from "./summary.ts";
import { guardEmail } from "./summary-email.ts";

// ---------- wrap-up from the call memory ----------
// The memory (calls/<id>/session.json) already holds what the call was about, who promised what and what is still open. The wrap-up reads that, with
// the last lines of the call, instead of the whole transcript. Open questions, open promises and uncovered agenda items come from the memory in code,
// so they are in the summary even when the model forgets them. The follow-up email goes through the same guards as before, plus the digit guard.
const WRAP_TAIL_LINES = 40;
const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[\s.,!?;:"'()-]+/g, " ")
    .trim();
const addUnique = (list: string[], item: string, max: number): string[] => {
  const n = norm(item);
  if (!n || list.some((x) => norm(x) === n || norm(x).includes(n) || n.includes(norm(x)))) return list;
  return list.length >= max ? list : [...list, item];
};
const isMe = (who: string) => /^(me|i|אני|אני\.)$/i.test(who.trim()) || isMeLabel(who);

/** What the memory alone says: decisions, next steps (open promises) and open questions (open questions and agenda items not covered). Code, no model. */
export function memoryOpenLoops(mem: SessionMemory, lang: CallLang): Pick<Fields, "decisions" | "nextSteps" | "openQuestions"> {
  const decisions = mem.decisions.map((d) => d.text);
  const nextSteps: NextStep[] = mem.commitments
    .filter((c) => c.status === "open")
    .map((c) => ({ who: isMe(c.who) ? ME_LABEL : c.who, what: c.what, ...(c.due ? { when: c.due } : {}) }));
  const label = lang === "en" ? "Not covered in the call" : "לא כוסה בשיחה";
  const openQuestions = [
    ...mem.openQuestions.filter((q) => q.status === "open").map((q) => q.text),
    ...mem.objections.filter((o) => !o.handled).map((o) => o.text),
    ...mem.mustCover.filter((m) => !m.done).map((m) => `${label}: ${m.text}`),
  ];
  return { decisions, nextSteps, openQuestions };
}

/** Summary fields from the memory with no model call (the model is down, capped or too slow). The email is a short template made of memory items. */
export function localWrapFields(mem: SessionMemory, lang: CallLang): Fields {
  const loops = memoryOpenLoops(mem, lang);
  const sentences = mem.summary
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
  let bullets = sentences.slice(0, 5);
  if (!bullets.length) bullets = [mem.topic.now, ...mem.facts.filter((f) => f.src === "call").map((f) => f.text)].filter(Boolean).slice(0, 4);
  const en = lang === "en";
  const lines = [
    en ? "Hi," : "שלום,",
    "",
    en ? "Thank you for the call. A short recap:" : "תודה על השיחה. סיכום קצר:",
    ...bullets.slice(0, 3).map((b) => `- ${b}`),
    ...(loops.decisions.length ? ["", en ? "Agreed:" : "הוסכם:", ...loops.decisions.slice(0, 4).map((d) => `- ${d}`)] : []),
    ...(loops.nextSteps.length
      ? [
          "",
          en ? "Next steps:" : "הצעדים הבאים:",
          ...loops.nextSteps.slice(0, 5).map((n) => `- ${n.who === ME_LABEL ? (en ? "Me" : ME_LABEL) : n.who}: ${n.what}`),
        ]
      : []),
    ...(loops.openQuestions.length ? ["", en ? "Still open:" : "עוד פתוח:", ...loops.openQuestions.slice(0, 4).map((q) => `- ${q}`)] : []),
    "",
    en ? "Best regards" : "בברכה",
  ];
  return {
    summary: bullets,
    decisions: loops.decisions.slice(0, 12),
    nextSteps: loops.nextSteps.slice(0, 12),
    openQuestions: loops.openQuestions.slice(0, 12),
    followUpEmail: bullets.length || loops.nextSteps.length ? lines.join("\n") : "",
  };
}

/** Model fields plus the memory's open loops. The memory items are added by code, without duplicates. */
export function mergeWrapFields(model: Fields | undefined, mem: SessionMemory, lang: CallLang): Fields {
  const base = model ?? localWrapFields(mem, lang);
  const loops = memoryOpenLoops(mem, lang);
  let decisions = base.decisions,
    openQuestions = base.openQuestions;
  for (const d of loops.decisions) decisions = addUnique(decisions, d, 12);
  for (const q of loops.openQuestions) openQuestions = addUnique(openQuestions, q, 12);
  const nextSteps = [...base.nextSteps];
  for (const n of loops.nextSteps)
    if (
      nextSteps.length < 12 &&
      !nextSteps.some((x) => norm(x.what) === norm(n.what) || norm(x.what).includes(norm(n.what)) || norm(n.what).includes(norm(x.what)))
    )
      nextSteps.push(n);
  return { ...base, decisions, nextSteps, openQuestions };
}

export type WrapupOpts = Omit<RunOpts, "data"> & {
  mem: SessionMemory;
  /** The last lines of the call (the caller passes the whole list, only the tail is used). */
  lines: CallData["lines"];
  contextNotes?: string[];
};
const wrapBudgets: Budgets = { ...DEFAULT_BUDGETS, wrapup: { ...DEFAULT_BUDGETS.wrapup, roleInstructions: 1800 } };

/** Why the wrap-up from memory cannot run (the caller then uses the transcript summary): undefined = go. */
export function wrapupSkipReason(o: Pick<WrapupOpts, "mem" | "S" | "noAi" | "discard" | "crashed" | "force">): string | undefined {
  if (o.discard) return "discard";
  if (o.crashed) return "crashed";
  if (o.noAi) return "no-ai";
  if (isEmptyMemory(o.mem) && o.mem.ver === 0) return "no-memory";
  if (!o.force && !o.S.summary.enabled) return "disabled";
  return undefined;
}

/**
 * The post-call summary built from the call memory. One model call with the memory and the last lines (not the whole transcript). Never throws.
 * When the model is down, capped or too slow, the summary is made from the memory alone (localWrapFields), so open loops and a follow-up draft are still there.
 * Result `skipped: "no-memory"` (or discard, crashed, no-ai, disabled) means: nothing was written, use runSummary.
 */
export async function runWrapup(o: WrapupOpts): Promise<RunResult> {
  const why = wrapupSkipReason(o);
  if (why) return { ok: false, skipped: why };
  const { model, timeoutMs } = o.S.summary;
  const t0 = Date.now();
  const tail = o.lines.slice(-WRAP_TAIL_LINES);
  const memText = renderMemory(o.mem, 2400);
  const lang = callLanguage([memText, ...tail.map((l) => l.text)].join("\n"), o.S.stt.language);
  let fields: Fields | undefined;
  let usd = 0;
  let modelFailed: string | undefined;
  if (o.cost.llmState() === "capped") modelFailed = "cost-cap";
  else {
    try {
      const kind = o.mem.kind === "interview" ? "other" : o.mem.kind;
      const ctx = buildContext({
        role: "wrapup",
        roleInstructions: summarySystem(lang) + kindGuidance(kind),
        memory: o.mem,
        rawLines: tail.map((l) => ({ side: l.ch, text: l.text, ...(l.who ? { name: l.who } : {}) })),
        trigger: "The call is over. Write the JSON object now.",
        budgets: wrapBudgets,
      });
      const resolved = await o.registry.resolve(model, "wrapup");
      const abort = AbortSignal.any([o.signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]);
      let hardTimer: NodeJS.Timeout | undefined;
      const hard = new Promise<never>((_, rej) => {
        hardTimer = setTimeout(() => rej(new Error(`wrap-up timed out after ${timeoutMs} ms`)), timeoutMs + 300);
        hardTimer.unref?.();
      });
      try {
        const call = generateOnce(o.generate, {
          model: resolved,
          maxOutputTokens: 2000,
          maxRetries: 0,
          abortSignal: abort,
          providerOptions: providerOptionsFor(model, { effort: "low", thinking: false }),
          output: Output.object({ schema: fieldsSchema(lang), name: "call_summary" }),
          instructions: ctx.system.map((b) => ({ role: "system" as const, content: b.text })),
          messages: ctx.messages,
        });
        call.catch(() => {});
        const r = await Promise.race([call, hard]);
        fields = parseSummary(r.output) ?? parseSummary(r.text);
        if (!fields) modelFailed = "unusable-output";
        const c = o.cost.addLlm("wrapup", model, r.usage ?? r.totalUsage, r.providerMetadata);
        usd = c.usd;
        o.write("usage", { role: "wrapup", model, usage: r.usage ?? r.totalUsage, usd: c.usd });
      } finally {
        clearTimeout(hardTimer);
      }
    } catch (e) {
      if (o.signal?.aborted) return { ok: false, skipped: "user" };
      modelFailed = String((e as Error)?.message ?? e).slice(0, 200);
    }
  }
  if (o.signal?.aborted) return { ok: false, skipped: "user" };
  if (modelFailed) o.write("events", { type: "wrapup.model-failed", reason: modelFailed });
  const merged = mergeWrapFields(fields, o.mem, lang);
  const notes = o.contextNotes ?? [];
  const trusted = [...notes, memText].join("\n");
  const tailText = tail.map((l) => l.text).join("\n");
  merged.followUpEmail = fixGreeting(merged.followUpEmail, tailText + "\n" + o.mem.roster.map((p) => `${p.name} ${p.name}`).join("\n"), [
    ...notes,
    ...o.mem.roster.map((p) => p.name),
  ]);
  const g = guardEmail(merged.followUpEmail, trusted, lang, `${memText}\n${tailText}\n${notes.join("\n")}`);
  const summary: CallSummary = {
    v: 1,
    callId: o.callId,
    generatedAt: new Date().toISOString(),
    model: modelFailed ? "memory" : model,
    ...merged,
    followUpEmail: g.text,
    guard: { replaced: g.replaced, rules: g.rules },
    costUsd: usd,
    from: "memory",
    ...coachingField(o.dir),
  };
  try {
    const file = join(o.dir, "summary.json");
    writeFileSync(file, JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 300);
    o.write("events", { type: "summary.error", error: eventError(e), ms: Date.now() - t0 });
    return { ok: false, error };
  }
  o.write("events", {
    type: "summary.done",
    from: "memory",
    ms: Date.now() - t0,
    usd,
    emailGuardReplaced: g.replaced,
    openLoops: merged.openQuestions.length + merged.nextSteps.length,
  });
  return { ok: true, summary };
}
