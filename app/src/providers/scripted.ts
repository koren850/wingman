// Offline test doubles for a whole call with no network and no keys (pnpm e2e, src/e2e/scripted-call.test.ts).
// Registered as STT provider "script" (providers/stt/index.ts) and LLM provider "scripted" (providers/llm.ts).
// Answers are deterministic and keyed on phrases in the real prompts, so a prompt wording change can break these doubles.
//   stt.provider: script      -> plays a transcript JSON ([{speaker: me|them, text}]) as STT finals, ignores audio.
//                                File: env WINGMAN_STT_SCRIPT; spacing: env WINGMAN_SCRIPT_GAP_MS (default 1200).
//   llm model "scripted:packgen" -> drafts bank cards from "Q: ... A: ..." blocks in the notes (wingman pack from-notes, see scriptedPackgen).
//   llm model "scripted:bank" -> a fake model: the reflex answers "BANK <id>" for the first bank card id named in
//                                the prompt's question line, STALL for prices, else SKIP; notes get one note.
import { EventEmitter } from "node:events";
import { readFileSync, appendFileSync } from "node:fs";
import { MockLanguageModelV4 } from "ai/test";
import type { SttOptions, SttProvider, SttResult, SttStreamLike } from "./stt/types.ts";
import { matchBank, loadBank } from "../bank.ts";
import { PolicyModel } from "../testkit/policy-model.ts";

// Fault injection for tests: WINGMAN_STT_FAIL=<channel>:<http status>@<ms since this process started> makes that channel fail like a real provider
// (e.g. them:401@3000 = a refused key 3 s in; later open() calls fail too) until WINGMAN_STT_HEAL_AT_MS (ms since start; default never).
const T0 = Date.now();
const FIRST_OPEN: Record<string, number> = {};
function injectedFailure(channel: string): { status: number; at: number } | undefined {
  const m = String(process.env.WINGMAN_STT_FAIL ?? "").match(/^(me|them):(\d+)@(\d+)$/);
  if (!m || m[1] !== channel) return undefined;
  const heal = Number(process.env.WINGMAN_STT_HEAL_AT_MS ?? Infinity);
  return Date.now() - T0 >= heal ? undefined : { status: Number(m[2]), at: Number(m[3]) };
}
const failError = (status: number) => Object.assign(new Error(`HTTP ${status} (injected)`), { statusCode: status });

/** Fake STT stream: replays the transcript file as final results on timers (the audio sent to it is only counted). */
class ScriptStream extends EventEmitter implements SttStreamLike {
  isOpen = false;
  audioSeconds = 0;
  dropped = 0;
  private timers: NodeJS.Timeout[] = [];
  constructor(private o: SttOptions) {
    super();
  }
  async open() {
    // Test hook: WINGMAN_STT_HANG=<channel> makes open() of that channel never answer (a dropped SYN, a captive portal): a black hole.
    if (process.env.WINGMAN_STT_HANG === this.o.channel) await new Promise<void>(() => {});
    const inj = injectedFailure(this.o.channel);
    if (inj && Date.now() - T0 >= inj.at) throw failError(inj.status);
    if (inj) {
      const t = setTimeout(
        () => {
          if (!this.isOpen) return;
          this.isOpen = false;
          for (const x of this.timers) clearTimeout(x);
          this.emit("error", failError(inj.status), { terminal: true });
        },
        inj.at - (Date.now() - T0),
      );
      this.timers.push(t);
    }
    this.isOpen = true;
    const file = process.env.WINGMAN_STT_SCRIPT;
    if (!file) throw new Error("stt.provider script needs WINGMAN_STT_SCRIPT=<transcript.json>");
    const gap = Number(process.env.WINGMAN_SCRIPT_GAP_MS ?? 1200);
    // Optional per line: afterMs = time since the previous line (a quick follow-up, e.g. a question split by a pause).
    // QA replay lines (qa/run-qa.ts --replay) also carry atMs (absolute time since start), words and speechFinal,
    // so a saved Deepgram run plays back exactly as it was heard.
    type Line = { speaker: string; text: string; afterMs?: number; atMs?: number; words?: SttResult["words"]; speechFinal?: boolean; endLagMs?: number };
    const lines = JSON.parse(readFileSync(file, "utf8")) as Line[];
    // A channel that is reopened (after an outage) continues the script where the clock is, instead of replaying it from the start.
    const firstOpen = (FIRST_OPEN[this.o.channel] ??= Date.now()),
      late = Date.now() - firstOpen;
    let at = 300;
    lines.forEach((l, i) => {
      if (Number.isFinite(l.atMs)) at = Number(l.atMs);
      else if (i > 0) at += Number.isFinite(l.afterMs) ? Number(l.afterMs) : gap;
      const when = at - late;
      if (l.speaker !== this.o.channel || when < 0) return;
      this.timers.push(
        setTimeout(() => {
          const now = Date.now();
          const r: SttResult = {
            channel: this.o.channel,
            text: l.text,
            isFinal: true,
            speechFinal: l.speechFinal ?? true,
            words: l.words ?? [],
            speechEndWall: now - (l.endLagMs ?? 300),
            arrivedAt: now,
          };
          this.emit("result", r);
        }, when),
      );
    });
  }
  send(pcm: Buffer) {
    this.audioSeconds += pcm.length / 32000;
    return true;
  }
  /** Like a real socket, it delivers its last finals while closing. Test hook: WINGMAN_SCRIPT_CLOSE_FINALS=[{speaker, text}] are emitted ~50 ms after close() starts. */
  async close() {
    this.isOpen = false;
    for (const t of this.timers) clearTimeout(t);
    const late = (() => {
      try {
        return JSON.parse(process.env.WINGMAN_SCRIPT_CLOSE_FINALS ?? "[]") as { speaker: string; text: string }[];
      } catch {
        return [];
      }
    })().filter((l) => l.speaker === this.o.channel);
    if (late.length) await new Promise((r) => setTimeout(r, 50));
    for (const l of late) {
      const now = Date.now();
      this.emit("result", {
        channel: this.o.channel,
        text: l.text,
        isFinal: true,
        speechFinal: true,
        words: [],
        speechEndWall: now - 300,
        arrivedAt: now,
      } as SttResult);
    }
    this.emit("close");
  }
}

/** The "script" STT provider. `id` is cast because SttProvider.id does not list it. */
export const script: SttProvider = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the offline test double is not a real provider id
  id: "script" as any,
  experimental: false,
  capabilities: { keyterms: false, diarize: false, interim: false, maxKeyterms: 0 },
  create: (o) => new ScriptStream(o),
  probe: async () => ({ ok: true }),
};

/** The reflex prompt ends with: The other side just said: <call_transcript>QUESTION</call_transcript>  (or, for the user's own questions: "<name> is asking you ... : <call_transcript>…") */
// Extracts the question from the reflex prompt (see the line above).
function questionOf(prompt: string): string {
  const m = prompt.match(/(?:The other side just said|The client just said|is asking you[^<]*?): <call_transcript>([\s\S]*?)<\/call_transcript>/);
  return m?.[1] ?? "";
}
/** Answers for the user's own questions (model "scripted:*" in me-mode). Invented, deterministic. */
const ME_ANSWERS: [RegExp, string][] = [
  [/בירה.*אוסטרליה|capital of australia/i, "הבירה של אוסטרליה היא קנברה."],
  [/ההבדל.*(cdn|dns)|difference/i, "CDN מפיץ עותקים של האתר לשרתים קרובים לגולש, ו-DNS רק מתרגם שם דומיין לכתובת."],
  [/מה זה dns|what is dns/i, "DNS הוא ספר הטלפונים של האינטרנט: הוא מתרגם שם דומיין לכתובת השרת."],
  [/טוקיו|tokyo|טיסה/i, "טיסה לטוקיו עם עצירה לוקחת בערך 14 עד 17 שעות."],
  [/פורטוגל|portugal/i, "הכלכלה של פורטוגל מבוססת בעיקר על שירותים ותיירות."],
  [/ווינגמן|wingman/i, "אני כאן. מה לבדוק?"],
];
function meAnswer(q: string): string {
  const hit = ME_ANSWERS.find(([re]) => re.test(q));
  return hit ? `ANS\n${hit[1]}` : "SKIP";
}
/** Audience classifier double (classifySystem in src/assist.ts): ASSIST for knowledge questions, OTHER for anything aimed at the other side. */
export function scriptedClassify(prompt: string): string {
  const said = prompt.match(/just said: <call_transcript>([\s\S]*?)<\/call_transcript>/)?.[1] ?? "";
  if (/(אתם|שלכם|לכם|אצלכם|your|you guys|תקציב|דעתך|תוכל)/i.test(said)) return "OTHER";
  if (/(בירה|הבדל|difference|capital|dns|cdn|טוקיו|טיסה|תרגם|מה זה|מה זאת)/i.test(said)) return "ASSIST";
  return "NEITHER";
}
// Flattens an AI SDK prompt (string or parts) into one string for the keyword matching above.
function promptText(o: { prompt?: unknown }): string {
  const prompt = (o.prompt ?? []) as { content?: string | { text?: string }[] }[];
  return prompt.map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join(""))).join("\n");
}
const bank = loadBank();
/** True when the transcript in the prompt is English: it has Latin letters and no Hebrew letters (speaker labels like "אני:" do not count). */
export function isEnglishPrompt(prompt: string): boolean {
  const at = prompt.lastIndexOf("<call_transcript>"); // the system text also names the tag, so take the LAST block: the real transcript
  if (at < 0) return false;
  const t = (prompt.slice(at + 17).split("</call_transcript>")[0] ?? "").replace(/^(?:אני|לקוח|הצד השני)(?: \([^)]*\))?:/gm, "");
  return /[a-z]/i.test(t) && !/[\u0590-\u05FF]/.test(t);
}
/** Post-call summary double: valid JSON; the email deliberately has a price sentence and a date sentence so tests can see the guards replace them. */
export const SCRIPTED_SUMMARY = {
  summary: ["הלקוחה פנתה בגלל אתר שנטען לאט", "שאלה על גיבויים לאתר", "השאירה טלפון ומייל לחזרה"],
  decisions: ["בודקים את מהירות האתר"],
  nextSteps: [
    { who: "אני", what: "לבדוק את סיבת האיטיות" },
    { who: "לקוח", what: "לשלוח גישה לאתר", when: "השבוע" },
  ],
  openQuestions: ["כמה תעלה החבילה המלאה"],
  followUpEmail: 'שלום דנה,\nתודה על השיחה. דיברנו על מהירות האתר והגיבויים.\nהחבילה עולה 500 ש"ח לחודש.\nנחזור אליך עד יום שני.\nבברכה',
};
/** The same summary for an English transcript (demo-call.en.json). */
export const SCRIPTED_SUMMARY_EN = {
  summary: ["The client called because her site loads slowly", "She asked about backups for the site", "She left a phone number and an email for the reply"],
  decisions: ["Check the speed of the site"],
  nextSteps: [
    { who: "אני", what: "Find out why the site is slow" },
    { who: "לקוח", what: "Send access to the site", when: "this week" },
  ],
  openQuestions: ["How much the full package costs"],
  followUpEmail:
    "Hi Dana,\nThanks for the call. We talked about the speed of the site and backups.\nThe package costs $500 per month.\nWe will get back to you by Monday.\nBest regards",
};
/** Call-frame double (model "scripted:frame"): an invented client call; checklist items tick off when their keyword is in the transcript. */
const FRAME_ITEMS: [string, RegExp, boolean][] = [
  ["להבין למה האתר איטי", /איטי|לאט/, true],
  ["לשאול על גיבויים", /גיבוי/, true],
  ["לקבל טלפון ומייל לחזרה", /טלפון|מייל|dana@/i, true],
  ["לבדוק אם יש חנות WooCommerce", /ווקומרס|woocommerce/i, false],
  ["להסכים על הצעד הבא", /הצעה|נחזור|נדבר/, false],
];
const FRAME_ITEMS_EN: [string, RegExp, boolean][] = [
  ["Find out why the site is slow", /slow/i, true],
  ["Ask about backups", /backup/i, true],
  ["Get a phone number and email for the reply", /number is|zero five|dana at|@/i, true],
  ["Check if there is a WooCommerce shop", /woocommerce/i, false],
  ["Agree on the next step", /quote|get back|talk soon/i, false],
];
// The "must" flag marks must-cover checklist items.
export function scriptedFrame(prompt: string): string {
  const said = prompt.slice(prompt.indexOf("<call_transcript>"));
  if (isEnglishPrompt(prompt))
    return JSON.stringify({
      kind: "client",
      topic: "Slow site and backups",
      goal: "Understand the problem and offer a check",
      people: [{ who: "Dana", role: "client" }],
      entities: ["WooCommerce"],
      checklist: FRAME_ITEMS_EN.map(([item, re, must]) => ({ item, done: re.test(said), must })),
    });
  return JSON.stringify({
    kind: "client",
    topic: "אתר איטי וגיבויים",
    goal: "להבין את הבעיה ולהציע בדיקה",
    people: [{ who: "דנה", role: "לקוחה" }],
    entities: ["WooCommerce"],
    checklist: FRAME_ITEMS.map(([item, re, must]) => ({ item, done: re.test(said), must })),
  });
}
/** Live-tip double (model "scripted:tips"): one tip once backups come up, NONE otherwise. */
export function scriptedTip(prompt: string): string {
  const said = prompt.slice(prompt.indexOf("<call_transcript>"));
  if (isEnglishPrompt(prompt))
    return /backup/i.test(said) && !/Tips already given[^]*backups are stored/.test(prompt)
      ? JSON.stringify({ type: "ask", text: "Ask where the backups are stored today and who is responsible for them." })
      : "NONE";
  return /גיבוי/.test(said) && !/Tips already given[^]*גיבויים נשמרים/.test(prompt)
    ? JSON.stringify({ type: "ask", text: "כדאי לשאול איפה הגיבויים נשמרים היום ומי אחראי עליהם." })
    : "NONE";
}
/**
 * Card-drafting double (model "scripted:packgen", `wingman pack from-notes`): the notes are blocks separated by a blank line, each
 *   Q: <question>  A: <answer>  [EN: <English answer>]  [FLAG: price|date|promise]     (Hebrew labels ש: / ת: work too).
 * Each block becomes one card whose triggers are the question's words, so the draft step can be tested without a model.
 */
export function scriptedPackgen(prompt: string): string {
  const at = prompt.lastIndexOf("<notes>");
  const notes = prompt.slice(at + 7).split("</notes>")[0] ?? "";
  const cards = notes
    .split(/\n\s*\n/)
    .map((block) => {
      const f = (re: RegExp) => block.match(re)?.[1]?.trim();
      const q = f(/^(?:Q|ש):\s*(.+)$/m),
        a = f(/^(?:A|ת):\s*(.+)$/m);
      if (!q || !a) return undefined;
      const en = f(/^EN:\s*(.+)$/m);
      const flag = f(/^FLAG:\s*(\w+)$/m);
      const id = q
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 24);
      return {
        id,
        title: q.slice(0, 40),
        triggers: [q.replace(/[?؟]$/, ""), ...q.split(/\s+/).filter((w) => w.length > 3)].slice(0, 6),
        say: a,
        facts: [q.slice(0, 30)],
        ...(flag ? { sensitive: flag } : {}),
        ...(en ? { en: { say: en } } : {}),
      };
    })
    .filter(Boolean);
  return JSON.stringify({ cards });
}
/**
 * The keyword-lookup fake model of the first version: picks the reply by which system-prompt phrase the prompt contains; the first match wins.
 * It decides by itself, which is why new tests use the policy fake (src/testkit/policy-model.ts) instead. Kept until the v2 engine is in.
 */
export function legacyScripted(prompt: string): string {
  if (prompt.includes("You draft answer cards")) return scriptedPackgen(prompt);
  if (prompt.includes("You build the call frame")) return scriptedFrame(prompt);
  if (prompt.includes("You write at most one live tip")) return scriptedTip(prompt);
  if (prompt.includes("write the post-call summary")) return JSON.stringify(isEnglishPrompt(prompt) ? SCRIPTED_SUMMARY_EN : SCRIPTED_SUMMARY);
  if (prompt.includes("You keep short live notes")) return isEnglishPrompt(prompt) ? "- The client wants a faster site" : "- הלקוחה רוצה אתר מהיר יותר";
  if (/You decide who .{1,60} is talking to/.test(prompt)) return scriptedClassify(prompt);
  const q = questionOf(prompt);
  if (prompt.includes("is asking you (the assistant) directly")) return meAnswer(q);
  if (/כמה (זה )?עולה|מחיר/.test(q)) return "STALL";
  const hit = matchBank(q, bank);
  return hit ? `BANK ${hit.card.id}` : "SKIP";
}
/** Old name of legacyScripted, kept as the same function so existing imports keep working. */
export const scriptedAnswer = legacyScripted;
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const finish = { unified: "stop" as const, raw: "end_turn" };

/** Factory used by ModelRegistry (spec.factory): returns modelId -> a mock model. Streaming sends the whole answer as one delta. */
// Fault injection for tests: WINGMAN_LLM_FAIL=<n>:<http status | net> makes the first n reflex calls (questions from the other side) fail like a real provider.
let llmFailsLeft = Number(String(process.env.WINGMAN_LLM_FAIL ?? "").split(":")[0]) || 0;
const llmFailKind = String(process.env.WINGMAN_LLM_FAIL ?? "").split(":")[1] ?? ""; // an HTTP status, or "net" = a dropped connection
const llmFailStatus = Number(llmFailKind) || 401;
// Model "scripted:policy" serves a policy file (env WINGMAN_POLICY_FILE, written by PolicyModel.toJSON()), so a child-process engine test can use the
// policy fake. One PolicyModel per process: rule counters (times, nth) and the call log are shared by all calls.
let policyShared: PolicyModel | undefined;
function policyFromEnv(): PolicyModel {
  if (policyShared) return policyShared;
  const f = process.env.WINGMAN_POLICY_FILE;
  if (!f) throw new Error("model scripted:policy needs WINGMAN_POLICY_FILE=<policy.json> (see src/testkit/policy-model.ts)");
  // WINGMAN_POLICY_LOG=<file>: one JSON line per call (role, last line, which rule served it), for tests that read what the engine asked.
  const log = process.env.WINGMAN_POLICY_LOG;
  policyShared = PolicyModel.fromJSON(JSON.parse(readFileSync(f, "utf8")), {
    onCall: log
      ? (c) =>
          appendFileSync(
            log,
            JSON.stringify({ role: c.view.role, model: c.view.model, lastLine: c.view.lastLine, rule: c.rule, tokens: c.view.tokens, at: c.at }) + "\n",
          )
      : undefined,
  });
  return policyShared;
}
export function createScripted() {
  return (modelId: string) =>
    modelId === "policy"
      ? policyFromEnv().model
      : new MockLanguageModelV4({
          provider: "scripted",
          modelId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the mock model's result types are stricter than the scripted reply needs
          doGenerate: async (o) => ({ content: [{ type: "text", text: legacyScripted(promptText(o)) }], finishReason: finish, usage, warnings: [] }) as any,
          doStream: async (o) => {
            const text = legacyScripted(promptText(o));
            if (llmFailsLeft > 0 && questionOf(promptText(o))) {
              llmFailsLeft--;
              if (llmFailKind === "net") throw Object.assign(new Error("fetch failed (injected)"), { code: "ECONNRESET" });
              throw Object.assign(new Error(`HTTP ${llmFailStatus} (injected)`), { statusCode: llmFailStatus });
            }
            const parts = [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: text },
              { type: "text-end", id: "t" },
              { type: "finish", usage, finishReason: finish },
            ];
            return {
              stream: new ReadableStream({
                start(c) {
                  for (const p of parts) c.enqueue(p);
                  c.close();
                },
              }),
            } as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- as above: the scripted stream parts are plain objects
          },
        });
}
