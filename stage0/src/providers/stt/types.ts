// STT provider contract. Every provider returns the same normalized events:
//   'result' (SttResult) · 'disconnected' ({channel, code, reason, error?}) · 'reconnected' · 'error' (ProviderError) · 'close'
// Optional: 'keyterms_off' (Deepgram retried without keyterms). Deepgram also emits 'utteranceEnd'; nothing listens for it yet.
// SttChannel (channel.ts) sits on top and adds provider switching; the adapters here only reconnect their own socket.
import type { EventEmitter } from "node:events";
import type { ProviderError } from "../errors.ts";

/** "me" = the user's microphone, "them" = system audio (the other side). */
export type Channel = "me" | "them";
export type Word = { word: string; start: number; end: number; speaker?: number; confidence?: number };
/** One transcript event. Interim results have isFinal=false; speechFinal marks the end of an utterance. Word times are seconds on the connection's audio clock. */
export type SttResult = {
  channel: Channel;
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  words: Word[];
  /** wall-clock ms of the last word's end, from the audio clock (valid when audio is sent in real time) */
  speechEndWall?: number;
  arrivedAt: number;
  confidence?: number;
};

/** Per-stream options. Audio is always 16 kHz signed 16-bit mono PCM (32 bytes per ms). */
export type SttOptions = {
  apiKey: string;
  channel: Channel;
  language?: string;
  keyterms?: string[];
  endpointingMs?: number;
  utteranceEndMs?: number;
  /** Deepgram only: send mip_opt_out=true so the audio is not used for model improvement. */
  mipOptOut?: boolean;
  keepAliveMs?: number;
  finalizeSilenceMs?: number;
  diarize?: boolean;
  model?: string;
  baseUrl?: string;
  debug?: boolean;
  /** retry once without keyterms if the provider rejects the open . Default true. */
  keytermRetry?: boolean;
};

/** One live socket for one channel. */
export interface SttStreamLike extends EventEmitter {
  open(): Promise<void>;
  send(pcm: Buffer): boolean; // false = dropped; never throws
  close(): Promise<void>;
  readonly isOpen: boolean;
  readonly audioSeconds: number; // for cost
  dropped: number;
}

/** An STT adapter: capabilities plus a factory for streams. */
export interface SttProvider {
  id: "deepgram" | "soniox" | "gladia";
  experimental: boolean;
  capabilities: { keyterms: boolean; diarize: boolean; interim: boolean; maxKeyterms: number };
  create(opts: SttOptions): SttStreamLike;
  /** open a real socket and close it (used by src/doctor.ts). Never throws. */
  probe(opts: Omit<SttOptions, "channel">): Promise<{ ok: true } | { ok: false; error: ProviderError }>;
}

/**
 * Wall-clock ms of a word's end. Audio is sent in real time, so audio sent on this connection but not yet
 * transcribed is (sentSeconds - lastWordEnd). Falls back to arrivedAt - 400 if that looks wrong
 * (e.g. right after a reconnect when the clocks are not comparable).
 */
export function speechEndWall(arrivedAt: number, sentSecondsThisConn: number, lastWordEnd: number): number {
  const lag = (sentSecondsThisConn - lastWordEnd) * 1000;
  if (!Number.isFinite(lag) || lag < 0 || lag > 15000) return arrivedAt - 400;
  return arrivedAt - lag;
}
