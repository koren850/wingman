// Scheduler properties: hero never replaced by a lower rank, per-minute cap with exempt kinds, feedback raises a threshold, stale turns drop, offline mode.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  recordShown,
  recordFeedback,
  clearHero,
  newSchedulerState,
  rankOf,
  minValueFrom,
  thresholdFor,
  isExempt,
  DEFAULT_SCHEDULER,
  type ScheduledMoment,
  type SchedulerState,
} from "./moments/scheduler.ts";
import { MOMENT_TAGS } from "./moments/types.ts";

const M = (o: Partial<ScheduledMoment> = {}): ScheduledMoment => ({ tag: "ANS", value: 3, aim: "me", say: "x", why: "", more: [], ...o });
const show = (s: SchedulerState, m: ScheduledMoment, id: string) => {
  const d = decide(m, s);
  assert.equal(d.action === "show", true, `${id}: ${d.reason}`);
  return recordShown(s, m, id, d);
};

test("scheduler: SKIP, aim other and a low value are dropped; value just below the minimum is a chip", () => {
  const s = newSchedulerState(1000);
  assert.equal(decide(M({ tag: "SKIP", value: 0 }), s).reason, "skip");
  assert.equal(decide(M({ aim: "other" }), s).reason, "aim-other");
  assert.equal(decide(M({ value: 0 }), s).action, "drop");
  assert.equal(decide(M({ value: 1 }), s).action, "chip");
  assert.equal(decide(M({ value: 2 }), s).action, "show");
  assert.equal(decide(M({ tag: "STALL", stall: "price", value: 1 }), s).action, "chip"); // a stall has a lower default, but VALUE 1 is only ever a chip
  assert.equal(decide(M({ tag: "STALL", stall: "price", value: 2 }), s).action, "show");
});

test("scheduler: per-tag min value from the setting", () => {
  assert.deepEqual(minValueFrom(3), { default: 3 });
  const mv = minValueFrom({ TERM: 3, ANS: 1 });
  assert.equal(mv.TERM, 3);
  assert.equal(mv.ANS, 1);
  assert.equal(mv.default, 2);
  const cfg = { ...DEFAULT_SCHEDULER, minValue: mv };
  assert.equal(decide(M({ tag: "TERM", value: 2 }), newSchedulerState(), cfg).action, "chip");
  assert.equal(decide(M({ tag: "ANS", value: 1 }), newSchedulerState(), cfg).reason, "value-1"); // the setting lets it through the minimum, VALUE 1 stays a chip
  assert.equal(decide(M({ tag: "ANS", value: 2 }), newSchedulerState(), cfg).action, "show");
});

test("scheduler: rank is value x urgency x freshness, lower for an old line and for an unclear aim", () => {
  const fresh = rankOf(M({ lineAt: 1000 }), 1500);
  const old = rankOf(M({ lineAt: 1000 }), 9000);
  assert.ok(fresh > old);
  assert.ok(rankOf(M({ aim: "unclear" }), 0) < rankOf(M({ aim: "me" }), 0));
  assert.ok(rankOf(M({ tag: "STALL" }), 0) > rankOf(M({ tag: "NOTE" }), 0));
});

test("scheduler property: a live hero is never replaced by a lower or equal rank", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const tags = MOMENT_TAGS.filter((t) => t !== "SKIP");
  for (let run = 0; run < 200; run++) {
    let s = newSchedulerState(0);
    const hero = M({ tag: tags[Math.floor(rnd() * tags.length)], value: 2 + Math.floor(rnd() * 2) } as Partial<ScheduledMoment>);
    const hd = decide(hero, s);
    if (hd.action !== "show") continue;
    s = recordShown(s, hero, "hero", hd);
    for (let k = 0; k < 10; k++) {
      s = { ...s, now: s.now + Math.floor(rnd() * 3000), memVer: s.memVer + 1 };
      const m = M({
        tag: tags[Math.floor(rnd() * tags.length)],
        value: Math.floor(rnd() * 4),
        aim: "me",
        lineAt: s.now - Math.floor(rnd() * 8000),
        ref: `q${run}-${k}`,
      } as Partial<ScheduledMoment>);
      const d = decide(m, s);
      if (d.action === "show" && s.hero && s.now - s.hero.at < DEFAULT_SCHEDULER.topicLifetimeMs) {
        assert.ok(d.rank > s.hero.rank, `rank ${d.rank} replaced hero ${s.hero.rank}`);
        assert.equal(d.replaces, s.hero.id);
        s = recordShown(s, m, `c${k}`, d);
      }
    }
  }
});

test("scheduler: a higher rank takes over the hero; after the topic lifetime or clearHero anything may show", () => {
  let s = newSchedulerState(0);
  s = show(s, M({ tag: "NOTE", value: 2, ref: "a1" }), "n1");
  const d = decide(M({ tag: "NOTE", value: 2, ref: "a2" }), s);
  assert.equal(d.reason, "hero-holds");
  assert.equal(d.action, "chip");
  const hi = decide(M({ tag: "STALL", stall: "price", value: 3, ref: "a3" }), s);
  assert.equal(hi.action, "show");
  assert.equal(hi.replaces, "n1");
  assert.equal(decide(M({ tag: "NOTE", value: 2, ref: "a2" }), clearHero(s)).action, "show");
  assert.equal(decide(M({ tag: "NOTE", value: 2, ref: "a2" }), { ...s, now: 61_000 }).action, "show");
});

test("scheduler: per-minute cap; price/guarantee stalls and checks are exempt", () => {
  let s = newSchedulerState(0);
  for (let i = 0; i < DEFAULT_SCHEDULER.maxPerMinute; i++) {
    s = { ...s, now: i * 1000, hero: undefined, memVer: s.memVer + 1 };
    s = show(s, M({ ref: `r${i}` }), `c${i}`);
  }
  s = { ...s, now: 5000, hero: undefined };
  const capped = decide(M({ ref: "r9" }), s);
  assert.equal(capped.reason, "per-minute-cap");
  assert.equal(capped.action, "chip");
  assert.equal(decide(M({ tag: "STALL", stall: "price", ref: "p1" }), s).action, "show");
  assert.equal(decide(M({ tag: "STALL", stall: "guarantee", ref: "p2" }), s).action, "show");
  assert.equal(decide(M({ tag: "BANK", bankId: "stall-price" }), s).action, "show");
  assert.equal(decide(M({ tag: "CHECK", ref: "p3" }), s).action, "show");
  assert.equal(decide(M({ tag: "STALL", stall: "timeline", ref: "p4" }), s).reason, "per-minute-cap"); // a timeline stall is not exempt
  assert.equal(isExempt(M({ tag: "REPLY" })), false);
  assert.equal(decide(M({ ref: "r9" }), { ...s, now: 62_000 }).action, "show"); // the minute passed
  // exempt cards do not use up the cap
  let t = newSchedulerState(0);
  for (let i = 0; i < 6; i++) {
    t = { ...t, now: i * 100, hero: undefined };
    t = recordShown(t, M({ tag: "CHECK", ref: `k${i}` }), `k${i}`, decide(M({ tag: "CHECK", ref: `k${i}` }), t));
  }
  assert.equal(decide(M({ ref: "z" }), { ...t, hero: undefined }).action, "show");
});

test("scheduler: novelty needs a memory change for the same ref, bank card or topic within 2 minutes", () => {
  let s = newSchedulerState(0);
  s = { ...s, memVer: 3 };
  s = show(s, M({ ref: "q12" }), "a");
  s = { ...s, now: 30_000, hero: undefined };
  assert.equal(decide(M({ ref: "q12" }), s).reason, "not-novel");
  assert.equal(decide(M({ ref: "q12" }), { ...s, memVer: 4 }).action, "show");
  assert.equal(decide(M({ ref: "q12" }), { ...s, now: 130_000 }).action, "show"); // after 2 minutes
  assert.equal(decide(M({ ref: "q99" }), s).action, "show");
  let b = show({ ...newSchedulerState(0), memVer: 1 }, M({ tag: "BANK", bankId: "site-slow" }), "b1");
  b = { ...b, now: 10_000, hero: undefined };
  assert.equal(decide(M({ tag: "BANK", bankId: "site-slow" }), b).reason, "not-novel");
  assert.equal(decide(M({ tag: "BANK", bankId: "backups" }), b).action, "show");
  let t = show({ ...newSchedulerState(0), memVer: 1 }, M({ topic: "Pricing", tag: "REPLY" }), "t1");
  t = { ...t, now: 10_000, hero: undefined };
  assert.equal(decide(M({ topic: "pricing", tag: "REPLY" }), t).reason, "not-novel");
});

test("scheduler: three not-useful ratings in a row raise that kind's threshold; useful resets; other kinds are untouched", () => {
  let s = newSchedulerState(0);
  assert.equal(thresholdFor("TERM", s), 2);
  s = recordFeedback(s, "TERM", "not-useful");
  s = recordFeedback(s, "TERM", "not-useful");
  s = recordFeedback(s, "TERM", "useful");
  s = recordFeedback(s, "TERM", "not-useful");
  s = recordFeedback(s, "TERM", "not-useful");
  assert.equal(thresholdFor("TERM", s), 2);
  s = recordFeedback(s, "TERM", "not-useful");
  assert.equal(thresholdFor("TERM", s), 3);
  assert.equal(decide(M({ tag: "TERM", value: 2 }), s).action, "chip");
  assert.equal(decide(M({ tag: "TERM", value: 3 }), s).action, "show");
  assert.equal(thresholdFor("ANS", s), 2);
  for (let i = 0; i < 9; i++) s = recordFeedback(s, "TERM", "not-useful");
  assert.equal(thresholdFor("TERM", s), 3); // capped at 3
});

test("scheduler: a late stream from another turn is dropped", () => {
  const s: SchedulerState = { ...newSchedulerState(1000), currentTurnId: 7 };
  assert.equal(decide(M({ turnId: 6 }), s).reason, "stale-turn");
  assert.equal(decide(M({ turnId: 7 }), s).action, "show");
  assert.equal(decide(M({}), s).action, "show"); // no turn id: not checked
});

test("scheduler: a late observer moment is dropped, a late direct one is only ranked lower", () => {
  const s = newSchedulerState(20_000);
  assert.equal(decide(M({ source: "observer", lineAt: 10_000 }), s).reason, "late");
  assert.equal(decide(M({ source: "direct", lineAt: 10_000 }), s).action, "show");
});

test("scheduler offline: only a strong hint may show a bank or stall card", () => {
  const s: SchedulerState = { ...newSchedulerState(0), offline: true };
  assert.equal(decide(M({ tag: "BANK", bankId: "backups", hint: "strong" }), s).action, "show");
  assert.equal(decide(M({ tag: "STALL", stall: "price", hint: "strong" }), s).action, "show");
  assert.equal(decide(M({ tag: "BANK", bankId: "backups", hint: "weak" }), s).reason, "offline");
  assert.equal(decide(M({ tag: "ANS", hint: "strong" }), s).reason, "offline");
});
