// Answer window v2 (overlay/v2.js model, preload "act" channel, strings, qa-check.js) and the hidden snapshot checks (overlay/snap2.cjs).
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT } from "./env.ts";
import { MAC } from "./test-platform.ts";

const require = createRequire(import.meta.url);
const V = require("../overlay/v2.js");
const qa = require("../overlay/qa-check.js");
const strings = require("../overlay/strings.js");
const fx = require("../overlay/fixtures-v2.cjs");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

const T0 = 1_000_000;
const row = (o: Record<string, unknown>) => ({ type: "card", id: "x", say: "Say this", at: T0, ...o });

test("kindOf and isV2: v2 fields make a v2 card; legacy rows, tips, health and side rows do not", () => {
  assert.equal(V.kindOf({ kind: "check" }), "check");
  assert.equal(V.kindOf({ badge: "careful" }), "check");
  assert.equal(V.kindOf({ badge: "fix" }), "check");
  assert.equal(V.kindOf({ badge: "fact" }), "fact");
  assert.equal(V.kindOf({ badge: "ai" }), "answer");
  assert.equal(V.kindOf({ kind: "bogus", badge: "bank" }), "answer");
  assert.equal(V.isV2(row({ kind: "answer" })), true);
  assert.equal(V.isV2(row({ why: "because" })), true);
  assert.equal(V.isV2(row({ more: ["a"] })), true);
  assert.equal(V.isV2(row({ closes: "answered" })), true);
  assert.equal(V.isV2(row({ badge: "ai", question: "q?", facts: ["f"] })), false, "a legacy row has none of the v2 fields");
  assert.equal(V.isV2(row({ badge: "tip", tipType: "ask" })), false, "a legacy tip has no kind");
  assert.equal(V.isV2(row({ badge: "tip", kind: "prompt" })), true, "the engine's v2 prompt card keeps badge tip for old tools but has kind prompt");
  assert.equal(V.isV2(row({ health: true, kind: "check" })), false);
  assert.equal(V.isV2(row({ turnId: "side", kind: "fact" })), false);
  assert.equal(V.isV2({ type: "frame", kind: "client" }), false);
  assert.equal(V.isV2(null), false);
});

test("board: a higher rank replaces the hero and the old hero waits as a chip", () => {
  const b = new V.Board();
  b.apply(row({ id: "a", kind: "answer", value: 2 }), T0);
  assert.equal(b.hero.id, "a");
  b.apply(row({ id: "p", kind: "prompt", value: 3, at: T0 + 1 }), T0 + 1);
  assert.equal(b.hero.id, "a", "a prompt never beats an answer");
  b.apply(row({ id: "c", kind: "check", value: 1, at: T0 + 2 }), T0 + 2);
  assert.equal(b.hero.id, "c", "a check beats an answer");
  assert.deepEqual(
    b.chips.map((e: { id: string }) => e.id),
    ["p", "a"],
    "the old hero is a chip, not gone",
  );
  b.apply(row({ id: "a2", kind: "answer", value: 3, at: T0 + 3 }), T0 + 3);
  assert.equal(b.hero.id, "c", "an answer does not beat a check");
});

test("board: equal rank, newer wins; value breaks ties between kinds of the same rank", () => {
  const b = new V.Board();
  b.apply(row({ id: "a", kind: "answer", value: 2, at: T0 }), T0);
  b.apply(row({ id: "b", kind: "answer", value: 2, at: T0 + 5 }), T0 + 5);
  assert.equal(b.hero.id, "b");
  b.apply(row({ id: "c", kind: "answer", value: 1, at: T0 + 9 }), T0 + 9);
  assert.equal(b.hero.id, "b", "lower value waits");
});

test("board: a fact is a chip only and leaves after five minutes", () => {
  const b = new V.Board();
  b.apply(row({ id: "f", kind: "fact", at: T0 }), T0);
  assert.equal(b.hero, null);
  assert.equal(b.chips.length, 1);
  assert.equal(b.promote("f"), false, "a fact never becomes the hero");
  assert.equal(b.tick(T0 + V.FACT_MS - 1), false);
  assert.equal(b.tick(T0 + V.FACT_MS), true);
  assert.equal(b.chips.length, 0);
});

test("board: a closed card dims with its reason for 4 s, then goes to history and the next card takes the seat", () => {
  const b = new V.Board();
  b.apply(row({ id: "a", kind: "answer", value: 3 }), T0);
  b.apply(row({ id: "w", kind: "answer", value: 1, at: T0 + 1 }), T0 + 1);
  assert.equal(b.hero.id, "a");
  b.apply({ type: "card", id: "a", closes: "answered" }, T0 + 10);
  assert.equal(b.hero.id, "a");
  assert.equal(b.hero.state, "dim");
  assert.equal(b.hero.reason, "answered");
  assert.equal(b.tick(T0 + 10 + V.DIM_MS - 1), false);
  assert.equal(b.tick(T0 + 10 + V.DIM_MS), true);
  assert.equal(b.hero.id, "w", "the waiting card is promoted");
  assert.equal(b.history[0].id, "a");
  assert.equal(b.history[0].reason, "answered");
  b.apply({ type: "card", id: "w", closes: "topic" }, T0 + 20000);
  assert.equal(b.hero.reason, "topic");
  assert.equal(b.apply({ type: "card", id: "ghost", closes: "topic" }, T0), null, "a close for an unknown card does nothing");
});

test("board: a new card takes the seat of a dimmed hero at once", () => {
  const b = new V.Board();
  b.apply(row({ id: "a", kind: "answer", value: 3 }), T0);
  b.apply({ type: "card", id: "a", closes: "topic" }, T0 + 1);
  b.apply(row({ id: "n", kind: "prompt", value: 1, at: T0 + 2 }), T0 + 2);
  assert.equal(b.hero.id, "n");
});

test("board: pin keeps the card; only a check can replace a pinned hero; dismiss removes it at once", () => {
  const b = new V.Board();
  b.apply(row({ id: "a", kind: "answer", value: 1 }), T0);
  assert.equal(b.togglePin("a"), true);
  b.apply(row({ id: "b", kind: "answer", value: 3, at: T0 + 1 }), T0 + 1);
  assert.equal(b.hero.id, "a");
  b.apply({ type: "card", id: "a", closes: "answered" }, T0 + 2);
  assert.equal(b.hero.state, "live", "a pinned card is not dimmed by a close");
  b.apply(row({ id: "c", kind: "check", value: 1, at: T0 + 3 }), T0 + 3);
  assert.equal(b.hero.id, "c");
  b.remove("c", "dismissed", T0 + 4);
  assert.equal(b.hero.id, "a", "the next best card takes the seat");
  assert.equal(b.history[0].reason, "dismissed");
  b.apply({ type: "card", id: "a", closes: "dismissed" }, T0 + 5);
  assert.equal(b.has("a"), false, "a dismissed close removes even a pinned card");
});

test("board: the chip cap drops the oldest answers to history but never a check", () => {
  const b = new V.Board();
  b.apply(row({ id: "c1", kind: "check", value: 3, at: T0 }), T0);
  for (let i = 0; i < 8; i++) b.apply(row({ id: "w" + i, kind: "answer", value: 1, at: T0 + 1 + i }), T0 + 1 + i);
  const kinds = b.chips.map((e: { id: string }) => e.id);
  assert.equal(b.hero.id, "c1");
  assert.equal(kinds.length, V.MAX_CHIPS);
  assert.deepEqual(kinds, ["w7", "w6", "w5", "w4"]);
  // checks are not cut by the answer cap, but open checks have their own cap (r2: V.MAX_CHECKS), and the newest one takes the hero
  for (let i = 0; i < 6; i++) b.apply(row({ id: "k" + i, kind: "check", value: 1, say: "Check " + i, ref: "r" + i, at: T0 + 100 + i }), T0 + 100 + i);
  assert.equal([...b.cards.values()].filter((e: { kind: string }) => e.kind === "check").length, V.MAX_CHECKS, "open checks are capped");
  assert.equal(b.hero.id, "k5");
});

test("board: promote swaps the hero; rate toggles; updates keep their place; withdraw removes silently", () => {
  const b = new V.Board();
  b.apply(row({ id: "a", kind: "answer", value: 3 }), T0);
  b.apply(row({ id: "w", kind: "answer", value: 1, at: T0 + 1 }), T0 + 1);
  assert.equal(b.promote("w"), true);
  assert.equal(b.hero.id, "w");
  assert.deepEqual(
    b.chips.map((e: { id: string }) => e.id),
    ["a"],
  );
  assert.equal(b.rate("w", "useful"), "useful");
  assert.equal(b.rate("w", "useful"), "", "the same rating again clears it");
  assert.equal(b.rate("w", "not_useful"), "not_useful");
  b.apply(row({ id: "w", kind: "answer", value: 1, say: "New text", at: T0 + 999 }), T0 + 999);
  assert.equal(b.hero.head, "New text");
  assert.equal(b.hero.rating, "not_useful", "an update keeps the rating");
  assert.equal(b.hero.at, T0 + 1, "an update keeps its age");
  b.apply({ type: "card", id: "a", withdraw: true }, T0 + 2000);
  assert.equal(b.has("a"), false);
  assert.equal(b.history.length, 0);
});

test("makeEntry: the line stays whole; the detail is the more lines and the facts, at most 4", () => {
  const long = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen";
  const e = V.makeEntry(row({ say: long, more: ["m1", "m2", "m3"], facts: ["f1", "f2"] }), T0);
  assert.equal(e.head, long, "nothing is moved out of the line");
  assert.equal(e.long, true);
  assert.deepEqual(e.detail, ["m1", "m2", "m3", "f1"]);
  assert.equal(V.makeEntry(row({ value: 9 }), T0).value, 3);
  assert.equal(V.makeEntry(row({ value: "x" }), T0).value, 1);
});

test("normView: cleans a view row and never throws on junk", () => {
  const v = V.normView({
    now: " Topic ",
    kind: "client",
    open: ["a", { text: "b" }, 3, ""],
    cover: "no",
    ai: "offline",
    recap: { where: "w", decided: ["d"] },
  });
  assert.equal(v.topic, "Topic");
  assert.deepEqual(v.open, ["a", "b"]);
  assert.deepEqual(v.cover, []);
  assert.equal(v.ai, "offline");
  assert.equal(v.recap.where, "w");
  assert.deepEqual(v.recap.promised, []);
  assert.equal(V.normView({ ai: "weird" }).ai, "ok");
  assert.equal(V.normView(null).topic, "");
  assert.equal(V.recapEmpty(V.normView({}).recap), true);
  assert.equal(V.recapEmpty(v.recap), false);
});

// ---- controls and the preload bridge ----
test("controls send the right messages (fake IPC)", () => {
  const sent: [string, unknown][] = [];
  const copied: string[] = [];
  const c = V.createControls(
    (k: string, p: unknown) => sent.push([k, p]),
    (t: string) => copied.push(t),
  );
  c.rate("c1", "useful");
  c.rate("c1", "none");
  c.rate("c1", "weird");
  c.pin("c1", true);
  c.pin("c1", false);
  c.dismiss("c1");
  c.copy("hello");
  assert.deepEqual(sent, [
    ["rate", { cardId: "c1", rating: "useful" }],
    ["rate", { cardId: "c1", rating: "none" }],
    ["rate", { cardId: "c1", rating: "none" }],
    ["event", { name: "pin", cardId: "c1" }],
    ["event", { name: "unpin", cardId: "c1" }],
    ["event", { name: "dismiss", cardId: "c1" }],
  ]);
  assert.deepEqual(copied, ["hello"]);
  assert.equal(V.copyText({ head: "Head", detail: ["a", "b"] }), "Head\na\nb");
});

function loadPreload() {
  const sends: [string, unknown][] = [];
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  let api: Record<string, (...a: unknown[]) => unknown> = {};
  const fake = {
    contextBridge: { exposeInMainWorld: (_n: string, a: typeof api) => (api = a) },
    ipcRenderer: { on: (ch: string, h: () => void) => (handlers[ch] = h), send: (ch: string, p: unknown) => sends.push([ch, p]) },
  };
  const Mod = require("node:module") as { _load: (...a: unknown[]) => unknown };
  const orig = Mod._load;
  Mod._load = (req: unknown, ...rest: unknown[]) => (req === "electron" ? fake : orig.call(Mod, req, ...rest));
  const path = join(ROOT, "overlay/preload.cjs");
  delete require.cache[require.resolve(path)];
  try {
    require(path);
  } finally {
    Mod._load = orig;
  }
  return { api, sends, handlers };
}

test("preload: act() sends only clean rate and event messages on the act channel; copy still works", () => {
  const { api, sends, handlers } = loadPreload();
  api.act!("rate", { cardId: "c1", rating: "useful" });
  api.act!("event", { cardId: "c1", name: "pin" });
  api.act!("event", { cardId: "c1", name: "delete-everything" }); // unknown event
  api.act!("rate", { cardId: "c1", rating: "five stars" }); // unknown rating
  api.act!("rate", { rating: "useful" }); // no card
  api.act!("shell", { cardId: "c1", cmd: "rm -rf" }); // unknown kind
  api.act!("rate", "not an object");
  api.act!("rate", { cardId: "x".repeat(500), rating: "none" });
  api.copy!("text");
  assert.deepEqual(sends, [
    ["act", { kind: "rate", cardId: "c1", rating: "useful" }],
    ["act", { kind: "event", cardId: "c1", name: "pin" }],
    ["act", { kind: "rate", cardId: "x".repeat(200), rating: "none" }],
    ["copy", "text"],
  ]);
  assert.equal(
    api.onRecap!(() => undefined),
    undefined,
    "a bridge function returns nothing",
  );
  assert.equal(typeof handlers.recap, "function", "the recap event is subscribed (the hotkey is wired by main.cjs)");
});

test("cleanAct in v2.js and in the preload give the same answer", () => {
  const { api, sends } = loadPreload();
  const cases: [string, unknown][] = [
    ["rate", { cardId: "a", rating: "useful" }],
    ["rate", { cardId: "a", rating: "not_useful" }],
    ["rate", { cardId: "a", rating: "none" }],
    ["rate", { cardId: "a", rating: "x" }],
    ["event", { cardId: "a", name: "pin" }],
    ["event", { cardId: "a", name: "unpin" }],
    ["event", { cardId: "a", name: "dismiss" }],
    ["event", { cardId: "a", name: "x" }],
    ["other", { cardId: "a" }],
    ["rate", {}],
    ["rate", null],
  ];
  for (const [kind, payload] of cases) {
    sends.length = 0;
    api.act!(kind, payload);
    const want = V.cleanAct(kind, payload);
    assert.deepEqual(sends[0]?.[1] ?? null, want, `${kind} ${JSON.stringify(payload)}`);
  }
});

// ---- strings ----
test("v2 strings: both languages have every v2 key; every tr() key in v2view.js exists; no Hebrew outside strings.js", () => {
  const he = Object.keys(strings.STRINGS.he).filter((k) => k.startsWith("v2."));
  const en = Object.keys(strings.STRINGS.en).filter((k) => k.startsWith("v2."));
  assert.ok(he.length >= 40);
  assert.deepEqual(en.sort(), he.sort(), "key parity for v2.*");
  const src = read("overlay/v2view.js");
  const used = new Set<string>();
  for (const m of src.matchAll(/\btr\("([\w.-]+)"/g)) if (!m[1]!.endsWith(".")) used.add(m[1]!); // "v2.kind." + k is a run-time key, listed below
  // keys built at run time: kind label, dim reason, count chips and their list titles, key names for the kinds on the idle line
  for (const k of ["answer", "prompt", "check", "fact"]) used.add("v2.kind." + k);
  for (const k of ["answered", "topic", "time"]) used.add("v2.dim." + k);
  for (const k of ["v2.list.open", "v2.list.promises", "v2.list.cover", "v2.age.s", "v2.age.min"]) used.add(k);
  for (const k of ["client", "support", "vendor", "team", "consult", "personal", "other"]) used.add("kind." + k);
  for (const k of used) assert.ok(k in strings.STRINGS.en, "unknown key " + k);
  for (const f of ["overlay/v2view.js", "overlay/v2.js", "overlay/qa-check.js", "overlay/index.html"]) {
    const code = read(f)
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    assert.doesNotMatch(code, /[֐-׿]/, `${f} has a Hebrew literal outside strings.js`);
  }
  // the interface keeps its own labels short enough for a chip: no label above 40 characters except sentences
  for (const k of ["v2.context", "v2.fewer", "v2.recap.button", "v2.more", "v2.useful", "v2.notUseful"]) {
    assert.ok(strings.STRINGS.en[k].length <= 20 && strings.STRINGS.he[k].length <= 22, k);
  }
});

test("v2 view: no innerHTML, every text node is set with textContent or a text node (card text comes from the call)", () => {
  for (const f of ["overlay/v2view.js", "overlay/v2.js"]) assert.doesNotMatch(read(f), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, f);
});

// ---- contrast helper and the CSS the checks rely on ----
test("contrastRatio: WCAG values", () => {
  assert.equal(Math.round(qa.contrastRatio([0, 0, 0], [255, 255, 255])), 21);
  assert.equal(qa.contrastRatio([255, 255, 255], [255, 255, 255]), 1);
  assert.ok(qa.contrastRatio([119, 119, 119], [255, 255, 255]) > 4.4 && qa.contrastRatio([119, 119, 119], [255, 255, 255]) < 4.6); // #777 on white is the 4.48 edge
  assert.deepEqual(qa.parseColor("rgba(10, 20, 30, 0.5)"), [10, 20, 30, 0.5]);
  assert.deepEqual(qa.parseColor("rgb(10, 20, 30)"), [10, 20, 30, 1]);
  assert.equal(qa.parseColor("transparent"), null);
});

function hex(h: string): [number, number, number] {
  const n = parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
test("theme tokens: the dim text colours reach 4.5:1 on their backgrounds, in dark and light", () => {
  const css = read("overlay/overlay.css");
  const block = (sel: RegExp) => sel.exec(css)![1]!;
  const vars = (b: string) => Object.fromEntries([...b.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));
  const dark = vars(block(/\n:root \{([^}]*)\}/));
  const light = { ...dark, ...vars(block(/:root\[data-theme="light"\] \{([^}]*)\}/)) };
  for (const [name, v] of [
    ["dark", dark],
    ["light", light],
  ] as const) {
    for (const fg of ["--text", "--soft", "--muted"])
      for (const bg of ["--bg", "--card", "--card2", "--raised"])
        assert.ok(qa.contrastRatio(hex(v[fg]!), hex(v[bg]!)) >= 4.5, `${name}: ${fg} on ${bg} = ${qa.contrastRatio(hex(v[fg]!), hex(v[bg]!)).toFixed(2)}`);
  }
});

// ---- snapshots: the hidden window with real preload, clipping / contrast / font / dir checks ----
const HAVE_ELECTRON = existsSync(join(ROOT, "node_modules/.bin/electron"));
const SNAP = { ...MAC, skip: MAC.skip || (!HAVE_ELECTRON && "electron is not installed") };
function snap(lang: "en" | "he", specs: string[]) {
  const out = mkdtempSync(join(tmpdir(), "wm-snap-"));
  const r = spawnSync(join(ROOT, "node_modules/.bin/electron"), [join(ROOT, "overlay/snap2.cjs"), out, "--check", ...specs], {
    env: { ...process.env, WINGMAN_OVERLAY_LANG: lang },
    encoding: "utf8",
    timeout: 480_000, // the whole v2 set in two looks is over 100 specs
    maxBuffer: 64 * 1024 * 1024,
  });
  const results = r.stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map(
      (l) =>
        JSON.parse(l) as {
          spec: string;
          png: string;
          ipc: [string, unknown][];
          issues: { type: string; sel: string; detail: string }[];
          metrics: { heroPct: number; minFont: number };
        },
    );
  return { results, out, status: r.status, stderr: r.stderr };
}

test("snapshots: the buttons on the hero send the right IPC messages from the real page", SNAP, () => {
  const { results } = snap("en", ["v2-controls"]);
  assert.equal(results.length, 1);
  const r = results[0]!;
  assert.deepEqual(r.ipc, [
    ["act", { kind: "event", cardId: "a1", name: "pin" }],
    ["act", { kind: "rate", cardId: "a1", rating: "useful" }],
    ["act", { kind: "rate", cardId: "a1", rating: "none" }],
    ["act", { kind: "rate", cardId: "a1", rating: "not_useful" }],
    [
      "copy",
      "Yes, through the API. About two days of work.\nNeeds an admin user in Salesforce\nZapier works too, but a direct webhook has fewer points of failure\nPrice from the brief: 2,400 once",
    ],
    ["act", { kind: "event", cardId: "a1", name: "dismiss" }],
  ]);
});

test("snapshots: card controls and Catch me up work from the keyboard events, and an unknown key does nothing", SNAP, () => {
  const { results } = snap("en", ["v2-live-keys"]);
  const r = results[0]!;
  assert.equal(r.issues.length, 0);
  const acts = r.ipc.map(([ch, p]) => [ch, (p as { kind?: string; name?: string; rating?: string }).name ?? (p as { rating?: string }).rating]);
  assert.deepEqual(acts, [
    ["act", "pin"],
    ["act", "useful"],
    ["act", "not_useful"],
    ["act", "recap"],
  ]);
});

for (const lang of ["en", "he"] as const) {
  test(`snapshots (${lang}): every v2 scenario passes the clipping, contrast, font and dir checks in dark M and light L`, SNAP, () => {
    const names: string[] = fx.ALL;
    const specs = [...names, ...names.map((n) => n + ":light,l")];
    const { results, status, stderr } = snap(lang, specs);
    assert.equal(results.length, specs.length, "every spec produced a result: " + stderr.slice(0, 300));
    const bad = results
      .filter((r) => r.issues.length)
      .map(
        (r) =>
          `${r.spec}: ${r.issues
            .map((i) => `${i.type} ${i.sel} ${i.detail}`)
            .slice(0, 3)
            .join(" | ")}`,
      );
    assert.deepEqual(bad, [], "layout or contrast problems");
    assert.equal(status, 0);
    for (const r of results) assert.ok(existsSync(r.png), r.png);
  });
  test(`snapshots (${lang}): sizes S and L and the hero stays under 25 percent of the window with a long card`, SNAP, () => {
    const specs = [
      "v2-long",
      "v2-long:s",
      "v2-long:l",
      "v2-long:light,s",
      "v2-long:light,l",
      "v2-manychips:s",
      "v2-manychips:l",
      "v2-chipsopen:l",
      "v2-mixed:l",
      "v2-check:l",
    ];
    const { results } = snap(lang, specs);
    assert.equal(results.length, specs.length);
    for (const r of results) {
      assert.deepEqual(r.issues, [], r.spec);
      assert.ok(r.metrics.minFont >= 12, `${r.spec} font ${r.metrics.minFont}`);
      if (r.spec.startsWith("v2-long")) assert.ok(r.metrics.heroPct > 0 && r.metrics.heroPct < 25, `${r.spec} hero is ${r.metrics.heroPct} percent`);
    }
  });
}

test("board edge: a pinned waiting card is never dropped by the chip cap", () => {
  const b = new V.Board();
  b.apply(row({ id: "hero", kind: "check", value: 3, at: T0 }), T0);
  b.apply(row({ id: "keep", kind: "answer", at: T0 + 1 }), T0 + 1);
  b.togglePin("keep");
  for (let i = 0; i < 8; i++) b.apply(row({ id: "w" + i, kind: "answer", at: T0 + 2 + i }), T0 + 2 + i);
  assert.ok(b.has("keep"), "pinned card stays");
});

test("board edge: junk rows never throw and a numeric id works", () => {
  const b = new V.Board();
  // eslint-disable-next-line prefer-spread -- Board.apply, not Function.apply
  assert.equal(b.apply(null, T0), null);
  assert.equal(b.apply({ type: "card" }, T0), null);
  b.apply(row({ id: 7, kind: "answer" }), T0);
  assert.ok(b.has(7));
  b.close(7, "weird", T0);
  assert.equal(b.hero.reason, "time");
  b.tick(T0 + V.DIM_MS);
  assert.equal(b.has(7), true, "a card that timed out stays longer than one you answered");
  b.tick(T0 + V.DIM_BY.time);
  assert.equal(b.has(7), false);
});

test("fixtures: card ages are measured from the moment a scenario is built, not from when the file was loaded", () => {
  // A snapshot run of many specs can take minutes on a busy machine. If ages were fixed at load, a 40 s old card would turn stale (3 minutes) in a late spec and fail the contrast check.
  const realNow = Date.now;
  const t0 = realNow.call(Date);
  try {
    Date.now = () => t0 + 10 * 60_000;
    const rows = fx.build("v2-answer", "en").rows as { at: number }[];
    for (const r of rows) assert.ok(Date.now() - r.at < 60_000, "a fresh scenario has fresh cards, however late it is built: " + (Date.now() - r.at));
  } finally {
    Date.now = realNow;
  }
});
