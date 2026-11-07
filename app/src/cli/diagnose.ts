// wingman diagnose [callId|latest] [--out <file>]: writes one scrubbed JSON file for a bug report (see ../diagnose.ts for what is left out).
// Reads the call folder and settings directly. It never talks to the app and never reads keys.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readAudioDevices, type AudioDevice } from "../devices.ts";
import { loadSettings, SettingsError, formatSettingsError } from "../settings.ts";
import { buildReport } from "../diagnose.ts";
import { resolveId } from "./calls.ts";
import { CliError, EXIT, parse, dataLib, type Ctx, type Result } from "./common.ts";

const readJson = (f: string): { version?: string } | undefined => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
};
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");

export async function diagnose(ctx: Ctx, args: string[]): Promise<Result> {
  const { values, positionals } = parse(args, { out: { type: "string" } });
  if (positionals.length > 1) throw new CliError("usage", "Give at most one call id.", EXIT.USAGE, "Run: wingman help");
  // No saved call is fine: the report then holds the app, system and settings parts only.
  let id: string | undefined;
  const wanted = positionals[0] ?? "latest";
  if (wanted !== "latest" || dataLib.listCalls(ctx.calls).length) id = resolveId(ctx, wanted);

  let settings;
  try {
    settings = loadSettings({ env: ctx.env, userFile: ctx.userSettings });
  } catch (e) {
    settings = { error: e instanceof SettingsError ? formatSettingsError(e) : String((e as Error).message) };
  }
  const devices: AudioDevice[] = await (ctx.devices ?? (() => readAudioDevices()))().catch(() => []);
  const electronPkg = readJson(join(ctx.root, "node_modules", "electron", "package.json"));
  const report = buildReport({
    appVersion: readJson(join(ctx.root, "package.json"))?.version ?? "unknown",
    electronVersion: electronPkg?.version,
    devices,
    settings,
    callDir: id ? dataLib.callDir(ctx.calls, id) : undefined,
  });

  const file = resolve(values.out ?? join(dirname(ctx.calls), "diagnose", `wingman-diagnose-${id ?? "no-call"}-${stamp()}.json`));
  if (existsSync(file) && values.out) throw new CliError("exists", `${file} already exists.`, EXIT.REFUSED, "Pick another --out file.");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });

  const text = [
    `Wrote ${file}`,
    id ? `Call: ${id}` : "No saved call found: the file has app, system and settings information only.",
    "Check it before you share it: open the file and read it. It holds no transcript or card text, but you decide what leaves your Mac.",
  ].join("\n");
  return { data: { file, callId: id ?? null }, text };
}
