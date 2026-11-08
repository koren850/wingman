// Observer window: decides WHEN to ask the model "is help useful now?" while the call runs. It does not call the model. The engine pushes
// every kept line (after intake) and asks for due windows; a window holds every line that was not sent yet, so nothing is lost when a call is held back.
// Triggers: a strong hint at once; a weak hint after 0.7 s of quiet; 12 or more new words; a topic change; the user asking. At most `perMinute`
// calls per minute (default 6): a trigger that cannot fire yet stays pending and its lines go into the next window. The clock is passed in, so a virtual clock drives it in tests.
import type { HintLevel } from "./types.ts";
import type { Side } from "./intake.ts";

export type ObserverLine = { id: string; text: string; side: Side; at: number; hint?: HintLevel };
export type Trigger = "ask" | "strong" | "topic" | "words" | "weak";
export type ObserverWindow = {
  firedAt: number;
  trigger: Trigger;
  /** Every line not sent before, oldest first. */
  lines: ObserverLine[];
  /** Lines sent in earlier windows that are still inside `contextMs`, oldest first (so the model sees the lead-in). */
  context: ObserverLine[];
  /** How many triggers were held back by the cap and are covered by this window. */
  merged: number;
};
export type ObserverConfig = {
  perMinute: number;
  weakQuietMs: number;
  newWords: number;
  contextMs: number;
  /** Safety bound on unsent lines. Only a runaway stream reaches it; then the oldest line goes. */
  maxPending: number;
};
export const DEFAULT_OBSERVER: ObserverConfig = { perMinute: 6, weakQuietMs: 700, newWords: 12, contextMs: 40_000, maxPending: 200 };

const wordsIn = (t: string) => t.split(/\s+/).filter(Boolean).length;

export class Observer {
  private pending: ObserverLine[] = [];
  private sent: ObserverLine[] = [];
  private fires: number[] = [];
  private strong = false;
  private weak = false;
  private topic = false;
  private ask = false;
  private newWords = 0;
  private heldTriggers = 0;
  private lastLineAt = -Infinity;
  private cfg: ObserverConfig;
  constructor(
    private now: () => number,
    cfg: Partial<ObserverConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_OBSERVER, ...cfg };
  }

  /** A kept line. Returns a window when this line makes a call due and the cap allows it. */
  push(line: ObserverLine): ObserverWindow | undefined {
    this.pending.push(line);
    if (this.pending.length > this.cfg.maxPending) this.pending.shift();
    this.lastLineAt = Math.max(this.lastLineAt, line.at);
    this.newWords += wordsIn(line.text);
    if (line.side === "them") {
      if (line.hint === "strong") {
        this.strong = true;
        this.heldTriggers++;
      } else if (line.hint === "weak") {
        this.weak = true;
        this.heldTriggers++;
      }
    }
    return this.poll();
  }

  /** The memory says the topic changed. */
  topicChange(): ObserverWindow | undefined {
    this.topic = true;
    this.heldTriggers++;
    return this.poll();
  }

  /** The user asked Wingman something. Still counts against the cap, so the window waits for a free slot if all are used. */
  userAsk(): ObserverWindow | undefined {
    this.ask = true;
    this.heldTriggers++;
    return this.poll();
  }

  /** Call from a timer at `nextDueAt()`. */
  poll(): ObserverWindow | undefined {
    if (!this.pending.length) return undefined;
    const now = this.now();
    const trigger = this.pickTrigger(now);
    if (!trigger || !this.hasSlot(now)) return undefined;
    return this.fire(trigger, now);
  }

  /** When poll() should be called next (ms on the same clock), or undefined when nothing is waiting. */
  nextDueAt(): number | undefined {
    if (!this.pending.length) return undefined;
    const now = this.now();
    let due: number | undefined;
    if (this.ask || this.strong || this.topic || this.newWords >= this.cfg.newWords) due = now;
    else if (this.weak) due = this.lastLineAt + this.cfg.weakQuietMs;
    if (due === undefined) return undefined;
    return Math.max(due, this.slotFreeAt(now));
  }

  /** Number of unsent lines. */
  get pendingCount(): number {
    return this.pending.length;
  }

  private pickTrigger(now: number): Trigger | undefined {
    if (this.ask) return "ask";
    if (this.strong) return "strong";
    if (this.topic) return "topic";
    if (this.newWords >= this.cfg.newWords) return "words";
    if (this.weak && now - this.lastLineAt >= this.cfg.weakQuietMs) return "weak";
    return undefined;
  }
  private recentFires(now: number) {
    this.fires = this.fires.filter((t) => now - t < 60_000);
    return this.fires;
  }
  private hasSlot(now: number) {
    return this.recentFires(now).length < this.cfg.perMinute;
  }
  private slotFreeAt(now: number) {
    const f = this.recentFires(now);
    return f.length < this.cfg.perMinute ? now : f[f.length - this.cfg.perMinute] + 60_000;
  }
  private fire(trigger: Trigger, now: number): ObserverWindow {
    const lines = this.pending;
    const first = lines[0]?.at ?? now;
    const context = this.sent.filter((l) => first - l.at <= this.cfg.contextMs);
    const w: ObserverWindow = { firedAt: now, trigger, lines, context, merged: Math.max(0, this.heldTriggers - 1) };
    this.sent = [...this.sent, ...lines].filter((l) => now - l.at <= this.cfg.contextMs * 2).slice(-200);
    this.pending = [];
    this.fires.push(now);
    this.strong = this.weak = this.topic = this.ask = false;
    this.newWords = 0;
    this.heldTriggers = 0;
    return w;
  }
}
