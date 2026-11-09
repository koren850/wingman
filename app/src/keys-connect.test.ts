// keys:connect, the setup window's one call: check the pasted key with the service, save it only when accepted. Fake store, fake fetch.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ipc = require("../dashboard/keys-ipc.cjs");
const KEY = "sk-ant-TESTONLY0123456789abcdefghijkl9F2a";
const DG = "dgTESTONLY0123456789abcdefABCDEF1234Zz";

function host(status: number, body: unknown = {}, o: { storeFails?: boolean; fake?: string } = {}) {
  const saved = new Map<string, string>();
  const store = {
    kind: "dpapi",
    get: (p: string) => saved.get(p) ?? null,
    set: (p: string, v: string) => {
      if (o.storeFails) throw new Error(`could not save ${v}`);
      saved.set(p, v);
      return true as const;
    },
    remove: (p: string) => saved.delete(p),
  };
  const handlers = new Map<string, (...a: any[]) => any>();
  const requests: string[] = [];
  let now = 1000;
  ipc.register({
    handle: (n: string, fn: any) => handlers.set(n, fn),
    getWin: () => ({}),
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    keysFile: async () => "/nonexistent/keys.env",
    fake: o.fake ?? "",
    store,
    env: {},
    fetch: async (url: string) => {
      requests.push(url);
      return { status, json: async () => body };
    },
    now: () => now,
  });
  return { call: (n: string, ...a: any[]) => handlers.get(n)!(...a), saved, requests, tick: (ms: number) => (now += ms) };
}
const noKey = (r: unknown, ...k: string[]) =>
  assert.deepEqual(
    k.filter((x) => JSON.stringify(r).includes(x)),
    [],
    "a key is in the answer",
  );

test("connect: a good key is checked, saved, and the answer carries only the last 4 characters", async () => {
  const h = host(200);
  const r = await h.call("keys:connect", "anthropic", KEY);
  assert.equal(r.ok, true);
  assert.equal(r.result, "ok");
  assert.equal(r.saved, true);
  assert.equal(h.saved.get("anthropic"), KEY);
  assert.equal(r.state.providers.anthropic.last4, KEY.slice(-4));
  assert.equal(r.state.store, "dpapi");
  noKey(r, KEY);
});

test("connect: a wrong key is not saved and the answer says invalid", async () => {
  const h = host(401);
  const r = await h.call("keys:connect", "anthropic", KEY);
  assert.deepEqual([r.ok, r.result, r.saved], [false, "invalid", false]);
  assert.equal(h.saved.size, 0);
  noKey(r, KEY);
});

test("connect: a right key with no credit is saved (the user may add credit later) but is not ok", async () => {
  const h = host(402);
  const r = await h.call("keys:connect", "anthropic", KEY);
  assert.deepEqual([r.ok, r.result, r.saved], [false, "nocredit", true]);
  assert.equal(h.saved.get("anthropic"), KEY);
});

test("connect: service down or no network is not saved", async () => {
  const h = host(503);
  assert.equal((await h.call("keys:connect", "anthropic", KEY)).result, "unavailable");
  assert.equal(h.saved.size, 0);
});

test("connect: a bad format never reaches the network; a bad provider throws", async () => {
  const h = host(200);
  const r = await h.call("keys:connect", "anthropic", "nope");
  assert.deepEqual([r.ok, r.result], [false, "format"]);
  assert.equal(h.requests.length, 0);
  await assert.rejects(() => h.call("keys:connect", "openai", KEY));
});

test("connect: a store that fails gives a scrubbed error", async () => {
  const h = host(200, {}, { storeFails: true });
  const r = await h.call("keys:connect", "deepgram", DG);
  assert.deepEqual([r.ok, r.result, r.saved], [false, "store", false]);
  noKey(r, DG);
});

test("connect: 12 tries a minute, then it waits", async () => {
  const h = host(401);
  for (let i = 0; i < 12; i++) assert.equal((await h.call("keys:connect", "deepgram", DG)).result, "invalid");
  assert.equal((await h.call("keys:connect", "deepgram", DG)).result, "limit");
  h.tick(61000);
  assert.equal((await h.call("keys:connect", "deepgram", DG)).result, "invalid");
});

test("connect: in a preview nothing is checked or saved", async () => {
  const h = host(200, {}, { fake: "missing" });
  const r = await h.call("keys:connect", "anthropic", KEY);
  assert.equal(r.ok, false);
  assert.equal(h.saved.size, 0);
  assert.equal(h.requests.length, 0);
});

test("L12: a connect that finishes after a newer paste does not overwrite it, and a remove during a connect is not undone", async () => {
  const slow: Array<() => void> = [];
  const saved = new Map<string, string>();
  const handlers = new Map<string, (...a: any[]) => any>();
  let n = 0;
  ipc.register({
    handle: (name: string, fn: any) => handlers.set(name, fn),
    getWin: () => ({}),
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    keysFile: async () => "/nonexistent/keys.env",
    fake: "",
    store: {
      kind: "dpapi",
      get: (p: string) => saved.get(p) ?? null,
      set: (p: string, v: string) => (saved.set(p, v), true as const),
      remove: (p: string) => saved.delete(p),
    },
    env: {},
    // the first check is slow (it answers after the second one), the later ones answer at once
    fetch: (_url: string) =>
      n++ === 0 ? new Promise((r) => slow.push(() => r({ status: 200, json: async () => ({}) }))) : Promise.resolve({ status: 200, json: async () => ({}) }),
    now: () => 1000,
  });
  const call = (name: string, ...a: any[]) => handlers.get(name)!(...a);
  const OLD = KEY,
    NEW = "sk-ant-TESTONLY0123456789abcdefghijkl9F2b";
  const first = call("keys:connect", "anthropic", OLD);
  const second = await call("keys:connect", "anthropic", NEW);
  assert.equal(second.saved, true);
  slow[0]();
  const r1 = await first;
  assert.equal(r1.saved, false);
  assert.equal(r1.result, "superseded");
  assert.equal(saved.get("anthropic"), NEW, "the newer key stays");
  // remove during a connect
  n = 0;
  slow.length = 0;
  saved.set("deepgram", "dgOLDKEY0123456789abcdefABCDEF1234Zz"); // something to remove
  const third = call("keys:connect", "deepgram", DG);
  await call("keys:remove", "deepgram");
  slow[0]();
  assert.equal((await third).saved, false);
  assert.equal(saved.has("deepgram"), false);
});
