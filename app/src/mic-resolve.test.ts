// The mic is saved by name and index (":2|Name") and checked again at every start: indexes move when a headset or a USB mic connects.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { avDevice, parseMicSetting, resolveMicSetting, pickMicDevice } from "./audio.ts";

const require = createRequire(import.meta.url);
const setup = require("../dashboard/setup-ipc.cjs");

const before = [
  { index: 0, name: "MacBook Pro Microphone" },
  { index: 1, name: "External USB Microphone" },
];
// a headset connected: the USB mic is now number 2
const after = [
  { index: 0, name: "MacBook Pro Microphone" },
  { index: 1, name: "Dan's AirPods Pro" },
  { index: 2, name: "External USB Microphone" },
];

test("a mic whose index moved is found again by its name", () => {
  const saved = ":1|External USB Microphone";
  assert.deepEqual(resolveMicSetting(saved, before), { device: ":1", name: "External USB Microphone" });
  const r = resolveMicSetting(saved, after);
  assert.equal(r.device, ":2");
  assert.equal(r.moved, true);
  assert.equal(pickMicDevice(r.device, [], 0), ":2", "the moved index is what ffmpeg opens");
});

test("a mic whose name is gone falls back to the default and says so", () => {
  const r = resolveMicSetting(":1|Studio Mic", after);
  assert.equal(r.gone, true);
  assert.equal(r.device, ":default");
});

test("old settings and unreadable lists are used as they are", () => {
  assert.deepEqual(resolveMicSetting(":1", after), { device: ":1", name: undefined });
  assert.deepEqual(resolveMicSetting("BlackHole 2ch", after), { device: "BlackHole 2ch", name: undefined });
  assert.deepEqual(resolveMicSetting(":1|Studio Mic", []), { device: ":1", name: "Studio Mic" }, "no device list: do not guess");
});

test("avDevice and parseMicSetting ignore the saved name", () => {
  assert.equal(avDevice(":2|External USB Microphone"), ":2");
  assert.deepEqual(parseMicSetting(":2|A|B"), { device: ":2", name: "A|B" });
  assert.deepEqual(parseMicSetting(":default"), { device: ":default" });
});

test("setup:setMic saves the device name next to the index", async () => {
  const handlers = new Map<string, (...a: unknown[]) => Promise<unknown>>();
  const writes: string[] = [];
  setup.register({
    handle: (n: string, fn: (...a: unknown[]) => Promise<unknown>) => handlers.set(n, fn),
    child: async (args: string[], input?: string) => {
      if (args[0] === "src/mics-cli.ts") return { ok: true, devices: after };
      writes.push(String(input));
      return { ok: true };
    },
    root: "/x",
    home: "/x",
    env: {},
    systemPreferences: {},
    shell: {},
    screen: { getAllDisplays: () => [] },
    preview: false,
  });
  await handlers.get("setup:setMic")!(":2");
  await handlers.get("setup:setMic")!(":9"); // not in the list: the index alone
  await handlers.get("setup:setMic")!(":default");
  assert.deepEqual(
    writes.map((w) => JSON.parse(w)["audio.mic.device"]),
    [":2|External USB Microphone", ":9", ":default"],
  );
  assert.equal(setup.withMicName(":1", [{ index: 1, name: "A|B\nC" }]), ":1|A B C", "control characters and the separator are cleaned");
});
