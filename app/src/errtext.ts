// One-line, safe text for an error that is going to be printed (stderr -> tray.log) or logged.
// Never pass an error object to console.error: AI SDK errors (APICallError and ProviderError.cause) carry requestBodyValues and responseBody,
// i.e. the whole prompt with the transcript, and Node prints those. This keeps the name, the HTTP status and a short message only.
/** Defence in depth: a provider error that echoes a credential must not carry it into a log. Covers Anthropic keys, auth header values and 40-hex tokens. */
export function scrubSecrets(t: string): string {
  return t
    .replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, "sk-ant-…")
    .replace(/\b(Bearer|Token|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 …")
    .replace(/\b[a-f0-9]{40}\b/gi, "…");
}

export function errText(e: unknown): string {
  if (e === null || e === undefined) return "unknown error";
  if (typeof e !== "object") return scrubSecrets(String(e).replace(/\s+/g, " ").slice(0, 300));
  const x = e as { name?: unknown; message?: unknown; statusCode?: unknown; status?: unknown; code?: unknown };
  const name = typeof x.name === "string" ? x.name : "Error";
  const status = x.statusCode ?? x.status;
  const msg = typeof x.message === "string" ? x.message : "";
  const extra = [typeof status === "number" ? `HTTP ${status}` : "", typeof x.code === "string" ? x.code : ""].filter(Boolean).join(" ");
  return `${name}${extra ? ` (${extra})` : ""}: ${scrubSecrets(msg.replace(/\s+/g, " ").slice(0, 300))}`.trim();
}

/** What goes into events.jsonl for an error: the safe one-liner plus the first few stack frames (at most `frames`, 2000 characters in all). */
export function errStack(e: unknown, frames = 4): string {
  const head = errText(e);
  const stack = typeof (e as { stack?: unknown } | null | undefined)?.stack === "string" ? (e as { stack: string }).stack : "";
  const at = stack
    .split("\n")
    .filter((l) => /^\s+at /.test(l))
    .slice(0, frames)
    .map((l) => l.trim());
  return [head, ...at].join("\n").slice(0, 2000);
}
