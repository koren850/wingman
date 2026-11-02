// wingman calls list | show | summary | email | rate | purge. Reads and writes calls/ through dashboard/lib.cjs, the module the app's Calls pages use.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { appStatus } from "./client.ts";
import { CliError, EXIT, dataLib, feedLib, parse, usage, clip, mmss, type Ctx, type Result } from "./common.ts";

const when = (t: number) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) : "?");

/** "latest" or a call id -> a validated id. */
export function resolveId(ctx: Ctx, id: string | undefined): string {
  if (!id) throw usage("A call id is needed (wingman calls list).");
  if (id === "latest") {
    const l = dataLib.listCalls(ctx.calls)[0];
    if (!l) throw new CliError("not_found", "There are no saved calls.", EXIT.NOT_FOUND);
    return l.id;
  }
  try { dataLib.callDir(ctx.calls, id); } catch (e) {
    const m = (e as Error).message;
    if (/bad call id|bad call path/.test(m)) throw usage(`Not a call id: ${clip(id, 40)}`);
    throw new CliError("not_found", `No such call: ${id}`, EXIT.NOT_FOUND, "List calls: wingman calls list");
  }
  return id;
}

function summaryText(s: any): string {
  const L: string[] = [];
  if (s.summary.length) L.push("Summary:", ...s.summary.map((x: string) => `  - ${x}`));
  if (s.decisions.length) L.push("Decisions:", ...s.decisions.map((x: string) => `  - ${x}`));
  if (s.nextSteps.length) L.push("Next steps:", ...s.nextSteps.map((n: any) => `  - ${n.who}: ${n.what}${n.when ? ` (${n.when})` : ""}`));
  if (s.openQuestions.length) L.push("Open questions:", ...s.openQuestions.map((x: string) => `  - ${x}`));
  return L.join("\n");
}

function generate(ctx: Ctx, id: string): Promise<boolean> {
  const run = ctx.spawnTsx ?? ((a: string[], ms: number) => new Promise<{ code: number; out: string }>((res) =>
    execFile(join(ctx.root, "node_modules", ".bin", "tsx"), a, { cwd: ctx.root, timeout: ms, maxBuffer: 4_000_000, env: { ...ctx.env, FORCE_COLOR: "0" } }, (e) => res({ code: e ? 1 : 0, out: "" }))));
  return run([join(ctx.root, "src", "summary.ts"), id], 180_000).then((r) => r.code === 0);   // output is dropped: it contains call content
}

export async function calls(ctx: Ctx, args: string[]): Promise<Result> {
  const sub = args[0] || "list", rest = args.slice(1);
  switch (sub) {
    case "list": {
      const { values } = parse(rest, { limit: { type: "string" } });
      const n = values.limit === undefined ? 20 : Number(values.limit);
      if (!Number.isInteger(n) || n < 1 || n > 500) throw usage("--limit must be 1 to 500");
      const all = dataLib.listCalls(ctx.calls), list = all.slice(0, n);
      const text = list.length ? list.map((c: any) => `${c.id}  ${when(c.startedAt)}  ${mmss(c.durationMs).padStart(6)}  ${c.mode}${c.noAi ? " no-ai" : ""}${c.crashed ? " CRASHED" : ""}  cards ${c.cardsShown}  rated ${c.rated}  ${c.hasSummary ? "summary" : "no summary"}`).join("\n") + (all.length > n ? `\n(${all.length - n} older not shown: --limit)` : "") : "No saved calls.";
      return { data: { total: all.length, calls: list }, text };
    }
    case "show": {
      const { values, positionals } = parse(rest, { "no-transcript": { type: "boolean" }, lines: { type: "string" } });
      const id = resolveId(ctx, positionals[0]);
      const c = dataLib.getCall(ctx.calls, id);
      const t0 = c.transcript[0]?.t ?? 0;
      const max = values.lines === undefined ? Infinity : Number(values.lines);
      if (!(max > 0)) throw usage("--lines must be a positive number");
      const tr = values["no-transcript"] ? [] : c.transcript.slice(-max);
      const cards = c.cards.filter((x: any) => !x.hidden && x.badge !== "info" && !x.health).map((x: any) => ({ id: x.id, badge: x.badge, question: x.question || "", say: x.say || "", rating: c.tags[x.id] || "", t: x.at ?? x.t ?? 0 }));
      const s = c.summary;
      const data = { call: s, meta: c.meta, frame: c.callFrame, transcript: tr, cards, hasSummary: !!c.callSummary };
      const L = [`Call ${id}  ${when(s.startedAt)}  ${mmss(s.durationMs)}  ${s.mode}${s.noAi ? " no-ai" : ""}${s.crashed ? "  CRASHED" : ""}  cost $${s.costUsd.toFixed(3)}`];
      if (c.callFrame) L.push(`Frame: ${c.callFrame.frame.kind}${c.callFrame.frame.topic ? ` · ${c.callFrame.frame.topic}` : ""} · checklist ${c.callFrame.done}/${c.callFrame.total}`);
      if (tr.length) { L.push("", "Transcript:"); for (const l of tr) L.push(`  [${feedLib.stamp(l.t, t0)}] ${l.ch === "me" ? "me  " : "them"}: ${l.text}`); }
      if (cards.length) { L.push("", "Cards (id, badge, rating):"); for (const x of cards) L.push(`  ${x.id}  ${x.badge}${x.rating ? `  [${x.rating}]` : ""}  ${x.question ? x.question + " -> " : ""}${x.say}`); }
      if (c.callSummary) L.push("", summaryText(c.callSummary)); else L.push("", "(no summary yet: wingman calls summary " + id + " --generate)");
      return { data, text: L.join("\n") };
    }
    case "summary": case "email": {
      const { values, positionals } = parse(rest, { generate: { type: "boolean" } });
      const id = resolveId(ctx, positionals[0]);
      let s = dataLib.getCall(ctx.calls, id).callSummary;
      let generated = false;
      if (!s && values.generate) {
        if (!(await generate(ctx, id))) throw new CliError("generate_failed", "The summary could not be written (missing key, no transcript or the model failed).", EXIT.FAIL, "Check: wingman keys status");
        s = dataLib.getCall(ctx.calls, id).callSummary; generated = true;
      }
      if (!s) throw new CliError("not_found", `Call ${id} has no summary.`, EXIT.NOT_FOUND, `Write one (one small paid model call): wingman calls ${sub} ${id} --generate`);
      if (sub === "summary") return { data: { id, generated, summary: s }, text: summaryText(s) };
      if (!s.followUpEmail) throw new CliError("not_found", "This summary has no follow-up email (personal and other calls have none).", EXIT.NOT_FOUND);
      return { data: { id, generated, email: s.followUpEmail }, text: s.followUpEmail };
    }
    case "rate": {
      const { positionals } = parse(rest, {});
      if (positionals.length !== 3 || !/^(y|n|clear)$/.test(positionals[2])) throw usage("Usage: wingman calls rate <call id> <card id> y|n|clear");
      const id = resolveId(ctx, positionals[0]);
      try { dataLib.setTag(ctx.calls, id, positionals[1], positionals[2] === "clear" ? null : positionals[2]); }
      catch (e) { if (/not ratable/.test((e as Error).message)) throw new CliError("not_found", `Card ${clip(positionals[1], 40)} cannot be rated in call ${id} (see: wingman calls show ${id}).`, EXIT.NOT_FOUND); throw usage((e as Error).message); }
      const s = dataLib.getCall(ctx.calls, id).summary;
      return { data: { id, card: positionals[1], rating: positionals[2] === "clear" ? "" : positionals[2], rated: s.rated, useful: s.useful }, text: `Rated ${positionals[1]}: ${positionals[2]}  (${s.useful} useful of ${s.rated} rated)` };
    }
    case "purge": {
      const { values, positionals } = parse(rest, { yes: { type: "boolean" } });
      const id = resolveId(ctx, positionals[0]);
      if (!values.yes) throw new CliError("needs_yes", `Purging deletes call ${id} for good (transcript, cards, ratings, summary). Add --yes to confirm.`, EXIT.NEEDS_YES);
      const a = await appStatus(ctx).catch(() => null);
      if (a?.state?.running && a.state.callId === id) throw new CliError("refused", "That call is running. Stop it first (wingman stop, or wingman stop --delete --yes).", EXIT.REFUSED);
      dataLib.deleteCall(ctx.calls, id);
      return { data: { purged: id }, text: `Deleted ${id}` };
    }
    default: throw usage("Usage: wingman calls [list | show <id|latest> | summary <id> [--generate] | email <id> | rate <id> <card> y|n|clear | purge <id> --yes]");
  }
}
