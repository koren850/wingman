// Cassette layer for model calls: record a real answer once, replay it forever, offline and the same every time.
//
// Modes (env WINGMAN_LLM_MODE):
//   live    (default) the model is called as before; this file is not in the way.
//   replay  every call must be in the cassette. No network, no key. Tests use this. A miss throws CassetteMiss with a diff to the nearest entry.
//   record  the real model is called and its answer is added to the cassette. Needs a key. Never run in CI or by agents; tested with a mock model only.
// The cassette file is WINGMAN_CASSETTE (default data/cassettes/default.cassette.json). One entry per call:
//   key = sha256(role, model, system, messages, options), the chunks with their timing, usage, total ms, and source "recorded" | "authored".
// "authored" entries are written by hand (or by a test) and say so; they are never confused with a real recording.
//
// The seam is ModelRegistry.resolve(ref, role) in llm.ts, which wraps the model with wrapCassette() when the mode is record or replay.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModel } from "ai";
import { ROOT } from "../env.ts";
import { viewOf, renderView, inferRole, type CallOptions, type PromptView } from "../testkit/prompt.ts";

export type LlmMode = "live" | "record" | "replay";
export function llmMode(env: NodeJS.ProcessEnv = process.env): LlmMode {
  const m = (env.WINGMAN_LLM_MODE ?? "live").trim().toLowerCase();
  if (m === "live" || m === "record" || m === "replay") return m;
  throw new Error(`WINGMAN_LLM_MODE must be live, record or replay (got "${env.WINGMAN_LLM_MODE}")`);
}
export const defaultCassettePath = (env: NodeJS.ProcessEnv = process.env) => env.WINGMAN_CASSETTE || join(ROOT, "data", "cassettes", "default.cassette.json");

type Finish = { unified: string; raw?: string };
export type Entry = {
  key: string;
  role: string;
  model: string;
  source: "recorded" | "authored";
  /** What was asked, in readable form (for diffs and review). */
  request: { system: string; messages: string[]; options: unknown };
  /** sha256 (first 16 hex) of the system text. A changed prompt changes this and nothing else: that is how a stale entry is told from a miss. */
  promptHash?: string;
  /** Same for the messages and options. Equal input hash with a different prompt hash (or model) = the entry is stale. */
  inputHash?: string;
  /** Text pieces with the ms (since the call started) at which each arrived. */
  chunks: { at: number; text: string }[];
  finish: Finish;
  usage: unknown;
  /** Total ms from call to the end of the answer. */
  ms: number;
};
type File = { v: 1; entries: Entry[] };

/** Stable key of one call. Volatile fields (abort signals, headers, the wingman role marker) are not part of it. */
export function cassetteKey(v: Pick<PromptView, "role" | "model" | "system" | "messages" | "options">): string {
  return createHash("sha256")
    .update(JSON.stringify({ role: v.role, model: v.model, system: v.system, messages: v.messages, options: v.options }))
    .digest("hex")
    .slice(0, 24);
}

const sha16 = (x: unknown) =>
  createHash("sha256")
    .update(typeof x === "string" ? x : JSON.stringify(x))
    .digest("hex")
    .slice(0, 16);
/** Hash of the system text of a call. */
export const promptHashOf = (system: string) => sha16(system);
/** Hash of the messages and options of a call. */
export const inputHashOf = (messages: string[], options: unknown) => sha16({ messages, options });
const hashesOf = (e: Entry) => ({
  promptHash: e.promptHash ?? promptHashOf(e.request.system),
  inputHash: e.inputHash ?? inputHashOf(e.request.messages, e.request.options),
});

export class CassetteMiss extends Error {
  constructor(
    message: string,
    readonly key: string,
  ) {
    super(message);
    this.name = "CassetteMiss";
  }
}
/** A miss where the cassette holds an entry for the same input that was recorded with another prompt text or another model. The fix is to re-record, not to look for a bug. */
export class CassetteStale extends CassetteMiss {
  constructor(
    message: string,
    key: string,
    readonly staleKey: string,
    readonly why: "prompt" | "model",
  ) {
    super(message, key);
    this.name = "CassetteStale";
  }
}

export class Cassette {
  private byKey = new Map<string, Entry>();
  constructor(readonly path?: string) {
    if (path && existsSync(path)) {
      const f = JSON.parse(readFileSync(path, "utf8")) as File;
      if (f.v !== 1) throw new Error(`cassette ${path}: unknown version ${String(f.v)}`);
      for (const e of f.entries) this.byKey.set(e.key, e);
    }
  }
  get size() {
    return this.byKey.size;
  }
  get(key: string) {
    return this.byKey.get(key);
  }
  private byInput?: Map<string, Entry[]>;
  /** An entry recorded for the same role and the same input (messages, options) but another prompt text or model: stale, not missing. */
  findStale(v: PromptView): { entry: Entry; why: "prompt" | "model" } | undefined {
    if (!this.byInput) {
      this.byInput = new Map();
      for (const e of this.byKey.values()) {
        const k = `${e.role}\u0001${hashesOf(e).inputHash}`;
        (this.byInput.get(k) ?? this.byInput.set(k, []).get(k)!).push(e);
      }
    }
    const list = this.byInput.get(`${v.role}\u0001${inputHashOf(v.messages, v.options)}`);
    if (!list?.length) return undefined;
    const ph = promptHashOf(v.system);
    // the same model with another prompt is the common case; prefer it
    const e = list.find((x) => x.model === v.model && hashesOf(x).promptHash !== ph) ?? list.find((x) => x.model !== v.model);
    return e ? { entry: e, why: e.model === v.model ? "prompt" : "model" } : undefined;
  }
  entries() {
    return [...this.byKey.values()];
  }
  put(e: Entry) {
    this.byKey.set(e.key, e);
    this.byInput = undefined;
  }
  /** Writes the file atomically with sorted keys, so a re-record gives a small diff. */
  save(path = this.path) {
    if (!path) throw new Error("cassette: no path to save to");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const f: File = { v: 1, entries: [...this.byKey.values()].sort((a, b) => a.key.localeCompare(b.key)) };
    const tmp = `${path}.tmp${process.pid}`;
    writeFileSync(tmp, JSON.stringify(f, null, 1) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  }
  /** Adds a hand-written answer for the call `call` (the same options a model would receive). Marked "authored". */
  author(model: string, call: CallOptions, text: string, o: { ms?: number; role?: string; usage?: unknown } = {}): Entry {
    const v = viewOf(model, call);
    if (o.role) v.role = o.role;
    const e = entryOf(
      v,
      [{ at: o.ms ?? 0, text }],
      { unified: "stop", raw: "end_turn" },
      o.usage ?? usageOf(100, Math.ceil(text.length / 4)),
      o.ms ?? 0,
      "authored",
    );
    this.put(e);
    return e;
  }
  /** The entry most like `v` (same role and model first), for the miss message. */
  nearest(v: PromptView): Entry | undefined {
    const all = this.entries();
    const same = all.filter((e) => e.role === v.role && e.model === v.model);
    const pool = same.length ? same : all;
    let best: { e: Entry; d: number } | undefined;
    const mine = renderRequest(v).split("\n");
    for (const e of pool) {
      const d = lineDistance(renderEntryRequest(e).split("\n"), mine);
      if (!best || d < best.d) best = { e, d };
    }
    return best?.e;
  }
}

const usageOf = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});
function entryOf(v: PromptView, chunks: Entry["chunks"], finish: Finish, usage: unknown, ms: number, source: Entry["source"]): Entry {
  return {
    key: cassetteKey(v),
    role: v.role,
    model: v.model,
    source,
    request: { system: v.system, messages: v.messages, options: v.options },
    promptHash: promptHashOf(v.system),
    inputHash: inputHashOf(v.messages, v.options),
    chunks,
    finish,
    usage,
    ms,
  };
}
const renderRequest = (v: PromptView) => renderView(v);
const renderEntryRequest = (e: Entry) =>
  renderView({
    role: e.role,
    model: e.model,
    system: e.request.system,
    messages: e.request.messages,
    options: e.request.options as PromptView["options"],
  } as PromptView);

// ---- readable diff
/** Number of lines that differ between two line lists (size of the edit script). */
function lineDistance(a: string[], b: string[]): number {
  return a.length + b.length - 2 * lcs(a, b).length;
}
function lcs(a: string[], b: string[]): [number, number][] {
  // Plain dynamic programming; prompts are a few hundred lines. Larger inputs are compared on their first 600 lines.
  const A = a.slice(0, 600),
    B = b.slice(0, 600);
  const t: number[][] = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--) t[i][j] = A[i] === B[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < A.length && j < B.length;) {
    if (A[i] === B[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (t[i + 1][j] >= t[i][j + 1]) i++;
    else j++;
  }
  return out;
}
/** Unified-style diff: "- " only in the cassette, "+ " only in this call, "  " one line of context. At most `max` output lines. */
export function diffLines(a: string[], b: string[], max = 40): string {
  const short = (s: string) => (s.length > 160 ? s.slice(0, 157) + "..." : s);
  const script: string[] = [];
  let i = 0,
    j = 0;
  for (const [ci, cj] of [...lcs(a, b), [a.length, b.length] as [number, number]]) {
    while (i < ci) script.push(`- ${short(a[i++])}`);
    while (j < cj) script.push(`+ ${short(b[j++])}`);
    if (ci < a.length) script.push(`  ${short(a[ci])}`);
    i = ci + 1;
    j = cj + 1;
  }
  const changed = (k: number) => /^[-+]/.test(script[k] ?? "");
  const lines = script.filter((_, k) => changed(k) || changed(k - 1) || changed(k + 1)); // changed lines with one line of context
  return lines.length > max ? [...lines.slice(0, max), `... ${lines.length - max} more lines`].join("\n") : lines.join("\n");
}
export function staleMessage(c: Cassette, v: PromptView, key: string, s: { entry: Entry; why: "prompt" | "model" }): string {
  const head = `Cassette STALE (not a miss): role=${v.role} model=${v.model} key=${key}${c.path ? ` file=${c.path}` : ""}. The cassette has entry ${s.entry.key} for the same input, recorded with ${s.why === "model" ? `model ${s.entry.model}` : "another prompt text"}. Re-record it (needs a key); the entry is out of date, the engine did not break.`;
  if (s.why === "model") return head;
  const diff = diffLines(s.entry.request.system.split("\n"), v.system.split("\n"));
  return `${head}\nSystem prompt diff (- cassette, + this call):\n${diff || "(only whitespace differs)"}`;
}
export function missMessage(c: Cassette, v: PromptView, key: string): string {
  const near = c.nearest(v);
  const head = `Cassette miss: role=${v.role} model=${v.model} key=${key}${c.path ? ` file=${c.path}` : ""} (${c.size} entries). Re-record it with WINGMAN_LLM_MODE=record (needs a key), or author the entry.`;
  if (!near) return `${head}\nThe cassette is empty.`;
  const diff = diffLines(renderEntryRequest(near).split("\n"), renderRequest(v).split("\n"));
  return `${head}\nNearest entry: key=${near.key} role=${near.role} model=${near.model} source=${near.source}\nDiff (- cassette, + this call):\n${diff || "(no line differs; the options differ)"}`;
}

// ---- the wrapper
export type CassetteOptions = {
  mode: "record" | "replay";
  cassette: Cassette;
  /** The model name used in the key ("anthropic:claude-haiku-5-5"). */
  ref: string;
  role?: string;
  /** record only: the real model (or a mock transport in tests). */
  inner?: LanguageModel;
  /** replay: "recorded" waits the recorded gaps (default), "instant" does not wait. */
  timing?: "recorded" | "instant";
  /** record: save the file after every call (default true when the cassette has a path). */
  autosave?: boolean;
};
type Call = CallOptions & { abortSignal?: AbortSignal };
type AnyModel = { doGenerate: (c: unknown) => Promise<any>; doStream: (c: unknown) => Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any -- the V4 result types are not needed here

export function wrapCassette(o: CassetteOptions): LanguageModel {
  if (o.mode === "record" && !o.inner) {
    throw new Error("Cassette record mode needs the real model and its API key. Set the key, or use WINGMAN_LLM_MODE=replay.");
  }
  const inner = o.inner as unknown as AnyModel | undefined;
  const view = (c: Call): PromptView => {
    const v = viewOf(o.ref, c);
    if (o.role) v.role = o.role;
    else v.role = inferRole(v.system, c.providerOptions);
    return v;
  };
  const wait = (ms: number, signal?: AbortSignal) =>
    ms <= 0 || o.timing === "instant"
      ? Promise.resolve()
      : new Promise<void>((res, rej) => {
          const t = setTimeout(res, ms);
          signal?.addEventListener("abort", () => (clearTimeout(t), rej(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))), {
            once: true,
          });
        });
  const hit = (c: Call) => {
    const v = view(c),
      key = cassetteKey(v),
      e = o.cassette.get(key);
    if (!e) {
      const st = o.cassette.findStale(v);
      if (st) throw new CassetteStale(staleMessage(o.cassette, v, key, st), key, st.entry.key, st.why);
      throw new CassetteMiss(missMessage(o.cassette, v, key), key);
    }
    return e;
  };
  const save = () => {
    if (o.autosave !== false && o.cassette.path) o.cassette.save();
  };

  const model = new MockLanguageModelV4({
    provider: "cassette",
    modelId: o.ref,
    doGenerate: async (c: unknown) => {
      const call = c as Call;
      if (o.mode === "record") {
        const v = view(call),
          t0 = Date.now();
        const r = await inner!.doGenerate(c);
        const text = (r.content as { type: string; text?: string }[])
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("");
        const ms = Date.now() - t0;
        o.cassette.put(entryOf(v, text ? [{ at: ms, text }] : [], r.finishReason, r.usage, ms, "recorded"));
        save();
        return r;
      }
      const e = hit(call);
      await wait(e.chunks[0]?.at ?? e.ms, call.abortSignal);
      const text = e.chunks.map((x) => x.text).join("");
      return { content: text ? [{ type: "text", text }] : [], finishReason: e.finish, usage: e.usage, warnings: [] };
    },
    doStream: async (c: unknown) => {
      const call = c as Call;
      if (o.mode === "record") {
        const v = view(call),
          t0 = Date.now();
        const r = await inner!.doStream(c);
        const chunks: Entry["chunks"] = [];
        let finish: Finish = { unified: "stop" },
          usage: unknown;
        const tap = new TransformStream({
          transform(part, ctl) {
            if (part.type === "text-delta") chunks.push({ at: Date.now() - t0, text: part.delta ?? part.text ?? "" });
            if (part.type === "finish") {
              finish = part.finishReason;
              usage = part.usage;
            }
            ctl.enqueue(part);
          },
          flush() {
            o.cassette.put(entryOf(v, chunks, finish, usage ?? usageOf(0, 0), Date.now() - t0, "recorded"));
            save();
          },
        });
        return { ...r, stream: (r.stream as ReadableStream).pipeThrough(tap) };
      }
      const e = hit(call);
      const signal = call.abortSignal;
      const stream = new ReadableStream({
        async start(ctl) {
          try {
            ctl.enqueue({ type: "stream-start", warnings: [] });
            let prev = 0;
            if (e.chunks.length) ctl.enqueue({ type: "text-start", id: "t" });
            for (const ch of e.chunks) {
              await wait(ch.at - prev, signal);
              prev = ch.at;
              ctl.enqueue({ type: "text-delta", id: "t", delta: ch.text });
            }
            if (e.chunks.length) ctl.enqueue({ type: "text-end", id: "t" });
            if (!e.chunks.length) await wait(e.ms, signal);
            ctl.enqueue({ type: "finish", usage: e.usage, finishReason: e.finish });
            ctl.close();
          } catch (err) {
            ctl.error(err);
          }
        },
      });
      return { stream };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the mock's result types are stricter than the plain parts used here
  } as any);
  return model as unknown as LanguageModel;
}

// ---- cassette cache for the registry (one file loaded once per path)
const loaded = new Map<string, Cassette>();
export function cassetteFor(path = defaultCassettePath()): Cassette {
  let c = loaded.get(path);
  if (!c) loaded.set(path, (c = new Cassette(path)));
  return c;
}
export function resetCassetteCache() {
  loaded.clear();
}

// ---- what a cassette holds (for `pnpm cassette:status`)
export type CassetteSummary = {
  entries: number;
  bySource: Record<string, number>;
  /** per role: entries, models seen, and how many carry no hash (written before round 12) */
  byRole: Record<string, { entries: number; models: string[]; unhashed: number; ms: number }>;
};
export function summarizeCassette(c: Cassette): CassetteSummary {
  const out: CassetteSummary = { entries: c.size, bySource: {}, byRole: {} };
  for (const e of c.entries()) {
    out.bySource[e.source] = (out.bySource[e.source] ?? 0) + 1;
    const r = (out.byRole[e.role] ??= { entries: 0, models: [], unhashed: 0, ms: 0 });
    r.entries++;
    r.ms += e.ms;
    if (!r.models.includes(e.model)) r.models.push(e.model);
    if (!e.promptHash || !e.inputHash) r.unhashed++;
  }
  return out;
}
