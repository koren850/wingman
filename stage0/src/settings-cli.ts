// pnpm settings [--profile x] [--set k=v ...]: prints the effective settings, each value tagged with the layer it came from.
// Never prints secrets: API keys are not settings, and only present/missing is shown for them.
import { flatten, loadSettingsOrExit, redact } from "./settings.ts";
import { realKeychain } from "./keychain.ts";
import { loadKeys, KEY_VARS, KEYS_FILE } from "./env.ts";
import { expandHome } from "./settings.ts";

const { settings, sources, profile, userFile } = loadSettingsOrExit();
const flat = flatten(settings);
const tag = (k: string) => { const s = sources[k]; return s ? (s.layer === "default" ? "default" : `${s.layer}${s.detail ? ` (${s.detail})` : ""}`) : "default"; };
const width = Math.max(...Object.keys(flat).map((k) => k.length));
console.log(`Effective Wingman settings (layers: defaults < ${userFile} < profile${profile ? ` "${profile}"` : ""} < env < CLI)\n`);
for (const k of Object.keys(flat)) {
  const v = redact(k, flat[k]);
  console.log(`${k.padEnd(width)}  ${v.length > 90 ? v.slice(0, 87) + "..." : v}   [${tag(k)}]`);
}
const keys = loadKeys(expandHome(settings.keys.file) || KEYS_FILE, process.env, realKeychain());
console.log(`\nKeys in the Keychain, ${settings.keys.file} or the environment (values never shown):`);
for (const [name, envVar] of Object.entries(KEY_VARS)) console.log(`  ${envVar.padEnd(30)} ${keys[name as keyof typeof keys] ? "present" : "missing"}`);
console.log(`\n${Object.keys(flat).length} settings. Edit ${userFile} (commented starter created if absent) or use --profile / --set key=value.`);
