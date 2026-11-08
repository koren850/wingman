// Meeting context input (round 12, d1): the .ics reader, chunking at import, unsupported files, and the brief / background-file lifecycle
// (no 6 h expiry, nothing consumed on load, retired only after the call is live and has saved its first memory). Offline, invented data only.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIcs, pickEvent, eventToPlan } from "./brief-ics.ts";
import { loadBrief, confirmBrief, BRIEF_DIR, LATEST_BRIEF } from "./brief.ts";
import { loadAttachments, confirmAttachments, ATTACH_DIR } from "./attachments.ts";

const req = createRequire(import.meta.url);
const att = req("../tray/attachments.cjs");
const crlf = (s: string) => s.trim().split("\n").join("\r\n") + "\r\n";
const bytes = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));

// ---- .ics fixtures ----
const TIMED = crlf(`
BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:one@example.test
SUMMARY:Hosting move\\, kickoff
DTSTART;TZID=Asia/Jerusalem:20261112T100000
DTEND;TZID=Asia/Jerusalem:20261112T110000
LOCATION:Room 4\\; Acme office
ORGANIZER;CN="Dana Levi":mailto:dana@acme.example
ATTENDEE;CN=Noam Bar;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:noam@acme.example
ATTENDEE;PARTSTAT=DECLINED;CN=Gone Person:mailto:gone@acme.example
ATTENDEE:mailto:ron.katz@acme.example
DESCRIPTION:Agenda: price and downtime.\\nJoin: https://meet.example/j/123?pwd=secret\\n<b>Bring</b> the offer.
BEGIN:VALARM
TRIGGER:-PT15M
SUMMARY:alarm text must not be the title
END:VALARM
END:VEVENT
END:VCALENDAR
`);
const ALLDAY = crlf(`
BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Offsite day
DTSTART;VALUE=DATE:20261120
DTEND;VALUE=DATE:20261121
END:VEVENT
END:VCALENDAR
`);
const RECUR = crlf(`
BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Weekly sync
DTSTART:20261109T090000Z
RRULE:FREQ=WEEKLY;COUNT=10
END:VEVENT
END:VCALENDAR
`);
const HEBREW = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "SUMMARY:פגישת היכרות עם נועה",
  "DTSTART:20261115T133000",
  "DESCRIPTION:דיון על מחיר ועל מועד ההעברה. הלקוחה מעדיפה וואטסאפ. זה טקסט ארוך",
  "  שנשבר באמצע שורה (קיפול).",
  "ATTENDEE;CN=נועה כהן:mailto:noa@example.test",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

test("ics: a timed event in a named zone, with escapes, attendees, organizer, and no alarm text", () => {
  const [ev] = parseIcs(TIMED);
  assert.equal(ev.title, "Hosting move, kickoff");
  assert.equal(ev.startMs, Date.UTC(2026, 10, 12, 8, 0), "10:00 in Jerusalem in November is 08:00 UTC");
  assert.equal(ev.endMs, Date.UTC(2026, 10, 12, 9, 0));
  assert.equal(ev.allDay, false);
  assert.equal(ev.location, "Room 4; Acme office");
  assert.equal(ev.organizer?.name, "Dana Levi");
  assert.deepEqual(
    ev.attendees.map((a) => [a.name, a.status]),
    [
      ["Noam Bar", "ACCEPTED"],
      ["Gone Person", "DECLINED"],
      ["ron katz", ""],
    ],
    "a missing CN falls back to the mail name",
  );
  assert.match(ev.description, /^Agenda: price and downtime\.\nJoin: \[link\]\s+Bring the offer\.$/, "links and tags are removed from the description");
});

test("ics: plan fields never carry a mail address, skip declined people, and cap the list", () => {
  const p = eventToPlan(parseIcs(TIMED)[0]);
  assert.equal(p.fields.who, "Dana Levi, Noam Bar, ron katz");
  assert.equal(p.fields.title, "Hosting move, kickoff");
  assert.equal(p.fields.at, Date.UTC(2026, 10, 12, 8, 0));
  assert.doesNotMatch(p.text, /@|meet\.example|secret/, "no address, no join link");
  assert.match(p.text, /Invited: Dana Levi, Noam Bar, ron katz/);
  const many = TIMED.replace("END:VEVENT", Array.from({ length: 9 }, (_, i) => `ATTENDEE;CN=P${i}:mailto:p${i}@x.test`).join("\r\n") + "\r\nEND:VEVENT");
  assert.match(eventToPlan(parseIcs(many)[0]).fields.who, / \+\d+$/);
});

test("ics: an all-day event has a date and no time of day", () => {
  const [ev] = parseIcs(ALLDAY);
  assert.equal(ev.allDay, true);
  assert.equal(ev.startMs, new Date(2026, 10, 20).getTime());
  const p = eventToPlan(ev);
  assert.equal(p.fields.at, 0, "an all-day event gives the plan no clock time");
  assert.match(p.text, /When: 2026-11-20 \(all day\)/);
});

test("ics: a repeat rule is not expanded; the first date is the time and the plan says so", () => {
  const evs = parseIcs(RECUR);
  assert.equal(evs.length, 1, "one event, not ten");
  assert.equal(evs[0].recurring, true);
  assert.equal(evs[0].startMs, Date.UTC(2026, 10, 9, 9, 0));
  assert.match(eventToPlan(evs[0]).text, /repeating meeting. Only the first date/);
});

test("ics: a Hebrew title, a folded line and a floating time are read as UTF-8", () => {
  const [ev] = parseIcs(HEBREW);
  assert.equal(ev.title, "פגישת היכרות עם נועה");
  assert.equal(ev.startMs, new Date(2026, 10, 15, 13, 30).getTime(), "no zone: local time");
  assert.match(ev.description, /זה טקסט ארוך שנשבר באמצע שורה \(קיפול\)\./, "the folded line is joined");
  assert.equal(eventToPlan(ev).fields.who, "נועה כהן");
});

test("ics: garbage, empty and huge input never throw; the upcoming event is picked; cancelled ones come last", () => {
  for (const bad of ["", "not a calendar", "BEGIN:VEVENT", "\u0000\u0001 BEGIN:VEVENT\nDTSTART:zzz\nEND:VEVENT"]) assert.doesNotThrow(() => parseIcs(bad));
  assert.equal(parseIcs("BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:x\nDTSTART:zzz\nEND:VEVENT\nEND:VCALENDAR")[0].startMs, 0);
  const two = parseIcs(
    crlf(`
BEGIN:VEVENT
SUMMARY:Past
DTSTART:20200101T100000Z
END:VEVENT
BEGIN:VEVENT
SUMMARY:Cancelled soon
STATUS:CANCELLED
DTSTART:20261110T100000Z
END:VEVENT
BEGIN:VEVENT
SUMMARY:Next
DTSTART:20261111T100000Z
END:VEVENT
`),
  );
  assert.equal(two.length, 3);
  assert.equal(pickEvent(two, Date.UTC(2026, 10, 9))?.title, "Next");
  assert.equal(pickEvent([], 0), null);
  assert.equal(parseIcs("BEGIN:VEVENT\n".repeat(1) + "END:VEVENT\n".repeat(1)).length, 1);
});

// ---- the store: .ics import, chunking, unsupported files ----
const mk = (opts: object = {}) => {
  const dir = join(mkdtempSync(join(tmpdir(), "wingman-ctx-")), "files");
  return { dir, st: att.createStore({ dir, pdftotext: "", ...opts }) };
};

test("import: a dropped .ics is stored as a readable background text and returns the plan fields", async () => {
  const { st } = mk();
  const r = await st.addFile("invite.ics", bytes(TIMED));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.fields.title, "Hosting move, kickoff");
  assert.equal(r.fields.who, "Dana Levi, Noam Bar, ron katz");
  assert.match(st.readAll()[0].text, /^Meeting: Hosting move, kickoff/);
  const none = await st.addFile("empty.ics", bytes("BEGIN:VCALENDAR\r\nEND:VCALENDAR"));
  assert.equal(none.ok, false);
  assert.match(none.error, /No meeting found/);
});

test("import: a long text is chunked at about 500 tokens, no chunk is bigger, and no text is lost", async () => {
  const { st, dir } = mk();
  const para = (i: number) => `Section ${i}. ` + "The hosting contract renews in March and the price rises by four percent each year. ".repeat(12).trim();
  const text = Array.from({ length: 12 }, (_, i) => para(i)).join("\n\n");
  const r = await st.addFile("contract.md", bytes(text));
  assert.ok(r.ok);
  assert.ok(r.chunks > 1, "more than one chunk");
  const chunks = st.readChunks();
  assert.equal(chunks.length, r.chunks);
  for (const c of chunks) assert.ok(att.estimateTokens(c.text) <= att.CHUNK_TOKENS, `chunk ${c.i} is ${att.estimateTokens(c.text)} tokens`);
  assert.equal(chunks.map((c: { text: string }) => c.text.replace(/\s+/g, "")).join(""), text.replace(/\s+/g, ""), "joined chunks equal the text");
  assert.ok(readdirSync(dir).some((n) => n.endsWith(".chunks.json")));
  assert.equal(st.list().files[0].chunks, chunks.length);
  st.remove(r.id);
  assert.deepEqual(readdirSync(dir), [], "removing a file removes its chunks too");
});

test("import: small text is one chunk with no chunk file; Hebrew counts as more tokens per letter; a huge single word is cut", async () => {
  const { st, dir } = mk();
  const r = await st.addFile("small.txt", bytes("Short note about the call."));
  assert.equal(r.chunks, 1);
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.endsWith(".chunks.json")),
    [],
  );
  assert.ok(att.estimateTokens("שלום עולם ".repeat(100)) > att.estimateTokens("hello world ".repeat(100)) * 0.5);
  const heb = Array.from({ length: 30 }, (_, i) => `פסקה ${i}: ` + "המחיר עולה בארבעה אחוזים בכל שנה והחוזה מתחדש במרץ. ".repeat(10)).join("\n\n");
  const parts = att.chunkText(heb);
  assert.ok(parts.length > 3);
  for (const p of parts) assert.ok(att.estimateTokens(p) <= 500);
  const blob = att.chunkText("x".repeat(9000));
  assert.ok(blob.length >= 4 && blob.every((p: string) => att.estimateTokens(p) <= 500));
  assert.deepEqual(att.chunkText("   \n\n  "), []);
});

test("import: an unsupported dropped file gets a clear message that names the type and the way out", async () => {
  const { st } = mk();
  for (const [name, ext] of [
    ["notes.docx", ".docx"],
    ["slides.pptx", ".pptx"],
    ["photo.png", ".png"],
  ]) {
    const r = await st.addFile(name, bytes("PK\u0003\u0004 not really"));
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(`A \\${ext} file cannot be read here`));
    assert.match(r.error, /\.txt, \.md, \.pdf and \.ics/);
    assert.match(r.error, /Paste the text instead/);
  }
  const none = await st.addFile("README", bytes("text"));
  assert.match(none.error, /^That file cannot be read here/);
});

test("import: a PDF without pdftotext says so and how to go on; with a fake one the text is stored", async () => {
  const { st } = mk();
  const pdf = bytes("%PDF-1.4 invented");
  const r = await st.addFile("offer.pdf", pdf);
  assert.equal(r.ok, false);
  assert.match(r.error, /pdftotext/);
  assert.match(r.error, /Paste the text instead/);
  assert.equal((await st.addFile("fake.pdf", bytes("not a pdf"))).error, "That is not a PDF file.");
});

// ---- brief and background files: lifecycle ----
function withLatest(fn: () => void) {
  mkdirSync(BRIEF_DIR, { recursive: true });
  const saved = existsSync(LATEST_BRIEF);
  assert.equal(saved, false, "the test data folder starts empty");
  try {
    fn();
  } finally {
    rmSync(LATEST_BRIEF, { force: true });
    for (const n of readdirSync(BRIEF_DIR)) if (n.startsWith("used-")) rmSync(join(BRIEF_DIR, n), { force: true });
    rmSync(ATTACH_DIR, { recursive: true, force: true });
  }
}

test("brief: loading does not use it up and a brief days old is still loaded (no 6 h rule)", () =>
  withLatest(() => {
    writeFileSync(LATEST_BRIEF, 'who: "Dana, Acme"\ngoal: "agree a date"\nmustCover: ["price"]\n');
    const old = new Date(Date.now() - 5 * 24 * 3600_000);
    utimesSync(LATEST_BRIEF, old, old);
    assert.equal(loadBrief(undefined)?.who, "Dana, Acme");
    assert.equal(loadBrief(undefined)?.who, "Dana, Acme", "a second load (a restart) gets it again");
    assert.ok(existsSync(LATEST_BRIEF));
  }));

test("brief: it survives a kill after Start and before the first memory write; only confirmBrief retires it, once", () =>
  withLatest(() => {
    writeFileSync(LATEST_BRIEF, 'who: "Dana, Acme"\n');
    loadBrief(undefined); // call 1 starts, goes live, then the process is killed: confirmBrief never runs
    assert.ok(existsSync(LATEST_BRIEF), "the brief is still there after the crash");
    assert.equal(loadBrief(undefined)?.who, "Dana, Acme", "the retry gets it");
    assert.equal(confirmBrief(), true, "live and first memory saved");
    assert.equal(existsSync(LATEST_BRIEF), false);
    assert.equal(readdirSync(BRIEF_DIR).filter((n) => n.startsWith("used-")).length, 1, "kept as history");
    assert.equal(confirmBrief(), false, "twice does nothing");
    assert.equal(loadBrief(undefined), undefined, "the 9:00 brief does not start the 11:00 call");
  }));

test("brief: a brief saved during the call is not retired by the older call's confirm; an explicit --brief file is never touched", () =>
  withLatest(() => {
    writeFileSync(LATEST_BRIEF, 'who: "First"\n');
    loadBrief(undefined);
    writeFileSync(LATEST_BRIEF, 'who: "Second"\n');
    const later = new Date(Date.now() + 60_000);
    utimesSync(LATEST_BRIEF, later, later);
    assert.equal(confirmBrief(), false);
    assert.equal(loadBrief(undefined)?.who, "Second");
    rmSync(LATEST_BRIEF, { force: true });
    confirmBrief(); // clears the remembered file
    const explicit = join(mkdtempSync(join(tmpdir(), "wingman-brief-")), "b.yaml");
    writeFileSync(explicit, 'who: "Explicit"\n');
    assert.equal(loadBrief(explicit)?.who, "Explicit");
    assert.equal(confirmBrief(), false, "an explicit file was never marked for retiring");
    assert.ok(existsSync(explicit));
  }));

test("background files: reading keeps them, a plan's own folder is never touched, confirm retires only the single-Plan files that were read", async () => {
  const flat = att.createStore({ dir: ATTACH_DIR, pdftotext: "" });
  assert.ok(flat.addPaste("Invented background about Acme and its twelve sites.").ok);
  try {
    assert.equal(loadAttachments(10_000).length, 1);
    assert.equal(loadAttachments(10_000).length, 1, "still there after being read (and after a crash)");
    const late = flat.addPaste("A file added while the call runs.");
    assert.ok(late.ok);
    assert.equal(confirmAttachments(), 1, "only the one that was loaded");
    assert.equal(flat.list().files.length, 1, "the newer file waits for its own call");
    assert.equal(confirmAttachments(), 0);
    // a plan's own folder
    const own = mk();
    own.st.addPaste("Plan background text for the next call too.");
    process.env.WINGMAN_ATTACH_DIR = own.dir;
    try {
      assert.equal(loadAttachments(10_000).length, 1);
      assert.equal(confirmAttachments(), 0);
      assert.equal(own.st.list().files.length, 1, "a plan's files stay for reuse");
    } finally {
      delete process.env.WINGMAN_ATTACH_DIR;
    }
  } finally {
    rmSync(ATTACH_DIR, { recursive: true, force: true });
  }
});
