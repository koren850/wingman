// Cards that are not an answer to a question: fact cards from the local snapshot, the proposed client, live notes, must-cover reminders, the capture box (phones, emails, domains), and speaker names.
import { eventError } from "../errtext.ts";
import { type Fact } from "../entities.ts";
import { takeNotes } from "../notes.ts";
import { SaidIndex } from "../brief.ts";
import type { Channel } from "../providers/stt/types.ts";
import { extract } from "../capture.ts";
import { status } from "./out.ts";
import { log, S, callStart, brief, transcript, cost, notesAbort, registry, sup, notesOn, contextNotes, CONTROL, spotter, speakers } from "./boot.ts";
import { emitSide, emitCard } from "./cards.ts";
import { st } from "./state.ts";
import { proposeClient, proposeClientHow, reminderTitle, reminderMore } from "./strings.ts";
import { recentNotes } from "./rules.ts";
import { quantities, mismatches, refQuantities } from "../moments/overpromise.ts";
import { checkNumberSay, checkNumberWhy } from "./strings.ts";
import { engineV2 } from "./memory.ts";

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
  spk = speakers.resolve(spk); // a voice from a new connection that gives an earlier person's name is that person
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
        say: proposeClient(f.title),
        facts: [proposeClientHow(CONTROL)],
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
  if (engineV2(S)) return; // v2: the call memory replaces the live notes
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
  for (; saidLines < transcript.absLength; saidLines++) {
    const t = transcript.lineAt(saidLines);
    if (t) said.add(t.text);
  }
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
  emitSide({ id: `reminder-${++reminderSeq}`, badge: "reminder", say: reminderTitle(), facts: more > 0 ? [...shown, reminderMore(more)] : shown });
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

// ---- Over-promise check (moments.engine = v2): a number the user said against the notes and the call memory ----
const CHECK_GAP_MS = 20_000;
let checkSeq = 0;
/** A final line of the user. Digits, currency signs and the unit after a number (any language, no word list) are paired with the numbers of the prepared notes and
 *  the call memory. A mismatch gives one amber Check card with the user's figure and the figure from the notes (the text comes from the user's own notes, so the price
 *  guard, which blocks model text, does not apply). Nothing to compare with = no card. No model call. */
export function checkOwnLine(text: string) {
  if (!S.moments.checkPromises || !st.call.consented || st.call.shuttingDown) return;
  const said = quantities(text);
  if (!said.length) return;
  const m = st.m.mem;
  const refs = refQuantities({
    notes: [...contextNotes, ...(brief?.mustCover ?? [])],
    numbers: m.numbers,
    facts: m.facts.map((f) => f.text),
  });
  if (!refs.length) return;
  const hit = mismatches(said, refs)[0];
  if (!hit) return;
  const now = Date.now();
  const key = `${hit.said.unit}:${hit.said.value}`;
  if (st.m.promised.has(key) || now - st.m.lastPromiseAt < CHECK_GAP_MS) {
    log.write("events", { type: "moment.check-skip", why: st.m.promised.has(key) ? "repeat" : "gap" });
    return;
  }
  st.m.promised.add(key);
  st.m.lastPromiseAt = now;
  const n = ++checkSeq;
  emitCard({
    id: `ck-${n}`,
    turnId: `ck${n}`,
    badge: "careful",
    question: text.slice(0, 200),
    say: checkNumberSay(hit.said.raw, hit.ref.source),
    facts: [],
    priority: true,
    kind: "check",
    value: 2,
    why: checkNumberWhy(),
    at: now,
  });
  log.write("events", { type: "moment.check", said: hit.said.raw, ref: hit.ref.source });
}
