// Second path from the engine to the answer window (call.ts <-> run.ts <-> overlay/main.cjs), used when writing cards.jsonl fails.
//   call.ts listens on a private unix socket (WINGMAN_OVERLAY_SOCK, in a 0700 temp folder); run.ts writes every cards row to it as one JSON line;
//   call.ts forwards each line to the window's stdin; the window de-duplicates against what it read from disk. (A plain extra stdio fd does not
//   survive the tsx launcher, hence the socket.) call.ts keeps the last rows so a restarted window
//   gets them again. Pure helpers live here so tests can run them without processes.
import type { Writable } from "node:stream";
import { connect, createServer, type Socket, type Server } from "node:net";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import pipe from "../shared/pipe.cjs";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";

/** Splits a byte stream into lines; a partial last line waits for the next chunk. Lines over `max` chars are dropped. */
export class LineSplitter {
  private rest = "";
  private skipping = false; // inside an oversize line that was dropped: ignore up to its newline
  private decoder = new StringDecoder("utf8"); // a multi-byte character split across chunks stays whole
  constructor(private max = 1_000_000) {}
  push(chunk: Buffer | string): string[] {
    this.rest += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const parts = this.rest.split("\n");
    this.rest = parts.pop() ?? "";
    if (this.skipping) {
      parts.shift();
      this.skipping = false;
    } // the tail of a dropped line is not a line
    if (this.rest.length > this.max) {
      this.rest = "";
      this.skipping = true;
    }
    return parts.filter((l) => l.trim() && l.length <= this.max);
  }
}

/** Forwards lines to whatever window is current and remembers the last `keep` lines for a window that restarts. */
export class RowRelay {
  private ring: string[] = [];
  private sink?: Pick<Writable, "write" | "writable" | "destroyed">;
  private lines = new LineSplitter();
  private lastMemory?: string; // the newest memory view row: kept apart from the ring so a flood of card rows cannot push it out
  constructor(private keep = 300) {}
  /** A (new) window: it receives the remembered lines first. */
  attach(sink: Pick<Writable, "write" | "writable" | "destroyed">) {
    this.sink = sink;
    for (const l of this.ring) this.send(l);
    if (this.lastMemory) this.send(this.lastMemory); // a restarted window sees the current memory view again
  }
  detach() {
    this.sink = undefined;
  }
  /** Bytes from the engine's pipe. */
  feed(chunk: Buffer | string) {
    for (const l of this.lines.push(chunk)) {
      if (isMemoryRow(l)) {
        this.lastMemory = l;
        this.send(l);
        continue;
      }
      this.ring.push(l);
      if (this.ring.length > this.keep) this.ring.shift();
      this.send(l);
    }
  }
  private send(l: string) {
    const s = this.sink;
    if (!s || !s.writable || s.destroyed) return;
    try {
      s.write(l + "\n", () => {});
    } catch {
      /* window gone: the next attach replays */
    }
  }
  get remembered() {
    return this.ring.length;
  }
}

/** A `{type:"memory", view}` row (engine/out.ts emitMemoryView). Cheap check on the text; the window validates the content. */
export const isMemoryRow = (line: string): boolean => /^\s*\{\s*"type"\s*:\s*"memory"/.test(line) || /"type"\s*:\s*"memory"[,}]/.test(line.slice(0, 80));

/** Answer-window restart budget that heals: a window that stayed up `stableMs` starts counting from zero again. */
export function nextRestartCount(restarts: number, upMs: number, stableMs = 10 * 60_000): number {
  return upMs >= stableMs ? 0 : restarts;
}

/** call.ts side: listens on a private socket and feeds everything received into `relay`. close() removes the socket folder. */
export function listenForRows(relay: RowRelay, platform: string = process.platform): { path: string; server: Server; close: () => void } | undefined {
  try {
    // Windows: a per-process named pipe (\\.\pipe\wingman-<user>-rows-<pid>-<random>), no folder. POSIX: a private folder with a Unix socket.
    const onPipe = pipe.usesPipes(platform);
    const dir = onPipe ? "" : mkdtempSync(join(tmpdir(), "wm-"));
    if (dir)
      try {
        chmodSync(dir, 0o700);
      } catch {
        /* mkdtemp is already 0700 */
      }
    const path = onPipe ? pipe.pipeName(`rows-${process.pid}-${Math.random().toString(36).slice(2, 10)}`) : join(dir, "c.sock");
    const server = createServer((c) => {
      c.on("data", (b) => {
        try {
          relay.feed(b);
        } catch {
          /* ignore */
        }
      });
      c.on("error", () => {});
    });
    server.on("error", () => {});
    server.listen(path);
    return {
      path,
      server,
      close: () => {
        try {
          server.close();
        } catch {}
        if (dir)
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {}
      },
    };
  } catch {
    return undefined;
  }
}

/** run.ts side: sends card rows to the socket. Never throws, never blocks; rows sent before the connection is up wait (up to 200). */
export class CardPipe {
  private sock?: Socket;
  private ready = false;
  private queue: string[] = [];
  sent = 0;
  constructor(path: string) {
    try {
      const s = connect(path);
      this.sock = s;
      s.on("connect", () => {
        this.ready = true;
        for (const l of this.queue.splice(0)) this.write(l);
      });
      s.on("error", () => {
        this.ready = false;
        this.sock = undefined;
      });
      s.on("close", () => {
        this.ready = false;
        this.sock = undefined;
      });
      s.unref();
    } catch {
      this.sock = undefined;
    }
  }
  send(row: Record<string, unknown>) {
    let line: string;
    try {
      line = JSON.stringify(row) + "\n";
    } catch {
      return;
    }
    if (this.ready) this.write(line);
    else if (this.sock && this.queue.length < 200) this.queue.push(line);
  }
  private write(line: string) {
    try {
      this.sock?.write(line, () => {});
      this.sent++;
    } catch {
      /* window path is best effort */
    }
  }
  close() {
    try {
      this.sock?.destroy();
    } catch {}
  }
}
