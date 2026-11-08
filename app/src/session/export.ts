// Export of a saved call as Markdown or JSON: summary, decisions, next steps, open questions, coaching numbers and the follow-up message.
// Everything is read from the call folder (summary.json, session.json, transcript.jsonl, call.json). No model call, no network.
// The follow-up message goes through the same sentence guard as the summary email (a price, a date or a promise becomes a placeholder).
// A `mailto:` link is BUILT as text so the user can open it in their own mail app. Nothing here sends anything or opens anything.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { callLanguage, type CallLang } from "../calllang.ts";
import { modeSummaryShape } from "../moments/modes.ts";
import { ME_LABEL } from "../profile.ts";
import { localWrapFields } from "../summary-wrapup.ts";
import { coachingForCall, type Coaching } from "./coaching.ts";
import { followupForCall } from "./followup.ts";
import { loadMemory } from "./store.ts";
import type { MemoryKind } from "./types.ts";

export type ExportFormat = "md" | "json";
export type ExportStep = { who: string; what: string; when?: string };
export type CallExport = {
  v: 1;
  callId: string;
  kind: MemoryKind;
  lang: CallLang;
  startedAt?: string;
  durationMin?: number;
  /** "summary" = summary.json; "memory" = no summary file, so the lists come from the call memory. */
  source: "summary" | "memory";
  topic?: string;
  summary: string[];
  decisions: string[];
  nextSteps: ExportStep[];
  openQuestions: string[];
  coaching?: Coaching;
  followUp: { text: string; mailto: string; guardReplaced: number };
};

/** Thrown when a call folder has nothing to export. */
export class ExportError extends Error {}

const MAX_ITEM = 600;
// Text from a summary file is data. Control characters and bidi overrides out, one line, capped.
const line = (x: unknown, max = MAX_ITEM): string =>
  (typeof x === "string" || typeof x === "number" ? String(x) : "")
    .replace(/[‪-‮⁦-⁩]/g, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const lines = (x: unknown, max: number): string[] =>
  Array.isArray(x)
    ? x
        .map((v) => line(v))
        .filter(Boolean)
        .slice(0, max)
    : [];

function readJson(dir: string, name: string): Record<string, unknown> | undefined {
  const f = join(dir, name);
  if (!existsSync(f)) return undefined;
  try {
    const j: unknown = JSON.parse(readFileSync(f, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const isMe = (who: string) => who === ME_LABEL || /^(me|i)$/i.test(who);
const whoLabel = (who: string, lang: CallLang) => (lang === "en" ? (isMe(who) ? "Me" : who === "לקוח" ? "Client" : who) : isMe(who) ? ME_LABEL : who);

/** A `mailto:` link with a subject and a body. Text only: it is never opened or sent here. The body is cut at a line end so the link stays short enough for mail apps. */
export function mailtoLink(subject: string, body: string, to = ""): string {
  const MAX_BODY = 1500;
  let b = body.replace(/\r\n?/g, "\n").trim();
  if (b.length > MAX_BODY) b = b.slice(0, MAX_BODY).replace(/\n[^\n]*$/, "") + "\n…";
  // ( and ) are encoded too: an open bracket in the text would end the Markdown link early.
  const enc = (s: string) =>
    encodeURIComponent(s)
      .replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"))
      .replace(/%0A/g, "%0D%0A");
  const addr = /^[^\s@<>,;:"()]+@[^\s@<>,;:"()]+$/.test(to) ? encodeURIComponent(to).replace(/%40/g, "@") : "";
  return `mailto:${addr}?subject=${enc(line(subject, 120))}&body=${enc(b)}`;
}

function durationMin(dir: string): { startedAt?: string; durationMin?: number } {
  const m = readJson(dir, "call.json");
  const s = typeof m?.startedAt === "string" ? m.startedAt : undefined;
  const e = typeof m?.endedAt === "string" ? m.endedAt : undefined;
  const a = s ? Date.parse(s) : NaN,
    b = e ? Date.parse(e) : NaN;
  return {
    ...(s && Number.isFinite(a) ? { startedAt: new Date(a).toISOString() } : {}),
    ...(Number.isFinite(a) && Number.isFinite(b) && b >= a ? { durationMin: Math.round((b - a) / 60000) } : {}),
  };
}

function savedCoaching(sum: Record<string, unknown> | undefined): Coaching | undefined {
  const c = sum?.coaching as Partial<Coaching> | undefined;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  const me = n(c?.paceWpm?.me),
    them = n(c?.paceWpm?.them);
  const a = n(c?.talkSharePct),
    b = n(c?.longestMonologueSec),
    q = n(c?.questionsAsked),
    i = n(c?.interruptions);
  if (a === undefined || b === undefined || q === undefined || i === undefined || me === undefined || them === undefined) return undefined;
  return { talkSharePct: a, longestMonologueSec: b, questionsAsked: q, paceWpm: { me, them }, interruptions: i };
}

/** The export of a call folder as data. Throws ExportError when the folder has no summary and an empty memory. */
export function buildExport(callDir: string): CallExport {
  const callId = basename(callDir);
  const mem = loadMemory(callDir).mem;
  const sum = readJson(callDir, "summary.json");
  const hasSummary = !!sum && sum.v === 1;
  let summary: string[], decisions: string[], openQuestions: string[], nextSteps: ExportStep[];
  let source: CallExport["source"];
  let lang: CallLang;
  if (hasSummary) {
    source = "summary";
    summary = lines(sum.summary, 8);
    decisions = lines(sum.decisions, 12);
    openQuestions = lines(sum.openQuestions, 12);
    nextSteps = (Array.isArray(sum.nextSteps) ? sum.nextSteps : [])
      .map((n: unknown) => {
        const o = (n && typeof n === "object" ? n : {}) as Record<string, unknown>;
        const when = line(o.when, 80);
        return { who: line(o.who, 40) || ME_LABEL, what: line(o.what), ...(when ? { when } : {}) };
      })
      .filter((n) => n.what)
      .slice(0, 12);
    lang = callLanguage([...summary, ...decisions, ...nextSteps.map((n) => n.what)].join("\n"));
  } else {
    lang = callLanguage([mem.summary, ...mem.decisions.map((d) => d.text), ...mem.commitments.map((c) => c.what)].join("\n"));
    const w = localWrapFields(mem, lang);
    source = "memory";
    summary = lines(w.summary, 8);
    decisions = lines(w.decisions, 12);
    openQuestions = lines(w.openQuestions, 12);
    nextSteps = w.nextSteps.map((n) => ({ who: line(n.who, 40), what: line(n.what), ...(n.when ? { when: line(n.when, 80) } : {}) })).filter((n) => n.what);
    if (!summary.length && !decisions.length && !openQuestions.length && !nextSteps.length)
      throw new ExportError(`Call ${callId} has nothing to export yet (no summary and an empty call memory).`);
  }
  const shape = modeSummaryShape(mem.kind);
  const fu = shape.followUp ? followupForCall(callDir, lang) : undefined;
  const text = fu?.text ?? "";
  const topic = line(mem.topic.now, 100);
  const subject = (lang === "en" ? "Follow-up" : "המשך לשיחה") + (topic ? `: ${topic}` : "");
  const coaching = savedCoaching(sum) ?? coachingForCall(callDir);
  return {
    v: 1,
    callId,
    kind: mem.kind,
    lang,
    ...durationMin(callDir),
    source,
    ...(topic ? { topic } : {}),
    summary,
    decisions,
    nextSteps: nextSteps.map((n) => ({ ...n, who: whoLabel(n.who, lang) })),
    openQuestions,
    ...(coaching ? { coaching } : {}),
    followUp: { text, mailto: text ? mailtoLink(subject, text) : "", guardReplaced: fu?.replaced ?? 0 },
  };
}

const L = {
  en: {
    call: "Call",
    follow: "Follow-up message",
    open: "Open in your email app",
    coaching: "Coaching numbers",
    share: "Your share of the talking",
    mono: "Your longest stretch without a pause for them",
    q: "Questions you asked",
    pace: "Pace (words a minute): you / them",
    inter: "Times you started while they were still talking",
    sec: "s",
    min: "min",
    placeholders: "Sentences with a price, a date or a promise were replaced by [fill in]. Complete them before you send.",
    kind: "Kind",
  },
  he: {
    call: "שיחה",
    follow: "הודעת המשך",
    open: "פתיחה באפליקציית המייל",
    coaching: "מספרי אימון",
    share: "החלק שלך בדיבור",
    mono: "הרצף הארוך ביותר שלך בלי הפסקה",
    q: "שאלות ששאלת",
    pace: "קצב (מילים בדקה): אתה / הם",
    inter: "פעמים שהתחלת לדבר כשהם עוד דיברו",
    sec: "שנ׳",
    min: "דק׳",
    placeholders: "משפטים עם מחיר, תאריך או הבטחה הוחלפו ב-[fill in]. השלימו אותם לפני השליחה.",
    kind: "סוג",
  },
} as const;

/** The export as Markdown (human) or JSON (a stable, pretty-printed object, `CallExport`). */
export function exportCall(callDir: string, format: ExportFormat): string {
  const x = buildExport(callDir);
  if (format === "json") return JSON.stringify(x, null, 2) + "\n";
  const t = L[x.lang === "en" ? "en" : "he"];
  const h = modeSummaryShape(x.kind).heading;
  const hd = (k: keyof typeof h) => h[k][x.lang === "en" ? "en" : "he"];
  const meta = [
    x.startedAt ? x.startedAt.slice(0, 16).replace("T", " ") : "",
    x.durationMin !== undefined ? `${x.durationMin} ${t.min}` : "",
    `${t.kind}: ${x.kind}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const out: string[] = [`# ${t.call} ${x.callId}`, "", meta, ""];
  const list = (title: string, items: string[]) => {
    if (items.length) out.push(`## ${title}`, ...items.map((i) => `- ${i}`), "");
  };
  list(hd("summary"), x.summary);
  list(hd("decisions"), x.decisions);
  list(
    hd("nextSteps"),
    x.nextSteps.map((n) => `**${n.who}**: ${n.what}${n.when ? ` (${n.when})` : ""}`),
  );
  list(hd("openQuestions"), x.openQuestions);
  if (x.coaching) {
    const c = x.coaching;
    list(t.coaching, [
      `${t.share}: ${c.talkSharePct}%`,
      `${t.mono}: ${c.longestMonologueSec} ${t.sec}`,
      `${t.q}: ${c.questionsAsked}`,
      `${t.pace}: ${c.paceWpm.me} / ${c.paceWpm.them}`,
      `${t.inter}: ${c.interruptions}`,
    ]);
  }
  if (x.followUp.text) {
    out.push(`## ${t.follow}`, "", ...x.followUp.text.split("\n").map((l) => (l ? `> ${l}` : ">")), "");
    if (x.followUp.guardReplaced) out.push(`_${t.placeholders}_`, "");
    out.push(`[${t.open}](${x.followUp.mailto})`, "");
  }
  return (
    out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}
