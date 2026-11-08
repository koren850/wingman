// Starting the live audio sources without losing the ability to stop them. The stoppers are registered BEFORE any start is awaited (a Stop pressed during
// a slow start must find them), each start has a timeout (a hung AudioTee start must not hang the engine), and a Stop that arrived meanwhile closes both.
type Startable = { start(): Promise<void> };

export type StartSourcesOpts = {
  sys?: Startable;
  mic: Startable;
  /** Closes the sources; pushed to `stops` first. Must be safe to call twice and before a start finished. */
  stoppers: (() => Promise<unknown> | unknown)[];
  stops: (() => Promise<unknown>)[];
  isStopping: () => boolean;
  timeoutMs: number;
  onTimeout?: (name: "sys" | "mic") => void;
  onError?: (name: "sys" | "mic", e: unknown) => void;
  /** Called once the mic start has returned, timed out or failed (not when a Stop got in first). */
  onMicStarted?: () => void;
};

/** Resolves true when the call goes on, false when Stop came first (the sources are closed then). */
export async function startSources(o: StartSourcesOpts): Promise<boolean> {
  const closeAll = async () => {
    for (const s of o.stoppers) await Promise.resolve(s()).catch(() => {});
  };
  o.stops.push(...o.stoppers.map((s) => async () => void (await s())));
  if (o.isStopping()) {
    await closeAll();
    return false;
  }
  const run = (name: "sys" | "mic", s?: Startable) => {
    if (!s) return Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((res) => {
      timer = setTimeout(() => {
        o.onTimeout?.(name);
        res();
      }, o.timeoutMs);
      timer.unref();
    });
    return Promise.race([s.start().catch((e) => o.onError?.(name, e)), limit]).finally(() => clearTimeout(timer));
  };
  // In parallel: a tap that takes 8 s to start must not hold the mic back.
  await Promise.all([run("sys", o.sys), run("mic", o.mic).then(() => !o.isStopping() && o.onMicStarted?.())]);
  if (o.isStopping()) {
    await closeAll();
    return false;
  }
  return true;
}
