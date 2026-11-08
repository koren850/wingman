// Shared mutable state of the one call this process runs. Everything that more than one engine module reads or writes lives here, grouped by
// topic; state that only one module uses stays a local `let` in that module. Everything async checks `st.call.shuttingDown` before it writes.
import { performance } from "node:perf_hooks";
import type { SttChannel } from "../providers/stt/channel.ts";
import type { EchoMode } from "../echo.ts";
import { emptyMemory, type MemoryKind, type SessionMemory } from "../session/types.ts";
import { newSchedulerState } from "../moments/scheduler.ts";
import { ECHO, PHONE, S, interview } from "./boot.ts";

/** Monotonic ms (does not jump with the wall clock; on macOS it also stands still while the Mac sleeps). Idle time and frame freshness use it. */
export const mono = () => performance.now();

/** The two speech-to-text channels, created in main() (before that they are not used). */
export const chans = {} as { me: SttChannel; them: SttChannel };

// "auto" starts as "filter" (never mutes the user) and becomes "both" only once the output device is known to be speakers.
const startEcho: EchoMode = PHONE ? "off" : ECHO.mode === "auto" ? "filter" : ECHO.mode;

export const st = {
  /** Call lifecycle. consented: audio may be sent for transcription. */
  call: {
    consented: false,
    shuttingDown: false,
    closing: false as boolean, // shutdown is closing the STT channels: finals still arriving are written to the transcript, but start nothing (no card, no question, no note)
    crashed: false,
    quiet: S.cards.quiet,
    discardNow: false,
    orphaned: false as boolean, // the menu-bar app's pipe closed (it crashed): the call goes on, but stops itself after ORPHAN_IDLE_MIN of silence
    consentedMono: 0,
  },
  /** Last time a card for the other side appeared: answers for the user must not push it off the screen. */
  cards: { lastThemCardAt: 0 },
  /** The running answer for the other side; a new question aborts it. */
  turn: { current: undefined as AbortController | undefined, lastAgencyTopicAt: 0 },
  /** Per-call state of the question path (engine/question.ts): turn counter, consecutive model failures, when each prepared card was last shown. */
  q: { turnSeq: 0, reflexErrors: 0, bankShownAt: new Map<string, number>() },
  /** Moment engine (engine/moments.ts, moments.engine = v2): model call counter, the newest direct and observer call (an older stream cannot show a card), the
   *  scheduler state, the call memory every model call reads (the memory updater replaces it; a failed update keeps the last good one) and the "AI paused" reason. */
  m: {
    seq: 0,
    direct: 0,
    /** Direct moment calls that have not finished yet. */
    directBusy: 0,
    obs: 0,
    sched: newSchedulerState(),
    mem: emptyMemory() as SessionMemory,
    paused: undefined as "cap" | "down" | "net" | undefined,
    lastFailKind: undefined as string | undefined,
    lastPromiseAt: 0,
    promised: new Set<string>(),
    lang: undefined as "he" | "en" | undefined,
  },
  /** Who spoke last and when (wall ms unless named Mono). */
  voice: {
    lastMeVoiced: 0,
    lastThemSpeech: 0,
    lastThemSound: Date.now(),
    themSoundSeen: false,
    lastThemText: Date.now(),
    lastSpeechMono: mono(),
    lastSysFrame: mono(),
    themHeard: (() => {}) as () => void,
  }, // clears the "I only hear you" banner when the other side's audio or text returns
  /** The ask window (Ctrl+Opt+A / the "ask" command). */
  ask: { until: 0, timer: undefined as NodeJS.Timeout | undefined },
  /** Answers for the user's own questions. */
  me: { seq: 0, shown: 0, current: undefined as AbortController | undefined, lat: [] as { total: number; source: string }[] },
  stt: { foreignDropped: 0 },
  /** Speakers mode: mic gate + echo text filter (echo.ts). */
  echo: {
    mode: startEcho,
    useGate: startEcho === "gate" || startEcho === "both",
    useFilter: startEcho === "filter" || startEcho === "both",
    gatedMs: 0,
    dropped: 0,
  },
};

/** The kind of call for the moment prompt and the scheduler: a practice interview (the plan says so), else what the call memory learned. */
export const callKind = (): MemoryKind => (interview ? "interview" : st.m.mem.kind);
