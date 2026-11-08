// buildContext: the one place that assembles the input of every v2 model call. Pure: no clock, no network, no files.
//
//   system[0]  A      shared: rules, profile, house style, answer bank index, brief digest. Same bytes for every role. Marker 1 h.
//   system[1]  rules  the role's fixed instructions (the text before the per-call facts). Same bytes for every call of the role. Marker 1 h for the roles
//                     that run often (see cache.ts CACHE_POLICY).
//   system[2]  B      the memory block (with its summary). Marker 5 min for the roles that call twice between two patches. Left out when empty.
//   system[3]  data   the role's per-call facts (user name, roster, bank candidates, call frame). Never cached.
//   messages   C      one user message: background chunks found by search, the raw transcript tail, the trigger. Not cached; with `tailChunk` the tail is cut
//                     into chunks at content-defined anchors so the older part keeps the same bytes while the window grows (append-only), and the last
//                     full chunk carries a marker.
// Why this order: a cached prefix must be byte-identical, so what changes least goes first. The memory block changes every patch, the facts change
// every call, the rules never. The old order (A, B, role) cached the memory across roles but left the 700 token rules unmarked.
//
// Everything that came from people or files is untrusted: it is stripped of our tags and angle brackets are escaped.
// The strings the caller passes for rules, profile, house style and bank index are the app's own text and go in as they are.
//
// The input never goes over the role's total budget. When it would, parts are cut in a fixed order (see TRIM_STEPS):
//   1 background chunks, 2 raw tail (oldest lines first), 3 memory (down to a floor, then to nothing), 4 role instructions, 5 trigger, 6 block A.
import type { Digest } from "../session/seed.ts";
import { escapeUntrusted, renderMemoryDetailed } from "../session/render.ts";
import { isEmptyMemory, type SessionMemory } from "../session/types.ts";
import { DEFAULT_BUDGETS, estimateTokens, MEMORY_FLOOR_TOKENS, truncateToTokens, type Budgets, type Role, type RoleBudget } from "./budget.ts";
import { CACHE_POLICY, splitRoleText, type CachePolicy } from "./cache.ts";
import { makeRecord, type CtxRecord } from "./record.ts";
import { buildIndex, search, type Bm25Index, type Chunk } from "./retrieve.ts";

export type RawLine = { side: "me" | "them"; text: string; name?: string };
export type SharedContext = {
  rules?: string;
  profile?: string;
  houseStyle?: string;
  /** the answer bank as "id: title" lines */
  bankIndex?: string;
  digest?: Digest;
  /** a ready index over the background files; built from digest.chunks when missing (and cached per digest) */
  index?: Bm25Index;
};
export type Block = { name: "shared" | "role" | "memory" | "data"; text: string; cache?: "1h" | "5m" };
/** A part of the user message. Only used when the tail is cached in chunks. */
export type MessagePart = { type: "text"; text: string; providerOptions?: { anthropic: { cacheControl: { type: "ephemeral"; ttl: "1h" | "5m" } } } };
export type ContextInput = {
  role: Role;
  roleInstructions: string;
  memory: SessionMemory;
  rawLines: RawLine[];
  /** the sentence or question that caused this call */
  trigger: string;
  budgets?: Budgets;
  shared?: SharedContext;
  /** Cache markers for this call. Defaults to CACHE_POLICY[role]. */
  cache?: Partial<CachePolicy>;
};
export type ContextOutput = {
  system: Block[];
  /** The user message as one text (always set; this is what tests and logs read). */
  messages: { role: "user"; content: string }[];
  /** The same message in parts with the cache marker on the last closed chunk. Only set when the tail is cached (policy `tailChunk` > 0). Send this one when it is there. */
  parts?: MessagePart[];
  record: CtxRecord;
};
/** The messages to hand to the model: the parts with cache markers when there are any, else the plain message. */
export const modelMessages = (ctx: Pick<ContextOutput, "messages" | "parts">): { role: "user"; content: string | MessagePart[] }[] =>
  ctx.parts ? [{ role: "user", content: ctx.parts }] : ctx.messages;

export const TRIM_STEPS = ["retrieved", "rawTail", "memory", "memoryAll", "roleInstructions", "trigger", "shared"] as const;

const indexCache = new WeakMap<object, Bm25Index>();
function indexFor(sh: SharedContext | undefined): Bm25Index | undefined {
  if (!sh) return undefined;
  if (sh.index) return sh.index;
  const ch = sh.digest?.chunks;
  if (!ch?.length) return undefined;
  let ix = indexCache.get(ch);
  if (!ix) {
    ix = buildIndex(ch.map((c, i): Chunk => ({ id: c.id ?? String(i + 1), text: c.text, source: c.source })));
    indexCache.set(ch, ix);
  }
  return ix;
}

const esc = escapeUntrusted;

/** Brief digest as text for block A: people and likely questions. (Agenda and facts go into the memory when it is seeded.) */
export function renderDigest(d: Digest | undefined): string {
  if (!d) return "";
  const lines: string[] = [];
  if (d.roster?.length)
    lines.push(
      "People:",
      ...d.roster.map((p) => `- ${esc(p.name)}${p.side || p.role ? " (" + [p.side, p.role && esc(p.role)].filter(Boolean).join(", ") + ")" : ""}`),
    );
  if (d.likelyQuestions?.length) lines.push("Likely questions:", ...d.likelyQuestions.map((q) => `- ${esc(q.q)}${q.a ? " -> " + esc(q.a) : ""}`));
  return lines.length ? `<wingman_context>\n${lines.join("\n")}\n</wingman_context>` : "";
}

const section = (title: string, body: string | undefined): string => (body?.trim() ? `${title}:\n${body.trim()}\n\n` : "");

/** Block A. The result depends only on `sh` and the shared cap, never on the role. */
function buildShared(sh: SharedContext | undefined, cap: number): { text: string; parts: Record<string, number>; cut: boolean } {
  const order = ["rules", "profile", "houseStyle", "bankIndex", "digest"] as const;
  const texts: Record<(typeof order)[number], string> = {
    rules: sh?.rules?.trim() ? sh.rules.trim() + "\n\n" : "",
    profile: section("Profile", sh?.profile),
    houseStyle: section("House style", sh?.houseStyle),
    bankIndex: section("Answer bank (id: title)", sh?.bankIndex),
    digest: section("Pre-meeting brief", renderDigest(sh?.digest)),
  };
  const sum = () => order.reduce((n, k) => n + estimateTokens(texts[k]), 0);
  let cut = false;
  // cut order, least important first: brief digest, bank index, house style, profile, rules
  for (const k of ["digest", "bankIndex", "houseStyle", "profile", "rules"] as const) {
    const over = sum() - cap;
    if (over <= 0) break;
    cut = true;
    texts[k] = truncateToTokens(texts[k], Math.max(0, estimateTokens(texts[k]) - over));
  }
  const parts: Record<string, number> = {};
  for (const k of order) parts[k] = estimateTokens(texts[k]);
  return { text: order.map((k) => texts[k]).join(""), parts, cut };
}

const lineText = (l: RawLine): string => `${l.side === "me" ? "me" : "them" + (l.name ? ` (${esc(l.name)})` : "")}: ${esc(l.text).replace(/\s+/g, " ").trim()}`;

/** A line starts a chunk when the hash of its text is a multiple of `chunk`. The anchors depend only on the text, so every call sees the same ones. */
const isAnchor = (text: string, chunk: number): boolean => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) % chunk === 0;
};

/** The tail as one text and, when `chunk` > 0 and the window holds at least two anchors, as pieces: `stable` (closed chunks, each ending in a newline; the first
 *  starts with the open tag) and `rest` (the lines after the last anchor and the close tag). `text` is what is sent: in the chunked case the lines before
 *  the first anchor are left out, so the window only moves when a whole chunk leaves it and between those moments each call extends the same bytes. */
/** The newest lines that fit in `allowance` tokens, wrapped in the transcript tag. The newest line is cut when it alone is too long. */
export function renderTailParts(lines: RawLine[], allowance: number, chunk: number): { text: string; stable: string[]; rest: string } {
  const open = "<call_transcript>\n",
    close = "\n</call_transcript>";
  const wrap = (body: string) => open + body + close;
  if (estimateTokens(wrap("")) > allowance) return { text: "", stable: [], rest: "" };
  const kept: string[] = [];
  let used = estimateTokens(wrap(""));
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lineText(lines[i]);
    const c = estimateTokens(t + "\n");
    if (used + c > allowance) {
      if (!kept.length) {
        const room = allowance - used - 1;
        if (room > 8) kept.unshift(truncateToTokens(t, room));
      }
      break;
    }
    kept.unshift(t);
    used += c;
  }
  const text = wrap(kept.join("\n"));
  if (chunk <= 0 || kept.length < 3) return { text, stable: [], rest: "" };
  const anchors = kept.map((t, i) => (isAnchor(t, chunk) ? i : -1)).filter((i) => i >= 0);
  if (anchors.length < 2) return { text, stable: [], rest: "" };
  const last = anchors[anchors.length - 1];
  const stable: string[] = [];
  for (let k = 0; k < anchors.length - 1; k++) {
    const body = kept.slice(anchors[k], anchors[k + 1]).join("\n") + "\n";
    stable.push(k === 0 ? open + body : body);
  }
  const rest = kept.slice(last).join("\n") + close;
  return { text: stable.join("") + rest, stable, rest };
}

function renderRetrieved(hits: { chunk: Chunk }[], allowance: number): { text: string; ids: string[] } {
  const ids: string[] = [];
  let body = "";
  for (const h of hits) {
    const piece = `[${esc(h.chunk.source ?? "file")} ${h.chunk.id}]\n${esc(h.chunk.text)}\n`;
    const next = body + piece;
    if (estimateTokens(`<background_files>\n${next}</background_files>\n`) > allowance) break;
    body = next;
    ids.push(h.chunk.id);
  }
  return body ? { text: `<background_files>\n${body}</background_files>\n`, ids } : { text: "", ids: [] };
}

const renderTrigger = (t: string, allowance: number): string => {
  const body = esc(t).replace(/\s+/g, " ").trim();
  const wrap = (b: string) => `\n<trigger>${b}</trigger>`;
  if (estimateTokens(wrap("")) > allowance) return "";
  return wrap(truncateToTokens(body, allowance - estimateTokens(wrap(""))));
};

export function buildContext(inp: ContextInput): ContextOutput {
  const rb: RoleBudget = (inp.budgets ?? DEFAULT_BUDGETS)[inp.role];
  const trimmed: string[] = [];

  // ---- block A: the same for every role ----
  const A = buildShared(inp.shared, rb.shared);
  if (A.cut) trimmed.push("shared");

  // ---- allowances, cut in TRIM_STEPS order until the total fits ----
  const al = { retrieved: rb.retrieved, rawTail: rb.rawTail, memory: rb.memory, roleInstructions: rb.roleInstructions, trigger: rb.trigger };
  const ix = rb.retrieved > 0 ? indexFor(inp.shared) : undefined;
  const query = [inp.trigger, ...inp.rawLines.slice(-3).map((l) => l.text)].join(" ");
  const hits = ix ? search(ix, query, { maxTokens: rb.retrieved }) : [];

  type Made = {
    memory: ReturnType<typeof renderMemoryDetailed>;
    retrieved: { text: string; ids: string[] };
    tail: string;
    stable: string[];
    rest: string;
    role: string;
    trig: string;
  };
  const pol: CachePolicy = { ...CACHE_POLICY[inp.role], ...inp.cache };
  const make = (): Made => ({
    memory: rb.memory > 0 && !isEmptyMemory(inp.memory) ? renderMemoryDetailed(inp.memory, al.memory) : { text: "", tokens: 0, trimmed: [] },
    retrieved: al.retrieved > 0 ? renderRetrieved(hits, al.retrieved) : { text: "", ids: [] },
    ...(al.rawTail > 0
      ? (({ text, stable, rest }) => ({ tail: text, stable, rest }))(renderTailParts(inp.rawLines, al.rawTail, pol.tailChunk))
      : { tail: "", stable: [], rest: "" }),
    role: truncateToTokens(inp.roleInstructions.trim(), al.roleInstructions),
    trig: renderTrigger(inp.trigger, al.trigger),
  });
  // Block sizes below are counted per part, exactly as the record counts them, so "over budget" and "record.tokens" agree.
  const partsOf = (m: Made): Record<string, number> => ({
    ...A.parts,
    memory: m.memory.tokens,
    roleInstructions: estimateTokens(m.role),
    retrieved: estimateTokens(m.retrieved.text),
    rawTail: estimateTokens(m.tail),
    trigger: estimateTokens(m.trig),
  });
  const total = (m: Made) => Object.values(partsOf(m)).reduce((a, b) => a + b, 0);

  let made = make();
  const over = () => total(made) - rb.total;
  const cutTo = (cur: number): number => Math.max(0, cur - over());
  for (const step of TRIM_STEPS) {
    if (over() <= 0) break;
    const before = total(made);
    switch (step) {
      case "retrieved":
        al.retrieved = cutTo(estimateTokens(made.retrieved.text));
        break;
      case "rawTail":
        al.rawTail = cutTo(estimateTokens(made.tail));
        break;
      case "memory":
        al.memory = Math.max(Math.min(MEMORY_FLOOR_TOKENS, al.memory), cutTo(made.memory.tokens));
        break;
      case "memoryAll":
        al.memory = cutTo(made.memory.tokens);
        break;
      case "roleInstructions":
        al.roleInstructions = cutTo(estimateTokens(made.role));
        break;
      case "trigger":
        al.trigger = cutTo(estimateTokens(made.trig));
        break;
      case "shared":
        break;
    }
    if (step !== "shared") {
      made = make();
      if (total(made) < before) trimmed.push(step);
    }
  }
  let aText = A.text;
  let aParts = A.parts;
  if (over() > 0) {
    // Last resort, only for a budget table that cannot hold even the bare parts: cut block A. It then differs between roles.
    const s = buildShared(inp.shared, Math.max(0, rb.shared - over()));
    aText = s.text;
    aParts = s.parts;
    if (!trimmed.includes("shared")) trimmed.push("shared");
  }

  const parts: Record<string, number> = {
    ...aParts,
    memory: made.memory.tokens,
    roleInstructions: estimateTokens(made.role),
    retrieved: estimateTokens(made.retrieved.text),
    rawTail: estimateTokens(made.tail),
    trigger: estimateTokens(made.trig),
  };
  for (const t of made.memory.trimmed) trimmed.push(`memory:${t}`);

  const system: Block[] = [];
  const { rules, data } = splitRoleText(made.role);
  if (aText.trim()) system.push({ name: "shared", text: aText, cache: "1h" });
  if (rules) system.push({ name: "role", text: rules, ...(pol.rules ? { cache: pol.rules } : {}) });
  if (made.memory.text) system.push({ name: "memory", text: made.memory.text, ...(pol.memory ? { cache: pol.memory } : {}) });
  if (data) system.push({ name: "data", text: data });
  // The user message. With a cached tail the transcript comes first (its closed chunks are the cached prefix), then the background and the trigger.
  const chunked = made.stable.length > 0;
  let content = chunked ? made.tail + made.retrieved.text + made.trig : made.retrieved.text + made.tail + made.trig;
  let msgParts: MessagePart[] | undefined;
  if (chunked) {
    const mark = { anthropic: { cacheControl: { type: "ephemeral" as const, ttl: "5m" as const } } };
    msgParts = [
      ...made.stable.map((text, i): MessagePart => ({ type: "text", text, ...(i === made.stable.length - 1 ? { providerOptions: mark } : {}) })),
      { type: "text", text: made.rest + made.retrieved.text + made.trig },
    ];
  } else if (!content) {
    content = "(no new lines)";
    parts.trigger += estimateTokens(content);
  }
  const record = makeRecord({ role: inp.role, memV: inp.memory.ver, parts, trimmed, a: aText, b: made.memory.text, chunks: made.retrieved.ids });
  return { system, messages: [{ role: "user", content }], ...(msgParts ? { parts: msgParts } : {}), record };
}
