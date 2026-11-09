// pnpm call [run args]: opens the answer window and starts listening, together. Ctrl+C stops both.
// Parent process: spawns overlay.ts's Electron window plus src/run.ts as a child (run args pass through).
// With WINGMAN_CONTROL=1 it also prints "@@wingman {json}" overlay status lines on stdout, like run.ts does.
// Stop order: SIGINT to run.ts (it saves the call), window closes 5 s later so the last cards stay readable.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { ROOT, CALLS, requireKeys } from "./env.ts";
import { loadSettingsOrExit, expandHome } from "./settings.ts";
import { parseModelRef } from "./providers/llm.ts";
import { spawnOverlay } from "./overlay.ts";
import bin from "../shared/bin.cjs";
import { RowRelay, nextRestartCount, listenForRows } from "./relay.ts";

const rest = process.argv.slice(2);
const { settings: S } = loadSettingsOrExit(rest); // exits with code 2 and a clear message when settings are invalid
requireKeys(
  [
    S.stt.provider,
    ...(S.run.noAi
      ? []
      : [
          parseModelRef(S.llm.reflex.model)
            .provider as any /* eslint-disable-line @typescript-eslint/no-explicit-any -- "script"/"scripted" are not real key names; filtered out below */,
        ]),
  ].filter((k) => k !== "script" && k !== "scripted"),
  expandHome(S.keys.file),
);
try {
  rmSync(join(CALLS, "latest"), { force: true });
} catch {
  /* removed so the new window waits for run.ts's own folder instead of replaying the previous call */
}

// U1: the answer window is reopened if it crashes (overlay.restartMax). Exit code 3 = it refused a single shared screen.
let overlay: ReturnType<typeof spawnOverlay>,
  restarts = 0,
  overlayStartedAt = 0;
// Second path for the cards (when writing cards.jsonl fails): run.ts sends card rows to a private socket, forwarded to the window's stdin.
const relay = new RowRelay();
const rows = listenForRows(relay);
/** Same "@@wingman" status line protocol as run.ts, only in control mode (the tray app reads it). */
const status = (ev: string, data: Record<string, unknown> = {}) => {
  if (process.env.WINGMAN_CONTROL === "1") process.stdout.write(`\n@@wingman ${JSON.stringify({ ev, ...data })}\n`);
};
/** Starts the answer window; on a crash it reopens it after 1 s (up to overlay.restartMax). Code 0 = closed by the user, code 3 = refused a single shared screen: no restart. */
function openOverlay() {
  overlay = spawnOverlay(S, true);
  overlayStartedAt = Date.now();
  if (overlay?.stdin) relay.attach(overlay.stdin);
  overlay?.on("exit", (code, sig) => {
    relay.detach();
    if (life !== "running") return;
    restarts = nextRestartCount(restarts, Date.now() - overlayStartedAt); // a window that ran 10 minutes was stable: crashes far apart do not add up
    if (code !== 3 && code !== 0 && restarts < S.overlay.restartMax) {
      restarts++;
      console.log(`(answer window crashed: code ${code ?? sig}; reopening, ${restarts}/${S.overlay.restartMax})`);
      status("overlay", { ok: false, restarting: true });
      setTimeout(() => {
        if (life === "running") openOverlay();
      }, 1000);
    } else {
      console.log(`(answer window exited: code ${code ?? sig}; still listening, Ctrl+C to stop)`);
      status("overlay", { ok: false, reason: code === 3 ? "one-screen" : "closed" });
    }
  });
}
openOverlay();
const runCmd = bin.binCommand("tsx", [join(ROOT, "src", "run.ts"), ...rest], ROOT);
const run = spawn(runCmd.cmd, runCmd.args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...(rows ? { WINGMAN_OVERLAY_SOCK: rows.path } : {}) } });
// A failed spawn (no tsx, no permission) is an "error" event, not an exit: without a handler it is an uncaught error in this process.
run.on("error", (e) => {
  console.error(`\n🔴 Could not start the call engine: ${e.message}`);
  status("ended", { crashed: true, deleted: false });
  finalExit(1);
});

// What call.ts is doing: running (the engine runs), stopping (a stop was requested), runGone (the engine is gone, only the window lingers for
// 5 s; runCode keeps the engine's own exit code), exiting (finalExit() has started). Only the edges in LIFE_EDGES happen; others are ignored.
type Life = "running" | "stopping" | "runGone" | "exiting";
const LIFE_EDGES: Record<Life, Life[]> = { running: ["stopping", "runGone", "exiting"], stopping: ["runGone", "exiting"], runGone: ["exiting"], exiting: [] };
let life: Life = "running",
  runCode = 0;
const moveLife = (to: Life): boolean => (LIFE_EDGES[life].includes(to) ? ((life = to), true) : false);
/** SIGTERM the answer window, SIGKILL it 2 s later if it hangs. */
function closeOverlay() {
  const o = overlay;
  if (!o || o.exitCode !== null || o.signalCode) return;
  try {
    o.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      if (o.exitCode === null && !o.signalCode) o.kill("SIGKILL");
    } catch {}
  }, 2000).unref();
}
/** Close the window (escalating) and leave; never waits longer than 2.5 s for it. */
function finalExit(code: number) {
  if (!moveLife("exiting")) return;
  rows?.close();
  const o = overlay;
  closeOverlay();
  if (!o || o.exitCode !== null || o.signalCode) return process.exit(code);
  const t = setTimeout(() => process.exit(code), 2500);
  o.once("exit", () => {
    clearTimeout(t);
    process.exit(code);
  });
}
function stop() {
  if (life === "runGone") return finalExit(runCode); // the call is over and only the window lingers: a stop (new call starting, quit) closes it now
  if (life === "exiting") return;
  if (life === "stopping") {
    try {
      run.kill("SIGKILL");
    } catch {}
    return;
  } // second stop: the call is stuck, force it
  moveLife("stopping");
  run.kill("SIGINT"); // run.ts saves the call and prints the speed summary
  setTimeout(closeOverlay, 5000); // leave the last cards up briefly
}
// Ctrl+C reaches the whole foreground group; the overlay is detached so it survives the 5 s grace.
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);
run.on("exit", (code, signal) => {
  moveLife("runGone"); // (this also stops the crash-restart of the window)
  runCode = code ?? (signal ? 1 : 0);
  // The engine died without saying goodbye (SIGKILL, out of memory, a crash): the tray would show a live call for 5 more seconds, and its Stop
  // would go to a dead process. A clean exit already printed its own "ended" line; a second one is ignored by the tray.
  if (runCode !== 0) status("ended", { crashed: true, deleted: false });
  setTimeout(() => finalExit(runCode), 5000);
  console.log("(answer window closes in 5 s)");
});
