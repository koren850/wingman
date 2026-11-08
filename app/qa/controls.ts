// Bad models on purpose. A grader that is not fooled by them is worth trusting: each control must score LOW (CONTROL_LIMITS in grade-golden.ts).
// The controls run through the real v2 engine (src/e2e/v2-worker.ts), not on a timeline: the engine, the guards and the scheduler see them as a model.
//   null        always SKIP: no card ever
//   noise       a random kind and six random words from the meeting, on a random half of the lines
//   shuffled    the scripted replies of the meeting, each moved to another slot (right style, wrong place)
//   always-ans  an answer card with one fixed sentence for every call
// `controlReplies` gives the policy fake its replies for the moment and observer roles. Pure: a meeting in, replies out.
import { rng, type Golden } from "./grade-golden.ts";
import { KINDS } from "./golden-schema.ts";

export type Control = "null" | "noise" | "shuffled" | "always-ans";
export const CONTROLS: readonly Control[] = ["null", "noise", "shuffled", "always-ans"];
export type Reply = { lastLine?: string; reply: string; ms: number };
const TAG: Record<string, string> = { answer: "ANS", prompt: "PROMPT", check: "CHECK", fact: "TERM" };
/** The one sentence of the always-ANS control: it holds no number, date or promise, so no guard removes it, and no moment asks for it. */
export const ALWAYS_SAY = "Take a moment to summarise the main points so far.";

export function controlReplies(g: Golden, control: Control | undefined, textOf: Map<string, string>): Reply[] {
  const placed = (xs: { at: string; reply: string; ms: number }[]): Reply[] =>
    xs.flatMap((x) => (textOf.get(x.at) ? [{ lastLine: textOf.get(x.at), reply: x.reply, ms: x.ms }] : []));
  if (control === "null") return [];
  if (control === "always-ans") return [{ reply: `TAG: ANS\nVALUE: 3\nAIM: me\nSAY: ${ALWAYS_SAY}\nWHY: always answer`, ms: 900 }];
  if (control === "noise") {
    const r = rng(11 + g.lines.length);
    const words = g.lines.flatMap((l) => l.text.split(/\s+/)).filter(Boolean);
    const out: Reply[] = [];
    for (const l of g.lines) {
      const lastLine = textOf.get(l.id);
      if (!lastLine || r() < 0.5) continue;
      const kind = KINDS[Math.floor(r() * KINDS.length)];
      const say = Array.from({ length: 6 }, () => words[Math.floor(r() * words.length)]).join(" ");
      out.push({ lastLine, reply: `TAG: ${TAG[kind]}\nVALUE: 3\nAIM: me\nSAY: ${say}\nWHY: random`, ms: 1000 });
    }
    return out;
  }
  const slots = (g.script ?? []).filter((s) => s.role === "moment");
  if (control === "shuffled") {
    // Rotate by a third of the slots plus one: a reply never stays where it was written, and the SKIP replies of the quiet lines move onto moments.
    const shift = Math.max(1, Math.round(slots.length / 3) + 1);
    return placed(slots.map((s, i) => ({ at: s.whenLastLine, reply: slots[(i + shift) % slots.length].reply, ms: s.ms ?? 800 })));
  }
  return placed(slots.map((s) => ({ at: s.whenLastLine, reply: s.reply, ms: s.ms ?? 800 })));
}
