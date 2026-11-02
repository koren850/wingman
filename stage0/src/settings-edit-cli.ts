// Child process for the Wingman window. `read`: prints state JSON. `write`: reads {key: value|null} JSON from stdin, validates, writes.
// Output is always one JSON line on stdout. WINGMAN_USER_SETTINGS redirects the settings file (tests and screenshots only).
import { applyEdits, readState, userFileFromEnv } from "./settings-edit.ts";
import { SettingsError, formatSettingsError } from "./settings.ts";
import { KEY_VARS } from "./env.ts";

const file = userFileFromEnv(), mode = process.argv[2];
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
try {
  if (mode === "read") {
    const s = readState(file);
    // Key state is not read here any more: the app asks the main process (keys:status), so this child never parses keys.env.
    out({ ok: true, ...s, keys: {}, keyVars: { deepgram: KEY_VARS.deepgram, anthropic: KEY_VARS.anthropic } });
  } else if (mode === "write") {
    let raw = ""; for await (const c of process.stdin) raw += c;
    const edits = JSON.parse(raw);
    if (!edits || typeof edits !== "object" || Array.isArray(edits)) throw new Error("bad edits");
    out(applyEdits(file, edits));
  } else out({ ok: false, message: "mode must be read or write" });
} catch (e) {
  out({ ok: false, message: e instanceof SettingsError ? formatSettingsError(e) : (e as Error).message });
}
