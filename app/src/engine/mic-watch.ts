// The mic watchdog as a small class with injected effects, so its order of events can be tested without an engine.
// Silence is normal while the user listens (a quiet Bluetooth mic raised "mic not picking up" about 20 times). Red only when the mic was NEVER heard since
// listening started (permission, wrong device). Once it was heard, only a long silence (longSilentMs) gives one calm amber line, cleared when the mic is heard again.
// The clock starts when BOTH are true: the user is listening (consent) and the mic source has started. A slow start (a permission prompt, a busy audio
// service) must not look like a dead mic.

export type MicWatchOpts = {
  intervalMs: number; // audio.watchdog.micSilentMs
  micPeak: number; // a frame at or above this counts as heard
  longSilentMs: number;
  shuttingDown: () => boolean;
  onNever: () => void; // red bar
  onLong: () => void; // amber bar
  onHeard: () => void; // the bar goes
};

export class MicWatch {
  private peakAfterStart = 0;
  private peakWin = 0;
  private shown = false;
  private timer?: NodeJS.Timeout;
  private consented = false;
  private started = false;
  private stopped = false;
  constructor(private o: MicWatchOpts) {}

  /** One mic frame: tracks the peaks the timer reads, and clears the bar when the mic is heard again. */
  frame(pk: number) {
    this.peakAfterStart = Math.max(this.peakAfterStart, pk);
    this.peakWin = Math.max(this.peakWin, pk);
    if (this.shown && pk >= this.o.micPeak) {
      this.shown = false;
      this.o.onHeard();
    }
  }
  /** The mic source came back: the next silence may raise its bar again. */
  back() {
    this.shown = false;
  }
  /** The user is listening now (audio may flow). */
  consent() {
    this.consented = true;
    this.maybeArm();
  }
  /** mic.start() returned (or gave up waiting). */
  micStarted() {
    this.started = true;
    this.maybeArm();
  }
  get armed() {
    return !!this.timer;
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }
  private maybeArm() {
    if (this.timer || this.stopped || !this.consented || !this.started) return;
    this.peakWin = 0;
    let silentSince = Date.now();
    this.timer = setInterval(() => {
      if (this.o.shuttingDown()) return;
      const now = Date.now();
      if (this.peakWin >= this.o.micPeak) silentSince = now;
      if (this.peakAfterStart < this.o.micPeak) {
        if (!this.shown) {
          this.shown = true;
          this.o.onNever();
        }
      } else if (now - silentSince >= this.o.longSilentMs && !this.shown) {
        this.shown = true;
        this.o.onLong();
      }
      this.peakWin = 0;
    }, this.o.intervalMs);
    this.timer.unref();
  }
}
