// The other side's voices: call-local numbers, names, labels for the models.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dominantSpeaker, SpeakerBook, lineLabel } from "./speakers.ts";

const w = (speaker?: number) => ({ word: "x", start: 0, end: 0.1, ...(speaker === undefined ? {} : { speaker }) });

test("dominant speaker: most words win; no speaker data gives undefined", () => {
  assert.equal(dominantSpeaker([w(3), w(3), w(0)]), 3);
  assert.equal(dominantSpeaker([w(), w()]), undefined);
});

test("speaker book: numbers in order of first voice, names override, labels for the models", () => {
  const b = new SpeakerBook();
  assert.deepEqual(b.of([w(7)]), { spk: 1 });
  assert.deepEqual(b.of([w(2), w(2)]), { spk: 2 });
  assert.deepEqual(b.of([w(7)]), { spk: 1 });
  b.setName(2, "Dana");
  assert.deepEqual(b.of([w(2)]), { spk: 2, name: "Dana" });
  assert.equal(b.count, 2);
  assert.equal(lineLabel("them", { spk: 1 }), "them (Speaker 1)");
  assert.equal(lineLabel("them", { spk: 2, name: "Dana" }), "them (Dana)");
  assert.equal(lineLabel("me", { spk: 1 }), "me");
  assert.equal(lineLabel("them"), "them");
});

test("attendee names: first names from a meeting's who line, either script", async () => {
  const { attendeeNames } = await import("./speakers.ts");
  assert.deepEqual(attendeeNames("Dana Levi, Pierre (IT) and רות כהן / Levi Studio"), ["Dana", "Pierre", "רות", "Levi"]);
  assert.deepEqual(attendeeNames(undefined), []);
});

test("introductions: attendees match in any script; 'I am' + an ordinary word is not a name", async () => {
  const { introName } = await import("./speakers.ts");
  const who = ["Dana", "Pierre", "רות"];
  assert.equal(introName("היי, אני רות מצוות ה-IT", who), "רות");
  assert.equal(introName("Thanks Dan. I'm Dana, I manage the content.", who), "Dana");
  assert.equal(introName("אני מבינה את זה", who), undefined);
  assert.equal(introName("I'm sure it works", who), undefined);
  assert.equal(introName("קוראים לי נועה ואני מהשיווק", who), "נועה");      // strong cue, not on the list
  assert.equal(introName("I'm Pierre, I handle the newsletter."), "Pierre"); // no list: a capitalised English name
  assert.equal(introName("אני מרים את זה עכשיו"), undefined);                // "מרים" is also a verb: needs the attendee list
  assert.equal(introName("אני מרים מהשיווק", ["מרים"]), "מרים");
  assert.equal(introName("I'm Donna. I manage the website content.", who), "Dana");   // misheard attendee: the list spelling wins
});

test("introductions: 'this is Zoom', \"it's Friday\", \"I'm Israeli\" do not name a voice; a long sentence or a stop-list word is not an intro", async () => {
  const { introName } = await import("./speakers.ts");
  for (const t of ["This is Zoom, can you hear me?", "It's Friday so I will keep it short", "I'm Israeli and I live in Tel Aviv", "Well this is Google Meet then", "It's Monday", "I'm Microsoft certified", "So I think that this is Pierre's idea about the website", "We looked at it yesterday and I'm Dana to the team"]) assert.equal(introName(t), undefined, t);
  assert.equal(introName("It's Friday", ["Friday"]), undefined, "even an odd attendee name is a day word here");
  assert.equal(introName("It's Dana's turn now", ["Dana"]), undefined);
  assert.equal(introName("Hi everyone, I'm Pierre."), "Pierre");
  assert.equal(introName("This is Dana speaking"), "Dana");
  assert.equal(introName("אני מרים את זה", ["מרים"]), undefined, "Hebrew verb after an attendee-like word");
  assert.equal(introName("זה שישי אז נקצר", ["Dana"]), undefined);
  assert.equal(introName("זה זום", []), undefined);
  assert.equal(introName("It's Dana here, the rest of the team will join in a few minutes", ["Dana"]), "Dana", "attendee match still works in a longer line");
});
