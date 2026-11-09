// The one health bar for the microphone (id "mic"). Two owners feed it: the source supervisor (the device is down: permission, busy, gone)
// and the mic watchdog (never heard, or silent for a long time). The bar shows the worst of them: down > never heard > long silence.
// When the worst one goes, the next one shows again, so one owner can never erase or soften the other's bar. Effects are injected for tests.

export type MicBarOpts = {
  /** Show or replace the bar. */
  show: (level: "red" | "amber", text: string, note?: string) => void;
  clear: () => void;
  texts: { never: () => string; long: () => string };
};

export class MicBar {
  private down?: { text: string; note?: string };
  private watch?: "never" | "long";
  private shown?: string; // what the bar says now, so a repeat does not write it again
  constructor(private o: MicBarOpts) {}

  /** The device is down (text from the error code), or back (undefined). */
  setDown(d?: { text: string; note?: string }) {
    this.down = d;
    this.render();
  }
  /** The watchdog's finding: "never" (red), "long" (amber), or undefined when the mic was heard. */
  setWatch(w?: "never" | "long") {
    this.watch = w;
    this.render();
  }
  private render() {
    if (this.down) return this.put(`down:${this.down.text}`, () => this.o.show("red", this.down!.text, this.down!.note));
    if (this.watch === "never") return this.put("never", () => this.o.show("red", this.o.texts.never()));
    if (this.watch === "long") return this.put("long", () => this.o.show("amber", this.o.texts.long()));
    if (this.shown !== undefined) {
      this.shown = undefined;
      this.o.clear();
    }
  }
  private put(key: string, show: () => void) {
    if (this.shown === key) return;
    this.shown = key;
    show();
  }
}
