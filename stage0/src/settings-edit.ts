// Edits the user settings file (~/.config/wingman/settings.yaml) for the Settings page and `wingman settings set`.
// Validates the result with the same zod schema as every call (loadSettings), keeps comments and other keys
// (yaml Document API), writes mode 600 through a temp file + rename. The app reaches it through src/settings-edit-cli.ts.
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { flatten, loadSettings, SettingsError, STARTER, USER_SETTINGS_FILE, type Flat } from "./settings.ts";

export type Edits = Record<string, unknown>;   // key -> new value, or null = back to the default
export type EditResult = { ok: true; changed: string[] } | { ok: false; message: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Built-in defaults, flattened (no user file, no env). */
export function defaultsFlat(): Flat {
  return flatten(loadSettings({ userFile: join("/nonexistent-wingman", "settings.yaml"), env: {}, argv: [] }).settings);
}

/** After a delete, removes parent maps that became empty, so the file does not keep bare `section: {}` stubs. Never removes the top level. */
function pruneEmpty(doc: YAML.Document, path: string[]) {
  for (let n = path.length - 1; n >= 1; n--) {
    const parent = path.slice(0, n);
    const node = doc.getIn(parent, true);
    if (YAML.isMap(node) && node.items.length === 0) doc.deleteIn(parent); else break;
  }
}

/**
 * Applies {key: value|null} to the user file. Unknown keys fail. A null, or a value equal to the default, deletes the key.
 * The result is validated from a temp copy first; the real file is replaced (atomic rename) only if that passes.
 * Returns the changed keys, or a user-facing message. Never throws for bad input.
 */
export function applyEdits(userFile: string, edits: Edits): EditResult {
  const keys = Object.keys(edits);
  if (!keys.length) return { ok: true, changed: [] };
  let text: string;
  try { text = existsSync(userFile) ? readFileSync(userFile, "utf8") : STARTER; } catch (e) { return { ok: false, message: `Cannot read ${userFile}: ${(e as Error).message}` }; }
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) return { ok: false, message: `${userFile} is not valid YAML: ${doc.errors[0].message.split("\n")[0]}. Fix or delete that file first.` };
  if (doc.contents != null && !YAML.isMap(doc.contents)) return { ok: false, message: `${userFile}: the top level must be a mapping of keys.` };
  let defaults: Flat;
  try { defaults = defaultsFlat(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const changed: string[] = [];
  for (const key of keys) {
    if (!(key in defaults) || !/^[A-Za-z0-9_.]+$/.test(key)) return { ok: false, message: `Unknown setting "${key}".` };
    const path = key.split("."), v = edits[key];
    if (v === null || same(v, defaults[key])) { if (doc.contents != null && doc.deleteIn(path)) pruneEmpty(doc, path); }
    else {
      // A bare section header ("stt:" with nothing under it) is a null scalar: replace it with a map before writing below it.
      for (let n = 1; n < path.length; n++) { const node = doc.getIn(path.slice(0, n), true); if (node !== undefined && !YAML.isMap(node)) doc.setIn(path.slice(0, n), new YAML.YAMLMap()); }
      doc.setIn(path, v);
    }
    changed.push(key);
  }
  const out = doc.toString();
  const dir = dirname(userFile), tmp = join(dir, `.settings.yaml.${process.pid}.tmp`), cand = join(dir, `.settings.check.${process.pid}.tmp`);
  try {
    // Validate a copy first so a bad edit never touches the real file.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(cand, out, { mode: 0o600 });
    try { loadSettings({ userFile: cand, env: {}, argv: [] }); }
    catch (e) {
      if (e instanceof SettingsError) { const i = e.issues[0]; return { ok: false, message: `${i.key}: ${i.message}${i.allowed ? ` (allowed: ${i.allowed})` : ""}` }; }
      return { ok: false, message: (e as Error).message };
    } finally { rmSync(cand, { force: true }); }
    writeFileSync(tmp, out, { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* no POSIX modes (Windows) */ }
    renameSync(tmp, userFile);
    try { chmodSync(userFile, 0o600); } catch { /* no POSIX modes (Windows) */ }
  } catch (e) { rmSync(tmp, { force: true }); return { ok: false, message: `Could not save: ${(e as Error).message}` }; }
  return { ok: true, changed };
}

/** Effective values (defaults + user file), which keys the user file changes, and the defaults. Secrets are never part of settings. */
export function readState(userFile: string) {
  const defaults = defaultsFlat();
  const { settings, sources } = loadSettings({ userFile, env: {}, argv: [] });
  const values = flatten(settings), changed: string[] = [];
  for (const k of Object.keys(values)) if (sources[k]?.layer === "user" && !same(values[k], defaults[k])) changed.push(k);
  const scalar = (o: Flat) => Object.fromEntries(Object.entries(o).filter(([k, v]) => !k.startsWith("budget.prices") && (v === null || ["string", "number", "boolean"].includes(typeof v))));
  return { values: scalar(values), defaults: scalar(defaults), changed, userFile, keysFile: settings.keys.file };
}

export const userFileFromEnv = () => process.env.WINGMAN_USER_SETTINGS || USER_SETTINGS_FILE;
