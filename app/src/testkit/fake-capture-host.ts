// A stand-in for the app's capture window (tray/capture-host.cjs) in tests: same small interface, no Electron, no hardware.
// It "records" a sine wave for every started channel, 100 ms per chunk, and can be told to fail, to fall back or to drop.
export type FakeHost = ReturnType<typeof fakeCaptureHost>;
type Ch = "mic" | "system";
type Cb<T extends unknown[]> = (...a: T) => void;

export function fakeCaptureHost(o: { devices?: string[]; chunkMs?: number } = {}) {
  const pcmCbs = new Set<Cb<[Ch, Buffer]>>(),
    endCbs = new Set<Cb<[Ch, string]>>();
  const timers: Partial<Record<Ch, NodeJS.Timeout>> = {};
  const calls: string[] = []; // "start mic Name", "stop mic"
  const h = {
    calls,
    /** A coded failure for the next start of a channel (consumed once, or kept with `keep`). */
    failNext: {} as Partial<Record<Ch, { code: string; message: string; keep?: boolean }>>,
    names: o.devices ?? ["Fake Microphone", "Fake Headset"],
    /** Level of the sine, 0-1. */
    level: 0.25,
    async start(ch: Ch, opts: { name?: string } = {}) {
      calls.push(`start ${ch} ${opts.name ?? ""}`.trim());
      const f = h.failNext[ch];
      if (f) {
        if (!f.keep) delete h.failNext[ch];
        throw Object.assign(new Error(f.message), { code: f.code });
      }
      clearInterval(timers[ch]);
      const n = Math.round(16 * (o.chunkMs ?? 100));
      let phase = 0;
      timers[ch] = setInterval(() => {
        const b = Buffer.alloc(n * 2);
        for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(h.level * 32767 * Math.sin(++phase / 8)), i * 2);
        for (const cb of pcmCbs) cb(ch, b);
      }, o.chunkMs ?? 100);
      timers[ch]!.unref();
      const name = opts.name ?? "";
      return { fellBack: !!name && !h.names.some((d) => d.toLowerCase().includes(name.toLowerCase())) };
    },
    async stop(ch: Ch) {
      calls.push(`stop ${ch}`);
      clearInterval(timers[ch]);
      delete timers[ch];
    },
    async devices() {
      return { devices: h.names.map((name, index) => ({ index, name })), defaultName: h.names[0] ?? "" };
    },
    onPcm(cb: Cb<[Ch, Buffer]>) {
      pcmCbs.add(cb);
      return () => pcmCbs.delete(cb);
    },
    onEnded(cb: Cb<[Ch, string]>) {
      endCbs.add(cb);
      return () => endCbs.delete(cb);
    },
    /** The device vanishes while recording. */
    drop(ch: Ch, reason = "the audio device stopped") {
      clearInterval(timers[ch]);
      delete timers[ch];
      for (const cb of endCbs) cb(ch, reason);
    },
    running: (ch: Ch) => !!timers[ch],
    destroy() {
      for (const t of Object.values(timers)) clearInterval(t);
    },
  };
  return h;
}
