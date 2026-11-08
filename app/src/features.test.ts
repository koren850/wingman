// Live nudges (virtual clock), Last time v2 (past search, company and topic index, deleting stored facts), opt-in lookup (fake fetch),
// the kind of call on the memory view, and the `wingman ask --past` / `wingman lookup` commands. No network, no model, no real clock.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_NUDGE_CFG, Nudger, liveNumbers, type Row } from "./session/coaching.ts";
import { saveMemory } from "./session/store.ts";
import { emptyMemory, type SessionMemory } from "./session/types.ts";
import { toView } from "./session/view.ts";
import {
  indexFinishedCalls,
  pastFactsFor,
  pastCallsLike,
  listPast,
  forgetPast,
  unblockPast,
  callKeywords,
  meetingWords,
  readIndex,
  PEOPLE_FILE,
} from "./session/people.ts";
import { collectPast, searchPast, askPast, answerPast, guardPastAnswer, PAST_LABELS_EN, docsOfCall } from "./session/past.ts";
import { lookup, pickSentence, sentences, lookupAddress } from "./session/lookup.ts";
import { main } from "./cli/index.ts";
import { loadSettings } from "./settings.ts";

const req = createRequire(import.meta.url);
const MV = req("../shared/memview.js");
const tmp = () => mkdtempSync(join(tmpdir(), "r3f-"));

// ---------------------------------------------------------------- helpers: invented calls
const memWith = (f: (m: SessionMemory) => void): SessionMemory => {
  const m = emptyMemory(1000, "client");
  f(m);
  return m;
};
function makeCall(callsDir: string, id: string, endedAt: string, mem: SessionMemory, extra?: Record<string, unknown>) {
  const dir = join(callsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "call.json"), JSON.stringify({ id, mode: "live", startedAt: endedAt.replace(/T.*/, "T09:00:00.000Z"), endedAt }));
  saveMemory(dir, mem);
  if (extra) writeFileSync(join(dir, "summary.json"), JSON.stringify(extra));
  return dir;
}
/** Two finished calls with different people: the backup rule was agreed in the first one only. */
function twoCalls() {
  const calls = tmp();
  makeCall(
    calls,
    "01CALLA",
    "2026-10-20T10:00:00.000Z",
    memWith((m) => {
      m.topic.now = "Hosting move for Levi Studio";
      m.roster.push({ id: "p1", name: "Dana Levi", side: "them", role: "owner at Levi Studio" }, { id: "p2", name: "Dan", side: "me" });
      m.facts.push({ id: "f1", text: "Daily backups run at 3 AM and are kept for 30 days", at: 1, src: "call" });
      m.decisions.push({ id: "d1", text: "Move the twelve sites on the first weekend of December", at: 2 });
      m.commitments.push({ id: "c1", who: "me", what: "send the updated offer", at: 3, status: "open" });
    }),
    { summary: ["A hosting move with daily backups."], decisions: ["Agreed a December date"], nextSteps: [{ who: "me", what: "send the updated offer" }] },
  );
  makeCall(
    calls,
    "01CALLB",
    "2026-11-02T10:00:00.000Z",
    memWith((m) => {
      m.topic.now = "Domain renewal for Beta Ltd";
      m.roster.push({ id: "p1", name: "Ron Katz", side: "them", role: "manager at Beta Ltd" }, { id: "p2", name: "Dan", side: "me" });
      m.facts.push({ id: "f1", text: "The domain renews on 14 March", at: 1, src: "call" });
      m.facts.push({ id: "f2", text: "Brief fact that is not from the call", at: 2, src: "brief" });
    }),
  );
  return calls;
}

// ---------------------------------------------------------------- live nudges
const T0 = Date.UTC(2026, 10, 8, 9, 0, 0);
/** n words in one row ending at t. */
/** A row of n words that took `sec` seconds (word times as the speech service gives them: first start, last end). */
const row = (ch: "me" | "them", words: number, t: number, sec = 0): Row => ({
  ch,
  text: Array.from({ length: words }, (_, i) => `w${i}`).join(" "),
  t,
  ...(sec ? { words: [{ start: 100, end: 100 + sec }] } : {}),
});
/** A call where the user talks fast for the last minute: 3 rows of 12 s at 240 words a minute (48 words each). */
function fastRows(endAt: number): Row[] {
  return [row("them", 150, endAt - 100_000, 60), row("me", 48, endAt - 36_000, 12), row("me", 48, endAt - 22_000, 12), row("me", 48, endAt - 8_000, 12)];
}
const on = { ...DEFAULT_NUDGE_CFG, enabled: true };

test("nudges: off by default (settings coach.nudges is false) and the engine config is off", () => {
  assert.equal(loadSettings({ argv: [] }).settings.coach.nudges, false);
  assert.equal(DEFAULT_NUDGE_CFG.enabled, false);
  assert.equal(new Nudger().check(T0, fastRows(T0)), undefined);
});

test("nudges: pace is measured over the last 60 s and needs 20 s of the user's speech", () => {
  const now = T0 + 200_000;
  const n = liveNumbers(fastRows(now), now);
  assert.ok(n.paceWpm !== undefined && n.paceWpm > 200, `pace ${n.paceWpm}`);
  const few = liveNumbers([row("me", 10, now - 5000, 4)], now);
  assert.equal(few.paceWpm, undefined, "5 s of speech is not a pace");
  // rows without word times would only give the average pace back: no pace number, no nudge
  const bare = [row("me", 48, now - 30_000), row("me", 48, now - 10_000)];
  assert.equal(liveNumbers(bare, now).paceWpm, undefined);
  assert.deepEqual(new Nudger(on).check(now, fastRows(now)), { kind: "pace", value: n.paceWpm, limit: 180 });
});

test("nudges: at most one per 5 minutes, on a virtual clock", () => {
  const nd = new Nudger(on);
  let now = T0 + 200_000;
  assert.equal(nd.check(now, fastRows(now))?.kind, "pace");
  for (const dt of [1000, 30_000, 120_000, 299_000]) assert.equal(nd.check(now + dt, fastRows(now + dt)), undefined, `+${dt}`);
  now += 300_000;
  assert.equal(nd.check(now, fastRows(now))?.kind, "pace", "after 5 minutes it may speak again");
  nd.reset();
  assert.equal(nd.check(now + 1, fastRows(now + 1))?.kind, "pace", "reset forgets the last nudge");
});

test("nudges: never during a Check hold, never in quiet mode, and a held nudge is not used up", () => {
  const nd = new Nudger(on);
  const now = T0 + 200_000;
  assert.equal(nd.check(now, fastRows(now), { checkHold: true }), undefined);
  assert.equal(nd.check(now, fastRows(now), { quiet: true }), undefined);
  assert.equal(nd.check(now + 1000, fastRows(now + 1000))?.kind, "pace", "the hold did not start the 5 minute gap");
});

test("nudges: talk share over 5 minutes, only with enough speech from both sides and after 3 minutes", () => {
  const now = T0 + 6 * 60_000;
  // the user talks 4 of every 5 seconds of speech for five minutes: 200 s of me, 50 s of them, at a normal pace (150 wpm = 2.5 words a second)
  const rows: Row[] = [];
  for (let t = now - 300_000; t < now; t += 25_000) {
    rows.push(row("them", 12, t + 5000), row("me", 50, t + 25_000));
  }
  const n = liveNumbers(rows, now);
  assert.ok(n.sharePct !== undefined && n.sharePct > 70, `share ${n.sharePct}`);
  const nd = new Nudger({ ...on, paceMax: 999 });
  assert.equal(nd.check(now, rows)?.kind, "share");
  // too early in the call: no share number
  assert.equal(
    liveNumbers(
      rows.filter((r) => r.t < T0 + 60_000),
      T0 + 60_000,
    ).sharePct,
    undefined,
  );
  // the setting moves the limit
  assert.equal(new Nudger({ ...on, paceMax: 999, talkShareMax: 95 }).check(now, rows), undefined);
});

test("nudges: a run of interruptions beats pace and share", () => {
  const now = T0 + 90_000;
  // the other side speaks 6 s at a time; the user starts 2 s into each of them, three times
  const rows: Row[] = [];
  for (let i = 0; i < 3; i++) {
    const s = now - 80_000 + i * 20_000;
    rows.push({ ch: "them", text: "a b c d e f g h i j k l m n o p", t: s + 8000, words: [{ start: s / 1000, end: (s + 8000) / 1000 }] });
    rows.push({ ch: "me", text: "yes but one more thing", t: s + 6500 });
  }
  const n = liveNumbers(rows, now);
  assert.ok(n.streak >= 3, `streak ${n.streak}`);
  assert.equal(new Nudger(on).check(now, rows)?.kind, "interrupt");
});

test("nudges: no word lists: the same numbers with other words give the same decision", () => {
  const now = T0 + 200_000;
  const words = (rows: Row[], w: string) =>
    rows.map((r) => ({
      ...r,
      text: r.text
        .split(" ")
        .map(() => w)
        .join(" "),
    }));
  const a = new Nudger(on).check(now, fastRows(now));
  const b = new Nudger(on).check(now, words(fastRows(now), "um"));
  const c = new Nudger(on).check(now, words(fastRows(now), "כאילו"));
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
});

// ---------------------------------------------------------------- the kind of call on the memory view
test("MemoryView carries kind and kindLocked, and the window copy of the view matches the TypeScript one", () => {
  const m = memWith((x) => {
    x.kind = "support";
    x.kindLocked = true;
  });
  const v = toView(m);
  assert.equal(v.kind, "support");
  assert.equal(v.kindLocked, true);
  assert.deepEqual(MV.viewFromMemory(m), v);
  assert.deepEqual(MV.viewFromMemory(emptyMemory(0)), toView(emptyMemory(0)));
  assert.equal(MV.cleanView({ ver: 1, kind: "<b>x</b>", kindLocked: "yes" }).kind, "other", "a bad kind id is other");
  assert.equal(MV.cleanView({ ver: 1, kind: "interview", kindLocked: true }).kindLocked, true);
  assert.equal(MV.cleanView({ ver: 1, topic: "x" }).kind, "", "a view from an older engine has no kind, so the screens show no pill");
  const row = MV.overlayViewRow(v, {});
  assert.equal(row.kind, "support");
  assert.equal(row.kindLocked, true);
});

// ---------------------------------------------------------------- Last time v2: past search
test("past search: a fact from a different earlier call is found, with the call date and the source, offline", async () => {
  const calls = twoCalls();
  const r = await askPast(calls, "how long are the backups kept?");
  assert.equal(r.found, true);
  assert.equal(r.ai, false);
  assert.equal(r.offline, true);
  assert.match(r.text, /^AI offline: from notes: /);
  assert.ok(r.hits.every((h) => h.callId === "01CALLA"));
  const fact = r.hits.find((h) => /kept for 30 days/.test(h.text));
  assert.ok(fact, "the fact is among the best 3");
  assert.match(r.text, /kept for 30 days \(2026-10-20, fact\)/);
  assert.ok(r.hits.length <= 3);
  // the other call's brief fact is not something a call said
  const all = collectPast(calls);
  assert.ok(!all.some((d) => /not from the call/.test(d.text)));
  // the question is about the other call: it comes back from there
  const b = await askPast(calls, "when does the domain renew?");
  assert.equal(b.hits[0].callId, "01CALLB");
});

test("past search: a company or a topic word finds the call (the index holds the topic and the roster roles)", async () => {
  const calls = twoCalls();
  const r = await askPast(calls, "what did we decide with Levi Studio?");
  assert.equal(r.hits[0].callId, "01CALLA");
  assert.match(r.hits[0].source, /decision|promise|summary|fact|topic/);
});

test("past search: nothing found says so, and an empty question or folder never throws", async () => {
  const calls = twoCalls();
  const r = await askPast(calls, "quantum chromodynamics lattice");
  assert.equal(r.found, false);
  assert.equal(r.text, PAST_LABELS_EN.nothing);
  assert.equal((await askPast(calls, "   ")).found, false);
  assert.equal((await askPast(join(tmp(), "none"), "backups")).found, false);
});

test("past search: a model answer is used only when its numbers are in the saved lines; a failing model falls back to the notes", async () => {
  const calls = twoCalls();
  const docs = collectPast(calls);
  const hits = searchPast(docs, "backups kept");
  assert.equal(guardPastAnswer("Backups are kept 30 days.", hits), "Backups are kept 30 days.");
  assert.equal(guardPastAnswer("Backups are kept 90 days.", hits), undefined, "a new number is refused");
  const good = await askPast(calls, "backups kept", { synthesize: async () => "Backups are kept 30 days." });
  assert.equal(good.ai, true);
  assert.match(good.text, /Backups are kept 30 days\./);
  const bad = await askPast(calls, "backups kept", { synthesize: async () => "Backups are kept 90 days." });
  assert.equal(bad.ai, false);
  assert.match(bad.text, /^AI offline: from notes/);
  const down = await askPast(calls, "backups kept", {
    synthesize: async () => {
      throw new Error("429");
    },
  });
  assert.equal(down.ai, false);
  assert.equal(answerPast([]).found, false);
});

test("past search: a running call, a practice call and a call that has not ended are not searched", () => {
  const calls = twoCalls();
  const run = join(calls, "01RUN");
  mkdirSync(run);
  writeFileSync(join(run, "call.json"), JSON.stringify({ mode: "live", startedAt: "2026-11-08T09:00:00.000Z" }));
  const prac = join(calls, "01PRAC");
  mkdirSync(prac);
  writeFileSync(join(prac, "call.json"), JSON.stringify({ mode: "practice", startedAt: "2026-11-08T09:00:00.000Z", endedAt: "2026-11-08T09:10:00.000Z" }));
  saveMemory(
    prac,
    memWith((m) => m.facts.push({ id: "f1", text: "practice fact about zebras", at: 1, src: "call" })),
  );
  const ids = new Set(collectPast(calls).map((d) => d.callId));
  assert.deepEqual([...ids].sort(), ["01CALLA", "01CALLB"]);
  assert.deepEqual(docsOfCall(join(calls, "01CALLA"), "01CALLA", 1).length > 0, true);
});

// ---------------------------------------------------------------- Last time v2: the index, list and delete
test("people index: keywords come from the topic and the roles, with no word list, and the index keeps them", () => {
  const kw = callKeywords({
    topic: "Hosting move for Levi Studio",
    roles: ["owner at Levi Studio"],
    summary: "backups backups backups migration migration plan",
  });
  assert.ok(kw.includes("levi") && kw.includes("studio") && kw.includes("hosting"));
  assert.ok(kw.includes("backups"), "a word the summary repeats");
  assert.ok(kw.length <= 12);
  const calls = twoCalls();
  const file = join(tmp(), PEOPLE_FILE);
  indexFinishedCalls({ callsDir: calls, file });
  const rec = readIndex(file).people["dana levi"].calls[0];
  assert.ok(rec.kw?.includes("levi"));
});

test("people index: a recurring meeting with no name match is found by company and topic words", () => {
  const calls = twoCalls();
  const file = join(tmp(), PEOPLE_FILE);
  indexFinishedCalls({ callsDir: calls, file });
  const like = pastCallsLike(meetingWords({ title: "Levi Studio hosting check-in", who: "" }), { file });
  assert.equal(like[0]?.id, "01CALLA");
  assert.equal(like[0]?.person, "Dana Levi");
  assert.deepEqual(pastCallsLike(meetingWords({ title: "Completely different plumbing job" }), { file }), []);
  assert.deepEqual(pastCallsLike([], { file }), []);
  // one shared word is not enough
  assert.deepEqual(pastCallsLike(["levi"], { file }), []);
  assert.equal(pastCallsLike(["levi"], { file, minShared: 1 }).length, 1);
});

test("people index: the Settings list shows what is stored and deleting a person is permanent for new calls", async () => {
  const calls = twoCalls();
  const file = join(tmp(), PEOPLE_FILE);
  indexFinishedCalls({ callsDir: calls, file });
  const list = listPast(file);
  assert.deepEqual(list.map((p) => p.name).sort(), ["Dana Levi", "Ron Katz"]);
  assert.ok(!JSON.stringify(list).includes('"kw"'), "the list shows facts, not the search words");
  assert.equal(pastFactsFor(["Dana"], { file }).length > 0, true);
  assert.equal(forgetPast(file, "dana levi"), true);
  assert.deepEqual(pastFactsFor(["Dana"], { file }), []);
  assert.equal(forgetPast(file, "dana levi"), false, "already gone");
  // a later call with the same person does not bring the name back
  makeCall(
    calls,
    "01CALLC",
    "2026-11-05T10:00:00.000Z",
    memWith((m) => {
      m.topic.now = "Follow-up";
      m.roster.push({ id: "p1", name: "Dana Levi", side: "them" });
      m.facts.push({ id: "f1", text: "She wants a quote", at: 1, src: "call" });
    }),
  );
  indexFinishedCalls({ callsDir: calls, file });
  assert.deepEqual(pastFactsFor(["Dana"], { file }), []);
  // and the search of finished calls leaves that person's calls out
  const r = await askPast(calls, "backups kept", { peopleFile: file });
  assert.equal(r.found, false, "the call with the deleted person is not searched");
  unblockPast(file);
  indexFinishedCalls({ callsDir: calls, file });
  assert.equal((statSync(file).mode & 0o777).toString(8), process.platform === "win32" ? (statSync(file).mode & 0o777).toString(8) : "600");
});

test("people index: deleting one stored call keeps the person's other calls", () => {
  const calls = twoCalls();
  makeCall(
    calls,
    "01CALLD",
    "2026-11-06T10:00:00.000Z",
    memWith((m) => {
      m.topic.now = "Second hosting call";
      m.roster.push({ id: "p1", name: "Dana Levi", side: "them" });
    }),
  );
  const file = join(tmp(), PEOPLE_FILE);
  indexFinishedCalls({ callsDir: calls, file });
  assert.equal(listPast(file).find((p) => p.key === "dana levi")?.calls.length, 2);
  assert.equal(forgetPast(file, "dana levi", "01CALLD"), true);
  assert.deepEqual(
    listPast(file)
      .find((p) => p.key === "dana levi")
      ?.calls.map((c) => c.id),
    ["01CALLA"],
  );
});

// ---------------------------------------------------------------- lookup
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const pubDns = async () => [{ address: "93.184.216.34", family: 4 }];
const WIKI = {
  title: "CNAME record",
  type: "standard",
  extract:
    "A CNAME record maps an alias name to a canonical domain name. It is used when several names point to one host. Most resolvers follow it in one extra lookup.",
};

test("lookup: off by default, nothing is fetched", async () => {
  let called = 0;
  const r = await lookup("CNAME record", {
    enabled: false,
    fetch: async () => {
      called++;
      return jsonRes(WIKI);
    },
    dns: pubDns,
  });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "off");
  assert.equal(called, 0);
  assert.equal(loadSettings({ argv: [] }).settings.lookup.enabled, false);
  assert.equal(loadSettings({ argv: [] }).settings.lookup.maxUsdPerCall, 0.05);
});

test("lookup: one https request, the source address and the exact sentence of the page", async () => {
  const urls: string[] = [];
  const r = await lookup("CNAME record", {
    enabled: true,
    fetch: async (u) => {
      urls.push(String(u));
      return jsonRes(WIKI);
    },
    dns: pubDns,
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/en\.wikipedia\.org\/api\/rest_v1\/page\/summary\/CNAME_record/);
  assert.equal(r.url, "https://en.wikipedia.org/wiki/CNAME_record");
  assert.equal(r.sentence, "A CNAME record maps an alias name to a canonical domain name.");
  assert.equal(r.line, r.sentence);
  assert.equal(r.ai, false);
  assert.equal(r.usd, 0);
  assert.ok(WIKI.extract.includes(r.sentence), "only text found in the fetched page");
  // a Hebrew term uses the Hebrew service
  const he: string[] = [];
  await lookup("רשומת CNAME", { enabled: true, fetch: async (u) => (he.push(String(u)), jsonRes(WIKI)), dns: pubDns });
  assert.match(he[0], /^https:\/\/he\.wikipedia\.org\//);
});

test("lookup: refuses http, private and local addresses, a redirect to one, and a bad term", async () => {
  const never = async () => {
    throw new Error("must not be fetched");
  };
  for (const u of [
    "http://example.com/x",
    "https://127.0.0.1/x",
    "https://10.0.0.5/page",
    "https://[::1]/x",
    "https://user:pw@example.com/x",
    "https://example.com:8443/x",
  ]) {
    const r = await lookup(u, { enabled: true, fetch: never, dns: pubDns });
    assert.equal(r.ok, false, u);
    assert.match(!r.ok ? r.code : "", /refused|failed/, u);
  }
  // a public name that resolves to a private address
  const priv = await lookup("https://intranet.example.com/x", { enabled: true, fetch: never, dns: async () => [{ address: "192.168.1.9", family: 4 }] });
  assert.equal(!priv.ok && priv.code, "refused");
  // a redirect to a private address is refused at the hop
  const redir = await lookup("https://example.com/x", {
    enabled: true,
    dns: async (h) => [{ address: h === "example.com" ? "93.184.216.34" : "10.1.1.1", family: 4 }],
    fetch: async () => new Response(null, { status: 302, headers: { location: "https://internal.example.net/secret" } }),
  });
  assert.equal(!redir.ok && redir.code, "refused");
  for (const bad of ["", " ", "?", "a"]) assert.equal((await lookup(bad, { enabled: true, fetch: never, dns: pubDns })).ok, false);
});

test("lookup: a page is read as untrusted text (markup and control characters are removed) and the size is capped", async () => {
  const html = `<html><head><title>Hostinger</title></head><script>alert(1)</script><body><p>Backup is a copy of your data.‮ Stored away from the site. <b>Safe</b>.</p></body></html>`;
  const r = await lookup("https://example.com/backup", {
    enabled: true,
    fetch: async () => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    dns: pubDns,
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.doesNotMatch(r.line + r.sentence, /[<>‮]|alert/);
  assert.match(r.sentence, /^Backup is a copy of your data\./);
  // a huge body is cut at the byte limit, not read to the end
  let read = 0;
  const big = new ReadableStream({
    pull(c) {
      read += 100_000;
      c.enqueue(new Uint8Array(100_000).fill(65));
    },
  });
  const r2 = await lookup("https://example.com/big", {
    enabled: true,
    maxBytes: 200_000,
    fetch: async () => new Response(big, { status: 200, headers: { "content-type": "text/plain" } }),
    dns: pubDns,
  });
  assert.ok(read <= 400_000, `read ${read}`);
  assert.equal(r2.ok || r2.code === "not-found" || r2.code === "failed", true);
});

test("lookup: a slow page times out", async () => {
  const r = await lookup("CNAME record", {
    enabled: true,
    timeoutMs: 30,
    dns: pubDns,
    fetch: (_u, init) =>
      new Promise((_res, rej) => {
        (init?.signal as AbortSignal).addEventListener("abort", () => rej(new Error("aborted")));
      }),
  });
  assert.equal(!r.ok && r.code, "timeout");
});

test("lookup: the AI may shorten the sentence only inside the spend cap and only with numbers from the page", async () => {
  const base = {
    enabled: true,
    fetch: async () => jsonRes({ ...WIKI, extract: "The service has run since 2009 and holds 12 data centres. It is used by many." }),
    dns: pubDns,
  };
  const run = (text: string, usd: number, est = 0.001, maxUsd = 0.05) =>
    lookup("service data centres", { ...base, maxUsd, shorten: { estimateUsd: () => est, run: async () => ({ text, usd }) } });
  const ok = await run("Runs since 2009 with 12 data centres.", 0.002);
  assert.ok(ok.ok && ok.ai && ok.usd === 0.002);
  const badNum = await run("Runs since 2009 with 40 data centres.", 0.002);
  assert.ok(badNum.ok && !badNum.ai, "a number the page does not have is refused");
  const dear = await run("Runs since 2009 with 12 data centres.", 0.5);
  assert.ok(dear.ok && !dear.ai, "a call that cost more than the cap is not used");
  const tooBig = await run("Runs since 2009 with 12 data centres.", 0.002, 0.2);
  assert.ok(tooBig.ok && !tooBig.ai, "an estimate over the cap means the model is not even called");
  const zero = await run("Runs since 2009 with 12 data centres.", 0.001, 0.001, 0);
  assert.ok(zero.ok && !zero.ai, "a cap of 0 never uses the AI");
  const down = await lookup("service data centres", {
    ...base,
    maxUsd: 0.05,
    shorten: {
      estimateUsd: () => 0.001,
      run: async () => {
        throw new Error("down");
      },
    },
  });
  assert.ok(down.ok && !down.ai, "a failing model leaves the sentence");
});

test("lookup: sentences and the address helper", () => {
  assert.deepEqual(sentences("Written by J. Smith in 2020. It costs 3.50 euros. Is that really so? Yes it is!"), [
    "Written by J. Smith in 2020.",
    "It costs 3.50 euros.",
    "Is that really so?",
    "Yes it is!",
  ]);
  assert.equal(pickSentence("Alpha beta gamma. The delta record is here. Omega.", "delta record"), "The delta record is here.");
  assert.ok("api" in lookupAddress("hello world"));
  assert.ok("direct" in lookupAddress("https://example.com/a"));
});

// ---------------------------------------------------------------- the commands
const run = async (argv: string[], over: Record<string, unknown> = {}) => {
  let out = "",
    err = "";
  const code = await main(argv, { out: (s: string) => (out += s), err: (s: string) => (err += s), ...over } as never);
  return { code, out, err };
};

test("wingman ask --past: finds the fact in an earlier call, cites its date, needs no app", async () => {
  const calls = twoCalls();
  const r = await run(["ask", "--past", "how long are the backups kept?", "--json"], { calls, socket: join(tmp(), "none.sock") });
  assert.equal(r.code, 0, r.out + r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.found, true);
  assert.equal(j.offline, true);
  assert.equal(j.hits[0].callId, "01CALLA");
  assert.equal(j.hits[0].date, "2026-10-20");
  assert.ok(j.hits.some((h: { text: string }) => /kept for 30 days/.test(h.text)));
  assert.match(j.answer, /^AI offline: from notes/);
  const t = await run(["ask", "--past", "domain", "renews"], { calls });
  assert.match(t.out, /AI offline: from notes/);
  assert.match(t.out, /call 01CALLB/);
  const none = await run(["ask", "--past", "zebra migration", "--json"], { calls });
  assert.equal(none.code, 5);
  assert.equal(JSON.parse(none.out).found, false);
  const both = await run(["ask", "--past", "--listen"], { calls });
  assert.equal(both.code, 2);
});

test("wingman lookup: refuses while it is off, works when it is on, with no network", async () => {
  const off = await run(["lookup", "CNAME record", "--json"], {
    env: { ...process.env, WINGMAN_USER_SETTINGS: join(tmp(), "none.yaml") },
    lookupFetch: async () => jsonRes(WIKI),
    lookupDns: pubDns,
  });
  assert.equal(off.code, 4);
  assert.equal(JSON.parse(off.out).error.code, "lookup-off");
  const file = join(tmp(), "settings.yaml");
  writeFileSync(file, "lookup:\n  enabled: true\n");
  const on = await run(["lookup", "CNAME record", "--json"], {
    env: { ...process.env, WINGMAN_USER_SETTINGS: file },
    lookupFetch: async () => jsonRes(WIKI),
    lookupDns: pubDns,
  });
  assert.equal(on.code, 0, on.out + on.err);
  const j = JSON.parse(on.out);
  assert.equal(j.url, "https://en.wikipedia.org/wiki/CNAME_record");
  assert.equal(j.sentence, "A CNAME record maps an alias name to a canonical domain name.");
  const text = await run(["lookup", "CNAME record"], {
    env: { ...process.env, WINGMAN_USER_SETTINGS: file },
    lookupFetch: async () => jsonRes(WIKI),
    lookupDns: pubDns,
  });
  assert.match(text.out, /Source: https:\/\/en\.wikipedia\.org\/wiki\/CNAME_record/);
  const bad = await run(["lookup", "http://10.0.0.1/x"], {
    env: { ...process.env, WINGMAN_USER_SETTINGS: file },
    lookupFetch: async () => jsonRes(WIKI),
    lookupDns: pubDns,
  });
  assert.notEqual(bad.code, 0);
});
