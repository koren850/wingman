// Regression tests for the round 14 real-API findings (see AUDIT-2026-11-06/round14/realfix.md). One block per finding.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./env.ts";
import { tsx } from "./test-platform.ts";
import { checkLock } from "../qa/golden-load.ts";
import { main as recordMain, judgeCallOptions } from "../scripts/cassette-record.ts";
import { Cassette, cassettePaceOf } from "./providers/cassette.ts";
import { mergeParts } from "../qa/cassette-merge.ts";
import { writeFileSync } from "node:fs";
import { gradeCase, isJudgeTag, loadJudgeSet, scoreJudge } from "../qa/judge-set.ts";
import { parseMoment, splitInlineFields } from "./moments/parse.ts";
import { validatePatch } from "./session/patch.ts";
import { openLoopSay } from "./tips.ts";
import { wrongTextLanguage } from "./reflex.ts";
import { summarySystem } from "./summary.ts";
import { quantities, mismatches, refQuantities } from "./moments/overpromise.ts";
import { cleanSttText } from "./stt-clean.ts";
import { voiceFor } from "../qa/render.ts";
import { runMeeting } from "./e2e/v2-kit.ts";

const url = (f: string) => JSON.stringify(pathToFileURL(join(ROOT, f)).href);

// P0: boot.ts removes the key variables at import, the real recording worker used to read the key afterwards and got undefined.
test("real recording: the worker keeps the Anthropic key it was started with, although boot.ts removes it from the environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-rk-"));
  const r = spawnSync(
    ...tsx([
      "-e",
      `
    (async () => {
      const { REAL_ANTHROPIC_KEY } = await import(${url("src/testkit/real-key.ts")});
      await import(${url("src/test-setup.ts")});
      await import(${url("src/engine/boot.ts")});
      console.log(JSON.stringify({ kept: REAL_ANTHROPIC_KEY === "sk-ant-fake-for-test", env: process.env.ANTHROPIC_API_KEY ?? null }));
      process.exit(0);
    })();
  `,
    ]),
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-fake-for-test", DEEPGRAM_API_KEY: "dg-fake", WINGMAN_DATA_DIR: dir },
      timeout: 60_000,
    },
  );
  const line = (r.stdout || "").split("\n").find((l) => l.startsWith("{"));
  assert.ok(line, `no result line: ${r.stdout} ${r.stderr}`);
  assert.deepEqual(JSON.parse(line), { kept: true, env: null });
});

// P1: eval:judge --record crashed while scoring when a verdict tag was not in the table (BANK).
test("judge set: a verdict outside the table (BANK) is a wrong answer, not a crash in the scorer", () => {
  const cases = loadJudgeSet().slice(0, 2);
  assert.equal(isJudgeTag("BANK"), false);
  const results = cases.map((c) => gradeCase(c, { tag: "BANK" as never, say: "x" }));
  assert.ok(results.every((r) => !r.ok));
  const s = scoreJudge(cases, results);
  assert.equal(s.accuracy, 0);
});

// P1: the model judge returned an empty text because thinking used up the 80 output tokens.
test("model judge: a judge call turns thinking off and leaves room for the answer", () => {
  const o = judgeCallOptions("anthropic:claude-haiku-5-5");
  assert.deepEqual(o.providerOptions, { anthropic: { thinking: { type: "disabled" }, effort: "low" } });
  assert.ok(o.maxOutputTokens >= 100);
});

// P1: the held-out lock files must match the meetings (cassette-record --final and eval --final stop otherwise). Hashes only, no content is read as an eval.
test("held-out splits: test.lock and test-b.lock match the meetings", () => {
  checkLock("test");
  checkLock("test-b");
});

// P1: recording at --pace above 1 stretches the recorded model times. Refuse it, store the pace, and never let a gate read such a cassette.
test("cassette-record: the real transport refuses a pace above 1 unless --fast-ok", async () => {
  const lines: string[] = [];
  const code = await recordMain(
    ["--suite", "dev", "--cap", "1", "--pace", "4", "--only", "dev-silence-en"],
    { ANTHROPIC_API_KEY: "k" },
    { transport: "real", log: (l) => void lines.push(l) },
  );
  assert.equal(code, 2);
  assert.match(lines.join("\n"), /too long/);
});

test("cassette: the pace is stored in the file and survives a merge", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-pace-"));
  const part = join(dir, "a.part.json"),
    out = join(dir, "a.json");
  new Cassette().save(part);
  assert.equal(cassettePaceOf(part), undefined);
  mergeParts(out, [part], 4);
  assert.equal(cassettePaceOf(out), 4);
  assert.equal(new Cassette(out).pace, 4);
});

test("eval: a cassette recorded at pace 4 is refused for --ship, --final and --update", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-pace-e-"));
  const f = join(dir, "dev.cassette.json");
  writeFileSync(f, JSON.stringify({ v: 1, pace: 4, entries: [] }));
  const r = spawnSync(...tsx(["scripts/eval.ts", "--ship", "--cassette", f]), {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, WINGMAN_DATA_DIR: dir },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /recorded at pace 4/);
});

// P1: a fresh user got the web and hosting example pack in every meeting. The example pack is now read only when it is asked for.
test("pack: no user pack means no prepared cards; the example pack is read only on request", async () => {
  const { packDirs, packPath, exampleAllowed, EXAMPLE_PACK } = await import("./pack.ts");
  const empty = mkdtempSync(join(tmpdir(), "wm-nopack-"));
  const env = { WINGMAN_PACK_DIR: empty } as NodeJS.ProcessEnv;
  assert.deepEqual(packDirs(env), [empty]);
  assert.equal(packPath("bank.yaml", env), undefined);
  assert.equal(packPath("topics.txt", env), undefined);
  for (const on of [{ WINGMAN_EXAMPLE_PACK: "1" }, { WINGMAN_DEMO: "1" }, { WINGMAN_STT_SCRIPT: "/x.json" }])
    assert.deepEqual(packDirs({ ...env, ...on }), [empty, EXAMPLE_PACK]);
  // a user pack with its own bank may lack other files: those come from the example pack (doctor warns)
  writeFileSync(join(empty, "bank.yaml"), "[]\n");
  assert.equal(exampleAllowed({}, empty), true);
  assert.equal(packPath("house-style.md", env), join(EXAMPLE_PACK, "house-style.md"));
});

test("bank: loadBank() with no pack returns no cards instead of throwing", async () => {
  const { loadBank } = await import("./bank.ts");
  const prev = process.env.WINGMAN_PACK_DIR,
    prevEx = process.env.WINGMAN_EXAMPLE_PACK;
  process.env.WINGMAN_PACK_DIR = mkdtempSync(join(tmpdir(), "wm-nopack-"));
  delete process.env.WINGMAN_EXAMPLE_PACK;
  try {
    assert.deepEqual(loadBank(), []);
    assert.throws(() => loadBank(""));
  } finally {
    process.env.WINGMAN_PACK_DIR = prev;
    process.env.WINGMAN_EXAMPLE_PACK = prevEx;
  }
});

// P1: the strict parser dropped useful replies (fields on one line, no VALUE) and the model reasoned aloud on line 1.

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

// P1: the memory updater with the real model lost 54 of 73 replies: it writes facts as plain strings, and one unusable roster entry dropped the whole patch.

test("memory patch: facts written as plain strings are kept as facts", () => {
  const r = validatePatch({
    add: { facts: ["North branch goes first", { text: "Harbor branch two weeks later", who: "Yael" }], numbers: [{ what: "delay", value: "two weeks" }] },
  });
  assert.equal(r.ok, true);
  if (r.ok)
    assert.deepEqual(
      r.patch.add.map((a) => a.f.text ?? a.f.what),
      ["North branch goes first", "Harbor branch two weeks later", "delay"],
    );
});

test("memory patch: a roster entry with an unknown side is left out and the rest of the patch is kept", () => {
  const r = validatePatch({
    add: { commitments: [{ who: "me", what: "ask billing to split the invoice", due: "before 1 December" }] },
    roster: [
      { name: "problem", side: "unknown", role: "unclear" },
      { name: "Dana", side: "them" },
    ],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.patch.add.length, 1);
    assert.deepEqual(r.patch.roster, [{ name: "Dana", side: "them" }]);
  }
  assert.equal(validatePatch({ add: { decisions: ["x"] } }).ok, false, "a string is repaired only for facts");
});

test("memory patch: the recorded real replies (memory cassette) are no longer dropped for their shape", () => {
  const cas = JSON.parse(readFileSync(join(ROOT, "data/cassettes/memory.cassette.json"), "utf8")) as { entries: { chunks: { text?: string }[] }[] };
  let ok = 0,
    shape = 0;
  for (const e of cas.entries) {
    const text = e.chunks.map((c) => c.text ?? "").join("");
    const a = text.indexOf("{"),
      b = text.lastIndexOf("}");
    if (a < 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(text.slice(a, b + 1));
    } catch {
      continue;
    }
    const r = validatePatch(raw);
    if (r.ok) ok++;
    else if (/not an object|bad side/.test(r.reason)) shape++;
  }
  assert.equal(shape, 0);
  assert.ok(ok >= 60, `only ${ok} replies valid`);
});

// P1: the open-loop card label follows the language of the item, not a call-wide guess.
test("open-loop card: the label has the language of the item", () => {
  assert.equal(openLoopSay({ kind: "promise", text: "send the project plan" }, "he"), "Promised, not done yet: send the project plan");
  assert.match(openLoopSay({ kind: "promise", text: "לשלוח את תוכנית הפרויקט" }, "en"), /^הבטחה שעוד לא בוצעה: /);
  assert.match(openLoopSay({ kind: "question", text: "12345" }, "en"), /^Still unanswered/);
});

// P1: card language follows the call. A Hebrew card in an English call, or an English sentence card in a Hebrew call, is dropped for every text tag.
test("language: wrongTextLanguage judges a card text against the language it should follow", () => {
  assert.equal(wrongTextLanguage("en", "אל תתחייב למועד מרץ בלי לבדוק"), true);
  assert.equal(wrongTextLanguage("en", "You said $1,200. Check the notes."), false);
  assert.equal(wrongTextLanguage("en", "Pilot in March, אבל לבדוק"), false);
  assert.equal(wrongTextLanguage("he", "Do not promise a date before you check the plan"), true);
  assert.equal(wrongTextLanguage("he", "כן, זה עובד עם WooCommerce"), false);
  assert.equal(wrongTextLanguage("he", "PHP 8.2"), false);
});

test("language: sayAllowed drops a Hebrew CHECK card in an English call and an English REPLY in a Hebrew call, keeps the right ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-lang-"));
  const r = spawnSync(
    ...tsx([
      "-e",
      `
    (async () => {
      await import(${url("src/test-setup.ts")});
      const { sayAllowed } = await import(${url("src/engine/moments.ts")});
      const m = (tag, say) => ({ tag, value: 2, aim: "me", say, why: "", more: [] });
      const out = [
        sayAllowed(m("CHECK", "אמרת 1,200 דולר, בהערות כתוב 85,000"), "What is the monthly price?", "en").ok,
        sayAllowed(m("CHECK", "You said 1,200 dollars; the notes say 85,000"), "What is the monthly price?", "en").ok,
        sayAllowed(m("REPLY", "Let me check with the team and come back to you"), "כמה זה עולה?", "he").ok,
        sayAllowed(m("REPLY", "אבדוק מול הצוות ואחזור אליך"), "כמה זה עולה?", "he").ok,
        sayAllowed(m("NOTE", "Pilot in March"), "", "en").ok,
      ];
      console.log("R" + JSON.stringify(out));
      process.exit(0);
    })();
  `,
    ]),
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "k", DEEPGRAM_API_KEY: "k", WINGMAN_DATA_DIR: dir }, timeout: 60_000 },
  );
  const line = (r.stdout || "").split("\n").find((l) => l.startsWith("R["));
  assert.ok(line, `${r.stdout} ${r.stderr}`);
  assert.deepEqual(JSON.parse(line.slice(1)), [false, true, false, true, true]);
});

// P1: the profile name leaked into the call summary ("Alex (Dan) walked ...") when the call used another name for the user.
test("summary prompt: the user is never named in the summary lists", () => {
  for (const lang of ["en", "he"] as const) {
    const p = summarySystem(lang);
    assert.match(p, /never write .* name in "summary", "decisions", "nextSteps" or "openQuestions"/);
    assert.match(p, lang === "en" ? /"you" or "the user"/ : /"אתה" or "המשתמש"/);
  }
});

// P1: the Check card compared unrelated numbers (a monthly price against a total budget).
test("check: figures of very different size are not one figure said wrong; a near miss still is", () => {
  const refs = refQuantities({ notes: ["budget: $85,000", "monthly hosting cost: 250 shekels a month", "Pilot price: $1,000"] });
  assert.equal(
    mismatches(
      quantities("The monthly price is $1,200"),
      refs.filter((r) => r.source.startsWith("budget")),
    ).length,
    0,
  );
  assert.equal(
    mismatches(
      quantities("It is 8,000 shekels for the fourth language"),
      refs.filter((r) => r.source.startsWith("monthly")),
    ).length,
    0,
  );
  assert.equal(mismatches(quantities("1200 ₪ for the site"), refQuantities({ notes: ["budget 60,000 NIS"] })).length, 0);
  assert.equal(
    mismatches(
      quantities("The pilot price is $1,200"),
      refs.filter((r) => r.source.startsWith("Pilot")),
    ).length,
    1,
  );
  assert.equal(
    mismatches(
      quantities("The pilot price is $10,000"),
      refs.filter((r) => r.source.startsWith("Pilot")),
    ).length,
    1,
    "one zero too many",
  );
});

// P2: Hebrew numbers and weekdays from smart formatting ("60 1000", "יום 4º").
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

// P2: mixed-language speech tests need one voice per language.
test("qa render: a voice speaks only text in its own language; a mixed scenario gets one voice per language", () => {
  assert.equal(voiceFor("כמה זה עולה?", "them", "Samantha"), "Carmit");
  assert.equal(voiceFor("How much does it cost?", "them", "Carmit"), "Samantha");
  assert.equal(voiceFor("How much does it cost?", "me", undefined), "Daniel");
  assert.equal(voiceFor("אני אבדוק", "me", undefined), "Carmit");
  assert.equal(voiceFor("How much", "them", "Samantha"), "Samantha");
  assert.equal(voiceFor("שלום", "them", "Samantha", "Daniel"), "Daniel", "an explicit voice on the turn wins");
});

// P0: 126 of 984 calls were missing on replay. The classifier for the user's own lines used the profile's scripted fake, so it was never recorded.
test("recording: a mock recording holds no call on the scripted fake model, and the same recording replays without a miss", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-rec-"));
  const file = join(dir, "c.json");
  await runMeeting("dev-sales-en", { split: "dev", asks: false, record: { cassette: file, transport: "mock" } }, 120_000);
  const c = new Cassette(file);
  assert.ok(c.size > 0);
  assert.deepEqual(
    c.entries().filter((e) => e.model.startsWith("scripted:")),
    [],
  );
  const again = await runMeeting("dev-sales-en", { split: "dev", asks: false, replay: { cassette: file } }, 120_000);
  assert.equal(again.cassetteMisses, 0);
});
