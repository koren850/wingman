// Observer window: decides WHEN to ask the model "is help useful now?" while the call runs. It does not call the model. The engine pushes
// every kept line (after intake) and asks for due windows; a window holds every line that was not sent yet, so nothing is lost when a call is held back.
// Triggers: a strong hint at once; a weak hint after 0.7 s of quiet; 12 or more new words; a topic change; the user asking; a short line with a local cue
// (a figure, or a line that looks like one of the user's cards) after 0.7 s of quiet; a question to the user followed by 2 s of silence; a long monologue
// of the user in a coaching mode. At most `perMinute` calls per minute (default 6): a trigger that cannot fire yet stays pending and its lines go into the next
// window. `reserved` of those calls (default 2 of 6) are kept for the triggers that matter most (ask, strong, cue, silence, monologue): the general ones
// (words, weak, topic) may use only the rest. The clock is passed in, so a virtual clock drives it in tests.
import type { HintLevel } from "./types.ts";
import type { Side } from "./intake.ts";
import { wordCount } from "../text-util.ts";

export type ObserverLine = {
  id: string;
  text: string;
  side: Side;
  at: number;
  hint?: HintLevel;
  /** A cheap local score said this (short) line deserves a look: a figure, or it looks like one of the user's cards. */
  cue?: boolean;
  /** A question to the user (the speed hint said fast). It starts the silence timer; it does not count as new words. */
  asked?: boolean;
  /** A line that is only kept for the window (and for the topic and silence looks): its words do not add to the "12 new words" trigger. */
  quiet?: boolean;
};
export type Trigger = "ask" | "strong" | "silence" | "monologue" | "topic" | "cue" | "words" | "weak";
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
  /** Calls a minute kept for the important triggers (never more than a third of perMinute). */
  reserved: number;
  /** A question to the user and this much silence: look at the call. 0 = off. */
  silenceMs: number;
  /** The user's own words in a row that make a coaching look (0 = off). */
  monologueWords: number;
};
export const DEFAULT_OBSERVER: ObserverConfig = {
  perMinute: 6,
  weakQuietMs: 700,
  newWords: 12,
  contextMs: 40_000,
  maxPending: 200,
  reserved: 2,
  silenceMs: 2000,
  monologueWords: 0,
};
/** A general look that has waited this long (ms) may use the reserved calls. */
const STARVED_MS = 2500;
const RESERVED = new Set<Trigger>(["ask", "strong", "silence", "monologue", "cue"]);

/** Priority order of the triggers. */
const ORDER: readonly Trigger[] = ["ask", "strong", "silence", "monologue", "topic", "cue", "words", "weak"];

export class Observer {
  private pending: ObserverLine[] = [];
  private sent: ObserverLine[] = [];
  private fires: number[] = [];
  private strong = false;
  private weak = false;
  private topic = false;
  private ask = false;
  private cue = false;
  private monologue = false;
  private askedAt: number | undefined;
  private meWords = 0;
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
    if (!line.asked && !line.quiet && line.side === "them") this.newWords += wordCount(line.text); // the user's own words never make a general look
    this.askedAt = line.asked ? line.at : undefined; // anyone speaking after the question ends the silence
    if (line.side === "me") {
      this.meWords += wordCount(line.text);
      if (this.cfg.monologueWords > 0 && this.meWords >= this.cfg.monologueWords && !this.monologue) {
        this.monologue = true;
        this.heldTriggers++;
      }
    } else {
      this.meWords = 0;
      if (line.cue && !this.cue) {
        this.cue = true;
        this.heldTriggers++;
      }
    }
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

  /** The mode of the call can change while it runs (the memory learns the kind): the number of own words in a row that make a coaching look. */
  setMonologueWords(n: number): void {
    this.cfg = { ...this.cfg, monologueWords: Math.max(0, Math.floor(n)) };
  }
  /** The mode of the call sets the calls a minute (the caller keeps it at or under the setting). 0 is kept as 1 here: the observer is switched off by the setting, not by a mode. */
  setPerMinute(n: number): void {
    this.cfg = { ...this.cfg, perMinute: Math.max(1, Math.floor(n)) };
  }
  /** The user spoke (a line that is not pushed): a question to the user is no longer waiting for an answer. */
  userSpoke(): void {
    this.askedAt = undefined;
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
    if (!trigger) return undefined;
    return this.fire(trigger, now);
  }

  /** When poll() should be called next (ms on the same clock), or undefined when nothing is waiting. */
  nextDueAt(): number | undefined {
    if (!this.pending.length) return undefined;
    const now = this.now();
    let best: number | undefined;
    for (const t of ORDER) {
      const due = this.dueAt(t, now);
      if (due === undefined) continue;
      let at = Math.max(due, this.slotFreeAt(now, this.limitFor(t, -Infinity)));
      if (!RESERVED.has(t)) at = Math.min(at, Math.max(due, this.starvedAt(), this.slotFreeAt(now, this.cfg.perMinute))); // a waiting general look may use a reserved call once it has waited long enough
      if (best === undefined || at < best) best = at;
    }
    return best === Infinity ? undefined : best;
  }

  /** Number of unsent lines. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** When trigger `t` is due (ms), or undefined when it is not armed. */
  private dueAt(t: Trigger, now: number): number | undefined {
    switch (t) {
      case "ask":
        return this.ask ? now : undefined;
      case "strong":
        return this.strong ? now : undefined;
      case "silence":
        return this.askedAt !== undefined && this.cfg.silenceMs > 0 ? this.askedAt + this.cfg.silenceMs : undefined;
      case "monologue":
        return this.monologue ? now : undefined;
      case "topic":
        return this.topic ? now : undefined;
      case "cue":
        return this.cue ? this.lastLineAt + this.cfg.weakQuietMs : undefined;
      case "words":
        return this.newWords >= this.cfg.newWords ? now : undefined;
      case "weak":
        return this.weak ? this.lastLineAt + this.cfg.weakQuietMs : undefined;
    }
  }
  /** Calls a minute this trigger may use: the important ones the whole cap, the general ones the cap minus the reserve. */
  private limitFor(t: Trigger, now: number): number {
    const reserve = Math.min(this.cfg.reserved, Math.floor(this.cfg.perMinute / 3));
    if (RESERVED.has(t)) return this.cfg.perMinute;
    return now >= this.starvedAt() ? this.cfg.perMinute : this.cfg.perMinute - reserve;
  }
  /** When the oldest waiting line has waited STARVED_MS: from then on a general look may also use the reserved calls, so a busy minute delays a card by seconds, never by half a minute. */
  private starvedAt(): number {
    return (this.pending[0]?.at ?? Infinity) + STARVED_MS;
  }
  /** The first due trigger (in priority order) that has a free call. */
  private pickTrigger(now: number): Trigger | undefined {
    for (const t of ORDER) {
      const due = this.dueAt(t, now);
      if (due !== undefined && due <= now && this.recentFires(now).length < this.limitFor(t, now)) return t;
    }
    return undefined;
  }
  private recentFires(now: number) {
    this.fires = this.fires.filter((t) => now - t < 60_000);
    return this.fires;
  }
  private slotFreeAt(now: number, limit: number) {
    const f = this.recentFires(now);
    return f.length < limit ? now : limit <= 0 ? Infinity : f[f.length - limit] + 60_000;
  }
  /** Gives a window back: the engine decided not to ask (a silence look after the direct call answered). The call slot is free again and the lines and triggers of the
   *  window are pending again, so a line that was waiting for its own look is not lost. The silence timer is not re-armed. */
  unfire(w: ObserverWindow): void {
    const back = this.undo.get(w);
    if (!back) return;
    this.undo.delete(w);
    back();
  }
  private undo = new WeakMap<ObserverWindow, () => void>();
  private fire(trigger: Trigger, now: number): ObserverWindow {
    const lines = this.pending;
    const snap = {
      strong: this.strong,
      weak: this.weak,
      topic: this.topic,
      ask: this.ask,
      cue: this.cue,
      monologue: this.monologue,
      meWords: this.meWords,
      newWords: this.newWords,
      held: this.heldTriggers,
      sent: this.sent,
    };
    const first = lines[0]?.at ?? now;
    const context = this.sent.filter((l) => first - l.at <= this.cfg.contextMs);
    const w: ObserverWindow = { firedAt: now, trigger, lines, context, merged: Math.max(0, this.heldTriggers - 1) };
    this.sent = [...this.sent, ...lines].filter((l) => now - l.at <= this.cfg.contextMs * 2).slice(-200);
    this.pending = [];
    this.fires.push(now);
    this.strong = this.weak = this.topic = this.ask = this.cue = this.monologue = false;
    this.askedAt = undefined;
    this.meWords = 0;
    this.newWords = 0;
    this.heldTriggers = 0;
    this.undo.set(w, () => {
      const i = this.fires.lastIndexOf(now);
      if (i >= 0) this.fires.splice(i, 1);
      this.pending = [...lines, ...this.pending].slice(-this.cfg.maxPending);
      this.sent = snap.sent;
      this.strong ||= snap.strong;
      this.weak ||= snap.weak;
      this.topic ||= snap.topic;
      this.ask ||= snap.ask;
      this.cue ||= snap.cue;
      this.monologue ||= snap.monologue;
      this.meWords += snap.meWords;
      this.newWords += snap.newWords;
      this.heldTriggers += snap.held;
    });
    return w;
  }
}
