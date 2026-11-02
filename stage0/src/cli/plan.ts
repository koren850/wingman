// wingman plan / prepare: the next meeting's brief (same file and format as the app's "Plan a call" and `pnpm brief`), plus background files.
// Writes data/private/briefs/latest.yaml and the attachments store directly (no engine, no network); the app notices within a second.
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { request } from "./client.ts";
import { CliError, EXIT, trayLib, attachments, parse, usage, ago, type Ctx, type Result } from "./common.ts";
import { KINDS } from "../frame.ts";

const KIND_PREFIX = "Call kind: ", TOPIC_PREFIX = "Topic: ";
const LIMIT_NOTES = 12;

export interface Plan { ready: boolean; who: string; goal: string; kind: string; topic: string; notes: string[]; mustCover: string[]; expiresInMin: number; attachments: { id: string; name: string; chars: number }[]; }

const store = (ctx: Ctx) => attachments.createStore({ dir: join(ctx.briefs, "attachments") });
const briefFile = (ctx: Ctx) => join(ctx.briefs, "latest.yaml");

export function readPlan(ctx: Ctx): Plan {
  const b = trayLib.readBrief(briefFile(ctx));
  let kind = "", topic = "";
  const notes: string[] = [];
  for (const n of (b?.notes ?? []) as string[]) {
    if (n.startsWith(KIND_PREFIX)) kind = n.slice(KIND_PREFIX.length).trim(); else if (n.startsWith(TOPIC_PREFIX)) topic = n.slice(TOPIC_PREFIX.length).trim(); else notes.push(n);
  }
  const att = store(ctx).list().files.map((f: any) => ({ id: f.id, name: f.name, chars: f.chars }));
  return { ready: !!b, who: b?.who ?? "", goal: b?.goal ?? "", kind, topic, notes, mustCover: b?.mustCover ?? [], expiresInMin: b ? Math.round(b.expiresInMs / 60000) : 0, attachments: att };
}

const item = (s: string) => s.replace(/;/g, ",").replace(/\s+/g, " ").trim();   // ';' splits items in the brief format
function describe(p: Plan): string {
  if (!p.ready) return "No plan for the next call." + (p.attachments.length ? ` (${p.attachments.length} background file(s) waiting)` : "");
  const L = [`Plan for the next call (expires in ${ago(p.expiresInMin * 60000)}):`];
  if (p.who) L.push(`  Who:    ${p.who}`);
  if (p.kind) L.push(`  Kind:   ${p.kind}`);
  if (p.topic) L.push(`  Topic:  ${p.topic}`);
  if (p.goal) L.push(`  Goal:   ${p.goal}`);
  if (p.notes.length) L.push("  Notes:", ...p.notes.map((n) => `    - ${n}`));
  if (p.mustCover.length) L.push("  Must cover:", ...p.mustCover.map((n) => `    [ ] ${n}`));
  if (p.attachments.length) L.push("  Background files:", ...p.attachments.map((a) => `    ${a.id}  ${a.name} (${a.chars} chars)`));
  return L.join("\n");
}

async function refreshApp(ctx: Ctx) { try { await request(ctx, "brief_refresh", undefined, 3000); } catch { /* app not running: it reads the file when it starts */ } }

async function setPlan(ctx: Ctx, args: string[]): Promise<Result> {
  const { values } = parse(args, {
    who: { type: "string" }, goal: { type: "string" }, kind: { type: "string" }, topic: { type: "string" },
    note: { type: "string", multiple: true }, "add-note": { type: "string", multiple: true }, must: { type: "string", multiple: true }, "add-must": { type: "string", multiple: true },
    fresh: { type: "boolean" },
  });
  if (values.kind && !(KINDS as readonly string[]).includes(values.kind)) throw usage(`--kind must be one of: ${KINDS.join(", ")}`);
  const cur = values.fresh ? { who: "", goal: "", kind: "", topic: "", notes: [] as string[], mustCover: [] as string[] } : readPlan(ctx);
  const who = values.who ?? cur.who, goal = values.goal ?? cur.goal, kind = values.kind ?? cur.kind, topic = values.topic ?? cur.topic;
  const notes = [...(values.note ? values.note.map(item) : cur.notes), ...(values["add-note"] ?? []).map(item)].filter(Boolean);
  const must = [...(values.must ? values.must.map(item) : cur.mustCover), ...(values["add-must"] ?? []).map(item)].filter(Boolean);
  const all = [...(kind ? [KIND_PREFIX + kind] : []), ...(topic ? [TOPIC_PREFIX + topic] : []), ...notes];
  if (all.length > LIMIT_NOTES) throw usage(`At most ${LIMIT_NOTES} notes (kind and topic count as notes).`);
  if (must.length > LIMIT_NOTES) throw usage(`At most ${LIMIT_NOTES} must-cover items.`);
  const b = trayLib.briefFrom({ who, goal, notes: all.join("\n"), mustCover: must.join("\n") });
  if (!b) throw usage("Give at least one of --who, --goal, --kind, --topic, --note, --must.");
  trayLib.writeBrief(ctx.briefs, b);
  await refreshApp(ctx);
  const p = readPlan(ctx);
  return { data: { saved: true, plan: p }, text: "Plan saved.\n" + describe(p) };
}

async function attach(ctx: Ctx, args: string[]): Promise<Result> {
  const { values } = parse(args, { file: { type: "string" }, text: { type: "string" }, stdin: { type: "boolean" } });
  const n = [values.file, values.text, values.stdin].filter((x) => x !== undefined && x !== false).length;
  if (n !== 1) throw usage("Give exactly one of: --file <path>, --text \"<text>\", --stdin");
  const s = store(ctx);
  let r: any;
  if (values.file !== undefined) {
    let st; try { st = statSync(values.file); } catch { throw new CliError("not_found", `No such file: ${values.file}`, EXIT.NOT_FOUND); }
    if (!st.isFile()) throw usage("That is not a regular file.");
    if (st.size > attachments.MAX_BYTES) throw usage("Files can be 2 MB at most.");
    r = await s.addFile(basename(values.file), readFileSync(values.file));
  } else {
    const text = values.text !== undefined ? values.text : await ctx.stdin();
    r = s.addPaste(text);
  }
  if (!r.ok) throw new CliError("attach_failed", r.error, EXIT.FAIL);
  await refreshApp(ctx);
  const p = readPlan(ctx);
  return { data: { attached: true, id: r.id, chars: r.chars, truncated: !!r.truncated, attachments: p.attachments }, text: `Background added (${r.chars} characters${r.truncated ? ", cut to fit the limit" : ""}), id ${r.id}.` };
}

export async function plan(ctx: Ctx, args: string[]): Promise<Result> {
  const sub = !args[0] ? "show" : args[0].startsWith("-") ? "set" : args[0], rest = sub === args[0] ? args.slice(1) : args;   // `prepare --who X` = set
  switch (sub) {
    case "show": case "list": { parse(rest, {}); const p = readPlan(ctx); return { data: { plan: p }, text: describe(p) }; }
    case "set": case "edit": case "create": return setPlan(ctx, rest);
    case "attach": return attach(ctx, rest);
    case "detach": {
      const { positionals } = parse(rest, {});
      if (positionals.length !== 1) throw usage("Usage: wingman plan detach <file id>   (ids: wingman plan show)");
      if (!/^a[0-9a-z]{6,12}$/.test(positionals[0])) throw usage("That is not a background file id.");
      if (!readPlan(ctx).attachments.some((a) => a.id === positionals[0])) throw new CliError("not_found", "No such background file.", EXIT.NOT_FOUND);
      store(ctx).remove(positionals[0]);
      return { data: { detached: positionals[0] }, text: "Background file removed." };
    }
    case "clear": {
      parse(rest, {});
      trayLib.clearBrief(ctx.briefs); store(ctx).clear();
      await refreshApp(ctx);
      return { data: { cleared: true }, text: "Plan and background files cleared." };
    }
    default: throw usage("Usage: wingman plan [show | set --who .. --goal .. --kind .. --topic .. --note .. --must .. | attach --file/--text/--stdin | detach <id> | clear]");
  }
}
