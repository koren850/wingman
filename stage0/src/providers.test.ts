// Provider layer: error classification (providers/errors.ts), model refs and registry (providers/llm.ts) and
// fallback switching in runReflex (reflex.ts). The AI stream and registry are mocks: no network, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHttp, classifyLlmError, classifyFinish, classifyWsClose, classifySttError, ProviderError, POLICY, type ErrorKind } from "./providers/errors.ts";
import { parseModelRef, ModelRegistry, ConfigError, providerOptionsFor, cacheOptionsFor, withFallbacks } from "./providers/llm.ts";
import { runReflex } from "./reflex.ts";
import { loadSettings } from "./settings.ts";

const S = loadSettings({ env: {}, userFile: "/nonexistent/x.yaml" }).settings;

test("error classification table: HTTP", () => {
  const rows: [number, string, ErrorKind, boolean, boolean][] = [   // status, body, kind, retryable, switchProvider
    [401, "", "auth", false, true], [403, "", "auth", false, true], [402, "", "quota", false, true],
    [429, '{"error":{"type":"rate_limit_error"}}', "rate", true, true],
    [429, '{"error":{"type":"rate_limit_error","message":"enforced_spend_limit_reached"}}', "spend_cap", false, true],
    [429, "insufficient_quota", "quota", false, true],
    [529, '{"type":"overloaded_error"}', "overload", true, true], [500, "", "overload", true, true], [503, "", "overload", true, true],
    [400, "Your credit balance is too low", "quota", false, true], [400, "bad", "bad_request", false, false], [413, "", "bad_request", false, false],
    [404, "model not found", "unsupported", false, true], [408, "", "timeout", true, false],
  ];
  for (const [status, body, kind, retryable, sw] of rows) {
    const e = classifyHttp("anthropic", status, body);
    assert.equal(e.kind, kind, `${status} ${body}`); assert.equal(e.retryable, retryable); assert.equal(e.switchProvider, sw);
  }
  assert.equal(classifyHttp("anthropic", 429, "", { "retry-after": "3" }).extra.retryAfterMs, 3000);
});

test("error classification: AI SDK / Anthropic shapes", () => {
  const api = (o: object) => Object.assign(new Error("x"), { name: "AI_APICallError", ...o });
  assert.equal(classifyLlmError("anthropic", api({ statusCode: 401 })).kind, "auth");
  assert.equal(classifyLlmError("anthropic", api({ statusCode: 429, responseBody: '{"error":{"type":"rate_limit_error","message":"slow down"}}' })).kind, "rate");
  assert.equal(classifyLlmError("anthropic", api({ statusCode: 429, responseBody: '{"error":{"message":"enforced_spend_limit_reached"}}' })).kind, "spend_cap");
  assert.equal(classifyLlmError("anthropic", api({ statusCode: 529 })).kind, "overload");
  assert.equal(classifyLlmError("anthropic", { type: "overloaded_error", message: "Overloaded" }).kind, "overload");        // stream error part, no status
  assert.equal(classifyLlmError("anthropic", { type: "authentication_error", message: "bad key" }).kind, "auth");
  assert.equal(classifyLlmError("anthropic", Object.assign(new Error("t"), { name: "TimeoutError" })).kind, "timeout");
  assert.equal(classifyLlmError("anthropic", Object.assign(new Error("a"), { name: "AbortError" })).kind, "timeout");
  assert.equal(classifyLlmError("anthropic", Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } })).kind, "network");
  assert.equal(classifyLlmError("openai", Object.assign(new Error("m"), { name: "LoadAPIKeyError" })).kind, "auth");
  assert.equal(classifyLlmError("openai", Object.assign(new Error("m"), { name: "NoSuchModelError" })).kind, "unsupported");
  assert.equal(classifyLlmError("x", new Error("weird")).kind, "unknown");
  const pe = new ProviderError("auth", "p", "m"); assert.equal(classifyLlmError("p", pe), pe);
});

test("refusal and empty output", () => {
  assert.equal(classifyFinish("anthropic", "content-filter", "hi")?.kind, "refusal");     // AI SDK maps stop_reason refusal to content-filter
  assert.equal(classifyFinish("anthropic", "other", "")?.kind, "refusal");
  assert.equal(classifyFinish("anthropic", "stop", "BANK x"), null);
  assert.equal(classifyFinish("anthropic", "length", "partial"), null);
  assert.equal(POLICY.refusal.retryable, false);
});

test("STT close and handshake classification", () => {
  assert.equal(classifyWsClose("deepgram", undefined, "Unexpected server response: 401")?.kind, "auth");
  assert.equal(classifyWsClose("deepgram", undefined, "Unexpected server response: 402")?.kind, "quota");
  assert.equal(classifyWsClose("deepgram", undefined, "Unexpected server response: 429")?.kind, "rate");
  assert.equal(classifyWsClose("deepgram", 1000, ""), null);
  assert.equal(classifyWsClose("deepgram", 1008, "")?.kind, "bad_request");
  assert.equal(classifyWsClose("deepgram", 1011, "")?.kind, "timeout");
  assert.equal(classifyWsClose("deepgram", 1006, "")?.kind, "network");
  assert.equal(classifyWsClose("soniox", 4000, "insufficient credit balance")?.kind, "quota");
  assert.equal(classifySttError("deepgram", Object.assign(new Error("x"), { statusCode: 401 })).kind, "auth");
});

test("provider:model parsing", () => {
  assert.deepEqual(parseModelRef("anthropic:claude-haiku-5-5"), { provider: "anthropic", model: "claude-haiku-5-5" });
  assert.deepEqual(parseModelRef("OpenAI:gpt-4.1:mini"), { provider: "openai", model: "gpt-4.1:mini" });
  for (const bad of ["claude-haiku", ":x", "anthropic:", "nope:model"]) assert.throws(() => parseModelRef(bad), ConfigError, bad);
});

test("registry: missing package gives the pnpm add error; missing key gives the keys.env error; resolves with a fake package", async () => {
  const real = new ModelRegistry({ openai: "k" });
  await assert.rejects(real.resolve("openai:gpt-5-mini"), (e: any) => e instanceof ConfigError && /pnpm add @ai-sdk\/openai/.test(e.message));   // @ai-sdk/openai is not installed
  const fakeMissing = new ModelRegistry({ google: "k" }, async () => { throw Object.assign(new Error("Cannot find package '@ai-sdk/google'"), { code: "ERR_MODULE_NOT_FOUND" }); });
  await assert.rejects(fakeMissing.resolve("google:gemini-x"), /Run: pnpm add @ai-sdk\/google/);
  const importer = async () => ({ createOpenAI: ({ apiKey }: any) => (id: string) => ({ id, apiKey }) });
  await assert.rejects(new ModelRegistry({}, importer).resolve("openai:m"), /OPENAI_API_KEY is missing/);
  assert.deepEqual(await new ModelRegistry({ openai: "k" }, importer).resolve("openai:m") as any, { id: "m", apiKey: "k" });
  const installed = await new ModelRegistry({ anthropic: "k" }).resolve("anthropic:claude-haiku-5-5") as any;   // real package, no network call
  assert.ok(installed);
  assert.deepEqual(new ModelRegistry({}).capabilities("openai:x"), { cache: false, thinking: false, effort: false, streaming: true });
});

test("Anthropic-only provider options", () => {
  assert.deepEqual(providerOptionsFor("anthropic:m", { effort: "low", thinking: false }), { anthropic: { thinking: { type: "disabled" }, effort: "low" } });
  assert.deepEqual(providerOptionsFor("anthropic:m", { effort: "high", thinking: true }), { anthropic: { thinking: { type: "adaptive" }, effort: "high" } });
  assert.equal(providerOptionsFor("openai:gpt", { effort: "low", thinking: false }), undefined);
  assert.deepEqual(cacheOptionsFor("anthropic:m", "1h"), { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } });
  assert.equal(cacheOptionsFor("anthropic:m", "off"), undefined); assert.equal(cacheOptionsFor("google:g", "1h"), undefined);
});

// ---- fallback switching with mocks ----
const fakeRegistry = { resolve: async (ref: string) => ({ ref }) } as unknown as ModelRegistry;
const fakeStream = (script: Record<string, { chunks?: string[]; error?: unknown; finish?: string }>) => ((opts: any) => {
  const s = script[opts.model.ref];
  return {
    textStream: (async function* () { for (const c of s.chunks ?? []) yield c; if (s.error) { opts.onError({ error: s.error }); } })(),
    finishReason: Promise.resolve(s.finish ?? "stop"), usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }), providerMetadata: Promise.resolve({}),
  };
}) as any;
const handlers = () => {
  const log: string[] = [];
  return { log, h: { onTag: (t: any) => log.push("tag:" + t.kind), onSay: () => {}, onFacts: () => {}, onSayComplete: (s: string) => log.push("say:" + s), onDone: (i: any) => log.push("done:" + i.model) } };
};
const base = { registry: fakeRegistry, cfg: S.llm.reflex, prefix: "p", transcript: "t", question: "q", signal: new AbortController().signal };

test("fallback: auth failure on the primary moves to the next model", async () => {
  const { log, h } = handlers(); const switched: string[] = [], failed: string[] = [];
  const stream = fakeStream({ "anthropic:a": { error: { type: "authentication_error", message: "bad" } }, "openai:b": { chunks: ["ANS\nשלום\n"] } });
  const used = await runReflex({ ...base, models: ["anthropic:a", "openai:b"], h, stream, onSwitch: (f, t, e) => switched.push(`${f}>${t}:${e.kind}`), onFail: (m, e) => failed.push(`${m}:${e.kind}`) });
  assert.equal(used, "openai:b"); assert.deepEqual(switched, ["anthropic:a>openai:b:auth"]); assert.deepEqual(failed, ["anthropic:a:auth"]);
  assert.deepEqual(log, ["tag:ANS", "say:שלום", "done:openai:b"]);
});
test("fallback: 529 and spend cap switch; refusal and bad_request do not", async () => {
  for (const [err, shouldSwitch] of [[{ type: "overloaded_error" }, true], [{ statusCode: 429, responseBody: "enforced_spend_limit_reached" }, true], [{ statusCode: 400, responseBody: "bad" }, false]] as const) {
    const { h } = handlers();
    const stream = fakeStream({ "anthropic:a": { error: err }, "openai:b": { chunks: ["STALL\n"] } });
    const p = runReflex({ ...base, models: ["anthropic:a", "openai:b"], h, stream });
    if (shouldSwitch) assert.equal(await p, "openai:b"); else await assert.rejects(p, (e: any) => e.kind === "bad_request");
  }
  const { h } = handlers();
  await assert.rejects(runReflex({ ...base, models: ["anthropic:a", "openai:b"], h, stream: fakeStream({ "anthropic:a": { chunks: ["ANS\nx\n"], finish: "content-filter" }, "openai:b": { chunks: ["STALL\n"] } }) }), (e: any) => e.kind === "refusal");
});
test("fallback: never after the answer started, never on a timeout", async () => {
  const { log, h } = handlers();
  const stream = fakeStream({ "anthropic:a": { chunks: ["ANS\nחצי"], error: { type: "overloaded_error" } }, "openai:b": { chunks: ["ANS\nשני\n"] } });
  await assert.rejects(runReflex({ ...base, models: ["anthropic:a", "openai:b"], h, stream }), (e: any) => e.kind === "overload");
  assert.ok(!log.some((l) => l.includes("openai:b")));    // the second model never answered after the first had started
  await assert.rejects(withFallbacks(["a:x", "b:y"], async (r) => { if (r === "a:x") throw Object.assign(new Error("t"), { name: "TimeoutError" }); return r; }), (e: any) => e.kind === "timeout");
  assert.equal(await withFallbacks(["a:x", "b:y"], async (r) => { if (r === "a:x") throw new ConfigError("package missing"); return r; }), "b:y");   // missing package = skip to the next
});
test("reflex hard timeout throws a timeout ProviderError", async () => {
  const { h } = handlers();
  const stream = ((opts: any) => ({ textStream: (async function* () { await new Promise((r) => opts.abortSignal.addEventListener("abort", r)); })(), finishReason: Promise.resolve("stop"), usage: Promise.resolve({}), providerMetadata: Promise.resolve({}) })) as any;
  await assert.rejects(runReflex({ ...base, cfg: { ...S.llm.reflex, timeoutMs: 30 }, models: ["anthropic:a"], h, stream }), (e: any) => e.kind === "timeout");
});
