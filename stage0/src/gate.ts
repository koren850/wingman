// Hebrew STT gate (STRUCTURE.md Stage 0 / S2). Streams each recording to Deepgram in real time and reports:
//   term recall on the gold English tech terms (pass >= 85%), endpoint-to-final p50/p95 (pass <= 600 ms),
//   and speakers found by diarization.
//   pnpm gate [files...]     default: data/gold/recordings/* (your real recordings)
//   pnpm gate data/gold/synthetic.wav   dry run on the Carmit TTS version
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import YAML from "yaml";
import { requireKeys, DATA } from "./env.ts";
import { decode } from "./audio.ts";
import { SttStream, type SttResult } from "./stt.ts";
import { containsPhrase } from "./normalize.ts";

const keys = requireKeys(["deepgram"]);
const allItems = JSON.parse(readFileSync(join(DATA, "gold", "terms.json"), "utf8")) as { id: string; sentence: string; terms: string[] }[];
// Options: --count N (first N sentences) · --ids t01,t02 · --no-keyterms (A/B run) · --language he|multi. Default: all 40 sentences.
const argv = process.argv.slice(2);
const flag = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const countArg = flag("--count"), idsArg = flag("--ids");
const language = (flag("--language") ?? "he") as "he" | "multi" | "en";   // --language multi = Hebrew+English code-switching
const items = idsArg ? allItems.filter((i) => idsArg.split(",").map((x) => x.trim()).includes(i.id))
  : countArg ? allItems.slice(0, Math.max(1, Number(countArg) || allItems.length)) : allItems;
const useKeyterms = !argv.includes("--no-keyterms");
const keyterms = useKeyterms ? readFileSync(join(DATA, "keyterms.txt"), "utf8").split("\n").map((s) => s.trim()).filter(Boolean) : [];
const fileArgs: string[] = [];
for (let i = 0; i < argv.length; i++) { if (["--count", "--ids", "--language"].includes(argv[i])) i++; else if (!argv[i].startsWith("--")) fileArgs.push(argv[i]); }
const aliasFile = join(DATA, "aliases.yaml");
const aliases: Record<string, string[]> = existsSync(aliasFile) ? YAML.parse(readFileSync(aliasFile, "utf8")) ?? {} : {};
const terms = [...new Set(items.flatMap((i) => i.terms))];

const recDir = join(DATA, "gold", "recordings");
const files = fileArgs.length ? fileArgs
  : existsSync(recDir) ? readdirSync(recDir).filter((f) => /\.(wav|m4a|mp3|aiff?|caf)$/i.test(f)).map((f) => join(recDir, f)) : [];
if (!files.length) { console.error(`No recordings. Put them in ${recDir} (see data/gold/SCRIPT.md), or pass a file.`); process.exit(2); }

const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN; };

async function run(file: string) {
  const pcm = await decode(file, 1);
  const stt = new SttStream({ apiKey: keys.deepgram, channel: "them", keyterms, diarize: true, language } as any);
  stt.on("error", (e) => console.error("stt error", e));
  const finals: SttResult[] = [];
  const delays: number[] = [];
  stt.on("result", (r: SttResult) => {
    if (!r.isFinal || !r.text) return;
    finals.push(r);
    if (r.speechFinal && r.speechEndWall) delays.push(r.arrivedAt - r.speechEndWall);
  });
  await stt.open();
  const frame = 3200; // 100 ms
  for (let off = 0; off < pcm.length; off += frame) {
    stt.send(pcm.subarray(off, off + frame));
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 2500));
  await stt.close();

  const text = finals.map((f) => f.text).join(" ");
  const found = terms.filter((t) => [t, ...(aliases[t] ?? [])].some((v) => containsPhrase(text, v)));
  const missed = terms.filter((t) => !found.includes(t));
  const speakers = new Set(finals.flatMap((f) => f.words.map((w) => w.speaker)).filter((s) => s !== undefined));
  const recall = found.length / terms.length;
  const p50 = pct(delays, 50), p95 = pct(delays, 95);
  const pass = recall >= 0.85 && p50 <= 600;
  const report = [
    `# STT gate: ${basename(file)}`,
    `- audio: ${(pcm.length / 32000).toFixed(0)} s · Deepgram nova-3 ${language} · ${keyterms.length} keyterms${useKeyterms ? "" : " (disabled)"} · ${items.length} sentences scored`,
    `- **term recall: ${(recall * 100).toFixed(0)}%** (${found.length}/${terms.length}; pass >= 85%)`,
    `- **endpoint-to-final: p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms** (${delays.length} endpoints; pass p50 <= 600 ms)`,
    `- speakers found: ${speakers.size}`,
    `- result: **${pass ? "PASS" : "FAIL"}**`,
    "", `Missed terms: ${missed.join(", ") || "none"}`,
    "", "## Transcript", ...finals.map((f) => `- ${f.text}`),
  ].join("\n");
  const out = join(DATA, "gold", `report-${basename(file).replace(/\.[^.]+$/, "")}${language === "he" ? "" : "-" + language}${useKeyterms ? "" : "-nokeyterms"}.md`);
  writeFileSync(out, report + "\n");
  console.log(report.split("\n## Transcript")[0]);
  console.log(`(full report: ${out})\n`);
  return pass;
}

let allPass = true;
for (const f of files) allPass = (await run(f)) && allPass;
process.exitCode = allPass ? 0 : 1;
