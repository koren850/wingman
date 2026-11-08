// Call memory: one small JSON object that is patched during a call and read by every model call.
// The shapes below are the contract of the Wingman v2 plan (section 3.1). `seq` is the only addition (see below).

export const KINDS = ["client", "support", "vendor", "team", "consult", "personal", "interview", "other"] as const;
export type MemoryKind = (typeof KINDS)[number];

export type Fact = { id: string; text: string; who?: string; at: number; src: "brief" | "call" | "user" };
export type NumberItem = { id: string; what: string; value: string; who?: string; at: number };
export type Commitment = { id: string; who: string; what: string; due?: string; at: number; status: "open" | "done" };
export type OpenQuestion = { id: string; asker: string; to?: string; text: string; at: number; status: "open" | "answered" | "dropped" };
export type Decision = { id: string; text: string; at: number };
export type Objection = { id: string; who: string; text: string; at: number; handled: boolean };
export type MustCover = { id: string; text: string; done: boolean };
export type Person = { id: string; name: string; side: "me" | "them"; role?: string; stance?: string };

export type SessionMemory = {
  v: 1;
  updatedAt: number;
  ver: number; // +1 per applied patch
  kind: MemoryKind;
  topic: { now: string; history: { label: string; from: number }[] };
  roster: Person[];
  facts: Fact[];
  numbers: NumberItem[];
  commitments: Commitment[];
  openQuestions: OpenQuestion[];
  decisions: Decision[];
  objections: Objection[];
  mustCover: MustCover[];
  summary: string; // rolling, at most 250 words
  /** Next number per id prefix ("f", "n", "c", "q", "d", "o", "m", "p"). Ids are never reused, even after an item is dropped by a cap. Optional: derived from the items when missing. */
  seq?: Record<string, number>;
  /** Lines the user removed ("list:normalised text"). The updater cannot add them back. At most 40. */
  vetoed?: string[];
};

/** The lists that a patch can add to (the keys of `MemoryPatch.add`). */
export const ADD_LISTS = ["facts", "numbers", "commitments", "openQuestions", "decisions", "objections"] as const;
export type AddList = (typeof ADD_LISTS)[number];

export type MemoryPatch = {
  add?: Partial<Record<AddList, object[]>>;
  resolve?: string[]; // ids
  update?: { id: string; fields: object }[];
  topic?: string;
  roster?: object[];
  summary?: string;
  kind?: MemoryKind;
};

/** Sent to the UI over the relay as { type: "memory", view }. Small. */
export type MemoryView = {
  ver: number;
  topic: string;
  soFar: string[]; // max 4
  open: { id: string; text: string }[];
  promises: { id: string; who: string; text: string }[];
  coverLeft: { id: string; text: string }[];
  numbers: { id: string; what: string; value: string }[];
};

export function emptyMemory(now = 0, kind: MemoryKind = "other"): SessionMemory {
  return {
    v: 1,
    updatedAt: now,
    ver: 0,
    kind,
    topic: { now: "", history: [] },
    roster: [],
    facts: [],
    numbers: [],
    commitments: [],
    openQuestions: [],
    decisions: [],
    objections: [],
    mustCover: [],
    summary: "",
  };
}

/** True when nothing worth rendering is in the memory (a call with no context is a first-class case). */
export function isEmptyMemory(m: SessionMemory): boolean {
  return (
    !m.topic.now &&
    !m.summary &&
    !m.roster.length &&
    !m.facts.length &&
    !m.numbers.length &&
    !m.commitments.length &&
    !m.openQuestions.length &&
    !m.decisions.length &&
    !m.objections.length &&
    !m.mustCover.length
  );
}
