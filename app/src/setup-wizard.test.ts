// The first-run window: the pure decisions (dashboard/setuplib.js), the platform pieces of setup-ipc.cjs, keys:recheck, the catalogs and the wiring of setupwizard.js.
// The window itself is checked with the hidden snapshots (dashboard/snapshot.sh, focus setup-<name>) and the driver dashboard/setupdrive.js.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { ROOT } from "./env.ts";

const req = createRequire(import.meta.url);
const S = req("../dashboard/setuplib.js");
const setup = req("../dashboard/setup-ipc.cjs");
const keysIpc = req("../dashboard/keys-ipc.cjs");
const en: Record<string, string> = req("../dashboard/strings.en.js");
const he: Record<string, string> = req("../dashboard/strings.he.js");

test("steps: keys first, then the sound, then ready; a key with no credit does not block the way", () => {
  const ok = { deepgram: "ok", anthropic: "ok" };
  assert.equal(S.wizardPlan({ keys: { deepgram: "missing", anthropic: "ok" }, allow: { done: true } }).step, "keys");
  assert.equal(S.wizardPlan({ keys: ok, allow: { done: false } }).step, "allow");
  assert.equal(S.wizardPlan({ keys: ok, allow: { done: true } }).step, "ready");
  assert.equal(S.wizardPlan({ keys: { deepgram: "ok", anthropic: "nocredit" }, allow: { done: false } }).step, "allow");
  for (const bad of ["invalid", "network", "unavailable", "format", "missing"]) assert.equal(S.keysDone({ deepgram: "ok", anthropic: bad }), false, bad);
  assert.equal(S.wizardPlan({ keys: ok, allow: { done: true }, pick: "keys" }).step, "keys", "the person can go back");
  assert.equal(
    S.wizardPlan({ keys: { deepgram: "missing", anthropic: "ok" }, allow: { done: true }, pick: "ready" }).step,
    "keys",
    "no jumping ahead of the keys",
  );
});

test("sound on macOS: the microphone is read from the system, System Audio Recording is confirmed by the person", () => {
  const a = (mic: string, audioAck = false) => S.allowState({ platform: "darwin", mic, audioAck });
  assert.deepEqual(a("granted", true), { mic: "ok", system: "ok", done: true });
  assert.equal(a("granted").done, false, "system audio not confirmed yet");
  assert.equal(a("not-determined", true).mic, "ask");
  assert.equal(a("denied", true).mic, "blocked");
  assert.equal(a("restricted", true).mic, "blocked");
  assert.equal(a("unknown", true).mic, "ask", "an unreadable status on macOS is asked, not assumed");
});

test("sound on Windows: only the microphone switch exists; an unknown status does not block; nothing to confirm for the call sound", () => {
  const a = (mic: string) => S.allowState({ platform: "win32", mic, audioAck: false });
  assert.deepEqual(a("granted"), { mic: "ok", system: "none", done: true });
  assert.equal(a("unknown").done, true);
  assert.equal(a("denied").mic, "blocked");
  assert.equal(a("denied").done, false);
  assert.equal(S.allowState({ platform: "linux", mic: "unknown" }).done, true);
});

test("every key problem has a plain message and a fix in English and Hebrew; the fix is one of the known buttons", () => {
  for (const word of ["invalid", "nocredit", "network", "unavailable", "format", "limit", "store", "app", "nonsense"]) {
    const p = S.keyProblem(word);
    assert.ok(en[p.text] && he[p.text], `${word}: ${p.text}`);
    assert.ok(["get", "billing", "retry", ""].includes(p.fix), `${word}: ${p.fix}`);
    if (p.fix) assert.ok(en["wiz.fix." + p.fix] && he["wiz.fix." + p.fix], p.fix);
  }
  assert.equal(S.keyProblem("nocredit").fix, "billing");
  assert.equal(S.keyProblem("invalid").fix, "get");
  assert.equal(S.keyProblem("network").fix, "retry");
});

test("every result word that keys:connect can answer has a message in the page (driven through the real handler)", async () => {
  const seen = new Set<string>();
  for (const [status, throws] of [
    [200, false],
    [401, false],
    [402, false],
    [503, false],
    [200, true],
  ] as const) {
    const handlers = new Map<string, (...a: any[]) => any>();
    keysIpc.register({
      handle: (n: string, fn: any) => handlers.set(n, fn),
      getWin: () => ({}),
      dialog: {},
      keysFile: async () => "/nonexistent/keys.env",
      fake: "",
      store: { kind: "file", get: () => null, set: () => true, remove: () => true },
      env: {},
      fetch: async () => {
        if (throws) throw new TypeError("fetch failed");
        return { status, json: async () => ({}) };
      },
    });
    const connect = handlers.get("keys:connect")!;
    seen.add((await connect("anthropic", "sk-ant-TESTONLY0123456789abcdefghijkl9F2a")).result);
    seen.add((await connect("anthropic", "short")).result);
    for (let i = 0; i < 12; i++) await connect("deepgram", "dgTESTONLY0123456789abcdefABCDEF1234Zz");
    seen.add((await connect("deepgram", "dgTESTONLY0123456789abcdefABCDEF1234Zz")).result);
  }
  assert.ok(
    ["ok", "invalid", "nocredit", "unavailable", "network", "format", "limit"].every((w) => seen.has(w)),
    [...seen].join(),
  );
  for (const w of seen) assert.ok(w === "ok" || S.KEY_PROBLEMS[w], `keys:connect answers "${w}" and the page has no message for it`);
});

test("the window shows only until finished or skipped, only while keys are missing or the person is in the middle of it, never in a call", () => {
  assert.equal(S.wizardVisible({ keysMissing: true }), true);
  assert.equal(S.wizardVisible({ keysMissing: false }), false, "keys already there (an existing user): no window");
  assert.equal(S.wizardVisible({ keysMissing: false, started: true }), true, "in the middle of it");
  assert.equal(S.wizardVisible({ keysMissing: true, skipped: true }), false);
  assert.equal(S.wizardVisible({ keysMissing: true, done: true }), false);
  assert.equal(S.wizardVisible({ keysMissing: true, running: true }), false);
});

test("setup:status names the platform; the microphone page is the macOS pane on macOS and the Windows page on Windows, and nothing elsewhere", async () => {
  const run = async (platform: string, which: string) => {
    const opened: string[] = [];
    const h = new Map<string, (...a: any[]) => any>();
    setup.register({
      handle: (n: string, fn: any) => h.set(n, fn),
      child: async () => ({ ok: true, values: {}, devices: [] }),
      root: ROOT,
      home: ROOT,
      env: {},
      platform,
      systemPreferences: { getMediaAccessStatus: () => "denied", askForMediaAccess: async () => false },
      shell: { openExternal: async (u: string) => void opened.push(u), openPath: async () => "" },
      screen: { getAllDisplays: () => [{}, {}] },
      preview: false,
    });
    const st = await h.get("setup:status")!();
    const r = await h.get("setup:openPrivacy")!(which);
    return { st, r, opened };
  };
  const mac = await run("darwin", "mic");
  assert.equal(mac.st.platform, "darwin");
  assert.deepEqual(mac.opened, [setup.PANES.mic]);
  const win = await run("win32", "mic");
  assert.equal(win.st.platform, "win32");
  assert.deepEqual(win.opened, ["ms-settings:privacy-microphone"]);
  const winAudio = await run("win32", "audio");
  assert.equal(winAudio.r.ok, false, "Windows has no System Audio Recording page");
  assert.deepEqual(winAudio.opened, []);
  const lin = await run("linux", "mic");
  assert.equal(lin.r.ok, false);
  assert.deepEqual(lin.opened, []);
});

test("billing and key pages are fixed https addresses", () => {
  for (const k of ["deepgram", "anthropic", "deepgramBilling", "anthropicBilling"])
    assert.match(setup.LINKS[k], /^https:\/\/console\.(deepgram|anthropic)\.com\//, k);
});

test("keys:recheck checks the saved key and returns a result word only", async () => {
  const handlers = new Map<string, (...a: any[]) => any>();
  const saved = new Map([["anthropic", "sk-ant-TESTONLY0123456789abcdefghijkl9F2a"]]);
  keysIpc.register({
    handle: (n: string, fn: any) => handlers.set(n, fn),
    getWin: () => ({}),
    dialog: {},
    keysFile: async () => "/nonexistent/keys.env",
    fake: "",
    store: { kind: "file", get: (p: string) => saved.get(p) ?? null, set: () => true, remove: () => true },
    env: {},
    fetch: async () => ({ status: 402, json: async () => ({}) }),
  });
  const r = await handlers.get("keys:recheck")!("anthropic");
  assert.deepEqual(r, { ok: false, result: "nocredit" });
  assert.deepEqual(await handlers.get("keys:recheck")!("deepgram"), { ok: false, result: "missing" });
});

// ---------------------------------------------------------------- the window itself, drawn with stub page helpers
type Node_ = {
  tag: string;
  attrs: Record<string, any>;
  kids: any[];
  value?: string;
  on: Record<string, ((e?: any) => void)[]>;
  addEventListener: (...a: any[]) => void;
};
const flat = (a: any[]): any[] => a.flat(Infinity).filter((k) => k != null && k !== false);
/** Loads dashboard/setupwizard.js with stand-ins for the page helpers (h, btn, chip, T ...) and returns it with a record of what was asked. */
function loadWindow(o: { platform?: string; mic?: string; missing?: string[]; audio?: boolean; api?: Record<string, any> } = {}) {
  const g = globalThis as any;
  const used = new Set<string>();
  const log = { announce: [] as string[], fail: [] as string[], redraw: 0, started: [] as string[], saved: 0, viewHome: 0 };
  const inputs: Record<string, { value: string }> = {};
  const h = (tag: string, attrs: any, ...kids: any[]): Node_ => {
    const n: Node_ = {
      tag,
      attrs: attrs || {},
      kids: flat(kids),
      on: {},
      addEventListener: (ev: string, fn: any) => void (n.on[ev] ||= []).push(fn),
    };
    return n;
  };
  const providers = (missing: string[]) =>
    Object.fromEntries(
      ["deepgram", "anthropic"].map((p) => [
        p,
        missing.includes(p) ? { source: "missing", last4: "" } : { source: "keychain", last4: "a9F2", inKeychain: true },
      ]),
    );
  const stubs: Record<string, any> = {
    h,
    btn: (label: any, x: any = {}) => h("button", { ...x, class: "btn " + (x.cls || "") }, label),
    chip: (text: any, variant: string) => h("span", { class: "chip " + variant }, text),
    ico: (name: string) => h("svg", { name }),
    ltr: (t: any) => h("span", { class: "ltr" }, t),
    T: (k: string) => (used.add(k), k),
    $: (id: string) => inputs[id] || null,
    announce: (m: string) => log.announce.push(m),
    fail: (m: string) => log.fail.push(m),
    renderSide: () => void log.redraw++,
    suSave: () => void log.saved++,
    suAct: async (_id: string, fn: () => any) => fn(),
    loadSetup: async () => {},
    viewHome: () => void log.viewHome++,
    act: async (fn: () => any) => (log.started.push("practice"), fn()),
    startFlow: () => void log.started.push("start"),
    languageRow: () => h("div", { class: "langrow" }),
    isRunning: () => false,
    keysMissing: () => o.missing ?? ["Deepgram", "Anthropic"],
    state: { view: "home" },
    H: { keys: { ok: true, store: "keychain", providers: providers((o.missing ?? ["Deepgram", "Anthropic"]).map((n) => n.toLowerCase())) } },
    KEYS: { data: null },
    SU: { status: { platform: o.platform ?? "darwin", mic: o.mic ?? "granted", displays: 2 }, acks: { audio: !!o.audio } },
    WingmanSetup: S,
    api: o.api ?? {},
  };
  Object.assign(g, stubs);
  const path = req.resolve("../dashboard/setupwizard.js");
  delete req.cache[path];
  const W = req("../dashboard/setupwizard.js");
  return { W, used, log, inputs, stubs, providers };
}
const walk = (n: any, f: (x: Node_) => void) => {
  if (n && typeof n === "object" && n.tag) {
    f(n);
    for (const k of n.kids) walk(k, f);
  }
};
const find = (n: any, id: string): Node_ | null => {
  let r: Node_ | null = null;
  walk(n, (x) => {
    if (x.attrs.id === id) r = x;
  });
  return r;
};
const ids = (n: any) => {
  const r: string[] = [];
  walk(n, (x) => x.attrs.id && r.push(x.attrs.id));
  return r;
};

/** Types into a key box the way a person does: draws the window, sets the field's value and fires its input event. Returns the field. */
function typeKey(t: ReturnType<typeof loadWindow>, p: string, value: string) {
  const f = find(t.W.welcomeCard(), "wiz-key-" + p)!;
  f.value = value;
  for (const fn of f.on.input || []) fn();
  t.inputs["wiz-key-" + p] = f as any; // $() finds the live field, as in the page
  return f;
}

test("the window draws every example state with texts that exist in English and Hebrew, one primary action per state", () => {
  const { W, used } = loadWindow();
  const want: Record<string, string[]> = {
    keys: ["wiz-check", "wiz-key-deepgram", "wiz-key-anthropic", "wiz-get-deepgram", "wiz-skip"],
    "keys-invalid": ["wiz-fix-deepgram", "wiz-err-deepgram", "wiz-check"],
    "keys-nocredit": ["wiz-fix-anthropic", "wiz-recheck-anthropic", "wiz-next", "wiz-replace-deepgram"],
    "keys-network": ["wiz-fix-anthropic", "wiz-key-anthropic", "wiz-check"],
    "keys-checking": ["wiz-check"],
    "allow-mac": ["wiz-mic-btn", "wiz-mic-check", "wiz-sys-open", "wiz-sys-ack", "wiz-back", "wiz-next"],
    "allow-blocked": ["wiz-mic-btn", "wiz-sys-ack"],
    "allow-win": ["wiz-mic-btn", "wiz-mic-check", "wiz-back"],
    "allow-mac-done": ["wiz-next", "wiz-back"],
    ready: ["wiz-practice", "wiz-start", "wiz-later", "wiz-consent"],
    "ready-win": ["wiz-practice", "wiz-start", "wiz-later"],
  };
  assert.deepEqual(Object.keys(W.WZ_PREVIEWS).sort(), Object.keys(want).sort());
  for (const [name, expect] of Object.entries(want)) {
    W.wizPreviewSet("setup-" + name);
    const card = W.welcomeCard();
    assert.ok(card, name);
    const have = ids(card);
    for (const id of expect) assert.ok(have.includes(id), `${name}: no ${id} in ${have.join(",")}`);
    let steps = 0;
    walk(card, (x) => x.tag === "li" && steps++);
    assert.equal(steps, 3, name);
    // Every key field is a password field.
    walk(card, (x) => {
      if (x.tag === "input") assert.equal(x.attrs.type, "password", name);
    });
  }
  W.wizPreviewSet("");
  for (const k of used) assert.ok(en[k] !== undefined && he[k] !== undefined, `text missing in English or Hebrew: ${k}`);
  assert.ok(used.has("wiz.fix.billing") && used.has("wiz.err.nocredit") && used.has("wiz.mic.blocked.win") && used.has("wiz.store.keychain"));
});

test("the window text follows the platform: Windows has no System Audio step and says where the keys are kept", () => {
  const { W, used } = loadWindow();
  W.wizPreviewSet("setup-allow-win");
  const win = W.welcomeCard();
  assert.equal(find(win, "wiz-sys-open"), null);
  assert.equal(find(win, "wiz-sys-ack"), null);
  assert.ok(used.has("wiz.allow.intro.win") && used.has("wiz.mic.openWin") && used.has("wiz.sys.none"));
  W.wizPreviewSet("setup-ready-win");
  const r = W.welcomeCard();
  assert.ok(find(r, "wiz-practice"));
  W.wizPreviewSet("setup-keys");
  W.welcomeCard();
  assert.ok(used.has("wiz.store.keychain"));
});

test("the window is not drawn for a person who already has keys, in a call, or after Set up later", () => {
  const have = loadWindow({ missing: [] });
  assert.equal(have.W.welcomeCard(), null, "keys already there");
  const first = loadWindow();
  assert.ok(first.W.welcomeCard());
  (first.stubs.isRunning as any) = () => true;
  Object.assign(globalThis, { isRunning: () => true });
  assert.equal(first.W.welcomeCard(), null, "in a call");
  Object.assign(globalThis, { isRunning: () => false });
  assert.ok(first.W.welcomeCard());
  first.W.wizEnd("skip");
  assert.equal(first.stubs.SU.acks.welcomeSkipped, true);
  assert.equal(first.W.welcomeCard(), null);
  first.W.wizReopen();
  assert.ok(first.W.welcomeCard(), "Settings, Setup guide brings it back while keys are missing");
});

test("pasting: the field is read once and cleared; a good key saves; a wrong key shows its message and fix; a network problem keeps the paste for Try again", async () => {
  const calls: [string, string][] = [];
  let answer = "ok";
  const api = {
    keysConnect: async (p: string, v: string) => {
      calls.push([p, v]);
      return {
        ok: answer === "ok",
        result: answer,
        saved: answer === "ok",
        state:
          answer === "ok"
            ? { ok: true, store: "dpapi", providers: { deepgram: { source: "keychain", last4: "a9F2" }, anthropic: { source: "keychain", last4: "Q7xZ" } } }
            : undefined,
      };
    },
    setupOpenLink: async () => ({ ok: true }),
  };
  const t = loadWindow({ api });
  typeKey(t, "deepgram", "  dgTESTONLY0123456789abcdefABCDEF1234Zz  ");
  typeKey(t, "anthropic", "");
  await t.W.wizSubmit();
  assert.deepEqual(calls, [["deepgram", "dgTESTONLY0123456789abcdefABCDEF1234Zz"]], "trimmed, and only the filled field is sent");
  assert.equal(t.inputs["wiz-key-deepgram"].value, "", "the field is cleared before anything else");
  assert.equal(t.W.WZ.res.deepgram, "ok");
  assert.equal(t.stubs.H.keys.store, "dpapi", "the saved-key status from the main process replaces the old one");
  assert.equal(t.W.WZ.pick, "keys", "the person stays to see the result, then presses Continue");
  assert.ok(t.log.announce.some((m) => m === "wiz.ok"));
  // A wrong key: message and fix, nothing kept.
  answer = "invalid";
  await t.W.wizConnect("anthropic", "sk-ant-TESTONLY0123456789abcdefghijkl9F2a");
  assert.equal(t.W.WZ.res.anthropic, "invalid");
  assert.equal(t.W.WZ.pending.anthropic, undefined);
  assert.ok(t.log.fail.includes("wiz.err.invalid"));
  // No network: the key stays in memory for Try again only.
  answer = "network";
  await t.W.wizConnect("anthropic", "sk-ant-TESTONLY0123456789abcdefghijkl9F2a");
  assert.equal(t.W.WZ.pending.anthropic, "sk-ant-TESTONLY0123456789abcdefghijkl9F2a");
  answer = "ok";
  await t.W.wizConnect("anthropic", t.W.WZ.pending.anthropic);
  assert.equal(t.W.WZ.pending.anthropic, undefined, "dropped as soon as the check succeeds");
  assert.equal(JSON.stringify(t.log), JSON.stringify(t.log).replace(/sk-ant-TESTONLY/g, "X"), "no key text in anything the window announced");
});

test("a pasted key survives every redraw of the window until it is sent (D-1)", async () => {
  const calls: [string, string][] = [];
  const t = loadWindow({ api: { keysConnect: async (p: string, v: string) => (calls.push([p, v]), { ok: false, result: "invalid" }) } });
  S.keyDraft.clearAll();
  typeKey(t, "deepgram", "dgTESTONLY-first");
  // The person goes to the browser and comes back: the window redraws (focus, a check result, a call-state update).
  for (let i = 0; i < 3; i++) t.W.welcomeCard();
  assert.equal(find(t.W.welcomeCard(), "wiz-key-deepgram")!.value, "dgTESTONLY-first", "the first key is still in its box");
  typeKey(t, "anthropic", "sk-ant-TESTONLY-second");
  assert.equal(find(t.W.welcomeCard(), "wiz-key-deepgram")!.value, "dgTESTONLY-first");
  assert.equal(find(t.W.welcomeCard(), "wiz-key-anthropic")!.value, "sk-ant-TESTONLY-second");
  await t.W.wizSubmit();
  assert.deepEqual(calls.map((c) => c[0]).sort(), ["anthropic", "deepgram"], "both keys are sent, not one");
  assert.equal(find(t.W.welcomeCard(), "wiz-key-deepgram")!.value, "", "cleared once sent");
  assert.equal(S.keyDraft.has("deepgram") || S.keyDraft.has("anthropic"), false);
});

test("a late key result does not pull the person back from the next step; Continue waits for a running check (D-6)", async () => {
  let release!: (r: unknown) => void;
  const gate = new Promise((r) => (release = r));
  const t = loadWindow({ missing: [], audio: false, api: { keysConnect: () => gate } });
  t.W.wizReopen(); // both keys are saved; the person opens the window again from Settings
  t.W.WZ.pick = "keys";
  const run = t.W.wizConnect("deepgram", "dgTESTONLY-replacement");
  assert.equal(find(t.W.welcomeCard(), "wiz-next")!.attrs.disabled, true, "Continue is off while the check runs");
  t.W.WZ.pick = ""; // pressed anyway (for example a click that was already on its way)
  assert.equal(t.W.wizStep(), "allow");
  release({ ok: true, result: "ok", saved: true });
  await run;
  assert.equal(t.W.WZ.pick, "", "the answer does not send the person back to the keys");
  assert.equal(t.W.wizStep(), "allow");
  assert.equal(t.W.WZ.res.deepgram, "ok");
  // On the keys step the answer keeps the person there to read it.
  t.W.WZ.pick = "keys";
  await t.W.wizConnect("deepgram", "x");
  assert.equal(t.W.WZ.pick, "keys");
});

test("an error button that says 'allow the sound' opens the allow step of the window, once the keys are done (D-6)", () => {
  const first = loadWindow(); // keys missing: the window shows the keys step and stays there
  assert.equal(first.W.wizGoAllow(), true);
  assert.equal(first.W.WZ.pick, "");
  const have = loadWindow({ missing: [] });
  assert.equal(have.W.wizGoAllow(), false, "window not on screen: the setup card handles it");
  have.W.wizReopen();
  assert.equal(have.W.wizGoAllow(), true);
  assert.equal(have.W.WZ.pick, "allow");
  assert.equal(have.W.wizStep(), "allow");
});

test("pressing Check and save with empty boxes says so; a bridge that throws becomes a plain message", async () => {
  const t = loadWindow({
    api: {
      keysConnect: async () => {
        throw new Error("no bridge");
      },
    },
  });
  typeKey(t, "deepgram", "");
  typeKey(t, "anthropic", "");
  await t.W.wizSubmit();
  assert.equal(t.W.WZ.empty, true);
  assert.ok(t.log.announce.includes("wiz.empty"));
  await t.W.wizConnect("deepgram", "dgTESTONLY0123456789abcdefABCDEF1234Zz");
  assert.equal(t.W.WZ.res.deepgram, "app");
  assert.ok(t.log.fail.includes("wiz.err.app"));
});

test("the page helpers the window uses exist in the real preload bridge and reach registered channels", async () => {
  // Load the real preload with a stand-in for electron: every method becomes a call of ipcRenderer.invoke(channel, ...).
  const Module = req("node:module");
  const invoked: string[] = [];
  const exposed: Record<string, any> = {};
  const electronPath = req.resolve("electron");
  const prev = Module._cache[electronPath];
  Module._cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      contextBridge: { exposeInMainWorld: (_n: string, api: any) => Object.assign(exposed, api) },
      ipcRenderer: { invoke: (c: string) => (invoked.push(c), Promise.resolve({})), on: () => {} },
    },
  };
  const preloadPath = req.resolve("../dashboard/preload.cjs");
  delete req.cache[preloadPath];
  try {
    req("../dashboard/preload.cjs");
  } finally {
    if (prev) Module._cache[electronPath] = prev;
    else delete Module._cache[electronPath];
  }
  for (const m of ["keysConnect", "keysRecheck", "setupOpenLink", "setupOpenPrivacy", "setupAskMic", "practice", "setupStatus"])
    assert.equal(typeof exposed[m], "function", m);
  await exposed.keysConnect("deepgram", "x");
  await exposed.keysRecheck("deepgram");
  await exposed.setupOpenLink("deepgramBilling");
  assert.deepEqual(invoked, ["keys:connect", "keys:recheck", "setup:openLink"]);
  const registered = new Set<string>();
  keysIpc.register({ handle: (n: string) => registered.add(n), getWin: () => ({}), dialog: {}, keysFile: async () => "", fake: "missing", env: {} });
  assert.ok(registered.has("keys:connect") && registered.has("keys:recheck"));
});
