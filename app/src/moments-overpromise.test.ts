// Over-promise check (src/moments/overpromise.ts): language neutral, no word lists, pairs a said number with the notes by unit and shared word.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { quantities, mismatches, refQuantities } from "./moments/overpromise.ts";

const check = (said: string, notes: string[], numbers: { what: string; value: string }[] = []) =>
  mismatches(quantities(said), refQuantities({ notes, numbers }));

test("quantities: digits with a currency sign, a percent sign or the word after them; thousands and decimals", () => {
  const q = quantities("It costs 5,000 ₪ and takes 2.5 weeks, with 30% off. Version v2 stays.");
  assert.deepEqual(
    q.map((x) => [x.value, x.unit, x.money]),
    [
      [5000, "₪", true],
      [2.5, "wee", false],
      [30, "%", false],
    ],
  );
  assert.deepEqual(
    quantities("$120 per month").map((x) => [x.value, x.unit, x.money]),
    [[120, "$", true]],
  );
  assert.deepEqual(
    quantities("1.200 שקל").map((x) => x.value),
    [1200],
  );
  assert.equal(quantities("no numbers here at all").length, 0);
});

test("a money figure that differs from the notes is a mismatch, in English and in Hebrew, with no word list", () => {
  assert.equal(check("I can do it for 4000 ₪", ["Quoted price: 5000 ₪ for the full site"]).length, 1);
  assert.equal(check("אני יכול לעשות את זה ב-4000 ₪", ["הצעת מחיר: 5000 ₪ לאתר מלא"]).length, 1);
  assert.equal(check("That is $90", ["Plan costs $120"]).length, 1);
  assert.equal(check("It is 5000 ₪ for you", ["Quoted price: 5000 ₪"]).length, 0, "the same figure is fine");
  assert.equal(check("It is 5,000 ₪", ["Quoted price: 5000 ₪"]).length, 0, "5,000 equals 5000");
});

test("a time unit needs a shared word: delivery in 3 weeks against notes that say 2 weeks for delivery, not 2 weeks of training", () => {
  assert.equal(check("Delivery will take 3 weeks", ["Delivery takes 2 weeks"]).length, 1);
  assert.equal(check("We have 3 weeks of vacation", ["Delivery takes 2 weeks"]).length, 0, "different subject: no pair, no card");
  assert.equal(check("Delivery will take 2 weeks", ["Delivery takes 2 weeks"]).length, 0);
});

test("memory numbers are read like notes; with nothing to compare against there is no mismatch", () => {
  const m = check("The monthly fee is 300 ₪", [], [{ what: "monthly fee", value: "250 ₪" }]);
  assert.equal(m.length, 1);
  assert.match(m[0].ref.source, /monthly fee/);
  assert.equal(check("The monthly fee is 300 ₪", []).length, 0);
  assert.equal(check("We talked for about 5 minutes", ["Price 5000 ₪"]).length, 0, "units do not pair");
});

test("odd input does not throw: huge numbers, empty text, weird characters", () => {
  assert.doesNotThrow(() => quantities("9".repeat(500) + " ₪ " + "\u0000‮" + " 1e999 NaN"));
  assert.deepEqual(quantities(""), []);
  assert.deepEqual(mismatches([], []), []);
});

test("money in words or short forms pairs with a currency sign in the notes (shekel, dollar, euro); a matching figure stays quiet", () => {
  const notes = ["The setup costs 5,000 ₪", "Hosting is $120 per month", "Training: 300 € total"];
  assert.equal(check("זה יעלה 4000 שקל", notes).length, 1);
  assert.equal(check("זה יעלה 4000 ש״ח", notes).length, 1);
  assert.equal(check("זה יעלה 5000 ש״ח", notes).length, 0);
  assert.equal(check("it is 200 dollars a month", notes).length, 1);
  assert.equal(check("it is 120 dollars a month", notes).length, 0);
  assert.equal(check("training is 250 euros", notes).length, 1);
  assert.equal(check("we have 4000 shekelim of luck", notes).length, 0, "a word that only starts like a unit is not money");
});

test("no notes and no memory = no reference numbers = nothing to report", () => {
  assert.equal(check("it costs 99999 ₪ and takes 40 weeks", []).length, 0);
});
