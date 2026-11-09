// Speech-to-text clean-up for Hebrew numbers and weekdays ("60 1000", "יום 4º").
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSttText } from "./stt-clean.ts";

// Hebrew numbers and weekdays from smart formatting ("60 1000", "יום 4º").
test("stt clean: Hebrew '60 1000' is 60000, a weekday ordinal is the day name, other ordinal signs go; English is untouched", () => {
  assert.equal(cleanSttText("התקציב הוא 60 1000 שקל"), "התקציב הוא 60000 שקל");
  assert.equal(cleanSttText("50 1000 שקל ועוד 2 1000000"), "50000 שקל ועוד 2000000");
  assert.equal(cleanSttText("נפגש ביום 4º או ביום 5º"), "נפגש ביום רביעי או ביום חמישי");
  assert.equal(cleanSttText("שאלה 1º ועוד שאלה 2º"), "שאלה 1 ועוד שאלה 2");
  assert.equal(cleanSttText("יש לי 3 1000 מילים"), "יש לי 3000 מילים");
  assert.equal(cleanSttText("שלחתי 1000 שקל"), "שלחתי 1000 שקל");
  assert.equal(cleanSttText("We pay 60 1000 per year, 4º"), "We pay 60 1000 per year, 4º");
  assert.equal(cleanSttText(""), "");
});

test("stt clean: phone-like digit runs keep their digits", () => {
  assert.equal(cleanSttText("התקשר ל 050 1000000 מחר"), "התקשר ל 050 1000000 מחר");
  assert.equal(cleanSttText("הטלפון 052 123 1000 תודה"), "הטלפון 052 123 1000 תודה");
  assert.equal(cleanSttText("התקשר ל 03-1000000 מחר"), "התקשר ל 03-1000000 מחר");
  assert.equal(cleanSttText("התקציב 60 1000 שקל"), "התקציב 60000 שקל");
});
