// Phone mode: a phone call on speaker next to the Mac. There is no system audio; the Mac microphone hears both people,
// so the "me" STT channel runs with diarization and this module decides, per voice, who is the user and who is the other side.
// The user sits next to the Mac microphone and the phone's speaker is further away and band-limited, so the user's voice is
// the LOUDER one. Until two voices have been heard, the first voice is taken as the user (you answer the call first).
// Nothing is saved: loudness is kept for the last minute only, in memory.
import type { SttResult, Word } from "./providers/stt/types.ts";

/** True when a prepared meeting's notes (or WINGMAN_PHONE=1) say the call is a phone call on speaker. */
export function isPhoneCall(notes: string[] | undefined, env = process.env): boolean {
  if (env.WINGMAN_PHONE === "1") return true;
  if (env.WINGMAN_PHONE === "0") return false;
  return (notes ?? []).some((n) => /phone call on speaker|speakerphone|phone on speaker|phone mode|שיחת טלפון ברמקול|טלפון על רמקול|טלפון ברמקול/i.test(n));
}

type Frame = { t: number; rms: number };
type Stat = { sum: number; n: number; firstAt: number };

/** Root mean square of an s16le buffer, 0-1. */
export function rmsOf(pcm: Buffer): number {
  let s = 0,
    n = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = pcm.readInt16LE(i) / 32768;
    s += v * v;
    n++;
  }
  return n ? Math.sqrt(s / n) : 0;
}

export class PhoneRouter {
  private frames: Frame[] = [];
  private stats = new Map<number, Stat>();
  private meId: number | undefined;
  private swapped = false;
  constructor(private o: { frameMs?: number; keepMs?: number; minWords?: number; margin?: number } = {}) {}

  /** Mic audio as it is captured (wall-clock ms of the END of the chunk). Split into 20 ms loudness frames. */
  recordMic(pcm: Buffer, endWall = Date.now()) {
    const fMs = this.o.frameMs ?? 20,
      bytes = fMs * 32; // 16 kHz s16le = 32 bytes per ms
    const n = Math.floor(pcm.length / bytes);
    for (let i = 0; i < n; i++) this.frames.push({ t: endWall - (n - i) * fMs, rms: rmsOf(pcm.subarray(i * bytes, (i + 1) * bytes)) });
    const keep = endWall - (this.o.keepMs ?? 60_000);
    let k = 0;
    while (k < this.frames.length && this.frames[k].t < keep) k++;
    if (k) this.frames.splice(0, k);
  }

  /** Mean loudness of the mic between two wall-clock times (undefined when no frames). */
  private loudness(a: number, b: number): number | undefined {
    let s = 0,
      n = 0;
    for (const f of this.frames)
      if (f.t >= a - 20 && f.t <= b) {
        s += f.rms;
        n++;
      }
    return n ? s / n : undefined;
  }

  /** The user flips the guess (wrong voice was taken as "me"). */
  swap() {
    this.swapped = !this.swapped;
  }

  /** Which raw speaker id is the user right now. */
  private me(): number | undefined {
    const min = this.o.minWords ?? 3,
      margin = this.o.margin ?? 1.2;
    const ready = [...this.stats.entries()].filter(([, s]) => s.n >= min).map(([id, s]) => ({ id, mean: s.sum / s.n, firstAt: s.firstAt }));
    if (ready.length >= 2) {
      ready.sort((x, y) => y.mean - x.mean);
      const cur = ready.find((r) => r.id === this.meId);
      // Hysteresis: keep the current choice unless another voice is clearly louder.
      if (!cur || ready[0].mean > cur.mean * margin) this.meId = ready[0].id;
    } else if (this.meId === undefined) {
      const first = [...this.stats.entries()].sort((a, b) => a[1].firstAt - b[1].firstAt)[0];
      if (first) this.meId = first[0];
    }
    return this.meId;
  }

  /** Role of a raw speaker id ("me" / "them"). Unknown speaker: "me" (never answer the user's own words as a question). */
  roleOf(id: number | undefined): "me" | "them" {
    if (id === undefined) return "me";
    const me = this.me();
    const isMe = me === undefined ? true : id === me;
    return isMe !== this.swapped ? "me" : "them";
  }

  /** Splits one result of the mixed mic stream into one result per speaker run and labels each run me / them. */
  route(r: SttResult): SttResult[] {
    const words = r.words ?? [];
    if (!words.length || words.every((w) => typeof w.speaker !== "number")) return [{ ...r, channel: this.roleOf(this.lastId) }];
    const lastEnd = words[words.length - 1].end;
    const endWall = r.speechEndWall ?? r.arrivedAt - 300;
    const wallOf = (t: number) => endWall - (lastEnd - t) * 1000;
    // Learn loudness only from finals (interims repeat the same words).
    if (r.isFinal)
      for (const w of words) {
        if (typeof w.speaker !== "number") continue;
        const l = this.loudness(wallOf(w.start), wallOf(w.end));
        if (l === undefined) continue;
        const s = this.stats.get(w.speaker) ?? { sum: 0, n: 0, firstAt: wallOf(w.start) };
        s.sum += l;
        s.n++;
        this.stats.set(w.speaker, s);
      }
    const runs: Word[][] = [];
    for (const w of words) {
      const prev = runs[runs.length - 1];
      if (prev && prev[0].speaker === w.speaker) prev.push(w);
      else runs.push([w]);
    }
    // Merge one-word runs into the neighbour (diarization flicker on short words).
    for (let i = 0; i < runs.length; i++)
      if (runs.length > 1 && runs[i].length === 1) {
        const into = i > 0 ? i - 1 : i + 1;
        runs[into] = i > 0 ? [...runs[into], ...runs[i]] : [...runs[i], ...runs[into]];
        runs.splice(i, 1);
        i--;
      }
    const out: SttResult[] = [];
    runs.forEach((run, i) => {
      const id = run.find((w) => typeof w.speaker === "number")?.speaker;
      this.lastId = id;
      const last = i === runs.length - 1;
      out.push({
        ...r,
        channel: this.roleOf(id),
        words: run,
        text: run.map((w) => w.word).join(" "),
        speechFinal: last ? r.speechFinal : r.isFinal, // a speaker change ends that speaker's utterance
        speechEndWall: last ? r.speechEndWall : wallOf(run[run.length - 1].end),
      });
    });
    return out;
  }
  private lastId: number | undefined;

  /** For the log: per voice word counts, mean loudness and which one is the user. */
  summary() {
    return {
      me: this.me(),
      swapped: this.swapped,
      voices: [...this.stats.entries()].map(([id, s]) => ({ id, words: s.n, loud: Number((s.sum / s.n).toFixed(4)) })),
    };
  }
}
