// Round 12, r3-verify-record: cassette hygiene (stale entries, hashes, summary) and cost reconciliation. Offline: the model is the policy fake.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Cassette, CassetteMiss, CassetteStale, wrapCassette, summarizeCassette, promptHashOf } from "./providers/cassette.ts";
import { generateOnce } from "./providers/llm.ts";
import { policyModel } from "./testkit/policy-model.ts";

const REF = "anthropic:claude-haiku-5-5";
const call = (system: string, user: string) => ({
  instructions: { role: "system", content: system },
  messages: [{ role: "user", content: user }],
  maxRetries: 0,
});
async function recorded(system: string, user: string, ref = REF): Promise<Cassette> {
  const c = new Cassette();
  const pm = policyModel({ strict: false, fallback: "SKIP" });
  const m = wrapCassette({ mode: "record", cassette: c, ref, role: "moment", inner: pm.model, autosave: false });
  await generateOnce(undefined, { model: m, ...call(system, user) });
  return c;
}

test("cassette entries carry the model id and a prompt hash", async () => {
  const c = await recorded("Rules v1.", "[l1] them: hi");
  const e = c.entries()[0];
  assert.equal(e.model, REF);
  assert.equal(e.promptHash, promptHashOf("Rules v1."));
  assert.match(String(e.inputHash), /^[0-9a-f]{16}$/);
  assert.notEqual(promptHashOf("Rules v1."), promptHashOf("Rules v2."));
});

test("a changed prompt text is reported as stale, not as a miss", async () => {
  const c = await recorded("Rules v1.\nKeep it short.", "[l1] them: hi");
  const rep = wrapCassette({ mode: "replay", cassette: c, ref: REF, role: "moment", timing: "instant" });
  const err = (await generateOnce(undefined, { model: rep, ...call("Rules v2.\nKeep it short.", "[l1] them: hi") }).catch((e) => e)) as Error;
  assert.ok(err instanceof CassetteStale, String(err));
  assert.ok(err instanceof CassetteMiss, "a stale entry is still a CassetteMiss for code that only knows misses");
  assert.equal((err as CassetteStale).why, "prompt");
  assert.match(err.message, /STALE \(not a miss\)/);
  assert.match(err.message, /^- Rules v1\.$/m);
  assert.match(err.message, /^\+ Rules v2\.$/m);
  // other user text = a real miss
  const other = (await generateOnce(undefined, { model: rep, ...call("Rules v1.\nKeep it short.", "[l1] them: something else") }).catch((e) => e)) as Error;
  assert.ok(other instanceof CassetteMiss && !(other instanceof CassetteStale));
  assert.match(other.message, /^Cassette miss:/);
});

test("a changed model id is reported as stale too", async () => {
  const c = await recorded("Rules.", "[l1] them: hi", "anthropic:claude-haiku-5-5");
  const rep = wrapCassette({ mode: "replay", cassette: c, ref: "anthropic:claude-sonnet-5-5", role: "moment", timing: "instant" });
  const err = (await generateOnce(undefined, { model: rep, ...call("Rules.", "[l1] them: hi") }).catch((e) => e)) as CassetteStale;
  assert.ok(err instanceof CassetteStale);
  assert.equal(err.why, "model");
  assert.match(err.message, /recorded with model anthropic:claude-haiku-5-5/);
});

test("an exact entry still replays, and an old entry with no hashes is found as stale by its request text", async () => {
  const c = await recorded("Rules.", "[l1] them: hi");
  const old = c.entries()[0];
  delete old.promptHash;
  delete old.inputHash;
  c.put(old);
  const hit = wrapCassette({ mode: "replay", cassette: c, ref: REF, role: "moment", timing: "instant" });
  assert.equal((await generateOnce(undefined, { model: hit, ...call("Rules.", "[l1] them: hi") })).text, "SKIP");
  await assert.rejects(generateOnce(undefined, { model: hit, ...call("Rules changed.", "[l1] them: hi") }), CassetteStale);
  const s = summarizeCassette(c);
  assert.equal(s.entries, 1);
  assert.equal(s.byRole.moment.unhashed, 1);
});

test("summarizeCassette counts entries by role, model and source", async () => {
  const c = await recorded("Rules.", "[l1] them: hi");
  c.author(
    REF,
    {
      prompt: [
        { role: "system", content: "S" },
        { role: "user", content: [{ type: "text", text: "u" }] },
      ],
    },
    "ANS",
    { role: "memory" },
  );
  const s = summarizeCassette(c);
  assert.equal(s.entries, 2);
  assert.deepEqual(s.bySource, { recorded: 1, authored: 1 });
  assert.deepEqual(Object.keys(s.byRole).sort(), ["memory", "moment"]);
  assert.deepEqual(s.byRole.moment.models, [REF]);
});

// ---- cost reconciliation
import { reconcileCost, formatRecon, cassetteUsageByRole } from "../qa/cost-recon.ts";

const SIM = { moment: { calls: 100, usd: 0.5 }, observer: { calls: 60, usd: 0.3 }, memory: { calls: 30, usd: 0.1 }, compact: { calls: 2, usd: 0.002 } };

test("cost reconciliation: within 15 percent passes and prints calls per hour per role", () => {
  const rec = { moment: { calls: 104, usd: 0.55 }, observer: { calls: 58, usd: 0.29 }, memory: { calls: 31, usd: 0.105 }, compact: { calls: 2, usd: 0.0021 } };
  const r = reconcileCost(SIM, rec, 1);
  assert.equal(r.ok, true, r.failed.join("; "));
  const text = formatRecon(r);
  assert.match(text, /moment\s+calls\/h\s+100 ->\s+104/);
  assert.match(text, /^all\s/m);
});

test("cost reconciliation: more than 15 percent off fails, in the total and in the role", () => {
  const rec = { ...SIM, moment: { calls: 100, usd: 0.75 } }; // +50 percent on the biggest role
  const r = reconcileCost(SIM, rec, 1);
  assert.equal(r.ok, false);
  assert.ok(r.failed.some((f) => f.startsWith("moment:")));
  assert.ok(r.failed.some((f) => f.startsWith("all:")));
  assert.match(formatRecon(r), /FAIL/);
  // exactly at the edge passes, just over fails
  assert.equal(reconcileCost({ a: { calls: 1, usd: 1 } }, { a: { calls: 1, usd: 1.15 } }, 1).ok, true);
  assert.equal(reconcileCost({ a: { calls: 1, usd: 1 } }, { a: { calls: 1, usd: 1.16 } }, 1).ok, false);
});

test("cost reconciliation: hours normalise both sides; a tiny role alone cannot fail; a big role only in the recording is unmatched", () => {
  const half = { moment: { calls: 50, usd: 0.25 }, observer: { calls: 30, usd: 0.15 }, memory: { calls: 15, usd: 0.05 }, compact: { calls: 1, usd: 0.02 } };
  const r = reconcileCost(SIM, half, 1, 0.5);
  assert.equal(r.rows.find((x) => x.role === "compact")?.material, false, "compact is small");
  assert.equal(r.rows.find((x) => x.role === "moment")?.recCallsPerHour, 100);
  assert.equal(r.ok, true, r.failed.join("; "));
  const extra = reconcileCost(SIM, { ...SIM, digest: { calls: 5, usd: 0.4 } }, 1);
  assert.equal(extra.ok, false);
  assert.ok(extra.failed.some((f) => f.startsWith("digest:") && f.includes("unmatched")));
});

test("cassetteUsageByRole prices the usage stored in the entries", async () => {
  const c = await recorded("Rules.", "[l1] them: hi");
  const e = c.entries()[0];
  e.usage = { inputTokens: { total: 1_000_000, noCache: 1_000_000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1_000_000 } };
  c.put(e);
  const by = cassetteUsageByRole(c);
  assert.equal(by.moment.calls, 1);
  assert.ok(Math.abs(by.moment.usd - 0.6) < 1e-9, String(by.moment.usd)); // 0.1 in + 0.5 out per million
});

// ---- cassette:status
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as statusMain, coverageOf } from "../scripts/cassette-status.ts";

test("cassette:status lists the files by role and model, and prints coverage with stale and missing apart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wingman-status-"));
  try {
    const c = await recorded("Rules.", "[l1] them: hi");
    c.save(join(dir, "dev.cassette.json"));
    const logs: string[] = [];
    // without --cassette: the folder is listed, nothing is played
    assert.equal(await statusMain([], { log: (l) => logs.push(l), dir }), 0);
    assert.match(logs.join("\n"), /dev\.cassette\.json: 1 entries \(1 recorded\)/);
    assert.match(logs.join("\n"), /moment\s+1 entries\s+anthropic:claude-haiku-5-5/);
    // with it: dev is played (the run is a stub here) and the coverage line separates stale from missing
    logs.length = 0;
    const run = (async () => ({ roleCalls: { moment: 100, memory: 20 }, cassetteMisses: 30, cassetteStale: 25 })) as never;
    assert.equal(await statusMain(["--cassette", join(dir, "dev.cassette.json"), "--limit", "2"], { log: (l) => logs.push(l), run, dir }), 0);
    assert.match(logs.join("\n"), /coverage on dev: 2 meetings, 240 model calls, 180 found \(75\.0%\), 50 STALE .*, 10 missing/);
    assert.equal(await statusMain(["--cassette", join(dir, "nope.json")], { log: () => {}, dir }), 2);
    assert.equal(await statusMain([], { log: (l) => logs.push(l), dir: join(dir, "empty") }), 0);
    assert.deepEqual(coverageOf([]), { meetings: 0, calls: 0, found: 0, stale: 0, missing: 0, pct: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
