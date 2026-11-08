// The memory loop (Wingman v2): the part of the engine that "learns like a Claude session".
// It reads new transcript lines (both sides), asks a small model for a patch, applies the patch to the call memory (session/), saves
// session.json and tells the UI. It never blocks a card: a direct question reads the memory as it is now plus the lines the updater has not seen yet.
//
// This file has no globals and no clock of its own: everything comes in through MemoryDeps, so tests run it on the virtual clock with a fake model.
// engine/coach.ts is the one place that wires it to the live call (boot.ts singletons).
//
// When the updater runs (see tick):
//   periodic  every memory.everySeconds (20) when at least memory.minNewWords (25) new words came in
//   event     at once, but not within minGapSeconds (8) of the last run: a digit, a "?" from the STT, a new token after a speaker change,
//             a long line, a question open for 20 s, a topic-shift hint from a moment call, a pause of more than 4 s after long speech.
//             These hints use no word list and no capital letters, so they work the same in Hebrew and English. They only wake the updater;
//             what the call means is the model's job.
//   compact   every memory.compactEveryMinutes (6), or when the render goes over its budget, or when a list is nearly full (once a minute at most)
// Cost guard: at most memory.maxPerHour updater calls an hour (240 is about $0.05 at the PLAN price of $0.0002 a call).
// Fallback: after 3 failures in a row the updater rests for a minute and tries again. The memory keeps its last good state, the file stays valid.
import { buildContext, modelMessages, type ContextOutput, type RawLine, type SharedContext } from "../context/build.ts";
import { withSettings, type Budgets } from "../context/budget.ts";
import { applyPatch } from "../session/patch.ts";
import { MEMORY_UPDATER_INSTRUCTIONS, COMPACTOR_INSTRUCTIONS } from "../session/prompt.ts";
import { renderMemoryDetailed } from "../session/render.ts";
import { CAPS } from "../session/caps.ts";
import { toView } from "../session/view.ts";
import type { MemoryView, SessionMemory } from "../session/types.ts";
import { spokenNumbers } from "../claims.ts"; // only for interview calls (deps.localNumbers); the v2 path does not use its unit list
import { generateOnce, providerOptionsFor, cacheOptionsFor, temperatureFor, type ModelRegistry } from "../providers/llm.ts";
import type { generateText } from "ai";

// ---------------------------------------------------------------- settings
export type MemoryConfig = {
  enabled: boolean;
  everySeconds: number;
  minNewWords: number;
  /** Least time between two updater runs, event or not. */
  minGapSeconds: number;
  compactEveryMinutes: number;
  budgetTokens: number;
  rawTailTokens: number;
  /** A question that is still open after this long wakes the updater (it may be answered, or may need a prompt). */
  questionOpenSeconds: number;
  /** Silence after this long, following at least longSpeechWords new words, wakes the updater. */
  pauseSeconds: number;
  longSpeechWords: number;
  /** An open item with no new line for this long may get a PROMPT card. */
  silencePromptSeconds: number;
  timeoutMs: number;
  compactTimeoutMs: number;
  /** Updater calls an hour. Beyond this the periodic and event runs wait (compaction has its own, smaller cap). */
  maxPerHour: number;
  maxCompactPerHour: number;
  model: string;
};
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  everySeconds: 20,
  minNewWords: 25,
  minGapSeconds: 8,
  compactEveryMinutes: 6,
  budgetTokens: 1800,
  rawTailTokens: 1200,
  questionOpenSeconds: 20,
  pauseSeconds: 4,
  longSpeechWords: 40,
  silencePromptSeconds: 6,
  timeoutMs: 8000,
  compactTimeoutMs: 15000,
  maxPerHour: 240,
  maxCompactPerHour: 20,
  model: "anthropic:claude-haiku-5-5",
};
/** The `memory.*` settings (added by the moment-engine package). Missing or odd values fall back to the defaults, so this works before and after that package lands. */
export function memoryConfigFrom(settings: unknown, fallbackModel?: string): MemoryConfig {
  const raw = ((settings as { memory?: unknown } | undefined)?.memory ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...DEFAULT_MEMORY_CONFIG };
  if (fallbackModel) out.model = fallbackModel;
  for (const k of Object.keys(DEFAULT_MEMORY_CONFIG) as (keyof MemoryConfig)[]) {
    const v = raw[k];
    if (typeof v === typeof DEFAULT_MEMORY_CONFIG[k] && (typeof v !== "number" || Number.isFinite(v)) && (typeof v !== "string" || v)) out[k] = v;
  }
  return out as MemoryConfig;
}

/** True when the call runs on the v2 engine (`moments.engine: v2`, added by the moment-engine package). Before that setting exists the answer is always false. */
export const engineV2 = (settings: unknown): boolean => (settings as { moments?: { engine?: unknown } } | undefined)?.moments?.engine === "v2";

// ---------------------------------------------------------------- types
export type MemRole = "memory" | "compact";
export type MemoryRequest = { role: MemRole; ctx: ContextOutput; signal: AbortSignal; timeoutMs: number };
export type MemoryReply = { text: string; usage?: unknown };
export type TriggerKind = "number" | "name" | "question" | "topic" | "pause" | "length" | "turn" | "manual";
export type MemLine = { side: "me" | "them"; text: string; name?: string; at: number };
/** One transcript line for the loop. `final`: the STT marked the end of the speaker's turn (Deepgram speech_final), when the source knows it. */
export type MemInput = { side: "me" | "them"; text: string; name?: string; final?: boolean };
export type MemoryDeps = {
  /** Wall ms. */
  now: () => number;
  /** One model call. The deps own the cost meter, the usage row and the model choice. */
  run: (req: MemoryRequest) => Promise<MemoryReply>;
  /** Atomic save of session.json. */
  save: (mem: SessionMemory) => void;
  /** Sends {type:"memory", view} to the relay. */
  sendView: (view: MemoryView) => void;
  log: (stream: "events" | "usage", row: Record<string, unknown>) => void;
  /** Cost cap and health: false stops a model call (the loop then waits). `final` is the last pass at shutdown: it must be allowed while the call is closing. */
  allowed?: (role: MemRole | "final") => boolean;
  shared?: () => SharedContext | undefined;
  budgets?: Budgets;
  /** Interview and legacy calls only: numbers with a unit are also written into the memory without a model call (claims.ts word list). Off by default. */
  localNumbers?: boolean;
  /** After every applied patch (also the local number patch). */
  onChange?: (mem: SessionMemory, prev: SessionMemory) => void;
  /** The topic label changed from one real label to another (not the first label). The moment engine makes the observer look at the call now. */
  onTopicChange?: (now: string, prev: string) => void;
};

const MAX_TAIL = 200;
const MAX_UNREAD = 200;
const FAIL_REST_MS = 60_000;
const FAILS_BEFORE_REST = 3;
const HOUR = 3_600_000;

const wc = (s: string) => s.split(/\s+/).filter(Boolean).length;
/** Words of a line, lower case, letters and digits only. Works for any script (no word list, no capitals). */
const tokensOf = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
/** A hint line is a "long line" for the updater when it has this many words. */
const LONG_LINE_WORDS = 45;
/** A new-token hint needs a token of at least this many letters, this many tokens already heard, and this long since the last such hint. */
const NEW_TOKEN_MIN_LEN = 3;
const NEW_TOKEN_WARMUP = 80;
const NEW_TOKEN_GAP_MS = 30_000;
const SEEN_MAX = 4000;

export class MemoryLoop {
  private mem: SessionMemory;
  private readonly tail: MemLine[] = [];
  private unread: MemLine[] = [];
  private unreadWords = 0;
  private busy: MemRole | undefined;
  private lastRunAt = 0;
  private lastCompactAt: number;
  private lastCompactVer = -1; // memory version the last compaction saw: an idle call is not compacted again
  private lastShedLogAt = 0;
  private lastLineAt = 0;
  private questionAt = 0; // first unread line that asks something
  private readonly events = new Set<TriggerKind>();
  private readonly runs: number[] = []; // updater start times, for the hourly cap
  private readonly compactRuns: number[] = [];
  private fails = 0;
  private restUntil = 0;
  private readonly rosterTokens = new Set<string>();
  private readonly seen = new Set<string>(); // every token heard so far (bounded)
  private lastSpeaker = "";
  private lastNewTokenAt = -Infinity;
  private localNumbers: { what: string; value: string; who: string }[] = [];
  private readonly prompted = new Set<string>();
  private lastPromptAt = 0;
  private abort = new AbortController();
  private stopped = false;
  stats = { runs: 0, compactions: 0, dropped: 0, failures: 0, applied: 0, shed: 0 };

  constructor(
    private readonly deps: MemoryDeps,
    private readonly cfg: MemoryConfig,
    start: SessionMemory,
  ) {
    this.mem = start;
    this.lastCompactAt = deps.now();
    for (const p of start.roster) this.learnName(p.name);
  }
  private learnName(n: string): void {
    for (const t of tokensOf(n)) this.rosterTokens.add(t);
  }

  // ------------------------------------------------------------ reading
  /** The memory as it is now. */
  get memory(): SessionMemory {
    return this.mem;
  }
  /** What a direct question reads: the memory as it is and the lines the updater has not seen yet (the raw tail covers the gap, so a slow updater costs nothing). */
  contextFor(): { memory: SessionMemory; unread: RawLine[]; ageMs: number } {
    return {
      memory: this.mem,
      unread: this.unread.map(({ side, text, name }) => ({ side, text, ...(name ? { name } : {}) })),
      ageMs: this.deps.now() - (this.mem.updatedAt || 0),
    };
  }
  get isBusy(): boolean {
    return !!this.busy;
  }
  get unreadWordCount(): number {
    return this.unreadWords;
  }
  /** Updater calls started in the last hour. */
  callsLastHour(): number {
    const now = this.deps.now();
    return this.runs.filter((t) => now - t < HOUR).length;
  }

  // ------------------------------------------------------------ input
  /** One transcript line (final). Both sides. */
  addLine(line: MemInput): void {
    const text = line.text.replace(/\s+/g, " ").trim();
    if (!text || this.stopped) return;
    const now = this.deps.now();
    const l: MemLine = { side: line.side, text, ...(line.name ? { name: line.name } : {}), at: now };
    this.tail.push(l);
    if (this.tail.length > MAX_TAIL) this.tail.shift();
    this.unread.push(l);
    if (this.unread.length > MAX_UNREAD) {
      const gone = this.unread.shift()!;
      this.unreadWords -= wc(gone.text);
    }
    const words = wc(text);
    this.unreadWords += words;
    this.lastLineAt = now;
    if (line.name) this.learnName(line.name);
    this.hints(line, text, words, now);
    // Interview and legacy only: claims.ts numbers (a number with its unit) go into `numbers` without a model call.
    if (this.deps.localNumbers)
      for (const s of spokenNumbers(text)) this.localNumbers.push({ what: s.unit, value: String(s.n), who: line.side === "me" ? "me" : (line.name ?? "them") });
  }
  /** Wake-up hints. None of them reads a word list or a capital letter, so Hebrew and English behave alike. The updater decides what the line means. */
  private hints(line: MemInput, text: string, words: number, now: number): void {
    if (/\d/.test(text)) this.events.add("number");
    if (/[?？؟]\s*$/.test(text) && !this.questionAt) this.questionAt = now;
    if (words >= LONG_LINE_WORDS) this.events.add("length");
    if (line.final && this.unreadWords >= Math.ceil(this.cfg.minNewWords / 2)) this.events.add("turn");
    // A token that is new to the call (not in the roster, never heard) right after the speaker changed: a name, a product, a place.
    const speaker = `${line.side}:${line.name ?? ""}`;
    const changed = this.lastSpeaker !== "" && speaker !== this.lastSpeaker;
    this.lastSpeaker = speaker;
    const toks = tokensOf(text);
    let fresh = false;
    if (changed && this.seen.size >= NEW_TOKEN_WARMUP && now - this.lastNewTokenAt >= NEW_TOKEN_GAP_MS)
      fresh = toks.some((t) => t.length >= NEW_TOKEN_MIN_LEN && !/^\d+$/.test(t) && !this.rosterTokens.has(t) && !this.seen.has(t));
    for (const t of toks) {
      this.seen.add(t);
      if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    }
    if (fresh) {
      this.lastNewTokenAt = now;
      this.events.add("name");
    }
  }
  /** A hint from outside: a topic shift in a moment call, a new speaker name, a manual wake. */
  noteEvent(kind: TriggerKind): void {
    this.events.add(kind);
  }

  // ------------------------------------------------------------ the clock
  /** Call about once a second. Starts at most one updater run and at most one compaction; returns what it started. */
  tick(): { started?: MemRole; why?: string } {
    if (this.stopped || !this.cfg.enabled) return {};
    const now = this.deps.now();
    this.applyLocalNumbers(now);
    if (this.busy) return {};
    if (now < this.restUntil) return {};
    if (!this.unread.length) this.events.clear(); // a hint with no new lines has nothing to learn (it must not fire on the next single line)
    if (this.unread.length) {
      const sinceRun = now - this.lastRunAt;
      const quietFor = now - this.lastLineAt;
      if (this.unreadWords >= this.cfg.longSpeechWords && quietFor >= this.cfg.pauseSeconds * 1000) this.events.add("pause");
      if (this.questionAt && now - this.questionAt >= this.cfg.questionOpenSeconds * 1000) this.events.add("question");
      let why: string | undefined;
      if (this.events.size && sinceRun >= this.cfg.minGapSeconds * 1000) why = [...this.events][0];
      else if (this.unreadWords >= this.cfg.minNewWords && sinceRun >= this.cfg.everySeconds * 1000) why = "periodic";
      if (why) {
        if (this.callsLastHour() >= this.cfg.maxPerHour) {
          this.stats.shed++;
          if (now - this.lastShedLogAt >= 60_000) {
            this.lastShedLogAt = now; // one log row a minute, not one a second
            this.deps.log("events", { type: "memory.shed", why: "hourly-cap", calls: this.callsLastHour() });
          }
        } else if (this.deps.allowed && !this.deps.allowed("memory")) {
          /* cost cap or model down: wait; the lines stay unread */
        } else {
          void this.runUpdater(why);
          return { started: "memory", why };
        }
      }
    }
    if (this.compactDue(now) && (!this.deps.allowed || this.deps.allowed("compact"))) {
      void this.runCompactor();
      return { started: "compact", why: "compact" };
    }
    return {};
  }

  private compactDue(now: number): boolean {
    if (this.mem.ver === 0 && !this.mem.facts.length) return false;
    if (this.mem.ver === this.lastCompactVer) return false; // nothing changed since the last compaction
    if (this.compactRuns.filter((t) => now - t < HOUR).length >= this.cfg.maxCompactPerHour) return false;
    if (now - this.lastCompactAt >= this.cfg.compactEveryMinutes * 60_000) return true;
    // Over budget (the render had to cut something) or a list is nearly full (its oldest items are dropped next, and the summary is where they live on).
    // At most once a minute.
    if (now - this.lastCompactAt < 60_000) return false;
    if (nearCap(this.mem)) return true;
    return renderMemoryDetailed(this.mem, this.cfg.budgetTokens).trimmed.length > 0;
  }

  // ------------------------------------------------------------ patches
  private apply(patch: unknown, now: number, role: string): { applied: boolean; reason?: string } {
    const r = applyPatch(this.mem, patch, { now });
    if (!r.applied) return { applied: false, reason: r.reason };
    const prev = this.mem;
    this.mem = r.mem;
    this.stats.applied++;
    try {
      this.deps.save(this.mem);
    } catch (e) {
      this.deps.log("events", { type: "memory.save.error", error: String((e as Error)?.message ?? e).slice(0, 160) });
    }
    try {
      this.deps.sendView(toView(this.mem));
    } catch {
      /* the UI path is best effort */
    }
    this.deps.log("events", { type: "memory.patch", role, ver: this.mem.ver, notes: r.notes.slice(0, 5) });
    try {
      this.deps.onChange?.(this.mem, prev);
    } catch (e) {
      this.deps.log("events", { type: "error.survived", where: "memory.onChange", error: String((e as Error)?.message ?? e).slice(0, 160) });
    }
    const was = prev.topic.now.trim(),
      is = this.mem.topic.now.trim();
    if (was && is && was.toLowerCase() !== is.toLowerCase()) {
      this.deps.log("events", { type: "memory.topic", from: was.slice(0, 80), to: is.slice(0, 80) });
      try {
        this.deps.onTopicChange?.(is, was);
      } catch (e) {
        this.deps.log("events", { type: "error.survived", where: "memory.onTopicChange", error: String((e as Error)?.message ?? e).slice(0, 160) });
      }
    }
    return { applied: true };
  }

  private applyLocalNumbers(now: number): void {
    if (!this.localNumbers.length) return;
    const add = this.localNumbers.splice(0).slice(0, 10);
    this.apply({ add: { numbers: add } }, now, "local");
  }

  private ctxFor(role: MemRole, lines: MemLine[], trigger: string): ContextOutput {
    return buildContext({
      role,
      roleInstructions: role === "memory" ? MEMORY_UPDATER_INSTRUCTIONS : COMPACTOR_INSTRUCTIONS,
      memory: this.mem,
      rawLines: lines.map(({ side, text, name }) => ({ side, text, ...(name ? { name } : {}) })),
      trigger,
      budgets: this.deps.budgets ?? withSettings({ memoryTokens: this.cfg.budgetTokens, rawTailTokens: this.cfg.rawTailTokens }),
      shared: this.deps.shared?.(),
    });
  }

  /** Reads the model reply as a patch. Never throws. */
  private take(text: string, role: string, now: number): "applied" | "empty" | "dropped" {
    const raw = parseJsonObject(text);
    if (!raw.ok) return this.drop(role, raw.reason, text);
    const r = this.apply(raw.value, now, role);
    if (r.applied) return "applied";
    if (r.reason === "nothing to change" || /nothing to change/i.test(r.reason ?? "")) return "empty";
    return this.drop(role, r.reason ?? "invalid", text);
  }
  private drop(role: string, reason: string, text: string): "dropped" {
    this.stats.dropped++;
    this.deps.log("events", { type: "memory.patch.dropped", role, reason: reason.slice(0, 160), sample: text.replace(/\s+/g, " ").slice(0, 80) });
    return "dropped";
  }

  private async runUpdater(why: string): Promise<void> {
    const now = this.deps.now();
    this.busy = "memory";
    this.lastRunAt = now;
    this.runs.push(now);
    while (this.runs.length > 600) this.runs.shift();
    const batch = this.unread;
    const batchWords = this.unreadWords;
    const hadQuestion = this.questionAt;
    this.unread = [];
    this.unreadWords = 0;
    this.questionAt = 0;
    this.events.clear();
    this.stats.runs++;
    const t0 = now;
    let outcome: "applied" | "empty" | "dropped" | "failed" = "failed";
    try {
      const ctx = this.ctxFor("memory", batch, "Update the memory with the new lines.");
      const reply = await this.deps.run({ role: "memory", ctx, signal: this.abort.signal, timeoutMs: this.cfg.timeoutMs });
      if (this.stopped && this.abort.signal.aborted) throw new Error("stopped");
      outcome = this.take(reply.text, "memory", this.deps.now());
      this.fails = 0;
    } catch (e) {
      this.fails++;
      this.stats.failures++;
      this.deps.log("events", { type: "memory.error", why, error: String((e as Error)?.message ?? e).slice(0, 160), fails: this.fails });
      if (this.fails >= FAILS_BEFORE_REST) {
        this.restUntil = this.deps.now() + FAIL_REST_MS;
        this.fails = 0;
        this.deps.log("events", { type: "memory.rest", ms: FAIL_REST_MS });
      }
    } finally {
      this.busy = undefined;
    }
    if (outcome === "failed" && !this.stopped) {
      // The lines were not learned: put them back in front of what came in meanwhile.
      this.unread = [...batch, ...this.unread].slice(-MAX_UNREAD);
      this.unreadWords = this.unread.reduce((n, l) => n + wc(l.text), 0);
      if (hadQuestion && !this.questionAt) this.questionAt = hadQuestion;
    }
    this.deps.log("events", { type: "memory.run", why, outcome, words: batchWords, ms: this.deps.now() - t0 });
  }

  private async runCompactor(): Promise<void> {
    const now = this.deps.now();
    this.busy = "compact";
    this.lastCompactAt = now;
    this.compactRuns.push(now);
    this.stats.compactions++;
    try {
      // The compactor sees the recent tail (also the lines the updater has already learned): it fixes and merges, it does not add.
      const ctx = this.ctxFor("compact", this.tail.slice(-60), "Tidy the memory and rewrite the summary.");
      const reply = await this.deps.run({ role: "compact", ctx, signal: this.abort.signal, timeoutMs: this.cfg.compactTimeoutMs });
      if (!(this.stopped && this.abort.signal.aborted)) this.take(reply.text, "compact", this.deps.now());
    } catch (e) {
      this.deps.log("events", { type: "memory.compact.error", error: String((e as Error)?.message ?? e).slice(0, 160) });
    } finally {
      this.lastCompactVer = this.mem.ver; // the compacted version counts as seen
      this.busy = undefined;
    }
  }

  // ------------------------------------------------------------ open loops
  /** An open question or promise that nobody has picked up for more than silencePromptSeconds. Each item is offered once, at most one per minute.
   *  The caller turns it into a PROMPT card; the text is the model's own wording in the call language, so no language is hard-coded here. */
  openLoopPrompt(): OpenLoopPrompt | undefined {
    const now = this.deps.now();
    if (this.stopped || now - this.lastLineAt < this.cfg.silencePromptSeconds * 1000) return undefined;
    if (now - this.lastPromptAt < 60_000) return undefined;
    const c = openLoops(this.mem).find((x) => !this.prompted.has(x.id) && now - x.at >= this.cfg.silencePromptSeconds * 1000 && now - x.at < 5 * 60_000);
    if (!c) return undefined;
    this.prompted.add(c.id);
    this.lastPromptAt = now;
    return c;
  }

  // ------------------------------------------------------------ end of call
  /** Writes the memory now (shutdown and crash). Never throws. */
  flush(): void {
    try {
      this.applyLocalNumbers(this.deps.now());
      this.deps.save(this.mem);
    } catch (e) {
      this.deps.log("events", { type: "memory.save.error", error: String((e as Error)?.message ?? e).slice(0, 160) });
    }
  }
  /** One last updater run for the lines that were not learned yet (shutdown has a few seconds). Returns when it is done or the time is up. */
  async finalPass(maxMs: number): Promise<void> {
    if (this.stopped || !this.cfg.enabled || !this.unread.length || this.unreadWords < 8 || (this.deps.allowed && !this.deps.allowed("final"))) return;
    const until = this.deps.now() + maxMs;
    while (this.busy && this.deps.now() < until) await new Promise((r) => setTimeout(r, 50));
    if (this.busy) return;
    const timer = setTimeout(() => this.abort.abort(), maxMs);
    try {
      await this.runUpdater("final");
    } finally {
      clearTimeout(timer);
    }
  }
  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }
}

/** What `MemoryDeps.allowed` looks at. Plain values, so the rule is testable without the engine. */
export type MemoryGateState = { consented: boolean; shuttingDown: boolean; discarding: boolean; llmUp: boolean; capped: boolean };
/** May the memory loop make a model call now? The final pass is the one call that runs while the call is closing (shuttingDown is true from the first
 *  second of Stop); it still respects the cost cap, a missing consent, a model that is down and a call that is being thrown away. */
export function memoryGate(role: MemRole | "final", s: MemoryGateState): boolean {
  if (!s.consented || !s.llmUp || s.capped) return false;
  if (role === "final") return !s.discarding;
  return !s.shuttingDown;
}

/** True when a list of the memory has room for fewer than 3 more items (CAPS in session/caps.ts). */
export function nearCap(mem: SessionMemory): boolean {
  const lists = {
    facts: mem.facts,
    numbers: mem.numbers,
    commitments: mem.commitments,
    openQuestions: mem.openQuestions,
    decisions: mem.decisions,
    objections: mem.objections,
  };
  return (Object.keys(lists) as (keyof typeof lists)[]).some((k) => lists[k].length >= CAPS[k] - 2);
}

export type OpenLoopPrompt = { id: string; kind: "question" | "promise"; text: string; who: string; at: number };

/** Open questions and open promises of a memory, oldest first. Plain data, no clock. */
export function openLoops(mem: SessionMemory): OpenLoopPrompt[] {
  const q = mem.openQuestions
    .filter((x) => x.status === "open")
    .map((x): OpenLoopPrompt => ({ id: x.id, kind: "question", text: x.text, who: x.asker, at: x.at }));
  const c = mem.commitments.filter((x) => x.status === "open").map((x): OpenLoopPrompt => ({ id: x.id, kind: "promise", text: x.what, who: x.who, at: x.at }));
  return [...q, ...c].sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "question" ? -1 : 1) || a.id.localeCompare(b.id));
}

/** The JSON object in a model reply: bare, in a code fence, or with text around it. */
export function parseJsonObject(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const t = String(text ?? "");
  const a = t.indexOf("{"),
    b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return { ok: false, reason: "no JSON object in the output" };
  try {
    return { ok: true, value: JSON.parse(t.slice(a, b + 1)) };
  } catch (e) {
    return { ok: false, reason: `JSON parse failed: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------- the real model call
export type RunnerOpts = {
  registry: ModelRegistry;
  model: string;
  compactModel?: string;
  /** Adds the cost to the meter and writes the usage row (role "memory" or "compact"). */
  onUsage: (role: MemRole, model: string, usage: unknown, providerMetadata: unknown, record: ContextOutput["record"]) => void;
  generate?: typeof generateText;
};
/** Turns a built context into one model call. System blocks keep their cache markers (A 1 h, B 5 min); the text answer is the patch. */
export function makeModelRunner(o: RunnerOpts): MemoryDeps["run"] {
  return async (req) => {
    const ref = req.role === "compact" ? (o.compactModel ?? o.model) : o.model;
    const model = await o.registry.resolve(ref, req.role);
    const instructions = req.ctx.system.map((b) => {
      const cache = b.cache ? cacheOptionsFor(ref, b.cache) : undefined;
      return { role: "system" as const, content: b.text, ...(cache ? { providerOptions: cache } : {}) };
    });
    const r = await generateOnce(o.generate, {
      model,
      maxOutputTokens: req.role === "compact" ? 700 : 500,
      maxRetries: 0,
      abortSignal: AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs)]),
      providerOptions: providerOptionsFor(ref, { effort: "low", thinking: false }),
      ...(temperatureFor(ref) !== undefined ? { temperature: temperatureFor(ref) } : {}),
      instructions,
      messages: modelMessages(req.ctx),
    });
    o.onUsage(req.role, ref, r.usage ?? r.totalUsage, r.providerMetadata, req.ctx.record);
    return { text: r.text ?? "", usage: r.usage };
  };
}
