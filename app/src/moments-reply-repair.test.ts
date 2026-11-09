// The reply parser keeps useful replies: fields on one line, a missing VALUE or AIM, and no card when the model thinks aloud.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMoment, splitInlineFields } from "./moments/parse.ts";

// the strict parser dropped useful replies (fields on one line, no VALUE) and the model reasoned aloud on line 1.

test("parser: fields written on one line are read as separate fields", () => {
  const r = parseMoment("ANS AIM: me CONF: high VALUE: 2 SAY: כן, המידע מוצפן בהעברה ובאחסון LABEL: הצפנה");
  assert.equal(r.moment.tag, "ANS");
  assert.equal(r.moment.say, "כן, המידע מוצפן בהעברה ובאחסון");
  assert.equal(r.moment.label, "הצפנה");
  assert.equal(r.moment.value, 2);
  assert.equal(r.moment.aim, "me");
  assert.equal(r.moment.conf, "high");
  assert.equal(splitInlineFields("SAY: use WHY: carefully WHY: x"), "SAY: use\nWHY: carefully WHY: x"); // a name splits a line once
});

test("parser: a reply with a verdict, an aim and a say but no VALUE keeps its card with value 1; no SAY is still dropped", () => {
  const ok = parseMoment("ANS\nAIM: me\nCONF: high\nSAY: Yes, the data is encrypted.\nLABEL: Encryption");
  assert.equal(ok.moment.tag, "ANS");
  assert.equal(ok.moment.value, 1);
  assert.equal(ok.errors[0]?.reason, "defaulted:VALUE");
  const noSay = parseMoment("ANS\nVALUE: 2\nAIM: me");
  assert.equal(noSay.moment.tag, "SKIP");
  assert.equal(noSay.errors[0]?.reason, "missing:SAY");
});

test("parser: a bank choice or a stall kind followed by thinking aloud is no card", () => {
  for (const reply of [
    "BANK soc2-type-difference No wait, the bank list does not contain a SOC 2 card.",
    "BANK php-version Hmm, wait...",
    "STALL price hmm, actually the user already gave the price",
  ]) {
    const r = parseMoment(`${reply}\nVALUE: 2\nAIM: me\nSAY: x`);
    assert.equal(r.moment.tag, "SKIP", reply);
    assert.equal(r.errors[0]?.reason, "reasoning-aloud", reply);
  }
  // a clean choice, with or without closing punctuation, still works
  assert.equal(parseMoment("BANK dns-basics.\nVALUE: 3\nAIM: me").moment.bankId, "dns-basics");
  assert.equal(parseMoment("STALL price\nVALUE: 3\nAIM: me").moment.stall, "price");
});

test("parser: a VALUE or AIM that is absent is defaulted; one that is there but wrong still drops the reply", () => {
  assert.equal(parseMoment("ANS\nVALUE: 2\nSAY: hello there friend\n").moment.aim, "unclear");
  assert.equal(parseMoment("ANS\nAIM: me\nSAY: hello there friend\n").moment.value, 1);
  assert.equal(parseMoment("ANS\nVALUE: 9\nAIM: me\nSAY: hello there friend\n").errors[0]?.reason, "missing:VALUE");
  assert.equal(parseMoment("ANS\nVALUE: 2\nAIM: nobody\nSAY: hello there friend\n").errors[0]?.reason, "missing:AIM");
});
