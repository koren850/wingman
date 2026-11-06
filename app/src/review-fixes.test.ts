// Regression tests for the engine review (AUDIT-2026-11-06 / 7): one block per finding.
import "./test-setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { parseReflex } from "./reflex.ts";

test("reflex: a prose line before the tag does not become the tag while streaming", () => {
  assert.equal(parseReflex("Let me think about this\n", false).tagLine, undefined);
  assert.equal(parseReflex("Let me think about this\nANS\n", false).tagLine, "ANS");
  assert.equal(parseReflex("Let me think about this\nANS\nשלום\n", true).tagLine, "ANS");
  assert.equal(parseReflex("ANS\nשלום\n", false).tagLine, "ANS");
  assert.equal(parseReflex("Hmm\n", true).tagLine, "Hmm"); // the end of the stream decides (parseTag turns this into SKIP)
});

import { checkClaims, parseClaim, spokenNumbers } from "./claims.ts";
test("claims: a number belonging to a neighbouring unit is not attributed to the claimed unit", () => {
  const claims = [parseClaim("4+ years")!];
  for (const line of ["I managed 12 clients for 4 years", "I led 20 people over 4 years", "worked 6 months and 4 years", "I have 4.5 years of experience"])
    assert.equal(checkClaims(line, claims), undefined, line);
  assert.equal(checkClaims("I have 12 years of experience", claims)?.said, 12);
  assert.deepEqual(
    spokenNumbers("70-80 customers").map((x) => x.n),
    [70, 80],
  );
  assert.deepEqual(
    spokenNumbers("70 80 לקוחות")
      .map((x) => x.n)
      .sort(),
    [70, 80],
  );
});

import { CostMeter } from "./cost.ts";
test("cost: call minutes are per channel, not the sum of both channels", () => {
  const prices = { llm: {}, stt: { deepgram: 0.55 } } as never,
    budget = { maxUsdPerCall: 5, warnAt: 0.8, maxMinutesPerCall: 90 } as never;
  const c = new CostMeter(prices, budget);
  c.setSttSeconds({ deepgram: 7200 }, 2); // 60 minute call, two channels
  assert.equal(c.sttMinutes, 60);
  assert.equal(c.minutesState(), "ok");
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBank, matchBank } from "./bank.ts";
test("bank loader: numeric triggers and ids are coerced to strings, an empty file is no cards", () => {
  const d = mkdtempSync(join(tmpdir(), "bank-"));
  writeFileSync(join(d, "bank.yaml"), `- id: 404\n  title: t\n  say: hello\n  triggers: [2024, hosting]\n  facts: []\n`);
  const bank = loadBank(join(d, "bank.yaml"));
  assert.equal(bank[0].id, "404");
  assert.deepEqual(bank[0].triggers, ["2024", "hosting"]);
  assert.doesNotThrow(() => matchBank("what about 2024 hosting", bank));
  writeFileSync(join(d, "empty.yaml"), "");
  assert.deepEqual(loadBank(join(d, "empty.yaml")), []);
});

import { parseCli } from "./settings.ts";
test("cli: --flag=value works like --flag value", () => {
  const c = parseCli(["--profile=practice", "--file=x.wav", "--model=anthropic:foo", "--no-ai", "--set=cards.quiet=true", "--endpoint-ms=800"], {});
  assert.equal(c.profile, "practice");
  assert.equal(c.flat["run.file"], "x.wav");
  assert.equal(c.flat["llm.reflex.model"], "anthropic:foo");
  assert.equal(c.flat["run.noAi"], true);
  assert.equal(c.flat["cards.quiet"], true);
  assert.equal(c.flat["stt.endpointMs"], 800);
});

import { resolveBankId } from "./reflex.ts";
import { setTurnLang, stallSay, type BankCard } from "./bank.ts";
test("turn language: resolveBankId and stallSay use the turn's language, not the module global", () => {
  const card: BankCard = { id: "dns-basics", title: "dns", triggers: ["dns"], say: "שלום", facts: [], en: { say: "hello" } };
  setTurnLang("en"); // a newer English question has just arrived
  assert.equal(resolveBankId("dns-basics", [card], "he")?.say, "שלום");
  assert.equal(stallSay(card, 0, "he"), "שלום");
  setTurnLang("he");
  assert.equal(resolveBankId("dns-basics", [card], "en")?.say, "hello");
  assert.equal(stallSay(card, 0, "en"), "hello");
});

import { masculine } from "./tips.ts";
import { setProfile } from "./profile.ts";
test("masculine(): real words that look like feminine imperatives are left alone; true imperatives still change", () => {
  setProfile({ address: "male" });
  try {
    assert.equal(masculine("ספרי הלימוד"), "ספרי הלימוד");
    assert.equal(masculine("זה ודאי יעבוד"), "זה ודאי יעבוד");
    assert.equal(masculine("שאלי על המחיר"), "שאל על המחיר");
    assert.equal(masculine("בדקי את הלוגים"), "בדוק את הלוגים");
  } finally {
    setProfile(undefined);
  }
});

import { applyEdits } from "./settings-edit.ts";
import { loadSettings } from "./settings.ts";
import { readFileSync } from "node:fs";
test("settings: an empty section header does not break loading, and an edit under it works", () => {
  const d = mkdtempSync(join(tmpdir(), "wingman-sec-")),
    f = join(d, "settings.yaml");
  writeFileSync(f, "# my settings\nstt:\n  # provider: soniox\n");
  assert.doesNotThrow(() => loadSettings({ env: {}, userFile: f, argv: [] }));
  const r = applyEdits(f, { "stt.provider": "soniox" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(readFileSync(f, "utf8"), /provider: soniox/);
  assert.equal(loadSettings({ env: {}, userFile: f, argv: [] }).settings.stt.provider, "soniox");
});

import { LineSplitter } from "./relay.ts";
test("relay: a multi-byte character split across chunks survives; the tail of a dropped oversize line is not a line", () => {
  const row = Buffer.from('{"say":"שלום"}\n'),
    cut = row.indexOf(0xd7) + 1; // inside the first Hebrew letter
  const sp = new LineSplitter();
  assert.deepEqual([...sp.push(row.subarray(0, cut)), ...sp.push(row.subarray(cut))], ['{"say":"שלום"}']);
  const small = new LineSplitter(10);
  assert.deepEqual([...small.push("0123456789ABCDEF"), ...small.push("GHIJ\nok\n")], ["ok"]);
});

import { worldClock } from "./reflex.ts";
test("worldClock: half-hour home zones keep the real sign and size of the gap", () => {
  const d = new Date("2026-11-06T12:00:00Z"); // Kolkata UTC+5:30, Los Angeles UTC-8 in November
  assert.match(worldClock(d, "Asia/Kolkata"), /Los Angeles 04:00 \(13\.5 h behind home time\)/);
  assert.match(worldClock(d, "Asia/Jerusalem"), /New York 07:00 \(7 h behind home time\)/);
});

import { EventEmitter } from "node:events";
import { MicSource } from "./audio.ts";
test("MicSource.stop: SIGINT first, SIGKILL when ffmpeg ignores it", async () => {
  const signals: string[] = [];
  const fake = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill: (s: string) => {
      signals.push(s);
      return true;
    },
  });
  const m = new MicSource(":default") as unknown as { p: unknown; stop(): Promise<void> };
  m.p = fake;
  const t0 = Date.now();
  await m.stop();
  assert.deepEqual(signals, ["SIGINT"]);
  await new Promise((r) => setTimeout(r, 2200));
  assert.deepEqual(signals, ["SIGINT", "SIGKILL"]);
  assert.ok(Date.now() - t0 >= 2000);
  // a process that exits after SIGINT is not killed again
  const quick = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill: (s: string) => {
      signals.push("q" + s);
      return true;
    },
  });
  m.p = quick;
  await m.stop();
  quick.emit("exit", 255, null);
  await new Promise((r) => setTimeout(r, 2200));
  assert.deepEqual(
    signals.filter((x) => x.startsWith("q")),
    ["qSIGINT"],
  );
});

import { CircuitBreaker } from "./health.ts";
test("circuit breaker: half-open lets one probe through, not every caller", () => {
  let now = 0;
  const b = new CircuitBreaker({ failures: 1, windowMs: 10_000, cooldownMs: 1000, closeAfter: 2 }, () => now);
  b.failure();
  assert.equal(b.allow(), false);
  now = 1500;
  assert.equal(b.allow(), true); // the probe
  assert.equal(b.allow(), false); // everyone else waits
  b.success();
  assert.equal(b.allow(), true); // next probe after a success
  b.success();
  assert.equal(b.state, "closed");
  assert.equal(b.allow(), true);
  assert.equal(b.allow(), true);
});

import { pcmAligner } from "./audio.ts";
test("pcmAligner: odd-length chunks never shift the s16 alignment and no byte is lost", () => {
  const src = Buffer.from(Array.from({ length: 20 }, (_, i) => i));
  const align = pcmAligner();
  const out: Buffer[] = [];
  for (const cut of [
    [0, 3],
    [3, 4],
    [4, 11],
    [11, 12],
    [12, 20],
  ]) {
    const w = align(src.subarray(cut[0], cut[1]));
    if (w) {
      assert.equal(w.length % 2, 0);
      out.push(w);
    }
  }
  assert.deepEqual(Buffer.concat(out), src);
});
