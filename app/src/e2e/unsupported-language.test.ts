// End-to-end, no network: a call in another language (Russian finals) shows ONE "language not supported" status line, in the UI language,
// and the finals never become cards or transcript lines.
import "../test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../env.ts";
import { writeWav } from "../audio.ts";
import { tsx } from "../test-platform.ts";

for (const lang of ["he", "en"] as const) {
  test(`e2e: unsupported language shows one notice (${lang})`, { timeout: 60_000 }, async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wingman-e2e-lang-"));
    const wav = join(tmp, "silence.wav"),
      CALLS = join(tmp, "calls");
    await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 8), 2);
    const child = spawn(...tsx([join(ROOT, "src", "run.ts"), "--profile", "e2e-me", "--file", wav, "--no-brief", "--set", `ui.language=${lang}`]), {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        WINGMAN_CONTROL: "1",
        WINGMAN_STT_SCRIPT: join(ROOT, "data", "test", "e2e-lang-call.json"),
        WINGMAN_SCRIPT_GAP_MS: "900",
        WINGMAN_CALL_APP: "none",
        WINGMAN_CALLS_DIR: CALLS,
      },
    });
    let out = "",
      err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    const code: number | null = await new Promise((res) => child.on("exit", res));
    assert.equal(code, 0, `run.ts exited ${code}\n${out}\n${err}`);
    const dir = join(CALLS, readlinkSync(join(CALLS, "latest")));
    const rows = (f: string) =>
      existsSync(join(dir, f))
        ? readFileSync(join(dir, f), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
    const events = rows("events.jsonl");
    const notices = events.filter((e) => e.type === "health" && e.id === "lang");
    assert.equal(notices.length, 1, `one notice: ${JSON.stringify(notices)}\n${out}`);
    assert.equal(
      notices[0].text,
      lang === "en" ? "This language is not supported yet. Wingman understands English and Hebrew." : "השפה הזו עדיין לא נתמכת. Wingman מבין אנגלית ועברית.",
    );
    const ev = events.find((e) => e.type === "lang.unsupported");
    assert.ok(ev && ev.foreign >= 3, "counter logged");
    assert.equal(events.filter((e) => e.type === "stt.foreign-script").length, 3, "the Russian finals are still dropped");
    assert.ok(!rows("transcript.jsonl").some((t) => /[Ѐ-ӿ]/.test(t.text)), "no Russian in the transcript");
  });
}
