// wingman plan: the prepared meetings (several can wait at once; same store as the app's "Prepare a meeting" and the menu bar, tray/plans.cjs).
// Reads and writes the files directly (no engine, no network), then nudges the app with a best-effort brief_refresh over the control
// socket (tray/control-socket.cjs); a running app also notices the change itself within a second.
// A call uses a meeting only when it is started with it: `wingman start --plan <id>`. `wingman start --quick` uses none.
import { basename } from "node:path";
import { request } from "./client.ts";
import { CliError, EXIT, plansLib, Plans, attachments, parse, usage, ago, type Ctx, type Result } from "./common.ts";
import { KINDS } from "../frame.ts";

const LIMIT_NOTES = 12;

/** A prepared meeting as the CLI shows it. `ready` is true for a meeting that can start a call. */
export interface Meeting {
  ready: boolean; id: string; title: string; name: string; who: string; goal: string; kind: string; topic: string; notes: string[]; mustCover: string[];
  at: string; atText: string; status: string; used: boolean; callId: string; expiresInMin: number; attachments: { id: string; name: string; chars: number }[];
}
/** The empty answer when no meeting exists (keeps `plan.ready === false` for older callers). */
const NONE = { ready: false };

export const store = (ctx: Ctx) => plansLib.createPlanStore({ dir: ctx.briefs });

/** One stored meeting -> the shape the CLI prints. */
export function toMeeting(m: any, now = Date.now()): Meeting {
  return {
    ready: m.status === "ready", id: m.id, title: m.title, name: Plans.label(m), who: m.who, goal: m.goal, kind: m.kind, topic: m.topic, notes: m.notes, mustCover: m.mustCover,
    at: m.at ? new Date(m.at).toISOString() : "", atText: m.at ? Plans.formatAt(m.at, now) : "", status: m.status, used: m.status === "used", callId: m.callId || "",
    expiresInMin: Math.max(0, Math.round((m.expiresAt - now) / 60000)), attachments: m.fileList.map((f: any) => ({ id: f.id, name: f.name, chars: f.chars })),
  };
}
/** All ready meetings, soonest first. */
export function readPlans(ctx: Ctx): Meeting[] { const now = Date.now(); return store(ctx).list().map((m: any) => toMeeting(m, now)); }

const item = (s: string) => s.replace(/;/g, ",").replace(/\s+/g, " ").trim();   // ';' splits items when text is typed in the app
function describe(p: Meeting): string {
  const L = [`${p.name}  [${p.id}]${p.used ? "  (used by a call)" : ""}`];
  L.push(`  Time:   ${p.atText || "no time"}  ·  ${p.used ? "kept" : "stays"} ${p.used ? "for a few days" : "until " + (p.at ? "about 6 h after" : "14 days after the last edit") + ` (expires in ${ago(p.expiresInMin * 60000)})`}`);
  if (p.who) L.push(`  Who:    ${p.who}`);
  if (p.kind) L.push(`  Kind:   ${p.kind}`);
  if (p.topic) L.push(`  Topic:  ${p.topic}`);
  if (p.goal) L.push(`  Goal:   ${p.goal}`);
  if (p.notes.length) L.push("  Notes:", ...p.notes.map((n) => `    - ${n}`));
  if (p.mustCover.length) L.push("  Must cover:", ...p.mustCover.map((n) => `    [ ] ${n}`));
  if (p.attachments.length) L.push("  Background files:", ...p.attachments.map((a) => `    ${a.id}  ${a.name} (${a.chars} chars)`));
  return L.join("\n");
}
function line(p: Meeting): string {
  return `${p.id}  ${(p.atText || "no time").padEnd(16)} ${p.name}${p.mustCover.length ? `  · ${p.mustCover.length} to cover` : ""}${p.attachments.length ? `  · ${p.attachments.length} file(s)` : ""}`;
}
const listText = (l: Meeting[]) => (l.length ? `Prepared meetings (soonest first):\n${l.map((p) => "  " + line(p)).join("\n")}\nStart one: wingman start --plan <id>    Start with none: wingman start --quick` : "No prepared meetings. Make one: wingman plan new --who ... --goal ...");

async function refreshApp(ctx: Ctx) { try { await request(ctx, "brief_refresh", undefined, 3000); } catch { /* app not running: it reads the files when it starts */ } }

/** Maps a store refusal to a CLI error: unknown id -> not found, anything else -> bad usage. */
function storeError(error: string): CliError {
  return /no such|already used|matches more/i.test(error) ? new CliError("not_found", error, EXIT.NOT_FOUND, "List them: wingman plan list") : usage(error);
}
/** The meeting a command works on: --id (id or unique prefix), else the only ready one; several -> a clear usage error. */
function target(ctx: Ctx, id: string | undefined, what: string) {
  const s = store(ctx);
  if (id) { const r = s.resolve(id); if (!r.meeting) throw storeError(r.error === "ambiguous" ? "That id matches more than one prepared meeting." : "No such prepared meeting."); return r.meeting; }
  const l = s.list();
  if (l.length === 1) return l[0];
  if (!l.length) throw new CliError("not_found", "There are no prepared meetings.", EXIT.NOT_FOUND, "Make one: wingman plan new --who ...");
  throw usage(`There are ${l.length} prepared meetings, so say which one to ${what}: --id <id>.\n${listText(l.map((m: any) => toMeeting(m)))}`);
}

// plan set|new|edit: --new makes a meeting; --id edits that one; with neither: no meeting yet = make one, exactly one = edit it, several = error.
// Fields you leave out are kept when editing (--fresh starts the meeting's fields over).
async function setPlan(ctx: Ctx, args: string[], forceNew: boolean): Promise<Result> {
  const { values } = parse(args, {
    id: { type: "string" }, new: { type: "boolean" }, title: { type: "string" }, at: { type: "string" },
    who: { type: "string" }, goal: { type: "string" }, kind: { type: "string" }, topic: { type: "string" },
    note: { type: "string", multiple: true }, "add-note": { type: "string", multiple: true }, must: { type: "string", multiple: true }, "add-must": { type: "string", multiple: true },
    fresh: { type: "boolean" },
  });
  const PLAN_KINDS = [...KINDS, "interview"];   // interview: a plan-only kind (src/brief.ts isInterview); the call frame never guesses it
  if (values.kind && !PLAN_KINDS.includes(values.kind)) throw usage(`--kind must be one of: ${PLAN_KINDS.join(", ")}`);
  const wantNew = forceNew || !!values.new;
  if (wantNew && values.id) throw usage("--new makes a new meeting; --id edits an existing one. Not both.");
  const s = store(ctx);
  const ready = s.list();
  const cur = wantNew ? null : values.id || ready.length === 1 ? target(ctx, values.id, "edit") : ready.length === 0 ? null : target(ctx, undefined, "edit");
  const base = cur && !values.fresh ? cur : { title: "", who: "", goal: "", kind: "", topic: "", notes: [] as string[], mustCover: [] as string[], at: 0 };
  const notes = [...(values.note ? values.note.map(item) : base.notes), ...(values["add-note"] ?? []).map(item)].filter(Boolean);
  const must = [...(values.must ? values.must.map(item) : base.mustCover), ...(values["add-must"] ?? []).map(item)].filter(Boolean);
  if (notes.length > LIMIT_NOTES) throw usage(`At most ${LIMIT_NOTES} notes.`);
  if (must.length > LIMIT_NOTES) throw usage(`At most ${LIMIT_NOTES} must-cover items.`);
  const f: Record<string, unknown> = {
    title: values.title ?? base.title, who: values.who ?? base.who, goal: values.goal ?? base.goal, kind: values.kind ?? base.kind, topic: values.topic ?? base.topic, notes, mustCover: must,
  };
  if (values.at !== undefined) f.at = values.at; else if (cur && values.fresh) f.at = 0; else if (cur) f.at = cur.at;
  const r = cur ? s.update(cur.id, f) : s.create(f);
  if (!r.ok) throw storeError(r.error === "Fill in at least one field." ? "Give at least one of --who, --goal, --kind, --topic, --title, --note, --must." : r.error);
  await refreshApp(ctx);
  const p = toMeeting(r.meeting);
  return { data: { saved: true, created: !cur, plan: p }, text: `${cur ? "Prepared meeting updated" : "Prepared meeting saved"}.\n${describe(p)}\nStart it: wingman start --plan ${p.id}` };
}

// plan attach: exactly one of --file / --text / --stdin, into --id (or the only meeting). Size and total limits are enforced by the attachments store.
async function attach(ctx: Ctx, args: string[]): Promise<Result> {
  const { values } = parse(args, { id: { type: "string" }, file: { type: "string" }, text: { type: "string" }, stdin: { type: "boolean" }, force: { type: "boolean" } });
  const n = [values.file, values.text, values.stdin].filter((x) => x !== undefined && x !== false).length;
  if (n !== 1) throw usage("Give exactly one of: --file <path>, --text \"<text>\", --stdin   (and --id <meeting id> when there are several meetings)");
  const m = target(ctx, values.id, "attach to");
  const fs = store(ctx).files(m.id);
  let r: any;
  if (values.file !== undefined) {
    let bytes: Buffer;
    try { bytes = attachments.readSourceFile(values.file, { force: !!values.force, home: ctx.env.HOME || undefined }); }
    catch (e: any) { throw e.code === "missing" ? new CliError("not_found", e.message, EXIT.NOT_FOUND) : new CliError("refused", e.message, EXIT.REFUSED); }
    r = await fs.addFile(basename(values.file), bytes);
  } else {
    const text = values.text !== undefined ? values.text : await ctx.stdin();
    r = fs.addPaste(text);
  }
  if (!r.ok) throw new CliError("attach_failed", r.error, EXIT.FAIL);
  await refreshApp(ctx);
  const p = toMeeting(store(ctx).get(m.id));
  return { data: { attached: true, id: r.id, planId: m.id, chars: r.chars, truncated: !!r.truncated, attachments: p.attachments }, text: `Background added to "${p.name}" (${r.chars} characters${r.truncated ? ", cut to fit the limit" : ""}), file id ${r.id}.` };
}

/** Dispatches plan subcommands. A first argument starting with "-" (or `prepare --who X`) means `set`. */
export async function plan(ctx: Ctx, args: string[]): Promise<Result> {
  const sub = !args[0] ? "show" : args[0].startsWith("-") ? "set" : args[0], rest = sub === args[0] ? args.slice(1) : args;   // `prepare --who X` = set
  switch (sub) {
    case "list": { parse(rest, {}); const l = readPlans(ctx); return { data: { plans: l, count: l.length }, text: listText(l) }; }
    case "show": {
      const { positionals } = parse(rest, {});
      const s = store(ctx), l = s.list();
      if (positionals.length > 1) throw usage("Usage: wingman plan show [id]");
      if (positionals[0]) { const m = target(ctx, positionals[0], "show"); const p = toMeeting(m); return { data: { plan: p, plans: l.map((x: any) => toMeeting(x)) }, text: describe(p) }; }
      const all = l.map((x: any) => toMeeting(x));
      if (all.length === 1) return { data: { plan: all[0], plans: all }, text: describe(all[0]) };
      return { data: { plan: NONE, plans: all, count: all.length }, text: all.length ? listText(all) : "No prepared meetings." };
    }
    case "new": return setPlan(ctx, rest, true);
    case "set": case "edit": case "create": return setPlan(ctx, rest, false);
    case "attach": return attach(ctx, rest);
    case "detach": {
      const { values, positionals } = parse(rest, { id: { type: "string" } });
      if (positionals.length !== 1) throw usage("Usage: wingman plan detach <file id> [--id <meeting id>]   (ids: wingman plan show)");
      if (!/^a[0-9a-z]{6,12}$/.test(positionals[0])) throw usage("That is not a background file id.");
      const s = store(ctx);
      const owner = (values.id ? [target(ctx, values.id, "detach from")] : s.list()).find((m: any) => m.fileList.some((f: any) => f.id === positionals[0]));
      if (!owner) throw new CliError("not_found", "No such background file.", EXIT.NOT_FOUND);
      s.files(owner.id).remove(positionals[0]);
      await refreshApp(ctx);
      return { data: { detached: positionals[0], planId: owner.id }, text: "Background file removed." };
    }
    case "delete": case "remove": {
      const { values, positionals } = parse(rest, { yes: { type: "boolean" }, id: { type: "string" } });
      const id = positionals[0] ?? values.id;
      if (!id || positionals.length > 1) throw usage("Usage: wingman plan delete <id> --yes   (ids: wingman plan list)");
      const m = target(ctx, id, "delete");
      if (!values.yes) throw new CliError("needs_yes", `\`plan delete\` removes "${Plans.label(m)}" and its background files for good. Add --yes to confirm.`, EXIT.NEEDS_YES);
      store(ctx).remove(m.id);
      await refreshApp(ctx);
      return { data: { deleted: m.id }, text: `Deleted "${Plans.label(m)}" (${m.id}).` };
    }
    case "clear": {   // older command: clears THE plan. With several meetings it refuses: delete one by id.
      parse(rest, {});
      const l = store(ctx).list();
      if (l.length > 1) throw usage(`There are ${l.length} prepared meetings; \`plan clear\` would not know which. Use: wingman plan delete <id> --yes\n${listText(l.map((m: any) => toMeeting(m)))}`);
      if (l.length === 1) store(ctx).remove(l[0].id);
      await refreshApp(ctx);
      return { data: { cleared: true, deleted: l.map((m: any) => m.id) }, text: l.length ? "The prepared meeting and its background files were deleted." : "No prepared meeting to clear." };
    }
    default: throw usage("Usage: wingman plan [list | show [id] | new|set [--id <id>] --title .. --at \"2026-11-03 14:30\" --who .. --goal .. --kind .. --topic .. --note .. --must .. | attach [--id <id>] --file/--text/--stdin | detach <file id> | delete <id> --yes]");
  }
}
