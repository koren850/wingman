// `wingman diagnose`: builds ONE report a user can attach to a bug report.
// Rule: nothing the other side or the user said ever goes in. Transcript and card text become lengths, event rows are kept only for a fixed list of
// types and fields, settings are shown only when they differ from the defaults, and every string is scrubbed for emails, phone numbers,
// key-like strings and home folder names. The file is plain JSON so the user can read it before sharing.
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { arch, platform, release, version as osVersion } from "node:os";
import { join } from "node:path";
import type { Settings } from "./settings.ts";

export const REPORT_VERSION = 1;

// ---------------------------------------------------------------- scrubbing
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PHONE = /(?<![\w.])\+?\(?\d[\d\s().-]{5,}\d(?![\w])/g;
const KEYLIKE = [
  /\b(?:sk|pk|rk|xox[abprs]|gh[pousr]|AKIA)[-_A-Za-z0-9]{10,}/g,
  /\bBearer\s+[\w.~+/=-]{10,}/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{28,}\b/g,
];
const SECRET_QUERY = /([?&;]\s*(?:api_?key|key|token|secret|password|auth)=)[^&\s"']+/gi;
const HOME = /\/(Users|home)\/[^/\s"'\\]+/g;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Removes emails, phone numbers, key-like strings and home folder names from one string. */
export function scrub(s: string): string {
  let o = s.replace(SECRET_QUERY, "$1<removed>").replace(EMAIL, "<email>");
  for (const re of KEYLIKE) o = o.replace(re, "<key>");
  o = o.replace(PHONE, (m) => {
    const digits = m.replace(/\D/g, "");
    if (DATE_ONLY.test(m.trim()) || digits.length < 7) return m;
    if (digits.length === m.trim().length && digits.length < 9) return m; // a bare 7-8 digit number is a count, not a phone
    return "<phone>";
  });
  return o.replace(HOME, "/$1/<user>");
}
/** A device name without the owner's name ("Dana's AirPods" -> "<name>'s AirPods"). */
export const scrubDevice = (s: string): string => scrub(s).replace(/^[^'’]{1,40}['’]s\s+/, "<name>'s ");
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Applies scrub() to every string in a value, however deep. A last safety net over the whole report. */
export function scrubDeep<T>(v: T): T {
  if (typeof v === "string") return scrub(v) as T;
  if (Array.isArray(v)) return v.map(scrubDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)])) as T;
  return v;
}

// ---------------------------------------------------------------- settings
const SECRET_KEY = /(api[-_]?key|secret|token|password|passwd|auth|credential)/i;
const SAFE_WORD = /^[\w.:/-]{1,60}$/;
/** One settings value for the report. Short ids and numbers stay; free text, file paths and word lists become a length or a count. */
export function settingValue(key: string, v: unknown): unknown {
  if (typeof v === "string") {
    if (SECRET_KEY.test(key)) return "<removed>";
    if (v.startsWith("/") || v.startsWith("~")) return `<path, ${v.length} chars>`;
    return SAFE_WORD.test(v) && scrub(v) === v ? v : `<text, ${v.length} chars>`;
  }
  if (Array.isArray(v)) return /fallbacks?$/i.test(key) ? v.map((x) => settingValue(key, x)) : `<${v.length} items>`;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, settingValue(`${key}.${k}`, x)]));
  return v;
}
export type SettingsLike = { settings: Settings; sources: Record<string, { layer: string }> };
/** Settings that came from somewhere other than the defaults file: { "llm.reflex.model": "…" }. */
export function changedSettings(loaded: SettingsLike): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const flat = flattenSettings(loaded.settings as unknown as Record<string, unknown>);
  for (const [k, src] of Object.entries(loaded.sources)) {
    if (src.layer === "default") continue;
    const v = k in flat ? flat[k] : undefined;
    out[`${k} (${src.layer})`] = settingValue(k, v);
  }
  return out;
}
function flattenSettings(obj: Record<string, unknown>, prefix = "", out: Record<string, unknown> = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && !/prices\.(llm|stt|sttAddons)$/.test(key)) flattenSettings(v as Record<string, unknown>, key, out);
    else out[key] = v;
  }
  return out;
}

// ---------------------------------------------------------------- call folder
type Row = Record<string, unknown>;
const TAIL_BYTES = 8 * 1024 * 1024;
/** Rows of calls/<id>/<name>.jsonl (the last 8 MB only; bad lines are skipped). */
export function readRows(dir: string, name: string): Row[] {
  const f = join(dir, `${name}.jsonl`);
  if (!existsSync(f)) return [];
  let text: string;
  try {
    const size = statSync(f).size;
    if (size <= TAIL_BYTES) text = readFileSync(f, "utf8");
    else {
      const fd = openSync(f, "r");
      const buf = Buffer.alloc(TAIL_BYTES);
      readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
      closeSync(fd);
      text = buf.toString("utf8").split("\n").slice(1).join("\n");
    }
  } catch {
    return [];
  }
  const rows: Row[] = [];
  for (const l of text.split("\n")) {
    if (!l) continue;
    try {
      const r = JSON.parse(l);
      if (r && typeof r === "object") rows.push(r);
    } catch {
      /* a half-written last line */
    }
  }
  return rows;
}

const EVENT_TYPES = new Set([
  "health",
  "health.clear",
  "ladder",
  "llm.error",
  "llm.switch",
  "reflex.hung",
  "me.error",
  "me.classify-error",
  "notes.error",
  "summary.error",
  "summary.done",
  "summary.skipped",
  "frame.error",
  "facts.error",
  "tip.error",
  "flow.error",
  "capture.error",
  "shutdown.error",
  "crash",
  "error.survived",
  "wake.recover",
  "sleep.gap",
  "clock.jump",
  "disk.free",
  "idle.stop",
  "cost.warn",
  "cost.total-warn",
  "echo.mode",
  "echo.summary",
  "foreign.summary",
  "me.summary",
  "speed.summary",
  "lang.unsupported",
  "control.closed",
]);
const EVENT_PREFIXES = /^(stt|audio|watchdog)\./;
// Never copied from an event, whatever its type: they can hold what was said.
const DENY_FIELDS = new Set([
  "text",
  "raw",
  "question",
  "say",
  "facts",
  "title",
  "name",
  "value",
  "left",
  "missed",
  "contextNotes",
  "aiNotes",
  "key",
  "planId",
  "file",
]);
const DEVICE_FIELDS = new Set(["device", "using", "configured", "output", "dev"]);
const keepEvent = (type: string) => EVENT_TYPES.has(type) || EVENT_PREFIXES.test(type);
const MAX_EVENTS = 400;

/** One event row reduced to safe scalar fields. */
export function safeEvent(e: Row): Row | undefined {
  const type = typeof e.type === "string" ? e.type : "";
  if (!type || !keepEvent(type)) return undefined;
  const out: Row = {};
  for (const [k, v] of Object.entries(e)) {
    if (DENY_FIELDS.has(k) && !(type === "health" && k === "text")) continue; // a health bar text is a status line the app wrote, not speech
    if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else if (typeof v === "string") out[k] = DEVICE_FIELDS.has(k) ? clip(scrubDevice(v), 120) : clip(scrub(v), /stack|error/i.test(k) ? 600 : 300);
    else if (Array.isArray(v) && v.length <= 12 && v.every((x) => typeof x === "string" || typeof x === "number"))
      out[k] = v.map((x) => (typeof x === "string" ? clip(scrub(x), 120) : x));
  }
  return out;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const USAGE_KEEP = [
  "t",
  "role",
  "model",
  "prompt",
  "usd",
  "roleTotalUsd",
  "aborted",
  "vendor",
  "llmUsd",
  "sttUsd",
  "totalUsd",
  "cacheHitPct",
  "cacheHitPctByRole",
  "models",
  "unpriced",
  "roles",
  "seconds",
  "bySeconds",
  "dropped",
];
function safeUsage(r: Row): Row {
  const out: Row = {};
  for (const k of USAGE_KEEP) if (k in r) out[k] = r[k];
  const u = r.usage as Row | undefined;
  if (u && typeof u === "object")
    out.tokens = { input: num(u.inputTokens), output: num(u.outputTokens), cacheRead: num((u.inputTokenDetails as Row | undefined)?.cacheReadTokens) };
  return out;
}
function safeLatency(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
}
const META_KEEP = [
  "id",
  "startedAt",
  "endedAt",
  "mode",
  "model",
  "fallbacks",
  "prompt",
  "stt",
  "sttFallback",
  "noAi",
  "discard",
  "crashed",
  "phase",
  "practice",
];

export type DiagnoseInput = {
  appVersion: string;
  electronVersion?: string;
  devices?: { name: string; transport: string; defaultInput: boolean; defaultOutput: boolean }[];
  settings?: SettingsLike | { error: string };
  callDir?: string;
  now?: number;
};

/** The whole report as a plain object (JSON-safe, already scrubbed). */
export function buildReport(i: DiagnoseInput): Row {
  const report: Row = {
    report: "wingman diagnose",
    reportVersion: REPORT_VERSION,
    createdAt: new Date(i.now ?? Date.now()).toISOString(),
    note: "No transcript text, card text, names or keys are included. Read this file before you share it.",
    app: { version: i.appVersion, electron: i.electronVersion ?? null },
    system: { os: platform(), osRelease: release(), osVersion: osVersion(), arch: arch(), node: process.version },
    devices: (i.devices ?? []).map((d) => ({
      name: clip(scrubDevice(d.name), 80),
      transport: d.transport,
      defaultInput: d.defaultInput,
      defaultOutput: d.defaultOutput,
    })),
  };
  if (i.settings) report.settingsChangedFromDefaults = "error" in i.settings ? { error: clip(scrub(i.settings.error), 300) } : changedSettings(i.settings);
  if (i.callDir && existsSync(i.callDir)) report.call = callSection(i.callDir);
  return scrubDeep(report);
}

function callSection(dir: string): Row {
  let meta: Row = {};
  try {
    meta = JSON.parse(readFileSync(join(dir, "call.json"), "utf8"));
  } catch {
    /* no metadata */
  }
  const keptMeta: Row = {};
  for (const k of META_KEEP) if (k in meta) keptMeta[k] = meta[k];
  const events = readRows(dir, "events");
  const cards = readRows(dir, "cards");
  const transcript = readRows(dir, "transcript");
  const usage = readRows(dir, "usage");
  const latency = readRows(dir, "latency");

  const byType: Record<string, number> = {};
  for (const e of events) if (typeof e.type === "string") byType[e.type] = (byType[e.type] ?? 0) + 1;
  const safeEvents = events.map(safeEvent).filter((x): x is Row => !!x);
  const modelCards = cards.filter((c) => c.type === "card" && !c.health && c.badge !== "info");
  const badges: Record<string, number> = {};
  const models: Record<string, number> = {};
  for (const c of modelCards) {
    badges[String(c.badge)] = (badges[String(c.badge)] ?? 0) + 1;
    if (typeof c.model === "string") models[`${c.model} / prompt ${c.prompt ?? "?"}`] = (models[`${c.model} / prompt ${c.prompt ?? "?"}`] ?? 0) + 1;
  }
  const ch: Record<string, { lines: number; chars: number }> = {};
  for (const t of transcript) {
    const k = String(t.ch ?? "?");
    const x = (ch[k] ??= { lines: 0, chars: 0 });
    x.lines++;
    x.chars += typeof t.text === "string" ? t.text.length : 0;
  }
  return {
    meta: keptMeta,
    counts: {
      events: events.length,
      eventsByType: byType,
      transcriptByChannel: ch,
      cards: modelCards.length,
      cardsByBadge: badges,
      cardsHidden: modelCards.filter((c) => c.hidden).length,
      cardsByModelAndPrompt: models,
      latencyRows: latency.length,
    },
    // Card rows keep ids, kinds and lengths only. The words are not copied.
    cards: modelCards.slice(-100).map((c) => ({
      t: num(c.t),
      id: typeof c.id === "string" ? clip(c.id, 40) : undefined,
      badge: c.badge,
      source: c.source,
      hidden: c.hidden === true ? (c.hiddenReason ?? true) : undefined,
      model: c.model,
      prompt: c.prompt,
      sayChars: typeof c.say === "string" ? c.say.length : 0,
      questionChars: typeof c.question === "string" ? c.question.length : 0,
      facts: Array.isArray(c.facts) ? c.facts.length : 0,
    })),
    events: safeEvents.slice(-MAX_EVENTS),
    eventsOmitted: Math.max(0, safeEvents.length - MAX_EVENTS),
    latency: latency.slice(-200).map(safeLatency),
    usage: usage.map(safeUsage),
  };
}
