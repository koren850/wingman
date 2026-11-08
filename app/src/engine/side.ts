// Cards that are not an answer to a question: fact cards from the local snapshot, the proposed client, live notes, must-cover reminders, the capture box (phones, emails, domains), and speaker names.
import { eventError } from "../errtext.ts";
import { type Fact } from "../entities.ts";
import { takeNotes } from "../notes.ts";
import { SaidIndex } from "../brief.ts";
import type { Channel } from "../providers/stt/types.ts";
import { extract } from "../capture.ts";
import { status } from "./out.ts";
import { log, S, callStart, brief, transcript, cost, notesAbort, registry, sup, notesOn, contextNotes, CONTROL, spotter, speakers } from "./boot.ts";
import { emitSide } from "./cards.ts";
import { st } from "./state.ts";
import { recentNotes } from "./rules.ts";

/** Name speaker `spk` for the rest of the call (source "intro" = from their own introduction, "user" = the user renamed them). The
 *  answer window and the dashboard follow the cards.jsonl "speaker" row; later transcript rows carry the name. */
export function nameSpeaker(spk: number, name: string, source: "intro" | "user") {
  if (!Number.isInteger(spk) || spk < 1 || spk > 20) return;
  if (source === "intro" && (speakers.isManual(spk) || speakers.name(spk))) return;
  const clean = name
    .replace(/[\u0000-\u001f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim()
    .slice(0, 40);
  speakers.setName(spk, clean, source === "user");
  log.write("cards", { type: "speaker", spk, name: clean, source });
  log.write("events", { type: "speaker.name", spk, source, named: !!clean });
  console.log(`\n[🗣 speaker ${spk}] ${clean || "(cleared)"} (${source})`);
}
const factsShown = new Set<string>();
let clientChosen = !!brief?.who,
  proposed: Fact | undefined;
/** Looks up clients/domains in the local snapshot for this text and emits a fact card once per fact. May propose the client for confirmation. */
export function spotFacts(text: string) {
  if (!spotter) return;
  for (const f of spotter.spot(
    text,
    extract(text)
      .filter((c) => c.kind === "domain")
      .map((c) => c.value),
  )) {
    if (factsShown.has(f.key)) continue;
    factsShown.add(f.key);
    emitSide({ id: `fact-${f.key}`, badge: "fact", say: f.title, facts: f.lines, warn: f.warn || undefined });
    console.log(`\n[🗂 fact] ${f.title}${f.lines.length ? "\n   • " + f.lines.join("\n   • ") : ""}`);
    if (S.facts.proposeClient && !clientChosen && !proposed && f.clientId !== undefined) {
      proposed = f;
      emitSide({
        id: "propose-client",
        badge: "info",
        say: `נראה שזו שיחה עם ${f.title}`,
        facts: [CONTROL ? "לאשר בתפריט למעלה (Confirm client) = ה-AI יקבל את הפרטים" : "y בטרמינל = לאשר ולתת ל-AI את הפרטים"],
      });
      console.log(`\nLooks like a call with ${f.title}. Press y to confirm (adds it to the AI notes).`);
      status("propose", { title: f.title });
    }
  }
}
/** The user confirmed the proposed client: its facts join the AI context notes (once). */
export function confirmClient() {
  if (!proposed || clientChosen) return;
  clientChosen = true;
  contextNotes.push(`Client on this call: ${proposed.title}. ${proposed.lines.join("; ")}`.slice(0, 400));
  log.write("events", { type: "client.confirmed", key: proposed.key });
  emitSide({ id: "propose-client", badge: "info", say: `✓ ${proposed.title}`, facts: [] });
  console.log(`\n✓ client confirmed: ${proposed.title}`);
  status("client", { title: proposed.title });
}
export const liveNotes: string[] = [];
let notesLines: string[] = [],
  notesBusy = false;
const MAX_NOTES_LINES = 200; // lines waiting for the next notes round; the oldest are dropped when the AI stays down
/** Timer job (notes.everyMs): turns the new transcript lines into up to 2 notes. Skips while busy, not consenting, AI down or budget capped; the lines are dropped (not retried) if the call fails. */
export async function notesRound() {
  if (!notesOn || notesBusy || !st.call.consented || st.call.shuttingDown || !sup.caps.llm || cost.llmState() === "capped") return;
  const words = notesLines.join(" ").split(/\s+/).length;
  if (words < S.notes.minNewWords) return;
  const lines = notesLines;
  notesLines = [];
  notesBusy = true;
  try {
    const r = await takeNotes({
      registry,
      model: S.notes.model,
      existing: recentNotes(liveNotes),
      lines,
      signal: notesAbort.signal,
      timeoutMs: S.notes.timeoutMs,
      sttLanguage: S.stt.language,
    });
    if (st.call.shuttingDown) return;
    const c = cost.addLlm("notes", S.notes.model, r.usage, r.providerMetadata);
    log.write("usage", { role: "notes", model: S.notes.model, usage: r.usage, usd: c.usd });
    for (const n of r.notes) {
      liveNotes.push(n);
      emitSide({ id: `note-${liveNotes.length}`, badge: "note", say: n, facts: [] });
      console.log(`\n[📝 note] ${n}`);
    }
  } catch (e) {
    log.write("events", { type: "notes.error", error: eventError(e) });
  } finally {
    notesBusy = false;
  }
}
// Must-cover reminders from the brief.
let lastReminderAt = 0,
  reminderSeq = 0,
  lastReminderKey = "";
// Must-cover check without re-reading the transcript: each line is added to the index once, and an item that is covered stays covered.
const said = new SaidIndex();
let saidLines = 0;
const coveredItems = new Set<string>();
/** Must-cover items of the brief that no transcript line has touched yet. */
export function uncovered(): string[] {
  for (; saidLines < transcript.length; saidLines++) said.add(transcript[saidLines].text);
  return (brief?.mustCover ?? []).filter((i) => {
    if (coveredItems.has(i)) return false;
    if (!said.covers(i)) return true;
    coveredItems.add(i);
    return false;
  });
}
/** Timer job: after reminders.firstAfterMin, every everyMin, lists the brief items still not covered. */
export function reminderTick() {
  if (!S.reminders.enabled || !brief?.mustCover?.length || !st.call.consented || st.call.shuttingDown) return;
  const min = (Date.now() - callStart) / 60000;
  if (min < S.reminders.firstAfterMin || Date.now() - lastReminderAt < S.reminders.everyMin * 60000) return;
  if (reminderSeq >= 3) return;
  const left = uncovered();
  if (!left.length) return;
  // The same list every 10 minutes was noise. Remind only when the list changed, at most 3 times a call, 3 items a card.
  const key = left.join("|");
  if (key === lastReminderKey || reminderSeq >= 3) return;
  lastReminderAt = Date.now();
  lastReminderKey = key;
  const shown = left.slice(0, 3),
    more = left.length - shown.length;
  emitSide({ id: `reminder-${++reminderSeq}`, badge: "reminder", say: "עוד לא דיברתם על:", facts: more > 0 ? [...shown, `ועוד ${more}`] : shown });
  console.log(`\n[⏰ reminder] not covered yet: ${left.join(", ")}`);
}
const lastFinals: Partial<Record<Channel, string[]>> = {};
const captured = new Set<string>();
export function capture(ch: Channel, text: string) {
  if (!S.capture.enabled) return;
  const lf = (lastFinals[ch] ??= []);
  lf.push(text);
  if (lf.length > 2) lf.shift();
  for (const c of extract(lf.join(" "))) {
    const k = `${c.kind}:${c.value}`;
    if (captured.has(k)) continue;
    captured.add(k);
    log.write("cards", { type: "capture", ch, ...c });
    console.log(`\n[📋 ${c.kind}] ${c.value}`);
  }
}

/** True while a client was proposed from a fact card and the user has not confirmed it yet (terminal key `y`). */
export function clientProposed(): boolean {
  return !!proposed && !clientChosen;
}
/** Adds one transcript line to the next notes round. Capped: the AI can be down for an hour. */
export function queueNoteLine(line: string) {
  notesLines.push(line);
  if (notesLines.length > MAX_NOTES_LINES) notesLines.splice(0, notesLines.length - MAX_NOTES_LINES);
}
