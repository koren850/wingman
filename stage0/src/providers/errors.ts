// One error model for every provider (STT and LLM). Decides: retry here, switch provider, or stop.
// Used by providers/llm.ts (withFallbacks), providers/stt/* (adapters, SttChannel) and src/reflex.ts. Classifiers never throw.
export type ErrorKind = "auth" | "quota" | "spend_cap" | "rate" | "overload" | "network" | "timeout" | "bad_request" | "refusal" | "unsupported" | "unknown";

/** retryable: the same request may work later. switchProvider: moving to a fallback is a sensible response. */
export const POLICY: Record<ErrorKind, { retryable: boolean; switchProvider: boolean }> = {
  auth: { retryable: false, switchProvider: true },
  quota: { retryable: false, switchProvider: true },
  spend_cap: { retryable: false, switchProvider: true }, // monthly cap: do not retry until the cap resets
  rate: { retryable: true, switchProvider: true },
  overload: { retryable: true, switchProvider: true },
  network: { retryable: true, switchProvider: true },
  timeout: { retryable: true, switchProvider: false }, // never fall back mid-answer: the stall line is already up
  bad_request: { retryable: false, switchProvider: false }, // our request is wrong; another vendor will not fix it
  refusal: { retryable: false, switchProvider: false }, // never retry the same text
  unsupported: { retryable: false, switchProvider: true }, // unknown model / feature missing
  unknown: { retryable: false, switchProvider: false },
};

/** Normalized provider failure. `retryable` / `switchProvider` come from POLICY[kind]; `extra` keeps HTTP status, Retry-After and the original cause. */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly switchProvider: boolean;
  constructor(
    public kind: ErrorKind,
    public provider: string,
    message: string,
    public extra: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.retryable = POLICY[kind].retryable;
    this.switchProvider = POLICY[kind].switchProvider;
  }
  get status() {
    return this.extra.status;
  }
}
/** Type guard for ProviderError. */
export const isProviderError = (e: unknown): e is ProviderError => e instanceof ProviderError;

/** HTTP status + body (+ headers) to a kind. Anthropic: 429 with enforced_spend_limit_reached is a monthly cap, 529 is global overload. */
export function classifyHttp(provider: string, status: number, body = "", headers: Record<string, string | undefined> = {}): ProviderError {
  const b = body.toLowerCase();
  const ra = Number(headers["retry-after"]);
  const retryAfterMs = Number.isFinite(ra) ? ra * 1000 : undefined;
  const mk = (kind: ErrorKind) =>
    new ProviderError(kind, provider, `${provider}: ${kind} (HTTP ${status})${body ? ` ${body.slice(0, 160)}` : ""}`, { status, retryAfterMs });
  if (status === 401 || status === 403) return mk("auth");
  if (status === 402) return mk("quota");
  if (status === 429)
    return mk(/enforced_spend_limit_reached|spend limit|usage limit/.test(b) ? "spend_cap" : /insufficient_quota|credit|billing/.test(b) ? "quota" : "rate");
  if (status === 408 || status === 504) return mk("timeout");
  if (status === 404) return mk("unsupported");
  if (status === 400 && /credit balance is too low|insufficient/.test(b)) return mk("quota");
  if (status === 400 || status === 413 || status === 422) return mk("bad_request");
  if (status === 529 || status === 503 || status === 502 || status >= 500) return mk("overload");
  return mk("unknown");
}

// Node/undici network error codes and messages. Matched against both err.code and err.message.
const NET_CODES = /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR|fetch failed|socket hang up|network/i;
// Anthropic error body "type" -> the HTTP status it stands for (used when a stream error has a body but no status).
const ANTHROPIC_TYPES: Record<string, number> = {
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  overloaded_error: 529,
  api_error: 500,
  invalid_request_error: 400,
};

/** The fields read off an error of unknown origin (AI SDK, fetch, ws). All optional: nothing about a thrown value can be trusted. */
interface ErrorFields {
  name?: string;
  message?: string;
  reason?: string;
  code?: unknown;
  type?: string;
  status?: number;
  statusCode?: number;
  isRetryable?: boolean;
  responseBody?: unknown;
  responseHeaders?: Record<string, string>;
  cause?: unknown;
  data?: { type?: string; error?: { type?: string } };
}
const fieldsOf = (e: unknown): ErrorFields | undefined => (e && typeof e === "object" ? (e as ErrorFields) : undefined);

/** AI SDK / Anthropic / any fetch-based LLM error (APICallError, stream error parts, aborts, network). */
export function classifyLlmError(provider: string, e: unknown): ProviderError {
  if (isProviderError(e)) return e;
  const x = fieldsOf(e);
  const name = String(x?.name ?? ""),
    msg = String(x?.message ?? e);
  if (name === "AbortError" || name === "TimeoutError" || x?.code === "ABORT_ERR")
    return new ProviderError("timeout", provider, `${provider}: timeout`, { cause: e });
  if (name === "LoadAPIKeyError" || /api key is missing|API key.*(not set|missing)/i.test(msg))
    return new ProviderError("auth", provider, `${provider}: API key missing`, { cause: e });
  if (name === "NoSuchModelError") return new ProviderError("unsupported", provider, `${provider}: unknown model (${msg})`, { cause: e });
  if (name === "UnsupportedFunctionalityError") return new ProviderError("unsupported", provider, `${provider}: ${msg}`, { cause: e });
  if (name === "InvalidPromptError") return new ProviderError("bad_request", provider, `${provider}: ${msg}`, { cause: e });
  // Nested error bodies: AI SDK keeps the raw JSON in responseBody / data; Anthropic nests {error:{type,message}}.
  const bodyText = typeof x?.responseBody === "string" ? x.responseBody : x?.data ? safeJson(x.data) : "";
  const type = x?.type ?? x?.data?.error?.type ?? x?.data?.type ?? bodyText.match(/"type"\s*:\s*"(\w+_error|\w+_reached)"/)?.[1];
  const status: number | undefined = x?.statusCode ?? x?.status ?? (type ? ANTHROPIC_TYPES[type] : undefined);
  if (typeof status === "number") {
    const c = classifyHttp(provider, status, bodyText || msg, x?.responseHeaders ?? {});
    return c.kind === "unknown" && x?.isRetryable ? new ProviderError("overload", provider, c.message, { status, cause: e }) : withCause(c, e);
  }
  if (x?.cause && x.cause !== e) {
    const inner = classifyLlmError(provider, x.cause);
    if (inner.kind !== "unknown") return inner;
  }
  if (NET_CODES.test(String(x?.code ?? "")) || NET_CODES.test(msg))
    return new ProviderError("network", provider, `${provider}: network error (${msg.slice(0, 120)})`, { cause: e });
  return new ProviderError("unknown", provider, `${provider}: ${msg.slice(0, 200)}`, { cause: e });
}
const withCause = (p: ProviderError, cause: unknown) => {
  p.extra.cause = cause;
  return p;
};
const safeJson = (v: unknown) => {
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
};

/** Refusal / empty answer from a finished stream. AI SDK maps Anthropic stop_reason "refusal" to finishReason "content-filter". */
export function classifyFinish(provider: string, finishReason: string | undefined, text: string): ProviderError | null {
  if (finishReason === "content-filter") return new ProviderError("refusal", provider, `${provider}: refusal (content-filter)`);
  if (!text.trim() && finishReason !== "stop") return new ProviderError("refusal", provider, `${provider}: empty output (finishReason ${finishReason ?? "?"})`);
  return null;
}

/**
 * WebSocket close / socket error for STT. Works mainly off the reason text because exact vendor codes are not all documented
 * (Deepgram: 1008 = bad audio payload, 1011 = no audio for ~10 s; handshake 401/402/429 arrive as "Unexpected server response: 401").
 */
export function classifyWsClose(provider: string, code: number | undefined, reason = ""): ProviderError | null {
  const r = reason.toLowerCase();
  const http = r.match(/unexpected server response:?\s*(\d{3})/) ?? r.match(/\b(?:http|status|error_code)\D{0,3}(\d{3})\b/);
  if (http) return classifyHttp(provider, Number(http[1]), reason);
  if (/invalid credentials|unauthori[sz]ed|forbidden|invalid.*(key|token)/.test(r))
    return new ProviderError("auth", provider, `${provider}: key rejected (${reason})`, { status: 401 });
  if (/insufficient|credit|balance|payment|budget/.test(r))
    return new ProviderError("quota", provider, `${provider}: credit finished (${reason})`, { status: 402 });
  if (/too many|concurren|rate limit/.test(r)) return new ProviderError("rate", provider, `${provider}: rate/concurrency limit (${reason})`, { status: 429 });
  if (code === 1000) return null; // normal close
  if (code === 1008) return new ProviderError("bad_request", provider, `${provider}: bad audio payload or policy violation (1008)`);
  if (code === 1011 || code === 1001) return new ProviderError("timeout", provider, `${provider}: closed, no audio for a while (${code})`);
  if (code === 1013 || code === 1012 || /unavailable|overload/.test(r))
    return new ProviderError("overload", provider, `${provider}: service unavailable (${code ?? reason})`);
  return new ProviderError("network", provider, `${provider}: connection closed (${code ?? "?"} ${reason})`.trim());
}

/** Short user-facing text per kind, e.g. "deepgram: key rejected" (terminal and status strip). */
export function describe(e: ProviderError): string {
  const t: Record<ErrorKind, string> = {
    auth: "key rejected",
    quota: "credit finished",
    spend_cap: "spend limit reached",
    rate: "rate limited",
    overload: "overloaded",
    network: "network problem",
    timeout: "timed out",
    bad_request: "bad request",
    refusal: "refused / empty answer",
    unsupported: "model or feature not available",
    unknown: "unknown error",
  };
  return `${e.provider}: ${t[e.kind]}`;
}

/** Any STT error (SDK error, handshake failure, close event) to a ProviderError. */
export function classifySttError(provider: string, e: unknown): ProviderError {
  if (isProviderError(e)) return e;
  const x = fieldsOf(e),
    msg = String(x?.message ?? x?.reason ?? e);
  const http = typeof x?.statusCode === "number" ? x.statusCode : typeof x?.status === "number" ? x.status : undefined;
  if (http !== undefined) return classifyHttp(provider, http, msg);
  return classifyWsClose(provider, typeof x?.code === "number" ? x.code : undefined, msg) ?? new ProviderError("unknown", provider, `${provider}: ${msg}`);
}
