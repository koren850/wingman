// pnpm call [run args]: opens the answer window and starts listening, together. Ctrl+C stops both.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { ROOT, CALLS, requireKeys } from "./env.ts";
import { loadSettingsOrExit, expandHome } from "./settings.ts";
import { parseModelRef } from "./providers/llm.ts";
import { spawnOverlay } from "./overlay.ts";

const rest = process.argv.slice(2);
const { settings: S } = loadSettingsOrExit(rest);   // exits with code 2 and a clear message when settings are invalid
requireKeys([S.stt.provider, ...(S.run.noAi ? [] : [parseModelRef(S.llm.reflex.model).provider as any])].filter((k) => k !== "script" && k !== "scripted"), expandHome(S.keys.file));
try { rmSync(join(CALLS, "latest"), { force: true }); } catch { /* the overlay must not replay the previous call */ }

const bin = (n: string) => join(ROOT, "node_modules", ".bin", n);
// U1: the answer window is reopened if it crashes (overlay.restartMax). Exit code 3 = it refused a single shared screen.
let overlay: ReturnType<typeof spawnOverlay>, restarts = 0;
const status = (ev: string, data: Record<string, unknown> = {}) => { if (process.env.WINGMAN_CONTROL === "1") process.stdout.write(`\n@@wingman ${JSON.stringify({ ev, ...data })}\n`); };
function openOverlay() {
  overlay = spawnOverlay(S, true);
  overlay?.on("exit", (code, sig) => {
    if (stopping) return;
    if (code !== 3 && code !== 0 && restarts < S.overlay.restartMax) {
      restarts++; console.log(`(answer window crashed: code ${code ?? sig}; reopening, ${restarts}/${S.overlay.restartMax})`);
      status("overlay", { ok: false, restarting: true });
      setTimeout(() => { if (!stopping) openOverlay(); }, 1000);
    } else {
      console.log(`(answer window exited: code ${code ?? sig}; still listening, Ctrl+C to stop)`);
      status("overlay", { ok: false, reason: code === 3 ? "one-screen" : "closed" });
    }
  });
}
openOverlay();
const run = spawn(bin("tsx"), [join(ROOT, "src", "run.ts"), ...rest], { cwd: ROOT, stdio: "inherit" });

let stopping = false;
function stop() {
  if (stopping) { try { run.kill("SIGKILL"); } catch {} return; }   // second stop: the call is stuck, force it
  stopping = true;
  run.kill("SIGINT"); // run.ts saves the call and prints the speed summary
  setTimeout(() => { try { overlay?.kill(); } catch {} }, 5000); // leave the last cards up briefly
}
// Ctrl+C reaches the whole foreground group; the overlay is detached so it survives the 5 s grace.
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);
run.on("exit", (code) => {
  stopping = true;
  setTimeout(() => { try { overlay?.kill(); } catch {} process.exit(code ?? 0); }, 5000);
  console.log("(answer window closes in 5 s)");
});
