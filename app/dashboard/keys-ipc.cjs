"use strict";
// IPC for Settings → Keys. Runs in the Electron MAIN process. The renderer can send a key to keys:set and nothing ever
// comes back except the last 4 characters. Every handler is registered through the host's sender-checked handle().
// Rules: provider allow-list, strict value check with generic messages, 5 set/test per minute, errors scrubbed,
// nothing in here logs its arguments. Snapshot/fake mode never reaches the Keychain.
const fs = require("node:fs");
const kc = require("../src/keychain.cjs");
const { createSecureStore } = require("../src/securestore.cjs");
const { checkKey } = require("../src/keycheck.cjs");

const FAKE = {
  keychain: {
    deepgram: { source: "keychain", last4: "a9F2", inFile: false, inKeychain: true },
    anthropic: { source: "keychain", last4: "Q7xZ", inFile: false, inKeychain: true },
  },
  file: {
    deepgram: { source: "file", last4: "a9F2", inFile: true, inKeychain: false },
    anthropic: { source: "file", last4: "Q7xZ", inFile: true, inKeychain: false },
  },
  missing: {
    deepgram: { source: "missing", last4: "", inFile: false, inKeychain: false },
    anthropic: { source: "missing", last4: "", inFile: false, inKeychain: false },
  },
};

/**
 * Register the keys:* IPC handlers (status, set, test, connect, remove, migrate). Called by window.cjs.
 * o: { handle, getWin, dialog, keysFile: () => Promise<string>, fake: "keychain"|"file"|"missing"|"" , run?, store?, fetch?, env?, now? }
 * (run/store/fetch/env/now are test seams; `demo` is a result word for the hidden window checks: keys:connect then answers with that word and keeps nothing real). Where the keys are kept depends on the platform (src/securestore.cjs); `run` forces the macOS Keychain with a mock. */
function register(o) {
  const keychain = o.store || (o.run ? kc.createKeychain(o.run) : createSecureStore({}));
  const limit = kc.createRateLimiter(5, 60000, o.now);
  const limitConnect = kc.createRateLimiter(12, 60000, o.now); // the setup window: a wrong paste is retried a few times
  const limitAdmin = kc.createRateLimiter(5, 60000, o.now); // remove + migrate: stops a looping page from spamming dialogs or file rewrites
  const env = o.env || process.env;
  const fake = o.fake && FAKE[o.fake] ? FAKE[o.fake] : null;
  const preview = { ok: false, message: "Preview only." };
  const provider = (p) => {
    if (typeof p !== "string" || !kc.PROVIDERS.includes(p)) throw new Error("bad provider");
    return p;
  };
  const demoSaved = new Set(); // demo mode only: which providers "saved" a key (nothing is stored anywhere)
  const demoProviders = () =>
    Object.fromEntries(
      kc.PROVIDERS.map((p) => [p, demoSaved.has(p) ? { source: "keychain", last4: "a9F2", inFile: false, inKeychain: true } : FAKE.missing[p]]),
    );
  const status = async () => {
    if (o.demo) return { ok: true, providers: demoProviders(), fake: true, store: "keychain" };
    if (fake) return { ok: true, providers: fake, fake: true, store: "keychain" };
    const file = await o.keysFile();
    return { ok: true, providers: kc.keyStatus({ keychain, file, env }), fake: false, store: keychain.kind || "keychain" };
  };
  // The key keys:test will try: Keychain, then environment, then keys.env. Never returned to the page.
  // Same order as resolveKey in keychain.cjs, which the engine (src/env.ts) uses, so this tests the key the engine will really use.
  const resolveKey = async (p) => {
    const a = kc.ACCOUNTS[p];
    try {
      const v = keychain.get(p);
      if (v) return v;
    } catch {
      /* next */
    }
    const e = env[a] && String(env[a]).trim();
    if (e) return e;
    try {
      return kc.parseKeysFile(fs.readFileSync(await o.keysFile(), "utf8"))[a] || "";
    } catch {
      return "";
    }
  };
  // Handlers never throw a message that could contain a value: failures come back as {ok:false, message} with fixed text.
  o.handle("keys:status", () => status());
  o.handle("keys:set", async (p, value) => {
    provider(p);
    if (fake) return preview;
    if (!limit()) return { ok: false, message: "Too many tries. Wait a minute." };
    const bad = kc.checkKeyFormat(p, value);
    if (bad) return { ok: false, message: bad };
    try {
      keychain.set(p, value);
    } catch (e) {
      return { ok: false, message: kc.scrub(e && e.message, [value]).slice(0, 200) };
    }
    return { ok: true, state: await status() };
  });
  // The setup window: one call checks the pasted key with the service, and saves it only when the service accepted it (or accepted it but the account has no credit yet).
  // Result words (never a key): ok | invalid | nocredit | unavailable | network | format | limit. The page shows its own plain message for each.
  o.handle("keys:connect", async (p, value) => {
    provider(p);
    if (o.demo) {
      const saved = o.demo === "ok" || o.demo === "nocredit";
      if (saved) demoSaved.add(p);
      return { ok: o.demo === "ok", result: o.demo, saved, state: await status() };
    }
    if (fake) return preview;
    if (!limitConnect()) return { ok: false, result: "limit", saved: false };
    if (kc.checkKeyFormat(p, value)) return { ok: false, result: "format", saved: false };
    const result = await checkKey(p, value, o.fetch);
    if (result !== "ok" && result !== "nocredit") return { ok: false, result, saved: false };
    try {
      keychain.set(p, value);
    } catch (e) {
      return { ok: false, result: "store", saved: false, message: kc.scrub(e && e.message, [value]).slice(0, 200) };
    }
    return { ok: result === "ok", result, saved: true, state: await status() };
  });
  // The saved key checked again (the user added credit, or came back later). Same result words as keys:connect.
  o.handle("keys:recheck", async (p) => {
    provider(p);
    if (fake) return preview;
    if (!limitConnect()) return { ok: false, result: "limit" };
    const key = await resolveKey(p);
    if (!key) return { ok: false, result: "missing" };
    const result = await checkKey(p, key, o.fetch);
    return { ok: result === "ok", result };
  });
  o.handle("keys:test", async (p) => {
    provider(p);
    if (fake) return { ok: true, result: fake[p].source === "missing" ? "invalid" : "ok", fake: true };
    if (!limit()) return { ok: false, message: "Too many tries. Wait a minute." };
    const key = await resolveKey(p);
    if (!key) return { ok: true, result: "missing" };
    return { ok: true, result: await kc.testKey(p, key, o.fetch) };
  });
  o.handle("keys:remove", async (p) => {
    provider(p);
    if (fake) return preview;
    if (!limitAdmin()) return { ok: false, message: "Too many tries. Wait a minute." };
    const st = (await status()).providers[p];
    if (!st.inKeychain)
      return { ok: false, message: st.inFile ? "That key is in keys.env, not in the secure store. Delete the line there." : "Nothing to remove." };
    const win = o.getWin();
    const { response: r } = await o.dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["Cancel", "Remove"],
      defaultId: 0,
      cancelId: 0,
      title: "Remove key",
      message: `Remove the ${p === "deepgram" ? "Deepgram" : "Anthropic"} key from this computer?`,
      detail: "Calls need it. You can paste it again later.",
    });
    if (r !== 1) return { ok: true, cancelled: true, state: await status() };
    return { ok: kc.PROVIDERS.includes(p) && keychain.remove(p), state: await status() };
  });
  // Only ever called from the button. Never from startup.
  o.handle("keys:migrate", async () => {
    if (fake) return preview;
    if (!limitAdmin()) return { ok: false, message: "Too many tries. Wait a minute." };
    let res;
    try {
      res = kc.migrateKeysToKeychain({ keychain, file: await o.keysFile() });
    } catch (e) {
      return {
        ok: false,
        moved: [],
        failed: [],
        message: e instanceof kc.KeychainError ? e.message : "Could not move the keys. Nothing was lost.",
        state: await status(),
      };
    }
    return {
      ok: res.failed.length === 0,
      moved: res.moved,
      failed: res.failed.map((f) => f.provider),
      message: res.failed.length ? "Some keys could not be moved. Nothing was lost." : "",
      state: await status(),
    };
  });
}

module.exports = { register, FAKE };
