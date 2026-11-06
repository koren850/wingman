// One-line, safe text for an error that is going to be printed (stderr -> tray.log) or logged.
// Never pass an error object to console.error: AI SDK errors (APICallError and ProviderError.cause) carry requestBodyValues and responseBody,
// i.e. the whole prompt with the transcript, and Node prints those. This keeps the name, the HTTP status and a short message only.
export function errText(e: unknown): string {
  if (e === null || e === undefined) return "unknown error";
  if (typeof e !== "object") return String(e).replace(/\s+/g, " ").slice(0, 300);
  const x = e as { name?: unknown; message?: unknown; statusCode?: unknown; status?: unknown; code?: unknown };
  const name = typeof x.name === "string" ? x.name : "Error";
  const status = x.statusCode ?? x.status;
  const msg = typeof x.message === "string" ? x.message : "";
  const extra = [typeof status === "number" ? `HTTP ${status}` : "", typeof x.code === "string" ? x.code : ""].filter(Boolean).join(" ");
  return `${name}${extra ? ` (${extra})` : ""}: ${msg.replace(/\s+/g, " ").slice(0, 300)}`.trim();
}
