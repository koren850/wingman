// The phase of the one call this process runs. One value, moving forward only:
//   starting -> waiting (listening not confirmed yet) -> live -> closing (Stop: STT finals still land in the transcript) -> closed (channels shut) -> ended
// A phase can be skipped (starting -> live when no consent is asked) but never repeated backwards, so a late "consent" cannot write "live" over a stop.
// `isStopping()` is true from "closing" on; every async path checks it before it starts something new. call.json carries the phase that the
// answer window reads: starting, waiting, live, ended (closing and closed are internal; call.json already says "ended" while the summary runs).
import { log } from "./boot.ts";

export type CallPhase = "starting" | "waiting" | "live" | "closing" | "closed" | "ended";
const RANK: Record<CallPhase, number> = { starting: 0, waiting: 1, live: 2, closing: 3, closed: 4, ended: 5 };
const rank = (p: CallPhase) => RANK[p];

let phase: CallPhase = "starting";

export const callPhase = () => phase;
/** True from Stop on (closing, closed, ended). */
export const isStopping = () => rank(phase) >= rank("closing");
/** True only while the STT sockets are being closed: finals that still arrive are written to the transcript, but start nothing. */
export const isClosing = () => phase === "closing";

/** Moves to `to` when that is forward (or the same phase again). Returns false, and changes nothing, when it would go backwards. */
export function transition(to: CallPhase, extra: Record<string, unknown> = {}): boolean {
  if (rank(to) < rank(phase)) return false;
  phase = to;
  if (to === "starting" || to === "waiting" || to === "live") writeCall({ phase: to, ...extra });
  return true;
}

/** Writes endedAt and phase "ended" to call.json. Safe to call more than once (the last call wins), never throws. The only place that writes "ended". */
export function writeEnded(crashed: boolean) {
  writeCall({ endedAt: new Date().toISOString(), crashed, phase: "ended" });
}

function writeCall(row: Record<string, unknown>) {
  try {
    log.update(row);
  } catch {
    /* best effort: the log itself may be what failed */
  }
}

/** Tests only: back to "starting". */
export function resetPhaseForTest() {
  phase = "starting";
}
