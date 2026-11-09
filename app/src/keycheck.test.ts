// The setup key check: one cheap call per key, with a fake fetch. Every outcome has one result word and the key never appears in it.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkKey } from "./keychain.ts";

const KEY = "sk-ant-TESTONLY0123456789abcdefghijkl9F2a";
const DG = "dgTESTONLY0123456789abcdefABCDEF1234Zz";
type Reply = { status: number; body?: unknown } | Error;
/** A fake fetch: replies by URL; records every request. */
function fake(replies: Record<string, Reply>) {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const key = Object.keys(replies).find((k) => url.includes(k));
    const r = key ? replies[key] : { status: 404 };
    if (r instanceof Error) throw r;
    return { status: r.status, json: async () => r.body ?? {} };
  }) as unknown as typeof fetch;
  return { f, seen };
}
const msgs = "https://api.anthropic.com/v1/messages";

test("Anthropic: 200 is ok and the request is one word on the cheap model with max_tokens 1", async () => {
  const t = fake({ [msgs]: { status: 200 } });
  assert.equal(await checkKey("anthropic", KEY, t.f), "ok");
  assert.equal(t.seen.length, 1);
  const body = JSON.parse(String(t.seen[0].init.body));
  assert.equal(body.max_tokens, 1);
  assert.equal(body.model, "claude-haiku-5-5");
  assert.equal((t.seen[0].init.headers as Record<string, string>)["x-api-key"], KEY);
  assert.ok(!t.seen[0].url.includes(KEY), "the key is never in the address");
});

test("Anthropic: 401 and 403 are invalid; 402 and the low-balance message are nocredit; 429 means the key works", async () => {
  assert.equal(await checkKey("anthropic", KEY, fake({ [msgs]: { status: 401 } }).f), "invalid");
  assert.equal(await checkKey("anthropic", KEY, fake({ [msgs]: { status: 403 } }).f), "invalid");
  assert.equal(await checkKey("anthropic", KEY, fake({ [msgs]: { status: 402 } }).f), "nocredit");
  const low = { status: 400, body: { error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } } };
  assert.equal(await checkKey("anthropic", KEY, fake({ [msgs]: low }).f), "nocredit");
  assert.equal(await checkKey("anthropic", KEY, fake({ [msgs]: { status: 429 } }).f), "ok");
  assert.equal(await checkKey("anthropic", KEY, fake({ [msgs]: { status: 400, body: { error: { message: "something else" } } } }).f), "ok");
});

test("Anthropic: a service error is unavailable; no connection and a timeout are network", async () => {
  assert.equal(await checkKey("anthropic", KEY, fake({ [msgs]: { status: 529 } }).f), "unavailable");
  assert.equal(await checkKey("anthropic", KEY, fake({ [msgs]: { status: 500 } }).f), "unavailable");
  assert.equal(await checkKey("anthropic", KEY, fake({ [msgs]: new TypeError("fetch failed") }).f), "network");
  assert.equal(await checkKey("anthropic", KEY, fake({ [msgs]: new DOMException("The operation was aborted", "TimeoutError") }).f), "network");
});

const proj = "https://api.deepgram.com/v1/projects";
test("Deepgram: a good key with a balance is ok; the balance is read from the first project", async () => {
  const t = fake({
    "/balances": { status: 200, body: { balances: [{ amount: 199.5 }] } },
    [proj]: { status: 200, body: { projects: [{ project_id: "abcd1234-ef56" }] } },
  });
  assert.equal(await checkKey("deepgram", DG, t.f), "ok");
  assert.ok(t.seen[1].url.endsWith("/v1/projects/abcd1234-ef56/balances"));
  assert.equal((t.seen[0].init.headers as Record<string, string>).Authorization, `Token ${DG}`);
});

test("Deepgram: balance 0 is nocredit; a key that may not read balances, or an empty list, still counts as ok", async () => {
  const p = { status: 200, body: { projects: [{ project_id: "abcd1234-ef56" }] } };
  assert.equal(await checkKey("deepgram", DG, fake({ "/balances": { status: 200, body: { balances: [{ amount: 0 }] } }, [proj]: p }).f), "nocredit");
  assert.equal(await checkKey("deepgram", DG, fake({ "/balances": { status: 403 }, [proj]: p }).f), "ok");
  assert.equal(await checkKey("deepgram", DG, fake({ "/balances": { status: 200, body: { balances: [] } }, [proj]: p }).f), "ok");
  assert.equal(await checkKey("deepgram", DG, fake({ "/balances": new Error("down"), [proj]: p }).f), "ok");
  assert.equal(await checkKey("deepgram", DG, fake({ [proj]: { status: 200, body: { projects: [] } } }).f), "ok");
});

test("Deepgram: 401 is invalid, 5xx unavailable, offline network", async () => {
  assert.equal(await checkKey("deepgram", DG, fake({ [proj]: { status: 401 } }).f), "invalid");
  assert.equal(await checkKey("deepgram", DG, fake({ [proj]: { status: 503 } }).f), "unavailable");
  assert.equal(await checkKey("deepgram", DG, fake({ [proj]: new TypeError("fetch failed") }).f), "network");
});

test("a value that could inject a header, or an unknown provider, is invalid and no request is made", async () => {
  const t = fake({});
  assert.equal(await checkKey("deepgram", "abc\r\nX-Evil: 1", t.f), "invalid");
  assert.equal(await checkKey("openai", KEY, t.f), "invalid");
  assert.equal(t.seen.length, 0);
});

test("keycheck: a Deepgram key with fewer rights (403 on the project list) is accepted; 401 is still invalid", async () => {
  const { checkKey } = await import("./keychain.ts");
  const st = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;
  assert.equal(await checkKey("deepgram", "k".repeat(30), st(403)), "ok");
  assert.equal(await checkKey("deepgram", "k".repeat(30), st(401)), "invalid");
});

test("keycheck: Deepgram account whose balance cannot be read still works", async () => {
  const { checkKey } = await import("./keychain.ts");
  const f = (async (url: string) => {
    if (String(url).endsWith("/projects")) return new Response(JSON.stringify({ projects: [{ project_id: "abcd1234-ef" }] }), { status: 200 });
    return new Response("{}", { status: 403 });
  }) as unknown as typeof fetch;
  assert.equal(await checkKey("deepgram", "k".repeat(30), f), "ok");
});

test("keycheck: a key with a space or newline never reaches the network", async () => {
  const { checkKey } = await import("./keychain.ts");
  let calls = 0;
  const f = (async () => {
    calls++;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await checkKey("anthropic", "sk-ant-abc\nX-Evil: 1", f), "invalid");
  assert.equal(await checkKey("deepgram", "a b", f), "invalid");
  assert.equal(calls, 0);
});

test("keycheck: a 5xx on the Deepgram balance call or a thrown error there still counts as ok", async () => {
  const { checkKey } = await import("./keychain.ts");
  const f = (async (url: string) => {
    if (String(url).endsWith("/projects")) return new Response(JSON.stringify({ projects: [{ project_id: "abcd1234-ef" }] }), { status: 200 });
    throw new Error("boom");
  }) as unknown as typeof fetch;
  assert.equal(await checkKey("deepgram", "k".repeat(30), f), "ok");
});
