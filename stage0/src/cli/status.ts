// status, doctor, keys status.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { call, appStatus, appProcessRunning, NO_APP_HINT } from "./client.ts";
import { readPlan } from "./plan.ts";
import { CliError, EXIT, trayLib, parse, usage, ago, type Ctx, type Result } from "./common.ts";
import { keyStatus, realKeychain, ACCOUNTS, PROVIDERS, type Keychain } from "../keychain.ts";
import { loadSettings, expandHome } from "../settings.ts";
import { KEYS_FILE } from "../env.ts";

type Doc = { ran: boolean; ok: boolean; verdict: string; failing: { text: string; fix: string }[]; warnings: { text: string; fix: string }[]; at: number };

function readiness(running: boolean, health: any[], doctor: Doc | null, phase: string) {
  const reasons: string[] = [];
  let level = "ready" as "ready" | "attention" | "not_ready";
  const bump = (l: typeof level, r: string) => { reasons.push(r); if (l === "not_ready") level = "not_ready"; else if (level === "ready") level = "attention"; };
  if (!running) { level = "not_ready"; reasons.push("The Wingman app is not running."); return { level, ready: false, reasons }; }
  for (const h of health) bump(h.level === "red" ? "not_ready" : "attention", `${h.level}: ${h.text}`);
  if (!doctor || !doctor.ran) bump("attention", "The readiness check has not run since the app started: wingman doctor");
  else if (!doctor.ok) bump("not_ready", `Last readiness check: ${doctor.verdict}${doctor.failing[0] ? " (" + doctor.failing[0].text + ")" : ""}`);
  else if (doctor.warnings.length) bump("attention", `Readiness check has ${doctor.warnings.length} warning(s): wingman doctor`);
  if (phase === "stopping") bump("attention", "A call is being saved.");
  return { level, ready: level !== "not_ready", reasons };
}

export async function status(ctx: Ctx, args: string[]): Promise<Result> {
  parse(args, {});
  const a = await appStatus(ctx);
  const plan = readPlan(ctx);
  const st = a?.state;
  const health = a?.health ?? [];
  const doctor: Doc | null = a?.doctor ?? null;
  const proc = a ? true : await appProcessRunning(ctx);
  const phase: string = st?.phase ?? "idle";
  const r = readiness(!!a, health, doctor, phase);
  const now = Date.now();
  const call_ = {
    active: !!st?.running, live: phase === "live", phase, practice: !!st?.practice, callId: st?.callId || "", client: st?.client || "", proposedClient: st?.proposed || "",
    quiet: !!st?.quiet, notes: st?.notes ?? 0, elapsedSec: st?.liveAt ? Math.round((now - st.liveAt) / 1000) : 0,
  };
  const hint = a ? "" : proc ? "The app is running but has no control socket (started before the CLI existed). Dan: Quit Wingman from the menu bar and open it again." : NO_APP_HINT;
  const data = {
    app: { running: !!a, controlSocket: !!a, processRunning: proc ?? null, pid: a?.pid ?? null, version: a?.version ?? "", hint },
    call: call_, health, overlayDown: a?.overlayDown || "", offReason: a?.offReason || "", lastError: a?.lastError || "",
    doctor, readiness: r, plan: { ready: plan.ready, who: plan.who, goal: plan.goal, kind: plan.kind, topic: plan.topic, expiresInMin: plan.expiresInMin, attachments: plan.attachments.length },
  };
  const L: string[] = [];
  L.push(a ? `App: running (pid ${a.pid})` : `App: NOT running${proc ? " (process found, but no control socket)" : ""}`);
  if (a) {
    L.push(`Call: ${phase === "idle" ? "none" : `${phase}${st.practice ? " (practice)" : ""}${call_.callId ? ` · ${call_.callId}` : ""}${call_.client ? ` · client ${call_.client}` : ""}${phase === "live" ? ` · ${trayLib.mmss(now - st.liveAt)}` : ""}${call_.quiet ? " · quiet" : ""}`}`);
    if (call_.proposedClient && !call_.client) L.push(`  Client proposed: ${call_.proposedClient} (wingman client to confirm)`);
    for (const h of health) L.push(`  ${h.level === "red" ? "RED" : "amber"}: ${h.text}`);
    if (data.overlayDown) L.push(`  Answer window: ${data.overlayDown === "one-screen" ? "closed (only one screen)" : "closed"}`);
    if (data.offReason) L.push(`  Wingman turned itself off: ${data.offReason}`);
    L.push(`Doctor: ${doctor && doctor.ran ? `${doctor.verdict} (${ago(now - doctor.at)} ago)` : "not run since the app started (wingman doctor)"}`);
  } else L.push(hint);
  L.push(`Plan: ${plan.ready ? `ready · ${[plan.who, plan.goal].filter(Boolean).join(" · ") || "(notes only)"} · expires in ${ago(plan.expiresInMin * 60000)}${plan.attachments.length ? ` · ${plan.attachments.length} file(s)` : ""}` : "none"}`);
  L.push(`Readiness: ${r.level.toUpperCase().replace("_", " ")}${r.reasons.length ? "\n  - " + r.reasons.join("\n  - ") : ""}`);
  return { data, text: L.join("\n"), exit: a ? EXIT.OK : EXIT.NO_APP };
}

/** Same child the app uses for its own doctor, when the app is not there to do it. */
function runDoctorDirect(ctx: Ctx, offline: boolean): Promise<string> {
  const run = ctx.spawnTsx ?? ((a: string[], ms: number) => new Promise<{ code: number; out: string }>((res) => {
    execFile(join(ctx.root, "node_modules", ".bin", "tsx"), a, { cwd: ctx.root, timeout: ms, maxBuffer: 4_000_000, env: { ...ctx.env, FORCE_COLOR: "0" } }, (e, so, se) => res({ code: e ? 1 : 0, out: String(so) + String(se) }));
  }));
  return run([join(ctx.root, "src", "doctor.ts"), ...(offline ? ["--offline"] : [])], 240_000).then((r) => r.out);
}

export async function doctor(ctx: Ctx, args: string[]): Promise<Result> {
  const { values } = parse(args, { offline: { type: "boolean" } });
  let d: Doc, via: string;
  const a = await appStatus(ctx);
  if (a) {
    const r = await call(ctx, "doctor", { offline: !!values.offline }, 300_000);
    d = r.doctor; via = "app";
  } else { d = trayLib.doctorSummary(await runDoctorDirect(ctx, !!values.offline)); via = "cli"; }
  const L = [`Doctor${values.offline ? " (offline)" : ""}: ${d.verdict}${via === "cli" ? " (app not running; ran directly)" : ""}`];
  for (const f of d.failing) L.push(`  FAIL ${f.text}${f.fix ? `\n       fix: ${f.fix}` : ""}`);
  for (const w of d.warnings) L.push(`  warn ${w.text}${w.fix ? `\n       fix: ${w.fix}` : ""}`);
  const busy = d.verdict === "BUSY";
  return { data: { via, offline: !!values.offline, ...d }, text: L.join("\n"), exit: busy ? EXIT.REFUSED : d.verdict === "NO RESULT" ? EXIT.FAIL : d.ok ? EXIT.OK : EXIT.NOT_READY };
}

/** keys status ONLY: present or missing per key, never a value, never the last characters. */
export async function keys(ctx: Ctx, args: string[]): Promise<Result> {
  const { positionals } = parse(args, {});
  if ((positionals[0] || "status") !== "status" || positionals.length > 1) {
    throw new CliError("keys_not_here", "The CLI only shows whether keys are present. It never prints, sets or moves a key.", EXIT.REFUSED, "Set or move keys with `pnpm keys set deepgram|anthropic` / `pnpm keys migrate` in a terminal, or in the Wingman app: Settings > Keys.");
  }
  const keychain = (ctx.keychain as Keychain | undefined) ?? realKeychain();
  const file = (ctx.env.WINGMAN_KEYS_FILE) || expandHome(loadSettings({ argv: [], env: {}, ...(ctx.userSettings ? { userFile: ctx.userSettings } : {}) }).settings.keys.file) || KEYS_FILE;
  const st = keyStatus({ keychain, file, env: ctx.env });
  const rows = PROVIDERS.map((p) => ({ key: p, name: ACCOUNTS[p], present: st[p].source !== "missing", source: st[p].source }));
  const missing = rows.filter((r) => !r.present);
  return {
    data: { keys: rows, allPresent: missing.length === 0 },
    text: rows.map((r) => `${r.name.padEnd(20)} ${r.present ? "present" : "MISSING"}${r.present && r.source !== "keychain" ? ` (in ${r.source}; move it: pnpm keys migrate)` : ""}`).join("\n") + (missing.length ? "\nAdd missing keys with `pnpm keys set <deepgram|anthropic>` or in the app: Settings > Keys." : ""),
    exit: missing.length ? EXIT.NOT_READY : EXIT.OK,
  };
}
