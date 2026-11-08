// A readable view of one model call, shared by the policy fake model and the cassette layer.
// The AI SDK hands a model a `prompt` (system message first, then user/assistant messages) and some options. This module flattens that into
// plain text, finds the role of the call (moment, memory, ask...) and the last transcript line, so tests can match on them.

export type Role = "moment" | "observer" | "memory" | "compact" | "ask" | "digest" | "wrapup" | "reflex" | "unknown";

/** Parsed call: what a test can match on or assert about. */
export type PromptView = {
  role: Role | string;
  model: string;
  /** All system messages joined. */
  system: string;
  /** Every non-system message, flattened to text, one string per message (role-prefixed). */
  messages: string[];
  /** The text of the last user message. */
  user: string;
  /** The last transcript line in the last user message. `id` is set when the line starts with [id] or #id. */
  lastLine: { id?: string; text: string };
  /** The options that matter for the cache key and for tests. */
  options: { maxOutputTokens?: number; temperature?: number; topP?: number; stopSequences?: string[]; providerOptions?: unknown };
  /** Estimated tokens of system + messages (see estimateTokens). */
  tokens: number;
};

type Part = { type?: string; text?: string };
type Msg = { role: string; content: string | Part[] };
export type CallOptions = {
  prompt?: Msg[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  providerOptions?: Record<string, unknown>;
};

const partText = (c: string | Part[] | undefined): string =>
  typeof c === "string" ? c : (c ?? []).map((p) => (p.type === "text" || p.text !== undefined ? (p.text ?? "") : `[${p.type ?? "part"}]`)).join("");

/** Rough token count: 1 token per 4 characters (Latin). Hebrew is closer to 1 per 2.5, so text with Hebrew letters counts 1 per 3. Good enough for budget assertions. */
export function estimateTokens(text: string): number {
  const he = (text.match(/[֐-׿]/g) ?? []).length;
  return Math.ceil(he > text.length / 4 ? text.length / 3 : text.length / 4);
}

/**
 * How a system block names its role. Packages add their own entry with registerRole(); the first marker found in the system text wins.
 * A call can also name its role directly: providerOptions.wingman.role (the registry sets this when a caller passes a role).
 */
const ROLE_MARKERS: { role: string; re: RegExp }[] = [
  // The model calls that exist today. New roles (moment, memory, ask...) are added by the package that writes their prompts.
  { role: "reflex", re: /You are Wingman, a live meeting AI assistant/ },
  { role: "frame", re: /You build the call frame/ },
  { role: "tip", re: /You write at most one live tip/ },
  { role: "summary", re: /write the post-call summary/ },
  { role: "notes", re: /You keep short live notes/ },
  { role: "packgen", re: /You draft answer cards/ },
  { role: "classify", re: /You decide who .{1,60} is talking to/ },
];
export function registerRole(role: string, marker: RegExp | string) {
  ROLE_MARKERS.push({ role, re: typeof marker === "string" ? new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : marker });
}
export function inferRole(system: string, providerOptions?: Record<string, unknown>): string {
  const named = (providerOptions?.wingman as { role?: unknown } | undefined)?.role;
  if (typeof named === "string" && named) return named;
  for (const m of ROLE_MARKERS) if (m.re.test(system)) return m.role;
  return "unknown";
}

/** `[l12] me: text` or `#l12 text` gives id l12. */
const LINE_ID = /^\s*(?:\[([\w.-]+)\]|#([\w.-]+))\s*/;
export function parseLine(raw: string): { id?: string; text: string } {
  const m = raw.match(LINE_ID);
  return m ? { id: m[1] ?? m[2], text: raw.slice(m[0].length).trim() } : { text: raw.trim() };
}
/**
 * The last transcript line: the last non-empty line inside the last <call_transcript> block when the text has one (instructions after the block,
 * such as "Respond in the exact format.", are not a line of the call); otherwise the last non-empty line. Closing tags are ignored.
 */
export function lastLineOf(text: string): { id?: string; text: string } {
  const blocks = [...text.matchAll(/<call_transcript>([\s\S]*?)<\/call_transcript>/g)];
  if (blocks.length) text = blocks[blocks.length - 1][1];
  const lines = text
    .split("\n")
    .map((l) => l.replace(/<\/?[a-z_]+>\s*$/i, "").trim())
    .filter(Boolean);
  return parseLine(lines.at(-1) ?? "");
}

export function viewOf(model: string, o: CallOptions): PromptView {
  const prompt = o.prompt ?? [];
  const system = prompt
    .filter((m) => m.role === "system")
    .map((m) => partText(m.content))
    .join("\n");
  const rest = prompt.filter((m) => m.role !== "system");
  const messages = rest.map((m) => `${m.role}: ${partText(m.content)}`);
  const lastUser = [...rest].reverse().find((m) => m.role === "user");
  const user = partText(lastUser?.content);
  const po = o.providerOptions;
  return {
    role: inferRole(system, po),
    model,
    system,
    messages,
    user,
    lastLine: lastLineOf(user),
    options: {
      maxOutputTokens: o.maxOutputTokens,
      temperature: o.temperature,
      topP: o.topP,
      stopSequences: o.stopSequences,
      providerOptions: stripWingman(po),
    },
    tokens: estimateTokens(system + "\n" + messages.join("\n")),
  };
}
/** providerOptions without our own `wingman` key (the role marker does not belong in a cache key). */
function stripWingman(po: Record<string, unknown> | undefined): unknown {
  if (!po) return undefined;
  const { wingman: _w, ...rest } = po;
  return Object.keys(rest).length ? rest : undefined;
}

/** Stable text of one call, for snapshots and diffs. */
export function renderView(v: PromptView): string {
  const opt = Object.fromEntries(Object.entries(v.options).filter(([, x]) => x !== undefined));
  return [`# role: ${v.role}`, `# model: ${v.model}`, `# options: ${JSON.stringify(opt)}`, "## system", v.system, "## messages", ...v.messages].join("\n");
}
