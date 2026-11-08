// Context sources for the Meeting context box (typed entry point). The work is in shared/inputs.cjs, which is plain CommonJS because the tray
// and the Wingman window cannot load TypeScript (same split as brief-ics.ts and shared/ics.cjs).
//   readSource({ type: "file" | "eml" | "url" | "calendar", ... }) -> { text, kind, label }
// Everything that comes back is untrusted text. It is cleaned here and in the .cjs, and wrapped with untag(), so it cannot close the
// <call_transcript> wrapper of a prompt. No new npm dependency.
import { createRequire } from "node:module";
import type { ReadOptions, SourceKind, SourceResult, SourceSpec } from "../../shared/inputs.d.cts";
import { untag } from "../reflex.ts";

export type { ReadOptions, SourceKind, SourceResult, SourceSpec };
const inputs = createRequire(import.meta.url)("../../shared/inputs.cjs") as typeof import("../../shared/inputs.d.cts");

/** Reads one context source. Throws an Error with a plain message (and `.code`) the window can show as it is. */
export async function readSource(spec: SourceSpec, o: ReadOptions = {}): Promise<SourceResult> {
  const r = await inputs.readSource(spec, o);
  return { ...r, text: untag(r.text) };
}
export const isPrivateAddress = inputs.isPrivateAddress;
export const nearestEvent = inputs.nearestEvent;
export const fetchSafe = inputs.fetchSafe;
export const checkUrl = inputs.checkUrl;
export const htmlToText = inputs.htmlToText;
