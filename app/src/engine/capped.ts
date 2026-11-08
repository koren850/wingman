// Bounds for per-call state, so an all-day call keeps memory flat. Maps and sets drop their oldest entry first (insertion order).

/** Per-call map/set/array cap (entries). */
export const CALL_CAP = 500;

/** Drop the oldest entries of a Map or Set until it holds at most `max`. */
export function capSize(c: Map<unknown, unknown> | Set<unknown>, max = CALL_CAP) {
  while (c.size > max) {
    const k = c.keys().next();
    if (k.done) return;
    c.delete(k.value);
  }
}
/** Drop the oldest items of an array until it holds at most `max`. */
export function capTail<T>(a: T[], max = CALL_CAP) {
  if (a.length > max) a.splice(0, a.length - max);
}

const words = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);

/**
 * The call transcript kept for the summary and the rescue copy. Pushing works like an array's push. When the total passes `maxWords`, lines from the
 * middle are dropped: the first `headWords` stay (who they are and what the call is about) and the newest lines stay. `omitted` counts the lines dropped.
 */
export class CappedTranscript<T extends { text: string }> extends Array<T> {
  static get [Symbol.species]() {
    return Array; // slice/map/filter return plain arrays
  }
  maxWords = 40_000;
  headWords = 4_000;
  omitted = 0;
  /** How many head lines stay for good (set by the first compaction). Call-wide indexes below this are plain indexes. */
  private headLen = 0;
  private total = 0;
  push(...items: T[]): number {
    for (const it of items) {
      super.push(it);
      this.total += words(it.text);
    }
    if (this.total > this.maxWords) this.compact();
    return this.length;
  }
  get wordTotal() {
    return this.total;
  }
  /** Lines pushed so far, dropped ones included. A reader keeps a call-wide cursor and stops when it reaches this. */
  get absLength() {
    return this.length + this.omitted;
  }
  /** The line at a call-wide index (counting dropped lines). Undefined when that line was dropped. */
  lineAt(abs: number): T | undefined {
    if (this.omitted === 0 || abs < this.headLen) return this[abs];
    const i = abs - this.omitted;
    return i < this.headLen ? undefined : this[i];
  }
  private compact() {
    // Down to 90 percent of the cap, so this runs once per ~10 percent of growth, not at every push.
    const target = Math.floor(this.maxWords * 0.9);
    let head = 0,
      hw = 0;
    while (head < this.length && hw < this.headWords) hw += words(this[head++].text);
    let cut = head,
      drop = 0;
    while (cut < this.length - 1 && this.total - drop > target) drop += words(this[cut++].text);
    if (cut <= head) return;
    this.splice(head, cut - head);
    this.headLen = head;
    this.omitted += cut - head;
    this.total -= drop;
  }
}
