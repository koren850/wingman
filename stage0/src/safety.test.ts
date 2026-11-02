import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAudioDevices, bluetoothInUse } from "./devices.ts";
import { securePerms } from "./env.ts";

const sp = (items: any[]) => JSON.stringify({ SPAudioDataType: [{ _items: items }] });

test("bluetooth: AirPods as default mic is flagged as mic; built-in is fine", () => {
  const devs = parseAudioDevices(sp([
    { _name: "Dan's AirPods Pro", coreaudio_default_audio_input_device: "spaudio_yes", coreaudio_device_transport: "coreaudio_device_type_bluetooth" },
    { _name: "MacBook Air Speakers", coreaudio_default_audio_output_device: "spaudio_yes", coreaudio_device_transport: "coreaudio_device_type_builtin" },
  ]));
  assert.equal(bluetoothInUse(devs)?.role, "mic");
  const ok = parseAudioDevices(sp([
    { _name: "MacBook Air Microphone", coreaudio_default_audio_input_device: "spaudio_yes", coreaudio_device_transport: "coreaudio_device_type_builtin" },
    { _name: "AirPods", coreaudio_device_transport: "coreaudio_device_type_bluetooth" },   // connected but not in use
  ]));
  assert.equal(bluetoothInUse(ok), undefined);
  const out = parseAudioDevices(sp([{ _name: "Bose QC", coreaudio_default_audio_output_device: "spaudio_yes", coreaudio_device_transport: "coreaudio_device_type_bluetooth" }]));
  assert.equal(bluetoothInUse(out)?.role, "output");
  assert.deepEqual(parseAudioDevices("not json"), []);
});

test("keys file: too-open permissions are fixed to 600", () => {
  const f = join(mkdtempSync(join(tmpdir(), "wm-keys-")), "keys.env");
  writeFileSync(f, "DEEPGRAM_API_KEY=x\n"); chmodSync(f, 0o644);
  assert.equal(securePerms(f), "fixed");
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(securePerms(f), "ok");
  assert.equal(securePerms(f + ".nope"), "missing");
});
