// Calendar file (.ics) reader for the Meeting context box. The parser itself is shared/ics.cjs (plain CommonJS, because the tray app that
// imports files cannot load TypeScript); this is the typed entry point for the engine, the CLI and the tests. No dependency.
import { createRequire } from "node:module";
import type { IcsEvent } from "../shared/ics.d.cts";

export type { IcsEvent, IcsPerson } from "../shared/ics.d.cts";
const ics = createRequire(import.meta.url)("../shared/ics.cjs") as typeof import("../shared/ics.d.cts");

/** All events of a calendar text (never throws; repeat rules are not expanded). */
export const parseIcs = (text: string): IcsEvent[] => ics.parseIcs(text).events;
/** The event to plan for: the soonest one that is not over, else the first. */
export const pickEvent = ics.pickEvent;
/** Plan fields (title, time, who) and a readable background text for one event. Mail addresses are not included. */
export const eventToPlan = ics.eventToPlan;
