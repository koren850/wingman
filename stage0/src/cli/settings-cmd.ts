// wingman settings list | get | set. Same catalog, conversion and validation as the app's Settings page
// (tray/settings-catalog.cjs + src/settings-edit.ts). Applies to the NEXT call. No secrets are involved: keys are not settings.
// Edits the user settings file directly; it does not use the tray's control socket.
import { CliError, EXIT, catalog, parse, usage, clip, type Ctx, type Result } from "./common.ts";
import { applyEdits, readState } from "../settings-edit.ts";
import { USER_SETTINGS_FILE } from "../settings.ts";

const file = (ctx: Ctx) => ctx.userSettings || USER_SETTINGS_FILE;
const show = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const FORBIDDEN = /^keys\./;   // where keys live is not something the CLI changes

/** One row of the app's settings catalog (src/settings-catalog; a CommonJS module, so untyped). */
interface CatalogItem { key: string; label: string; group: string; kind: string; value: unknown; def: unknown; changed: boolean; unit?: string; options?: string[][]; min?: number; max?: number; help?: string }

function items(ctx: Ctx) {
  const st = readState(file(ctx));
  return { st, items: catalog.describe(st) as CatalogItem[] };
}
const brief = (i: CatalogItem) => ({ key: i.key, label: i.label, group: i.group, kind: i.kind, value: i.value, default: i.def, changed: i.changed, unit: i.unit || "", options: i.options ? i.options.map((o: string[]) => o[0]) : undefined, min: i.min, max: i.max, help: i.help });

/** Text typed on the command line -> the value the Settings page would hold for this item. */
function typed(item: CatalogItem, raw: string): unknown {
  if (item.kind === "bool") {
    if (/^(on|true|yes|1)$/i.test(raw)) return true;
    if (/^(off|false|no|0)$/i.test(raw)) return false;
    throw new Error("expected on or off");
  }
  if (item.kind === "select") return raw;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) throw new Error("expected a number");
  return n;
}

/** list [--all] | get <key> | set <key> <value|default> [--advanced]. Keys not in the app's catalog need --advanced. keys.* is refused. */
export async function settings(ctx: Ctx, args: string[]): Promise<Result> {
  const sub = args[0] || "list", rest = args.slice(1);
  if (sub === "list") {
    const { values } = parse(rest, { all: { type: "boolean" } });
    const { st, items: its } = items(ctx);
    const L: string[] = [];
    let g = "";
    for (const i of its) {
      if (i.group !== g) { g = i.group; L.push("", `[${(catalog.GROUPS.find((x: { id: string }) => x.id === g) || { title: g }).title}]`); }
      L.push(`  ${i.key.padEnd(30)} ${show(i.value).padEnd(10)} ${i.unit || ""}${i.changed ? "  (changed)" : ""}  ${clip(i.label, 50)}`);
    }
    const data: Record<string, unknown> = { userFile: st.userFile, settings: its.map(brief) };
    if (values.all) {
      const known = new Set(its.map((i) => i.key));
      const extra = Object.keys(st.values).filter((k) => !known.has(k) && !FORBIDDEN.test(k)).sort();
      data.advanced = extra.map((k) => ({ key: k, value: st.values[k], default: st.defaults[k], changed: st.changed.includes(k) }));
      L.push("", "[Advanced (set with --advanced)]", ...extra.map((k) => `  ${k.padEnd(40)} ${show(st.values[k])}${st.changed.includes(k) ? "  (changed)" : ""}`));
    }
    L.push("", `File: ${st.userFile}. Changes apply to the next call.`);
    return { data, text: L.join("\n").trimStart() };
  }
  if (sub === "get") {
    const { positionals } = parse(rest, {});
    if (positionals.length !== 1) throw usage("Usage: wingman settings get <key>");
    const { st, items: its } = items(ctx);
    const i = its.find((x) => x.key === positionals[0]);
    if (i) return { data: { setting: brief(i) }, text: `${i.key} = ${show(i.value)}${i.unit ? " " + i.unit : ""}${i.changed ? "  (changed, default " + show(i.def) + ")" : "  (default)"}\n${i.label}: ${i.help}` };
    if (positionals[0] in st.values && !FORBIDDEN.test(positionals[0])) return { data: { setting: { key: positionals[0], value: st.values[positionals[0]], default: st.defaults[positionals[0]], changed: st.changed.includes(positionals[0]), advanced: true } }, text: `${positionals[0]} = ${show(st.values[positionals[0]])}${st.changed.includes(positionals[0]) ? "  (changed)" : "  (default)"}` };
    throw new CliError("not_found", `No such setting: ${clip(positionals[0], 60)}`, EXIT.NOT_FOUND, "List them: wingman settings list --all");
  }
  if (sub === "set") {
    const { values, positionals } = parse(rest, { advanced: { type: "boolean" } });
    if (positionals.length !== 2) throw usage("Usage: wingman settings set <key> <value|default> [--advanced]");
    const [key, raw] = positionals;
    if (FORBIDDEN.test(key)) throw new CliError("refused", "Key storage settings are not changed from the CLI.", EXIT.REFUSED, "Use the app: Settings > Keys.");
    const { st, items: its } = items(ctx);
    const item = catalog.BY_KEY.get(key);
    let stored: unknown;
    if (item) {
      try { stored = raw === "default" ? null : catalog.toStored(item, typed(item, raw)); } catch (e) { throw usage(`${item.label}: ${(e as Error).message}`); }
    } else {
      if (!values.advanced) throw new CliError("not_found", `"${clip(key, 60)}" is not one of the app's settings.`, EXIT.NOT_FOUND, "Advanced keys need --advanced (see wingman settings list --all).");
      if (!(key in st.values)) throw new CliError("not_found", `No such setting: ${clip(key, 60)}`, EXIT.NOT_FOUND);
      if (raw === "default") stored = null; else { try { stored = JSON.parse(raw); } catch { stored = raw; } }
    }
    const r = applyEdits(file(ctx), { [key]: stored });
    if (!r.ok) throw new CliError("invalid", r.message, EXIT.USAGE);
    const now = items(ctx).items.find((x) => x.key === key);
    const value = now ? now.value : readState(file(ctx)).values[key];
    return { data: { key, value, appliesTo: "next call" }, text: `${key} = ${show(value)}. Applies to the next call.` };
  }
  throw usage("Usage: wingman settings [list [--all] | get <key> | set <key> <value|default> [--advanced]]");
}
