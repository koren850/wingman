// `pnpm demo`: the offline demo call, one command, no keys, no network, no ffmpeg.
// Writes a silent stereo WAV (the replay clock; the engine ignores its audio), then runs the engine on the
// scripted demo call (scripted speech and scripted AI) with a throwaway data folder, default settings and the example pack.
// English by default; `pnpm demo --he` (or WINGMAN_DEMO_LANG=he) plays the Hebrew call.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A PCM WAV of silence: 44-byte header, then zeros. */
export function silentWav(seconds: number, rate = 16000, channels = 2): Buffer {
  const dataBytes = seconds * rate * channels * 2;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28); // byte rate
  h.writeUInt16LE(channels * 2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([h, Buffer.alloc(dataBytes)]);
}

/** "en" (default) or "he": from --he / --en, else WINGMAN_DEMO_LANG. */
export function demoLang(argv: string[] = process.argv.slice(2), env = process.env): "en" | "he" {
  if (argv.includes("--he")) return "he";
  if (argv.includes("--en")) return "en";
  return env.WINGMAN_DEMO_LANG === "he" ? "he" : "en";
}

function main(): number {
  const lang = demoLang();
  const tmp = mkdtempSync(join(tmpdir(), "wingman-demo-"));
  try {
    const wav = join(tmp, "silence.wav");
    writeFileSync(wav, silentWav(90));
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", join(APP, "src", "run.ts"), "--profile", lang === "he" ? "demo" : "demo-en", "--file", wav, "--no-brief"],
      {
        cwd: APP,
        stdio: "inherit",
        env: {
          ...process.env,
          WINGMAN_DATA_DIR: join(tmp, "data"),
          // Ignore the personal settings, profile and pack, so every machine shows the defaults and the example pack.
          WINGMAN_USER_SETTINGS: join(tmp, "settings.yaml"),
          WINGMAN_PROFILE_FILE: join(tmp, "profile.yaml"),
          WINGMAN_PACK_DIR: join(tmp, "pack"),
          WINGMAN_DEMO: "1",
          WINGMAN_STT_SCRIPT: join(APP, "data", "demo", lang === "he" ? "demo-call.json" : "demo-call.en.json"),
          WINGMAN_SCRIPT_GAP_MS: "3000",
        },
      },
    );
    return r.status ?? 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    console.log("\nDemo done. It ran in a temporary folder, now deleted.");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
