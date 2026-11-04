// Child process for the Wingman window (dashboard/setup-ipc.cjs): prints {ok, devices:[{index,name}], defaultInput} as one JSON line.
import { listInputDevices, readAudioDevices } from "./devices.ts";
const [devices, sys] = await Promise.all([listInputDevices(), readAudioDevices()]);
process.stdout.write(JSON.stringify({ ok: true, devices, defaultInput: sys.find((d) => d.defaultInput)?.name ?? "" }) + "\n");
