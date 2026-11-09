// LLM side of the providers layer: ModelRegistry resolves "provider:model" strings to AI SDK language models. Only @ai-sdk/anthropic is installed;
// other providers are imported on demand and give a clear "pnpm add" error when the package is missing.
import { generateText, wrapLanguageModel, type LanguageModel } from "ai";
import { KEY_VARS, type Keys, type KeyName } from "../env.ts";
import { LLM_CATALOG } from "./catalog.ts";
import { classifyLlmError, ProviderError } from "./errors.ts";
import { llmMode, cassetteFor, wrapCassette } from "./cassette.ts";

/** Bad or missing configuration (model ref, package, key). `fix` is a command or hint shown to the user. */
export class ConfigError extends Error {
  constructor(
    m: string,
    public fix?: string,
  ) {
    super(m);
    this.name = "ConfigError";
  }
}

/** How to load a provider: npm package, factory export name, and which key it needs (none for the offline double). Data lives in catalog.ts. */
export type ProviderSpec = { pkg: string; factory: string; keyVar?: string; key?: KeyName };
export const LLM_PROVIDERS: Record<string, ProviderSpec> = Object.fromEntries(
  Object.entries(LLM_CATALOG).map(([id, e]) => [id, { ...e, ...("keyVar" in e ? { key: id as KeyName } : {}) }]),
);

/** "provider:model" -> parts. Throws ConfigError for a bad format or an unknown provider. */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf(":");
  if (i < 1 || i === ref.length - 1) throw new ConfigError(`Bad model "${ref}": expected provider:model, e.g. anthropic:claude-haiku-5-5`);
  const provider = ref.slice(0, i).toLowerCase(),
    model = ref.slice(i + 1);
  if (!LLM_PROVIDERS[provider]) throw new ConfigError(`Unknown LLM provider "${provider}" in "${ref}". Known: ${Object.keys(LLM_PROVIDERS).join(", ")}`);
  return { provider, model };
}

/** What Wingman reads from a generateText result. */
export type GenerateResult = { text: string; output?: unknown; usage?: unknown; totalUsage?: unknown; providerMetadata?: unknown };
/** One non-streamed model call. `options` goes through as is; `generate` is the injected double in tests. The AI SDK's published option
 *  types do not list the `instructions` field (ai 7) yet, so the one cast for every such call lives here. */
export function generateOnce(generate: typeof generateText | undefined, options: Record<string, unknown>): Promise<GenerateResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ai 7 accepts `instructions`; its option type does not list it yet
  return (generate ?? generateText)(options as any) as unknown as Promise<GenerateResult>;
}

/** Loads a provider package; injected by tests. A package is a bag of exports (factories). */
export type Importer = (pkg: string) => Promise<Record<string, unknown>>;
type ModelFactory = (modelId: string) => LanguageModel;
const defaultImporter: Importer = (pkg) => import(pkg);

/** USD per million tokens for one model (cost estimates). */
export type Price = { inUsdPerM: number; outUsdPerM: number; cacheReadUsdPerM?: number; cacheWriteUsdPerM?: number };

/** Resolves model refs to AI SDK models. Provider factories are imported lazily and cached per provider. */
export class ModelRegistry {
  private factories = new Map<string, ModelFactory>();
  constructor(
    private keys: Keys,
    private importer: Importer = defaultImporter,
  ) {}

  /**
   * Throws ConfigError when the package or API key is missing. The key is read when the factory is first built.
   * `role` (moment, memory, ask...) names what the call is for. It only matters to the test seams: the cassette key and the policy fake model use it.
   * WINGMAN_LLM_MODE=replay answers from the cassette and needs no package and no key; =record calls the real model and writes the cassette (see cassette.ts).
   */
  async resolve(ref: string, role?: string): Promise<LanguageModel> {
    const { provider, model } = parseModelRef(ref);
    const mode = llmMode();
    if (mode === "replay" && provider !== "scripted") return wrapCassette({ mode, cassette: cassetteFor(), ref, role });
    const real = await this.resolveReal(ref, provider, model);
    if (mode === "record" && provider !== "scripted") return wrapCassette({ mode, cassette: cassetteFor(), ref, role, inner: real });
    if (role && provider === "scripted") {
      return wrapLanguageModel({
        model: real as never,
        middleware: { transformParams: async ({ params }) => ({ ...params, providerOptions: { ...params.providerOptions, wingman: { role } } }) },
      });
    }
    return real;
  }

  private async resolveReal(ref: string, provider: string, model: string): Promise<LanguageModel> {
    const spec = LLM_PROVIDERS[provider];
    let make = this.factories.get(provider);
    if (!make) {
      let mod: Record<string, unknown>;
      try {
        mod = await this.importer(spec.pkg);
      } catch (e) {
        if (
          /Cannot find (module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(
            String((e as { code?: unknown } | undefined)?.code ?? "") + String((e as Error)?.message),
          )
        ) {
          throw new ConfigError(`package missing: ${spec.pkg} (needed for "${ref}"). Run: pnpm add ${spec.pkg}`, `pnpm add ${spec.pkg}`);
        }
        throw e;
      }
      const factory = mod[spec.factory];
      if (typeof factory !== "function") throw new ConfigError(`${spec.pkg} has no ${spec.factory} export (unexpected version)`);
      const apiKey = spec.key ? this.keys[spec.key] : "none";
      if (!apiKey) throw new ConfigError(`${KEY_VARS[spec.key!]} is missing for "${ref}"`, `add it in Wingman Settings → Keys (or run: pnpm keys)`);
      make = (factory as (o: { apiKey: string }) => ModelFactory)({ apiKey });
      this.factories.set(provider, make);
    }
    return make(model) as LanguageModel;
  }

  /** What the provider supports; Anthropic-only options must not be sent to anyone else. */
  capabilities(ref: string) {
    const { provider } = parseModelRef(ref);
    return { cache: provider === "anthropic", thinking: provider === "anthropic", effort: provider === "anthropic", streaming: true as const };
  }
}

/** Anthropic-only providerOptions (thinking off/adaptive, effort). Empty for every other provider. */
export function providerOptionsFor(ref: string, cfg: { effort: "low" | "medium" | "high"; thinking: boolean }) {
  if (parseModelRef(ref).provider !== "anthropic") return undefined;
  return { anthropic: { thinking: cfg.thinking ? { type: "adaptive" as const } : { type: "disabled" as const }, effort: cfg.effort } };
}
/**
 * Sampling temperature for the classifier-style calls (reflex, classifier, self-check, frame, topic): 0 where the provider accepts it, so a
 * rerun of the same call gives the same answer. Anthropic is the exception on purpose: current Claude models (Haiku 5.5 included) reject
 * non-default sampling parameters with a 400, and from 2026-10-21 any `temperature` on a Messages request does. There the reply is kept
 * steady by the strict line protocol, the small maxOutputTokens and the parser instead, so this returns undefined and the field is omitted.
 */
export function temperatureFor(ref: string): number | undefined {
  return parseModelRef(ref).provider === "anthropic" ? undefined : 0;
}
/** Anthropic prompt-cache marker for the system block; undefined elsewhere or when cache = off. */
export function cacheOptionsFor(ref: string, cache: "off" | "5m" | "1h") {
  if (cache === "off" || parseModelRef(ref).provider !== "anthropic") return undefined;
  return { anthropic: { cacheControl: { type: "ephemeral" as const, ttl: cache } } };
}

/**
 * Try models in order. Moves on only when the error says switchProvider (and is not a timeout), and never after
 * the answer has started streaming (`started()`): a half answer must not be followed by a second model's answer.
 */
export async function withFallbacks<T>(
  refs: string[],
  attempt: (ref: string, index: number) => Promise<T>,
  o: { started?: () => boolean; onSwitch?: (from: string, to: string, err: ProviderError) => void; onFail?: (ref: string, err: ProviderError) => void } = {},
): Promise<T> {
  let last: ProviderError | undefined;
  for (let i = 0; i < refs.length; i++) {
    try {
      return await attempt(refs[i], i);
    } catch (e) {
      const err =
        e instanceof ConfigError
          ? new ProviderError("unsupported", refs[i].split(":")[0], e.message, { cause: e })
          : classifyLlmError(refs[i].split(":")[0], e);
      last = err;
      o.onFail?.(refs[i], err);
      if (!err.switchProvider || err.kind === "timeout" || o.started?.() || i === refs.length - 1) throw err;
      o.onSwitch?.(refs[i], refs[i + 1], err);
    }
  }
  throw last!;
}

/**
 * Opens the connection to the model before the first question, so that question does not pay for the package load, DNS, TCP and TLS.
 * Measured on real calls: the first request took 1.3 to 2.5 s to its first token, later ones 0.8 to 0.9 s. One request with one output token,
 * so the cost is a fraction of a cent. Only in live mode and for a real provider: a cassette or a scripted model has no connection to open.
 * Never throws; returns the time in ms, or why it was skipped or failed.
 */
export async function warmUp(
  registry: ModelRegistry,
  ref: string,
  o: { generate?: typeof generateText; mode?: string; timeoutMs?: number } = {},
): Promise<{ ms: number } | { skipped: string } | { error: string }> {
  const { provider } = parseModelRef(ref);
  if (provider === "script" || provider === "scripted") return { skipped: "offline model" };
  if ((o.mode ?? llmMode()) !== "live") return { skipped: "not live" };
  const t0 = Date.now();
  try {
    const model = await registry.resolve(ref, "warm");
    await generateOnce(o.generate, {
      model,
      maxOutputTokens: 1,
      maxRetries: 0,
      temperature: temperatureFor(ref),
      abortSignal: AbortSignal.timeout(o.timeoutMs ?? 8000),
      prompt: "ok",
    });
    return { ms: Date.now() - t0 };
  } catch (e) {
    return { error: (e as Error)?.message ?? String(e) };
  }
}
