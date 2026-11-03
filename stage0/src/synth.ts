// Builds synthetic test audio with the macOS Hebrew voice (Carmit):
//   data/synthetic/call1.wav   stereo, L = me, R = them (from call1.json)
//   data/gold/synthetic.wav    the 40 gold sentences read by Carmit (for a dry run of the STT gate)
// Synthetic TTS hides real STT problems; the real gold set decides the gate.
// macOS only (uses `say` and the Carmit voice). Dev tool: pnpm synth.
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, writeWav } from "./audio.ts";
import { DATA } from "./env.ts";

const tmp = mkdtempSync(join(tmpdir(), "wingman-synth-"));
let n = 0;
/** Speaks `text` with `say` at `rate` words/min and returns it as 16 kHz mono PCM. */
async function speak(text: string, rate: number): Promise<Buffer> {
  const f = join(tmp, `${n++}.aiff`);
  execFileSync("say", ["-v", "Carmit", "-r", String(rate), "-o", f, text]);
  return decode(f, 1);
}
/** `ms` of silence as 16 kHz mono s16le PCM. */
const silence = (ms: number) => Buffer.alloc(Math.round((16000 * ms) / 1000) * 2);

/** Builds the two-channel scripted call (L = me, R = them, equal length) from data/synthetic/call1.json. */
async function call1() {
  const turns = JSON.parse(readFileSync(join(DATA, "synthetic", "call1.json"), "utf8")) as { speaker: "me" | "them"; text: string }[];
  const L: Buffer[] = [], R: Buffer[] = [];
  for (const t of turns) {
    const pcm = await speak(t.text, t.speaker === "them" ? 175 : 195);
    const pad = silence(pcm.length / 32); // unused leftover (see `void pad` below); the other channel is padded with zeros of the same length instead
    if (t.speaker === "me") { L.push(pcm); R.push(Buffer.alloc(pcm.length)); } else { R.push(pcm); L.push(Buffer.alloc(pcm.length)); }
    const gap = silence(t.speaker === "them" ? 2500 : 900); // pause after a client turn = room for a card
    L.push(gap); R.push(gap); void pad;
  }
  const l = Buffer.concat(L), r = Buffer.concat(R);
  const st = Buffer.alloc(l.length * 2);
  for (let i = 0; i < l.length; i += 2) { l.copy(st, i * 2, i, i + 2); r.copy(st, i * 2 + 2, i, i + 2); }
  await writeWav(join(DATA, "synthetic", "call1.wav"), st, 2);
  console.log(`call1.wav: ${(l.length / 32000).toFixed(0)} s, ${turns.length} turns`);
}

/** Reads all 40 gold sentences into one mono wav with 2.5 s gaps, for a dry run of `pnpm gate`. */
async function gold() {
  const items = JSON.parse(readFileSync(join(DATA, "gold", "terms.json"), "utf8")) as { sentence: string }[];
  const parts: Buffer[] = [];
  for (const it of items) { parts.push(await speak(it.sentence, 175), silence(2500)); }
  const mono = Buffer.concat(parts);
  await writeWav(join(DATA, "gold", "synthetic.wav"), mono, 1);
  console.log(`gold/synthetic.wav: ${(mono.length / 32000).toFixed(0)} s, ${items.length} sentences`);
}

await call1();
await gold();
