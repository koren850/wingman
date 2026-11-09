"use strict";
// The one cheap call that proves a pasted key works, for the setup window. CommonJS (the Electron main process and the tests share it).
//   Deepgram   GET /v1/projects (free), then the project's balance (free). A key that works but has no money left is "nocredit".
//   Anthropic  POST /v1/messages with one word and max_tokens 1 on the cheapest model (about 0.00002 dollars). The free model-list call cannot see a missing balance.
// The result is one word and never contains the key: "ok" | "invalid" | "nocredit" | "unavailable" | "network".
//   invalid      the service said the key is wrong or switched off (401, 403)
//   nocredit     the key is right but the account has no credit (402, or Anthropic's "credit balance is too low", or Deepgram balance at 0)
//   unavailable  the service answered with an error on its side (500 and up)
//   network      nothing came back (offline, blocked, timed out)
// A rate limit (429) means the key was accepted, so it counts as ok. The fetch function is injected: tests never reach a real service.
const CHECK_MODEL = "claude-haiku-5-5";
const TIMEOUT_MS = 10000;

/** Printable ASCII only: a hand-edited value cannot inject a header. */
const headerSafe = (k) => typeof k === "string" && /^[\x21-\x7e]+$/.test(k);

async function json(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
const send = (f, url, init) => f(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), ...init });

/** Status codes that mean the same for both services. Returns a result word, or "" when the caller must look at the body. */
function byStatus(s) {
  if (s >= 200 && s < 300) return "ok";
  if (s === 401 || s === 403) return "invalid";
  if (s === 402) return "nocredit";
  if (s === 429) return "ok";
  if (s >= 500) return "unavailable";
  return "";
}

async function checkDeepgram(key, f) {
  const auth = { headers: { Authorization: `Token ${key}` } };
  const res = await send(f, "https://api.deepgram.com/v1/projects", { method: "GET", ...auth });
  // 403: the key is known but may not list projects (a key made with fewer rights). It can still transcribe, and the readiness check opens a real socket.
  if (res.status === 403) return "ok";
  const word = byStatus(res.status);
  if (word !== "ok" || res.status === 429) return word || "unavailable";
  const body = await json(res);
  const id = body && Array.isArray(body.projects) && body.projects[0] && body.projects[0].project_id;
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(id)) return "ok";
  try {
    const b = await send(f, `https://api.deepgram.com/v1/projects/${id}/balances`, { method: "GET", ...auth });
    if (b.status !== 200) return "ok"; // a key without the right to read balances still works
    const list = ((await json(b)) || {}).balances;
    if (Array.isArray(list) && list.length && list.every((x) => !(Number(x && x.amount) > 0))) return "nocredit";
  } catch {
    /* the balance is a bonus: the key itself was accepted */
  }
  return "ok";
}

async function checkAnthropic(key, f) {
  const res = await send(f, "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: CHECK_MODEL, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  });
  const word = byStatus(res.status);
  if (word) return word;
  const body = await json(res);
  const msg = String((body && body.error && body.error.message) || "");
  if (res.status === 400 && /credit balance|billing/i.test(msg)) return "nocredit";
  return "ok"; // 400/404 for another reason: the request was understood and the key was accepted, so the key is fine
}

/** @param {string} provider "deepgram" | "anthropic" @param {string} key @param {typeof fetch} [fetchFn] */
async function checkKey(provider, key, fetchFn = globalThis.fetch) {
  if ((provider !== "deepgram" && provider !== "anthropic") || !headerSafe(key)) return "invalid";
  try {
    return provider === "deepgram" ? await checkDeepgram(key, fetchFn) : await checkAnthropic(key, fetchFn);
  } catch {
    return "network";
  }
}

module.exports = { checkKey, CHECK_MODEL };
