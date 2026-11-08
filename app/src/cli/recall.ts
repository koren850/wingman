// wingman recap | followup, and the waiting half of wingman ask: the commands that read what the call knows.
//   recap     live call: asks the running app (the same as the Ctrl+Opt+U key) and prints the five lines when the engine has written them.
//             saved call, or no app: the recap straight from calls/<id>/session.json (no model), labelled "from notes".
//   followup  the follow-up draft of a saved call (summary.json email if there is one, else session.json), checked by the sentence guard.
// The engine writes its results as events in calls/<id>/events.jsonl (`recap.done`, `ask.done`); these commands read them from there.
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { call, appStatus } from "./client.ts";
import { CliError, EXIT, dataLib, parse, type Ctx, type Result } from "./common.ts";
import { resolveId } from "./calls.ts";
import { callLanguage } from "../calllang.ts";
import { ht, type UiLang } from "../htext.ts";
import { loadMemory } from "../session/store.ts";
import { recapFromMemory, recapIsEmpty, recapText, type Recap } from "../session/ask.ts";
import { followupForCall } from "../session/followup.ts";

type Ev = { type?: string; at?: number; [k: string]: unknown };

/** Rows of events.jsonl written at or after `since` (ms). Reads the last 400 KB only; a missing file gives []. */
export function eventsSince(file: string, since: number): Ev[] {
  let fd: number | undefined;
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return [];
    fd = openSync(file, "r");
    const size = fstatSync(fd).size,
      n = Math.min(size, 400_000),
      buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    const out: Ev[] = [];
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const e = JSON.parse(line) as Ev;
        if (typeof e.at === "number" && e.at >= since) out.push(e);
      } catch {
        /* a half-written line */
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Polls the call's events for the first row that `pick` accepts, up to `ms`. Uses ctx.sleep so tests run fast. */
export async function waitForEvent(ctx: Ctx, callId: string, since: number, pick: (e: Ev) => boolean, ms: number): Promise<Ev | undefined> {
  const file = join(dataLib.callDir(ctx.calls, callId), "events.jsonl");
  const end = Date.now() + ms;
  for (;;) {
    const hit = eventsSince(file, since).find(pick);
    if (hit) return hit;
    if (Date.now() >= end || ctx.signal?.aborted) return undefined;
    await ctx.sleep(300);
  }
}

const uiLang = (text: string): UiLang => (callLanguage(text) === "en" ? "en" : "he");

export async function recap(ctx: Ctx, args: string[]): Promise<Result> {
  const { values } = parse(args, { id: { type: "string" }, wait: { type: "string" }, "no-wait": { type: "boolean" } });
  const waitMs = values.wait === undefined ? 20_000 : Math.max(1, Number(values.wait) || 20) * 1000;
  const app = values.id ? null : await appStatus(ctx);
  const live = !!app?.state?.running && app.state.phase === "live";
  if (live) {
    const id = app!.state.callId as string;
    const since = Date.now();
    await call(ctx, "recap");
    if (values["no-wait"])
      return { data: { sent: true, callId: id }, text: "Catch me up requested. The sheet opens in the answer window; the result is also in the call events." };
    const ev = await waitForEvent(ctx, id, since, (e) => e.type === "recap.done", waitMs);
    if (!ev)
      throw new CliError(
        "timeout",
        `No recap came back in ${Math.round(waitMs / 1000)} s.`,
        EXIT.TIMEOUT,
        "The model may be slow. Try again, or read it later from the answer window.",
      );
    const r = ev.recap as Recap;
    return {
      data: { callId: id, live: true, recap: r, source: ev.source, ai: !!ev.ai, why: ev.why ?? "" },
      text: (ev.text as string) || ht("en", "recap.empty") + (ev.ai ? "" : `\n(${ht("en", "ask.offline")})`),
    };
  }
  // A saved call, or the app is not running: read session.json. No model.
  const id = resolveId(ctx, values.id ?? "latest");
  const dir = dataLib.callDir(ctx.calls, id);
  const mem = loadMemory(dir).mem;
  const r = recapFromMemory(mem);
  const lang = uiLang([mem.summary, ...mem.decisions.map((d) => d.text)].join(" "));
  const label = (k: "where" | "decided" | "open" | "promised" | "asked") => ht(lang, `recap.${k}`);
  return {
    data: { callId: id, live: false, recap: r, source: "notes", ai: false },
    text: (recapIsEmpty(r) ? ht(lang, "recap.empty") : recapText(r, label)) + `\n(${ht("en", "ask.offline")})`,
  };
}

export async function followup(ctx: Ctx, args: string[]): Promise<Result> {
  const { values, positionals } = parse(args, { id: { type: "string" } });
  const id = resolveId(ctx, values.id ?? positionals[0] ?? "latest");
  const f = followupForCall(dataLib.callDir(ctx.calls, id));
  if (f.source === "none")
    throw new CliError("not_found", ht(f.lang, "fu.none"), EXIT.NOT_FOUND, "The call has no saved memory yet. After a call with the AI on, run it again.");
  return {
    data: { callId: id, source: f.source, lang: f.lang, text: f.text, guardReplaced: f.replaced },
    text: f.text + (f.replaced ? `\n\n(${f.replaced} sentence(s) were replaced with [fill in]. Complete them before you send.)` : ""),
  };
}
