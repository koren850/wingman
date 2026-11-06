// wingman live [--follow]: the current transcript and answer cards, read from calls/<id>/{transcript,cards}.jsonl with the same
// parser and cleaner as the app's live view (dashboard/livefeed.js). Only the "is this call still running" check uses the
// owner-only control socket (tray/control-socket.cjs); the content is read from files.
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { appStatus } from "./client.ts";
import { CliError, EXIT, dataLib, feedLib, parse, usage, type Ctx, type Result } from "./common.ts";
import { resolveId } from "./calls.ts";

// Reads new complete lines of a growing .jsonl file. A partial last line is carried over to the next read; a shrunk file restarts from 0.
class Tail {
  off = 0; carry = Buffer.alloc(0);
  constructor(private file: string) {}
  read(): FeedRow[] {
    let fd: number | undefined;
    try {
      const st = lstatSync(this.file); if (!st.isFile()) return [];
      if (st.size < this.off) { this.off = 0; this.carry = Buffer.alloc(0); }
      if (st.size === this.off) return [];
      fd = openSync(this.file, "r");
      const n = Math.min(fstatSync(fd).size - this.off, 4_000_000), buf = Buffer.alloc(n);
      const got = readSync(fd, buf, 0, n, this.off); this.off += got;
      const data = Buffer.concat([this.carry, buf.subarray(0, got)]), nl = data.lastIndexOf(10);
      if (nl < 0) { this.carry = data; return []; }
      this.carry = data.subarray(nl + 1);
      return feedLib.parseJsonl("", data.subarray(0, nl + 1).toString("utf8")).rows;
    } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }
  }
}

// Which call to show: --id, else the running call, else the newest saved one.
async function pickId(ctx: Ctx, given: string | undefined) {
  if (given) return { id: resolveId(ctx, given), running: false, phase: "" };
  const a = await appStatus(ctx);
  if (a?.state?.callId && a.state.running) return { id: a.state.callId as string, running: true, phase: a.state.phase as string };
  const l = dataLib.listCalls(ctx.calls)[0];
  if (!l) throw new CliError("not_found", a ? "No call is running and there are no saved calls." : "The app is not running and there are no saved calls.", a ? EXIT.NOT_FOUND : EXIT.NO_APP);
  return { id: l.id as string, running: false, phase: "" };
}

/** One row of the live feed (transcript line, card or frame). */
interface FeedRow { t: number; ch?: string; text?: string; badge?: string; say?: string; dim?: boolean; id?: string; withdraw?: boolean; cards?: unknown; kind?: string; topic?: string; checklist?: unknown[] }
const fmtLine = (l: FeedRow, t0: number) => `[${feedLib.stamp(l.t, t0)}] ${l.ch === "me" ? "me  " : "them"}: ${l.text}`;
const fmtCard = (c: FeedRow, t0: number) => `    -> [${c.badge}${c.dim ? ", dim" : ""}] ${c.say}`;

/** Snapshot of a call, or with --follow a stream polled every 600 ms; app status is checked every 5th poll to detect the call ending. */
export async function live(ctx: Ctx, args: string[]): Promise<Result> {
  const { values } = parse(args, { follow: { type: "boolean" }, id: { type: "string" }, last: { type: "string" }, timeout: { type: "string" } });
  const last = values.last === undefined ? Infinity : Number(values.last);
  if (!(last > 0)) throw usage("--last must be a positive number");
  if (values.timeout !== undefined && !(Number(values.timeout) > 0)) throw usage("--timeout must be a positive number of seconds");
  const { id, running } = await pickId(ctx, values.id);
  const dir = dataLib.callDir(ctx.calls, id);
  const feed = feedLib.create();
  const tr = new Tail(join(dir, "transcript.jsonl")), cd = new Tail(join(dir, "cards.jsonl"));
  const load = () => { const lr = tr.read(), cr = cd.read(); return { lines: feed.addLines(lr), cards: feed.addCards(cr), frame: feed.addFrameRows(cr) }; };
  load();
  const t0 = () => feed.lines[0]?.t ?? 0;

  if (!values.follow) {
    const v = feed.view(), snap = feed.snapshot();
    const items = v.items.slice(-last);
    const L = [`Call ${id}${running ? " (live)" : ""}`];
    if (snap.frame) L.push(`Frame: ${snap.frame.kind}${snap.frame.topic ? ` · ${snap.frame.topic}` : ""} · ${feedLib.frameProgress(snap.frame).done}/${snap.frame.checklist.length}`);
    for (const l of items) { L.push(fmtLine(l, t0())); for (const c of l.cards) L.push(fmtCard(c, t0())); }
    for (const c of v.loose) L.push(`  (card) [${c.badge}] ${c.say}`);
    if (!items.length) L.push("(nothing heard yet)");
    return { data: { callId: id, live: running, frame: snap.frame, lines: items.map((l: FeedRow) => ({ t: l.t, ch: l.ch, text: l.text, cards: l.cards })), looseCards: v.loose }, text: L.join("\n") };
  }

  // Follow: stream until the call ends, --timeout seconds pass, or Ctrl+C.
  if (!running) throw new CliError("not_live", "No call is running to follow.", EXIT.REFUSED, "Read a finished call with: wingman live --id <id>  or  wingman calls show <id>");
  const end = values.timeout ? Date.now() + Number(values.timeout) * 1000 : Infinity;
  const emit = (type: string, o: FeedRow) => ctx.out(ctx.json ? JSON.stringify({ type, ...o }) + "\n" : type === "line" ? fmtLine(o, t0()) + "\n" : type === "card" ? (o.withdraw ? `    (card ${o.id} withdrawn)\n` : fmtCard(o, t0()) + "\n") : type === "frame" ? `Frame: ${o.kind}${o.topic ? ` · ${o.topic}` : ""} · ${feedLib.frameProgress(o).done}/${(o.checklist ?? []).length}\n` : "");
  for (const l of feed.lines.slice(-Math.min(last, 10))) emit("line", l);   // a little context to start with
  let tick = 0, ended = false;
  while (Date.now() < end && !ctx.signal?.aborted) {
    await ctx.sleep(600);
    const d = load();
    for (const l of d.lines) emit("line", l);
    for (const c of d.cards) emit("card", c);
    if (d.frame) emit("frame", d.frame);
    if (++tick % 5 === 0) {
      const a = await appStatus(ctx).catch(() => null);
      if (!a || !a.state.running || a.state.callId !== id) { const f = load(); for (const l of f.lines) emit("line", l); for (const c of f.cards) emit("card", c); ended = true; break; }
    }
  }
  if (ctx.json) ctx.out(JSON.stringify({ type: "end", callId: id, ended }) + "\n"); else ctx.out(ended ? "(call ended)\n" : "");
  return { data: { callId: id, ended, streamed: true }, text: "" };
}
