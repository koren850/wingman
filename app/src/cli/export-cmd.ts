// wingman export <call id|latest> [--md | --json]: a saved call as Markdown or JSON (summary, decisions, next steps, open questions, coaching numbers,
// the follow-up message and a mailto link). Reads the call folder only. Nothing is sent: the mailto link is text for the user to open.
import { CliError, EXIT, dataLib, parse, usage, type Ctx, type Result } from "./common.ts";
import { resolveId } from "./calls.ts";
import { buildExport, exportCall, ExportError } from "../session/export.ts";

export async function exportCmd(ctx: Ctx, args: string[]): Promise<Result> {
  const { values, positionals } = parse(args, { md: { type: "boolean" } });
  if (positionals.length > 1) throw usage("Usage: wingman export <call id|latest> [--md | --json]");
  const id = resolveId(ctx, positionals[0] ?? "latest");
  const dir = dataLib.callDir(ctx.calls, id);
  try {
    // --json is read by the CLI front door (ctx.json): the data is the export object. --md (or neither) prints Markdown.
    if (ctx.json && !values.md) return { data: { callId: id, format: "json", export: buildExport(dir) }, text: exportCall(dir, "json").trimEnd() };
    const md = exportCall(dir, "md");
    return { data: { callId: id, format: "md", markdown: md }, text: md.trimEnd() };
  } catch (e) {
    if (e instanceof ExportError) throw new CliError("not_found", e.message, EXIT.NOT_FOUND, `Write a summary first: wingman calls summary ${id} --generate`);
    throw e;
  }
}
