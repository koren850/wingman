// Wingman Stage 0: live (system audio + mic) or --file <stereo.wav> (L = me, R = them).
//   pnpm start                 live call (press Enter once consent is confirmed; audio is not sent to the cloud before that)
//   pnpm start --file x.wav    replay a recording in real time
//   pnpm start --no-ai         bank only (no Haiku)
//   pnpm start --discard       delete the call folder when the call ends
//   Keys while running: Enter = consent confirmed (start sending audio) · q = quiet on/off (cards logged, not shown)
//                       n = type a context note for the AI ("this is about the shop migration"), Enter to add · Ctrl+C = stop
//   WINGMAN_CONTROL=1         remote control for the menu-bar app: line commands on stdin (consent, quiet, client, note <text>, stop)
//                             and "@@wingman {json}" status lines on stdout. Consent is still required (no auto-start).
import { readFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { requireKeys, DATA, CALLS, ROOT } from "./env.ts";
import { EntitySpotter, loadSnapshot, type Fact } from "./entities.ts";
import { takeNotes } from "./notes.ts";
import { loadBrief, briefNotes, covered, type Brief } from "./brief.ts";
import { loadBank, matchBank, stallCard, stallSay, type BankCard } from "./bank.ts";
import { detect } from "./detector.ts";
import { guard, sanitize } from "./guards.ts";
import { buildPrefix, runReflex, type Tag } from "./reflex.ts";
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
import { joinSplit, type PrevUtterance } from "./split.ts";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const { settings: S, profile } = loadSettingsOrExit(args);
const fileArg = S.run.file ?? undefined;
const noAi = S.run.noAi;
const discard = S.run.discard;
const REFLEX_MODELS = [S.llm.reflex.model, ...S.llm.reflex.fallbacks];
const keyFile = expandHome(S.keys.file);
const NO_KEY = new Set(["script", "scripted"]);   // offline test doubles
const keys = requireKeys([...new Set([S.stt.provider, ...(noAi ? [] : [parseModelRef(S.llm.reflex.model).provider as any])])].filter((k) => !NO_KEY.has(k)), keyFile);
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
const prefix = buildPrefix(houseStyle, bank);
const log = new CallLog({ mode: fileArg ? "file" : "live", file: fileArg, model: S.llm.reflex.model, fallbacks: S.llm.reflex.fallbacks, stt: `${S.stt.provider} ${S.stt.model} ${S.stt.language}`, sttFallback: S.stt.fallback, profile, noAi, discard });
const cost = new CostMeter(S.budget.prices, S.budget);
const sup = new HealthSupervisor({ tickMs: S.health.tickMs, recoverStableMs: S.health.recoverStableMs, slowMs: S.llm.reflex.slowMs, slowSttMs: S.health.slowSttMs, minSamples: S.health.minSamples });
sup.set({ noAi, bankFailed: bank.length === 0 });
const breakers = new Map(REFLEX_MODELS.map((m) => [m, new CircuitBreaker({ failures: S.llm.circuit.failures, windowMs: 10_000, cooldownMs: S.llm.circuit.cooldownMs })]));
const downUntil = new Map<string, number>();   // spend cap: no retries for the rest of the day

type Badge = "bank" | "ai" | "stall" | "info" | "warn";
type Card = {
  id: string; turnId: string; badge: Badge; question: string; say: string; facts: string[]; dim?: boolean; at: number;
  health?: boolean; level?: "red" | "amber" | "info"; clear?: boolean; withdraw?: boolean;
};
const transcript: { ch: Channel; text: string }[] = [];
const contextNotes: string[] = [];
// Prepared start: a brief saved by `pnpm brief` (last 6 h), or --brief <file>; --no-brief skips it.
const briefArg = args.includes("--brief") ? args[args.indexOf("--brief") + 1] : undefined;
// A replay (--file) never consumes latest.yaml; it uses a brief only when --brief is given.
const brief: Brief | undefined = args.includes("--no-brief") || (fileArg && !briefArg) ? undefined : loadBrief(briefArg);
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
      emitSide({ id: "propose-client", badge: "info", say: `נראה שזו שיחה עם ${f.title}`, facts: ["y בטרמינל = לאשר ולתת ל-AI את הפרטים"] });
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
let current: AbortController | undefined;
let quiet = S.cards.quiet, consented = !!fileArg || !S.privacy.requireConsentAck, shuttingDown = false;
const decided = new Map<string, { hidden: boolean; reason?: string }>(); // card id -> was it hidden from the overlay
let shownTimes: number[] = [];
const turnsWithCard = new Set<string>();

function emitCard(c: Card) {
  c.say = sanitize(c.say); c.facts = c.facts.map(sanitize);
  const special = c.health || c.badge === "info";
  let hidden = false, reason: string | undefined;
  if (!special) {
    const prev = decided.get(c.id);
    if (prev) { hidden = prev.hidden; reason = prev.reason; }
    else {
      const now = Date.now();
      shownTimes = shownTimes.filter((t) => now - t < S.cards.windowMs);
      if (quiet) { hidden = true; reason = "quiet"; }
      else if (shownTimes.length >= S.cards.maxPerMinute) { hidden = true; reason = "cap"; }
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
  const badge = { bank: "📗 bank", ai: "🤖 AI", stall: "⏸ stall", info: "ℹ️ info", warn: "⚠️ HEALTH" }[c.badge];
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
  return `Speed: ${latRows.length} questions · first card p50 ${ms(pct(first, 50))} / p95 ${ms(pct(first, 95))} · bank cards ${bank.length} (p50 ${ms(pct(bank, 50))}) · Haiku first tag p50 ${ms(pct(tag, 50))}`;
}

function onQuestion(r: SttResult, reason = "") {
  const turnId = `q${++turnSeq}`;
  const speechEnd = r.speechEndWall ?? r.arrivedAt;
  const lat: Record<string, number | string> = { turnId, speechEnd, finalAt: r.arrivedAt, text: r.text };
  const fresh = () => Date.now() - speechEnd < S.reflex.dropStaleMs;
  const meSpokeSince = () => lastMeVoiced > speechEnd;
  current?.abort();
  const ac = (current = new AbortController());
  const weak = reason.startsWith("head:") || reason.startsWith("problem");   // weak detection: a bank card may be a wrong card
  const bankOnly = reason.startsWith("problem");                              // D6: never an AI answer on a guessed question

  // Ladder: the rung in force for this question (it only changes between questions).
  const caps = sup.caps, usable = usableModels();
  sup.beginQuestion();
  let ended = false;
  const end = () => { if (!ended) { ended = true; sup.endQuestion(); } };
  const useAi = !noAi && !bankOnly && caps.llm && usable.length > 0;
  const allowAns = S.reflex.allowAns && caps.ans;

  const hit = matchBank(r.text, bank);
  let shown: Card | undefined;
  if (hit) {
    shown = { id: `${turnId}-bank`, turnId, badge: "bank", question: r.text, say: hit.card.say, facts: hit.card.facts, dim: weak || undefined, at: Date.now() };
    emitCard(shown); lat.bankAt = Date.now(); lat.bankId = hit.card.id;
  }
  if (!useAi) {
    // Degraded (not by --no-ai): no LLM, so a question without a bank card gets the stall line, as the ladder promises.
    if (!noAi && !bankOnly && !shown && fresh()) { shown = { id: `${turnId}-stall`, turnId, badge: "stall", question: r.text, say: stallSay(stall, turnSeq), facts: [], at: Date.now() }; emitCard(shown); lat.stallAt = Date.now(); }
    recordLatency(lat); end(); return;
  }

  const stallId = `${turnId}-stall`;
  const stallTimer = setTimeout(() => {
    if (ac.signal.aborted) return;
    if (!shown && fresh()) { shown = { id: stallId, turnId, badge: "stall", question: r.text, say: stallSay(stall, turnSeq), facts: [], at: Date.now() }; emitCard(shown); lat.stallAt = Date.now(); }
  }, S.reflex.stallAfterMs);

  const ai: Card = { id: `${turnId}-ai`, turnId, badge: "ai", question: r.text, say: "", facts: [], at: 0 };
  const recent = transcript.slice(-12).map((l) => `${l.ch}: ${l.text}`).join("\n");
  lat.reqAt = Date.now();
  runReflex({
    registry, models: usable, cfg: S.llm.reflex, prefix, transcript: recent, question: r.text, context: contextNotes, signal: ac.signal,
    onFail: (model, err) => llmFailed(model, err),
    onSwitch: (from, to, err) => { log.write("events", { type: "llm.switch", turnId, from, to, kind: err.kind }); console.log(`\n↪ AI ${from} -> ${to} (${describe(err)})`); },
    h: {
      onTag(tagIn: Tag) {
        let tag = tagIn;
        if (ac.signal.aborted) return;
        lat.tagAt = Date.now(); lat.tag = tag.kind + (tag.bankId ? ` ${tag.bankId}` : "");
        sup.recordTag(Number(lat.tagAt) - Number(lat.reqAt));
        if (tag.kind === "ANS" && !allowAns) { tag = { kind: "STALL" }; lat.tag = "STALL (ans-off)"; log.write("events", { type: "ans.suppressed", turnId, rung: sup.rung }); }
        if (tag.kind === "SKIP") {
          clearTimeout(stallTimer);
          if (weak && shown?.badge === "bank" && shown.turnId === turnId) { emitCard({ ...shown, withdraw: true }); log.write("events", { type: "withdraw", turnId, why: "haiku-skip" }); }
          return;
        }
        if (tag.kind === "STALL") {
          clearTimeout(stallTimer);
          if (!shown && fresh()) { shown = { ...ai, id: stallId, badge: "stall", say: stallSay(stall, turnSeq), at: Date.now() }; emitCard(shown); }
          return;
        }
        if (tag.kind === "BANK" && tag.bankId && hit?.card.id !== tag.bankId) {
          const card = bank.find((c: BankCard) => c.id === tag.bankId);
          if (card && fresh()) {
            clearTimeout(stallTimer);
            if (shown?.badge === "bank") emitCard({ ...shown, withdraw: true }); // Haiku disagrees with the keyword hit
            shown = { ...ai, id: `${turnId}-bank2`, badge: "bank", say: card.say, facts: card.facts, at: Date.now() }; emitCard(shown); lat.bankAt ??= Date.now();
          }
        }
      },
      onSay(text) {
        if (ac.signal.aborted) return;
        if (!lat.firstWordAt) lat.firstWordAt = Date.now();
        ai.say = text;
      },
      onFacts(f) { if (!ac.signal.aborted) ai.facts = f; },
      onSayComplete(say) {
        if (ac.signal.aborted) return;
        ai.say = say;
        if (!/^(ANS|BANK)/.test(String(lat.tag ?? "")) || !fresh()) return;
        if (String(lat.tag).startsWith("BANK") && shown?.badge === "bank") return; // bank card already up
        const g = guard(ai.say);
        const card: Card = g.ok ? { ...ai, at: Date.now() } : { ...ai, id: stallId, badge: "stall", say: stallSay(stall, turnSeq), facts: [], at: Date.now() };
        if (!g.ok) log.write("events", { type: "guard", turnId, rule: g.rule });
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
    if ((kind === "refusal" || kind === "timeout") && !shown && fresh()) { shown = { id: stallId, turnId, badge: "stall", question: r.text, say: stallSay(stall, turnSeq), facts: [], at: Date.now() }; emitCard(shown); }
    if (kind !== "refusal" && ++reflexErrors >= 2) health("ai", "amber", "AI לא עונה (הבנק עדיין עובד)", String(e?.message ?? e));
  }).finally(end);
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
  if (ch !== "them" || shuttingDown) return;
  const now = Date.now();
  const glued = joinSplit(lastThem, joined.text, now, S.stt.joinWindowMs ?? 0);
  if (glued !== joined.text) { log.write("events", { type: "split.join", prev: lastThem?.text, text: joined.text }); joined.text = glued; }
  const hit = matchBank(joined.text, bank);
  const d = detect(joined.text, { bankScore: hit?.score ?? 0, stall: !!hit && hit.card.id.startsWith("stall-") });
  log.write("events", { type: "detect", text: joined.text, ...d });
  lastThem = { text: joined.text.split(/\s+/).slice(-30).join(" "), at: now, question: d.isQuestion };
  if (d.isQuestion && sup.caps.detect) onQuestion(joined, d.reason);
}

function onResult(r: SttResult) {
  if (!r.isFinal) return;
  log.write("events", { type: "stt", ch: r.channel, final: true, speechFinal: r.speechFinal, text: r.text, speechEndWall: r.speechEndWall });
  if (r.channel === "them" && r.text) echo.noteThem(r.text, r.arrivedAt);
  // "me" lines wait briefly so the client line they may echo has arrived, then go through the echo filter.
  if (r.channel === "me" && r.text && useFilter && !shuttingDown) {
    const t = setTimeout(() => { meTimers.delete(t); acceptResult(r, true); }, ECHO.filterDelayMs);
    meTimers.add(t); return;
  }
  acceptResult(r, false);
}
const meTimers = new Set<NodeJS.Timeout>();
function acceptResult(r: SttResult, checkEcho: boolean) {
  if (shuttingDown) return;
  if (checkEcho) {
    const e = echo.isEcho(r.text);
    if (e.echo) { echoDropped++; log.write("events", { type: "echo.drop", text: r.text, score: Number(e.score.toFixed(2)) }); return; }
  }
  if (r.text) {
    capture(r.channel, r.text);
    spotFacts(r.text);
    if (notesOn) notesLines.push(`${r.channel}: ${r.text}`);
    if (r.channel === "me" && r.text.length >= 6 && r.text.split(/\s+/).length >= 2) lastMeVoiced = Date.now();
    transcript.push({ ch: r.channel, text: r.text });
    log.write("transcript", { ch: r.channel, text: r.text, words: r.words });
    const p = (pending[r.channel] ??= { texts: [], words: [], last: r });
    p.texts.push(r.text); p.words.push(...r.words); p.last = r;
    clearTimeout(p.timer); p.timer = setTimeout(() => flush(r.channel), S.stt.flushFallbackMs);
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
function addNote(text: string) {
  const note = text.trim();
  if (!note) return;
  contextNotes.push(note.slice(0, 300)); log.write("events", { type: "context.note", note });
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
    else if (cmd === "note") addNote(rest.join(" "));
    else if (cmd === "stop") void shutdown();
  });
  rl.on("close", () => void shutdown());   // the menu-bar app went away: stop cleanly
}
// Typed context note (instant-start mode: tell Wingman what the call is about, mid-call).
let noteBuf: string | undefined;
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

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true; current?.abort(); notesAbort.abort();
  for (const t of meTimers) clearTimeout(t); meTimers.clear();
  for (const ch of ["me", "them"] as Channel[]) { clearTimeout(pending[ch]?.timer); delete pending[ch]; }
  for (const s of stops) await s().catch(() => {});
  sup.stop();
  await Promise.all([me?.close(), them?.close()].filter(Boolean)).catch(() => {});
  try {
    cost.setSttSeconds(sttSeconds());
    log.write("usage", { role: "stt", vendor: them?.provider, seconds: { me: me?.audioSeconds, them: them?.audioSeconds }, bySeconds: sttSeconds(), usd: cost.sttUsd, dropped: { me: me?.dropped, them: them?.dropped } });
    if (brief?.mustCover?.length) { const left = uncovered(); log.write("events", { type: "mustcover.summary", left }); if (left.length) console.log(`\nNot covered in this call: ${left.join(", ")}`); }
    log.write("events", { type: "echo.summary", mode: ECHO.mode, gatedSeconds: Math.round(gatedMs / 1000), echoDropped });
    log.write("usage", { role: "summary", llmUsd: cost.llmUsd, sttUsd: cost.sttUsd, totalUsd: cost.totalUsd, roles: cost.roles, unpriced: [...cost.unpriced] });
    const summary = speedSummary();
    log.write("events", { type: "speed.summary", summary });
    log.update({ endedAt: new Date().toISOString(), crashed });
    console.log(`\nSpeakers mode (${ECHO.mode}): mic muted ${Math.round(gatedMs / 1000)} s while the client talked · ${echoDropped} echo lines dropped`);
    console.log(`\n${summary}\nCost: ${cost.line()} (estimate from settings budget.prices)\nSTT chunks dropped (socket not open): me ${me?.dropped ?? 0}, them ${them?.dropped ?? 0}`);
  } catch (e) { console.error("call summary failed:", e); try { log.write("events", { type: "shutdown.error", error: String((e as Error)?.stack ?? e) }); } catch {} }
  let del = discard;
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
let lastTick = Date.now(), sleepClearAt = 0;
function tickHealth() {
  // Y2: a long gap between ticks means the Mac slept (lid closed) mid-call.
  const now = Date.now(), gap = now - lastTick; lastTick = now;
  const gapMs = S.system.sleepGapMs ?? 0;
  if (gapMs > 0 && gap > gapMs + S.health.tickMs) {
    log.write("events", { type: "sleep.gap", ms: gap });
    health("sleep", "amber", `המחשב נרדם ל-${Math.round(gap / 1000)} שניות. חלק מהשיחה לא נשמע`);
    sleepClearAt = now + 20_000;
  } else if (sleepClearAt && now > sleepClearAt) { sleepClearAt = 0; healthClear("sleep"); }
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
  if (to === 5) { console.log("Wingman is OFF: " + reasons.join(", ")); void shutdown(); }
}

function makeChannel(ch: Channel): SttChannel {
  return new SttChannel({
    channel: ch, chain: sttChain(S).map(getSttProvider), keyOf: (id) => (NO_KEY.has(id) ? "none" : (keys as Record<string, string | undefined>)[id]),
    base: { language: S.stt.language, keyterms, endpointingMs: S.stt.endpointMs, utteranceEndMs: S.stt.utteranceEndMs, keepAliveMs: S.stt.keepAliveMs, model: S.stt.model },
    circuit: S.stt.circuit, ringMs: S.stt.reconnect.ringMs,
  });
}

async function main() {
  me = makeChannel("me"); them = makeChannel("them");
  for (const id of sttChain(S)) if (getSttProvider(id).experimental) console.log(`⚠ STT provider "${id}" is EXPERIMENTAL (never tested live).`);
  for (const m of REFLEX_MODELS) if (!noAi) { try { await registry.resolve(m); } catch (e) { if (m === REFLEX_MODELS[0] && !(e instanceof ConfigError && REFLEX_MODELS.length > 1)) throw e; console.log(`⚠ AI model ${m}: ${(e as Error).message}`); downUntil.set(m, Infinity); } }
  await Promise.all([me.open(), them.open()]);
  sup.on("rung", renderRung); sup.start(); setInterval(tickHealth, S.health.tickMs).unref();
  setInterval(() => void notesRound(), S.notes.everyMs).unref();
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
      log.write("events", { type: "stt.exhausted", ch, kind: e.kind });
      health(`stt-${ch}`, "red", `STT (${ch}) נפל בכל הספקים – ${describe(e)}`);
      if (ch === "them") sup.set({ fatal: "STT down on every provider (client channel)" });
    });
  }
  console.log(`Wingman Stage 0 · call ${log.id} · ${fileArg ? "file " + fileArg : "live"} · ${bank.length} bank cards${noAi ? " · bank only" : ""}${discard ? " · --discard" : ""}`);
  console.log(`Cards also go to ${log.dir}/cards.jsonl (run "pnpm overlay" for the second-screen window). Keys: Enter = consent confirmed · q = quiet · n = add a note for the AI · y = confirm the proposed client · Ctrl+C = stop.`);
  console.log(`Speakers mode: ${ECHO.mode} (audio.echo.mode; "filter" is best with headphones) · capture box ${S.capture.enabled ? "on" : "off"}`);

  // Consent card: re-emitted until confirmed (the overlay may start late).
  const consentCard = (): Card => ({ id: "consent", turnId: "start", badge: "info", question: "תחילת שיחה", say: CONSENT_SAY, facts: ["להגיד את זה בתחילת השיחה", "הלקוח לא מסכים: Ctrl+C", "אחרי שהסכים: Enter"], at: Date.now() });
  let micPeakAfterStart = 0, micWatch: NodeJS.Timeout | undefined;
  const startForwarding = () => {
    if (consented) return;
    consented = true; clearInterval(reemit); log.write("events", { type: "consent.confirmed" });
    emitCard({ ...consentCard(), id: "consent", say: "הסכמה אושרה. התמלול פעיל.", facts: [] });
    console.log("\nConsent confirmed: audio is now being sent for transcription.");
    status("consented", { id: log.id });
    if (!fileArg) micWatch = setTimeout(() => {
      if (micPeakAfterStart < S.audio.watchdog.micPeak) health("mic", "red", "MIC SILENT – המיקרופון לא קולט (הרשאה? WINGMAN_MIC?)");
    }, S.audio.watchdog.micSilentMs);
  };
  emitCard(consentCard());
  const reemit = setInterval(() => { if (!consented) emitCard(consentCard()); }, 20_000);
  if (fileArg || (!process.stdin.isTTY && !CONTROL) || !S.privacy.requireConsentAck) startForwarding();
  if (CONTROL) setupControl(startForwarding); else setupKeys(startForwarding);
  if (consented) status("consented", { id: log.id, auto: true });   // replay or consent off: already sending
  if (!consented) { console.log(`\nWaiting for consent: nothing is sent to the cloud until you ${CONTROL ? "click \"Consent given\" in the menu bar" : "press Enter"}.`); status("waiting", { id: log.id }); }

  if (fileArg) {
    const f = new FileSource(fileArg);
    f.on("pcm-them", (b) => { gate.noteThemPeak(peakOf(b)); them.send(b); }); f.on("pcm-me", (b) => me.send(gateMic(b)));
    f.on("end", () => setTimeout(() => void shutdown(), 4000));
    await f.start(); stops.push(() => f.stop());
  } else {
    if (S.system.caffeinate) spawn("caffeinate", ["-dis", "-w", String(process.pid)], { stdio: "ignore" }).on("error", () => {}).unref();
    // Client audio: audiotee (macOS tap) | device (avfoundation input such as BlackHole, via ffmpeg) | off.
    const srcKind = S.audio.system.source;
    const sys = srcKind === "audiotee" ? new SystemSource() : srcKind === "device" ? new MicSource(S.audio.system.device) : undefined;
    const mic = new MicSource(S.audio.mic.device);
    console.log(`Mic device: ${mic.device} (audio.mic.device / WINGMAN_MIC) · client audio: ${srcKind}${srcKind === "device" ? ` (${S.audio.system.device})` : ""}`);
    mic.on("pcm", (b: Buffer) => { if (consented) { micPeakAfterStart = Math.max(micPeakAfterStart, peakOf(b)); me.send(gateMic(b)); } });
    mic.on("error", (e) => { console.error("mic error:", e.message); health("mic", "red", "MIC ERROR – המיקרופון נפל", e.message); });
    mic.on("log", (m: string) => console.log(m));
    if (sys) {
      sys.on("pcm", (b: Buffer) => { gate.noteThemPeak(peakOf(b)); if (consented) them.send(b); });
      sys.on("error", (e: Error) => { console.error("system audio error:", e.message); health("sys", "red", "SYSTEM AUDIO ERROR – לא שומעים את הלקוח", e.message); });
      sys.on("log", (m: string) => console.log(m));
      await sys.start();
    } else {
      console.log("audio.system.source is off: no client audio, so no questions can be detected (transcript-only).");
      sup.set({ themDead: true });
    }
    await mic.start();
    stops.push(async () => { await sys?.stop(); }, () => mic.stop(), async () => { clearTimeout(micWatch); clearInterval(reemit); });
    // Silent-tap watchdog: warn if the client side stays silent while Dan talks. Client audio dead = transcript-only rung.
    const W = S.audio.watchdog;
    let lastThem = Date.now(), warned = false;
    sys?.on("pcm", (b: Buffer) => { if (peakOf(b) > W.silentPeak) { lastThem = Date.now(); if (warned) { warned = false; healthClear("them-silent"); sup.set({ themDead: false }); } } });
    setInterval(() => {
      if (sys && consented && !warned && Date.now() - lastThem > W.silentThemMs && Date.now() - lastMeVoiced < 3000) {
        warned = true; log.write("events", { type: "watchdog.silent-them" }); sup.set({ themDead: true });
        health("them-silent", "red", "NOT HEARING THE CLIENT – אין שמע מהלקוח (system audio silent)");
      }
    }, 2000).unref();
  }
}

main().catch((e) => crash("main", e));
