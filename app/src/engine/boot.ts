// Everything the call needs before the first audio frame: settings, API keys (kept in memory only), the prepared brief and card bank, the call log folder,
// and the long-lived objects (cost meter, health supervisor, trackers). Importing this module starts the call's setup; it never imports another engine module.
// Why this is a module singleton: the engine is one process per call, so settings, keys and the call log are read once at import time and every
// engine module imports the result instead of passing a context around. Tests do not import this module: they exercise the pure modules
// (reflex, guards, degrade ladder) with injected inputs, and the whole engine as a child process on the scripted providers.
// A createEngine(settings) context would be the refactor if the engine ever had to run twice in one process.
import { createHash } from "node:crypto";
import { KEY_ENV_VARS } from "../keychain.ts";
import { requireKeys, CALLS, resolveUserPath, type KeyName } from "../env.ts";
import { EntitySpotter, loadSnapshot } from "../entities.ts";
import { loadBrief, confirmBrief, briefNotes, isInterview, briefCardsFile, briefTerms, type Brief } from "../brief.ts";
import { readPack } from "../pack.ts";
import { getProfile, checkProfile } from "../profile.ts";
import { loadBank, stallCard, type BankCard } from "../bank.ts";
import { MeGate } from "../assist.ts";
import { parseClaim, type Claim } from "../claims.ts";
import { SpeakerBook, lineLabel, attendeeNames, type SpeakerInfo } from "../speakers.ts";
import { FlowTracker } from "../flow.ts";
import { buildPrefix } from "../reflex.ts";
import type { Channel } from "../providers/stt/types.ts";
import { loadKeyterms } from "../providers/stt/index.ts";
import { ModelRegistry, parseModelRef } from "../providers/llm.ts";
import { CardPipe } from "../relay.ts";
import { CallLog, sweepLive } from "../log.ts";
import { PhoneRouter, isPhoneCall } from "../phone.ts";
import { loadSettingsOrExit, expandHome, resolveUiLanguage } from "../settings.ts";
import { CostMeter } from "../cost.ts";
import { EchoFilter, MicGate } from "../echo.ts";
import { HealthSupervisor, CircuitBreaker } from "../health.ts";
import { FrameTracker } from "../frame.ts";
import { TipGate, type TimedLine } from "../tips.ts";
import { SelfCheckGate } from "../selfcheck.ts";
import { loadAttachments, confirmAttachments, backgroundBlock } from "../attachments.ts";
import { factsActive } from "./rules.ts";

export const args = process.argv.slice(2);
export const { settings: S, profile } = loadSettingsOrExit(args);
try {
  checkProfile();
} catch (e) {
  console.error(`Wingman: ${(e as Error).message}\nFix ~/.config/wingman/profile.yaml (or run: wingman profile set ...).`);
  process.exit(2);
} // an invalid user profile stops the call before it starts
/** Language of the status texts the user reads (health bars, ladder): ui.language, auto = Hebrew unless the call language is English. */
export const UI_LANG = resolveUiLanguage(S);
export const fileArg = S.run.file ?? undefined;
export const noAi = S.run.noAi;
export const discard = S.run.discard;
export const REFLEX_MODELS = [S.llm.reflex.model, ...S.llm.reflex.fallbacks];
export const keyFile = expandHome(S.keys.file);
export const NO_KEY = new Set(["script", "scripted"]); // offline test doubles: providers that need no API key
export const keys = requireKeys(
  [
    ...new Set([
      S.stt.provider,
      ...(noAi
        ? []
        : [parseModelRef(S.llm.reflex.model).provider as KeyName, ...(S.summary.enabled ? [parseModelRef(S.summary.model).provider as KeyName] : [])]),
    ]),
  ].filter((k): k is KeyName => !NO_KEY.has(k)),
  keyFile,
);
for (const v of KEY_ENV_VARS) delete process.env[v]; // keys now live in `keys` (memory) only: no child of this process (audiotee, ffmpeg...) inherits them
export const registry = new ModelRegistry(keys);

/** S2: consent line. Names the cloud processing and the AI assistant, and offers an opt-out (settings privacy.consentText). */
export const CONSENT_SAY = S.privacy.consentText;
export const CONTROL = process.env.WINGMAN_CONTROL === "1";

// Prepared start: a brief saved by `pnpm brief` / the Plan, or --brief <file>; --no-brief skips it.
// Loading never uses a brief up and it never expires: confirmContext() retires latest.yaml once the call is live and has saved its first memory.
// A replay (--file) uses a brief only when --brief is given.
export const briefArg = args.includes("--brief") ? args[args.indexOf("--brief") + 1] : undefined;
export const noBrief = args.includes("--no-brief") || (!!fileArg && !briefArg);
export const brief: Brief | undefined = noBrief ? undefined : loadBrief(briefArg);
// Interview plan (kind "interview"): Wingman coaches the candidate. The plan's own prepared cards replace the agency bank, no "buy time"
// lines, no focus cap, and the AI answers technical and personal questions from the prep files (reflex.ts INTERVIEW_BLOCK).
export const interview = isInterview(brief);
// Phone mode: a phone call on speaker next to the Mac (plan note "Phone call on speaker" or WINGMAN_PHONE=1). Both voices come in on the
// microphone; diarization + loudness (phone.ts) decide which voice is the user. No system audio, no echo gate/filter.
export const PHONE = isPhoneCall(brief?.notes);
export const phone = PHONE ? new PhoneRouter() : undefined;
export const cardsFile = interview ? briefCardsFile(brief) : undefined;
export let bank: BankCard[];
try {
  bank = interview ? (cardsFile ? loadBank(cardsFile) : []) : loadBank();
} catch (e) {
  console.error(`Prepared cards ${cardsFile} not loaded: ${(e as Error).message}`);
  bank = [];
}
export const stall = stallCard(bank);
export const houseStyle = readPack("house-style.md");
// Names from the plan go first (the cap cuts the end of the list): "Dana Levi (Acme HR)" -> Dana, Levi, Acme.
export const keyterms = [...new Set([...briefTerms(brief), ...loadKeyterms(S)])].slice(0, Math.max(S.stt.keyterms.max, 1));
// Background files from the plan: read, not deleted (a plan can start the next call too). A replay / --no-brief never uses them.
export const attachFiles = noAi || noBrief ? [] : loadAttachments(S.attachments.maxChars);
/** Call is live and its first memory write worked: the single-Plan brief and files that were loaded are retired. A replay (--file) retires nothing. */
export function confirmContext(): void {
  if (fileArg) return;
  confirmBrief();
  confirmAttachments();
}
export const background = backgroundBlock(attachFiles);
export const prefix = buildPrefix(houseStyle, bank, "", background, interview);
/** Short id of the system prompt text sent to the model (first 8 hex of its sha256). Logged on model cards and usage rows so a bad card can be reproduced. */
export const PROMPT_V = createHash("sha256").update(prefix).digest("hex").slice(0, 8);
export let log: CallLog;
try {
  log = new CallLog({
    mode: fileArg ? "file" : "live",
    file: fileArg,
    model: S.llm.reflex.model,
    fallbacks: S.llm.reflex.fallbacks,
    prompt: PROMPT_V,
    stt: `${S.stt.provider} ${S.stt.model} ${S.stt.language}`,
    sttFallback: S.stt.fallback,
    profile,
    noAi,
    discard,
  });
} catch (e) {
  console.error(
    `Wingman cannot save this call: cannot create the calls folder (${(e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message}). Check free disk space and the folder permissions: ${CALLS}`,
  );
  process.exit(2);
}
// Second path to the answer window: every cards row also goes to call.ts over a private socket, which hands it to the window. If cards.jsonl cannot
// be written (disk full, folder gone), the cards and the health bars still reach the screen. No socket (pnpm start alone) = disk only.
if (process.env.WINGMAN_OVERLAY_SOCK) {
  const pipe = new CardPipe(process.env.WINGMAN_OVERLAY_SOCK);
  log.onCardRow = (row) => pipe.send(row);
}
sweepLive(CALLS, log.id); // live.jsonl (interim words) that a hard exit left in an older call folder
export const cost = new CostMeter(S.budget.prices, S.budget);
export const sup = new HealthSupervisor({
  tickMs: S.health.tickMs,
  recoverStableMs: S.health.recoverStableMs,
  slowMs: S.llm.reflex.slowMs,
  slowSttMs: S.health.slowSttMs,
  minSamples: S.health.minSamples,
});
sup.set({ noAi, bankFailed: bank.length === 0 && !interview });
export const breakers = new Map(
  REFLEX_MODELS.map((m) => [m, new CircuitBreaker({ failures: S.llm.circuit.failures, windowMs: 10_000, cooldownMs: S.llm.circuit.cooldownMs })]),
);
export const downUntil = new Map<string, number>(); // model -> epoch ms until which it is skipped (provider spend cap: 6 h; Infinity = failed to load at start)

export const transcript: (TimedLine & { ch: Channel; who?: SpeakerInfo })[] = [];
export const speakers = new SpeakerBook(); // the other side's voices (stt.speakers), numbered per call
export const lineOf = (l: { ch: Channel; text: string; who?: SpeakerInfo }) => `${lineLabel(l.ch, speakers.current(l.who))}: ${l.text}`; // the voice's name NOW, so a rename also fixes its earlier lines
export const flowOn = S.flow.enabled && S.stt.speakers;
export const flow = new FlowTracker();
export const contextNotes: string[] = [];
if (brief) contextNotes.push(...briefNotes(brief));
export const attendees = attendeeNames(brief?.who); // first names from the prepared meeting, for naming voices from their introductions
export const snapshot = factsActive({ factsEnabled: S.facts.enabled, interview }) ? loadSnapshot(resolveUserPath(S.facts.file)) : undefined;
export const spotter = snapshot
  ? new EntitySpotter(snapshot, { sslWarnDays: S.facts.sslWarnDays, minAliasLen: S.facts.minAliasLen, lang: UI_LANG })
  : undefined;
export const notesOn = S.notes.enabled && !noAi;
export const notesAbort = new AbortController(); // also used by tips; aborted in shutdown(): no notes call outlives the call
export const callStart = Date.now();
export const frameOn = S.frame.enabled && !noAi;
export const tipsOn = S.tips.enabled && !noAi;
export const tracker = new FrameTracker();
export const tipGate = new TipGate({ minGapMs: S.tips.minGapMs, afterAnswerMs: S.tips.afterAnswerMs });
export const tipsGiven: string[] = [];
export const ECHO = S.audio.echo;
export const gate = new MicGate({ hangoverMs: ECHO.gateHangoverMs, peak: ECHO.gatePeak });
export const echo = new EchoFilter({ windowMs: ECHO.filterWindowMs, threshold: ECHO.filterThreshold });
export const meGate = new MeGate({ minGapMs: S.assist.minGapMs, maxPerMin: S.assist.maxPerMin, protectThemMs: S.assist.protectThemMs });
export const claims: Claim[] = getProfile()
  .claims.map((c) => parseClaim(c))
  .filter((c): c is Claim => !!c);
export const selfGate = new SelfCheckGate({ minGapMs: S.selfCheck.minGapMs });
export const ORPHAN_IDLE_MIN = 5;
