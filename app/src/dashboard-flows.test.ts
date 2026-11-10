// The flows of the dashboard page that used to live only in DOM flags: the readiness check, the Start flow, the plan editor, ratings and so on.
// Each one is a small state value with a transition function (dashboard/homelib.js); here the page scripts run with a fake api and the
// stale or overlapping answers are checked. The pure transitions are tested first.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadDash, deferred } from "./dash-harness.ts";

const req = createRequire(import.meta.url);
const HL = req("../dashboard/homelib.js");
const tick = () => new Promise((r) => setImmediate(r));

test("check transitions: a full check is never replaced; a quick one may be; a replaced answer is dropped (D-2)", () => {
  const q = HL.checkBegin(HL.CHECK_IDLE, "quick");
  assert.equal(q.status, "running");
  assert.equal(HL.checkBegin(q, "quick"), null);
  const f = HL.checkBegin(q, "full");
  assert.equal(f.kind, "full");
  assert.notEqual(f.token, q.token);
  assert.equal(HL.checkBegin(f, "full"), null);
  assert.equal(HL.checkBegin(f, "quick"), null);
  assert.equal(HL.checkEnd(f, q.token).accept, false, "the quick answer is stale");
  const end = HL.checkEnd(f, f.token);
  assert.equal(end.accept, true);
  assert.equal(HL.checkRunning(end.state), false);
  assert.equal(HL.checkEnd(end.state, f.token).accept, false, "answered twice");
});

test("start transitions: one start at a time; the gate lets a new start begin; illegal moves are refused (D-3)", () => {
  const S = HL.START_IDLE;
  const saving = HL.startNext(S, "saving", "p1");
  assert.deepEqual(saving, { status: "saving", planId: "p1" });
  assert.equal(HL.startNext(saving, "saving"), null);
  assert.equal(HL.startNext(S, "starting"), null);
  const gate = HL.startNext(saving, "gate");
  assert.equal(HL.startBusy(gate), false);
  assert.equal(HL.startBusy(saving), true);
  assert.ok(HL.startNext(gate, "saving", "p1"));
  const rv = HL.startNext(saving, "reviewing");
  assert.equal(HL.startBusy(rv), true);
  assert.equal(HL.startNext(rv, "starting").planId, "p1", "the plan id is kept along the way");
  assert.deepEqual(HL.startNext(rv, "idle"), S);
});

function home(extra: Record<string, any> = {}) {
  const calls = { start: 0, doctor: [] as any[] };
  const api: any = {
    start: async () => (calls.start++, { ok: true }),
    startNoAi: async () => (calls.start++, { ok: true }),
    ...extra.api,
  };
  const state: any = { view: "home", calls: [], call: { running: false, phase: "idle", doctor: { ok: true, warnings: [], failing: [], at: 1 } }, gen: 0 };
  const el = () => ({ textContent: "", append() {}, focus() {}, querySelector: () => null });
  const d = loadDash(["home.js"], {
    api,
    state,
    keysMissing: () => [],
    $: (id: string) => (id === "start-gate" || id === "main" || id === "call-slot" ? el() : null),
    ...extra.globals,
  });
  return { d, calls, api, state };
}

test("the Start flow runs once for a double click and the buttons stay off until it ends (D-3)", async () => {
  const gate = deferred();
  const { d, calls } = home({ api: { start: async () => (calls.start++, gate.promise) } });
  d.run("startFlow({ noAi: false })");
  d.run("startFlow({ noAi: false })");
  await tick();
  assert.equal(d.run("H.start.status"), "starting");
  assert.equal(calls.start, 1);
  gate.resolve({ ok: true });
  await tick();
  assert.equal(d.run("H.start.status"), "idle");
  d.run("startFlow({ noAi: false })");
  await tick();
  assert.equal(calls.start, 2, "a later start works");
});

test("a failed check leaves the Start flow at the gate, and Start anyway goes on from there (D-3)", async () => {
  const failing = { ok: false, verdict: "NOT READY", warnings: [], failing: [{ text: "Deepgram did not answer", fix: "" }], at: 5 };
  const { d, state, calls } = home();
  state.call.doctor = failing;
  d.run("startFlow({ noAi: false })");
  await tick();
  assert.equal(d.run("H.start.status"), "gate");
  assert.equal(calls.start, 0);
  d.run("startFlow({ noAi: false }, true)");
  await tick();
  assert.equal(calls.start, 1);
  assert.equal(d.run("H.start.status"), "idle");
});

test("a quick check that finishes after a full check does not replace its result or end its busy state (D-2)", async () => {
  const quick = deferred(),
    full = deferred();
  const queue = [quick, full];
  const { d, state } = home({ api: { runDoctor: () => queue.shift()!.promise } });
  state.call.doctor = null;
  d.run("runCheck(true)");
  d.run("runCheck(false)");
  d.run("runCheck(false)"); // a third request while the full check runs is ignored
  assert.equal(queue.length, 0);
  quick.resolve({ ok: true, warnings: [], failing: [], at: 10 });
  await tick();
  assert.equal(d.run("checking()"), true, "the full check is still running");
  assert.equal(state.call.doctor, null, "the stale quick answer was not used");
  const bad = { ok: false, verdict: "NOT READY", warnings: [], failing: [{ text: "x", fix: "" }], at: 20 };
  full.resolve(bad);
  await tick();
  assert.equal(d.run("checking()"), false);
  assert.equal(state.call.doctor, bad);
  // a call-state push that carries an older result does not undo the local one
  d.run("onCallState({ running: false, phase: 'idle', doctor: { ok: true, warnings: [], failing: [], at: 10 } })");
  assert.equal(state.call.doctor.at, 20);
});

test("the launch check waits while a key is missing, and runs once the keys are saved", async () => {
  const ran: boolean[] = [];
  const { d, state } = home({ api: { runDoctor: async (quick: boolean) => (ran.push(quick), { ok: true, warnings: [], failing: [], at: 9 }) } });
  state.call.doctor = null;
  d.run(`H.keys = { providers: { deepgram: { source: "missing" } } }`);
  d.run("autoCheck()");
  await tick();
  assert.equal(ran.length, 0, "no check against a missing key");
  assert.equal(d.run("H.autoChecked"), false, "the launch check is still to come");
  d.run(`H.keys = { providers: { deepgram: { source: "keychain" } } }`);
  d.run("autoCheck()");
  await tick();
  assert.equal(ran.length, 1);
});

test("Stop is sent once for a double click, and again after a refusal; Quiet takes its value from the call state (D-8)", async () => {
  const gate = deferred();
  const sent = { stop: 0, quiet: [] as boolean[] };
  const { d, state } = home({
    api: {
      stop: () => (sent.stop++, gate.promise),
      quiet: async (on: boolean) => (sent.quiet.push(on), { ok: true }),
    },
  });
  state.call = { running: true, phase: "live", quiet: false };
  d.run("stopCall()");
  d.run("stopCall()");
  assert.equal(sent.stop, 1);
  gate.resolve({ ok: false });
  await tick();
  d.run("stopCall()");
  assert.equal(sent.stop, 2, "a refused stop can be tried again");
  d.run("quietToggle()");
  d.run("quietToggle()");
  await tick();
  assert.deepEqual(sent.quiet, [true], "one request at a time, and the value is the opposite of the state");
  state.call.quiet = true;
  d.run("quietToggle()");
  await tick();
  assert.deepEqual(sent.quiet, [true, false]);
});

test("a rating saved after the person opened another call updates the right row only (D-5)", async () => {
  const gate = deferred();
  const sum = (id: string, n: number) => ({ id, cards: 3, tagged: n });
  const els = { painted: 0 };
  const dash = loadDash(["app.js"], {
    wingman: { setTag: () => gate.promise },
    CSS: { escape: (x: string) => x },
    document: { querySelector: () => (els.painted++, null), querySelectorAll: () => [], getElementById: () => null, addEventListener() {} },
    pendingOf: (s: any) => 3 - s.tagged,
  });
  dash.run(
    `state.id = "call-a"; state.gen = 4; state.detail = { tags: {}, cards: [], summary: null }; state.calls = [{ id: "call-a", tagged: 0 }, { id: "call-b", tagged: 0 }];`,
  );
  const p = dash.run(`doRate({ id: "c1" }, "y", false)`);
  dash.run(`state.id = "call-b"; state.gen = 5; state.detail = { tags: {}, cards: [], summary: null };`); // the person opened the other call
  gate.resolve(sum("call-a", 1));
  await p;
  const calls = dash.run("state.calls");
  assert.equal(calls[0].tagged, 1, "the first call's row has its own summary");
  assert.equal(calls[1].tagged, 0, "the other call's row is not replaced");
  assert.equal(calls.length, 2);
  assert.equal(els.painted, 0, "nothing on the new screen was repainted");
});

function editorPage(api: Record<string, any>) {
  const { d, state } = home({ api });
  d.run("H.tickBound = true");
  const plan = (id: string) => ({ id, title: "Plan " + id, who: "", goal: "", mustCover: "" });
  d.run(`H.plans = [${JSON.stringify(plan("A"))}, ${JSON.stringify(plan("B"))}]`);
  const ed = loadDash(["home.js", "context.js"], { ...d.g, loadSetup: async () => {}, loadAiMode: () => {} }); // the same page globals, with the editor script
  ed.run(`H.plans = [${JSON.stringify(plan("A"))}, ${JSON.stringify(plan("B"))}]; H.tickBound = true`);
  return { ed, state };
}

test("opening plan B right after plan A never shows or saves A's text in B (D-4)", async () => {
  const gates: Record<string, ReturnType<typeof deferred>> = { A: deferred(), B: deferred() };
  const { ed } = editorPage({ attachList: (id: string) => gates[id].promise, planContext: async (id: string) => "text of " + id });
  ed.run('openEditor("A")');
  ed.run('openEditor("B")');
  gates.B.resolve({ files: [] });
  await tick();
  gates.A.resolve({ files: [] }); // the older answer arrives last
  await tick();
  assert.equal(ed.run("H.editId"), "B");
  assert.equal(ed.run("H.draft.context"), "text of B");
  assert.equal(ed.run("H.draft.title"), "Plan B");
  assert.equal(ed.run("H.editor.status"), "open");
  assert.equal(ed.run("H.editor.id"), "B");
});

test("closing the editor while it loads leaves it closed (D-4)", async () => {
  const gate = deferred();
  const { ed } = editorPage({ attachList: () => gate.promise, planContext: async () => "x" });
  ed.run('openEditor("A")');
  ed.run("closeEditor(false)");
  gate.resolve({ files: [] });
  await tick();
  assert.equal(ed.run("H.editing"), false);
  assert.equal(ed.run("H.draft"), null);
  assert.equal(ed.run("H.editor.status"), "closed");
});

const homeApi = (more: Record<string, any>) => ({
  callState: async () => ({ running: false, phase: "idle" }),
  keysStatus: async () => ({ ok: true, providers: {} }),
  recentPlans: async () => [],
  getSettings: async () => ({ ok: true, items: [] }),
  attachList: async () => ({ files: [] }),
  planContext: async () => "text",
  ...more,
});
const planOf = (id: string) => ({ id, title: "Plan " + id, who: "", goal: "", mustCover: "" });

test("an older Home load does not overwrite a newer one (D-4)", async () => {
  const first = deferred(),
    second = deferred();
  const queue = [first, second];
  const { ed } = editorPage(homeApi({ plansList: () => queue.shift()!.promise }));
  ed.run("viewHome()"); // slow
  ed.run("viewHome()"); // newer
  second.resolve([planOf("A")]);
  await tick();
  first.resolve([planOf("OLD")]);
  await tick();
  assert.deepEqual(ed.run("H.plans.map((p) => p.id)"), ["A"], "the older load is dropped");
});

test("a slow Home load does not close an editor that was opened while it ran (D-4)", async () => {
  const slow = deferred();
  const { ed } = editorPage(homeApi({ plansList: () => slow.promise }));
  ed.run("viewHome()");
  ed.run('H.plans = [{ id: "A", title: "Plan A", who: "", goal: "", mustCover: "" }]; openEditor("A")');
  await tick();
  assert.equal(ed.run("H.editing"), true);
  slow.resolve([planOf("A")]);
  await tick();
  assert.equal(ed.run("H.editing"), true, "still open");
  assert.equal(ed.run("H.editor.status"), "open");
});

/** A tiny page: elements are plain objects with attrs, kids and listeners; $() finds the newest element with an id. */
function fakePage() {
  type N = {
    tag: string;
    attrs: Record<string, any>;
    kids: any[];
    value?: string;
    on: Record<string, ((e?: any) => void)[]>;
    removed?: boolean;
    [k: string]: any;
  };
  const byId = new Map<string, N>();
  const flatten = (a: any[]): any[] => a.flat(Infinity).filter((k) => k != null && k !== false);
  const h = (tag: string, attrs: any, ...kids: any[]): N => {
    const n: N = {
      tag,
      attrs: attrs || {},
      kids: flatten(kids),
      on: {},
      textContent: "",
      addEventListener: (ev: string, fn: any) => void (n.on[ev] ||= []).push(fn),
      append: (...k: any[]) => void n.kids.push(...k),
      focus() {},
      remove() {
        n.removed = true;
        if (n.attrs.id && byId.get(n.attrs.id) === n) byId.delete(n.attrs.id);
      },
      querySelectorAll: () => [],
    };
    if (n.attrs.id) byId.set(n.attrs.id, n);
    return n;
  };
  const btn = (label: any, x: any = {}) => h("button", { ...x, class: "btn " + (x.cls || "") }, label);
  const slot = h("div", { id: "pop-slot" });
  return { h, btn, byId, slot, $: (id: string) => (id === "pop-slot" ? slot : (byId.get(id) ?? null)) };
}
const pickEl = (pg: ReturnType<typeof fakePage>, id: string) => pg.byId.get(id)!;
const fire = (n: any, ev: string) => (n.on[ev] || []).forEach((f: any) => f());

test("the review before Start keeps a line being edited when a tick box redraws it, and closes when the view changes (D-7)", async () => {
  const pg = fakePage();
  const KN = req("../dashboard/knowslib.js");
  const model = KN.fixture("before", "en");
  const secs = Object.entries(model.sections).filter(([, l]) => (l as unknown[]).length) as [string, { id: string; text: string }[]][];
  const first = secs[0][1][0],
    second = secs[0][1][1];
  const d = loadDash(["prestart.js"], {
    h: pg.h,
    btn: pg.btn,
    chip: () => null,
    ico: () => null,
    $: pg.$,
    srcLine: () => "",
    recapOffer: () => null,
    ready: () => {},
    announce: () => {},
    langOf: () => null,
    document: { activeElement: null, contains: () => false, querySelector: () => null },
  });
  d.g.window.WingmanKnows = KN;
  const result = d.run("prestartReview(" + JSON.stringify(model) + ", {})");
  // Edit the first line, type, then tick the second line's box (a redraw).
  pickEl(pg, "ps-e-" + first.id).attrs.onclick();
  const box = pickEl(pg, "ps-i-" + first.id);
  box.value = "My own words";
  fire(box, "input");
  const tick2 = pickEl(pg, "ps-c-" + second.id);
  tick2.checked = false;
  fire(tick2, "change");
  const again = pickEl(pg, "ps-i-" + first.id);
  assert.ok(again && !again.removed, "the edit box is still there after the redraw");
  assert.equal(again.value, "My own words", "with what was typed");
  // A view change closes the sheet and nothing starts.
  d.run("closePrestart()");
  assert.equal((await result).go, false);
  assert.equal(d.run("typeof psCancel"), "object");
  assert.equal(d.run("psCancel"), null);
});

test("a started call closes an open review (D-7)", () => {
  const el = { textContent: "", append() {} };
  const d = loadDash(["home.js"], {
    api: {},
    state: { view: "home", calls: [], call: null },
    $: (id: string) => (id === "call-slot" ? el : null),
    closePrestart: () => void (d.g.closed = (d.g.closed || 0) + 1),
  });
  d.run("onCallState({ running: true, phase: 'starting' })");
  assert.equal(d.g.closed, 1);
});

test("the keys sheet fields have ids of their own, so Settings and the sheet never repeat an id (D-7)", () => {
  const pg = fakePage();
  const s = loadDash(["settings.js"], { h: pg.h, btn: pg.btn, chip: () => null, api: {} });
  s.run("KEYS.data = { providers: { deepgram: { source: 'missing' }, anthropic: { source: 'missing' } } }");
  s.run('keyRow("deepgram"); keyRow("deepgram", "ks-key-")');
  assert.ok(pg.byId.has("key-deepgram") && pg.byId.has("ks-key-deepgram"));
});

test("the first call state from boot does not replace a newer pushed one (D-9)", async () => {
  const first = deferred();
  let push!: (s: unknown) => void;
  const el = () => ({ addEventListener() {}, setAttribute() {}, textContent: "" });
  const state: any = { call: null, view: "", calls: [] };
  const d = loadDash(["boot.js"], {
    state,
    api: { onCallState: (f: any) => (push = f), onNav() {}, callState: () => first.promise },
    $: el,
    location: { search: "" },
    navigator: { languages: ["en"] },
    document: { documentElement: {}, querySelector: el, querySelectorAll: () => [] },
    loadList: () => Promise.resolve(),
    onCallState: (s: any) => (state.call = s),
    renderCallSlot: () => {},
    windowLangChoice: () => "en",
    viewHome: () => {},
    setNav: () => {},
  });
  void d;
  push({ running: true, phase: "live", at: 2 }); // a newer state arrives while the first answer is still on its way
  first.resolve({ running: false, phase: "idle", at: 1 });
  await tick();
  assert.equal(state.call.phase, "live");
});
