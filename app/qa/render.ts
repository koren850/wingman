// Synthetic call renderer: scenario JSON -> stereo 16 kHz 16-bit WAV (L = me / the user's mic, R = them / the other side), with real timing.
//   tsx qa/render.ts <scenario…|--all>      writes qa/out/<scenario>.wav + qa/out/<scenario>.timeline.json
// Speech comes from macOS `say` (Carmit for Hebrew, Samantha/Daniel for English), cached by text hash in qa/cache/. No network, no keys.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { writeWav } from "../src/audio.ts";

const QA = dirname(fileURLToPath(import.meta.url));
export const SCEN_DIR = join(QA, "scenarios"),
  OUT_DIR = join(QA, "out"),
  CACHE_DIR = join(QA, "cache");
const SR = 16000;
const BASE_WPM = 170;

export type Expect = {
  question?: boolean; // is this client turn a question that should be detected?
  card?: string | string[]; // bank id | "stall" (stall line or any stall-* card) | "ai" | "none"; an array = any of these
  joinWith?: "prev"; // this turn completes a question started by the previous client turn (split question)
  part?: "head"; // first fragment of a split question: not graded on its own
  forMe?: "answer" | "none"; // a "me" turn: the user asks Wingman (a "For you" card is expected) or asks the other person / thinks aloud (no card)
  note?: string;
};
export type Turn = { speaker: "me" | "them"; text: string; pauseBeforeMs?: number; rate?: number; overlapMs?: number; voice?: string; expect?: Expect };
/** What the call frame and the tips should look like for this scenario (graded by qa/grade.ts). Only scenarios with a `frame` block are graded on it. */
export type FrameExpect = {
  kind: string | string[]; // accepted final frame kinds
  topicAny?: string[]; // at least one of these words in the final topic / goal / entities / checklist
  minChecklist?: number; // checklist items the frame should have at the end
  minTips?: number; // tip cards shown during the call
  tipAny?: string[]; // at least one tip mentions one of these words (a cheap relevance check; the tips are printed for a human to read)
  allowBank?: string[]; // bank card ids that are fine on this call
};
export type Scenario = { name?: string; title: string; focus?: string; voices?: { me?: string; them?: string }; frame?: FrameExpect; turns: Turn[] };
export type TimelineTurn = { i: number; speaker: "me" | "them"; text: string; startMs: number; endMs: number };

/** Reads qa/scenarios/<name>.json. The scenario name is the file name. */
export function loadScenario(name: string): Scenario & { name: string } {
  const s = JSON.parse(readFileSync(join(SCEN_DIR, `${name}.json`), "utf8")) as Scenario;
  return { ...s, name };
}
/** Sorted names of every scenario file. */
export function allScenarioNames(): string[] {
  return readdirSync(SCEN_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => basename(f, ".json"))
    .sort();
}

/** The macOS voices that speak Hebrew. Every other voice named in a scenario is taken to be an English one. */
const HEBREW_VOICES = new Set(["Carmit"]);
/** Default voice per language and side when the scenario names none that fits the text. */
const DEFAULT_VOICE = { he: { me: "Carmit", them: "Carmit" }, en: { me: "Daniel", them: "Samantha" } } as const;
/**
 * The voice for one turn. A scenario names one voice per side, but a mixed Hebrew and English call has turns in both languages, and an English voice that reads
 * Hebrew says "dot, question mark" (in a recorded run: speech-to-text 56% instead of 77%). So a voice is used only for text in its own language; otherwise the default
 * voice of the text's language and side is used. An explicit `voice` on the turn always wins.
 */
export function voiceFor(text: string, side: "me" | "them", named: string | undefined, turnVoice?: string): string {
  if (turnVoice) return turnVoice;
  const he = (text.match(/[\u0590-\u05FF]/g) ?? []).length,
    lat = (text.match(/[A-Za-z]/g) ?? []).length;
  const lang: "he" | "en" = he > lat ? "he" : "en";
  const fits = named && (HEBREW_VOICES.has(named) ? lang === "he" : lang === "en");
  return fits ? named : DEFAULT_VOICE[lang][side];
}

/** Mono 16 kHz s16le PCM for one phrase (cached). */
function speak(text: string, voice: string, rate: number): Buffer {
  const wpm = Math.round(BASE_WPM * rate);
  const key = createHash("sha1").update(`${voice}|${wpm}|${text}`).digest("hex").slice(0, 20);
  const wav = join(CACHE_DIR, `${key}.wav`);
  if (!existsSync(wav)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    const r = spawnSync("say", ["-v", voice, "-r", String(wpm), "-o", wav, "--file-format=WAVE", "--data-format=LEI16@16000", text], { encoding: "utf8" });
    if (r.status !== 0 || !existsSync(wav)) throw new Error(`say failed for "${text.slice(0, 30)}": ${r.stderr}`);
  }
  const b = readFileSync(wav);
  // find the "data" chunk (say may write extra chunks)
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4),
      size = b.readUInt32LE(off + 4);
    if (id === "data") return b.subarray(off + 8, Math.min(b.length, off + 8 + size));
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in " + wav);
}

/** Deterministic light noise (xorshift32 from a fixed seed, so renders are repeatable) so the line is not digital silence; silence can make the STT behave differently. */
function noise(n: number, amp: number, seed: number): Int16Array {
  const out = new Int16Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = Math.round(((x / 0xffffffff) * 2 - 1) * amp);
  }
  return out;
}

/**
 * Renders a scenario to qa/out/<name>.wav (stereo, L = me, R = them) and <name>.timeline.json. Turns are placed one after another
 * (pauseBeforeMs, default 700 ms; overlapMs lets a turn start before the previous one ends), with 0.8 s lead-in and 4 s tail.
 * Returns the wav path, the per-turn timeline (ms) and the total duration. Needs macOS `say`.
 */
export async function renderScenario(sc: Scenario & { name: string }): Promise<{ wav: string; timeline: TimelineTurn[]; durationMs: number }> {
  const voices = { me: sc.voices?.me, them: sc.voices?.them };
  const tl: TimelineTurn[] = [];
  const clips: { speaker: "me" | "them"; start: number; pcm: Buffer }[] = [];
  let cursor = Math.round(0.8 * SR); // lead-in
  let lastEnd = cursor;
  sc.turns.forEach((t, i) => {
    const pcm = speak(t.text, voiceFor(t.text, t.speaker, voices[t.speaker], t.voice), t.rate ?? 1);
    const pause = Math.round(((t.pauseBeforeMs ?? 700) / 1000) * SR);
    const overlap = Math.round(((t.overlapMs ?? 0) / 1000) * SR);
    const start = Math.max(0, lastEnd + pause - overlap);
    const samples = pcm.length / 2;
    clips.push({ speaker: t.speaker, start, pcm });
    lastEnd = Math.max(lastEnd, start + samples);
    tl.push({ i, speaker: t.speaker, text: t.text, startMs: Math.round((start / SR) * 1000), endMs: Math.round(((start + samples) / SR) * 1000) });
    cursor = start + samples;
  });
  const total = lastEnd + Math.round(4 * SR); // tail: lets the last final and card arrive
  const L = new Int16Array(total),
    R = new Int16Array(total);
  const nL = noise(total, 6, 11),
    nR = noise(total, 6, 29);
  for (let i = 0; i < total; i++) {
    L[i] = nL[i];
    R[i] = nR[i];
  }
  for (const c of clips) {
    const dst = c.speaker === "me" ? L : R;
    for (let i = 0; i < c.pcm.length / 2; i++) {
      const k = c.start + i;
      if (k >= total) break;
      dst[k] = Math.max(-32768, Math.min(32767, dst[k] + c.pcm.readInt16LE(i * 2)));
    }
  }
  const inter = Buffer.alloc(total * 4);
  for (let i = 0; i < total; i++) {
    inter.writeInt16LE(L[i], i * 4);
    inter.writeInt16LE(R[i], i * 4 + 2);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const wav = join(OUT_DIR, `${sc.name}.wav`);
  await writeWav(wav, inter, 2, SR);
  writeFileSync(join(OUT_DIR, `${sc.name}.timeline.json`), JSON.stringify(tl, null, 1));
  return { wav, timeline: tl, durationMs: Math.round((total / SR) * 1000) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const names = args.includes("--all") || !args.length ? allScenarioNames() : args.filter((a) => !a.startsWith("--"));
  for (const n of names) {
    const r = await renderScenario(loadScenario(n));
    console.log(`${n}: ${(r.durationMs / 1000).toFixed(0)} s, ${r.timeline.length} turns -> ${r.wav}`);
  }
}
