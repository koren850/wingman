// End-to-end (subprocess): engine behaviours found in the engine review (AUDIT-2026-11-06/8). The call loop (src/run.ts) runs offline over a
// silent wav with scripted speech-to-text and a scripted model: error bar, flow mode, Stop during STT close, echo-filter order, quiet mode.
import "../test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, readlinkSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, CALLS } from "../env.ts";
import { writeWav } from "../audio.ts";
import { tsx } from "../test-platform.ts";

type Row = Record<string, any>;
type Run = { code: number; out: string; err: string; cards: Row[]; events: Row[]; transcript: Row[] };
/** Runs one offline call. `script` = the scripted speech lines; `wavSeconds` = how long the file clock runs; `stdin` = [ms after start, line] commands (control mode). */
async function runCall(o: {
  script: Row[];
  wavSeconds?: number;
  args?: string[];
  env?: Record<string, string>;
  stdin?: [number, string][];
  onStatus?: (m: Row, send: (line: string) => void) => void;
  profile?: string;
}): Promise<Run> {
  const tmp = mkdtempSync(join(tmpdir(), "wingman-fix-"));
  const wav = join(tmp, "silence.wav"),
    script = join(tmp, "script.json");
  await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * (o.wavSeconds ?? 5)), 2);
  writeFileSync(script, JSON.stringify(o.script));
  const control = !!o.stdin || !!o.onStatus;
  const p = spawn(
    ...tsx([join(ROOT, "src", "run.ts"), "--profile", o.profile ?? "e2e", "--file", wav, "--no-brief", "--set", "moments.engine=legacy", ...(o.args ?? [])]),
    {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, WINGMAN_STT_SCRIPT: script, WINGMAN_SCRIPT_GAP_MS: "300", ...(control ? { WINGMAN_CONTROL: "1" } : {}), ...o.env },
    },
  );
  const send = (line: string) => {
    try {
      p.stdin.write(line + "\n");
    } catch {
      /* the process already exited */
    }
  };
  let out = "",
    err = "";
  p.stdout.on("data", (d) => {
    out += d;
    for (const line of d.toString().split("\n")) {
      if (line.startsWith("@@wingman ")) {
        try {
          o.onStatus?.(JSON.parse(line.slice(10)), send);
        } catch {
          /* not a status line */
        }
      }
    }
  });
  p.stderr.on("data", (d) => (err += d));
  for (const [ms, line] of o.stdin ?? []) setTimeout(() => send(line), ms);
  const code: number = await new Promise((res) => p.on("exit", (c) => res(c ?? -1)));
  if (!existsSync(join(CALLS, "latest"))) throw new Error(`run.ts exited ${code} before it made a call folder\n${out.slice(-1500)}\n${err.slice(-1500)}`);
  const dir = join(CALLS, readlinkSync(join(CALLS, "latest")));
  try {
    const rows = (f: string): Row[] =>
      existsSync(join(dir, f))
        ? readFileSync(join(dir, f), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
    return { code, out, err, cards: rows("cards.jsonl"), events: rows("events.jsonl"), transcript: rows("transcript.jsonl") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(CALLS, "latest"), { force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("1. a hard AI error bar clears when the same model answers again", { timeout: 60_000 }, async () => {
  const r = await runCall({
    wavSeconds: 9,
    script: [
      { speaker: "them", text: "ויש לכם גיבוי של האתר אם משהו נופל" },
      { speaker: "them", text: "והאתר שלי נטען ממש לאט בזמן האחרון, למה זה קורה", afterMs: 3500 },
    ],
    args: ["--set", "llm.circuit.cooldownMs=1000", "--set", "health.recoverStableMs=1000", "--set", "health.tickMs=200"],
    env: { WINGMAN_LLM_FAIL: "1:401" },
  });
  assert.equal(r.code, 0, r.err);
  const red = r.events.find((e) => e.type === "health" && /^ai-/.test(e.id) && e.level === "red");
  assert.ok(red, `a hard error raised the red bar: ${r.events.filter((e) => e.type === "health").map((e) => e.id)}`);
  const clearAt = r.events.findIndex((e) => e.type === "health.clear" && e.id === red!.id);
  assert.ok(clearAt > r.events.indexOf(red!), "the bar is cleared after the model answered again");
});

const w = (spk: number, text: string) => text.split(" ").map((word, i) => ({ word, start: i * 0.3, end: i * 0.3 + 0.25, speaker: spk }));
const voice = (spk: number, text: string, extra: Row = {}) => ({ speaker: "them", text, words: w(spk, text), ...extra });

test("2. flow mode: a question aimed at the user is not held, a question between the others is", { timeout: 60_000 }, async () => {
  const talk = [
    voice(1, "אז מה נעשה עם הדף הראשי של הפרויקט"),
    voice(2, "אני חושב שצריך לדבר קודם עם הספק"),
    voice(1, "בסדר אבל מתי הם חוזרים אלינו עם תשובה"),
  ];
  const toUser = await runCall({ args: ["--set", "stt.speakers=true"], script: [...talk, voice(2, "ומה דעתך, יש גיבוי של האתר אם משהו נופל")] });
  assert.equal(toUser.code, 0, toUser.err);
  assert.ok(
    toUser.events.some((e) => e.type === "flow.internal"),
    "their discussion was recognised",
  );
  assert.ok(!toUser.events.some((e) => e.type === "flow.hold" && /דעתך/.test(e.text)), "the question to the user is not held");
  assert.ok(
    toUser.cards.some((c) => c.type === "card" && c.badge === "bank" && /גיבוי/.test(c.say)),
    "it gets its prepared card",
  );
  const between = await runCall({ args: ["--set", "stt.speakers=true"], script: [...talk, voice(2, "ויש גיבוי של האתר אם משהו נופל")] });
  assert.ok(
    between.events.some((e) => e.type === "flow.hold" && /גיבוי/.test(e.text)),
    "a question between the others is still held",
  );
  assert.ok(!between.cards.some((c) => c.type === "card" && c.badge === "bank" && /גיבוי/.test(c.say)), "and gets no card");
});

test("3. finals that arrive while Stop closes the STT channels reach the transcript but start no new answer", { timeout: 60_000 }, async () => {
  const r = await runCall({
    wavSeconds: 20,
    args: [],
    script: [
      { speaker: "them", text: "ויש לכם גיבוי של האתר אם משהו נופל", atMs: 600 },
      { speaker: "me", text: "בדיקה אחת שתיים שלוש מה שלומכם", atMs: 900 },
    ],
    env: {
      WINGMAN_SCRIPT_CLOSE_FINALS: JSON.stringify([
        { speaker: "them", text: "והאתר שלי נטען ממש לאט, למה זה קורה" },
        { speaker: "me", text: "שורה אחרונה של המשתמש אחרי העצירה" },
      ]),
    },
    onStatus: (m, send) => {
      if (m.ev === "consented") setTimeout(() => send("stop"), 1100);
    }, // the "me" line (900 ms) is still in its 700 ms echo delay
  });
  assert.equal(r.code, 0, r.err);
  const said = r.transcript.map((t) => t.text);
  assert.ok(
    said.some((t) => /בדיקה אחת שתיים שלוש/.test(t)),
    `the echo-delayed me final is kept: ${said}`,
  );
  assert.ok(
    said.some((t) => /נטען ממש לאט/.test(t)),
    "the late final of the other side is kept",
  );
  assert.ok(
    said.some((t) => /שורה אחרונה/.test(t)),
    "the late final of the user is kept",
  );
  assert.ok(!r.cards.some((c) => c.type === "card" && /נטען ממש לאט/.test(c.question ?? "")), "but the late question starts no answer turn");
});

test("9. two 'me' finals of one utterance keep their order when only the first waits for the echo filter", { timeout: 60_000 }, async () => {
  const r = await runCall({
    wavSeconds: 8,
    script: [
      { speaker: "them", text: "אה, רגע אחד", atMs: 100 },
      { speaker: "me", text: "החלק הראשון של המשפט שלי", atMs: 3200 },
      { speaker: "me", text: "והחלק השני של אותו משפט", atMs: 3400 },
    ],
  });
  assert.equal(r.code, 0, r.err);
  const me = r.transcript.filter((t) => t.ch === "me").map((t) => t.text);
  assert.deepEqual(me, ["החלק הראשון של המשפט שלי", "והחלק השני של אותו משפט"]);
});

test("6. quiet mode keeps fact, note and reminder cards but hides them (the client proposal still shows)", { timeout: 60_000 }, async () => {
  const script = JSON.parse(readFileSync(join(ROOT, "data", "test", "e2e-call.json"), "utf8"));
  const run = (quiet: boolean) =>
    runCall({
      script,
      wavSeconds: 6,
      env: { WINGMAN_SCRIPT_GAP_MS: "400" },
      onStatus: (m, send) => {
        if (quiet && m.ev === "consented") send("quiet on");
      },
    });
  const q = await run(true),
    loud = await run(false);
  const side = (r: Run) => r.cards.filter((c) => c.type === "card" && c.turnId === "side");
  assert.ok(side(loud).some((c) => c.badge === "fact") && side(loud).every((c) => !c.hidden), "without quiet mode side cards show");
  assert.ok(
    side(q).some((c) => c.badge === "fact"),
    "the fact card is still written",
  );
  assert.ok(
    side(q)
      .filter((c) => c.badge !== "info")
      .every((c) => c.hidden && c.hiddenReason === "quiet"),
    `side cards are flagged hidden: ${JSON.stringify(side(q).map((c) => [c.badge, c.hidden]))}`,
  );
  assert.ok(
    side(q)
      .filter((c) => c.badge === "info")
      .every((c) => !c.hidden),
    "the client proposal (info) is never hidden",
  );
});
