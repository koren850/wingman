// A5: AirPods/Bluetooth headsets drop to a low-quality call profile when the mic opens, so the transcript gets worse.
// Reads the default input/output devices from macOS (system_profiler, ~0.3 s) and flags Bluetooth ones.
import { execFile } from "node:child_process";

export type AudioDevice = { name: string; transport: string; defaultInput: boolean; defaultOutput: boolean };

/** Parses `system_profiler SPAudioDataType -json` output. Bad JSON gives []. */
export function parseAudioDevices(json: string): AudioDevice[] {
  let d: any;
  try { d = JSON.parse(json); } catch { return []; }
  const out: AudioDevice[] = [];
  for (const g of d?.SPAudioDataType ?? []) for (const it of g?._items ?? []) {
    out.push({
      name: String(it._name ?? ""),
      transport: String(it.coreaudio_device_transport ?? ""),
      defaultInput: it.coreaudio_default_audio_input_device === "spaudio_yes",
      defaultOutput: it.coreaudio_default_audio_output_device === "spaudio_yes",
    });
  }
  return out;
}

// Name guess for Bluetooth gear that reports no transport; built-in/USB devices with such a word in their name are not flagged.
const BT_NAME = /airpods|beats|buds|bose|jabra|sony wh|sony wf|bluetooth|headset/i;
export const isBluetooth = (d: AudioDevice) => /bluetooth/i.test(d.transport) || (BT_NAME.test(d.name) && !/builtin|usb/i.test(d.transport));

/** The Bluetooth device in use for the mic (worst case) or for the speakers, if any. */
export function bluetoothInUse(devs: AudioDevice[]): { device: AudioDevice; role: "mic" | "output" } | undefined {
  const mic = devs.find((d) => d.defaultInput && isBluetooth(d));
  if (mic) return { device: mic, role: "mic" };
  const outp = devs.find((d) => d.defaultOutput && isBluetooth(d));
  return outp ? { device: outp, role: "output" } : undefined;
}

/** Runs system_profiler (macOS only). Any failure or timeout gives [] so a startup check never blocks a call. */
export function readAudioDevices(timeoutMs = 4000): Promise<AudioDevice[]> {
  return new Promise((res) => {
    if (process.platform !== "darwin") return res([]);
    execFile("system_profiler", ["SPAudioDataType", "-json"], { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout) => res(err ? [] : parseAudioDevices(stdout)));
  });
}
