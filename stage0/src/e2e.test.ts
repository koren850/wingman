// End-to-end call test with no network: scripted STT plays data/test/e2e-call.json, a scripted model answers,
// and the real call loop (src/run.ts) runs over a silent stereo wav. Checks the call folder it writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, CALLS } from "./env.ts";
import { writeWav } from "./audio.ts";

test("e2e: a scripted call produces bank cards, a stall, captures, a fact card, a note, and drops echo", { timeout: 60_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wingman-e2e-"));
  const wav = join(tmp, "silence.wav");
  await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 14), 2);   // 14 s of stereo silence: the file clock ends the call
  const r = spawnSync(join(ROOT, "node_modules", ".bin", "tsx"), [join(ROOT, "src", "run.ts"), "--profile", "e2e", "--file", wav, "--no-brief"], {
    cwd: ROOT, encoding: "utf8", timeout: 50_000,
    env: { ...process.env, WINGMAN_STT_SCRIPT: join(ROOT, "data", "test", "e2e-call.json"), WINGMAN_SCRIPT_GAP_MS: "1100", WINGMAN_ECHO: "both" },
  });
  const dir = join(CALLS, readlinkSync(join(CALLS, "latest")));
  try {
    assert.equal(r.status, 0, `run.ts exited ${r.status}\n${r.stdout}\n${r.stderr}`);
    const rows = (f: string) => existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const cards = rows("cards.jsonl"), events = rows("events.jsonl"), transcript = rows("transcript.jsonl");
    const shown = cards.filter((c) => c.type === "card" && !c.health && c.badge !== "info");
    const ids = new Set(shown.map((c) => `${c.badge}:${c.turnId === "side" ? c.say : ""}`));
    // Answers: slow site and backups from the bank; price -> stall line, never a price.
    assert.ok(shown.some((c) => c.badge === "bank" && /איטי/.test(c.say)), "slow-site bank card");
    assert.ok(shown.some((c) => c.badge === "bank" && /גיבוי/.test(c.say)), "backup bank card");
    const price = shown.filter((c) => /כמה זה עולה/.test(c.question ?? ""));
    assert.ok(price.length && price.every((c) => c.badge === "stall" || (c.badge === "bank" && /המחיר תלוי|הצעה/.test(c.say))), "price question gets a stall/price-stall card");
    assert.ok(!shown.some((c) => /₪|\d{3,}\s*שקל/.test(c.say ?? "")), "no price on any card");
    // Capture box: phone from Hebrew digit words, email.
    const caps = cards.filter((c) => c.type === "capture").map((c) => `${c.kind}:${c.value}`);
    assert.ok(caps.includes("phone:054-1234567"), `phone captured: ${caps}`);
    assert.ok(caps.includes("email:dana@acmestores.co.il"), `email captured: ${caps}`);
    // Fact card for the fixture client, and the instant-start proposal.
    assert.ok(shown.some((c) => c.badge === "fact" && /אקמה סטורז/.test(c.say)), "fact card");
    assert.ok(cards.some((c) => c.id === "propose-client"), "client proposal");
    // Live note from the scripted notes model.
    assert.ok(shown.some((c) => c.badge === "note"), `a live note (${[...ids].join(", ")})`);
    // Speakers mode: Dan's line that repeats the client is dropped as echo, his own line is kept.
    assert.ok(events.some((e) => e.type === "echo.drop"), "echo line dropped");
    const me = transcript.filter((t) => t.ch === "me").map((t) => t.text);
    assert.ok(me.some((t) => /מדבר דן/.test(t)), "Dan's own words kept");
    assert.ok(!me.some((t) => /נטען ממש לאט/.test(t)), "echo of the client not in Dan's transcript");
    // The call closes cleanly with a speed summary.
    assert.ok(events.some((e) => e.type === "speed.summary"), "speed summary written");
  } finally {
    rmSync(dir, { recursive: true, force: true }); rmSync(join(CALLS, "latest"), { force: true }); rmSync(tmp, { recursive: true, force: true });
  }
});
