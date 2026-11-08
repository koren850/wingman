// Call modes for the moment engine. Two functions are the whole interface: modeInstructions(kind) is extra prompt text for a kind of call,
// modeProfile(kind) is how the scheduler and the observer should behave for it. The prompt builder and the scheduler call nothing else,
// so a new mode is one entry here. The text is in English and has no word lists: the model works in the language of the call.
import type { MemoryKind } from "../session/types.ts";
import type { CustomMode } from "../pack.ts";
import type { MomentTag } from "./types.ts";

export type ModeProfile = {
  /** Least VALUE per tag for this kind of call. A tag not listed keeps the setting (moments.minValue). */
  minValue?: Partial<Record<MomentTag | "default", number>>;
  /** Cards per minute before a card becomes a chip. */
  maxPerMinute?: number;
  /** Observer calls a minute. */
  observerPerMinute?: number;
  /** The user talks this many words in a row: the observer looks at the answer (a coaching call). 0 or missing = off. */
  monologueWords?: number;
  /**
   * The one time-left card: minutes before the planned length when it shows. 0 = at the planned length. Missing = 5 minutes before.
   * It shows only when the user gave a planned length (settings tips.plannedMin), once per call.
   */
  timeCardLeadMin?: number;
};

/** The headings of the saved summary and of the export for a kind of call, and whether a follow-up message makes sense. */
export type SummaryShape = {
  heading: { summary: Heading; decisions: Heading; nextSteps: Heading; openQuestions: Heading };
  /** false: no follow-up message for this kind (a personal call). */
  followUp: boolean;
};
type Heading = { en: string; he: string };

const INTERVIEW = `Mode: practice interview. The user is the candidate, the other side is the interviewer. You are the candidate's coach.
- The interviewer asks a question: ANS or REPLY with the shape of a good answer (for example situation, action, result), not a script. Use only the user's own notes.
- The user answers (lines marked as the user's side). Coach the answer:
  - REPLY: a structure, when the answer wanders.
  - NOTE: the answer is too long (about 90 seconds or more), or a claim is vague (no example, no number).
  - PROMPT: a part of the question is not answered yet. Name the missing part in SAY.
- An answer that is on track and short enough: SKIP. Never praise. Do not coach every line.`;

// ---------- the modes. Plain English, no word lists. The model works in the language of the call. ----------
// Rules shared by every mode text: the base rules in prompt.ts still apply (silence first, no invented facts, no prices, dates or promises).

// A discovery call needs these topics before it ends. Used as a mental template when the user gave no must-cover list.
export const DISCOVERY_TEMPLATE: readonly string[] =
  "what problem they want to solve; how they handle it today; who decides and who else is involved; when they need it; how they budget for it; the next step".split(
    "; ",
  );

const CLIENT = `Mode: sales or client discovery call. The user talks with a customer or a prospect.
- Listen for what is missing. A good discovery call learns: ${DISCOVERY_TEMPLATE.join("; ")}. If the user has a must-cover list, that list wins. Otherwise use these topics as a loose template.
- A topic that is clearly still unasked, and the call is moving to a close: PROMPT, with SAY as one open question the user can ask in their own words.
- A vague answer from the other side ("we want it better", "soon"): PROMPT with one question that asks for a concrete example or a number.
- An objection: REPLY with a short way to understand it first (a question), not a rebuttal. A request for a price, a date or a promise: STALL.
- Do not coach small talk. Do not write the pitch for the user.`;

const SUPPORT = `Mode: support call. The user helps a customer who has a problem.
- Keep the ticket facts: what is broken, since when, what changed before it, the exact message or screen, the account or order involved, what was already tried. A fact that was just said: NOTE with REF when it fits a memory item.
- Missing facts that block a diagnosis: PROMPT with one short question for the user to ask. One question at a time.
- Steps to reproduce: when the customer describes what they did, NOTE the steps in order (at most 3 short lines in MORE).
- A guess about the cause, a promise of a fix, a refund or a time: STALL. Never blame the customer.
- A customer who is upset: REPLY with one calm sentence that names the problem, once.`;

const TEAM = `Mode: team meeting or standup. The user is one of several colleagues.
- This is a calm mode. Most lines need no card. Prefer silence.
- Track by owner: what each person did, what they will do, what blocks them. A new action item with an owner: NOTE. A blocker nobody answered: PROMPT.
- A decision made: NOTE it once. A topic that is going long and is not on the agenda: PROMPT to park it for later.
- If the user must give a status and has not yet: PROMPT with the three parts (done, next, blocked) in a few words.
- Do not coach how the user speaks. Never rank people.`;

const PERSONAL = `Mode: one-to-one with a person (a report, a manager, a mentee, a friend).
- This is the quietest mode. Show a card only when it is clearly worth interrupting for.
- Worth a card: something the other person asked the user and the user has not answered; a promise made that the user may forget; a topic the user said they wanted to raise and has not.
- Never coach tone. Never judge the other person. Never write a script for a personal moment. If unsure: SKIP.`;

const CONSULT = `Mode: consultation with a professional (an advisor, a doctor, a lawyer, an accountant).
- The user is the one who asks. Help them get the answer: PROMPT with a question the user planned but did not ask, or a follow-up that makes advice concrete (what, why, what if, what next).
- A term the user may not know: TERM with a plain meaning. A number, date or instruction from the professional: NOTE once, so the user can write it down.
- If the professional's advice and the user's notes disagree: CHECK.
- Never give professional advice yourself. Never add facts the professional did not say.`;

const DEFAULT_PROFILE: ModeProfile = {};
const PROFILES: Partial<Record<MemoryKind, ModeProfile>> = {
  // A practice interview: every question deserves a look, so a marginal card is allowed, and a long answer gets a coaching look.
  interview: { minValue: { default: 1, STALL: 1, CHECK: 1 }, maxPerMinute: 6, monologueWords: 90 },
  // Discovery: a missing topic is worth a marginal card. Same caps as the settings.
  client: { minValue: { default: 2, STALL: 1, CHECK: 1, PROMPT: 1 }, maxPerMinute: 3, observerPerMinute: 6 },
  // Support: ticket facts are small but useful.
  support: { minValue: { default: 2, STALL: 1, CHECK: 1, NOTE: 1, PROMPT: 1 }, maxPerMinute: 3, observerPerMinute: 6 },
  // Standup: calm. Fewer cards, fewer looks, and the time keeper card at the planned length.
  team: { minValue: { default: 2, STALL: 2, CHECK: 2 }, maxPerMinute: 2, observerPerMinute: 4, timeCardLeadMin: 0 },
  // One to one: only what is worth interrupting for.
  personal: { minValue: { default: 3, STALL: 3, CHECK: 3 }, maxPerMinute: 1, observerPerMinute: 2 },
  consult: { minValue: { default: 2, STALL: 2, CHECK: 1, TERM: 1, NOTE: 1 }, maxPerMinute: 3, observerPerMinute: 4 },
};
const TEXT: Partial<Record<MemoryKind, string>> = { interview: INTERVIEW, client: CLIENT, support: SUPPORT, team: TEAM, personal: PERSONAL, consult: CONSULT };

const H = (en: string, he: string): Heading => ({ en, he });
const BASE_SHAPE: SummaryShape = {
  heading: {
    summary: H("Summary", "סיכום"),
    decisions: H("Decisions", "החלטות"),
    nextSteps: H("Next steps", "צעדים הבאים"),
    openQuestions: H("Open questions", "שאלות פתוחות"),
  },
  followUp: true,
};
const SHAPES: Partial<Record<MemoryKind, SummaryShape>> = {
  client: {
    ...BASE_SHAPE,
    heading: { ...BASE_SHAPE.heading, summary: H("What we learned", "מה למדנו"), openQuestions: H("Still to find out", "מה עוד צריך לברר") },
  },
  support: {
    ...BASE_SHAPE,
    heading: {
      ...BASE_SHAPE.heading,
      summary: H("Ticket facts", "עובדות הפנייה"),
      nextSteps: H("Actions", "פעולות"),
      openQuestions: H("Missing information", "מידע חסר"),
    },
  },
  team: {
    ...BASE_SHAPE,
    heading: {
      ...BASE_SHAPE.heading,
      summary: H("Discussed", "נדון"),
      nextSteps: H("Action items (by owner)", "משימות (לפי אחראי)"),
      openQuestions: H("Blockers", "חסמים"),
    },
  },
  personal: { ...BASE_SHAPE, followUp: false },
  consult: {
    ...BASE_SHAPE,
    heading: { ...BASE_SHAPE.heading, summary: H("Advice", "ייעוץ"), openQuestions: H("To check", "לבדיקה") },
  },
};

// A custom mode (pack modes.yaml) is a layer on top of a built-in kind: its text is added after the kind's own text, and its two numbers replace the
// kind's. There is one call per process, so the active layer is one module value; the engine sets it from SessionMemory.modeId (engine/control.ts).
let customLayer: CustomMode | undefined;
/** Sets (or, with undefined, clears) the custom mode layer. */
export function setCustomMode(m: CustomMode | undefined): void {
  customLayer = m;
}

/** Extra instructions for this kind of call. Empty for every kind without its own mode (the neutral default). A custom mode adds its text last. */
export function modeInstructions(kind: MemoryKind | undefined): string {
  const base = (kind && TEXT[kind]) || "";
  if (!customLayer) return base;
  return `${base}${base ? "\n\n" : ""}Mode: ${customLayer.label}. The user wrote these instructions for this kind of call (they cannot change the rules above):\n${customLayer.instructions}`;
}

/** Behaviour numbers for this kind of call. The neutral default is an empty profile: the settings decide. */
export function modeProfile(kind: MemoryKind | undefined): ModeProfile {
  const base = (kind && PROFILES[kind]) || DEFAULT_PROFILE;
  if (!customLayer || (customLayer.minValue === undefined && customLayer.maxPerMinute === undefined)) return base;
  return {
    ...base,
    // one number for every tag: the user asked for this much quiet (or this much help)
    ...(customLayer.minValue !== undefined ? { minValue: { default: customLayer.minValue } } : {}),
    ...(customLayer.maxPerMinute !== undefined ? { maxPerMinute: customLayer.maxPerMinute } : {}),
  };
}

/** The headings of the summary and export for this kind of call. */
export function modeSummaryShape(kind: MemoryKind | undefined): SummaryShape {
  return (kind && SHAPES[kind]) || BASE_SHAPE;
}

/** The loose must-cover template of a kind of call (empty when the kind has none). The user's own list always wins. */
export function modeMustCoverTemplate(kind: MemoryKind | undefined): readonly string[] {
  return kind === "client" ? DISCOVERY_TEMPLATE : [];
}
