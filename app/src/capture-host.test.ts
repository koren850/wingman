// tray/capture-host.cjs with a fake Electron: the hidden window, the microphone permission, the Windows loopback handler and the page's replies.
// The page (tray/capture/capture.js) is played by the test through the fake ipcMain.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCaptureHost } = require("../tray/capture-host.cjs");
const permissions = require("../shared/permissions.cjs");

type Cmd = { id: number; op: string; ch?: string; name?: string };

function env(
  o: { platform?: string; mic?: string; ask?: boolean; sources?: unknown[]; askGate?: Promise<void>; execGate?: Promise<void>; loadFails?: boolean } = {},
) {
  const ipc = new EventEmitter();
  const wins: FakeWin[] = [];
  const grants: [unknown, string[]][] = [];
  let handler: ((req: unknown, cb: (s: unknown) => void) => void) | undefined;
  class FakeWin extends EventEmitter {
    destroyed = false;
    opts: any;
    sent: Cmd[] = [];
    webContents: any;
    loaded = "";
    constructor(opts: any) {
      super();
      this.opts = opts;
      this.webContents = Object.assign(new EventEmitter(), {
        send: (_c: string, cmd: Cmd) => {
          this.sent.push(cmd);
          this.onCommand?.(cmd);
        },
        setWindowOpenHandler: () => {},
        executeJavaScript: () => o.execGate ?? Promise.resolve(),
      });
      wins.push(this);
    }
    onCommand?: (c: Cmd) => void;
    loadFile(f: string) {
      this.loaded = f;
      return o.loadFails ? Promise.reject(new Error("ERR_FILE_NOT_FOUND")) : Promise.resolve();
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
  }
  const asked: string[] = [];
  const host = createCaptureHost({
    BrowserWindow: FakeWin,
    session: {
      fromPartition: (n: string) => ({
        name: n,
        setDisplayMediaRequestHandler: (h: typeof handler) => {
          handler = h;
        },
      }),
    },
    ipcMain: ipc,
    desktopCapturer: { getSources: async () => o.sources ?? [{ id: "screen:0" }] },
    systemPreferences: {
      getMediaAccessStatus: () => o.mic ?? "granted",
      askForMediaAccess: async () => {
        asked.push("ask");
        if (o.askGate) await o.askGate;
        return o.ask ?? true;
      },
    },
    grantSession: (s: unknown, p: string[]) => grants.push([s, p]),
    dir: "/app/tray/capture",
    platform: o.platform ?? "darwin",
  });
  return { host, ipc, wins, grants, asked, getHandler: () => handler };
}

test("host: the window is hidden, sandboxed, uses its own session and gets only media permissions", async () => {
  const e = env();
  const p = e.host.start("mic", {});
  await new Promise((r) => setImmediate(r));
  const w = e.wins[0];
  ipcReply(e, w, w.sent[0].id, { ok: true });
  await p;
  assert.equal(w.opts.show, false);
  assert.equal(w.opts.webPreferences.sandbox, true);
  assert.equal(w.opts.webPreferences.contextIsolation, true);
  assert.equal(w.opts.webPreferences.nodeIntegration, false);
  assert.equal(w.opts.webPreferences.backgroundThrottling, false);
  assert.match(w.loaded, /capture\.html$/);
  assert.equal(e.grants.length, 1);
  assert.deepEqual(e.grants[0][1], ["media", "display-capture"]);
  assert.equal((e.grants[0][0] as { name: string }).name, "wingman-capture");
  assert.equal(e.wins.length, 1, "one window for all commands");
});

function ipcReply(e: ReturnType<typeof env>, w: any, id: number, r: Record<string, unknown>) {
  e.ipc.emit("capture:reply", { sender: w.webContents }, { id, ...r });
}

test("host: start sends the saved name, a reply with fellBack is passed on, pcm goes to listeners only while the channel runs", async () => {
  const e = env();
  const got: [string, number][] = [];
  e.host.onPcm((ch: string, b: Buffer) => got.push([ch, b.length]));
  const p = e.host.start("mic", { name: "USB Mic" });
  await new Promise((r) => setImmediate(r));
  const w = e.wins[0];
  assert.deepEqual({ op: w.sent[0].op, ch: w.sent[0].ch, name: w.sent[0].name }, { op: "start", ch: "mic", name: "USB Mic" });
  ipcReply(e, w, w.sent[0].id, { ok: true, fellBack: true });
  assert.deepEqual(await p, { fellBack: true });
  e.ipc.emit("capture:pcm", { sender: w.webContents }, "mic", new Uint8Array(3200));
  e.ipc.emit("capture:pcm", { sender: w.webContents }, "mic", new Uint8Array(3)); // odd length: the last byte is cut
  e.ipc.emit("capture:pcm", { sender: w.webContents }, "system", new Uint8Array(3200)); // not running
  e.ipc.emit("capture:pcm", { sender: {} }, "mic", new Uint8Array(3200)); // not the capture window
  e.ipc.emit("capture:pcm", { sender: w.webContents }, "other", new Uint8Array(3200));
  assert.deepEqual(got, [
    ["mic", 3200],
    ["mic", 2],
  ]);
});

test("host: macOS asks for the microphone once and a refusal is a 'permission' error without opening the window", async () => {
  const e = env({ mic: "not-determined", ask: false });
  await assert.rejects(
    () => e.host.start("mic", {}),
    (x: any) => x.code === "permission",
  );
  assert.deepEqual(e.asked, ["ask"]);
  assert.equal(e.wins.length, 0, "no window was needed");
  const d = env({ mic: "denied" });
  await assert.rejects(
    () => d.host.start("mic", {}),
    (x: any) => x.code === "permission" && /denied/.test(x.message),
  );
  const r = env({ mic: "restricted" });
  await assert.rejects(
    () => r.host.start("mic", {}),
    (x: any) => x.code === "permission",
  );
});

test("host: the page's coded errors become coded Errors and the channel is not left running", async () => {
  const e = env();
  const p = e.host.start("mic", {});
  await new Promise((r) => setImmediate(r));
  const w = e.wins[0];
  ipcReply(e, w, w.sent[0].id, { ok: false, code: "busy", message: "NotReadableError" });
  await assert.rejects(p, (x: any) => x.code === "busy" && x.message === "NotReadableError");
  assert.equal(e.host.isRunning("mic"), false);
  e.ipc.emit("capture:pcm", { sender: w.webContents }, "mic", new Uint8Array(3200));
});

test("host: a reply from another sender or with an unknown id is ignored; an unanswered command times out", async () => {
  const timers: { fn: () => void }[] = [];
  const ipc = new EventEmitter();
  let win: any;
  class W extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { send: () => {}, setWindowOpenHandler: () => {} });
    constructor() {
      super();
      win = { webContents: this.webContents };
    }
    loadFile() {
      return Promise.resolve();
    }
    isDestroyed() {
      return false;
    }
    destroy() {}
  }
  const host = createCaptureHost({
    BrowserWindow: W,
    session: { fromPartition: () => ({ setDisplayMediaRequestHandler() {} }) },
    ipcMain: ipc,
    desktopCapturer: {},
    systemPreferences: { getMediaAccessStatus: () => "granted" },
    grantSession() {},
    dir: "/x",
    platform: "win32",
    setTimeout: (fn: () => void) => (timers.push({ fn }), timers.length),
    clearTimeout() {},
  });
  const p = host.start("mic", {});
  await new Promise((r) => setImmediate(r));
  ipc.emit("capture:reply", { sender: {} }, { id: 1, ok: true });
  ipc.emit("capture:reply", { sender: win.webContents }, { id: 99, ok: true });
  timers[0].fn();
  await assert.rejects(p, /did not answer start/);
});

test("host: system audio works on Windows only, and the loopback handler grants a screen with 'loopback' audio", async () => {
  const mac = env({ platform: "darwin" });
  await assert.rejects(
    () => mac.host.start("system", {}),
    (x: any) => x.code === "unsupported",
  );
  const win = env({ platform: "win32", sources: [{ id: "screen:1:0" }] });
  const p = win.host.start("system", {});
  await new Promise((r) => setImmediate(r));
  const w = win.wins[0];
  ipcReply(win, w, w.sent[0].id, { ok: true });
  await p;
  const h = win.getHandler();
  assert.ok(h, "handler installed on Windows");
  const granted = await new Promise((r) => h!({}, r));
  assert.deepEqual(granted, { video: { id: "screen:1:0" }, audio: "loopback" });
  assert.equal(mac.getHandler(), undefined, "no loopback handler on macOS");
});

test("host: the loopback handler answers with nothing when there is no screen source", async () => {
  const win = env({ platform: "win32", sources: [] });
  const p = win.host.start("system", {});
  await new Promise((r) => setImmediate(r));
  ipcReply(win, win.wins[0], win.wins[0].sent[0].id, { ok: true });
  await p;
  const granted = await new Promise((r) => win.getHandler()!({}, r));
  assert.deepEqual(granted, {});
});

test("host: 'ended' from the page reaches listeners once and clears the channel; a crash ends every running channel", async () => {
  const e = env({ platform: "win32" });
  const ended: [string, string][] = [];
  e.host.onEnded((ch: string, why: string) => ended.push([ch, why]));
  const start = async (ch: string) => {
    const p = e.host.start(ch, {});
    await new Promise((r) => setImmediate(r));
    const w = e.wins[0];
    ipcReply(e, w, w.sent.at(-1)!.id, { ok: true });
    await p;
  };
  await start("mic");
  await start("system");
  const w = e.wins[0];
  e.ipc.emit("capture:ended", { sender: w.webContents }, "mic", "unplugged");
  e.ipc.emit("capture:ended", { sender: w.webContents }, "mic", "again");
  assert.deepEqual(ended, [["mic", "unplugged"]]);
  w.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.deepEqual(ended.at(-1), ["system", "the capture window stopped (crashed)"]);
  assert.equal(e.host.isRunning("system"), false);
  // the next command opens a fresh window
  const next = e.host.devices();
  await new Promise((r) => setImmediate(r));
  assert.equal(e.wins.length, 2, "a new window after the crash");
  ipcReply(e, e.wins[1], e.wins[1].sent[0].id, { ok: true, devices: [], defaultName: "" });
  await next;
});

test("host: devices asks the page and returns its list; stop is quiet without a window", async () => {
  const e = env();
  await e.host.stop("mic"); // nothing was ever opened
  assert.equal(e.wins.length, 0);
  const p = e.host.devices();
  await new Promise((r) => setImmediate(r));
  const w = e.wins[0];
  assert.equal(w.sent[0].op, "devices");
  ipcReply(e, w, w.sent[0].id, { ok: true, devices: [{ index: 0, name: "A" }], defaultName: "A" });
  assert.deepEqual(await p, { devices: [{ index: 0, name: "A" }], defaultName: "A" });
});

test("permissions: grantSession lets one session keep 'media' and every other session still says no", () => {
  const mk = () => {
    const h: Record<string, (...a: any[]) => any> = {};
    return {
      h,
      setPermissionRequestHandler: (f: any) => (h.req = f),
      setPermissionCheckHandler: (f: any) => (h.check = f),
      setDevicePermissionHandler: (f: any) => (h.dev = f),
    };
  };
  const cap = mk(),
    other = mk();
  permissions.grantSession(cap, ["media"]);
  permissions.denyPermissions(cap);
  permissions.denyPermissions(other);
  const ask = (s: ReturnType<typeof mk>, p: string) => {
    let r: boolean | undefined;
    s.h.req({}, p, (x: boolean) => (r = x));
    return r;
  };
  assert.equal(ask(cap, "media"), true);
  assert.equal(ask(cap, "geolocation"), false);
  assert.equal(ask(other, "media"), false);
  assert.equal(cap.h.check({}, "media"), true);
  assert.equal(other.h.check({}, "media"), false);
});

test("host: a system start first gives the page a user gesture (getDisplayMedia needs one); a mic start does not", async () => {
  const e = env({ platform: "win32" });
  const calls: [string, boolean][] = [];
  const first = e.host.start("mic", {});
  await new Promise((r) => setImmediate(r));
  const w = e.wins[0];
  w.webContents.executeJavaScript = async (code: string, gesture: boolean) => void calls.push([code, gesture]);
  ipcReply(e, w, w.sent[0].id, { ok: true });
  await first;
  assert.deepEqual(calls, [], "no gesture for the microphone");
  const p = e.host.start("system", {});
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [["0", true]]);
  assert.equal(w.sent.at(-1)?.ch, "system", "the command is sent after the gesture");
  ipcReply(e, w, w.sent.at(-1)!.id, { ok: true });
  await p;
});

test("host: a failing gesture script does not stop the system start", async () => {
  const e = env({ platform: "win32" });
  const first = e.host.start("mic", {});
  await new Promise((r) => setImmediate(r));
  const w = e.wins[0];
  ipcReply(e, w, w.sent[0].id, { ok: true });
  await first;
  w.webContents.executeJavaScript = () => Promise.reject(new Error("gone"));
  const p = e.host.start("system", {});
  await new Promise((r) => setImmediate(r));
  ipcReply(e, w, w.sent.at(-1)!.id, { ok: true });
  assert.deepEqual(await p, { fellBack: false });
});

// ---- Explicit channel state (tray/capture-chan.cjs) ----

test("H1: a stop during the microphone prompt cancels the start; the mic is not opened after Allow", async () => {
  let allow!: () => void;
  const e = env({ mic: "not-determined", ask: true, askGate: new Promise<void>((r) => (allow = r)) });
  const starting = e.host.start("mic", {});
  const outcome = starting.then(
    () => "started",
    (x: any) => x.code,
  );
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(e.asked, ["ask"], "the prompt is open");
  assert.equal(e.wins.length, 0, "no window yet, so stop has nothing to send");
  await e.host.stop("mic"); // the engine socket closed
  allow(); // the user clicks Allow
  assert.equal(await outcome, "cancelled");
  assert.equal(e.wins.length, 0, "the window was never opened");
  assert.equal(e.host.isRunning("mic"), false);
  // the channel is usable again afterwards
  const again = env();
  const p = again.host.start("mic", {});
  await new Promise((r) => setImmediate(r));
  ipcReply(again, again.wins[0], again.wins[0].sent[0].id, { ok: true });
  await p;
  assert.equal(again.host.isRunning("mic"), true);
});

test("H1: on Windows a stop that overtakes the start gesture means the start command is never sent", async () => {
  let go!: () => void;
  const e = env({ platform: "win32", execGate: new Promise<void>((r) => (go = r)) });
  const starting = e.host.start("system", {});
  const outcome = starting.then(
    () => "started",
    (x: any) => x.code,
  );
  await new Promise((r) => setImmediate(r));
  const w = e.wins[0];
  const stopping = e.host.stop("system");
  await new Promise((r) => setImmediate(r));
  ipcReply(e, w, w.sent.find((c) => c.op === "stop")!.id, { ok: true });
  await stopping;
  go();
  assert.equal(await outcome, "cancelled");
  assert.deepEqual(
    w.sent.map((c) => c.op),
    ["stop"],
    "no start reached the page after the stop",
  );
  assert.equal(e.host.isRunning("system"), false);
});

test("H1: a stop while the page is still starting leaves the channel stopped", async () => {
  const e = env();
  const starting = e.host.start("mic", {});
  const outcome = starting.then(
    () => "started",
    (x: any) => x.code,
  );
  await new Promise((r) => setImmediate(r));
  const w = e.wins[0];
  const startCmd = w.sent[0];
  const stopping = e.host.stop("mic");
  await new Promise((r) => setImmediate(r));
  ipcReply(e, w, startCmd.id, { ok: true });
  ipcReply(e, w, w.sent.find((c) => c.op === "stop")!.id, { ok: true });
  await stopping;
  assert.equal(await outcome, "cancelled");
  assert.equal(e.host.isRunning("mic"), false);
});

test("M9: a capture window that fails to load is destroyed, and a retry opens a fresh one", async () => {
  const e = env({ loadFails: true });
  for (let i = 0; i < 3; i++)
    await assert.rejects(
      () => e.host.start("mic", {}),
      (x: any) => x.code === "failed" && /did not load/.test(x.message),
    );
  assert.equal(e.wins.length, 3);
  assert.ok(
    e.wins.every((w) => w.destroyed),
    "no hidden window is left behind",
  );
  assert.equal(e.host.isRunning("mic"), false);
});
