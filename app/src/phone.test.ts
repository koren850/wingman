import { test } from "node:test";
import assert from "node:assert/strict";
import { PhoneRouter, isPhoneCall } from "./phone.ts";
import type { SttResult } from "./providers/stt/types.ts";

const tone = (amp: number, ms: number) => {
  const b = Buffer.alloc(ms * 32);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(Math.round(Math.sin(i / 7) * amp * 32767), i);
  return b;
};
const res = (words: [string, number, number, number][], endWall: number, final = true): SttResult => ({
  channel: "me",
  isFinal: final,
  speechFinal: final,
  arrivedAt: endWall + 300,
  speechEndWall: endWall,
  words: words.map(([word, speaker, start, end]) => ({ word, speaker, start, end })),
  text: words.map((w) => w[0]).join(" "),
});

test("isPhoneCall: plan note or env", () => {
  assert.equal(isPhoneCall(["Phone call on speaker"], {}), true);
  assert.equal(isPhoneCall(["שיחת טלפון ברמקול"], {}), true);
  assert.equal(isPhoneCall(["The call may be in English"], {}), false);
  assert.equal(isPhoneCall(undefined, { WINGMAN_PHONE: "1" }), true);
  assert.equal(isPhoneCall(["Phone call on speaker"], { WINGMAN_PHONE: "0" }), false);
});

test("first voice is me until two voices are known; then the louder voice is me", () => {
  const p = new PhoneRouter();
  // 0-1 s: loud (me, speaker 0); 1-2 s: quiet (phone, speaker 1)
  p.recordMic(tone(0.6, 1000), 1000);
  p.recordMic(tone(0.15, 1000), 2000);
  const a = p.route(
    res(
      [
        ["hello", 0, 0, 0.3],
        ["this", 0, 0.3, 0.6],
        ["is", 0, 0.6, 0.8],
        ["dana", 0, 0.8, 1.0],
      ],
      1000,
    ),
  );
  assert.equal(a[0].channel, "me");
  const b = p.route(
    res(
      [
        ["hi", 1, 1.0, 1.3],
        ["tell", 1, 1.3, 1.5],
        ["me", 1, 1.5, 1.7],
        ["about", 1, 1.7, 1.85],
        ["yourself", 1, 1.85, 2.0],
      ],
      2000,
    ),
  );
  assert.equal(b[0].channel, "them");
});

test("louder voice wins even if the phone spoke first", () => {
  const p = new PhoneRouter();
  p.recordMic(tone(0.1, 1000), 1000);
  p.recordMic(tone(0.5, 1000), 2000);
  p.route(
    res(
      [
        ["hi", 1, 0, 0.3],
        ["dana", 1, 0.3, 0.6],
        ["this", 1, 0.6, 0.8],
        ["is", 1, 0.8, 1.0],
      ],
      1000,
    ),
  );
  p.route(
    res(
      [
        ["yes", 0, 1.0, 1.3],
        ["hi", 0, 1.3, 1.6],
        ["there", 0, 1.6, 1.8],
        ["thanks", 0, 1.8, 2.0],
      ],
      2000,
    ),
  );
  const c = p.route(
    res(
      [
        ["so", 1, 0, 0.3],
        ["what", 1, 0.3, 0.6],
        ["is", 1, 0.6, 0.8],
        ["next", 1, 0.8, 1.0],
      ],
      1000,
    ),
  );
  assert.equal(c[0].channel, "them");
  const d = p.route(
    res(
      [
        ["ok", 0, 1.0, 1.5],
        ["great", 0, 1.5, 2.0],
      ],
      2000,
    ),
  );
  assert.equal(d[0].channel, "me");
});

test("a mixed final is split per speaker; one-word flicker is merged", () => {
  const p = new PhoneRouter();
  p.recordMic(tone(0.6, 1000), 1000);
  p.recordMic(tone(0.15, 1000), 2000);
  const out = p.route(
    res(
      [
        ["thanks", 0, 0, 0.3],
        ["for", 0, 0.3, 0.6],
        ["calling", 0, 0.6, 1.0],
        ["so", 1, 1.0, 1.2],
        ["why", 1, 1.2, 1.4],
        ["x", 0, 1.4, 1.5],
        ["here", 1, 1.5, 2.0],
      ],
      2000,
    ),
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].channel, "me");
  assert.equal(out[0].speechFinal, true);
  assert.equal(out[1].channel, "them");
  assert.match(out[1].text, /why/);
});

test("swap flips the roles", () => {
  const p = new PhoneRouter();
  p.recordMic(tone(0.6, 1000), 1000);
  const a = p.route(
    res(
      [
        ["a", 0, 0, 0.5],
        ["b", 0, 0.5, 1.0],
      ],
      1000,
    ),
  );
  assert.equal(a[0].channel, "me");
  p.swap();
  assert.equal(
    p.route(
      res(
        [
          ["a", 0, 0, 0.5],
          ["b", 0, 0.5, 1.0],
        ],
        1000,
      ),
    )[0].channel,
    "them",
  );
});

test("no speaker info: stays me (never answers the user's own words)", () => {
  const p = new PhoneRouter();
  const r = p.route({ channel: "me", isFinal: true, speechFinal: true, arrivedAt: 1, words: [], text: "hello" });
  assert.equal(r[0].channel, "me");
});

test("a lone quiet voice (the other side speaks first) is them; a lone near-field voice is still me", () => {
  const words = (id: number): [string, number, number, number][] => [
    ["tell", id, 0, 0.25],
    ["me", id, 0.25, 0.5],
    ["about", id, 0.5, 0.75],
    ["yourself", id, 0.75, 1.0],
  ];
  const quiet = new PhoneRouter();
  quiet.recordMic(tone(0.03, 1000), 1000); // rms ~0.02: far phone speaker
  const q = quiet.route(res(words(0), 1000));
  assert.equal(q[0].channel, "them");
  // Later the user answers, louder: the louder voice becomes me and the quiet one stays them.
  quiet.recordMic(tone(0.3, 1000), 2000);
  const a = quiet.route(
    res(
      words(1).map(([w, i, s, e]) => [w, i, s + 1, e + 1]),
      2000,
    ),
  );
  assert.equal(a[0].channel, "me");
  assert.equal(quiet.roleOf(0), "them");
  const loud = new PhoneRouter();
  loud.recordMic(tone(0.3, 1000), 1000);
  assert.equal(loud.route(res(words(0), 1000))[0].channel, "me");
});
