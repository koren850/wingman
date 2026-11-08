// Shared pieces of the v2 gate tests (src/e2e/v2-*.test.ts). Not a test file.
//  - observeModel: wraps the policy fake so every call gets a usage that follows its real prompt size and a simulated prompt cache
//    (the policy fake reports one fixed usage). The engine then books honest rows in usage.jsonl.
//  - timelineOf: the cards on screen as a grader timeline.
//  - runMeeting: plays one golden meeting through the real engine modules in a child process (v2-worker.ts) and returns what it saw.
// The engine is a singleton per process, so each meeting gets its own child. Nothing here uses the network, keys or audio.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ROOT } from "../env.ts";
import { tsx } from "../test-platform.ts";
import { estimateTokens } from "../testkit/prompt.ts";
import type { Engine } from "../testkit/engine-inproc.ts";
import type { PolicyModel } from "../testkit/policy-model.ts";
import type { TimelineCard } from "../../qa/grade-golden.ts";
import type { Control } from "../../qa/controls.ts";

// ---------------------------------------------------------------- the cache simulator
type Block = { text: string; ttlMs?: number };
export type CallRecord = {
  role: string;
  at: number;
  /** tokens by cache class, as the provider would bill them */
  plain: number;
  read: number;
  write: number;
  out: number;
  /** tokens of each system block, in order, and which of them carry a cache marker */
  blocks: { name: string; tokens: number; cache?: "5m" | "1h" }[];
  userTokens: number;
  /** the text of the blocks and of the user message (only when asked for, for the prompt snapshots) */
  text?: { system: { text: string; cache?: "5m" | "1h" }[]; user: string };
};

const TTL = { "5m": 300_000, "1h": 3_600_000 } as const;
const sha = (s: string) => createHash("sha1").update(s).digest("hex");
type Content = string | { type?: string; text?: string }[];
const textOf = (c: Content) => (typeof c === "string" ? c : c.map((p) => p.text ?? "").join(""));

/**
 * Wraps `e.pm.model` so that every call (a) is recorded with its blocks and cache markers and (b) reports a usage computed from the prompt:
 * Anthropic's cache works on prefixes up to a marker; a prefix that was sent within its TTL is read at the cache-read price, a new one is written.
 * Output tokens follow the text that was actually streamed. The registry returns this wrapper for every ref.
 */
export function observePolicy(
  pm: PolicyModel,
  o: { keepText?: boolean; minCacheTokens?: number; roleFirst?: boolean } = {},
): { calls: CallRecord[]; cacheReadRatio: () => number; wrap: (role?: string) => unknown } {
  const calls: CallRecord[] = [];
  // Providers cache a prefix only above a minimum length (1024 tokens for most models, more for the smallest). Assumed here; a shorter marked prefix is not cached.
  const minCache = o.minCacheTokens ?? 1024;
  const cache = new Map<string, number>(); // prefix hash -> expires at (virtual wall ms)
  const inner = pm.model as unknown as {
    doStream: (c: unknown) => Promise<{ stream: ReadableStream<{ type: string; delta?: string; usage?: unknown }> }>;
    doGenerate: (c: unknown) => Promise<{ content: { text?: string }[]; usage?: unknown }>;
  };
  type Msg = { role: string; content: Content; providerOptions?: { anthropic?: { cacheControl?: { ttl?: "5m" | "1h" } } } };
  const account = (role: string, c: { prompt?: Msg[] }, outText: () => string) => {
    const prompt = c.prompt ?? [];
    let sys = prompt.filter((m) => m.role === "system");
    if (o.roleFirst && sys.length >= 2) {
      // What-if layout: the static rules of the role go right after block A with a 1 h marker; the memory block follows; the per-call data (user, roster,
      // bank candidates) comes last, not cached. Today the rules and the data are one block after the memory block, so nothing of it is cached.
      const roleBlock = sys[sys.length - 1];
      if (!roleBlock.providerOptions?.anthropic?.cacheControl) {
        const marker = { anthropic: { cacheControl: { ttl: "1h" as const } } };
        const full = textOf(roleBlock.content);
        const cut = full.indexOf("\n\n<call_facts>");
        const rules = cut >= 0 ? full.slice(0, cut) : full;
        const data = cut >= 0 ? full.slice(cut) : "";
        const head = sys.length >= 3 ? 1 : 0; // block A first when there is one besides memory and role
        sys = [
          ...sys.slice(0, head),
          { role: "system", content: rules, providerOptions: marker },
          ...sys.slice(head, -1),
          ...(data ? [{ role: "system", content: data }] : []),
        ];
      }
    }
    const rest = prompt.filter((m) => m.role !== "system");
    const blocks: Block[] = sys.map((m) => ({
      text: textOf(m.content),
      ttlMs: m.providerOptions?.anthropic?.cacheControl?.ttl ? TTL[m.providerOptions.anthropic.cacheControl.ttl] : undefined,
    }));
    const now = Date.now();
    const tok = blocks.map((b) => estimateTokens(b.text));
    const userTokens = rest.reduce((a, m) => a + estimateTokens(textOf(m.content)), 0);
    let read = 0,
      write = 0,
      prefix = "",
      upto = 0;
    const marked: { key: string; tokens: number; ttl: number }[] = [];
    blocks.forEach((b, i) => {
      prefix += "\u0001" + b.text;
      upto += tok[i];
      if (b.ttlMs && upto >= minCache) marked.push({ key: sha(prefix), tokens: upto, ttl: b.ttlMs });
    });
    // the longest marked prefix that is still cached is read; the marked prefixes after it are written
    let hitAt = -1;
    marked.forEach((m, i) => {
      if ((cache.get(m.key) ?? 0) > now) hitAt = i;
    });
    if (hitAt >= 0) read = marked[hitAt].tokens;
    for (let i = hitAt + 1; i < marked.length; i++) write = marked[i].tokens - read;
    for (const m of marked) cache.set(m.key, now + m.ttl); // a hit or a write refreshes the clock
    const total = tok.reduce((a, b) => a + b, 0) + userTokens;
    const out = estimateTokens(outText());
    const rec: CallRecord = {
      role,
      at: now,
      plain: Math.max(0, total - read - write),
      read,
      write,
      out,
      blocks: sys.map((m, i) => ({
        name: String(i),
        tokens: tok[i],
        ...(m.providerOptions?.anthropic?.cacheControl?.ttl ? { cache: m.providerOptions.anthropic.cacheControl.ttl } : {}),
      })),
      userTokens,
      ...(o.keepText
        ? {
            text: {
              system: sys.map((m) => ({ text: textOf(m.content), cache: m.providerOptions?.anthropic?.cacheControl?.ttl })),
              user: rest.map((m) => textOf(m.content)).join("\n"),
            },
          }
        : {}),
    };
    calls.push(rec);
    const usage = {
      inputTokens: { total: total, noCache: rec.plain, cacheRead: read, cacheWrite: write },
      outputTokens: { total: out, text: out, reasoning: 0 },
    };
    return usage;
  };
  const roleOf = (c: { providerOptions?: { wingman?: { role?: string } } }, fallback?: string) => c.providerOptions?.wingman?.role ?? fallback ?? "unknown";
  const wrap = (currentRole?: string) => ({
    ...inner,
    specificationVersion: (pm.model as unknown as { specificationVersion: string }).specificationVersion,
    provider: (pm.model as unknown as { provider: string }).provider,
    modelId: (pm.model as unknown as { modelId: string }).modelId,
    async doStream(c: { prompt?: Msg[]; providerOptions?: { wingman?: { role?: string } } }) {
      const r = await inner.doStream(c);
      let text = "";
      const role = roleOf(c, currentRole);
      const ts = new TransformStream({
        transform(part, ctl) {
          if (part.type === "text-delta") text += part.delta ?? "";
          if (part.type === "finish") ctl.enqueue({ ...part, usage: account(role, c, () => text) });
          else ctl.enqueue(part);
        },
      });
      return { ...r, stream: r.stream.pipeThrough(ts) };
    },
    async doGenerate(c: { prompt?: Msg[]; providerOptions?: { wingman?: { role?: string } } }) {
      const r = await inner.doGenerate(c);
      return { ...r, usage: account(roleOf(c, currentRole), c, () => r.content.map((x) => x.text ?? "").join("")) };
    },
  });
  return {
    calls,
    wrap,
    cacheReadRatio: () => {
      const r = calls.reduce((a, c) => a + c.read, 0),
        all = calls.reduce((a, c) => a + c.read + c.write + c.plain, 0);
      return all ? r / all : 0;
    },
  };
}

/** observePolicy for the engine of this process: every model ref resolves to the wrapped fake, the call's role travels with it. */
export function observeModel(e: Engine, opts: Parameters<typeof observePolicy>[1] = {}) {
  const o = observePolicy(e.pm, opts);
  (e.boot.registry as unknown as { resolve: (ref: string, role?: string) => Promise<unknown> }).resolve = async (_ref: string, role?: string) => o.wrap(role);
  return o;
}

// ---------------------------------------------------------------- cards on screen as a timeline
/** The cards on screen at the end, with the time each was first shown (ms from `t0`), kinds as the grader wants them. */
export function timelineOf(e: Engine, t0: number): TimelineCard[] {
  const first = new Map<string, number>();
  for (const r of e.rows) if (r.type === "card" && !r.health && !r.hidden && !r.withdraw && !first.has(r.id)) first.set(r.id, r.t - t0);
  return e.screen().map((c) => ({
    atMs: first.get(c.id) ?? 0,
    // A card without a kind: a prepared (bank), calc or stall card answers a question; an amber "careful" or red "fix" card checks what the user said.
    kind:
      (c.kind as TimelineCard["kind"]) ?? (c.badge === "careful" || c.badge === "fix" ? "check" : c.badge === "info" || c.badge === "tip" ? "fact" : "answer"),
    text: [c.say, ...((c.more as string[]) ?? [])].join(" "),
  }));
}

// ---------------------------------------------------------------- one meeting in a child process
export type MeetingRun = {
  id: string;
  cards: TimelineCard[];
  /** the cards on screen at the end, as the overlay got them */
  screen: { id: string; turnId?: unknown; source?: unknown; badge?: unknown; kind?: unknown; say?: unknown; more?: unknown; at: number }[];
  /** the model calls the engine made, with the usage that was booked */
  calls: CallRecord[];
  /** rows of usage.jsonl */
  usage: { role: string; usd?: number; model?: string }[];
  /** memory at `atLine`+lag, for gradeMemory */
  snapshots: { atLine: string; memory: unknown }[];
  events: Record<string, unknown>[];
  askCards: { q: string; say: string; ms?: number }[];
  /** the meeting length in ms (last line) */
  lengthMs: number;
  memoryVer: number;
  /** the memory at the end of the call, and the last lines (for the wrap-up cost run) */
  memory?: unknown;
  tail: { ch: "me" | "them"; text: string }[];
  sessionFile: boolean;
  cacheRead: number;
  roleCalls: Record<string, number>;
  error?: string;
};
export type WorkerOptions = {
  /** `--set key=value` overrides */
  sets?: Record<string, string | number | boolean>;
  /** lines get this prefix of the ids removed: noisy copy of the meeting (no punctuation) */
  noisy?: boolean;
  /** run the ask entries of the script */
  asks?: boolean;
  /** memory snapshot lag after the check line, ms */
  lagMs?: number;
  /** what-if cache layout for the usage rows: role instructions right after block A, cached for 1 h */
  roleFirst?: boolean;
  /** which split the meeting is in (default dev); the held-out splits check their lock file in the child */
  split?: "dev" | "test" | "test-b";
  /** a deliberately bad model instead of the scripted replies (qa/controls.ts) */
  control?: Control;
  /** record every model call into a cassette. "mock" records the policy fake (tests); "real" the provider (owner only). `pace` > 0 runs the virtual clock at
   *  that many times real time; `capUsd` stops the meeting when the booked cost passes it. */
  record?: { cassette: string; transport: "mock" | "real"; pace?: number; capUsd?: number };
};

/** Plays one dev meeting through the engine (child process). Times out after `timeoutMs`. */
export async function runMeeting(id: string, o: WorkerOptions = {}, timeoutMs = 120_000): Promise<MeetingRun> {
  const tmp = mkdtempSync(join(tmpdir(), "wingman-v2-"));
  const out = join(tmp, "out.json");
  const p = spawn(...tsx([join(ROOT, "src", "e2e", "v2-worker.ts")]), {
    cwd: ROOT,
    env: { ...process.env, V2_MEETING: id, V2_OUT: out, V2_OPTS: JSON.stringify(o), WINGMAN_DATA_DIR: join(tmp, "data") },
  });
  let log = "";
  p.stdout.on("data", (b) => (log += b));
  p.stderr.on("data", (b) => (log += b));
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const code = await new Promise<number | null>((res) => p.on("exit", res));
  clearTimeout(timer);
  try {
    if (code !== 0) throw new Error(`worker for ${id} exited with ${code}\n${log.slice(-3000)}`);
    return JSON.parse(readFileSync(out, "utf8")) as MeetingRun;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Runs `fn` over `items` with at most `n` at a time. */
export async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        res[i] = await fn(items[i]);
      }
    }),
  );
  return res;
}

/** USD of one usage row set by role, plus calls. */
export function costByRole(rows: { role: string; usd?: number }[]): Record<string, { calls: number; usd: number }> {
  const out: Record<string, { calls: number; usd: number }> = {};
  for (const r of rows) {
    const o = (out[r.role] ??= { calls: 0, usd: 0 });
    o.calls++;
    o.usd += r.usd ?? 0;
  }
  return out;
}
