// Round 12 review of r2-context-inputs: edge cases found while trying to break the readers. No network.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readSource } from "./session/inputs.ts";

const require_ = createRequire(import.meta.url);
const inputs = require_("../shared/inputs.cjs") as {
  expandRepeats: (ev: Record<string, unknown>, from: number, to: number) => { startMs: number; endMs: number }[];
  nearestEvent: (evs: Record<string, unknown>[], now: number) => { startMs: number; title?: string } | null;
};
const catalog = require_("../tray/settings-catalog.cjs") as { toStored: (item: unknown, v: unknown) => unknown; BY_KEY: Map<string, unknown> };

const H = 3600_000;
const D = 24 * H;
const ev = (o: Record<string, unknown>) => ({
  title: "x",
  startMs: 0,
  endMs: 0,
  allDay: false,
  attendees: [],
  organizer: null,
  location: "",
  description: "",
  recurring: false,
  cancelled: false,
  ...o,
});

test("a lookup that never answers is stopped at the time limit (the 8 s covers the name lookup too)", async () => {
  const never = () => new Promise<never>(() => {});
  const t0 = Date.now();
  await assert.rejects(
    readSource({ type: "url", url: "https://slow.example.com/" }, { lookup: never as never, fetch: (async () => new Response("x")) as never, timeoutMs: 80 }),
    /did not answer/,
  );
  assert.ok(Date.now() - t0 < 2000);
});

test("repeating events: weekly with BYDAY, daily with COUNT, UNTIL, EXDATE and a short month", () => {
  const start = new Date(2026, 0, 5, 9, 0).getTime(); // Monday 5 Jan 2026, 09:00 local
  const weekly = ev({ startMs: start, endMs: start + H, recurring: true, rrule: "FREQ=WEEKLY;BYDAY=MO,WE" });
  const now = new Date(2026, 10, 9, 10, 0).getTime(); // Monday 9 Nov, after 09:00
  const r = inputs.expandRepeats(weekly, now - D, now + 7 * D);
  assert.deepEqual(
    r.map((x) => new Date(x.startMs).getDay() + ":" + new Date(x.startMs).getHours()),
    ["1:9", "3:9", "1:9"].slice(0, r.length),
  );
  assert.equal(new Date(r[0].startMs).getDate(), 9);
  assert.equal(r[0].endMs - r[0].startMs, H);
  const counted = ev({ startMs: start, endMs: start + H, recurring: true, rrule: "FREQ=DAILY;COUNT=3" });
  assert.equal(inputs.expandRepeats(counted, 0, start + 30 * D).length, 3);
  const ended = ev({ startMs: start, endMs: start + H, recurring: true, rrule: "FREQ=DAILY;UNTIL=20260103T000000Z" });
  assert.equal(inputs.expandRepeats(ended, 0, start + 30 * D).length, 0);
  const skipped = ev({ startMs: start, endMs: start + H, recurring: true, rrule: "FREQ=DAILY;COUNT=3", exdates: [start + D] });
  assert.equal(inputs.expandRepeats(skipped, 0, start + 30 * D).length, 2);
  const m31 = ev({ startMs: new Date(2026, 0, 31, 9).getTime(), recurring: true, rrule: "FREQ=MONTHLY" });
  const months = inputs.expandRepeats(m31, 0, new Date(2026, 5, 30).getTime()).map((x) => new Date(x.startMs).getMonth());
  assert.deepEqual(months, [0, 2, 4]);
  assert.deepEqual(inputs.expandRepeats(ev({ startMs: start, recurring: true, rrule: "FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO" }), 0, start + 90 * D), []);
  assert.deepEqual(inputs.expandRepeats(ev({ startMs: start, recurring: true, rrule: "FREQ=SECONDLY" }), 0, start + D), []);
});

test("nearest event: a weekly meeting that started months ago is found at its next date, not its first", () => {
  const start = new Date(2026, 0, 5, 9, 0).getTime();
  const now = new Date(2026, 10, 9, 10, 30).getTime(); // Monday after the 09:00-10:00 slot
  const weekly = ev({ title: "Weekly sync", startMs: start, endMs: start + H, recurring: true, rrule: "FREQ=WEEKLY" });
  const once = ev({ title: "Old one-off", startMs: start - 30 * D, endMs: start - 30 * D + H });
  const r = inputs.nearestEvent([once, weekly], now);
  assert.equal(r?.title, "Weekly sync");
  assert.equal(new Date(r!.startMs).getDate(), 16); // next Monday
});

test("calendar link: a repeating meeting through the parser and the reader", async () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "SUMMARY:Weekly sync",
    "DTSTART:20260105T090000Z",
    "DTEND:20260105T100000Z",
    "RRULE:FREQ=WEEKLY",
    "EXDATE:20260112T090000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const f = (async () => new Response(ics, { headers: { "content-type": "text/calendar" } })) as unknown as typeof fetch;
  const now = Date.UTC(2026, 0, 11, 12, 0); // the 12 Jan slot is skipped, so the 19th is next
  const r = await readSource(
    { type: "calendar", url: "https://calendar.example.com/x.ics" },
    { fetch: f, lookup: (async () => [{ address: "93.184.216.34", family: 4 }]) as never, now },
  );
  assert.equal(r.when, Date.UTC(2026, 0, 19, 9, 0));
  assert.doesNotMatch(r.text, /Only the first date/);
});

test("settings: webcal:// becomes https:// for the calendar address; other schemes are refused", () => {
  const item = catalog.BY_KEY.get("context.calendarUrl");
  assert.equal(catalog.toStored(item, "webcal://calendar.example.com/p/a.ics"), "https://calendar.example.com/p/a.ics");
  assert.throws(() => catalog.toStored(item, "http://calendar.example.com/a.ics"), /https/);
  assert.throws(() => catalog.toStored(item, "ftp://x/a.ics"), /https/);
  assert.equal(catalog.toStored(item, ""), "");
});
