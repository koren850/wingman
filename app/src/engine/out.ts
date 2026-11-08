// Output to the outside: the "@@wingman {json}" status lines the menu-bar app reads on stdout, health bars, and the error helpers (errBrief, safe, survived).
import { errText, errStack } from "../errtext.ts";
import { describe, type ProviderError } from "../providers/errors.ts";
import { log, CONTROL, UI_LANG } from "./boot.ts";
import { ht } from "../htext.ts";
import { emitCard } from "./cards.ts";
import type { MemoryView } from "../session/types.ts";

/** Label for a channel in the UI language, used in health texts. */
export const chHe = (c: string) => ht(UI_LANG, c === "me" ? "ch.me" : "ch.them");
/** Call phase for the answer window: written into call.json at each change (best effort, like every CallLog write). */
export function setPhase(phase: "starting" | "waiting" | "live" | "ended", extra: Record<string, unknown> = {}) {
  try {
    log.update({ phase, ...extra });
  } catch {
    /* best effort */
  }
}
/** Status line for the menu-bar app: "@@wingman {json}" on its own line (the leading newline keeps it off any half-written log line). Only in control mode. */
export function status(ev: string, data: Record<string, unknown> = {}) {
  if (CONTROL) process.stdout.write(`\n@@wingman ${JSON.stringify({ ev, ...data })}\n`);
}

/** Health bar in the answer window (and a status line for the tray). One bar per id; the same id replaces the old text. Clear it with healthClear. */
export function health(id: string, level: "red" | "amber" | "info", text: string, note?: string) {
  console.log(`\n${level === "red" ? "🔴" : level === "amber" ? "🟠" : "ℹ️ "} ${text}`);
  status("health", { id, level, text });
  log.write("events", { type: "health", id, level, text, note });
  emitCard({ id: `health-${id}`, turnId: "health", badge: "warn", health: true, level, question: "", say: text, facts: [], at: Date.now() });
}
/** Removes the health bar `id`. */
export function healthClear(id: string) {
  log.write("events", { type: "health.clear", id });
  status("health.clear", { id });
  emitCard({ id: `health-${id}`, turnId: "health", badge: "warn", health: true, clear: true, question: "", say: "", facts: [], at: Date.now() });
}

/** The memory view for the overlay and the live feed: one `{type:"memory", view}` row on the cards stream (so it also reaches the window over the relay socket
 *  and a restarted window finds the newest one on disk). Small by design (MemoryView caps every list). Best effort. */
export function emitMemoryView(view: MemoryView) {
  try {
    log.write("cards", { type: "memory", view, at: Date.now() });
  } catch {
    /* the view is only a convenience */
  }
}

/** One short, safe line for an error: a classified provider error ("authentication failed"), or "Name: message" cut to 200 chars.
 *  Never the raw object: AI SDK errors carry the whole request (requestBodyValues = the prompt, i.e. call text) and util.inspect would print it. */
export function errBrief(e: unknown): string {
  try {
    const pe = e as ProviderError;
    if (pe?.kind) return `${describe(pe)}${pe.provider ? ` (${pe.provider})` : ""}`;
    return errText(e).slice(0, 200);
  } catch {
    return "error";
  }
}
/** A handler failed but the call must go on: log it (`error.survived`) and carry on. Floods are thinned (first 20 per place, then every 100th). Does not count towards the "too many strays" crash. */
const survivedCount: Record<string, number> = {};
export function survived(where: string, e: unknown) {
  const n = (survivedCount[where] = (survivedCount[where] ?? 0) + 1);
  if (n > 20 && n % 100) return;
  try {
    log.write("events", { type: "error.survived", where, n, error: errStack(e) });
  } catch {
    /* best effort */
  }
  try {
    console.error(`\n⚠️ ${where} failed (call continues): ${errBrief(e)}`);
  } catch {
    /* stderr gone */
  }
}
/** Wraps an event handler / timer callback: a throw (or a rejected promise) is logged and survived. */
export function safe<A extends unknown[]>(where: string, fn: (...a: A) => unknown): (...a: A) => void {
  return (...a: A) => {
    try {
      const r = fn(...a);
      if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch((e) => survived(where, e));
    } catch (e) {
      survived(where, e);
    }
  };
}
