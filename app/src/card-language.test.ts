// Card language follows the call: the label of an open-loop card, and the check that drops a card in the wrong language.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./env.ts";
import { tsx } from "./test-platform.ts";
import { openLoopSay } from "./tips.ts";
import { wrongTextLanguage } from "./reflex.ts";

const url = (f: string) => JSON.stringify(pathToFileURL(join(ROOT, f)).href);

// the open-loop card label follows the language of the item, not a call-wide guess.
test("open-loop card: the label has the language of the item", () => {
  assert.equal(openLoopSay({ kind: "promise", text: "send the project plan" }, "he"), "Promised, not done yet: send the project plan");
  assert.match(openLoopSay({ kind: "promise", text: "לשלוח את תוכנית הפרויקט" }, "en"), /^הבטחה שעוד לא בוצעה: /);
  assert.match(openLoopSay({ kind: "question", text: "12345" }, "en"), /^Still unanswered/);
});

// card language follows the call. A Hebrew card in an English call, or an English sentence card in a Hebrew call, is dropped for every text tag.
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
