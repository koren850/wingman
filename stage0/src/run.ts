// Wingman Stage 0: live (system audio + mic) or --file <stereo.wav> (L = me, R = them).
//   pnpm start                 live call (listening starts at once; with "Ask me before listening starts" on, press Enter first and nothing is sent before that)
//   pnpm start --file x.wav    replay a recording in real time
//   pnpm start --no-ai         Prepared cards only (no AI)
//   pnpm start --discard       delete the call folder when the call ends
//   Keys while running: Enter = start listening (only when it is waiting) · q = Quiet mode on/off (cards saved, not shown)
//                       n = type a context note for the AI ("this is about the shop migration"), Enter to add · Ctrl+C = stop
//   WINGMAN_CONTROL=1         remote control for the menu-bar app: line commands on stdin (consent = Start listening, quiet, client, ask, note <text>, stop)
//                             and "@@wingman {json}" status lines on stdout (starting/waiting/consented, ask, mode, stopphase, ended...).
//                             call.json in the call folder also gets phase ("starting"|"waiting"|"live"|"ended") and liveAt for the answer window.
//
// Main flow (one process = one call):
//   audio (audio.ts: mic -> "me", system tap -> "them") -> SttChannel per side (providers/stt) -> onResult/acceptResult
//   -> per-channel buffer, joined on speech_final or a fallback timer (flush) -> "them": question detector (detector.ts),
//   split/merge fixes, then onQuestion: prepared bank card at once, stall line after reflex.stallAfterMs, Claude reflex
//   answer streamed in behind it (reflex.ts) -> emitCard -> cards.jsonl (the answer window tails it).
//   "me" finals go to handleMe: only the user's own questions to Wingman (ask key, or a detected question) get a "me" card.
// Side jobs on timers: notes (notesRound), call frame + tips (frameRound/tipsTick), must-cover reminders, health tick.
// State is module-level on purpose: one call per process. Everything async checks `shuttingDown` before it writes.
//
// Safety and cost:
//   - Nothing is sent for transcription until `consented` (immediately, or after "Start listening" when privacy.requireConsentAck is on).
//   - AI text passes guards.ts (no prices, dates, promises); a hit becomes a stall line.
//   - budget.maxUsdPerCall: at "capped" (cost.llmState) every model job (reflex, notes, frame, tips, me) stops; prepared cards still work.
//   - budget.idleStopMin: a call with no speech stops itself. STT minutes only warn.
//
// IPC contract with the tray app (WINGMAN_CONTROL=1):
//   stdin  lines: consent | quiet [on|off] | client | ask [text] | note <text> | stop | stop-no-summary | skip-summary | stop-delete
//   stdout "@@wingman {json}" lines. Stop sequence: {ev:"stopphase",phase:"saving"} -> "summary" -> "done", then {ev:"ended"}.
//   The tray escalates a stop with SIGINT at 12 s and SIGKILL at 20 s, so shutdown() finishes inside that.
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
import { detect, isClearQuestion } from "./detector.ts";
import { SpeakerBook, lineLabel, attendeeNames, introName, type SpeakerInfo } from "./speakers.ts";
import { guard, sanitize } from "./guards.ts";
import { buildPrefix, runReflex, resolveBankId, leakedTag, type Tag } from "./reflex.ts";
import type { SttResult, Channel, Word } from "./providers/stt/types.ts";
import { SttChannel } from "./providers/stt/channel.ts";
import { getSttProvider, sttChain, loadKeyterms } from "./providers/stt/index.ts";
import { ModelRegistry, parseModelRef, ConfigError } from "./providers/llm.ts";
import { describe, type ProviderError } from "./providers/errors.ts";
import { SystemSource, MicSource, FileSource, peakOf } from "./audio.ts";
import { CallLog } from "./log.ts";
import { loadSettingsOrExit, expandHome } from "./settings.ts";
import { CostMeter } from "./cost.ts";
import { EchoFilter, MicGate, resolveEchoMode, type EchoMode } from "./echo.ts";
import { extract } from "./capture.ts";
import { HealthSupervisor, CircuitBreaker, describeRung, type Rung } from "./health.ts";
import { joinSplit, isBareQuestionTail, type PrevUtterance } from "./split.ts";
import { splitMergedQuestions } from "./multiq.ts";
import { readAudioDevices, bluetoothInUse } from "./devices.ts";
import { runSummary, formatShort } from "./summary.ts";
import { FrameTracker, runFrame, frameText, isAgencyKind, isAgencyTopic, progress, missedMust, KIND_HE, type Frame } from "./frame.ts";
import { TipGate, runTip, checkTip, talkRatio, talkTip, wrapUpTip, type Tip, type TimedLine } from "./tips.ts";
import { SelfCheckGate, detectCareful, looksFactual, runSelfCheck, checkFix, MIN_WORDS } from "./selfcheck.ts";
import { loadAttachments, backgroundBlock } from "./attachments.ts";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const { settings: S, profile } = loadSettingsOrExit(args);
const fileArg = S.run.file ?? undefined;
const noAi = S.run.noAi;
const discard = S.run.discard;
const REFLEX_MODELS = [S.llm.reflex.model, ...S.llm.reflex.fallbacks];
const keyFile = expandHome(S.keys.file);
const NO_KEY = new Set(["script", "scripted"]);   // offline test doubles: providers that need no API key
const keys = requireKeys([...new Set([S.stt.provider, ...(noAi ? [] : [parseModelRef(S.llm.reflex.model).provider as any, ...(S.summary.enabled ? [parseModelRef(S.summary.model).provider as any] : [])])])].filter((k) => !NO_KEY.has(k)), keyFile);
for (const v of KEY_ENV_VARS) delete process.env[v];   // keys now live in `keys` (memory) only: no child of this process (audiotee, ffmpeg...) inherits them
const registry = new ModelRegistry(keys);

/** S2: consent line. Names the cloud processing and the AI assistant, and offers an opt-out (settings privacy.consentText). */
export const CONSENT_SAY = S.privacy.consentText;
const CONTROL = process.env.WINGMAN_CONTROL === "1";
/** Hebrew label for a channel, used in health texts. */
const chHe = (c: string) => (c === "me" ? "(המיקרופון שלך)" : "(הצד השני)");
/** Call phase for the answer window: written into call.json at each change (best effort, like every CallLog write). */
function setPhase(phase: "starting" | "waiting" | "live" | "ended", extra: Record<string, unknown> = {}) { try { log.update({ phase, ...extra }); } catch { /* best effort */ } }
/** Status line for the menu-bar app: "@@wingman {json}" on its own line (the leading newline keeps it off any half-written log line). Only in control mode. */
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
const attachFiles = noAi || noBrief ? [] : loadAttachments(S.attachments.maxChars, { consume: !fileArg });   // a practice call with the plan never uses up the real call's files
const background = backgroundBlock(attachFiles);
const prefix = buildPrefix(houseStyle, bank, "", background);
let log: CallLog;
try { log = new CallLog({ mode: fileArg ? "file" : "live", file: fileArg, model: S.llm.reflex.model, fallbacks: S.llm.reflex.fallbacks, stt: `${S.stt.provider} ${S.stt.model} ${S.stt.language}`, sttFallback: S.stt.fallback, profile, noAi, discard });
} catch (e) {
  console.error(`Wingman cannot save this call: cannot create the calls folder (${(e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message}). Check free disk space and the folder permissions: ${CALLS}`);
  process.exit(2);
}
log.onWriteFail = (e) => { try { health("disk", "amber", "לא ניתן לשמור את השיחה בדיסק (אין מקום?). השיחה ממשיכה, אבל ההקלטה והסיכום עלולים להיות חלקיים. פנה מקום בדיסק", String(e?.message ?? e)); } catch {} };
const cost = new CostMeter(S.budget.prices, S.budget);
const sup = new HealthSupervisor({ tickMs: S.health.tickMs, recoverStableMs: S.health.recoverStableMs, slowMs: S.llm.reflex.slowMs, slowSttMs: S.health.slowSttMs, minSamples: S.health.minSamples });
sup.set({ noAi, bankFailed: bank.length === 0 });
setPhase("starting");
status("mode", { noAi });   // effective AI mode for the app (the setting or --no-ai)
const breakers = new Map(REFLEX_MODELS.map((m) => [m, new CircuitBreaker({ failures: S.llm.circuit.failures, windowMs: 10_000, cooldownMs: S.llm.circuit.cooldownMs })]));
const downUntil = new Map<string, number>();   // model -> epoch ms until which it is skipped (provider spend cap: 6 h; Infinity = failed to load at start)

/** Card kinds. "info"/"warn"/"tip" are system cards; "me" is an answer for the user's own question. */
type Badge = "bank" | "ai" | "stall" | "info" | "warn" | "tip" | "me" | "careful" | "fix";
/** One row of cards.jsonl as the answer window sees it. Same id = update of that card; withdraw = remove it; clear (health only) = remove the bar. */
type Card = {
  tipType?: string;
  id: string; turnId: string; badge: Badge; question: string; say: string; facts: string[]; dim?: boolean; at: number;
  health?: boolean; level?: "red" | "amber" | "info"; clear?: boolean; withdraw?: boolean;
  forMe?: boolean; source?: "calc" | "ai";   // badge "me": an answer for the user (their own question). source "calc" on an "ai" card: local arithmetic, no model
  priority?: boolean;   // "don't commit yet" bank cards (stall-price, stall-guarantee…): never hidden by the per-minute cap
};
const transcript: (TimedLine & { ch: Channel; who?: SpeakerInfo })[] = [];
const speakers = new SpeakerBook();   // the other side's voices (stt.speakers), numbered per call
/** Name speaker `spk` for the rest of the call (source "intro" = from their own introduction, "user" = the user renamed them). The
 *  answer window and the dashboard follow the cards.jsonl "speaker" row; later transcript rows carry the name. */
function nameSpeaker(spk: number, name: string, source: "intro" | "user") {
  if (!Number.isInteger(spk) || spk < 1 || spk > 20) return;
  if (source === "intro" && (speakers.isManual(spk) || speakers.name(spk))) return;
  const clean = name.replace(/[\u0000-\u001f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 40);
  speakers.setName(spk, clean, source === "user");
  log.write("cards", { type: "speaker", spk, name: clean, source });
  log.write("events", { type: "speaker.name", spk, source, named: !!clean });
  console.log(`\n[🗣 speaker ${spk}] ${clean || "(cleared)"} (${source})`);
}
const lineOf = (l: { ch: Channel; text: string; who?: SpeakerInfo }) => `${lineLabel(l.ch, l.who)}: ${l.text}`;
const contextNotes: string[] = [];
// Prepared start: a brief saved by `pnpm brief` (last 6 h), or --brief <file>; --no-brief skips it.
// A replay (--file) never consumes latest.yaml; it uses a brief only when --brief is given.
const brief: Brief | undefined = noBrief ? undefined : loadBrief(briefArg);
if (brief) contextNotes.push(...briefNotes(brief));
const attendees = attendeeNames(brief?.who);   // first names from the prepared meeting, for naming voices from their introductions
// Fact cards from the local client/domain snapshot.
const snapshot = S.facts.enabled ? loadSnapshot(join(ROOT, S.facts.file)) : undefined;
const spotter = snapshot ? new EntitySpotter(snapshot, { sslWarnDays: S.facts.sslWarnDays, minAliasLen: S.facts.minAliasLen }) : undefined;
const factsShown = new Set<string>();
let clientChosen = !!brief?.who, proposed: Fact | undefined;
/** Writes a side card (fact, note, reminder, client proposal) that is not tied to a question. */
function emitSide(row: Record<string, unknown>) {
  log.write("cards", { type: "card", turnId: "side", question: "", at: Date.now(), ...row });
}
/** Looks up clients/domains in the local snapshot for this text and emits a fact card once per fact. May propose the client for confirmation. */
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
/** The user confirmed the proposed client: its facts join the AI context notes (once). */
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
const notesAbort = new AbortController();   // also used by tips; aborted in shutdown(): no notes call outlives the call
let notesLines: string[] = [], notesBusy = false;
/** Timer job (notes.everyMs): turns the new transcript lines into up to 2 notes. Skips while busy, not consenting, AI down or budget capped; the lines are dropped (not retried) if the call fails. */
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
/** Must-cover items of the brief that no transcript line has touched yet. */
function uncovered(): string[] { return (brief?.mustCover ?? []).filter((i) => !covered(i, allText())); }
/** Timer job: after reminders.firstAfterMin, every everyMin, lists the brief items still not covered. */
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
  const t = transcript.filter((l) => now - l.at <= minutes * 60_000).slice(-maxLines).map(lineOf).join("\n");
  return t.length > 6000 ? t.slice(-6000) : t;
}
const framePct = (f: Frame) => { const p = progress(f); return `${p.done}/${p.total}`; };
/** Call-frame update: one model call that says what the call is about and which checklist items were covered. Single flight (returns the running promise).
 *  `final` = the last look at shutdown: ignores the shuttingDown check and needs fewer new words. */
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
/** Asks the model for one coaching tip. Rate-limited (30 s between tries, 30 new words, TipGate); the result is dropped if an answer card appeared meanwhile. */
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
/** Every 5 s: wrap-up nudge first, then the talk-ratio tip (at most every 10 min), then an AI tip. Silent in quiet mode. */
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
// Speakers mode: mic gate + echo text filter (echo.ts).
const ECHO = S.audio.echo;
// "auto" starts as "filter" (never mutes the user) and becomes "both" only once the output device is known to be speakers.
let echoMode: EchoMode = ECHO.mode === "auto" ? "filter" : ECHO.mode;
let useGate = echoMode === "gate" || echoMode === "both";
let useFilter = echoMode === "filter" || echoMode === "both";
function setEchoMode(m: EchoMode) { echoMode = m; useGate = m === "gate" || m === "both"; useFilter = m === "filter" || m === "both"; }
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
// `captured` dedupes per call.
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
// ---- Answers for the user's own questions (assist.*) ----
const meGate = new MeGate({ minGapMs: S.assist.minGapMs, maxPerMin: S.assist.maxPerMin, protectThemMs: S.assist.protectThemMs });
let lastThemSpeech = 0, meLat: { total: number; source: string }[] = [];
let lastThemCardAt = 0, lastThemSound = Date.now(), themSoundSeen = false, lastThemText = Date.now(), askUntil = 0, askTimer: NodeJS.Timeout | undefined, meSeq = 0, meShown = 0, foreignDropped = 0;
let meCurrent: AbortController | undefined;   // the running "me" answer; a newer question aborts it
// meTimers2 holds deferred "me" card retries (cleared in shutdown).
let themHeard: () => void = () => {};   // clears the "I only hear you" banner when the other side's audio or text returns
const meTimers2 = new Set<NodeJS.Timeout>();
let current: AbortController | undefined;   // the running answer for the other side; a new question aborts it
let quiet = S.cards.quiet, consented = false, shuttingDown = false;   // set by startForwarding() (at once when no consent click is needed)
const decided = new Map<string, { hidden: boolean; reason?: string }>(); // card id -> was it hidden from the overlay (a card keeps its first decision when it is updated, so it never flips)
// Cards that took a slot of the per-minute cap. A withdrawn card gives its slot back, and "buy time" lines never take one
// (3 Nov call: stall lines and replaced cards used up the cap, and the best answer of the call was hidden).
let shownTimes: { id: string; t: number }[] = [];
const turnsWithCard = new Set<string>();

/** The single exit for every card. Sanitizes text, decides hidden (quiet mode, or the per-minute cap unless priority), appends to cards.jsonl
 *  (hidden cards are logged too, flagged) and prints to the terminal. Health/info/tip cards are never hidden or counted. */
// "Important cards only" (cards.focus): 2 cards per 2 minutes, and only for clear questions. The detector's weaker cues ("head": a
// question word at the start, 124 of 225 detections on 3 Nov, mostly statements) do not count; price/date cards and cards about
// what the user said are not affected.
const capMax = () => (S.cards.focus ? Math.min(2, S.cards.maxPerMinute) : S.cards.maxPerMinute);
const capWindow = () => (S.cards.focus ? 120_000 : S.cards.windowMs);
function focusWorthy(text: string, reason: string): boolean { return isClearQuestion(text, reason) || !!matchBankFor(text, bank)?.card.id.startsWith("stall-"); }
function emitCard(c: Card) {
  c.say = sanitize(c.say); c.facts = c.facts.map(sanitize);
  const special = c.health || c.badge === "info" || c.badge === "tip";
  const forMe = c.badge === "me";   // answers to the user's own questions: hidden in quiet mode, but never counted against (or hidden by) the per-minute cap of cards for the other side
  let hidden = false, reason: string | undefined;
  if (c.withdraw) shownTimes = shownTimes.filter((s) => s.id !== c.id);
  if (!special) {
    const prev = decided.get(c.id);
    if (prev) { hidden = prev.hidden; reason = prev.reason; }
    else {
      const now = Date.now();
      shownTimes = shownTimes.filter((s) => now - s.t < Math.max(S.cards.windowMs, capWindow()));
      if (quiet) { hidden = true; reason = "quiet"; }
      else if (forMe || c.badge === "careful" || c.badge === "fix" || c.badge === "stall") { /* no cap, not counted */ }
      else if (shownTimes.filter((s) => now - s.t < capWindow()).length >= capMax() && !c.priority) { hidden = true; reason = "cap"; }
      else shownTimes.push({ id: c.id, t: now });
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
  if (!hidden && !c.withdraw && (c.badge === "bank" || c.badge === "ai" || c.badge === "stall")) lastThemCardAt = Date.now();      // a fresh answer for the other side: answers for the user must not push it off the screen
  const badge = { bank: "📗 prepared", ai: "🤖 AI", stall: "⏸ buy time", info: "ℹ️ info", warn: "⚠️ HEALTH", tip: "💡 tip", me: "🙋 for you", careful: "🟠 careful", fix: "🔴 correction" }[c.badge];
  console.log(`\n[${badge}${c.dim ? " · dimmed" : ""}${hidden ? ` · HIDDEN (${reason})` : ""}] ${c.say}${c.facts.length ? "\n   • " + c.facts.join("\n   • ") : ""}`);
}

/** Health bar in the answer window (and a status line for the tray). One bar per id; the same id replaces the old text. Clear it with healthClear. */
function health(id: string, level: "red" | "amber" | "info", text: string, note?: string) {
  console.log(`\n${level === "red" ? "🔴" : level === "amber" ? "🟠" : "ℹ️ "} ${text}`);
  status("health", { id, level, text });
  log.write("events", { type: "health", id, level, text, note });
  emitCard({ id: `health-${id}`, turnId: "health", badge: "warn", health: true, level, question: "", say: text, facts: [], at: Date.now() });
}
/** Removes the health bar `id`. */
function healthClear(id: string) {
  log.write("events", { type: "health.clear", id });
  status("health.clear", { id });
  emitCard({ id: `health-${id}`, turnId: "health", badge: "warn", health: true, clear: true, question: "", say: "", facts: [], at: Date.now() });
}

// One row per question; also written to latency.jsonl. Times are epoch ms: speechEnd (when they stopped talking), finalAt, bankAt/stallAt/cardAt, tagAt...
const latRows: Record<string, number | string>[] = [];
function recordLatency(lat: Record<string, number | string>) { latRows.push(lat); log.write("latency", lat); }

/** One-line speed summary: speech end -> first card on screen, bank cards, and Haiku first tag. */
function speedSummary(): string {
  const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN; };
  const ms = (n: number) => (Number.isFinite(n) ? `${(n / 1000).toFixed(1)}s` : "-");
  const since = (k: string) => latRows.filter((l) => typeof l[k] === "number").map((l) => (l[k] as number) - (l.speechEnd as number));
  const first = latRows.map((l) => Math.min(...["bankAt", "stallAt", "cardAt"].map((k) => (typeof l[k] === "number" ? (l[k] as number) : Infinity))) - (l.speechEnd as number)).filter(Number.isFinite);
  const bank = since("bankAt"), tag = since("tagAt");
  return `Speed: ${latRows.length} questions · first card p50 ${ms(pct(first, 50))} / p95 ${ms(pct(first, 95))} · Prepared cards ${bank.length} (p50 ${ms(pct(bank, 50))}) · Haiku first tag p50 ${ms(pct(tag, 50))}${meLat.length ? ` · For you ${meLat.length} answers (speech end to card p50 ${ms(pct(meLat.map((m) => m.total), 50))} / p95 ${ms(pct(meLat.map((m) => m.total), 95))}${meLat.some((m) => m.source === "calc") ? `, math p50 ${ms(pct(meLat.filter((m) => m.source === "calc").map((m) => m.total), 50))}` : ""})` : ""}`;
}

let lastAgencyTopicAt = 0;
/** A question from the other side. Order of work:
 *  1. calc: pure arithmetic is answered locally, no model.
 *  2. bank: a keyword match shows a prepared card at once (dimmed when "weak").
 *  3. no usable AI (degraded rungs): a stall line if nothing matched.
 *  4. AI: a stall timer (reflex.stallAfterMs) shows "buy time" if nothing is up yet; meanwhile the model streams a tag
 *     (BANK / ANS / STALL / SKIP) that can confirm, replace or withdraw the card, then the answer text, which passes the guards.
 *  A newer question aborts this one (`current`). Answers older than reflex.dropStaleMs are never shown (`fresh`). `reason` is the detector's reason string. */
function onQuestion(r: SttResult, reason = "") {
  if (S.cards.focus && !focusWorthy(r.text, reason)) { log.write("events", { type: "focus.skip", reason, text: r.text.slice(0, 120) }); return; }
  const turnId = `q${++turnSeq}`;
  const speechEnd = r.speechEndWall ?? r.arrivedAt;
  const lat: Record<string, number | string> = { turnId, speechEnd, finalAt: r.arrivedAt, text: r.text };
  const fresh = () => Date.now() - speechEnd < S.reflex.dropStaleMs;
  const meSpokeSince = () => lastMeVoiced > speechEnd;
  current?.abort();
  const ac = (current = new AbortController());
  // Not a client / support call (frame, after hysteresis) and the question is not about the user's web / hosting services: Wingman never
  // speaks for the user here. No agency bank card and no stall line, whatever the keywords say (team meeting, interview, friend, supplier).
  // A short follow-up ("יהיה מוכן?", "את הדומיין?") has no topic word of its own: it counts as agency talk for 60 s after one that did (the frame can also guess "vendor" wrongly).
  const agencyTopic = isAgencyTopic(r.text), agencyRecent = Date.now() - lastAgencyTopicAt < 60_000;
  if (agencyTopic) lastAgencyTopicAt = Date.now();
  const noAgency = !!tracker.kind && !isAgencyKind(tracker.kind) && !agencyTopic && !agencyRecent;
  const hit = noAgency ? undefined : matchBankFor(r.text, bank);   // stall-price is dropped for arithmetic and for prices that are not the user's services
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
  // A prepared meeting with background files: a general topical card (SEO basics, "move a site") may be the wrong card for this meeting,
  // so it shows dimmed and an AI answer from the background replaces it (3 Nov: "old links and Google ranking" got the generic SEO card).
  const bgBank = !!background && !!hit && !STALL_TIER.has(hit.card.id);
  const weakBank = offKind && !!hit && !STALL_TIER.has(hit.card.id) && !agencyTopic && !agencyRecent;
  // weak = a bank card may be the wrong card, so it is dimmed and the model may withdraw it. Before the first call frame a topical card
  // may belong to a call that is not a customer call.
  const weak = (reason.startsWith("head:") && !(hit && hit.score >= 2)) || reason.startsWith("problem") || weakBank || (!tracker.kind && !!hit && !STALL_TIER.has(hit.card.id) && !agencyTopic && !agencyRecent) || bgBank;
  const bankOnly = reason.startsWith("problem");                              // a "problem" is a guessed question (not a clear one): never an AI answer on it

  // Degradation ladder (health.ts): the rung in force for this question (it only changes between questions).
  // beginQuestion/endQuestion tell the supervisor a question is in flight, so it does not change rung mid-answer.
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
  // If neither the bank nor the model has put a card up by then, show the "buy time" line so the user is never left with a blank screen.
  const stallTimer = setTimeout(() => {
    if (ac.signal.aborted) return;
    if (!shown && !noAgency && fresh()) { shown = { id: stallId, turnId, badge: "stall", question: r.text, say: stallSay(stall, turnSeq), facts: [], at: Date.now() }; emitCard(shown); lat.stallAt = Date.now(); }
  }, S.reflex.stallAfterMs);

  const ai: Card = { id: `${turnId}-ai`, turnId, badge: "ai", question: r.text, say: "", facts: [], at: 0 };
  const recent = transcript.slice(-12).map(lineOf).join("\n");
  lat.reqAt = Date.now();
  runReflex({
    registry, models: usable, cfg: S.llm.reflex, prefix, transcript: recent, question: r.text, context: contextNotes, signal: ac.signal,
    frame: frameText(tracker.current) || undefined, weakBank: weakBank ? hit!.card.id : undefined, noAgency,
    onFail: (model, err) => llmFailed(model, err),
    onSwitch: (from, to, err) => { log.write("events", { type: "llm.switch", turnId, from, to, kind: err.kind }); console.log(`\n↪ AI ${from} -> ${to} (${describe(err)})`); },
    h: {
      // The model's first token: its decision for this question. The code, not the prompt, enforces the stall tier and the off-topic gate.
      onTag(tagIn: Tag) {
        let tag = tagIn;
        if (ac.signal.aborted) return;
        lat.tagAt = Date.now(); lat.tag = tag.kind + (tag.bankId ? ` ${tag.bankId}` : "");
        sup.recordTag(Number(lat.tagAt) - Number(lat.reqAt));
        if (!modelMayOverrideBank(hit?.card.id, tag)) {
          clearTimeout(stallTimer); log.write("events", { type: "stall-tier.kept", turnId, tag: tag.kind + (tag.bankId ? ` ${tag.bankId}` : ""), bank: hit?.card.id });
          lat.tag = `${lat.tag} (ignored: ${hit?.card.id} stays)`; modelIgnored = true; return;
        }
        // Off-kind call, not about the user's services: BANK and STALL are not for this question. The code enforces what the prompt asks.
        if (noAgency && (tag.kind === "STALL" || tag.kind === "BANK")) {
          clearTimeout(stallTimer); modelIgnored = true; lat.tag = `${lat.tag} (gated: ${tracker.kind})`;
          log.write("events", { type: "agency.gated", turnId, kind: tracker.kind, tag: tag.kind, model: true }); return;
        }
        if (tag.kind === "ANS" && !allowAns) { tag = { kind: "STALL" }; lat.tag = "STALL (ans-off)"; log.write("events", { type: "ans.suppressed", turnId, rung: sup.rung }); }
        // Off-kind call: the model prefers an answer or a stall over the weak keyword card, so that card goes away.
        if ((weakBank || bgBank) && shown?.badge === "bank" && shown.turnId === turnId && (tag.kind === "ANS" || tag.kind === "STALL")) { emitCard({ ...shown, withdraw: true }); log.write("events", { type: "withdraw", turnId, why: "off-kind" }); shown = undefined; }
        if (tag.kind === "SKIP") {
          clearTimeout(stallTimer);
          if (shown?.id === stallId) { emitCard({ ...shown, withdraw: true }); log.write("events", { type: "withdraw", turnId, why: "stall-then-skip" }); shown = undefined; }
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
      // Full answer text is ready: guard it, then show it (a guard hit becomes a stall line instead).
      onSayComplete(say) {
        if (ac.signal.aborted || modelIgnored) return;
        ai.say = say;
        // A late answer still replaces the "buy time" line already on screen for this question; otherwise a stale answer is dropped.
        if (!/^(ANS|BANK)/.test(String(lat.tag ?? "")) || (!fresh() && shown?.id !== stallId)) return;
        if (String(lat.tag).startsWith("BANK") && shown?.badge === "bank") return; // bank card already up
        // The model leaked its own control words into the say-line ("... לכן SKIP עדיף כרגע"): it was not sure, so no card.
        if (leakedTag(ai.say)) {
          clearTimeout(stallTimer); modelIgnored = true; log.write("events", { type: "reflex.discard", turnId, why: "leaked-tag" });
          if (shown?.id === stallId) { emitCard({ ...shown, withdraw: true }); shown = undefined; }
          return;
        }
        const g = guard(ai.say);
        if (!g.ok) log.write("events", { type: "guard", turnId, rule: g.rule });
        if (!g.ok && noAgency) { clearTimeout(stallTimer); return; }   // a blocked answer on a call that is not with a customer: nothing, never a stall line
        const card: Card = g.ok ? { ...ai, at: Date.now() } : { ...ai, id: stallId, badge: "stall", say: stallSay(stall, turnSeq), facts: [], at: Date.now() };
        if (meSpokeSince()) card.dim = true;
        clearTimeout(stallTimer);
        // The "buy time" line went up while the model was still deciding; the real answer replaces it (never both on screen).
        if (g.ok && shown?.id === stallId) emitCard({ ...shown, withdraw: true });
        shown = card; emitCard(card); lat.cardAt = Date.now();
      },
      // Stream finished: book the cost, mark the model healthy, and upsert the card with its (guarded) facts.
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
    if (kind !== "refusal" && ++reflexErrors >= 2) health("ai", "amber", "AI לא עונה: מוצגים רק כרטיסים מוכנים מראש. בדוק חיבור לאינטרנט ומפתח ב-Settings", String(e?.message ?? e));
  }).finally(end);
}

// ---- Answers for the user's own questions ("me" channel) ----
// A "me" card is only for the user. Whether a line is for Wingman or for the other person is decided by audienceByCues (rules),
// then a quick classifier model when unsure and the other side is talking; MeGate rate-limits the cards.
const ONLY_YOU_TEXT = "אני שומע רק אותך. כדי לקבל תשובות גם לצד השני, הצטרף לשיחה או הפעל את השמע שלה. אפשר לשאול אותי כל דבר: Ctrl+Opt+A";
const isSolo = () => !themSoundSeen && !transcript.some((l) => l.ch === "them");
/** Answers for the user need a working model and budget; they do NOT need the other side to be heard (rung 4 still allows them). */
const canMeAi = () => !noAi && consented && !shuttingDown && sup.caps.meAns && usableModels().length > 0 && cost.llmState() !== "capped";
const meLog = (turnId: string, text: string, decision: string, why: string, extra: Record<string, unknown> = {}) => log.write("events", { type: "me.decision", turnId, text, decision, why, ...extra });

/** Ctrl+Opt+A / the "ask" control command: the next thing the user says (within assist.askWindowMs) is a question for Wingman. */
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
/** Ends the ask window ("used" = a question took it; "timeout" = nothing came). */
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

// ---- Self-check: cards about what the user himself said (selfcheck.ts) ----
const selfGate = new SelfCheckGate({ minGapMs: S.selfCheck.minGapMs });
let selfSeq = 0;
const selfEvent = (type: string, extra: Record<string, unknown> = {}) => log.write("events", { type, ...extra });
/** A final "me" line that is not a question for Wingman: amber card on price / date / promise (no AI), red card on a contradiction of the briefing (cheap model). */
function selfCheckLine(text: string) {
  const sc = S.selfCheck;
  if (!sc.enabled || !consented || shuttingDown) return;
  if (text.split(/\s+/).filter(Boolean).length < MIN_WORDS) return;
  const now = Date.now();
  if (sc.careful) {
    const c = detectCareful(text);
    if (c) {
      if (selfGate.canCareful(now)) {
        selfGate.noteCareful(now); const n = ++selfSeq;
        emitCard({ id: `sc-${n}`, turnId: `sc${n}`, badge: "careful", question: c.question, say: c.say, facts: [], priority: true, at: now });
        selfEvent("selfcheck.careful", { kind: c.kind });
      } else selfEvent("selfcheck.skip", { why: "careful-gap" });
    }
  }
  if (!sc.fix) return;
  if (!background.trim()) return;   // no prepared meeting: nothing to check against
  if (!looksFactual(text)) return;
  if (noAi || !sup.caps.llm || cost.llmState() === "capped") { selfEvent("selfcheck.skip", { why: noAi ? "no-ai" : "ai-unavailable" }); return; }
  if (!selfGate.canModel(now)) { selfEvent("selfcheck.skip", { why: "busy-or-gap" }); return; }
  selfGate.startModel(now);
  void (async () => {
    try {
      const r = await runSelfCheck({ registry, model: S.tips.model, cache: S.llm.reflex.cache, background, transcript: recentTranscript(S.frame.windowMin), line: text, signal: notesAbort.signal, timeoutMs: sc.timeoutMs });
      const cu = cost.addLlm("selfcheck", S.tips.model, r.usage, r.providerMetadata);
      log.write("usage", { role: "selfcheck", model: S.tips.model, usage: r.usage, usd: cu.usd });
      if (shuttingDown) return;
      const v = r.verdict;
      if (v.verdict === "ok") { selfEvent("selfcheck.ok"); return; }
      const g = checkFix(v);
      if (!g.ok) { selfEvent("selfcheck.skip", { why: "guard", rule: g.rule }); return; }
      const t = Date.now();
      if (!selfGate.canFix(t, v.correct)) { selfEvent("selfcheck.skip", { why: "fix-gap-or-repeat" }); return; }
      selfGate.noteFix(t, v.correct); const n = ++selfSeq;
      emitCard({ id: `sc-${n}`, turnId: `sc${n}`, badge: "fix", question: v.said, say: v.correct, facts: v.source ? [v.source] : [], priority: true, at: t });
      selfEvent("selfcheck.fix", {});
    } catch (e) { selfEvent("selfcheck.error", { error: String((e as Error)?.message ?? e).slice(0, 200) }); }
    finally { selfGate.endModel(); }
  })();
}

/** A "me" utterance has ended. Decide whether it is a question for Wingman and answer it. */
function handleMe(joined: SttResult) {
  const text = joined.text.trim();
  if (!text || shuttingDown || !consented) return;
  const speechEnd = joined.speechEndWall ?? joined.arrivedAt;
  const nWords = text.split(/\s+/).filter(Boolean).length;
  const forced = askUntil > 0 && speechEnd <= askUntil + 1500 && nWords >= 2;   // the ask key was pressed: this is for Wingman
  if (forced) disarmAsk("used");
  if (!forced) selfCheckLine(text);   // what he said himself (not an ask to Wingman); a tag question ("יש לכם 200 עמודים, נכון?") is still a claim
  const mode = S.assist.answerMe;
  if (!forced && mode !== "always") return;
  const math = evalMath(text);
  const d = detect(text);
  if (!forced && !d.isQuestion && !math) return;
  log.write("events", { type: "me.detect", text, forced, reason: forced ? "hotkey" : math ? "math" : d.reason });
  void onMeQuestion(joined, forced).catch((e) => log.write("events", { type: "me.error", error: String((e as Error)?.message ?? e).slice(0, 200) }));
}

/** Answers one "me" question. `forced` = the ask key / typed ask was used, so it is surely for Wingman and may wait for a protected card slot.
 *  Steps: 1 audience decision (rules, maybe classifier in parallel with the answer), 2 show gate (meGate, stale check), 2a arithmetic, 2b model. */
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
  const settle = async (): Promise<boolean> => {           // true = answer for the user
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
    registry, models: usable, cfg: S.llm.reflex, prefix, transcript: transcript.slice(-12).map(lineOf).join("\n"), question: text, context: contextNotes, signal: ac.signal,
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
        // The user pressed the ask key (or typed `ask`) and nothing came back: say so, never leave an empty screen.
        if (forced && !cardOut && !shownOnce) { meLog(turnId, text, "unsure", "forced-no-answer"); show("לא בטוח — נסה לנסח שוב", [], "ai"); }
      },
    },
  }).catch((e: ProviderError) => { if (!dead()) log.write("events", { type: "me.error", turnId, kind: e?.kind ?? "unknown", error: String(e?.message ?? e).slice(0, 200) }); });
}

let reflexErrors = 0;   // consecutive reflex failures; 2 in a row raise the "AI not answering" bar, a success clears it
/** Models whose breaker lets a request through, in configured order. */
function usableModels(): string[] {
  const now = Date.now();
  return REFLEX_MODELS.filter((m) => (downUntil.get(m) ?? 0) <= now && breakers.get(m)!.allow());
}
/** Reflex failure hook: opens the model's circuit breaker (hard = auth/quota/spend cap/unsupported opens it for longer), parks a spend-capped model for 6 h, tells the supervisor, shows a bar for hard errors. */
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

// Buffer is_final segments per channel and handle the joined utterance on speech_final (or a short fallback timer, stt.flushFallbackMs,
// for when the end-of-speech mark never arrives).
type Pending = { texts: string[]; words: Word[]; last: SttResult; timer?: NodeJS.Timeout; spk?: number };
const pending: Partial<Record<Channel, Pending>> = {};
let lastThem: (PrevUtterance & { spk?: number }) | undefined;   // S10: the previous client utterance, for split questions
/** Handles one buffered utterance: "me" -> handleMe; "them" -> glue split questions, split merged ones, detect, onQuestion. */
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
  // Glue the previous short fragment only when that turns a non-question into a question (a split question: "כמה זה" ... "עולה לחודש?").
  // Never glue two different voices: one person's fragment is not the start of another person's question.
  const otherVoice = p.spk !== undefined && lastThem?.spk !== undefined && p.spk !== lastThem.spk;
  const glued = otherVoice || (d.isQuestion && !isBareQuestionTail(joined.text, d.reason)) ? joined.text : joinSplit(lastThem, joined.text, startWall, S.stt.joinWindowMs);
  if (glued !== joined.text) {
    const g = detectText(glued);
    if (g.d.isQuestion) { log.write("events", { type: "split.join", prev: lastThem?.text, text: joined.text }); joined.text = glued; hit = g.hit; d = g.d; }
  }
  lastThem = { text: joined.text.split(/\s+/).slice(-30).join(" "), at: endWall, question: d.isQuestion, spk: p.spk };
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

// Words while they are spoken: interim STT text goes to live.jsonl (at most 4 rows a second per channel) for the answer window's
// live strip. The final line in transcript.jsonl replaces it. live.jsonl is deleted when the call ends (the transcript has it all).
const lastPartialAt: Partial<Record<Channel, number>> = {};
function livePartial(r: SttResult) {
  if (!r.text || !consented || shuttingDown || !S.overlay.showLastLine) return;
  const now = Date.now();
  if (now - (lastPartialAt[r.channel] ?? 0) < 250) return;
  if (S.stt.dropForeignScript && !checkScript(r.text).ok) return;
  lastPartialAt[r.channel] = now;
  const who = r.channel === "them" && S.stt.speakers ? speakers.of(r.words) : undefined;
  log.write("live", { ch: r.channel, text: r.text.slice(-300), ...(who ? { spk: who.spk, ...(who.name ? { name: who.name } : {}) } : {}) });
}

/** Every STT result (both channels). Only finals matter. Drops foreign-script junk, logs, then routes "me" lines through the echo filter delay. */
function onResult(r: SttResult) {
  if (!r.isFinal) { livePartial(r); return; }
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
  // "me" lines wait briefly so the client line they may echo has arrived (the two channels' finals are not time-ordered), then go through the echo filter.
  // (No wait when the other side has not spoken within the filter window: there is nothing the mic could be echoing.)
  if (r.channel === "me" && r.text && useFilter && !shuttingDown && Date.now() - lastThemSpeech < ECHO.filterWindowMs + ECHO.filterDelayMs) {
    const t = setTimeout(() => { meTimers.delete(t); acceptResult(r, true); }, ECHO.filterDelayMs);
    meTimers.add(t); return;
  }
  acceptResult(r, false);
}
const meTimers = new Set<NodeJS.Timeout>();   // pending echo-filter delays (cleared in shutdown)
/** Takes a final into the call: echo drop, side features (capture, facts, notes), transcript, then buffers it for flush(). */
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
    let who = r.channel === "them" && S.stt.speakers ? speakers.of(r.words) : undefined;
    // "היי, אני רות מצוות ה-IT" / "I'm Dana": the voice that introduces itself gets that name (the meeting's attendees first).
    if (who && !who.name) { const n = introName(r.text, attendees); if (n) { nameSpeaker(who.spk, n, "intro"); who = speakers.of(r.words); } }
    if (notesOn) notesLines.push(lineOf({ ch: r.channel, text: r.text, who }));
    if (r.channel === "me" && r.text.length >= 6 && r.text.split(/\s+/).length >= 2) lastMeVoiced = Date.now();
    transcript.push({ ch: r.channel, text: r.text, at: Date.now(), ...(who ? { who } : {}) });
    { const n = wordCount(r.text); frameWords += n; tipWords += n; }
    log.write("transcript", { ch: r.channel, text: r.text, words: r.words, ...(who ? { spk: who.spk, ...(who.name ? { name: who.name } : {}) } : {}) });
    // A different voice starts a new turn: never glue two people's words into one question.
    if (who && pending[r.channel] && pending[r.channel]!.spk !== undefined && pending[r.channel]!.spk !== who.spk) flush(r.channel);
    const p = (pending[r.channel] ??= { texts: [], words: [], last: r });
    if (who) p.spk = who.spk;
    p.texts.push(r.text); p.words.push(...r.words); p.last = r;
    clearTimeout(p.timer); p.timer = setTimeout(() => flush(r.channel), S.stt.flushFallbackMs);
    // The user's own question: do not wait for the end-of-speech mark or the fallback timer when the text already ends in "?" or is a sum.
    if (r.channel === "me" && S.assist.answerMe !== "off" && (/\?\s*$/.test(r.text) || evalMath(p.texts.join(" ")))) { flush("me"); return; }
  }
  if (r.speechFinal) flush(r.channel);
}

// Single-key input (terminal mode only; with WINGMAN_CONTROL the tray uses stdin lines instead): Enter = consent, q = quiet, a = ask, n = note, y = confirm client, Ctrl+C = stop.
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
/** Quiet mode: cards are still saved to cards.jsonl but flagged hidden, so the answer window shows nothing. Reversible mid-call. */
function toggleQuiet(on = !quiet) {
  if (on === quiet) return;
  quiet = on; log.write("events", { type: "quiet", on: quiet });
  quiet ? health("quiet", "info", "מצב שקט: הכרטיסים נשמרים אבל לא מוצגים. לחזרה כבה את Quiet mode בתפריט") : healthClear("quiet");
  console.log(`\nquiet ${quiet ? "ON: cards are logged, not shown" : "OFF"}`);
  status("quiet", { on: quiet });
}
const typedNotes: string[] = [], MAX_TYPED_NOTES = 20, MAX_TYPED_NOTE_CHARS = 4096;
/** A typed context note for the AI (instant-start mode). Added to every prompt via contextNotes; capped so a long call cannot grow the prompt without bound. */
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
/** Menu-bar app commands (WINGMAN_CONTROL=1): one per line on stdin. A closed stdin means the app is gone: stop cleanly (saves the call). */
function setupControl(onConsent: () => void) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const [cmd, ...rest] = line.trim().split(" ");
    if (cmd === "consent") onConsent();
    else if (cmd === "quiet") toggleQuiet(rest[0] === "on" ? true : rest[0] === "off" ? false : undefined);
    else if (cmd === "client") confirmClient();
    else if (cmd === "ask") { const q = rest.join(" ").trim(); if (q) askTyped(q); else armAsk(); }   // "ask" = the hotkey; "ask <text>" = a typed question (wingman CLI)
    else if (cmd === "note") addNote(rest.join(" "));
    else if (cmd === "speaker") { const n = Number(rest[0]); if (Number.isInteger(n)) nameSpeaker(n, rest.slice(1).join(" "), "user"); }   // "speaker 2 Dana": the user renamed a voice
    else if (cmd === "stop") void shutdown();
    else if (cmd === "stop-no-summary") { skipSummaryNow(); void shutdown(); }   // `wingman stop --no-summary`: keep the call, skip the summary
    else if (cmd === "skip-summary") { if (shuttingDown) skipSummaryNow(); }      // the "Skip summary" button while the summary is being written
    else if (cmd === "stop-delete") { discardNow = true; void shutdown(); }
  });
  rl.on("close", () => void shutdown());   // the menu-bar app went away: stop cleanly
}
// Typed context note state (terminal key `n`): undefined = not typing.
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
/** Waits up to `ms` for one key press (the delete-this-call question). Resolves "" on timeout. */
const askKey = (ms: number) => new Promise<string>((res) => { const t = setTimeout(() => { keyWaiter = undefined; res(""); }, ms); keyWaiter = (k) => { clearTimeout(t); res(k); }; });

let stops: (() => Promise<void>)[] = [];   // audio source stoppers, run first in shutdown()
let me: SttChannel, them: SttChannel;
let crashed = false;

/** Skip the summary for this stop: aborts the model call if it is running, and shutdown() moves on. The call stays saved (write it later with `wingman calls summary <id> --generate`). */
let summarySkipped = false, summaryDone = false;
const summaryAbort = new AbortController();
let wakeSkip: () => void = () => {};
const summarySkipWait = new Promise<void>((res) => { wakeSkip = res; });
function skipSummaryNow() {
  if (summarySkipped) return;
  summarySkipped = true; summaryAbort.abort(); wakeSkip();
  try { log.write("events", { type: "summary.skipped", reason: "user" }); } catch { /* best effort */ }
}
/** Post-call summary: one model call before the "delete this call?" question. Never blocks longer than summary.timeoutMs; errors are logged, not thrown. */
async function postCallSummary() {
  if (summarySkipped) { status("summary", { ok: false, skipped: true }); return; }
  try {
    log.write("events", { type: "context.snapshot", contextNotes, aiNotes: liveNotes });   // lets `pnpm summary <id>` rebuild the same input later
    const r = await runSummary({
      dir: log.dir, callId: log.id, S, registry, cost, noAi, signal: summaryAbort.signal, discard: discard || discardNow, crashed,
      data: { lines: transcript.map((l) => ({ ch: l.ch, text: l.text, ...(l.who ? { who: l.who.name ?? `Speaker ${l.who.spk}` } : {}) })), contextNotes, aiNotes: liveNotes, frame: tracker.current },
      write: (stream, row) => log.write(stream, row),
    });
    if (summarySkipped) { status("summary", { ok: false, skipped: true }); return; }
    summaryDone = true;
    if (r.skipped) return;
    if (r.ok) console.log(formatShort(r.summary!)); else console.log(`\nSummary failed: ${r.error}`);
    status("summary", { ok: r.ok, id: log.id });
  } catch (e) { try { log.write("events", { type: "summary.error", error: String((e as Error)?.message ?? e) }); } catch {} }
}

/** The one exit path (stop command, Ctrl+C, SIGTERM/SIGHUP, idle stop, file end, crash, rung 5). Idempotent.
 *  Order: abort jobs and timers -> stop audio -> close STT -> write usage + endedAt (phase "ended") -> final frame look -> summary
 *  -> ask about deletion (terminal only) -> process.exit. call.json gets phase "ended" as soon as the call files are written (before the summary);
 *  the tray follows the {ev:"stopphase"} lines for progress. Watchdogs: 10 s force-exit if closing audio/sockets hangs (the mic must not stay open),
 *  16 s last-resort exit overall. The tray's own SIGINT (12 s) / SIGKILL (20 s) escalation comes after those. */
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true; current?.abort(); notesAbort.abort();
  status("stopphase", { phase: "saving" });   // the app shows: saving, then summary, then done (tray/lib.cjs STOP_PHASES)
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
    log.write("events", { type: "echo.summary", mode: echoMode, setting: ECHO.mode, gatedSeconds: Math.round(gatedMs / 1000), echoDropped });
    log.write("events", { type: "foreign.summary", dropped: foreignDropped });
    log.write("events", { type: "me.summary", mode: S.assist.answerMe, answers: meShown, questions: meSeq });
    if (foreignDropped) console.log(`\nDropped ${foreignDropped} speech-to-text lines in a foreign script (not Hebrew/English).`);
    log.write("usage", { role: "summary", llmUsd: cost.llmUsd, sttUsd: cost.sttUsd, totalUsd: cost.totalUsd, roles: cost.roles, unpriced: [...cost.unpriced] });
    const summary = speedSummary();
    log.write("events", { type: "speed.summary", summary });
    log.update({ endedAt: new Date().toISOString(), crashed, phase: "ended" });
    console.log(`\nSpeakers mode (${echoMode}): mic muted ${Math.round(gatedMs / 1000)} s while the client talked · ${echoDropped} echo lines dropped`);
    console.log(`\n${summary}\nCost: ${cost.line()} (estimate from settings budget.prices)\nSTT chunks dropped (socket not open): me ${me?.dropped ?? 0}, them ${them?.dropped ?? 0}`);
  } catch (e) { console.error("call summary failed:", e); try { log.write("events", { type: "shutdown.error", error: String((e as Error)?.stack ?? e) }); } catch {} }
  // (usage was logged twice on purpose: once above so the numbers exist even if the summary hangs, again below with the summary's own cost.)
  // One last frame look so the checklist result in the review is current (a few seconds at most, never when the call is discarded or crashed).
  if (frameOn && left() > 6000 && !crashed && !discard && !discardNow && cost.llmState() !== "capped") {
    await Promise.race([frameRound(true), new Promise((res) => setTimeout(res, Math.min(S.frame.timeoutMs + 500, left() - 5000)))]).catch(() => {});
    const f = tracker.current;
    if (f) log.write("events", { type: "frame.summary", kind: f.kind, done: progress(f).done, total: progress(f).total, missed: missedMust(f).map((m) => m.item) });
  }
  status("stopphase", { phase: "summary" });
  await Promise.race([postCallSummary(), summarySkipWait, new Promise((res) => setTimeout(res, Math.max(1500, left())))]);
  if (summarySkipped) status("summary", { ok: false, skipped: true });
  try { log.write("usage", { role: "summary", llmUsd: cost.llmUsd, sttUsd: cost.sttUsd, totalUsd: cost.totalUsd, roles: cost.roles, unpriced: [...cost.unpriced] }); } catch {}
  try { log.update({ endedAt: new Date().toISOString(), crashed, phase: "ended" }); } catch {}
  let del = discard || discardNow;
  if (!del && !crashed && process.stdin.isTTY) {
    process.stdout.write("\nDelete this call's saved text now? y = delete, any other key (or 10 s) = keep: ");
    del = (await askKey(10_000)).toLowerCase() === "y";
  }
  if (del) {
    try { rmSync(log.dir, { recursive: true, force: true }); if (!existsSync(join(CALLS, "latest"))) rmSync(join(CALLS, "latest"), { force: true }); } catch {}
    console.log(`\nDeleted ${log.dir}`);
  } else {
    console.log(`\nSaved ${log.dir}\nRate the cards: pnpm tag · delete later: pnpm purge ${log.id}`);
    // A long call's summary does not fit the ~12 s stop budget (3 Nov: 70 minutes, no summary). It is finished by a separate
    // background process that outlives this one (same code as `wingman calls summary <id> --generate`).
    if (!summaryDone && !summarySkipped && !crashed && !noAi && S.summary.enabled) {
      summaryAbort.abort();
      try {
        spawn(join(ROOT, "node_modules", ".bin", "tsx"), [join(ROOT, "src", "summary.ts"), log.id], { cwd: ROOT, detached: true, stdio: "ignore", env: childEnv() }).on("error", () => {}).unref();
        log.write("events", { type: "summary.background" });
        status("summary", { ok: false, background: true, id: log.id });
      } catch { /* the user can still run: wingman calls summary <id> --generate */ }
    }
  }
  if (!del) try { rmSync(join(log.dir, "live.jsonl"), { force: true }); } catch { /* best effort */ }
  status("stopphase", { phase: "done" });
  status("ended", { id: log.id, deleted: del, crashed });
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
  process.exit(crashed ? 1 : 0);
}

/** Fatal error path: print, log, then shut down in order to save what we have (crashed=true lands in call.json). A second crash during shutdown exits at once. */
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

/** Audio seconds sent per STT provider, both channels summed. Cost input. */
const sttSeconds = () => {
  const out: Record<string, number> = {};
  for (const c of [me, them]) for (const [k, v] of Object.entries(c?.audioSecondsByProvider() ?? {})) out[k] = (out[k] ?? 0) + v;
  return out;
};
let sttSwitchedCh = new Set<Channel>();   // channels that moved to the fallback STT provider (the ladder treats this as degraded)
let costWarned = false, minutesWarned = false;

/** Every health.tickMs: sleep detection, idle auto-stop, ladder signals, cost and call-length warnings, then the supervisor tick. */
let lastTick = Date.now(), sleepClearAt = 0, lastSpeechAt = Date.now(), idleWarned = false, consentedAt = 0;
function tickHealth() {
  // Y2: a long gap between ticks means the Mac slept (lid closed) mid-call.
  const now = Date.now(), gap = now - lastTick; lastTick = now;
  const gapMs = S.system.sleepGapMs ?? 0;
  if (gapMs > 0 && gap > gapMs + S.health.tickMs) {
    log.write("events", { type: "sleep.gap", ms: gap });
    health("sleep", "amber", `המחשב נרדם ל-${Math.round(gap / 1000)} שניות. חלק מהשיחה לא נשמע. אם פספסת משהו, בקש שיחזרו עליו`);
    sleepClearAt = now + 20_000;
  } else if (sleepClearAt && now > sleepClearAt) { sleepClearAt = 0; healthClear("sleep"); }
  // A call left running with nobody talking stops itself (a long real meeting is never cut while people speak).
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
  if (st === "warn" && !costWarned) { costWarned = true; health("cost", "amber", `עלות AI ${cost.line()}. אפשר להמשיך; לעצירה לחץ Stop call`); log.write("events", { type: "cost.warn", line: cost.line() }); }
  if (cost.minutesState() !== "ok" && !minutesWarned) { minutesWarned = true; health("minutes", "amber", `השיחה רצה ${cost.sttMinutes.toFixed(0)} דקות. אם היא הסתיימה, לחץ Stop call`); }
  sup.tick();
}
/** Ladder change handler: log it, show/clear the "ladder" bar, and at rung 5 (everything down) stop the call. */
function renderRung({ from, to, reasons }: { from: Rung; to: Rung; reasons: string[] }) {
  log.write("events", { type: "ladder", from, to, reasons, idle: sup.idle });
  const d = describeRung(to, reasons, sup.userChoiceOnly);
  if (from !== to) console.log(`\n⇅ ladder: rung ${from} -> ${to} (${reasons.join(", ") || "recovered"})`);
  if (!d) healthClear("ladder"); else health("ladder", d.level, d.text);
  if (to === 5) { console.log("Wingman is OFF: " + reasons.join(", ")); status("off", { reasons }); void shutdown(); }
}

/** One STT channel (own socket, provider chain with fallback and circuit breaker). Keys come from memory, not env. */
function makeChannel(ch: Channel): SttChannel {
  return new SttChannel({
    channel: ch, chain: sttChain(S).map(getSttProvider), keyOf: (id) => (NO_KEY.has(id) ? "none" : (keys as Record<string, string | undefined>)[id]),
    base: { diarize: ch === "them" && S.stt.speakers, language: S.stt.language, keyterms, endpointingMs: S.stt.endpointMs, utteranceEndMs: S.stt.utteranceEndMs, keepAliveMs: S.stt.keepAliveMs, model: S.stt.model },
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
          health(`stt-${ch}`, "red", `תמלול ${chHe(ch)} – ${describe(pe)}. בדוק את חיבור האינטרנט`);
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
        health(`stt-${name}`, "red", `תמלול ${chHe(name)} אין חיבור – ${describe(pe)}. מנסה שוב ושוב עד שיחזור. בדוק חיבור לאינטרנט`);
        void sttRetryLoop(ch, name); return;
      }
      if (!n) health(`stt-${name}`, "amber", `מתחבר לשירות התמלול (${name})…`);
      await new Promise((r) => setTimeout(r, Math.min(8000, 1000 * 2 ** n)));
    }
  }
}

/** Startup: open both STT channels, start timers, wire STT events to health bars, handle consent, then start the audio sources (or the replay file). */
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
  // All timers are unref'd: they never keep the process alive on their own.
  setInterval(() => void frameRound(), 5000).unref();
  setInterval(tipsTick, 5000).unref();
  setInterval(reminderTick, 30_000).unref();
  if (brief?.planId) log.write("events", { type: "plan.used", planId: brief.planId, title: brief.title ?? "" });   // which prepared meeting this call used (ids and names only)
  if (brief) console.log(`Brief loaded: ${[brief.who, brief.goal].filter(Boolean).join(" · ") || "(notes only)"}${brief.mustCover?.length ? ` · must cover: ${brief.mustCover.join(", ")}` : ""}`);
  console.log(spotter ? `Fact cards: ${spotter.size.clients} clients, ${spotter.size.domains} domains (snapshot ${snapshot?.generatedAt?.slice(0, 10) ?? "?"})` : "Fact cards: off (no snapshot at facts.file)");
  sup.tick();
  for (const s of [me, them]) {
    const ch = s === me ? "me" : "them";
    s.on("result", (r: SttResult) => { if (ch === "them" && r.isFinal && r.speechFinal && r.speechEndWall) sup.recordSttLag(r.arrivedAt - r.speechEndWall); onResult(r); });
    s.on("stt_error", (e: ProviderError) => { console.error("stt error", ch, e.message); log.write("events", { type: "stt.error", ch, kind: e.kind, error: e.message }); });
    s.on("keyterms_off", () => { console.log("keyterms off for this provider (open was rejected with them)"); log.write("events", { type: "stt.keyterms_off", ch }); });
    s.on("disconnected", (d) => health(`stt-${ch}`, "red", `תמלול ${chHe(ch)} התנתק – מנסה להתחבר מחדש. בדוק את חיבור האינטרנט`, JSON.stringify({ code: d.code, reason: d.reason })));
    s.on("reconnected", () => { healthClear(`stt-${ch}`); log.write("events", { type: "stt.reconnected", ch }); });
    s.on("switched", (d: { from: string; to: string; kind: string; reason: string }) => {
      sttSwitchedCh.add(ch); healthClear(`stt-${ch}`);
      log.write("events", { type: "stt.switch", ch, ...d });
      health(`stt-switch-${ch}`, "amber", `תמלול ${chHe(ch)}: עברנו מ-${d.from} ל-${d.to}`, d.reason); tickHealth();
    });
    s.on("exhausted", (e: ProviderError) => {
      log.write("events", { type: "stt.exhausted", ch, kind: e.kind, retryable: e.retryable });
      // Auth / quota / spend cap will not fix themselves: stop with a clear message. Anything else (wifi drop, 5xx, rate limit) is retried forever with backoff.
      if (!e.retryable) {
        health(`stt-${ch}`, "red", `תמלול ${chHe(ch)} נפל בכל הספקים – ${describe(e)}`);
        if (ch === "them") sup.set({ fatal: `STT unusable: ${describe(e)} (client channel)` });
        return;
      }
      health(`stt-${ch}`, "red", `תמלול ${chHe(ch)} אין חיבור – ${describe(e)}. מנסה שוב ושוב עד שיחזור. בדוק חיבור לאינטרנט`);
      void sttRetryLoop(s as SttChannel, ch);
    });
  }
  console.log(`Wingman Stage 0 · call ${log.id} · ${fileArg ? "file " + fileArg : "live"} · ${bank.length} prepared cards${noAi ? " · prepared only" : ""}${discard ? " · --discard" : ""}`);
  console.log(`Cards also go to ${log.dir}/cards.jsonl (run "pnpm overlay" for the second-screen window). Keys: Enter = start listening (when waiting) · q = Quiet mode · a = ask Wingman · n = add a note for the AI · y = confirm the proposed client · Ctrl+C = stop.`);
  console.log(`Speakers mode: ${ECHO.mode} (audio.echo.mode; "filter" is best with headphones) · capture box ${S.capture.enabled ? "on" : "off"}`);

  // Consent card: re-emitted every 20 s until confirmed (the answer window may start late and would miss a single one).
  const consentCard = (): Card => ({ id: "consent", turnId: "start", badge: "info", question: "תחילת שיחה", say: CONSENT_SAY, facts: ["אפשר להגיד את זה בתחילת השיחה", CONTROL ? "לא רוצים להקליט: עצור ומחק מהתפריט" : "לא רוצים להקליט: Ctrl+C", CONTROL ? "להתחלת האזנה: Ctrl+Opt+Return" : "להתחלת האזנה: Enter"], at: Date.now() });
  const MIC_LONG_SILENT_MS = 5 * 60_000;
  let micPeakAfterStart = 0, micPeakWin = 0, micSilentShown = false, micWatch: NodeJS.Timeout | undefined;
  // privacy.requireConsentAck ("Ask me before listening starts", default off): wait for Start listening before any audio leaves the Mac.
  const needAck = S.privacy.requireConsentAck && !fileArg && (process.stdin.isTTY || CONTROL);
  const startForwarding = () => {
    if (consented) return;
    consented = true; clearInterval(reemit); log.write("events", { type: needAck ? "consent.confirmed" : "listening.start" });
    if (needAck) { emitCard({ ...consentCard(), id: "consent", say: "ההאזנה התחילה. התמלול פעיל.", facts: [] }); console.log("\nListening started: audio is now being sent for transcription."); }
    status("consented", { id: log.id });
    consentedAt = Date.now();
    setPhase("live", { liveAt: consentedAt });
    // Mic watchdog. Silence is normal while the user listens (3 Nov: a quiet Bluetooth mic raised "mic not picking up" about 20 times).
    // Red only when the mic was NEVER heard since listening started (permission, wrong device). Once it was heard, only a long silence
    // (micLongSilentMs) gives one calm amber line, cleared as soon as the mic is heard again.
    if (!fileArg) { micPeakWin = 0; let silentSince = Date.now(); micWatch = setInterval(() => {
      if (shuttingDown) return;
      const now = Date.now();
      if (micPeakWin >= S.audio.watchdog.micPeak) silentSince = now;
      if (micPeakAfterStart < S.audio.watchdog.micPeak) {
        if (!micSilentShown) { micSilentShown = true; health("mic", "red", "המיקרופון לא קולט. בדוק הרשאת מיקרופון ב-Settings ובחירת מיקרופון, ואז הרץ בדיקת מוכנות"); }
      } else if (now - silentSince >= MIC_LONG_SILENT_MS && !micSilentShown) {
        micSilentShown = true; health("mic", "amber", "לא שמעתי אותך כמה דקות. אם דיברת, בדוק את המיקרופון");
      }
      micPeakWin = 0;
    }, S.audio.watchdog.micSilentMs); micWatch.unref(); }
  };
  if (needAck) emitCard(consentCard());
  const reemit = setInterval(() => { if (!consented && needAck) emitCard(consentCard()); }, 20_000);
  if (!needAck) startForwarding();
  if (CONTROL) setupControl(startForwarding); else setupKeys(startForwarding);
  if (!consented) { console.log(`\nWaiting for you to start listening: nothing is sent to the cloud until you ${CONTROL ? "click \"Start listening\" in the menu bar" : "press Enter"}.`); setPhase("waiting"); status("waiting", { id: log.id }); }

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
    const devsP = readAudioDevices();
    if (ECHO.mode === "auto") void devsP.then((devs) => {
      const m = resolveEchoMode("auto", devs);
      setEchoMode(m);
      log.write("events", { type: "echo.mode", mode: m, output: devs.find((d) => d.defaultOutput)?.name ?? "" });
      console.log(`Speakers mode auto: ${m} (output: ${devs.find((d) => d.defaultOutput)?.name ?? "unknown"})`);
    });
    if (S.audio.warnBluetooth) void devsP.then((devs) => {
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
    mic.on("error", (e) => { console.error("mic error:", e.message); health("mic", "red", "המיקרופון נפל. חבר אותו מחדש או בחר מיקרופון אחר ב-Settings", e.message); });
    mic.on("log", (m: string) => console.log(m));
    if (sys) {
      sys.on("pcm", (b: Buffer) => { gate.noteThemPeak(peakOf(b)); if (consented) them.send(b); });
      sys.on("error", (e: Error) => { console.error("system audio error:", e.message); health("sys", "red", "לא שומעים את הצד השני. בדוק את הרשאת הקלטת המסך/שמע המערכת והרץ בדיקת מוכנות", e.message); });
      sys.on("log", (m: string) => console.log(m));
      await sys.start();
    } else {
      console.log("audio.system.source is off: no audio from the other side, so only your own questions get answers (Ctrl+Opt+A).");
      sup.set({ themDead: true });
    }
    await mic.start();
    stops.push(async () => { await sys?.stop(); }, () => mic.stop(), async () => { clearInterval(micWatch); clearInterval(reemit); });
    // Silent-tap watchdog. Two different situations:
    //  1. Frames keep arriving but are silent while the user talks (a monologue, a test, thinking aloud): ONE calm info line. This NEVER sets
    //     themDead (that would drop the ladder to transcript-only for a minute). Sound or client text clears it at once.
    //  2. No frames at all from the tap for deadFrameMs: the tap is really dead -> red, themDead (recovers within seconds once frames return).
    // Answers for the user keep working in both cases.
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
    const ONLY_YOU_MS = Math.max(W.silentThemMs, 45_000); let lastOnlyYouAt = 0;
    setInterval(() => {
      if (!sys || !consented || shuttingDown) return;
      if (Date.now() - lastSysFrame > deadFrameMs) {
        if (shownKind !== "red") {
          if (shownKind === "calm") { healthClear("only-you"); shownKind = undefined; }
          shownKind = "red"; sup.set({ themDead: true }); log.write("events", { type: "watchdog.tap-dead" });
          health("them-silent", "red", "אין שמע מהצד השני (ערוץ השמע של המערכת לא שולח כלום). התשובות אליך עדיין פועלות. בדוק שהשמע של השיחה מופעל ושהווליום למעלה");
        }
        return;
      }
      if (shownKind || checking) return;
      // "I only hear you" only after a long one-sided stretch: the other side is silent while the user talks for a while in any call
      // (3 Nov: shown 8 times while Zoom audio worked). At most once every 10 minutes.
      if (!(Date.now() - lastThemSound > ONLY_YOU_MS && Date.now() - lastMeVoiced < 3000 && Date.now() - lastOnlyYouAt > 10 * 60_000)) return;
      checking = true;
      void callAppRunning().then((app) => {
        checking = false;
        if (shuttingDown || shownKind || Date.now() - lastThemSound <= ONLY_YOU_MS) return;
        lastOnlyYouAt = Date.now();
        log.write("events", { type: "watchdog.silent-them", callApp: app ?? null });
        shownKind = "calm"; health("only-you", "info", ONLY_YOU_TEXT);
      });
    }, 2000).unref();
  }
}

main().catch((e) => crash("main", e));
