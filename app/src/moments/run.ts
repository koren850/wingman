// One streamed moment call (role moment or observer): the context from buildContext goes to the model, the reply is read as it streams
// (parse.ts), and the caller sees every step through the handlers. Pure of engine state: the registry, the clock (timers) and the abort
// signal are passed in or global, so the policy fake model and the virtual clock can drive it in a test.
// Failure model is the one of reflex.ts runOne: abort by the caller returns quietly, the hard timeout and stream errors become a ProviderError,
// and fallbacks are tried in order until the first tag was seen (a half answer is never followed by a second model's answer).
import { streamText } from "ai";
import type { LanguageModel } from "ai";
import type { ContextOutput } from "../context/build.ts";
import { cacheOptionsFor, providerOptionsFor, temperatureFor, withFallbacks } from "../providers/llm.ts";
import { classifyFinish, classifyLlmError, ProviderError } from "../providers/errors.ts";
import { parseMomentStream, type ParsedMoment } from "./parse.ts";
import type { Moment, SurvivedRow } from "./types.ts";

export type MomentRole = "moment" | "observer";
export type MomentRunCfg = {
  timeoutMs: number;
  maxTokens: number;
  maxRetries: number;
  effort: "low" | "medium" | "high";
  thinking: boolean;
  /** cache mode of the Anthropic prompt cache for the shared block; the memory block always uses the 5 minute marker */
  cache: "off" | "5m" | "1h";
};
export type MomentDone = {
  moment: Moment;
  errors: SurvivedRow[];
  usage: unknown;
  providerMetadata: unknown;
  text: string;
  model: string;
  /** The provider stopped at the token limit: the last line may be cut. */
  truncated: boolean;
};
export type MomentRunHandlers = {
  /** After every chunk, with what the parser can read so far. The caller decides when it has enough to show a card. */
  onPartial(p: ParsedMoment, model: string): void;
  /** The stream ended cleanly. `moment` is the validated reply (SKIP plus errors when the reply was bad). */
  onDone(d: MomentDone): void;
  /** A reply the caller aborted: the provider may still have billed it. Best effort, never awaited. */
  onAbortedUsage?(info: { usage: unknown; providerMetadata: unknown; model: string }): void;
};
export type MomentRun = {
  registry: { resolve(ref: string, role?: string): Promise<LanguageModel> };
  models: string[];
  role: MomentRole;
  ctx: Pick<ContextOutput, "system" | "messages">;
  cfg: MomentRunCfg;
  signal: AbortSignal;
  h: MomentRunHandlers;
  maxTokens?: number;
  onSwitch?: (from: string, to: string, err: ProviderError) => void;
  onFail?: (model: string, err: ProviderError) => void;
  /** An attempt that was replaced after waiting at least half of timeoutMs for its first token. */
  onHung?: (model: string, err: ProviderError) => void;
  /** test hook: replaces streamText */
  stream?: typeof streamText;
};

/** How long to wait for the SDK's usage after an abort before giving up. */
export const ABORT_USAGE_WAIT_MS = 300;

/** Tries `models` in order. Resolves with the model that answered; throws a ProviderError. */
export async function runMoment(o: MomentRun): Promise<string> {
  let started = false;
  const h: MomentRunHandlers = {
    ...o.h,
    onPartial: (p, m) => {
      if (p.tag) started = true;
      o.h.onPartial(p, m);
    },
  };
  return withFallbacks(o.models, (ref) => runOne(o, ref, h), { started: () => started, onSwitch: o.onSwitch, onFail: o.onFail });
}

/** The system blocks as AI SDK instructions: shared block (cache 1 h), memory block (cache 5 min), role block (no cache). Non-Anthropic models get no cache fields. */
export function instructionsFor(ref: string, ctx: Pick<ContextOutput, "system">, cache: MomentRunCfg["cache"]) {
  return ctx.system.map((b) => {
    const mode = b.cache === "1h" ? cache : b.cache === "5m" ? (cache === "off" ? "off" : "5m") : "off";
    const po = mode === "off" ? undefined : cacheOptionsFor(ref, mode);
    return { role: "system" as const, content: b.text, ...(po ? { providerOptions: po } : {}) };
  });
}

function bookAborted(result: { usage: PromiseLike<unknown>; providerMetadata: PromiseLike<unknown> }, ref: string, h: MomentRunHandlers): void {
  if (!h.onAbortedUsage) return;
  const wait = new Promise<undefined>((r) => {
    const id = setTimeout(r, ABORT_USAGE_WAIT_MS);
    (id as unknown as { unref?: () => void }).unref?.();
  });
  void Promise.race([Promise.all([result.usage, result.providerMetadata]), wait])
    .then((v) => {
      if (v) h.onAbortedUsage?.({ usage: v[0], providerMetadata: v[1], model: ref });
    })
    .catch(() => {});
}

async function runOne(o: MomentRun, ref: string, h: MomentRunHandlers): Promise<string> {
  const provider = ref.split(":")[0];
  const model = await o.registry.resolve(ref, o.role);
  const timeout = AbortSignal.timeout(o.cfg.timeoutMs);
  const signal = AbortSignal.any([o.signal, timeout]);
  const t0 = Date.now();
  let gotDelta = false;
  const reportIfHung = () => {
    const waited = Date.now() - t0;
    if (!gotDelta && waited >= o.cfg.timeoutMs / 2)
      o.onHung?.(ref, new ProviderError("timeout", provider, `${provider}: no first token after ${waited} ms (replaced by the next question)`));
  };
  let streamError: unknown;
  const result = (o.stream ?? streamText)({
    model,
    maxOutputTokens: o.maxTokens ?? o.cfg.maxTokens,
    maxRetries: o.cfg.maxRetries,
    abortSignal: signal,
    providerOptions: { ...providerOptionsFor(ref, o.cfg), wingman: { role: o.role } },
    temperature: temperatureFor(ref),
    onError: ({ error }: { error: unknown }) => {
      streamError = error;
    },
    instructions: instructionsFor(ref, o.ctx, o.cfg.cache),
    messages: o.ctx.messages,
  } as never);

  let buf = "";
  const STOP = Symbol("stop");
  const stopped = new Promise<typeof STOP>((res) => (signal.aborted ? res(STOP) : signal.addEventListener("abort", () => res(STOP), { once: true })));
  const it = result.textStream[Symbol.asyncIterator]();
  try {
    for (;;) {
      const n = await Promise.race([it.next(), stopped]);
      if (n === STOP) {
        void Promise.resolve(it.return?.()).catch(() => {});
        break;
      }
      if (n.done) break;
      gotDelta = true;
      if (o.signal.aborted) {
        bookAborted(result, ref, h);
        return ref;
      }
      buf += n.value;
      h.onPartial(parseMomentStream(buf, false), ref);
    }
  } catch (e) {
    if (!o.signal.aborted) streamError ??= e;
  }
  if (o.signal.aborted) {
    reportIfHung();
    bookAborted(result, ref, h);
    return ref;
  }
  if (timeout.aborted) throw new ProviderError("timeout", provider, `${provider}: no complete answer in ${o.cfg.timeoutMs} ms`);
  if (streamError) throw classifyLlmError(provider, streamError);
  const finish = await Promise.resolve(result.finishReason).catch(() => undefined);
  const bad = classifyFinish(provider, finish, buf);
  if (bad) throw bad;
  const fin = parseMomentStream(buf, true);
  if (o.signal.aborted) return ref;
  h.onDone({
    moment: fin.moment!,
    errors: fin.errors,
    usage: await result.usage,
    providerMetadata: await result.providerMetadata,
    text: buf,
    model: ref,
    truncated: finish === "length",
  });
  return ref;
}
