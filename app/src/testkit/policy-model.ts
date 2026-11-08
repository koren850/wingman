// Policy fake model: a model that answers exactly what the test says, and nothing else. It never decides by itself.
//
//   const pm = policyModel();
//   pm.reply({ role: "moment", lastLine: "l3" }, "ANS\nVALUE: 3\nSAY: Backups run nightly.", { ms: 400 });
//   pm.on({ role: "memory" }, error(529));            // the memory model is overloaded
//   pm.on({ role: "ask" }, hang());                   // no first token, until the caller aborts
//   const model = pm.model;                           // a LanguageModel for generateText / streamText
//   pm.assertPrompt({ role: "moment" }, { contains: "Memory:", maxTokens: 2000 });
//
// Rules are checked in the order they were declared; the first rule that matches serves the call (a rule with `times` stops matching after that
// many uses). A call that no rule matches throws a readable error (or returns `fallback` text when `strict: false`), so a missing rule is a loud test failure.
// Rules are plain data, so a policy can be written to a file (pm.toJSON()) and served in a child process as model "scripted:policy"
// (env WINGMAN_POLICY_FILE), for the engine e2e tests.
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModel } from "ai";
import { viewOf, estimateTokens, type PromptView, type CallOptions } from "./prompt.ts";
import type { GoldenScriptEntry } from "./golden-types.ts";

// ---- match
export type Match = {
  role?: string | string[];
  /** A line id (`[l7]`/`#l7` in the prompt), or text: a string matches when the last line equals it or contains it; a RegExp tests the line text. */
  lastLine?: string | RegExp;
  /** Substring or RegExp in the system block. */
  system?: string | RegExp;
  /** Substring or RegExp in the last user message. */
  user?: string | RegExp;
  model?: string;
  /** Only the n-th call (1-based) of this role that reaches this rule. */
  nth?: number;
};
export type MatchArg = Match | string | ((v: PromptView) => boolean);

const has = (hay: string, n: string | RegExp) => (typeof n === "string" ? hay.includes(n) : n.test(hay));
function matches(m: Match, v: PromptView): boolean {
  if (m.role !== undefined && ![m.role].flat().includes(v.role)) return false;
  if (m.model !== undefined && v.model !== m.model && !v.model.endsWith(`:${m.model}`)) return false;
  if (m.system !== undefined && !has(v.system, m.system)) return false;
  if (m.user !== undefined && !has(v.user, m.user)) return false;
  if (m.lastLine !== undefined) {
    const l = v.lastLine;
    const ok = typeof m.lastLine === "string" ? l.id === m.lastLine || l.text === m.lastLine || l.text.includes(m.lastLine) : m.lastLine.test(l.text);
    if (!ok) return false;
  }
  return true;
}

// ---- actions
export type Usage = { input: number; output: number; cacheRead?: number };
type Common = { ms?: number; usage?: Usage };
export type Action =
  | ({ kind: "reply"; text: string; chunks?: number; chunkMs?: number; injection?: boolean } & Common)
  | ({ kind: "garbage"; seed?: number } & Common)
  | ({ kind: "truncate"; n: number; text?: string } & Common)
  | ({ kind: "hang" } & Common)
  | ({ kind: "refuse" } & Common)
  | ({ kind: "error"; status: number; message?: string } & Common);

export const garbage = (o: { seed?: number } & Common = {}): Action => ({ kind: "garbage", ...o });
export const truncate = (n: number, text?: string, o: Common = {}): Action => ({ kind: "truncate", n, text, ...o });
export const hang = (): Action => ({ kind: "hang" });
export const refuse = (o: Common = {}): Action => ({ kind: "refuse", ...o });
export const error = (status: number, message?: string): Action => ({ kind: "error", status, message });
/** A normal reply that starts after `ms`. `text` defaults to the model's defaultText. */
export const slow = (ms: number, text?: string): Action => ({ kind: "reply", text: text ?? "\u0000default", ms });
/** Hostile model output: text that tries to give the app an order. Served like a reply; the code under test must treat it as plain, untrusted text. */
export const injection = (text: string, o: Common = {}): Action => ({ kind: "reply", text, injection: true, ...o });
export const replyAction = (text: string, o: Common & { chunks?: number; chunkMs?: number } = {}): Action => ({ kind: "reply", text, ...o });

type Rule = { match: MatchArg; action: Action; times?: number; used: number; hits: Map<string, number>; source: "authored" | "scripted" };
export type Served = { view: PromptView; action: Action | undefined; rule: number; at: number };

// ---- the model
const DEFAULT_TEXT = "SKIP";
const LONG_TEXT = "ANS\nVALUE: 3\nAIM: me\nSAY: This is a long answer that a test cuts off in the middle.\nWHY: sample\nMORE: one\nMORE: two";
const GARBAGE_BYTES = "\u0000\u0001{{{ ]] <<<>>> ‮� ??? ;;; ";

export type PolicyOptions = {
  /** What an unmatched call does. strict (default): throw. false: answer `fallback`. */
  strict?: boolean;
  fallback?: string;
  defaultText?: string;
  usage?: Usage;
  modelId?: string;
  /** Called for every call, after the rule is chosen (rule -1 = unmatched). */
  onCall?: (c: Served) => void;
};

export class PolicyModel {
  private rules: Rule[] = [];
  /** Every call, in order, with the rule that served it (rule -1 = unmatched). */
  readonly calls: Served[] = [];
  usage: Usage;
  readonly strict: boolean;
  private fallback?: string;
  private defaultText: string;
  readonly model: LanguageModel;
  private roleCount = new Map<string, number>();
  private onCall?: (c: Served) => void;

  constructor(o: PolicyOptions = {}) {
    this.strict = o.strict ?? true;
    this.onCall = o.onCall;
    this.fallback = o.fallback;
    this.defaultText = o.defaultText ?? DEFAULT_TEXT;
    this.usage = o.usage ?? { input: 100, output: 5 };
    const modelId = o.modelId ?? "policy";
    this.model = new MockLanguageModelV4({
      provider: "policy",
      modelId,
      doGenerate: async (c: unknown) => this.generate(modelId, c as CallOptions & { abortSignal?: AbortSignal }),
      doStream: async (c: unknown) => this.stream(modelId, c as CallOptions & { abortSignal?: AbortSignal }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the mock's result types are stricter than the plain parts used here
    } as any) as unknown as LanguageModel;
  }

  // ---- declaring rules
  /** Adds a rule. `times`: serve at most that many calls. */
  on(match: MatchArg, action: Action, o: { times?: number } = {}): this {
    this.rules.push({ match, action, times: o.times, used: 0, hits: new Map(), source: "authored" });
    return this;
  }
  /** reply(match, text, {ms}): answer `text` after `ms` (time to the first token). `chunks`: split the text into that many deltas, `chunkMs` apart. */
  reply(match: MatchArg, text: string, o: Common & { chunks?: number; chunkMs?: number; times?: number } = {}): this {
    const { times, ...rest } = o;
    return this.on(match, replyAction(text, rest), { times });
  }
  garbage(match: MatchArg, o?: Parameters<typeof garbage>[0]) {
    return this.on(match, garbage(o));
  }
  truncate(match: MatchArg, n: number, text?: string) {
    return this.on(match, truncate(n, text));
  }
  hang(match: MatchArg) {
    return this.on(match, hang());
  }
  refuse(match: MatchArg) {
    return this.on(match, refuse());
  }
  error(match: MatchArg, status: number, message?: string) {
    return this.on(match, error(status, message));
  }
  slow(match: MatchArg, ms: number, text?: string) {
    return this.on(match, slow(ms, text));
  }
  injection(match: MatchArg, text: string) {
    return this.on(match, injection(text));
  }
  /** Serves golden.script entries: each answers the given role when the last line of the prompt is `whenLastLine` (a line id, or text). */
  serve(script: GoldenScriptEntry[]): this {
    for (const e of script) {
      this.rules.push({
        match: { role: e.role, lastLine: e.whenLastLine },
        action: replyAction(e.reply, { ms: e.ms }),
        used: 0,
        hits: new Map(),
        source: "scripted",
      });
    }
    return this;
  }
  /** Sets the reported usage (tokens) for later calls. A rule's own `usage` wins. */
  setUsage(u: Usage) {
    this.usage = u;
    return this;
  }
  reset() {
    this.rules = [];
    this.calls.length = 0;
    this.roleCount.clear();
    return this;
  }

  // ---- looking at what happened
  callsFor(role: string): Served[] {
    return this.calls.filter((c) => c.view.role === role);
  }
  get unmatched(): Served[] {
    return this.calls.filter((c) => c.rule < 0);
  }
  /** Asserts on the prompt of a call (the last call that matches `which`, or the n-th with `nth`, 1-based). Throws a readable error. */
  assertPrompt(
    which: Match | { nth: number } | number,
    want: { contains?: string | RegExp | (string | RegExp)[]; notContains?: string | RegExp | (string | RegExp)[]; maxTokens?: number; minTokens?: number },
  ): PromptView {
    const nthOnly = typeof which === "object" && which.nth !== undefined && Object.keys(which).length === 1;
    const c =
      typeof which === "number"
        ? this.calls[which]
        : nthOnly
          ? this.calls[(which as { nth: number }).nth - 1]
          : this.calls.filter((x) => matches(which as Match, x.view)).at(-1);
    if (!c)
      throw new Error(
        `PolicyModel.assertPrompt: no call matches ${JSON.stringify(which)} (${this.calls.length} calls: ${this.calls.map((x) => x.view.role).join(", ") || "none"})`,
      );
    const text = c.view.system + "\n" + c.view.messages.join("\n");
    for (const n of [want.contains ?? []].flat())
      if (!has(text, n))
        throw new Error(`PolicyModel.assertPrompt: the ${c.view.role} prompt does not contain ${String(n)}\n--- prompt tail ---\n${text.slice(-600)}`);
    for (const n of [want.notContains ?? []].flat())
      if (has(text, n)) throw new Error(`PolicyModel.assertPrompt: the ${c.view.role} prompt contains ${String(n)} but should not`);
    if (want.maxTokens !== undefined && c.view.tokens > want.maxTokens)
      throw new Error(`PolicyModel.assertPrompt: the ${c.view.role} prompt is about ${c.view.tokens} tokens, over the limit of ${want.maxTokens}`);
    if (want.minTokens !== undefined && c.view.tokens < want.minTokens)
      throw new Error(`PolicyModel.assertPrompt: the ${c.view.role} prompt is about ${c.view.tokens} tokens, under ${want.minTokens}`);
    return c.view;
  }

  // ---- serialization (a policy file for a child process)
  toJSON() {
    return {
      v: 1,
      strict: this.strict,
      fallback: this.fallback,
      defaultText: this.defaultText,
      usage: this.usage,
      rules: this.rules.map((r) => {
        if (typeof r.match === "function") throw new Error("PolicyModel.toJSON: a function match cannot be written to a file");
        const m = typeof r.match === "string" ? { role: r.match } : r.match;
        const enc = (x: unknown) => (x instanceof RegExp ? { re: x.source, flags: x.flags } : x);
        return { match: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, enc(v)])), action: r.action, times: r.times };
      }),
    };
  }
  static fromJSON(j: ReturnType<PolicyModel["toJSON"]>, o: PolicyOptions = {}): PolicyModel {
    const pm = new PolicyModel({ strict: j.strict, fallback: j.fallback, defaultText: j.defaultText, usage: j.usage, ...o });
    const dec = (x: unknown) => (x && typeof x === "object" && "re" in x ? new RegExp((x as { re: string }).re, (x as { flags?: string }).flags) : x);
    for (const r of j.rules) pm.on(Object.fromEntries(Object.entries(r.match).map(([k, v]) => [k, dec(v)])) as Match, r.action as Action, { times: r.times });
    return pm;
  }

  // ---- serving
  private record(c: Served) {
    this.calls.push(c);
    this.onCall?.(c);
  }
  private pick(model: string, c: CallOptions): { view: PromptView; action?: Action; ruleIx: number } {
    const view = viewOf(model, c);
    const n = (this.roleCount.get(view.role) ?? 0) + 1;
    this.roleCount.set(view.role, n);
    for (let i = 0; i < this.rules.length; i++) {
      const r = this.rules[i];
      if (r.times !== undefined && r.used >= r.times) continue;
      const m = typeof r.match === "function" ? r.match(view) : typeof r.match === "string" ? matches({ role: r.match }, view) : matches(r.match, view);
      if (!m) continue;
      if (typeof r.match === "object" && r.match.nth !== undefined) {
        const seen = (r.hits.get(view.role) ?? 0) + 1;
        r.hits.set(view.role, seen);
        if (seen !== r.match.nth) continue;
      }
      r.used++;
      this.record({ view, action: r.action, rule: i, at: Date.now() });
      return { view, action: r.action, ruleIx: i };
    }
    this.record({ view, action: undefined, rule: -1, at: Date.now() });
    if (this.strict) {
      throw new Error(
        `PolicyModel: no rule matches this call. role=${view.role} model=${view.model} lastLine=${JSON.stringify(view.lastLine)}\n` +
          `rules: ${this.rules.map((r, i) => `#${i} ${JSON.stringify(typeof r.match === "function" ? "fn" : r.match)}`).join("; ") || "none"}`,
      );
    }
    return { view, ruleIx: -1 };
  }

  private async sleep(ms: number, signal?: AbortSignal) {
    if (ms <= 0) return;
    await new Promise<void>((res, rej) => {
      const t = setTimeout(res, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          rej(abortError());
        },
        { once: true },
      );
    });
  }

  /** The plan for one call: what text to stream, in which pieces, when, and how it finishes. */
  private async plan(model: string, c: CallOptions & { abortSignal?: AbortSignal }) {
    const { action, view } = this.pick(model, c);
    const signal = c.abortSignal;
    if (signal?.aborted) throw abortError();
    const a: Action = action ?? { kind: "reply", text: this.fallback ?? this.defaultText };
    const usage = a.usage ?? this.usage;
    const wait = async () => this.sleep(a.ms ?? 0, signal);
    const text = (t: string) => (t === "\u0000default" ? this.defaultText : t);
    switch (a.kind) {
      case "error":
        await wait();
        throw Object.assign(new Error(a.message ?? `HTTP ${a.status} (policy fake)`), {
          statusCode: a.status,
          ...(a.status === 429 ? { responseHeaders: { "retry-after": "1" } } : {}),
        });
      case "hang":
        await new Promise<void>((_, rej) =>
          signal ? (signal.aborted ? rej(abortError()) : signal.addEventListener("abort", () => rej(abortError()), { once: true })) : undefined,
        );
        throw abortError(); // unreachable without a signal: the promise above never settles
      case "refuse":
        await wait();
        return { pieces: [] as string[], gapMs: 0, usage, finish: { unified: "content-filter" as const, raw: "refusal" }, view };
      case "garbage":
        await wait();
        return { pieces: [garbageText(a.seed ?? 1)], gapMs: 0, usage, finish: { unified: "stop" as const, raw: "end_turn" }, view };
      case "truncate": {
        await wait();
        const full = text(a.text ?? LONG_TEXT);
        return { pieces: [full.slice(0, a.n)], gapMs: 0, usage, finish: { unified: "length" as const, raw: "max_tokens" }, view };
      }
      case "reply": {
        await wait();
        const full = text(a.text);
        const n = Math.max(1, Math.min(a.chunks ?? 1, full.length || 1));
        const size = Math.ceil(full.length / n);
        const pieces = n === 1 ? [full] : Array.from({ length: n }, (_, i) => full.slice(i * size, (i + 1) * size)).filter(Boolean);
        return { pieces, gapMs: a.chunkMs ?? 0, usage, finish: { unified: "stop" as const, raw: "end_turn" }, view };
      }
    }
  }

  private async generate(model: string, c: CallOptions & { abortSignal?: AbortSignal }) {
    const p = await this.plan(model, c);
    return {
      content: p.pieces.length ? [{ type: "text", text: p.pieces.join("") }] : [],
      finishReason: p.finish,
      usage: toUsage(p.usage, p.pieces.join("")),
      warnings: [],
    };
  }

  private async stream(model: string, c: CallOptions & { abortSignal?: AbortSignal }) {
    const p = await this.plan(model, c);
    const signal = c.abortSignal;
    const sleep = (ms: number) => this.sleep(ms, signal);
    const stream = new ReadableStream({
      async start(ctl) {
        try {
          ctl.enqueue({ type: "stream-start", warnings: [] });
          if (p.pieces.length) ctl.enqueue({ type: "text-start", id: "t" });
          for (let i = 0; i < p.pieces.length; i++) {
            if (i > 0) await sleep(p.gapMs);
            ctl.enqueue({ type: "text-delta", id: "t", delta: p.pieces[i] });
          }
          if (p.pieces.length) ctl.enqueue({ type: "text-end", id: "t" });
          ctl.enqueue({ type: "finish", usage: toUsage(p.usage, p.pieces.join("")), finishReason: p.finish });
          ctl.close();
        } catch (e) {
          ctl.error(e);
        }
      },
    });
    return { stream };
  }
}

export function policyModel(o: PolicyOptions = {}): PolicyModel {
  return new PolicyModel(o);
}

function abortError() {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}
/** Deterministic junk that is not valid in any Wingman protocol (control bytes, brackets, bidi marks). */
function garbageText(seed: number): string {
  let s = GARBAGE_BYTES.repeat(2);
  for (let i = 0; i < 6; i++) s += String.fromCharCode(0x20 + ((seed * 31 + i * 17) % 90));
  return s;
}
function toUsage(u: Usage, text: string) {
  const out = u.output || estimateTokens(text);
  return {
    inputTokens: { total: u.input + (u.cacheRead ?? 0), noCache: u.input, cacheRead: u.cacheRead ?? 0, cacheWrite: 0 },
    outputTokens: { total: out, text: out, reasoning: 0 },
  };
}
