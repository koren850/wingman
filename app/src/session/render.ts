// renderMemory: the memory as one text block for a prompt.
//   - Deterministic: the same memory always gives the same bytes. No clock, no random.
//   - Prefix-stable: fixed section order, items sorted by id. The things that change most (topic, summary) come last,
//     so prompt caching keeps working: adding an item only changes the text after its own section start.
//   - Safe: all text is untrusted. Tags are removed and angle brackets are escaped.
//   - Inside the budget: when too long, it trims in a fixed order (see TRIM_ORDER). It never goes over.
import { estimateTokens } from "../context/budget.ts";
import { stripTag } from "../reflex.ts";
import { clipWords } from "./caps.ts";
import { isEmptyMemory, type SessionMemory } from "./types.ts";

export const TRIM_ORDER = ["summaryDetail", "resolvedQuestions", "oldFacts", "handledObjections", "doneCommitments", "summary", "lastResort"] as const;
export type TrimStep = (typeof TRIM_ORDER)[number];
export type Rendered = { text: string; tokens: number; /** steps applied, in order; "oldFacts:3" says how many facts went */ trimmed: string[] };

/** Untrusted text into a prompt: our own wrapper tags are removed, then every angle bracket and ampersand is escaped. */
export function escapeUntrusted(s: string): string {
  let t = String(s);
  if (t.includes("<")) for (const tag of ["call_transcript", "call_memory", "background_files", "trigger", "wingman_context"]) t = stripTag(t, tag);
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const byId = <T extends { id: string }>(a: T[]): T[] => a.slice().sort((x, y) => Number(x.id.slice(1)) - Number(y.id.slice(1)));
/** Escaped and on one line: a loaded file may hold line breaks, and a line break must not start a fake section. */
const e = (s: string): string => escapeUntrusted(s).replace(/\s+/g, " ").trim();

type View = {
  dropResolvedQ: boolean;
  /** number of oldest call facts hidden */
  factsHidden: number;
  /** more facts hidden after the call ones (last resort), oldest first */
  extraHidden: number;
  dropHandledObj: boolean;
  dropDone: boolean;
  summaryWords: number;
  history: boolean;
  /** last resort: sections cut from the bottom of this list */
  cut: number;
};

const LAST_RESORT_SECTIONS = ["numbers", "decisions", "objections", "commitments", "openQuestions", "mustCover", "roster"] as const;

function build(m: SessionMemory, v: View): string {
  const out: string[] = [];
  const sec = (title: string, lines: string[]) => {
    if (lines.length) out.push(title + ":", ...lines);
  };
  const cut = new Set(LAST_RESORT_SECTIONS.slice(0, v.cut));
  out.push(`Call type: ${m.kind}`);
  if (!cut.has("roster"))
    sec(
      "People",
      byId(m.roster).map((p) => `- ${p.id} ${e(p.name)} (${p.side}${p.role ? ", " + e(p.role) : ""})${p.stance ? " stance: " + e(p.stance) : ""}`),
    );
  if (!cut.has("mustCover"))
    sec(
      "Must cover",
      byId(m.mustCover)
        .filter((x) => !(v.dropDone && x.done))
        .map((x) => `- ${x.id} [${x.done ? "x" : " "}] ${e(x.text)}`),
    );
  const facts = byId(m.facts);
  const callIds = facts.filter((f) => f.src === "call").map((f) => f.id); // oldest first (ids rise with time)
  const hidden = new Set(callIds.slice(0, v.factsHidden));
  const rest = facts.filter((f) => !hidden.has(f.id));
  const hidden2 = new Set(rest.slice(0, v.extraHidden).map((f) => f.id));
  sec(
    "Facts",
    rest
      .filter((f) => !hidden2.has(f.id))
      .map((f) => `- ${f.id} ${e(f.text)}${f.who ? " (" + e(f.who) + ")" : ""}${f.src === "call" ? "" : " [" + f.src + "]"}`),
  );
  if (!cut.has("numbers"))
    sec(
      "Numbers",
      byId(m.numbers).map((n) => `- ${n.id} ${e(n.what)}: ${e(n.value)}${n.who ? " (" + e(n.who) + ")" : ""}`),
    );
  if (!cut.has("commitments"))
    sec(
      "Promises",
      byId(m.commitments)
        .filter((c) => !(v.dropDone && c.status === "done"))
        .map((c) => `- ${c.id} ${e(c.who)}: ${e(c.what)}${c.due ? " (due " + e(c.due) + ")" : ""} [${c.status}]`),
    );
  if (!cut.has("openQuestions"))
    sec(
      "Questions",
      byId(m.openQuestions)
        .filter((q) => !(v.dropResolvedQ && q.status !== "open"))
        .map((q) => `- ${q.id} ${e(q.asker)}${q.to ? " to " + e(q.to) : ""}: ${e(q.text)} [${q.status}]`),
    );
  if (!cut.has("decisions"))
    sec(
      "Decisions",
      byId(m.decisions).map((d) => `- ${d.id} ${e(d.text)}`),
    );
  if (!cut.has("objections"))
    sec(
      "Objections",
      byId(m.objections)
        .filter((o) => !(v.dropHandledObj && o.handled))
        .map((o) => `- ${o.id} ${e(o.who)}: ${e(o.text)} [${o.handled ? "handled" : "open"}]`),
    );
  if (m.topic.now) out.push(`Topic now: ${e(m.topic.now)}`);
  if (v.history && m.topic.history.length > 1)
    out.push(
      `Earlier topics: ${m.topic.history
        .slice(0, -1)
        .map((h) => e(h.label))
        .join(" > ")}`,
    );
  const sum = v.summaryWords > 0 ? clipWords(m.summary, v.summaryWords) : "";
  if (sum) out.push("Summary so far:", e(sum));
  return `<call_memory>\n${out.join("\n")}\n</call_memory>`;
}

/** The smallest k in 1..max for which `ok(k)` is true (ok must be monotonic: more cut never fits worse). Returns max when none fits. */
function leastThatFits(max: number, ok: (k: number) => boolean): number {
  if (max <= 0) return 0;
  let lo = 1,
    hi = max;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Renders with details (tokens, trim steps). An empty memory gives an empty text. */
export function renderMemoryDetailed(m: SessionMemory, budgetTokens: number): Rendered {
  if (isEmptyMemory(m) || budgetTokens <= 0) return { text: "", tokens: 0, trimmed: [] };
  const v: View = { dropResolvedQ: false, factsHidden: 0, extraHidden: 0, dropHandledObj: false, dropDone: false, summaryWords: 250, history: true, cut: 0 };
  const trimmed: string[] = [];
  let text = build(m, v);
  const fits = () => estimateTokens(text) <= budgetTokens;
  const redo = () => {
    text = build(m, v);
    return fits();
  };
  const finish = (): Rendered => ({ text, tokens: estimateTokens(text), trimmed });

  if (fits()) return finish();
  // 0. summary detail first: the summary is the lossy part (it is a rewrite of older items), the lists hold exact ids and wording. Half the words go before anything exact does.
  if (m.summary && clipWords(m.summary, 250).split(/\s+/).filter(Boolean).length > 125) {
    v.summaryWords = 125;
    trimmed.push("summaryDetail");
    if (redo()) return finish();
  }
  // 1. resolved questions
  if (m.openQuestions.some((q) => q.status !== "open")) {
    v.dropResolvedQ = true;
    trimmed.push("resolvedQuestions");
    if (redo()) return finish();
  }
  // 2. old minor facts: the oldest call facts, one at a time, the 6 newest stay
  const callCount = m.facts.filter((f) => f.src === "call").length;
  if (callCount > 6) {
    v.factsHidden = leastThatFits(callCount - 6, (k) => ((v.factsHidden = k), redo()));
    redo();
    trimmed.push(`oldFacts:${v.factsHidden}`);
    if (fits()) return finish();
  }
  // 3. handled objections
  if (m.objections.some((o) => o.handled)) {
    v.dropHandledObj = true;
    trimmed.push("handledObjections");
    if (redo()) return finish();
  }
  // 4. done commitments (and covered items)
  if (m.commitments.some((c) => c.status === "done") || m.mustCover.some((x) => x.done)) {
    v.dropDone = true;
    trimmed.push("doneCommitments");
    if (redo()) return finish();
  }
  // 5. summary detail, then the topic history
  if (m.summary) {
    trimmed.push("summary");
    while (v.summaryWords > 0) {
      v.summaryWords = v.summaryWords > 20 ? Math.floor(v.summaryWords / 2) : 0;
      if (redo()) return finish();
    }
  }
  if (v.history) {
    v.history = false;
    if (redo()) return finish();
  }
  // 6. last resort: older facts, then whole sections from the least important. Still never over budget.
  trimmed.push("lastResort");
  v.extraHidden = leastThatFits(m.facts.length - v.factsHidden, (k) => ((v.extraHidden = k), redo()));
  if (redo()) return finish();
  v.cut = leastThatFits(LAST_RESORT_SECTIONS.length, (k) => ((v.cut = k), redo()));
  if (redo()) return finish();
  const bare = `<call_memory>\nCall type: ${m.kind}${m.topic.now ? "\nTopic now: " + e(m.topic.now) : ""}\n</call_memory>`;
  text = estimateTokens(bare) <= budgetTokens ? bare : "";
  return finish();
}

export function renderMemory(m: SessionMemory, budgetTokens: number): string {
  return renderMemoryDetailed(m, budgetTokens).text;
}
