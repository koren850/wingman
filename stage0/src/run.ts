// Wingman Stage 0: live (system audio + mic) or --file <stereo.wav> (L = me, R = them).
//   pnpm start                 live call (press Enter once consent is confirmed; audio is not sent to the cloud before that)
//   pnpm start --file x.wav    replay a recording in real time
//   pnpm start --no-ai         bank only (no Haiku)
//   pnpm start --discard       delete the call folder when the call ends
//   Keys while running: Enter = consent confirmed (start sending audio) · q = quiet on/off (cards logged, not shown)
//                       n = type a context note for the AI ("this is about the shop migration"), Enter to add · Ctrl+C = stop
//   WINGMAN_CONTROL=1         remote control for the menu-bar app: line commands on stdin (consent, quiet, client, ask, note <text>, stop)
//                             and "@@wingman {json}" status lines on stdout. Consent is still required (no auto-start).
import { readFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { KEY_ENV_VARS } from "./keychain.ts";
import { requireKeys, childEnv, DATA, CALLS, ROOT } from "./env.ts";
import { EntitySpotter, loadSnapshot, type Fact } from "./entities.ts";
import { takeNotes } from "./notes.ts";
import { loadBrief, briefNotes, covered, type Brief } from "./brief.ts";
import { loadBank, matchBank, matchBankFor, priceOffTopic, stallCard, stallSay, modelMayOverrideBank, STALL_TIER, type BankCard } from "./bank.ts";
import { evalMath, looksArithmetic } from "./calc.ts";
import { checkScript } from "./lang.ts";
import { callAppRunning } from "./callapp.ts";
import { audienceByCues, classify, decideAudience, MeGate, guardMe } from "./assist.ts";
import { detect } from "./detector.ts";
import { guard, sanitize } from "./guards.ts";
import { buildPrefix, runReflex, resolveBankId, type Tag } from "./reflex.ts";
import type { SttResult, Channel, Word } from "./providers/stt/types.ts";
import { SttChannel } from "./providers/stt/channel.ts";
import { getSttProvider, sttChain, loadKeyterms } from "./providers/stt/index.ts";
import { ModelRegistry, parseModelRef, ConfigError } from "./providers/llm.ts";
import { describe, type ProviderError } from "./providers/errors.ts";
import { SystemSource, MicSource, FileSource, peakOf } from "./audio.ts";
import { CallLog } from "./log.ts";
import { loadSettingsOrExit, expandHome } from "./settings.ts";
import { CostMeter } from "./cost.ts";
import { EchoFilter, MicGate } from "./echo.ts";
import { extract } from "./capture.ts";
import { HealthSupervisor, CircuitBreaker, describeRung, type Rung } from "./health.ts";
import { joinSplit, isBareQuestionTail, type PrevUtterance } from "./split.ts";
import { splitMergedQuestions } from "./multiq.ts";
import { readAudioDevices, bluetoothInUse } from "./devices.ts";
import { runSummary, formatShort } from "./summary.ts";
import { FrameTracker, runFrame, frameText, isAgencyKind, isAgencyTopic, progress, missedMust, KIND_HE, type Frame } from "./frame.ts";
import { TipGate, runTip, checkTip, talkRatio, talkTip, wrapUpTip, type Tip, type TimedLine } from "./tips.ts";
import { loadAttachments, backgroundBlock } from "./attachments.ts";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const { settings: S, profile } = loadSettingsOrExit(args);
const fileArg = S.run.file ?? undefined;
const noAi = S.run.noAi;
const discard = S.run.discard;
const REFLEX_MODELS = [S.llm.reflex.model, ...S.llm.reflex.fallbacks];
const keyFile = expandHome(S.keys.file);
const NO_KEY = new Set(["script", "scripted"]);   // offline test doubles
const keys = requireKeys([...new Set([S.stt.provider, ...(noAi ? [] : [parseModelRef(S.llm.reflex.model).provider as any, ...(S.summary.enabled ? [parseModelRef(S.summary.model).provider as any] : [])])])].filter((k) => !NO_KEY.has(k)), keyFile);
for (const v of KEY_ENV_VARS) delete process.env[v];   // keys now live in `keys` (memory) only: no child of this process (audiotee, ffmpeg...) inherits them
const registry = new ModelRegistry(keys);

/** S2: consent line. Names the cloud processing and the AI assistant, and offers an opt-out (settings privacy.consentText). */
export const CONSENT_SAY = S.privacy.consentText;
const CONTROL = process.env.WINGMAN_CONTROL === "1";
/** Status line for the menu-bar app (only in control mode). */
function status(ev: string, data: Record<string, unknown> = {}) {
  if (CONTROL) process.stdout.write(`\n@@wingman ${JSON.stringify({ ev, ...data })}\n`);
}

const bank = loadBank();
const stall = stallCard(bank);
const houseStyle = readFileSync(join(DATA, "house-style.md"), "utf8");
const keyterms = loadKeyterms(S);
// Background files from "Plan a call": read once (and deleted: one plan = one call). A replay / --no-brief never uses them.
const briefArg = args.includes("--brief") ? args[args.indexOf("--brief") + 1] : undefined;
const noBrief = args.includes("--no-brief") || (!!fileArg && !briefArg);
const attachFiles = noAi || noBrief ? [] : loadAttachments(S.attachments.maxChars);
const background = backgroundBlock(attachFiles);
const prefix = buildPrefix(houseStyle, bank, "", background);
let log: CallLog;
try { log = new CallLog({ mode: fileArg ? "file" : "live", file: fileArg, model: S.llm.reflex.model, fallbacks: S.llm.reflex.fallbacks, stt: `${S.stt.provider} ${S.stt.model} ${S.stt.language}`, sttFallback: S.stt.fallback, profile, noAi, discard });
} catch (e) {
  console.error(`Wingman cannot save this call: cannot create the calls folder (${(e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message}). Check free disk space and the folder permissions: ${CALLS}`);
  process.exit(2);
}
log.onWriteFail = (e) => { try { health("disk", "amber", "לא ניתן לשמור את השיחה בדיסק (אין מקום?). השיחה ממשיכה, אבל ההקלטה והסיכום עלולים להיות חלקיים", String(e?.message ?? e)); } catch {} };
const cost = new CostMeter(S.budget.prices, S.budget);
const sup = new HealthSupervisor({ tickMs: S.health.tickMs, recoverStableMs: S.health.recoverStableMs, slowMs: S.llm.reflex.slowMs, slowSttMs: S.health.slowSttMs, minSamples: S.health.minSamples });
sup.set({ noAi, bankFailed: bank.length === 0 });
const breakers = new Map(REFLEX_MODELS.map((m) => [m, new CircuitBreaker({ failures: S.llm.circuit.failures, windowMs: 10_000, cooldownMs: S.llm.circuit.cooldownMs })]));
const downUntil = new Map<string, number>();   // spend cap: no retries for the rest of the day

type Badge = "bank" | "ai" | "stall" | "info" | "warn" | "tip" | "me";
type Card = {
  tipType?: string;
  id: string; turnId: string; badge: Badge; question: string; say: string; facts: string[]; dim?: boolean; at: number;
  health?: boolean; level?: "red" | "amber" | "info"; clear?: boolean; withdraw?: boolean;
  forMe?: boolean; source?: "calc" | "ai";   // badge "me": an answer for Dan himself (his own question). source "calc" on an "ai" card: local arithmetic, no model
  priority?: boolean;   // "don't commit yet" bank cards (stall-price, stall-guarantee…): never hidden by the per-minute cap
};
const transcript: (TimedLine & { ch: Channel })[] = [];
const contextNotes: string[] = [];
// Prepared start: a brief saved by `pnpm brief` (last 6 h), or --brief <file>; --no-brief skips it.
// A replay (--file) never consumes latest.yaml; it uses a brief only when --brief is given.
const brief: Brief | undefined = noBrief ? undefined : loadBrief(briefArg);
if (brief) contextNotes.push(...briefNotes(brief));
// Fact cards from the local client/domain snapshot.
const snapshot = S.facts.enabled ? loadSnapshot(join(ROOT, S.facts.file)) : undefined;
const spotter = snapshot ? new EntitySpotter(snapshot, { sslWarnDays: S.facts.sslWarnDays, minAliasLen: S.facts.minAliasLen }) : undefined;
const factsShown = new Set<string>();
let clientChosen = !!brief?.who, proposed: Fact | undefined;
function emitSide(row: Record<string, unknown>) {
  log.write("cards", { type: "card", turnId: "side", question: "", at: Date.now(), ...row });
}
function spotFacts(text: string) {
  if (!spotter) return;
  for (const f of spotter.spot(text, extract(text).filter((c) => c.kind === "domain").map((c) => c.value))) {
    if (factsShown.has(f.key)) continue;
    factsShown.add(f.key);
    emitSide({ id: `fact-${f.key}`, badge: "fact", say: f.title, facts: f.lines, warn: f.warn || undefined });
    console.log(`\n[🗂 fact] ${f.title}${f.lines.length ? "\n   • " + f.lines.join("\n   • ") : ""}`);
    if (S.facts.proposeClient && !clientChosen && !proposed && f.clientId !== undefined) {
      proposed = f;
      emitSide({ id: "propose-client", badge: "info", say: `נראה שזו שיחה עם ${f.title}`, facts: [CONTROL ? "לאשר בתפריט למעלה (Confirm client) = ה-AI יקבל את הפרטים" : "y בטרמינל = לאשר ולתת ל-AI את הפרטים"] });
      console.log(`\nLooks like a call with ${f.title}. Press y to confirm (adds it to the AI notes).`);
      status("propose", { title: f.title });
    }
  }
}
function confirmClient() {
  if (!proposed || clientChosen) return;
  clientChosen = true;
  contextNotes.push(`Client on this call: ${proposed.title}. ${proposed.lines.join("; ")}`.slice(0, 400));
  log.write("events", { type: "client.confirmed", key: proposed.key });
  emitSide({ id: "propose-client", badge: "info", say: `✓ ${proposed.title}`, facts: [] });
  console.log(`\n✓ client confirmed: ${proposed.title}`);
  status("client", { title: proposed.title });
}
// Live notes: key things said, every notes.everyMs.
const liveNotes: string[] = [];
const notesOn = S.notes.enabled && !noAi;
const notesAbort = new AbortController();   // aborted in shutdown(): no notes call outlives the call
let notesLines: string[] = [], notesBusy = false;
async function notesRound() {
  if (!notesOn || notesBusy || !consented || shuttingDown || !sup.caps.llm || cost.llmState() === "capped") return;
  const words = notesLines.join(" ").split(/\s+/).length;
  if (words < S.notes.minNewWords) return;
  const lines = notesLines; notesLines = []; notesBusy = true;
  try {
    const r = await takeNotes({ registry, model: S.notes.model, existing: liveNotes, lines, signal: notesAbort.signal, timeoutMs: S.notes.timeoutMs });
    if (shuttingDown) return;
    const c = cost.addLlm("notes", S.notes.model, r.usage, r.providerMetadata);
    log.write("usage", { role: "notes", model: S.notes.model, usage: r.usage, usd: c.usd });
    for (const n of r.notes) {
      liveNotes.push(n);
      emitSide({ id: `note-${liveNotes.length}`, badge: "note", say: n, facts: [] });
      console.log(`\n[📝 note] ${n}`);
    }
  } catch (e) { log.write("events", { type: "notes.error", error: String((e as Error)?.message ?? e) }); }
  finally { notesBusy = false; }
}
// Must-cover reminders from the brief.
const callStart = Date.now();
let lastReminderAt = 0, reminderSeq = 0;
const allText = () => transcript.map((l) => l.text).join(" ");
function uncovered(): string[] { return (brief?.mustCover ?? []).filter((i) => !covered(i, allText())); }
function reminderTick() {
  if (!S.reminders.enabled || !brief?.mustCover?.length || !consented || shuttingDown) return;
  const min = (Date.now() - callStart) / 60000;
  if (min < S.reminders.firstAfterMin || Date.now() - lastReminderAt < S.reminders.everyMin * 60000) return;
  const left = uncovered();
  if (!left.length) return;
  lastReminderAt = Date.now();
  emitSide({ id: `reminder-${++reminderSeq}`, badge: "reminder", say: "עוד לא דיברתם על:", facts: left });
  console.log(`\n[⏰ reminder] not covered yet: ${left.join(", ")}`);
}
// ---- Call frame (what is this call about?) and live tips ----
const frameOn = S.frame.enabled && !noAi, tipsOn = S.tips.enabled && !noAi;
const tracker = new FrameTracker();
const tipGate = new TipGate({ minGapMs: S.tips.minGapMs, afterAnswerMs: S.tips.afterAnswerMs });
const tipsGiven: string[] = [];
let frameBusy: Promise<void> | undefined, lastFrameAt = 0, frameWords = 0, tipSeq = 0, tipBusy = false, lastTipTryAt = 0, tipWords = 0, wrapNudged = false, lastTalkTipAt = 0;
const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;
/** The last `minutes` of the call as "me: …/them: …" lines, newest at the end, at most ~6000 characters. */
function recentTranscript(minutes: number, maxLines = 80): string {
  const now = Date.now();
  const t = transcript.filter((l) => now - l.at <= minutes * 60_000).slice(-maxLines).map((l) => `${l.ch}: ${l.text}`).join("\n");
  return t.length > 6000 ? t.slice(-6000) : t;
}
const framePct = (f: Frame) => { const p = progress(f); return `${p.done}/${p.total}`; };
function frameRound(final = false): Promise<void> {
  if (frameBusy) return frameBusy;
  if (!frameOn || !consented || (!final && shuttingDown) || !sup.caps.llm || cost.llmState() === "capped") return Promise.resolve();
  const now = Date.now();
  // The very first frame comes early (half the usual words, no waiting): the first question of a call should already know what the call is about.
  const need = final ? 8 : tracker.current ? S.frame.minNewWords : Math.min(S.frame.minNewWords, 20);
  if (frameWords < need || (!final && tracker.current && now - lastFrameAt < S.frame.everyMs)) return Promise.resolve();
  lastFrameAt = now; frameWords = 0;
  const run = (async () => {
    try {
      const r = await runFrame({ registry, model: S.frame.model, cache: S.llm.reflex.cache, transcript: recentTranscript(S.frame.windowMin), contextNotes, background, current: tracker.current, signal: new AbortController().signal, timeoutMs: S.frame.timeoutMs });
      const c = cost.addLlm("frame", S.frame.model, r.usage, r.providerMetadata);
      log.write("usage", { role: "frame", model: S.frame.model, usage: r.usage, usd: c.usd });
      const { frame, changed } = tracker.apply(r.frame);
      if (!changed) return;
      log.write("events", { type: "frame", frame });
      log.write("cards", { type: "frame", frame, at: Date.now() });
      console.log(`\n[🧭 call] ${KIND_HE[frame.kind]} · ${frame.topic || "?"} · ${framePct(frame)}`);
    } catch (e) { log.write("events", { type: "frame.error", error: String((e as Error)?.message ?? e).slice(0, 200) }); }
    finally { frameBusy = undefined; }
  })();
  frameBusy = run;
  return run;
}

/** One tip card. Guards (price / date / promise) and the repeat check run here, for every source. */
function emitTip(tip: Tip, source: "ai" | "talk" | "wrapup"): boolean {
  const chk = checkTip(tip, tipsGiven);
  if (!chk.ok) { log.write("events", { type: "tip.dropped", source, why: chk.why, rule: chk.rule }); return false; }
  tipsGiven.push(tip.text); tipGate.noteTip(Date.now());
  emitCard({ id: `tip-${++tipSeq}`, turnId: "tips", badge: "tip", tipType: tip.type, question: "", say: tip.text, facts: [], at: Date.now() });
  log.write("events", { type: "tip", source, tipType: tip.type });
  return true;
}
async function aiTip() {
  const now = Date.now();
  if (tipBusy || (frameOn && !tracker.current) || tipWords < 30 || now - lastTipTryAt < Math.max(30_000, S.tips.minGapMs / 2) || !sup.caps.llm || cost.llmState() === "capped") return;
  tipBusy = true; lastTipTryAt = now; tipWords = 0;
  try {
    const r = await runTip({ registry, model: S.tips.model, cache: S.llm.reflex.cache, frame: tracker.current, transcript: recentTranscript(S.frame.windowMin), contextNotes, background, factLines: liveNotes.slice(-6), given: tipsGiven.slice(-6), elapsedMin: (now - callStart) / 60000, signal: notesAbort.signal, timeoutMs: S.tips.timeoutMs });
    const c = cost.addLlm("tips", S.tips.model, r.usage, r.providerMetadata);
    log.write("usage", { role: "tips", model: S.tips.model, usage: r.usage, usd: c.usd });
    // An answer card may have appeared while the model was thinking.
    if (shuttingDown || !r.tip || !tipGate.can(Date.now(), { quiet })) { if (!r.tip) log.write("events", { type: "tip.none" }); return; }
    emitTip(r.tip, "ai");
  } catch (e) { log.write("events", { type: "tip.error", error: String((e as Error)?.message ?? e).slice(0, 200) }); }
  finally { tipBusy = false; }
}
function tipsTick() {
  if (!tipsOn || !consented || shuttingDown || quiet) return;
  const now = Date.now();
  const latest = transcript.filter((l) => now - l.at < 20_000).map((l) => l.text).join(" ");
  const wrap = wrapUpTip(tracker.current, { latestText: latest, elapsedMin: (now - callStart) / 60_000, wrapUpAfterMin: S.tips.wrapUpAfterMin, alreadyNudged: wrapNudged });
  if (wrap && tipGate.can(now, { quiet, ignoreGap: true })) { wrapNudged = true; emitTip(wrap, "wrapup"); return; }
  if (!tipGate.can(now, { quiet })) return;
  if (S.tips.talkRatio && now - lastTalkTipAt > 10 * 60_000) {
    const t = talkTip(talkRatio(transcript, now));
    if (t) { lastTalkTipAt = now; emitTip(t, "talk"); return; }
  }
  void aiTip();
}
// Speakers mode (PLAN §0.4): mic gate + echo text filter.
const ECHO = S.audio.echo;
const useGate = ECHO.mode === "gate" || ECHO.mode === "both";
const useFilter = ECHO.mode === "filter" || ECHO.mode === "both";
const gate = new MicGate({ hangoverMs: ECHO.gateHangoverMs, peak: ECHO.gatePeak });
const echo = new EchoFilter({ windowMs: ECHO.filterWindowMs, threshold: ECHO.filterThreshold });
let gatedMs = 0, echoDropped = 0;
/** Mic audio passes through the gate: while the client is voiced, the mic sends silence (keeps the stream timing). */
function gateMic(b: Buffer): Buffer {
  if (!useGate || !gate.closed()) return b;
  gatedMs += (b.length / 32000) * 1000;
  return Buffer.alloc(b.length);
}
// Capture box: phones, emails, domains. The last two finals per channel are joined so a number split across finals is found.
const lastFinals: Partial<Record<Channel, string[]>> = {};
const captured = new Set<string>();
function capture(ch: Channel, text: string) {
  if (!S.capture.enabled) return;
  const lf = (lastFinals[ch] ??= []); lf.push(text); if (lf.length > 2) lf.shift();
  for (const c of extract(lf.join(" "))) {
    const k = `${c.kind}:${c.value}`;
    if (captured.has(k)) continue;
    captured.add(k);
    log.write("cards", { type: "capture", ch, ...c });
    console.log(`\n[📋 ${c.kind}] ${c.value}`);
  }
}
let lastCardAt = 0, lastMeVoiced = 0, turnSeq = 0;
// ---- Answers for Dan's own questions (assist.*) ----
const meGate = new MeGate({ minGapMs: S.assist.minGapMs, maxPerMin: S.assist.maxPerMin, protectThemMs: S.assist.protectThemMs });
let lastThemSpeech = 0, meLat: { total: number; source: string }[] = [];
let lastThemCardAt = 0, lastThemSound = Date.now(), themSoundSeen = false, lastThemText = Date.now(), askUntil = 0, askTimer: NodeJS.Timeout | undefined, meSeq = 0, meShown = 0, foreignDropped = 0;
let meCurrent: AbortController | undefined;
let themHeard: () => void = () => {};   // clears the "I only hear you" banner when the other side's audio or text returns
const meTimers2 = new Set<NodeJS.Timeout>();
let current: AbortController | undefined;
let quiet = S.cards.quiet, consented = false, shuttingDown = false;   // set by startForwarding() (at once when no consent click is needed)
const decided = new Map<string, { hidden: boolean; reason?: string }>(); // card id -> was it hidden from the overlay
let shownTimes: number[] = [];
const turnsWithCard = new Set<string>();

function emitCard(c: Card) {
  c.say = sanitize(c.say); c.facts = c.facts.map(sanitize);
  const special = c.health || c.badge === "info" || c.badge === "tip";
  const forMe = c.badge === "me";   // answers to Dan's own questions: hidden in quiet mode, but never counted against (or hidden by) the per-minute cap of cards for the other side
  let hidden = false, reason: string | undefined;
  if (!special) {
    const prev = decided.get(c.id);
    if (prev) { hidden = prev.hidden; reason = prev.reason; }
    else {
      const now = Date.now();
      shownTimes = shownTimes.filter((t) => now - t < S.cards.windowMs);
      if (quiet) { hidden = true; reason = "quiet"; }
      else if (forMe) { /* no cap */ }
      else if (shownTimes.length >= S.cards.maxPerMinute && !c.priority) { hidden = true; reason = "cap"; }
      else shownTimes.push(now);
      decided.set(c.id, { hidden, reason });
      if (!turnsWithCard.has(c.turnId)) {
        turnsWithCard.add(c.turnId);
        if (now - lastCardAt < S.cards.lockoutMs) log.write("events", { type: "lockout_would_apply", turnId: c.turnId });
        lastCardAt = now;
      }
    }
  }
  log.write("cards", { type: "card", ...c, ...(hidden ? { hidden: true, hiddenReason: reason } : {}) });
  if (c.clear) return;
  if (!hidden && !c.withdraw && (c.badge === "bank" || c.badge === "ai" || c.badge === "stall" || forMe)) tipGate.noteAnswer(Date.now());   // no tip right after an answer card
  if (!hidden && !c.withdraw && (c.badge === "bank" || c.badge === "ai" || c.badge === "stall")) lastThemCardAt = Date.now();      // a fresh answer for the other side: answers for Dan must not push it off the screen
  const badge = { bank: "📗 bank", ai: "🤖 AI", stall: "⏸ stall", info: "ℹ️ info", warn: "⚠️ HEALTH", tip: "💡 tip", me: "🙋 for you" }[c.badge];
  console.log(`\n[${badge}${c.dim ? " · dimmed" : ""}${hidden ? ` · HIDDEN (${reason})` : ""}] ${c.say}${c.facts.length ? "\n   • " + c.facts.join("\n   • ") : ""}`);
}

/** S4: persistent health bar in the overlay. Clears when healthy. */
function health(id: string, level: "red" | "amber" | "info", text: string, note?: string) {
  console.log(`\n${level === "red" ? "🔴" : level === "amber" ? "🟠" : "ℹ️ "} ${text}`);
  status("health", { id, level, text });
  log.write("events", { type: "health", id, level, text, note });
  emitCard({ id: `health-${id}`, turnId: "health", badge: "warn", health: true, level, question: "", say: text, facts: [], at: Date.now() });
}
function healthClear(id: string) {
  log.write("events", { type: "health.clear", id });
  status("health.clear", { id });
  emitCard({ id: `health-${id}`, turnId: "health", badge: "warn", health: true, clear: true, question: "", say: "", facts: [], at: Date.now() });
}

const latRows: Record<string, number | string>[] = [];
function recordLatency(lat: Record<string, number | string>) { latRows.push(lat); log.write("latency", lat); }

/** One-line speed summary: speech end -> first card on screen, bank cards, and Haiku first tag. */
function speedSummary(): string {
  const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN; };
  const ms = (n: number) => (Number.isFinite(n) ? `${(n / 1000).toFixed(1)}s` : "-");
  const since = (k: string) => latRows.filter((l) => typeof l[k] === "number").map((l) => (l[k] as number) - (l.speechEnd as number));
  const first = latRows.map((l) => Math.min(...["bankAt", "stallAt", "cardAt"].map((k) => (typeof l[k] === "number" ? (l[k] as number) : Infinity))) - (l.speechEnd as number)).filter(Number.isFinite);
  const bank = since("bankAt"), tag = since("tagAt");
  return `Speed: ${latRows.length} questions · first card p50 ${ms(pct(first, 50))} / p95 ${ms(pct(first, 95))} · bank cards ${bank.length} (p50 ${ms(pct(bank, 50))}) · Haiku first tag p50 ${ms(pct(tag, 50))}${meLat.length ? ` · For you ${meLat.length} answers (speech end to card p50 ${ms(pct(meLat.map((m) => m.total), 50))} / p95 ${ms(pct(meLat.map((m) => m.total), 95))}${meLat.some((m) => m.source === "calc") ? `, math p50 ${ms(pct(meLat.filter((m) => m.source === "calc").map((m) => m.total), 50))}` : ""})` : ""}`;
}

let lastAgencyTopicAt = 0;
function onQuestion(r: SttResult, reason = "") {
  const turnId = `q${++turnSeq}`;
  const speechEnd = r.speechEndWall ?? r.arrivedAt;
  const lat: Record<string, number | string> = { turnId, speechEnd, finalAt: r.arrivedAt, text: r.text };
  const fresh = () => Date.now() - speechEnd < S.reflex.dropStaleMs;
  const meSpokeSince = () => lastMeVoiced > speechEnd;
  current?.abort();
  const ac = (current = new AbortController());
  // Not a client / support call (frame, after hysteresis) and the question is not about Dan's web / hosting services: Wingman never
  // speaks for Dan here. No agency bank card and no stall line, whatever the keywords say (team meeting, interview, friend, supplier).
  // A short follow-up ("יהיה מוכן?", "את הדומיין?") has no topic word of its own: it counts as agency talk for 60 s after one that did (the frame can also guess "vendor" wrongly).
  const agencyTopic = isAgencyTopic(r.text), agencyRecent = Date.now() - lastAgencyTopicAt < 60_000;
  if (agencyTopic) lastAgencyTopicAt = Date.now();
  const noAgency = !!tracker.kind && !isAgencyKind(tracker.kind) && !agencyTopic && !agencyRecent;
  const hit = noAgency ? undefined : matchBankFor(r.text, bank);   // stall-price is dropped for arithmetic and for prices that are not Dan's services
  if (noAgency && matchBank(r.text, bank)) log.write("events", { type: "agency.gated", turnId, kind: tracker.kind });
  if (!hit && !noAgency && matchBank(r.text, bank)?.card.id === "stall-price") log.write("events", { type: "stall.suppressed", turnId, why: priceOffTopic(r.text) ?? "off-topic" });
  // Arithmetic from the other side ("כמה זה 36 ועוד 42?"): the local answer, instantly, no model.
  // A price verb ("כמה זה יעלה 3 כפול 450") already makes evalMath return nothing (calc.ts hasPriceVerb), so no calc card reaches a price question.
  const math = evalMath(r.text);
  if (math && fresh()) {
    const card: Card = { id: `${turnId}-calc`, turnId, badge: "ai", source: "calc", question: r.text, say: math.say, facts: [], at: Date.now() };
    emitCard(card); lat.cardAt = Date.now(); lat.tag = "CALC";
    log.write("events", { type: "calc", turnId, expr: math.expr, result: math.result });
    recordLatency(lat); current = undefined; return;
  }
  // Not a client / support call (frame, after hysteresis): a keyword hit on the agency bank is weak (dimmed, the model may drop it),
  // except the price / timeline / guarantee stall tier, which always stays.
  const offKind = !!tracker.kind && !isAgencyKind(tracker.kind);
  const weakBank = offKind && !!hit && !STALL_TIER.has(hit.card.id) && !agencyTopic && !agencyRecent;
  const weak = (reason.startsWith("head:") && !(hit && hit.score >= 2)) || reason.startsWith("problem") || weakBank || (!tracker.kind && !!hit && !STALL_TIER.has(hit.card.id) && !agencyTopic && !agencyRecent);   // before the first call frame a topical card may belong to a call that is not a customer call: dim, and Haiku's SKIP withdraws it   // weak detection: a bank card may be a wrong card
  const bankOnly = reason.startsWith("problem");                              // D6: never an AI answer on a guessed question

  // Ladder: the rung in force for this question (it only changes between questions).
  const caps = sup.caps, usable = usableModels();
  sup.beginQuestion();
  let ended = false;
  const end = () => { if (!ended) { ended = true; sup.endQuestion(); } };
  const useAi = !noAi && !bankOnly && caps.llm && usable.length > 0;
  const allowAns = S.reflex.allowAns && caps.ans;

  let shown: Card | undefined, modelIgnored = false;
  if (hit) {
    shown = { id: `${turnId}-bank`, turnId, badge: "bank", question: r.text, say: hit.card.say, facts: hit.card.facts, dim: weak || undefined, priority: hit.card.id.startsWith("stall-") || undefined, at: Date.now() };
    emitCard(shown); lat.bankAt = Date.now(); lat.bankId = hit.card.id;
  }
  if (!useAi) {
    // Degraded (not by --no-ai): no LLM, so a question without a bank card gets the stall line, as the ladder promises.
    if (!noAi && !bankOnly && !noAgency && !shown && fresh()) { shown = { id: `${turnId}-stall`, turnId, badge: "stall", question: r.text, say: stallSay(stall, turnSeq), facts: [], at: Date.now() }; emitCard(shown); lat.stallAt = Date.now(); }
    recordLatency(lat); end(); return;
  }

  const stallId = `${turnId}-stall`;
  const stallTimer = setTimeout(() => {
    if (ac.signal.aborted) return;
    if (!shown && !noAgency && fresh()) { shown = { id: stallId, turnId, badge: "stall", question: r.text, say: stallSay(stall, turnSeq), facts: [], at: Date.now() }; emitCard(shown); lat.stallAt = Date.now(); }
  }, S.reflex.stallAfterMs);

  const ai: Card = { id: `${turnId}-ai`, turnId, badge: "ai", question: r.text, say: "", facts: [], at: 0 };
  const recent = transcript.slice(-12).map((l) => `${l.ch}: ${l.text}`).join("\n");
  lat.reqAt = Date.now();
  runReflex({
    registry, models: usable, cfg: S.llm.reflex, prefix, transcript: recent, question: r.text, context: contextNotes, signal: ac.signal,
    frame: frameText(tracker.current) || undefined, weakBank: weakBank ? hit!.card.id : undefined, noAgency,
    onFail: (model, err) => llmFailed(model, err),
    onSwitch: (from, to, err) => { log.write("events", { type: "llm.switch", turnId, from, to, kind: err.kind }); console.log(`\n↪ AI ${from} -> ${to} (${describe(err)})`); },
    h: {
      onTag(tagIn: Tag) {
        let tag = tagIn;
        if (ac.signal.aborted) return;
        lat.tagAt = Date.now(); lat.tag = tag.kind + (tag.bankId ? ` ${tag.bankId}` : "");
        sup.recordTag(Number(lat.tagAt) - Number(lat.reqAt));
        if (!modelMayOverrideBank(hit?.card.id, tag)) {
          clearTimeout(stallTimer); log.write("events", { type: "stall-tier.kept", turnId, tag: tag.kind + (tag.bankId ? ` ${tag.bankId}` : ""), bank: hit?.card.id });
          lat.tag = `${lat.tag} (ignored: ${hit?.card.id} stays)`; modelIgnored = true; return;
        }
        // Off-kind call, not about Dan's services: BANK and STALL are not for this question. The code enforces what the prompt asks.
        if (noAgency && (tag.kind === "STALL" || tag.kind === "BANK")) {
          clearTimeout(stallTimer); modelIgnored = true; lat.tag = `${lat.tag} (gated: ${tracker.kind})`;
          log.write("events", { type: "agency.gated", turnId, kind: tracker.kind, tag: tag.kind, model: true }); return;
        }
        if (tag.kind === "ANS" && !allowAns) { tag = { kind: "STALL" }; lat.tag = "STALL (ans-off)"; log.write("events", { type: "ans.suppressed", turnId, rung: sup.rung }); }
        // Off-kind call: the model prefers an answer or a stall over the weak keyword card, so that card goes away.
        if (weakBank && shown?.badge === "bank" && shown.turnId === turnId && (tag.kind === "ANS" || tag.kind === "STALL")) { emitCard({ ...shown, withdraw: true }); log.write("events", { type: "withdraw", turnId, why: "off-kind" }); shown = undefined; }
        if (tag.kind === "SKIP") {
          clearTimeout(stallTimer);
          if (weak && shown?.badge === "bank" && shown.turnId === turnId) { emitCard({ ...shown, withdraw: true }); log.write("events", { type: "withdraw", turnId, why: "haiku-skip" }); }
          return;
        }
        if (tag.kind === "STALL") {
          clearTimeout(stallTimer);
          if (!shown && !noAgency && fresh()) { shown = { ...ai, id: stallId, badge: "stall", say: stallSay(stall, turnSeq), at: Date.now() }; emitCard(shown); }
          return;
        }
        if (tag.kind === "BANK" && tag.bankId && hit?.card.id !== tag.bankId) {
          const card = resolveBankId(tag.bankId, bank);
          if (card && hit?.card.id === card.id) { clearTimeout(stallTimer); return; }   // the model bent the id of the card already on screen
          if (card && fresh()) {
            clearTimeout(stallTimer);
            if (shown?.badge === "bank") emitCard({ ...shown, withdraw: true }); // Haiku disagrees with the keyword hit
            shown = { ...ai, id: `${turnId}-bank2`, badge: "bank", say: card.say, facts: card.facts, priority: card.id.startsWith("stall-") || undefined, at: Date.now() }; emitCard(shown); lat.bankAt ??= Date.now();
          }
        }
      },
      onDiscard(why) {
        // the model contradicted its own tag (BANK/STALL/ANS, then SKIP) or answered in the wrong language: the card it made goes away
        if (ac.signal.aborted) return;
        clearTimeout(stallTimer); modelIgnored = true; lat.tag = `${lat.tag} (discarded: ${why})`;
        log.write("events", { type: "reflex.discard", turnId, why });
        if (shown && shown.turnId === turnId && !(shown.badge === "bank" && shown.id === `${turnId}-bank` && !weak)) { emitCard({ ...shown, withdraw: true }); shown = undefined; }
      },
      onSay(text) {
        if (ac.signal.aborted) return;
        if (!lat.firstWordAt) lat.firstWordAt = Date.now();
        ai.say = text;
      },
      onFacts(f) { if (!ac.signal.aborted) ai.facts = f; },
      onSayComplete(say) {
        if (ac.signal.aborted || modelIgnored) return;
        ai.say = say;
        if (!/^(ANS|BANK)/.test(String(lat.tag ?? "")) || !fresh()) return;
        if (String(lat.tag).startsWith("BANK") && shown?.badge === "bank") return; // bank card already up
        const g = guard(ai.say);
        if (!g.ok) log.write("events", { type: "guard", turnId, rule: g.rule });
        if (!g.ok && noAgency) { clearTimeout(stallTimer); return; }   // a blocked answer on a call that is not with his customer: nothing, never a stall line
        const card: Card = g.ok ? { ...ai, at: Date.now() } : { ...ai, id: stallId, badge: "stall", say: stallSay(stall, turnSeq), facts: [], at: Date.now() };
        if (meSpokeSince()) card.dim = true;
        clearTimeout(stallTimer);
        shown = card; emitCard(card); lat.cardAt = Date.now();
      },
      onDone({ usage, providerMetadata, text, model }) {
        if (ac.signal.aborted) return;
        clearTimeout(stallTimer);
        reflexErrors = 0; healthClear("ai"); breakers.get(model)?.success(); refreshSignals();
        const c = cost.addLlm("reflex", model, usage, providerMetadata);
        log.write("usage", { role: "reflex", model, turnId, usage, providerMetadata, usd: c.usd, roleTotalUsd: cost.roles.reflex.usd });
        log.write("events", { type: "reflex.raw", turnId, text });
        if (shown && shown.badge === "ai" && ai.facts.length) {
          const g = guard(ai.facts.join(" "));
          if (g.ok) emitCard({ ...shown, facts: ai.facts }); // upsert same id with facts
          else log.write("events", { type: "guard", turnId, rule: g.rule, where: "facts" });
        }
        lat.doneAt = Date.now();
        recordLatency(lat);
      },
    },
  }).catch((e: ProviderError) => {
    clearTimeout(stallTimer);
    lat.aborted = ac.signal.aborted ? 1 : 0; recordLatency(lat);
    if (ac.signal.aborted) return;
    const kind = e?.kind ?? "unknown";
    log.write("events", { type: kind === "refusal" ? "reflex.empty" : "reflex.error", turnId, kind, error: String(e) });
    console.error("reflex error:", e?.message ?? e);
    // L5/L6: refusal, empty answer or timeout: show the stall line if nothing is up yet.
    if ((kind === "refusal" || kind === "timeout") && !shown && !noAgency && fresh()) { shown = { id: stallId, turnId, badge: "stall", question: r.text, say: stallSay(stall, turnSeq), facts: [], at: Date.now() }; emitCard(shown); }
    if (kind !== "refusal" && ++reflexErrors >= 2) health("ai", "amber", "AI לא עונה (הבנק עדיין עובד)", String(e?.message ?? e));
  }).finally(end);
}

// ---- Answers for Dan's own questions ("me" channel) ----
const ONLY_YOU_TEXT = "I only hear you. To get answers for the other side, join the call or play its audio. Ask me anything: Ctrl+Opt+A.";
const isSolo = () => !themSoundSeen && !transcript.some((l) => l.ch === "them");
/** Answers for Dan need a working model and budget; they do NOT need the other side to be heard (rung 4 still allows them). */
const canMeAi = () => !noAi && consented && !shuttingDown && sup.caps.meAns && usableModels().length > 0 && cost.llmState() !== "capped";
const meLog = (turnId: string, text: string, decision: string, why: string, extra: Record<string, unknown> = {}) => log.write("events", { type: "me.decision", turnId, text, decision, why, ...extra });

/** Ctrl+Opt+A / the "ask" control command: the next thing Dan says (within assist.askWindowMs) is a question for Wingman. */
function armAsk() {
  if (shuttingDown) return;
  if (!consented) { console.log("\n(ask ignored: listening has not started yet)"); return; }
  askUntil = Date.now() + S.assist.askWindowMs;
  log.write("events", { type: "ask.armed", ms: S.assist.askWindowMs });
  log.write("cards", { type: "ask", on: true, until: askUntil, at: Date.now() });
  status("ask", { on: true, until: askUntil });
  console.log(`\n🙋 Listening for your question (${Math.round(S.assist.askWindowMs / 1000)} s)…`);
  clearTimeout(askTimer);
  askTimer = setTimeout(() => disarmAsk("timeout"), S.assist.askWindowMs + 2500);   // small grace: a sentence that started inside the window may finish after it
}
function disarmAsk(why: string) {
  if (!askUntil) return;
  askUntil = 0; clearTimeout(askTimer);
  log.write("cards", { type: "ask", on: false, at: Date.now() });
  status("ask", { on: false });
  if (why === "timeout") log.write("events", { type: "ask.expired" });
}

/** `ask <question>` on the control channel (the wingman CLI): a typed question, handled like a spoken one that followed the ask key. */
function askTyped(q: string) {
  if (shuttingDown || !consented) { console.log("\n(ask ignored: listening has not started yet)"); return; }
  const text = q.replace(/\s+/g, " ").trim().slice(0, 300), now = Date.now();
  log.write("events", { type: "me.detect", text, forced: true, reason: "typed" });
  void onMeQuestion({ channel: "me", text, isFinal: true, speechFinal: true, words: [], arrivedAt: now, speechEndWall: now } as SttResult, true).catch((e) => log.write("events", { type: "me.error", error: String((e as Error)?.message ?? e).slice(0, 200) }));
}

/** A "me" utterance has ended. Decide whether it is a question for Wingman and answer it. */
function handleMe(joined: SttResult) {
  const text = joined.text.trim();
  if (!text || shuttingDown || !consented) return;
  const speechEnd = joined.speechEndWall ?? joined.arrivedAt;
  const nWords = text.split(/\s+/).filter(Boolean).length;
  const forced = askUntil > 0 && speechEnd <= askUntil + 1500 && nWords >= 2;   // the ask key was pressed: this is for Wingman
  if (forced) disarmAsk("used");
  const mode = S.assist.answerMe;
  if (!forced && mode !== "always") return;
  const math = evalMath(text);
  const d = detect(text);
  if (!forced && !d.isQuestion && !math) return;
  log.write("events", { type: "me.detect", text, forced, reason: forced ? "hotkey" : math ? "math" : d.reason });
  void onMeQuestion(joined, forced).catch((e) => log.write("events", { type: "me.error", error: String((e as Error)?.message ?? e).slice(0, 200) }));
}

async function onMeQuestion(r: SttResult, forced: boolean) {
  const tStart = Date.now();
  const text = r.text.trim();
  const turnId = `m${++meSeq}`;
  const speechEnd = r.speechEndWall ?? r.arrivedAt;
  meCurrent?.abort();
  const ac = (meCurrent = new AbortController());
  const dead = () => ac.signal.aborted || shuttingDown;
  const quietFor = Date.now() - Math.max(lastThemSound, lastThemText), solo = isSolo();

  // 1. Is it for Wingman or for the other person?
  const ignoreOther = Date.now() - lastThemSpeech > 60_000;   // nobody else spoke lately: "you / can you" is for Wingman
  const cue = audienceByCues(text, { forced, ignoreOther });
  let verdict: "ASSIST" | "OTHER" | "NEITHER" | undefined;
  // Speculative: when the rules are unsure and others are talking, the classifier and the answer run in PARALLEL; the card waits for the verdict.
  let verdictP: Promise<void> | undefined;
  if (cue.audience === "unsure" && canMeAi() && !solo) {
    verdictP = (async () => {
    try {
      const c = await classify({ registry, model: S.assist.model, cache: S.llm.reflex.cache, system: prefix, text, frame: frameText(tracker.current) || undefined, recent: transcript.slice(-8).map((l) => `${l.ch}: ${l.text}`).join("\n"), solo, themQuietMs: quietFor, signal: ac.signal, timeoutMs: S.assist.classifyTimeoutMs });
      const cu = cost.addLlm("assist", S.assist.model, c.usage, c.providerMetadata);
      log.write("usage", { role: "assist", model: S.assist.model, turnId, usage: c.usage, usd: cu.usd });
      verdict = c.verdict;
    } catch (e) { if (!dead()) log.write("events", { type: "me.classify-error", turnId, error: String((e as Error)?.message ?? e).slice(0, 160) }); }
    })();
  }
  let dec = decideAudience(cue, { verdict, themQuietMs: quietFor, solo, quietNeededMs: S.assist.themQuietMs });
  let tDecide = Date.now();
  const settle = async (): Promise<boolean> => {           // true = answer for Dan
    if (verdictP) { await verdictP; verdictP = undefined; dec = decideAudience(cue, { verdict, themQuietMs: Date.now() - Math.max(lastThemSound, lastThemText), solo, quietNeededMs: S.assist.themQuietMs }); tDecide = Date.now(); if (!dead() && !dec.answer) meLog(turnId, text, "skip", dec.why); }
    return !dead() && dec.answer;
  };
  if (!verdictP && !dec.answer) { meLog(turnId, text, "skip", dec.why); return; }

  // 2. Show an answer, unless it would push a fresh card for the other side off the screen (an asked-for answer waits instead).
  const giveUpAt = Date.now() + 30_000;
  let cardOut = false;
  const show = (say: string, facts: string[], source: "calc" | "ai") => {
    const tryShow = () => {
      if (dead()) return;
      const now = Date.now();
      if (verdictP) { void settle().then((ok) => { if (ok) tryShow(); }); return; }   // classifier still out: hold the card
      if (!dec.answer) return;
      const g = meGate.check(now, { forced, lastThemCardAt, calc: source === "calc", solo: isSolo() });   // arithmetic is instant and tiny: it ignores the protect-them window
      if (!g.ok) {
        if (g.why === "protect-them" && forced && now + g.waitMs < giveUpAt) { meLog(turnId, text, "defer", g.why, { waitMs: Math.round(g.waitMs) }); const t = setTimeout(() => { meTimers2.delete(t); tryShow(); }, g.waitMs + 50); meTimers2.add(t); return; }
        meLog(turnId, text, "skip", g.why); return;
      }
      if (!forced && now - speechEnd > S.reflex.dropStaleMs * 2) { meLog(turnId, text, "skip", "stale"); return; }
      meGate.note(now); meShown++;
      { const total = now - speechEnd; meLat.push({ total, source }); log.write("events", { type: "me.latency", turnId, source, stt: Math.max(0, r.arrivedAt - speechEnd), detect: Math.max(0, tStart - r.arrivedAt), decide: Math.max(0, tDecide - tStart), firstCard: Math.max(0, now - tDecide), total }); }
      emitCard({ id: `${turnId}-me`, turnId, badge: "me", forMe: true, source, question: text, say, facts, at: now }); cardOut = true;
      meLog(turnId, text, "answer", dec.why, { source });
    };
    tryShow();
  };

  // 2a. arithmetic: local, instant, no model
  const math = evalMath(text);
  if (math) { show(math.say, [], "calc"); return; }
  // 2b. everything else needs the model
  if (!canMeAi()) { meLog(turnId, text, "skip", noAi ? "no-ai" : "ai-unavailable"); return; }
  const usable = usableModels();
  let tag: Tag | undefined, said = "", facts: string[] = [], shownOnce = false;
  await runReflex({
    registry, models: usable, cfg: S.llm.reflex, prefix, transcript: transcript.slice(-12).map((l) => `${l.ch}: ${l.text}`).join("\n"), question: text, context: contextNotes, signal: ac.signal,
    frame: frameText(tracker.current) || undefined, asker: "me", solo, maxTokens: Math.min(S.llm.reflex.maxTokens, 100),
    onFail: (model, err) => llmFailed(model, err),
    onSwitch: (from, to, err) => { log.write("events", { type: "llm.switch", turnId, from, to, kind: err.kind }); },
    h: {
      onTag(t) { tag = t; },
      onSay() {},
      onFacts(f) { facts = f; },
      onSayComplete(say) {
        if (dead() || tag?.kind !== "ANS") return;
        const g = guardMe(say, text);
        if (!g.ok) { meLog(turnId, text, "skip", `guard:${g.rule}`); return; }
        said = say; shownOnce = true; show(say, [], "ai");
      },
      onDone({ usage, providerMetadata, text: raw, model }) {
        if (dead()) return;
        breakers.get(model)?.success(); refreshSignals();
        const c = cost.addLlm("me", model, usage, providerMetadata);
        log.write("usage", { role: "me", model, turnId, usage, providerMetadata, usd: c.usd, roleTotalUsd: cost.roles.me.usd });
        log.write("events", { type: "reflex.raw", turnId, text: raw });
        if (!shownOnce && tag?.kind !== "ANS") meLog(turnId, text, "skip", `model:${tag?.kind ?? "none"}`);
        // Dan pressed the ask key (or typed `ask`) and nothing came back: say so, never leave him with an empty screen.
        if (forced && !cardOut && !shownOnce) { meLog(turnId, text, "unsure", "forced-no-answer"); show("לא בטוח — נסה לנסח שוב", [], "ai"); }
      },
    },
  }).catch((e: ProviderError) => { if (!dead()) log.write("events", { type: "me.error", turnId, kind: e?.kind ?? "unknown", error: String(e?.message ?? e).slice(0, 200) }); });
}

let reflexErrors = 0;
/** Models whose breaker lets a request through, in configured order. */
function usableModels(): string[] {
  const now = Date.now();
  return REFLEX_MODELS.filter((m) => (downUntil.get(m) ?? 0) <= now && breakers.get(m)!.allow());
}
function llmFailed(model: string, err: ProviderError) {
  const hard = err.kind === "auth" || err.kind === "spend_cap" || err.kind === "quota" || err.kind === "unsupported";
  breakers.get(model)?.failure(hard);
  if (err.kind === "spend_cap") downUntil.set(model, Date.now() + 6 * 3600_000);
  if (err.kind === "rate" || err.kind === "overload" || err.kind === "timeout" || err.kind === "network") sup.noteLlmTrouble();
  log.write("events", { type: "llm.error", model, kind: err.kind, retryable: err.retryable, switchProvider: err.switchProvider, status: err.status });
  if (hard) health(`ai-${model}`, "red", `AI ${describe(err)}${REFLEX_MODELS.length > 1 ? "" : ". בנק בלבד"}`);
  refreshSignals();
}

/** Push the current facts to the supervisor (called every tick and after events). */
function refreshSignals() {
  const usable = usableModels();
  sup.set({
    llmDown: !noAi && usable.length === 0,
    llmOnFallback: usable.length > 0 && usable[0] !== REFLEX_MODELS[0],
    costCapped: cost.llmState() === "capped",
  });
}

// C2: buffer is_final segments per channel and handle the joined utterance on speech_final (or a short fallback timer).
type Pending = { texts: string[]; words: Word[]; last: SttResult; timer?: NodeJS.Timeout };
const pending: Partial<Record<Channel, Pending>> = {};
let lastThem: PrevUtterance | undefined;   // S10: the previous client utterance, for split questions
function flush(ch: Channel) {
  const p = pending[ch]; if (!p) return;
  clearTimeout(p.timer); delete pending[ch];
  const joined: SttResult = { ...p.last, text: p.texts.join(" "), words: p.words, speechFinal: true };
  if (shuttingDown) return;
  if (ch === "me") { handleMe(joined); return; }
  if (ch !== "them") return;
  const now = Date.now();
  if (isAgencyTopic(joined.text)) lastAgencyTopicAt = now;   // any customer line about sites / hosting keeps short follow-ups on topic
  const endWall = joined.speechEndWall ?? now;
  const w = joined.words;
  const startWall = w.length && joined.speechEndWall ? endWall - Math.max(0, (w[w.length - 1].end - w[0].start) * 1000) : now;
  const detectText = (t: string) => { const h = matchBankFor(t, bank); return { hit: h, d: detect(t, { bankScore: h?.score ?? 0, stall: !!h && h.card.id.startsWith("stall-") }) }; };
  let { hit, d } = detectText(joined.text);
  // S10: glue the previous short fragment only when that turns a non-question into a question.
  const glued = d.isQuestion && !isBareQuestionTail(joined.text, d.reason) ? joined.text : joinSplit(lastThem, joined.text, startWall, S.stt.joinWindowMs);
  if (glued !== joined.text) {
    const g = detectText(glued);
    if (g.d.isQuestion) { log.write("events", { type: "split.join", prev: lastThem?.text, text: joined.text }); joined.text = glued; hit = g.hit; d = g.d; }
  }
  lastThem = { text: joined.text.split(/\s+/).slice(-30).join(" "), at: endWall, question: d.isQuestion };
  // Fast back-to-back questions merged into one final: one question (and one card) per piece.
  const parts = d.isQuestion ? splitMergedQuestions(joined.text, bank) : [joined.text];
  if (parts.length > 1) {
    log.write("events", { type: "split.multi", text: joined.text, parts });
    parts.forEach((p, part) => {
      const pd = detectText(p).d;
      log.write("events", { type: "detect", text: p, part, ...pd });
      if (pd.isQuestion && sup.caps.detect) onQuestion({ ...joined, text: p }, pd.reason);
    });
    return;
  }
  log.write("events", { type: "detect", text: joined.text, ...d });
  if (d.isQuestion && sup.caps.detect) onQuestion(joined, d.reason);
}

function onResult(r: SttResult) {
  if (!r.isFinal) return;
  // Hebrew + English mixing sometimes hallucinates Telugu / Persian / Arabic on short clips: such a final triggers nothing.
  if (S.stt.dropForeignScript && r.text) {
    const sc = checkScript(r.text);
    if (!sc.ok) {
      foreignDropped++;
      log.write("events", { type: "stt.foreign-script", ch: r.channel, text: r.text.slice(0, 80), ratio: Number(sc.ratio.toFixed(2)), n: foreignDropped });
      if (r.speechFinal) { flush(r.channel); }   // the pending (good) text of this utterance still gets handled
      return;
    }
  }
  log.write("events", { type: "stt", ch: r.channel, final: true, speechFinal: r.speechFinal, text: r.text, speechEndWall: r.speechEndWall });
  if (r.channel === "them" && r.text) echo.noteThem(r.text, r.arrivedAt);
  // "me" lines wait briefly so the client line they may echo has arrived, then go through the echo filter.
  // (No wait when the other side has not spoken within the filter window: there is nothing the mic could be echoing.)
  if (r.channel === "me" && r.text && useFilter && !shuttingDown && Date.now() - lastThemSpeech < ECHO.filterWindowMs + ECHO.filterDelayMs) {
    const t = setTimeout(() => { meTimers.delete(t); acceptResult(r, true); }, ECHO.filterDelayMs);
    meTimers.add(t); return;
  }
  acceptResult(r, false);
}
const meTimers = new Set<NodeJS.Timeout>();
function acceptResult(r: SttResult, checkEcho: boolean) {
  if (shuttingDown) return;
  if (r.text.length > 2000) r = { ...r, text: r.text.slice(-2000) };   // a runaway final must not stall the regex/matching
  if (checkEcho) {
    const e = echo.isEcho(r.text);
    if (e.echo) { echoDropped++; log.write("events", { type: "echo.drop", text: r.text, score: Number(e.score.toFixed(2)) }); return; }
  }
  if (r.text) {
    lastSpeechAt = Date.now();
    if (r.channel === "them") { lastThemText = Date.now(); lastThemSpeech = Date.now(); themHeard(); }
    // Side features must never take the call down: a bad snapshot row or odd text only loses its own card.
    try { capture(r.channel, r.text); } catch (e) { log.write("events", { type: "capture.error", error: String((e as Error)?.message ?? e) }); }
    try { spotFacts(r.text); } catch (e) { log.write("events", { type: "facts.error", error: String((e as Error)?.message ?? e) }); }
    if (notesOn) notesLines.push(`${r.channel}: ${r.text}`);
    if (r.channel === "me" && r.text.length >= 6 && r.text.split(/\s+/).length >= 2) lastMeVoiced = Date.now();
    transcript.push({ ch: r.channel, text: r.text, at: Date.now() });
    { const n = wordCount(r.text); frameWords += n; tipWords += n; }
    log.write("transcript", { ch: r.channel, text: r.text, words: r.words });
    const p = (pending[r.channel] ??= { texts: [], words: [], last: r });
    p.texts.push(r.text); p.words.push(...r.words); p.last = r;
    clearTimeout(p.timer); p.timer = setTimeout(() => flush(r.channel), S.stt.flushFallbackMs);
    // Dan's own question: do not wait for the end-of-speech mark or the fallback timer when the text already ends in "?" or is a sum.
    if (r.channel === "me" && S.assist.answerMe !== "off" && (/\?\s*$/.test(r.text) || evalMath(p.texts.join(" ")))) { flush("me"); return; }
  }
  if (r.speechFinal) flush(r.channel);
}

// Single-key input: Enter = consent confirmed, q = quiet toggle, Ctrl+C = stop.
let keyWaiter: ((k: string) => void) | undefined;
function setupKeys(onEnter: () => void) {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true); process.stdin.resume();
  process.stdin.on("data", (b: Buffer) => {
    for (const ch of b.toString()) {
      if (keyWaiter) { const w = keyWaiter; keyWaiter = undefined; w(ch); continue; }
      if (ch === "\u0003") { void shutdown(); return; }
      if (noteBuf !== undefined) { noteKey(ch); continue; }
      if ((ch === "y" || ch === "Y") && proposed && !clientChosen) { confirmClient(); continue; }
      if (ch === "a" || ch === "A") { armAsk(); continue; }
      if (ch === "n" || ch === "N") { noteBuf = ""; process.stdout.write("\nNote for the AI (Enter = add, Esc = cancel): "); continue; }
      if (ch === "\r" || ch === "\n") onEnter();
      if (ch === "q" || ch === "Q") toggleQuiet();
    }
  });
}
function toggleQuiet(on = !quiet) {
  if (on === quiet) return;
  quiet = on; log.write("events", { type: "quiet", on: quiet });
  quiet ? health("quiet", "info", "מצב שקט: הכרטיסים נרשמים אבל לא מוצגים (q לחזרה)") : healthClear("quiet");
  console.log(`\nquiet ${quiet ? "ON: cards are logged, not shown" : "OFF"}`);
  status("quiet", { on: quiet });
}
const typedNotes: string[] = [], MAX_TYPED_NOTES = 20, MAX_TYPED_NOTE_CHARS = 4096;
function addNote(text: string) {
  const note = text.trim();
  if (!note) return;
  const kept = note.slice(0, 300);
  contextNotes.push(kept); typedNotes.push(kept); log.write("events", { type: "context.note", note });
  // Typed notes are capped (last 20 notes / 4 KB) so a long call cannot grow every prompt without bound; brief notes are never dropped.
  while (typedNotes.length > 1 && (typedNotes.length > MAX_TYPED_NOTES || typedNotes.reduce((n, x) => n + x.length, 0) > MAX_TYPED_NOTE_CHARS)) {
    const old = typedNotes.shift()!, i = contextNotes.lastIndexOf(old); if (i >= 0) contextNotes.splice(i, 1);
  }
  console.log(`\n✓ note added (${contextNotes.length})`);
  status("note", { count: contextNotes.length });
}
/** Menu-bar app commands (WINGMAN_CONTROL=1): one per line on stdin. */
function setupControl(onConsent: () => void) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const [cmd, ...rest] = line.trim().split(" ");
    if (cmd === "consent") onConsent();
    else if (cmd === "quiet") toggleQuiet(rest[0] === "on" ? true : rest[0] === "off" ? false : undefined);
    else if (cmd === "client") confirmClient();
    else if (cmd === "ask") { const q = rest.join(" ").trim(); if (q) askTyped(q); else armAsk(); }   // "ask" = the hotkey; "ask <text>" = a typed question (wingman CLI)
    else if (cmd === "note") addNote(rest.join(" "));
    else if (cmd === "stop") void shutdown();
    else if (cmd === "stop-delete") { discardNow = true; void shutdown(); }
  });
  rl.on("close", () => void shutdown());   // the menu-bar app went away: stop cleanly
}
// Typed context note (instant-start mode: tell Wingman what the call is about, mid-call).
let noteBuf: string | undefined, discardNow = false;
function noteKey(ch: string) {
  if (ch === "\u001b") { noteBuf = undefined; process.stdout.write(" (cancelled)\n"); return; }
  if (ch === "\r" || ch === "\n") {
    const note = (noteBuf ?? "").trim(); noteBuf = undefined;
    if (note) addNote(note); else process.stdout.write("\n");
    return;
  }
  if (ch === "\u007f" || ch === "\b") { if (noteBuf) { noteBuf = [...noteBuf].slice(0, -1).join(""); process.stdout.write("\b \b"); } return; }
  if (ch >= " ") { noteBuf += ch; process.stdout.write(ch); }
}
const askKey = (ms: number) => new Promise<string>((res) => { const t = setTimeout(() => { keyWaiter = undefined; res(""); }, ms); keyWaiter = (k) => { clearTimeout(t); res(k); }; });

let stops: (() => Promise<void>)[] = [];
let me: SttChannel, them: SttChannel;
let crashed = false;

/** Post-call summary: one model call before the "delete this call?" question. Never blocks longer than summary.timeoutMs; errors are logged, not thrown. */
async function postCallSummary() {
  try {
    log.write("events", { type: "context.snapshot", contextNotes, aiNotes: liveNotes });   // lets `pnpm summary <id>` rebuild the same input later
    const r = await runSummary({
      dir: log.dir, callId: log.id, S, registry, cost, noAi, discard: discard || discardNow, crashed,
      data: { lines: transcript.map((l) => ({ ch: l.ch, text: l.text })), contextNotes, aiNotes: liveNotes, frame: tracker.current },
      write: (stream, row) => log.write(stream, row),
    });
    if (r.skipped) return;
    if (r.ok) console.log(formatShort(r.summary!)); else console.log(`\nSummary failed: ${r.error}`);
    status("summary", { ok: r.ok, id: log.id });
  } catch (e) { try { log.write("events", { type: "summary.error", error: String((e as Error)?.message ?? e) }); } catch {} }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true; current?.abort(); notesAbort.abort();
  const shutdownDeadline = Date.now() + 12_000;
  const hard = setTimeout(() => { console.error("shutdown stuck: forcing exit"); process.exit(1); }, 10_000);   // a hung audio/socket close must not keep the mic open
  for (const t of meTimers) clearTimeout(t); meTimers.clear();
  for (const t of meTimers2) clearTimeout(t); meTimers2.clear(); meCurrent?.abort(); clearTimeout(askTimer);
  for (const ch of ["me", "them"] as Channel[]) { clearTimeout(pending[ch]?.timer); delete pending[ch]; }
  for (const s of stops) await s().catch(() => {});
  sup.stop();
  await Promise.all([me?.close(), them?.close()].filter(Boolean)).catch(() => {});
  clearTimeout(hard);
  setTimeout(() => process.exit(crashed ? 1 : 0), 16_000).unref();   // last resort, before the tray's SIGKILL at 20 s (files are already written)
  // Budget: the tray sends SIGINT at 12 s and SIGKILL at 20 s after Stop, so the final frame + summary share ~12 s from the start of shutdown.
  // The call files (usage, endedAt) are written FIRST; the frame look and the summary are best effort on top of that.
  const left = () => shutdownDeadline - Date.now();
  try {
    cost.setSttSeconds(sttSeconds());
    log.write("usage", { role: "stt", vendor: them?.provider, seconds: { me: me?.audioSeconds, them: them?.audioSeconds }, bySeconds: sttSeconds(), usd: cost.sttUsd, dropped: { me: me?.dropped, them: them?.dropped } });
    if (brief?.mustCover?.length) { const left = uncovered(); log.write("events", { type: "mustcover.summary", left }); if (left.length) console.log(`\nNot covered in this call: ${left.join(", ")}`); }
    log.write("events", { type: "echo.summary", mode: ECHO.mode, gatedSeconds: Math.round(gatedMs / 1000), echoDropped });
    log.write("events", { type: "foreign.summary", dropped: foreignDropped });
    log.write("events", { type: "me.summary", mode: S.assist.answerMe, answers: meShown, questions: meSeq });
    if (foreignDropped) console.log(`\nDropped ${foreignDropped} speech-to-text lines in a foreign script (not Hebrew/English).`);
    log.write("usage", { role: "summary", llmUsd: cost.llmUsd, sttUsd: cost.sttUsd, totalUsd: cost.totalUsd, roles: cost.roles, unpriced: [...cost.unpriced] });
    const summary = speedSummary();
    log.write("events", { type: "speed.summary", summary });
    log.update({ endedAt: new Date().toISOString(), crashed });
    console.log(`\nSpeakers mode (${ECHO.mode}): mic muted ${Math.round(gatedMs / 1000)} s while the client talked · ${echoDropped} echo lines dropped`);
    console.log(`\n${summary}\nCost: ${cost.line()} (estimate from settings budget.prices)\nSTT chunks dropped (socket not open): me ${me?.dropped ?? 0}, them ${them?.dropped ?? 0}`);
  } catch (e) { console.error("call summary failed:", e); try { log.write("events", { type: "shutdown.error", error: String((e as Error)?.stack ?? e) }); } catch {} }
  // One last frame look so the checklist result in the review is current (a few seconds at most, never when the call is discarded or crashed).
  if (frameOn && left() > 6000 && !crashed && !discard && !discardNow && cost.llmState() !== "capped") {
    await Promise.race([frameRound(true), new Promise((res) => setTimeout(res, Math.min(S.frame.timeoutMs + 500, left() - 5000)))]).catch(() => {});
    const f = tracker.current;
    if (f) log.write("events", { type: "frame.summary", kind: f.kind, done: progress(f).done, total: progress(f).total, missed: missedMust(f).map((m) => m.item) });
  }
  await Promise.race([postCallSummary(), new Promise((res) => setTimeout(res, Math.max(1500, left())))]);
  try { log.write("usage", { role: "summary", llmUsd: cost.llmUsd, sttUsd: cost.sttUsd, totalUsd: cost.totalUsd, roles: cost.roles, unpriced: [...cost.unpriced] }); } catch {}
  try { log.update({ endedAt: new Date().toISOString(), crashed }); } catch {}
  let del = discard || discardNow;
  if (!del && !crashed && process.stdin.isTTY) {
    process.stdout.write("\nDelete this call's saved text now? y = delete, any other key (or 10 s) = keep: ");
    del = (await askKey(10_000)).toLowerCase() === "y";
  }
  if (del) {
    try { rmSync(log.dir, { recursive: true, force: true }); if (!existsSync(join(CALLS, "latest"))) rmSync(join(CALLS, "latest"), { force: true }); } catch {}
    console.log(`\nDeleted ${log.dir}`);
  } else console.log(`\nSaved ${log.dir}\nRate the cards: pnpm tag · delete later: pnpm purge ${log.id}`);
  status("ended", { id: log.id, deleted: del, crashed });
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
  process.exit(crashed ? 1 : 0);
}

function crash(kind: string, e: unknown) {
  if (kind === "main" && (e as ProviderError)?.kind) console.error(`\n🔴 ${describe(e as ProviderError)} – ${(e as Error).message}\n   (providers: stt ${sttChain(S).join(" -> ")}; fix the key/credit or set stt.fallback; pnpm run doctor checks all of them)`);
  else console.error(`\n🔴 ${kind}:`, e);
  try { log.write("events", { type: "crash", kind, error: String((e as Error)?.stack ?? e) }); } catch {}
  if (shuttingDown) process.exit(1);
  crashed = true;
  setTimeout(() => process.exit(1), 5000).unref(); // never hang on a broken shutdown
  void shutdown();
}
process.on("uncaughtException", (e) => crash("uncaughtException", e));
process.on("unhandledRejection", (e) => crash("unhandledRejection", e));
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGHUP", () => void shutdown());

const sttSeconds = () => {
  const out: Record<string, number> = {};
  for (const c of [me, them]) for (const [k, v] of Object.entries(c?.audioSecondsByProvider() ?? {})) out[k] = (out[k] ?? 0) + v;
  return out;
};
let sttSwitchedCh = new Set<Channel>();
let costWarned = false, minutesWarned = false;

/** Once a second: feed the supervisor and the cost warnings. */
let lastTick = Date.now(), sleepClearAt = 0, lastSpeechAt = Date.now(), idleWarned = false, consentedAt = 0;
function tickHealth() {
  // Y2: a long gap between ticks means the Mac slept (lid closed) mid-call.
  const now = Date.now(), gap = now - lastTick; lastTick = now;
  const gapMs = S.system.sleepGapMs ?? 0;
  if (gapMs > 0 && gap > gapMs + S.health.tickMs) {
    log.write("events", { type: "sleep.gap", ms: gap });
    health("sleep", "amber", `המחשב נרדם ל-${Math.round(gap / 1000)} שניות. חלק מהשיחה לא נשמע`);
    sleepClearAt = now + 20_000;
  } else if (sleepClearAt && now > sleepClearAt) { sleepClearAt = 0; healthClear("sleep"); }
  // S16: a call left running with nobody talking stops itself (a long real meeting is never cut while people speak).
  const idleMin = S.budget.idleStopMin;
  if (idleMin > 0 && consented && !fileArg && !shuttingDown) {
    if (!consentedAt) consentedAt = now;
    const idle = now - Math.max(lastSpeechAt, consentedAt);
    if (idle >= idleMin * 60_000) { log.write("events", { type: "idle.stop", minutes: idleMin }); console.log(`\nNobody spoke for ${idleMin} minutes: stopping the call.`); void shutdown(); }
    else if (idle >= Math.max(1, idleMin - 2) * 60_000 && !idleWarned) { idleWarned = true; health("idle", "amber", `אף אחד לא דיבר ${Math.round(idle / 60_000)} דקות. השיחה תיעצר לבד בעוד כ-2 דקות`); }
    else if (idleWarned && idle < 60_000) { idleWarned = false; healthClear("idle"); }
  }
  refreshSignals();
  cost.setSttSeconds(sttSeconds());
  sup.set({ sttOnFallback: sttSwitchedCh.size > 0 });
  const st = cost.llmState();
  if (st === "warn" && !costWarned) { costWarned = true; health("cost", "amber", `עלות AI ${cost.line()}`); log.write("events", { type: "cost.warn", line: cost.line() }); }
  if (cost.minutesState() !== "ok" && !minutesWarned) { minutesWarned = true; health("minutes", "amber", `השיחה רצה ${cost.sttMinutes.toFixed(0)} דקות. לעצור?`); }
  sup.tick();
}
function renderRung({ from, to, reasons }: { from: Rung; to: Rung; reasons: string[] }) {
  log.write("events", { type: "ladder", from, to, reasons, idle: sup.idle });
  const d = describeRung(to, reasons, sup.userChoiceOnly);
  if (from !== to) console.log(`\n⇅ ladder: rung ${from} -> ${to} (${reasons.join(", ") || "recovered"})`);
  if (!d) healthClear("ladder"); else health("ladder", d.level, d.text);
  if (to === 5) { console.log("Wingman is OFF: " + reasons.join(", ")); status("off", { reasons }); void shutdown(); }
}

function makeChannel(ch: Channel): SttChannel {
  return new SttChannel({
    channel: ch, chain: sttChain(S).map(getSttProvider), keyOf: (id) => (NO_KEY.has(id) ? "none" : (keys as Record<string, string | undefined>)[id]),
    base: { language: S.stt.language, keyterms, endpointingMs: S.stt.endpointMs, utteranceEndMs: S.stt.utteranceEndMs, keepAliveMs: S.stt.keepAliveMs, model: S.stt.model },
    circuit: S.stt.circuit, ringMs: S.stt.reconnect.ringMs,
  });
}

/** STT channel with no fallback left: keep reopening the current provider (backoff 1,2,4,8,10,10... s) until it works or the failure is permanent. */
const sttRetrying = new Set<string>();
const STT_RETRY_BACKOFF_MS = (n: number) => Math.min(10_000, 1000 * 2 ** n);
async function sttRetryLoop(s: SttChannel, ch: string) {
  if (sttRetrying.has(ch)) return;
  sttRetrying.add(ch);
  try {
    for (let n = 0; !shuttingDown; n++) {
      await new Promise((r) => setTimeout(r, STT_RETRY_BACKOFF_MS(n)));
      if (shuttingDown) return;
      try {
        await s.reopen();
        healthClear(`stt-${ch}`); log.write("events", { type: "stt.recovered", ch, attempts: n + 1 });
        return;
      } catch (e) {
        const pe = e as ProviderError;
        log.write("events", { type: "stt.retry.fail", ch, n: n + 1, kind: pe.kind, error: pe.message });
        if (pe.kind && pe.retryable === false && pe.kind !== "bad_request") {
          health(`stt-${ch}`, "red", `STT (${ch}) – ${describe(pe)}`);
          if (ch === "them") sup.set({ fatal: `STT unusable: ${describe(pe)} (client channel)` });
          return;
        }
      }
    }
  } finally { sttRetrying.delete(ch); }
}

/** Initial open: transient errors (timeout, network, 5xx, closed) retry with backoff 1/2/4/8 s for ~30 s with a "connecting" line; auth/quota/spend-cap throw at once.
 *  After 30 s the call goes on exactly like a mid-call outage (red bar, retry forever): starting is safe, the consent card and mic checks do not depend on STT. */
async function openChannel(ch: SttChannel, name: string) {
  const t0 = Date.now();
  for (let n = 0; ; n++) {
    try { await ch.open(); if (n) healthClear(`stt-${name}`); return; }
    catch (e) {
      const pe = e as ProviderError;
      if (!pe.kind || (!pe.retryable && pe.kind !== "unknown")) throw e;   // auth / quota / spend cap / bad request: fatal with its clear message
      log.write("events", { type: "stt.open.retry", ch: name, n: n + 1, kind: pe.kind, error: pe.message });
      if (Date.now() - t0 > 30_000) {
        health(`stt-${name}`, "red", `STT (${name}) אין חיבור – ${describe(pe)}. מנסה שוב ושוב עד שיחזור`);
        void sttRetryLoop(ch, name); return;
      }
      if (!n) health(`stt-${name}`, "amber", `מתחבר לשירות התמלול (${name})…`);
      await new Promise((r) => setTimeout(r, Math.min(8000, 1000 * 2 ** n)));
    }
  }
}

async function main() {
  me = makeChannel("me"); them = makeChannel("them");
  for (const id of sttChain(S)) if (getSttProvider(id).experimental) console.log(`⚠ STT provider "${id}" is EXPERIMENTAL (never tested live).`);
  for (const m of REFLEX_MODELS) if (!noAi) { try { await registry.resolve(m); } catch (e) { if (m === REFLEX_MODELS[0] && !(e instanceof ConfigError && REFLEX_MODELS.length > 1)) throw e; console.log(`⚠ AI model ${m}: ${(e as Error).message}`); downUntil.set(m, Infinity); } }
  // Both channels open in parallel; neither rejection is allowed to leave the other dangling (allSettled), and only a permanent error is fatal.
  const opened = await Promise.allSettled([openChannel(me, "me"), openChannel(them, "them")]);
  const failed = opened.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (failed) throw failed.reason;
  sup.on("rung", renderRung); sup.start(); lastTick = Date.now(); setInterval(tickHealth, S.health.tickMs).unref();
  setInterval(() => void notesRound(), S.notes.everyMs).unref();
  setInterval(() => void frameRound(), 5000).unref();
  setInterval(tipsTick, 5000).unref();
  setInterval(reminderTick, 30_000).unref();
  if (brief) console.log(`Brief loaded: ${[brief.who, brief.goal].filter(Boolean).join(" · ") || "(notes only)"}${brief.mustCover?.length ? ` · must cover: ${brief.mustCover.join(", ")}` : ""}`);
  console.log(spotter ? `Fact cards: ${spotter.size.clients} clients, ${spotter.size.domains} domains (snapshot ${snapshot?.generatedAt?.slice(0, 10) ?? "?"})` : "Fact cards: off (no snapshot at facts.file)");
  sup.tick();
  for (const s of [me, them]) {
    const ch = s === me ? "me" : "them";
    s.on("result", (r: SttResult) => { if (ch === "them" && r.isFinal && r.speechFinal && r.speechEndWall) sup.recordSttLag(r.arrivedAt - r.speechEndWall); onResult(r); });
    s.on("stt_error", (e: ProviderError) => { console.error("stt error", ch, e.message); log.write("events", { type: "stt.error", ch, kind: e.kind, error: e.message }); });
    s.on("keyterms_off", () => { console.log("keyterms off for this provider (open was rejected with them)"); log.write("events", { type: "stt.keyterms_off", ch }); });
    s.on("disconnected", (d) => health(`stt-${ch}`, "red", `STT DISCONNECTED (${ch}) – אין תמלול, מנסה להתחבר מחדש`, JSON.stringify({ code: d.code, reason: d.reason })));
    s.on("reconnected", () => { healthClear(`stt-${ch}`); log.write("events", { type: "stt.reconnected", ch }); });
    s.on("switched", (d: { from: string; to: string; kind: string; reason: string }) => {
      sttSwitchedCh.add(ch); healthClear(`stt-${ch}`);
      log.write("events", { type: "stt.switch", ch, ...d });
      health(`stt-switch-${ch}`, "amber", `STT (${ch}): עברנו מ-${d.from} ל-${d.to}`, d.reason); tickHealth();
    });
    s.on("exhausted", (e: ProviderError) => {
      log.write("events", { type: "stt.exhausted", ch, kind: e.kind, retryable: e.retryable });
      // Auth / quota / spend cap will not fix themselves: stop with a clear message. Anything else (wifi drop, 5xx, rate limit) is retried forever with backoff.
      if (!e.retryable) {
        health(`stt-${ch}`, "red", `STT (${ch}) נפל בכל הספקים – ${describe(e)}`);
        if (ch === "them") sup.set({ fatal: `STT unusable: ${describe(e)} (client channel)` });
        return;
      }
      health(`stt-${ch}`, "red", `STT (${ch}) אין חיבור – ${describe(e)}. מנסה שוב ושוב עד שיחזור`);
      void sttRetryLoop(s as SttChannel, ch);
    });
  }
  console.log(`Wingman Stage 0 · call ${log.id} · ${fileArg ? "file " + fileArg : "live"} · ${bank.length} bank cards${noAi ? " · bank only" : ""}${discard ? " · --discard" : ""}`);
  console.log(`Cards also go to ${log.dir}/cards.jsonl (run "pnpm overlay" for the second-screen window). Keys: Enter = consent confirmed · q = quiet · a = ask Wingman · n = add a note for the AI · y = confirm the proposed client · Ctrl+C = stop.`);
  console.log(`Speakers mode: ${ECHO.mode} (audio.echo.mode; "filter" is best with headphones) · capture box ${S.capture.enabled ? "on" : "off"}`);

  // Consent card: re-emitted until confirmed (the overlay may start late).
  const consentCard = (): Card => ({ id: "consent", turnId: "start", badge: "info", question: "תחילת שיחה", say: CONSENT_SAY, facts: ["להגיד את זה בתחילת השיחה", CONTROL ? "הצד השני לא מסכים: Stop and delete בתפריט" : "הצד השני לא מסכים: Ctrl+C", CONTROL ? "אחרי שהסכים: Ctrl+Opt+Return" : "אחרי שהסכים: Enter"], at: Date.now() });
  let micPeakAfterStart = 0, micPeakWin = 0, micSilentShown = false, micWatch: NodeJS.Timeout | undefined;
  // privacy.requireConsentAck (default off: a personal tool): wait for a consent click before any audio leaves the Mac.
  const needAck = S.privacy.requireConsentAck && !fileArg && (process.stdin.isTTY || CONTROL);
  const startForwarding = () => {
    if (consented) return;
    consented = true; clearInterval(reemit); log.write("events", { type: needAck ? "consent.confirmed" : "listening.start" });
    if (needAck) { emitCard({ ...consentCard(), id: "consent", say: "הסכמה אושרה. התמלול פעיל.", facts: [] }); console.log("\nConsent confirmed: audio is now being sent for transcription."); }
    status("consented", { id: log.id });
    consentedAt = Date.now();
    // Periodic: checks the last micSilentMs of audio each time, shows the red banner when silent and clears it as soon as the mic is heard.
    if (!fileArg) { micPeakWin = 0; micWatch = setInterval(() => {
      if (shuttingDown) return;
      if (micPeakWin < S.audio.watchdog.micPeak) { if (!micSilentShown) { micSilentShown = true; health("mic", "red", "MIC SILENT – המיקרופון לא קולט (הרשאה? WINGMAN_MIC?)"); } }
      micPeakWin = 0;
    }, S.audio.watchdog.micSilentMs); micWatch.unref(); }
  };
  if (needAck) emitCard(consentCard());
  const reemit = setInterval(() => { if (!consented && needAck) emitCard(consentCard()); }, 20_000);
  if (!needAck) startForwarding();
  if (CONTROL) setupControl(startForwarding); else setupKeys(startForwarding);
  if (!consented) { console.log(`\nWaiting for consent: nothing is sent to the cloud until you ${CONTROL ? "click \"Consent given\" in the menu bar" : "press Enter"}.`); status("waiting", { id: log.id }); }

  if (fileArg) {
    const f = new FileSource(fileArg);
    f.on("pcm-them", (b) => { gate.noteThemPeak(peakOf(b)); them.send(b); }); f.on("pcm-me", (b) => me.send(gateMic(b)));
    f.on("end", () => setTimeout(() => void shutdown(), 4000));
    await f.start(); stops.push(() => f.stop());
  } else {
    if (S.system.caffeinate) spawn("caffeinate", ["-dis", "-w", String(process.pid)], { stdio: "ignore", env: childEnv() }).on("error", () => {}).unref();
    // Client audio: audiotee (macOS tap) | device (avfoundation input such as BlackHole, via ffmpeg) | off.
    const srcKind = S.audio.system.source;
    const sys = srcKind === "audiotee" ? new SystemSource() : srcKind === "device" ? new MicSource(S.audio.system.device) : undefined;
    const mic = new MicSource(S.audio.mic.device);
    if (S.audio.warnBluetooth) void readAudioDevices().then((devs) => {
      const bt = bluetoothInUse(devs);
      if (!bt || shuttingDown) return;
      log.write("events", { type: "audio.bluetooth", role: bt.role, device: bt.device.name });
      health("bluetooth", "amber", bt.role === "mic" ? `${bt.device.name} הוא המיקרופון: איכות התמלול יורדת. עדיף מיקרופון המק או אוזניות חוטיות` : `${bt.device.name} ברמקולים: אם המיקרופון שלהן ייפתח, האיכות תרד`);
    });
    console.log(`Mic device: ${mic.device} (audio.mic.device / WINGMAN_MIC) · client audio: ${srcKind}${srcKind === "device" ? ` (${S.audio.system.device})` : ""}`);
    mic.on("pcm", (b: Buffer) => {
      if (!consented) return;
      const pk = peakOf(b); micPeakAfterStart = Math.max(micPeakAfterStart, pk); micPeakWin = Math.max(micPeakWin, pk);
      if (micSilentShown && pk >= S.audio.watchdog.micPeak) { micSilentShown = false; healthClear("mic"); }
      me.send(gateMic(b));
    });
    mic.on("error", (e) => { console.error("mic error:", e.message); health("mic", "red", "MIC ERROR – המיקרופון נפל", e.message); });
    mic.on("log", (m: string) => console.log(m));
    if (sys) {
      sys.on("pcm", (b: Buffer) => { gate.noteThemPeak(peakOf(b)); if (consented) them.send(b); });
      sys.on("error", (e: Error) => { console.error("system audio error:", e.message); health("sys", "red", "SYSTEM AUDIO ERROR – לא שומעים את הלקוח", e.message); });
      sys.on("log", (m: string) => console.log(m));
      await sys.start();
    } else {
      console.log("audio.system.source is off: no audio from the other side, so only your own questions get answers (Ctrl+Opt+A).");
      sup.set({ themDead: true });
    }
    await mic.start();
    stops.push(async () => { await sys?.stop(); }, () => mic.stop(), async () => { clearInterval(micWatch); clearInterval(reemit); });
    // Silent-tap watchdog. Two different situations:
    //  1. Frames keep arriving but are silent while Dan talks (a monologue, a test, thinking aloud): ONE calm info line. This NEVER sets
    //     themDead (that would drop the ladder to transcript-only for a minute). Sound or client text clears it at once.
    //  2. No frames at all from the tap for deadFrameMs: the tap is really dead -> red, themDead (recovers within seconds once frames return).
    // Answers for Dan keep working in both cases.
    const W = S.audio.watchdog;
    let shownKind: "red" | "calm" | undefined, checking = false, lastSysFrame = Date.now();
    const clearThemBanner = () => {
      if (!shownKind) return;
      healthClear(shownKind === "red" ? "them-silent" : "only-you");
      if (shownKind === "red") sup.set({ themDead: false });
      shownKind = undefined;
    };
    themHeard = clearThemBanner;
    sys?.on("pcm", (b: Buffer) => {
      lastSysFrame = Date.now();
      if (peakOf(b) <= W.silentPeak) { if (shownKind === "red") { clearThemBanner(); } return; }   // frames are back (even quiet ones): the tap is alive
      lastThemSound = Date.now(); themSoundSeen = true;
      clearThemBanner();
    });
    const deadFrameMs = Math.max(W.silentThemMs, 8000);
    setInterval(() => {
      if (!sys || !consented || shuttingDown) return;
      if (Date.now() - lastSysFrame > deadFrameMs) {
        if (shownKind !== "red") {
          if (shownKind === "calm") { healthClear("only-you"); shownKind = undefined; }
          shownKind = "red"; sup.set({ themDead: true }); log.write("events", { type: "watchdog.tap-dead" });
          health("them-silent", "red", "NOT HEARING THE OTHER SIDE – אין שמע מהצד השני (ערוץ השמע של המערכת לא שולח כלום). התשובות אליך עדיין פועלות");
        }
        return;
      }
      if (shownKind || checking) return;
      if (!(Date.now() - lastThemSound > W.silentThemMs && Date.now() - lastMeVoiced < 3000)) return;
      checking = true;
      void callAppRunning().then((app) => {
        checking = false;
        if (shuttingDown || shownKind || Date.now() - lastThemSound <= W.silentThemMs) return;
        log.write("events", { type: "watchdog.silent-them", callApp: app ?? null });
        shownKind = "calm"; health("only-you", "info", ONLY_YOU_TEXT);
      });
    }, 2000).unref();
  }
}

main().catch((e) => crash("main", e));
