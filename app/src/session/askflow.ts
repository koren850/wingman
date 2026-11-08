// What the engine does with an ask and a recap: build the inputs, run the model job (session/ask.ts), and put the result on the screen.
// Kept free of the engine singletons (boot.ts) so it is unit-tested with plain objects: the engine passes `FlowDeps`.
// Rules: a typed or hotkey ask ALWAYS ends in a card (an answer, "not in the call", an offline answer from notes, or an error line). A recap writes
// `view` rows (the overlay's Catch me up sheet reads them) and `recap.done` for the command line; when the sheet cannot be filled (nothing known,
// AI offline) one small card says so.
import { evalMath } from "../calc.ts";
import type { Card } from "../engine/cards.ts";
import { eventError } from "../errtext.ts";
import { toView } from "./view.ts";
import { offlineLabel, recapIsEmpty, recapText, runAsk, runRecap, type AskEnv, type AskLabels, type Recap } from "./ask.ts";
import type { SessionMemory } from "./types.ts";

export type FlowDeps = {
  /** Fresh inputs for every job: the memory from disk, the transcript now, the usable models. */
  env: () => AskEnv;
  emit: (c: Card) => void;
  log: (stream: "events" | "cards" | "usage", row: Record<string, unknown>) => void;
  addCost: (role: string, model: string, usage: unknown, meta: unknown) => { usd: number };
  now: () => number;
  /** next card id suffix, unique per call */
  seq: () => number;
  labels: AskLabels & { error: string; recapEmpty: string };
  /** word for each part of the recap in the UI language (card text and command line) */
  recapLabel: (k: "where" | "decided" | "open" | "promised" | "asked") => string;
  signal?: AbortSignal;
  /** min ms between two streamed card updates */
  throttleMs?: number;
};

const usageRow = (d: FlowDeps, role: string, turnId: string, u: { usage: unknown; providerMetadata: unknown; model: string }, record: unknown) => {
  try {
    const c = d.addCost(role, u.model, u.usage, u.providerMetadata);
    d.log("usage", { role, model: u.model, turnId, usage: u.usage, providerMetadata: u.providerMetadata, usd: c.usd, ctx: record });
  } catch {
    /* cost bookkeeping never blocks an answer */
  }
};

/** A typed or hotkey "ask the call". Always ends in at least one card. */
export async function answerAsk(d: FlowDeps, question: string): Promise<void> {
  const q = question.replace(/\s+/g, " ").trim().slice(0, 400);
  const turnId = `k${d.seq()}`;
  const id = `${turnId}-me`;
  const card = (say: string, o: Partial<Card> = {}): Card => ({
    id,
    turnId,
    badge: "me",
    forMe: true,
    source: "ai",
    question: q,
    say,
    facts: [],
    at: d.now(),
    ...o,
  });
  const done = (text: string, extra: Record<string, unknown>) => d.log("events", { type: "ask.done", turnId, question: q, text, at: d.now(), ...extra });
  try {
    if (!q) return void d.emit(card(d.labels.nothing, { done: true }));
    const math = evalMath(q);
    if (math) {
      d.emit(card(math.say, { source: "calc", done: true }));
      done(math.say, { source: "calc", ai: false });
      return;
    }
    let lastEmit = 0;
    const r = await runAsk(d.env(), q, (text) => {
      const t = d.now();
      if (t - lastEmit < (d.throttleMs ?? 150)) return;
      lastEmit = t;
      d.emit(card(text, { done: false }));
    });
    if (r.usage) usageRow(d, "ask", turnId, r.usage, r.record);
    const say = r.ai ? r.text : offlineLabel(d.labels, r.text);
    d.emit(card(say, { done: true }));
    done(say, { source: r.source, ai: r.ai, why: r.why, firstMs: r.ms.first, totalMs: r.ms.total });
  } catch (e) {
    // The job itself never throws; this is the last net: the user asked, so the screen is never left empty.
    d.log("events", { type: "ask.error", turnId, error: eventError(e).slice(0, 200) });
    d.emit(card(d.labels.error, { done: true }));
    done(d.labels.error, { source: "none", ai: false, why: "error" });
  }
}

/** The row the overlay reads: the memory view plus the recap. `showRecap` asks the overlay to open the sheet. */
export function viewRow(mem: SessionMemory, recap: Recap, ai: "ok" | "offline", at: number, showRecap: boolean): Record<string, unknown> {
  const v = toView(mem);
  return {
    type: "view",
    at,
    now: v.topic,
    kind: mem.kind,
    open: v.open.map((x) => x.text),
    promises: v.promises.map((x) => x.text),
    cover: v.coverLeft.map((x) => x.text),
    recap,
    ai,
    showRecap,
  };
}

/** "Catch me up": streams view rows as lines arrive; a final row; `recap.done` for the command line. */
export async function showRecap(d: FlowDeps): Promise<void> {
  const turnId = `r${d.seq()}`;
  const env = d.env();
  try {
    const r = await runRecap(env, (rc) => d.log("cards", viewRow(env.memory, rc, "ok", d.now(), true)));
    if (r.usage) usageRow(d, "ask", turnId, r.usage, r.record);
    const ai = r.ai ? "ok" : "offline";
    d.log("cards", viewRow(env.memory, r.recap, ai, d.now(), true));
    const text = recapText(r.recap, d.recapLabel);
    d.log("events", {
      type: "recap.done",
      turnId,
      at: d.now(),
      recap: r.recap,
      text,
      source: r.source,
      ai: r.ai,
      why: r.why,
      firstMs: r.ms.first,
      totalMs: r.ms.total,
    });
    // The sheet is the normal place. A card says it when there is nothing to show or the AI could not help, so the key never does nothing.
    if (recapIsEmpty(r.recap)) d.emit(infoCard(d, turnId, d.labels.recapEmpty));
    else if (!r.ai) d.emit(infoCard(d, turnId, `${d.labels.offline}\n${text}`));
  } catch (e) {
    d.log("events", { type: "recap.error", turnId, error: eventError(e).slice(0, 200) });
    d.emit(infoCard(d, turnId, d.labels.error));
  }
}
const infoCard = (d: FlowDeps, turnId: string, say: string): Card => ({
  id: `${turnId}-recap`,
  turnId,
  badge: "me",
  forMe: true,
  source: "ai",
  question: "",
  say,
  facts: [],
  at: d.now(),
  done: true,
});
