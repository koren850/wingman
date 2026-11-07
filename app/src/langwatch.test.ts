import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFinal, LangWatch } from "./langwatch.ts";

const RU = "Здравствуйте, можете рассказать подробнее о ваших услугах";
const ES = "Hola buenos días, quería preguntar cuánto cuesta el servicio para nuestra empresa";
const FR = "Bonjour, je voudrais savoir combien coûte votre service pour notre entreprise";
const EN = "Hi, can you tell me how much the service costs for our company";
const HE = "שלום, אשמח לשמוע כמה עולה השירות לחברה שלנו";

test("classifyFinal: script and function-word rule", () => {
  assert.equal(classifyFinal(RU), "foreign");
  assert.equal(classifyFinal(ES), "latin");
  assert.equal(classifyFinal(FR), "latin");
  assert.equal(classifyFinal(EN), "supported");
  assert.equal(classifyFinal(HE), "supported");
  assert.equal(classifyFinal("Hebrew mixed: מה המחיר ל-API"), "supported");
  for (const short of ["", "Yes", "ok thanks", "כן", "Да"]) assert.equal(classifyFinal(short), "neutral", short);
});

test("a streak of foreign finals shows the notice once", () => {
  const w = new LangWatch();
  const out = [0, 1, 2, 3, 4].map((i) => w.note(RU, 1000 + i * 5000));
  assert.deepEqual(out, [null, null, "show", null, null]);
  assert.equal(w.counts.foreign, 5);
  assert.equal(w.counts.notices, 1);
});

test("foreign finals spread over a long time, or between Hebrew/English lines, do not trigger", () => {
  const w = new LangWatch();
  assert.equal(w.note(RU, 0), null);
  assert.equal(w.note(RU, 40_000), null);
  assert.equal(w.note(RU, 100_000), null, "first one fell out of the 60 s window");
  const v = new LangWatch();
  assert.deepEqual(
    [RU, RU, EN, RU, RU].map((t, i) => v.note(t, i * 1000)),
    [null, null, null, null, null],
  );
  const x = new LangWatch(); // a hallucinated foreign line now and then inside a good call
  for (let i = 0; i < 10; i++) {
    assert.equal(x.note(i % 2 ? RU : HE, i * 3000), null);
  }
  assert.equal(x.counts.notices, 0);
});

test("Spanish or French calls: 4 Latin finals with no English trigger the same notice", () => {
  const w = new LangWatch();
  const out = [ES, FR, ES, FR, ES].map((t, i) => w.note(t, i * 8000));
  assert.deepEqual(out, [null, null, null, "show", null]);
  assert.equal(new LangWatch().note(EN), null);
});

test("the notice clears after two supported lines and is shown at most 3 times", () => {
  const w = new LangWatch({ foreignCount: 1, maxShows: 2 });
  assert.equal(w.note(RU, 0), "show");
  assert.equal(w.note(RU, 1000), null, "not repeated while shown");
  assert.equal(w.note(HE, 2000), null);
  assert.equal(w.note(EN, 3000), "clear");
  assert.equal(w.note(RU, 4000), "show");
  w.note(HE, 5000);
  w.note(HE, 6000);
  assert.equal(w.note(RU, 7000), null, "maxShows reached: no spam");
});
