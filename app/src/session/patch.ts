// Strict patch validator and the pure applyPatch. The model proposes a patch; this file decides.
//   - A bad patch is dropped whole, with a reason. The memory is returned unchanged (the same object).
//     Two shape slips that real models make all the time are repaired and not punished (round 14: 54 of 73 recorded replies were dropped whole):
//     a fact written as a plain string is the fact {text}, and a roster entry that cannot be used (side "unknown") is left out.
//   - Ids (f1, n1, c1, q1, d1, o1, m1, p1) are assigned here, never by the model, and are never reused.
//   - Status only moves forward: done stays done, answered stays answered, handled stays handled.
//   - Lists stay inside their caps (caps.ts). The patch can add and update; it can never remove an item by itself.
import { CAPS, clipWords, enforceCaps } from "./caps.ts";
import { ADD_LISTS, KINDS, type AddList, type MemoryKind, type Person, type SessionMemory } from "./types.ts";

export type PatchCheck = { ok: true; patch: ValidPatch } | { ok: false; reason: string };
export type ApplyResult = { mem: SessionMemory; applied: boolean; reason?: string; notes: string[] };
export type ApplyCtx = { now: number; /** where new facts come from; "brief" only for seeding */ src?: "brief" | "call" | "user" };

type Rec = Record<string, unknown>;
type NewItem = { list: AddList; f: Rec };
type Upd = { id: string; f: Rec };
/** A patch after validation: every string is cleaned and clipped, every key is known. */
export type ValidPatch = {
  add: NewItem[];
  resolve: string[];
  update: Upd[];
  topic?: string;
  roster: { name: string; side: "me" | "them"; role?: string; stance?: string }[];
  summary?: string;
  kind?: MemoryKind;
};

const PREFIX: Record<AddList | "mustCover" | "roster", string> = {
  facts: "f",
  numbers: "n",
  commitments: "c",
  openQuestions: "q",
  decisions: "d",
  objections: "o",
  mustCover: "m",
  roster: "p",
};
const LIST_OF: Record<string, AddList | "mustCover" | "roster"> = {
  f: "facts",
  n: "numbers",
  c: "commitments",
  q: "openQuestions",
  d: "decisions",
  o: "objections",
  m: "mustCover",
  p: "roster",
};
const ID_RE = /^([fncqdomp])([1-9]\d{0,5})$/;

/** Fields the model may send per list when adding: [required, optional]. Code-owned keys (id, at, status, handled, done) are ignored if sent. */
const ADD_FIELDS: Record<AddList, [string[], string[]]> = {
  facts: [["text"], ["who", "src"]],
  numbers: [["what", "value"], ["who"]],
  commitments: [["who", "what"], ["due"]],
  openQuestions: [["asker", "text"], ["to"]],
  decisions: [["text"], []],
  objections: [["who", "text"], []],
};
const IGNORED_ON_ADD = new Set(["id", "at", "status", "handled", "done"]);
/** Fields an update may change. Status fields only move forward (checked when applying). */
const UPDATE_FIELDS: Record<string, string[]> = {
  f: ["text", "who"],
  n: ["what", "value", "who"],
  c: ["who", "what", "due", "status"],
  q: ["asker", "to", "text", "status"],
  d: ["text"],
  o: ["who", "text", "handled"],
  m: ["text", "done"],
  p: ["name", "side", "role", "stance"],
};
const LONG_FIELDS = new Set(["text", "what", "stance"]);
const SHORT_FIELDS = new Set(["who", "asker", "to", "name", "role", "due", "value"]);

const BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩﻿]/g;
/** One line, no control or bidi-override characters, clipped to `max` characters (by code point). Empty becomes undefined. */
export function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return undefined;
  const s = v.replace(BAD_CHARS, "").replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max).join("").trim() : s;
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const isObj = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

function fieldMax(k: string): number {
  return LONG_FIELDS.has(k) ? CAPS.text : SHORT_FIELDS.has(k) ? CAPS.short : CAPS.short;
}

/** Strict check of an unknown value. Returns a cleaned patch, or the reason it is rejected. Never throws. */
export function validatePatch(raw: unknown): PatchCheck {
  try {
    return check(raw);
  } catch (e) {
    return { ok: false, reason: `validator error: ${(e as Error).message}` };
  }
}

function check(raw: unknown): PatchCheck {
  if (!isObj(raw)) return { ok: false, reason: "patch is not an object" };
  const allowed = new Set(["add", "resolve", "update", "topic", "roster", "summary", "kind"]);
  for (const k of Object.keys(raw)) if (!allowed.has(k)) return { ok: false, reason: `unknown key "${k}"` };
  const out: ValidPatch = { add: [], resolve: [], update: [], roster: [] };

  if (raw.add !== undefined) {
    if (!isObj(raw.add)) return { ok: false, reason: "add is not an object" };
    for (const [list, items] of Object.entries(raw.add)) {
      if (!(ADD_LISTS as readonly string[]).includes(list)) return { ok: false, reason: `add: unknown list "${list}"` };
      if (!Array.isArray(items)) return { ok: false, reason: `add.${list} is not an array` };
      if (items.length > CAPS.addPerList) return { ok: false, reason: `add.${list} has more than ${CAPS.addPerList} items` };
      const [req, opt] = ADD_FIELDS[list as AddList];
      for (const given of items) {
        // The model often writes facts as plain strings. A string is the text of a fact; for the other lists it is still a bad item.
        const it = list === "facts" && typeof given === "string" ? { text: given } : given;
        if (!isObj(it)) return { ok: false, reason: `add.${list}: item is not an object` };
        const f: Rec = {};
        for (const [k, v] of Object.entries(it)) {
          if (IGNORED_ON_ADD.has(k)) continue;
          if (!req.includes(k) && !opt.includes(k)) return { ok: false, reason: `add.${list}: unknown field "${k}"` };
          if (k === "src") {
            if (v !== "call" && v !== "user") return { ok: false, reason: `add.${list}: bad src` };
            f.src = v;
            continue;
          }
          const c = cleanText(v, fieldMax(k));
          if (c === undefined) {
            if (req.includes(k)) return { ok: false, reason: `add.${list}: empty or non-text "${k}"` };
            continue; // an empty optional field is just left out
          }
          f[k] = c;
        }
        for (const k of req) if (f[k] === undefined) return { ok: false, reason: `add.${list}: missing "${k}"` };
        out.add.push({ list: list as AddList, f });
      }
    }
  }

  if (raw.resolve !== undefined) {
    if (!Array.isArray(raw.resolve)) return { ok: false, reason: "resolve is not an array" };
    if (raw.resolve.length > CAPS.resolvePerPatch) return { ok: false, reason: "resolve has too many ids" };
    for (const id of raw.resolve) {
      if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, reason: "resolve: bad id" };
      out.resolve.push(id);
    }
  }

  if (raw.update !== undefined) {
    if (!Array.isArray(raw.update)) return { ok: false, reason: "update is not an array" };
    if (raw.update.length > CAPS.updatePerPatch) return { ok: false, reason: "update has too many entries" };
    for (const u of raw.update) {
      if (!isObj(u) || typeof u.id !== "string" || !ID_RE.test(u.id) || !isObj(u.fields)) return { ok: false, reason: "update: bad entry" };
      if (Object.keys(u).some((k) => k !== "id" && k !== "fields")) return { ok: false, reason: "update: unknown key" };
      const ok = UPDATE_FIELDS[u.id[0]];
      const f: Rec = {};
      for (const [k, v] of Object.entries(u.fields)) {
        if (!ok.includes(k)) return { ok: false, reason: `update ${u.id}: field "${k}" is not allowed` };
        if (k === "status") {
          const legal = u.id[0] === "c" ? ["open", "done"] : ["open", "answered", "dropped"];
          if (typeof v !== "string" || !legal.includes(v)) return { ok: false, reason: `update ${u.id}: bad status` };
          f[k] = v;
        } else if (k === "handled" || k === "done") {
          if (typeof v !== "boolean") return { ok: false, reason: `update ${u.id}: ${k} must be true or false` };
          f[k] = v;
        } else if (k === "side") {
          if (v !== "me" && v !== "them") return { ok: false, reason: `update ${u.id}: bad side` };
          f[k] = v;
        } else {
          const c = cleanText(v, fieldMax(k));
          if (c === undefined) {
            if (k === "due" || k === "to" || k === "role" || k === "stance") continue;
            return { ok: false, reason: `update ${u.id}: empty "${k}"` };
          }
          f[k] = c;
        }
      }
      out.update.push({ id: u.id, f });
    }
  }

  if (raw.topic !== undefined) {
    const t = typeof raw.topic === "string" ? cleanText(raw.topic, CAPS.short) : undefined;
    if (t === undefined) return { ok: false, reason: "topic is empty or not text" };
    out.topic = t;
  }
  if (raw.kind !== undefined) {
    if (typeof raw.kind !== "string" || !(KINDS as readonly string[]).includes(raw.kind)) return { ok: false, reason: "bad kind" };
    out.kind = raw.kind as MemoryKind;
  }
  if (raw.summary !== undefined) {
    if (typeof raw.summary !== "string") return { ok: false, reason: "summary is not text" };
    // The summary keeps its line breaks out, like every other text; an empty summary is ignored (the memory never goes backwards).
    const s = cleanText(raw.summary, CAPS.summaryChars);
    if (s !== undefined) out.summary = clipWords(s, CAPS.summaryWords);
  }
  if (raw.roster !== undefined) {
    if (!Array.isArray(raw.roster)) return { ok: false, reason: "roster is not an array" };
    if (raw.roster.length > CAPS.roster) return { ok: false, reason: "roster is too long" };
    for (const p of raw.roster) {
      if (!isObj(p)) return { ok: false, reason: "roster: item is not an object" };
      for (const k of Object.keys(p)) if (!["name", "side", "role", "stance", "id"].includes(k)) return { ok: false, reason: `roster: unknown field "${k}"` };
      const name = cleanText(p.name, CAPS.short);
      if (!name) return { ok: false, reason: "roster: missing name" };
      if (p.side !== "me" && p.side !== "them") continue; // "unknown" or empty: we cannot place this person, so leave the entry out and keep the rest of the patch
      const e: ValidPatch["roster"][number] = { name, side: p.side };
      const role = cleanText(p.role, CAPS.short);
      if (role) e.role = role;
      const stance = cleanText(p.stance, CAPS.text);
      if (stance) e.stance = stance;
      out.roster.push(e);
    }
  }
  return { ok: true, patch: out };
}

/** Parses model output text into a checked patch. Accepts a bare JSON object or one inside a ``` fence or surrounded by text. */
export function parsePatchText(text: string): PatchCheck {
  const t = String(text ?? "");
  const a = t.indexOf("{"),
    b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return { ok: false, reason: "no JSON object in the output" };
  let raw: unknown;
  try {
    raw = JSON.parse(t.slice(a, b + 1));
  } catch (e) {
    return { ok: false, reason: `JSON parse failed: ${(e as Error).message}` };
  }
  return validatePatch(raw);
}

// ---- apply ----

const idNum = (id: string): number => Number(id.slice(1));

function nextId(mem: SessionMemory, seq: Record<string, number>, prefix: string): string {
  const list = mem[LIST_OF[prefix]] as { id: string }[];
  const maxNow = list.reduce((m, it) => Math.max(m, idNum(it.id) || 0), 0);
  const n = Math.max(seq[prefix] ?? 0, maxNow) + 1;
  seq[prefix] = n;
  return `${prefix}${n}`;
}

const key = (list: AddList, f: Rec): string => {
  switch (list) {
    case "numbers":
      return norm(`${f.what} ${f.value}`);
    case "commitments":
      return norm(`${f.who} ${f.what}`);
    case "openQuestions":
      return norm(`${f.asker} ${f.text}`);
    case "objections":
      return norm(`${f.who} ${f.text}`);
    default:
      return norm(String(f.text));
  }
};
const keyOfItem = (list: AddList, it: Rec): string => key(list, it);
/** The veto key of an item (the user removed it; the updater must not add it again). */
export const vetoKey = (list: AddList, it: Rec): string => `${list}:${keyOfItem(list, it)}`;

/** Validates a patch (an unknown value, for example parsed model JSON) and applies it to a memory. Pure: the input is never changed. */
export function applyPatch(mem: SessionMemory, patch: unknown, ctx: ApplyCtx): ApplyResult {
  const chk = validatePatch(patch);
  if (!chk.ok) return { mem, applied: false, reason: chk.reason, notes: [] };
  const p = chk.patch;
  const notes: string[] = [];
  const next: SessionMemory = {
    ...mem,
    topic: { now: mem.topic.now, history: mem.topic.history.slice() },
    roster: mem.roster.map((x) => ({ ...x })),
    facts: mem.facts.map((x) => ({ ...x })),
    numbers: mem.numbers.map((x) => ({ ...x })),
    commitments: mem.commitments.map((x) => ({ ...x })),
    openQuestions: mem.openQuestions.map((x) => ({ ...x })),
    decisions: mem.decisions.map((x) => ({ ...x })),
    objections: mem.objections.map((x) => ({ ...x })),
    mustCover: mem.mustCover.map((x) => ({ ...x })),
  };
  const seq: Record<string, number> = { ...(mem.seq ?? {}) };
  let changed = false;
  const src = ctx.src ?? "call";

  if (p.kind && p.kind !== next.kind) {
    if (next.kindLocked) notes.push(`kind locked to ${next.kind}, ignored ${p.kind}`);
    else {
      next.kind = p.kind;
      changed = true;
    }
  }

  for (const { name, side, role, stance } of p.roster) {
    const have = next.roster.find((x) => norm(x.name) === norm(name));
    if (have) {
      const before = JSON.stringify(have);
      have.side = side;
      if (role) have.role = role;
      if (stance) have.stance = stance;
      if (JSON.stringify(have) !== before) changed = true;
    } else if (next.roster.length < CAPS.roster) {
      const person: Person = { id: nextId(next, seq, "p"), name, side };
      if (role) person.role = role;
      if (stance) person.stance = stance;
      next.roster.push(person);
      changed = true;
    } else notes.push(`roster full, skipped ${name}`);
  }

  for (const { list, f } of p.add) {
    const arr = next[list] as unknown as Rec[];
    const k = key(list, f);
    if (mem.vetoed?.includes(`${list}:${k}`)) {
      notes.push(`${list} item was removed by the user, skipped`);
      continue;
    }
    if (arr.some((it) => keyOfItem(list, it) === k && (list !== "openQuestions" || it.status === "open"))) {
      notes.push(`duplicate ${list} item skipped`);
      continue;
    }
    const id = nextId(next, seq, PREFIX[list]);
    let item: Rec;
    switch (list) {
      case "facts":
        item = { id, text: f.text, ...(f.who ? { who: f.who } : {}), at: ctx.now, src: f.src ?? src };
        break;
      case "numbers":
        item = { id, what: f.what, value: f.value, ...(f.who ? { who: f.who } : {}), at: ctx.now };
        break;
      case "commitments":
        item = { id, who: f.who, what: f.what, ...(f.due ? { due: f.due } : {}), at: ctx.now, status: "open" };
        break;
      case "openQuestions":
        item = { id, asker: f.asker, ...(f.to ? { to: f.to } : {}), text: f.text, at: ctx.now, status: "open" };
        break;
      case "decisions":
        item = { id, text: f.text, at: ctx.now };
        break;
      default:
        item = { id, who: f.who, text: f.text, at: ctx.now, handled: false };
    }
    arr.push(item);
    changed = true;
  }

  const find = (id: string): Rec | undefined => {
    const l = LIST_OF[id[0]];
    return (next[l] as unknown as Rec[]).find((it) => it.id === id);
  };

  for (const id of p.resolve) {
    const it = find(id);
    if (!it) {
      notes.push(`resolve: unknown id ${id}`);
      continue;
    }
    const before = JSON.stringify(it);
    if (id[0] === "c") it.status = "done";
    else if (id[0] === "q") {
      if (it.status === "open") it.status = "answered";
    } else if (id[0] === "o") it.handled = true;
    else if (id[0] === "m") it.done = true;
    else {
      notes.push(`resolve: ${id} cannot be resolved`);
      continue;
    }
    if (JSON.stringify(it) !== before) changed = true;
  }

  for (const { id, f } of p.update) {
    const it = find(id);
    if (!it) {
      notes.push(`update: unknown id ${id}`);
      continue;
    }
    const before = JSON.stringify(it);
    for (const [k, v] of Object.entries(f)) {
      if (k === "status") {
        // forward only: open -> done / answered / dropped; a finished item stays finished
        if (it.status === "open" && v !== "open") it.status = v;
        else if (it.status !== "open") notes.push(`update ${id}: status is final`);
      } else if (k === "handled" || k === "done") {
        if (v === true) it[k] = true;
        else if (it[k] === true) notes.push(`update ${id}: ${k} cannot go back`);
      } else it[k] = v;
    }
    if (JSON.stringify(it) !== before) changed = true;
  }

  if (p.topic !== undefined && norm(p.topic) !== norm(next.topic.now)) {
    next.topic = { now: p.topic, history: [...next.topic.history, { label: p.topic, from: ctx.now }] };
    changed = true;
  }
  if (p.summary !== undefined && p.summary !== next.summary) {
    next.summary = p.summary;
    changed = true;
  }

  if (!changed) return { mem, applied: false, reason: "nothing to change", notes };
  const capped = enforceCaps(next);
  capped.seq = seq;
  capped.ver = mem.ver + 1;
  capped.updatedAt = ctx.now;
  return { mem: capped, applied: true, notes };
}

/**
 * The user picks the call mode (control command `mode`). A built-in kind locks it: the memory updater can no longer change it.
 * A custom mode id (from the pack) locks the current kind and sets `modeId`. "auto" unlocks and clears the custom mode, so the updater may guess again.
 * `customIds` are the ids the pack knows. An id nobody knows returns undefined (the caller says so). Pure.
 */
export function setMode(mem: SessionMemory, mode: string, now: number, customIds: readonly string[] = []): SessionMemory | undefined {
  const bump = (m: SessionMemory): SessionMemory => ({ ...m, ver: mem.ver + 1, updatedAt: now });
  const strip = ({ modeId: _m, ...rest }: SessionMemory): SessionMemory => rest;
  if (mode === "auto") return mem.kindLocked || mem.modeId ? bump(strip({ ...mem, kindLocked: false })) : mem;
  if ((KINDS as readonly string[]).includes(mode)) {
    const kind = mode as MemoryKind;
    return mem.kind === kind && mem.kindLocked && !mem.modeId ? mem : bump({ ...strip(mem), kind, kindLocked: true });
  }
  if (customIds.includes(mode)) return mem.modeId === mode && mem.kindLocked ? mem : bump({ ...mem, kindLocked: true, modeId: mode });
  return undefined;
}
