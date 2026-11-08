"use strict";
// Serves the app's audio capture (tray/capture-host.cjs) to the engine process over a local socket.
// The engine is a separate process (src/call.ts). It asks for the microphone or the system audio here and gets 16 kHz mono PCM back,
// so the engine needs no ffmpeg. Wire format: shared/capture-wire.cjs. Client: src/capture-client.ts.
// Safety: a Unix socket in a private folder (700, socket 600) or a per-user named pipe on Windows, a random token in the first frame
// (passed to the engine in its environment), a 3 s limit for that first frame, and a small fixed list of commands. No audio is stored.
// No electron import: unit-tested in src/capture-bridge.test.ts with a fake host.
const nodeFs = require("node:fs");
const nodeOs = require("node:os");
const nodePath = require("node:path");
const nodeNet = require("node:net");
const nodeCrypto = require("node:crypto");
const pipes = require("../shared/pipe.cjs");
const wire = require("../shared/capture-wire.cjs");

const HELLO_TIMEOUT_MS = 3000;
/** More than this waiting to be written means the engine stopped reading: audio is dropped instead of piling up (about 12 s of PCM). */
const MAX_BACKLOG = 400_000;

/**
 * o: { host, platform?, token?, name?, log? }. `host` is the object from createCaptureHost.
 * Returns { listen(), close(), env() }. env() = what the engine needs to find this bridge.
 */
function createCaptureBridge(o) {
  const platform = o.platform || process.platform;
  const log = o.log || (() => {});
  const token = o.token || nodeCrypto.randomBytes(16).toString("hex");
  const id = nodeCrypto.randomBytes(4).toString("hex");
  let dir, endpoint, server;
  const conns = new Set();
  const owner = { mic: undefined, system: undefined }; // channel -> the connection that started it
  const seqOf = { mic: undefined, system: undefined }; // channel -> the "seq" of its latest start; a stop for an older source is ignored

  const send = (sock, obj) => {
    if (!sock.destroyed) sock.write(wire.encodeJson(obj));
  };

  const unsub = [
    o.host.onPcm((ch, pcm) => {
      const sock = owner[ch];
      if (!sock || sock.destroyed || sock.writableLength > MAX_BACKLOG) return;
      sock.write(wire.encodePcm(ch, pcm));
    }),
    o.host.onEnded((ch, reason) => {
      const sock = owner[ch];
      owner[ch] = undefined;
      if (sock) send(sock, { ev: "ended", ch, reason });
    }),
  ];

  async function release(sock) {
    for (const ch of wire.CHANNELS)
      if (owner[ch] === sock) {
        owner[ch] = undefined;
        await o.host.stop(ch).catch(() => {});
      }
  }

  async function handle(sock, msg) {
    const reply = (extra) => send(sock, { id: msg.id, ...extra });
    const bad = (code, message) => reply({ ev: "error", ch: msg.ch, code, message });
    if (msg.op === "devices") {
      try {
        reply({ ev: "devices", ...(await o.host.devices()) });
      } catch (e) {
        bad(e.code || "failed", String(e.message));
      }
      return;
    }
    if (!wire.CHANNELS.includes(msg.ch)) return bad("failed", "unknown channel");
    if (msg.op === "start") {
      const before = owner[msg.ch];
      owner[msg.ch] = sock;
      seqOf[msg.ch] = msg.seq;
      if (before && before !== sock) send(before, { ev: "ended", ch: msg.ch, reason: "another program took over the audio capture" });
      try {
        const r = await o.host.start(msg.ch, { name: typeof msg.name === "string" ? msg.name : "" });
        if (owner[msg.ch] !== sock) return; // a newer start or a stop came meanwhile
        reply({ ev: "started", ch: msg.ch, fellBack: !!r.fellBack });
      } catch (e) {
        if (owner[msg.ch] === sock) owner[msg.ch] = undefined;
        log(`capture start ${msg.ch} failed: ${e.code || ""} ${e.message}`);
        bad(e.code || "failed", String(e.message));
      }
    } else if (msg.op === "stop") {
      // A source that is replaced (restart after a drop) stops after the new one asked to start: only its own latest start can be stopped.
      if (owner[msg.ch] === sock && (msg.seq === undefined || msg.seq === seqOf[msg.ch])) {
        owner[msg.ch] = undefined;
        await o.host.stop(msg.ch).catch(() => {});
      }
      reply({ ev: "stopped", ch: msg.ch });
    } else bad("failed", "unknown command");
  }

  function onConnection(sock) {
    if (conns.size >= 8) return sock.destroy();
    conns.add(sock);
    const dec = wire.createDecoder();
    let authed = false;
    const timer = setTimeout(() => {
      if (!authed) sock.destroy();
    }, HELLO_TIMEOUT_MS);
    timer.unref();
    let chain = Promise.resolve(); // commands of one connection run in order
    sock.on("data", (chunk) => {
      let frames;
      try {
        frames = dec.push(chunk);
      } catch {
        return sock.destroy();
      }
      for (const f of frames) {
        const m = f.json;
        if (!m || typeof m !== "object") return sock.destroy(); // a client never sends PCM
        if (!authed) {
          const a = Buffer.from(String(m.token || "")),
            b = Buffer.from(token);
          if (m.op !== "hello" || a.length !== b.length || !nodeCrypto.timingSafeEqual(a, b)) return sock.destroy();
          authed = true;
          clearTimeout(timer);
          send(sock, { ev: "hello", ok: true });
          continue;
        }
        chain = chain.then(() => handle(sock, m)).catch((e) => log(`capture bridge: ${e && e.message}`));
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      clearTimeout(timer);
      conns.delete(sock);
      void release(sock);
    });
  }

  return {
    /** Starts listening. Resolves when the endpoint is ready. */
    listen() {
      if (pipes.usesPipes(platform)) endpoint = pipes.pipeName(`capture-${id}`);
      else {
        dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "wm-cap-")); // mkdtemp makes it 700
        endpoint = nodePath.join(dir, "s");
      }
      server = nodeNet.createServer(onConnection);
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, () => {
          server.removeListener("error", reject);
          server.on("error", (e) => log(`capture bridge: ${e.message}`));
          if (dir)
            try {
              nodeFs.chmodSync(endpoint, 0o600);
            } catch {
              /* the folder is already private */
            }
          resolve(endpoint);
        });
      });
    },
    /** Environment variables that let the engine (and the doctor) reach this bridge. Empty before listen(). */
    env() {
      return endpoint ? { WINGMAN_CAPTURE_ENDPOINT: endpoint, WINGMAN_CAPTURE_TOKEN: token } : {};
    },
    async close() {
      for (const u of unsub) u();
      for (const s of conns) s.destroy();
      conns.clear();
      for (const ch of wire.CHANNELS) {
        owner[ch] = undefined;
        await o.host.stop(ch).catch(() => {});
      }
      await new Promise((r) => (server ? server.close(() => r(undefined)) : r(undefined)));
      if (dir)
        try {
          nodeFs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
    },
  };
}

module.exports = { createCaptureBridge, HELLO_TIMEOUT_MS, MAX_BACKLOG };
