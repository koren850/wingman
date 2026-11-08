// The app's audio capture seen from the engine: tray/capture-bridge.cjs served over a real local socket with a fake capture window,
// and src/capture-client.ts (CaptureLink, BridgeSource) as the client. No Electron and no hardware.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createRequire } from "node:module";
import { fakeCaptureHost, type FakeHost } from "./testkit/fake-capture-host.ts";
import { CaptureLink, BridgeSource, CaptureError, captureLinkFromEnv } from "./capture-client.ts";
import { SupervisedSource, peakOf } from "./audio.ts";
import { appBackend, backendFor, micNameOf } from "./audio-platform.ts";
import wire from "../shared/capture-wire.cjs";

const { createCaptureBridge } = createRequire(import.meta.url)("../tray/capture-bridge.cjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(hostOpts = {}) {
  const host = fakeCaptureHost(hostOpts);
  const bridge = createCaptureBridge({ host });
  await bridge.listen();
  const env = bridge.env() as { WINGMAN_CAPTURE_ENDPOINT: string; WINGMAN_CAPTURE_TOKEN: string };
  const link = new CaptureLink(env.WINGMAN_CAPTURE_ENDPOINT, env.WINGMAN_CAPTURE_TOKEN);
  const done = async () => {
    link.close();
    await bridge.close();
    host.destroy();
  };
  return { host, bridge, env, link, done };
}

test("bridge: a mic source follows the AudioSource contract (whole s16le samples, nothing after stop, stop twice is fine)", async () => {
  const t = await setup();
  try {
    const src = new BridgeSource(t.link, "mic");
    const chunks: Buffer[] = [],
      errors: Error[] = [];
    src.on("pcm", (b: Buffer) => chunks.push(b));
    src.on("error", (e: Error) => errors.push(e));
    await src.start();
    await sleep(450);
    await src.stop();
    const seen = chunks.length;
    assert.ok(seen >= 3, `chunks arrive (${seen})`);
    for (const c of chunks) assert.equal(c.length % 2, 0);
    assert.ok(src.peak > 0.2 && src.peak <= 1, `peak ${src.peak}`);
    await src.stop();
    await sleep(300);
    assert.equal(chunks.length, seen, "no pcm after stop()");
    assert.deepEqual(errors, []);
    assert.ok(!t.host.running("mic"), "the capture stopped");
  } finally {
    await t.done();
  }
});

test("bridge: mic and system are separate channels", async () => {
  const t = await setup();
  try {
    const mic = new BridgeSource(t.link, "mic"),
      sys = new BridgeSource(t.link, "system");
    let m = 0,
      s = 0;
    mic.on("pcm", () => m++);
    sys.on("pcm", () => s++);
    await mic.start();
    await sleep(350);
    assert.ok(m >= 2 && s === 0, `only the mic runs (m=${m}, s=${s})`);
    await sys.start();
    await sleep(350);
    assert.ok(s >= 2, "system audio runs too");
    await mic.stop();
    const sBefore = s;
    await sleep(250);
    assert.ok(s > sBefore, "system audio goes on after the mic stopped");
    await sys.stop();
  } finally {
    await t.done();
  }
});

test("bridge: the saved microphone name travels to the capture window; a missing one reports the fallback", async () => {
  const t = await setup();
  try {
    const seen: (string | undefined)[] = [];
    const a = new BridgeSource(t.link, "mic", "Fake Headset", (m) => seen.push(m));
    await a.start();
    await a.stop();
    const b = new BridgeSource(t.link, "mic", "Gone Mic", (m) => seen.push(m));
    await b.start();
    await b.stop();
    assert.deepEqual(seen, [undefined, "Gone Mic"]);
    assert.ok(t.host.calls.includes("start mic Fake Headset") && t.host.calls.includes("start mic Gone Mic"));
  } finally {
    await t.done();
  }
});

test("bridge: appBackend takes the name from the saved setting (':2|Name')", async () => {
  const t = await setup();
  try {
    const backend = appBackend(t.link, "win32");
    assert.equal(backend.resolvesDevices, true);
    const mic = backend.createMic(":2|Fake Headset");
    await mic.start();
    await mic.stop();
    assert.ok(t.host.calls.includes("start mic Fake Headset"), t.host.calls.join(","));
    const def = backend.createMic(":default");
    await def.start();
    await def.stop();
    assert.ok(t.host.calls.includes("start mic"), "no name: the default microphone");
    assert.ok(backend.createSystem("audiotee", "") instanceof BridgeSource, "Windows system audio comes from the app");
  } finally {
    await t.done();
  }
});

test("bridge: micNameOf reads the name from a saved setting, a bare name, or gives '' for the default", () => {
  assert.equal(micNameOf(":2|USB Mic"), "USB Mic");
  assert.equal(micNameOf("USB Mic"), "USB Mic");
  assert.equal(micNameOf(":USB Mic"), "USB Mic");
  assert.equal(micNameOf(":default"), "");
  assert.equal(micNameOf(":1"), "");
  assert.equal(micNameOf(""), "");
  assert.equal(micNameOf("default"), "");
});

test("bridge: errors carry a code (permission, no-device, busy) and the source rejects start with it", async () => {
  const t = await setup();
  try {
    for (const code of ["permission", "no-device", "busy"]) {
      t.host.failNext.mic = { code, message: `fake ${code}` };
      const src = new BridgeSource(t.link, "mic");
      await assert.rejects(
        () => src.start(),
        (e: unknown) => e instanceof CaptureError && e.code === code && e.message === `fake ${code}`,
      );
    }
    const ok = new BridgeSource(t.link, "mic");
    await ok.start(); // the failure was consumed: the next start works
    await ok.stop();
  } finally {
    await t.done();
  }
});

test("bridge: a device that drops while recording raises 'error' once; the supervisor restarts it and frames flow again", async () => {
  const t = await setup();
  try {
    const sup = new SupervisedSource({ name: "mic", make: () => new BridgeSource(t.link, "mic"), backoff: () => 50, stallMs: 0 });
    let frames = 0;
    const downs: { code?: string }[] = [];
    sup.on("pcm", () => frames++);
    sup.on("down", (d) => downs.push(d));
    await sup.start();
    await sleep(350);
    assert.ok(frames >= 2);
    t.host.drop("mic");
    await sleep(100);
    assert.equal(downs.length, 1, "one down");
    const at = frames;
    await sleep(500);
    assert.ok(frames > at + 2, "frames flow again after the restart");
    assert.ok(!sup.down);
    await sup.stop();
  } finally {
    await t.done();
  }
});

test("bridge: a permission failure reaches the supervisor's down event with its code", async () => {
  const t = await setup();
  try {
    t.host.failNext.mic = { code: "permission", message: "blocked", keep: true };
    const sup = new SupervisedSource({ name: "mic", make: () => new BridgeSource(t.link, "mic"), backoff: () => 5000, stallMs: 0 });
    const downs: { code?: string; reason: string }[] = [];
    sup.on("down", (d) => downs.push(d));
    await sup.start();
    assert.equal(downs[0]?.code, "permission");
    assert.match(downs[0].reason, /blocked/);
    await sup.stop();
  } finally {
    await t.done();
  }
});

test("bridge: a stop from a replaced source does not stop its successor", async () => {
  const t = await setup();
  try {
    const first = new BridgeSource(t.link, "mic");
    await first.start();
    const second = new BridgeSource(t.link, "mic");
    await second.start(); // the supervisor builds the new one before the old one has finished stopping
    let n = 0;
    second.on("pcm", () => n++);
    await first.stop();
    await sleep(350);
    assert.ok(n >= 2, "the second source still records");
    assert.ok(t.host.running("mic"));
    await second.stop();
    assert.ok(!t.host.running("mic"));
  } finally {
    await t.done();
  }
});

test("bridge: the capture stops when the engine disconnects", async () => {
  const t = await setup();
  try {
    const src = new BridgeSource(t.link, "mic");
    src.on("error", () => {});
    await src.start();
    assert.ok(t.host.running("mic"));
    t.link.close();
    await sleep(150);
    assert.ok(!t.host.running("mic"), "no recording without a listener");
  } finally {
    await t.done();
  }
});

test("bridge: the engine sees 'error' when the app side closes", async () => {
  const t = await setup();
  try {
    const src = new BridgeSource(t.link, "mic");
    const errors: Error[] = [];
    src.on("error", (e) => errors.push(e));
    await src.start();
    await t.bridge.close();
    await sleep(100);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /closed/);
  } finally {
    await t.done();
  }
});

test("bridge: devices are listed through the same link", async () => {
  const t = await setup({ devices: ["Desk Mic", "USB Headset"] });
  try {
    const r = await t.link.devices();
    assert.deepEqual(r.devices, [
      { index: 0, name: "Desk Mic" },
      { index: 1, name: "USB Headset" },
    ]);
    assert.equal(r.defaultName, "Desk Mic");
  } finally {
    await t.done();
  }
});

test("bridge: a wrong token is refused and gets no audio", async () => {
  const t = await setup();
  try {
    const bad = new CaptureLink(t.env.WINGMAN_CAPTURE_ENDPOINT, "not-the-token");
    await assert.rejects(() => bad.connect());
    await new Promise<void>((resolve) => {
      // And a raw client that skips the hello never gets an answer to a command.
      const s = net.createConnection(t.env.WINGMAN_CAPTURE_ENDPOINT, () => s.write(wire.encodeJson({ op: "start", ch: "mic", id: 1 })));
      let got = 0;
      s.on("data", () => got++);
      s.on("close", () => {
        assert.equal(got, 0);
        resolve();
      });
    });
    assert.ok(!t.host.running("mic"));
  } finally {
    await t.done();
  }
});

test("bridge: a garbage frame drops the connection and the bridge keeps serving", async () => {
  const t = await setup();
  try {
    await new Promise<void>((resolve) => {
      const s = net.createConnection(t.env.WINGMAN_CAPTURE_ENDPOINT, () => s.write(Buffer.from([9, 1, 0, 0, 0, 0])));
      s.on("close", () => resolve());
      s.on("error", () => {});
    });
    const src = new BridgeSource(t.link, "mic");
    await src.start();
    await src.stop();
  } finally {
    await t.done();
  }
});

test("bridge: captureLinkFromEnv needs the endpoint and token, and WINGMAN_MIC_ENGINE=ffmpeg switches it off", () => {
  assert.equal(captureLinkFromEnv({}), undefined);
  assert.equal(captureLinkFromEnv({ WINGMAN_CAPTURE_ENDPOINT: "/x" }), undefined);
  const env = { WINGMAN_CAPTURE_ENDPOINT: "/x/s", WINGMAN_CAPTURE_TOKEN: "t" };
  assert.ok(captureLinkFromEnv(env) instanceof CaptureLink);
  assert.equal(captureLinkFromEnv({ ...env, WINGMAN_MIC_ENGINE: "ffmpeg" }), undefined);
  assert.equal(backendFor("darwin", {}).resolvesDevices, undefined, "no bridge: the ffmpeg backend");
  assert.equal(backendFor("win32", env).resolvesDevices, true, "bridge: the app backend");
});

test("bridge: peakOf agrees with the level of the fake recording", async () => {
  const t = await setup();
  try {
    t.host.level = 0.5;
    const src = new BridgeSource(t.link, "mic");
    await src.start();
    await sleep(300);
    await src.stop();
    const p = src.peak;
    assert.ok(Math.abs(p - 0.5) < 0.05, `peak ${p}`);
    assert.ok(peakOf(Buffer.alloc(4)) === 0);
  } finally {
    await t.done();
  }
});

export type { FakeHost };

test("bridge: a second program starting the same channel ends the first one with a clear reason, and the first one's stop leaves the second running", async () => {
  const t = await setup();
  try {
    const other = new CaptureLink(t.env.WINGMAN_CAPTURE_ENDPOINT, t.env.WINGMAN_CAPTURE_TOKEN);
    const a = new BridgeSource(t.link, "mic");
    const errors: Error[] = [];
    a.on("error", (e: Error) => errors.push(e));
    await a.start();
    const b = new BridgeSource(other, "mic");
    await b.start();
    await sleep(100);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /another program took over/);
    await a.stop();
    await sleep(250);
    assert.ok(t.host.running("mic"), "the newer owner keeps the microphone");
    await b.stop();
    other.close();
  } finally {
    await t.done();
  }
});

test("bridge: a client that connects and says nothing is dropped after the hello time limit", async () => {
  const t = await setup();
  try {
    const t0 = Date.now();
    await new Promise<void>((resolve) => {
      const s = net.createConnection(t.env.WINGMAN_CAPTURE_ENDPOINT);
      s.on("close", () => resolve());
      s.on("error", () => {});
    });
    assert.ok(Date.now() - t0 >= 2500, "waited for the hello");
  } finally {
    await t.done();
  }
});

test("bridge: a start on a closed link fails with a coded error instead of hanging", async () => {
  const t = await setup();
  await t.done();
  const dead = new CaptureLink(t.env.WINGMAN_CAPTURE_ENDPOINT, t.env.WINGMAN_CAPTURE_TOKEN);
  const src = new BridgeSource(dead, "mic");
  await assert.rejects(
    () => src.start(),
    (e: Error) => e instanceof CaptureError && e.code === "failed",
  );
  await src.stop();
});

test("bridge: a source stopped while its start is still waiting does not leave the capture running", async () => {
  const t = await setup();
  try {
    const src = new BridgeSource(t.link, "mic");
    const starting = src.start();
    const stopping = src.stop();
    await Promise.allSettled([starting, stopping]);
    await sleep(200);
    assert.ok(!t.host.running("mic"));
  } finally {
    await t.done();
  }
});
