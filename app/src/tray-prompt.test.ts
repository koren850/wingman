// tray/prompt.js: the note and brief form. Loaded in a stand-in page; the form's submit event is fired by hand.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runScript } from "./dash-harness.ts";

function load(search: string, submit: (kind: string, data: unknown) => Promise<unknown>) {
  const handlers: Record<string, (e: any) => any> = {};
  const field = { value: "hello", focus() {} };
  const form = { hidden: true, querySelector: () => field, addEventListener: (ev: string, fn: any) => (handlers[ev] = fn) };
  const doc: any = {
    documentElement: {},
    body: { dataset: {} },
    querySelectorAll: () => [],
    getElementById: (id: string) => (id === "note" || id === "brief" ? form : field),
    addEventListener: () => {},
  };
  const win: any = { WingmanPromptText: { pt: () => "" }, wingman: { submit }, close() {} };
  runScript("tray/prompt.js", { document: doc, window: win, location: { search }, URLSearchParams });
  return { submit: () => handlers.submit({ preventDefault() {} }) };
}

test("the note form sends once even if Enter is pressed twice before main closes the window (T-1)", async () => {
  const sent: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const p = load("?kind=note", async (k, d) => (sent.push([k, d]), gate));
  const a = p.submit();
  const b = p.submit();
  release();
  await Promise.all([a, b]);
  assert.equal(sent.length, 1);
});

test("after a failed send the form can be sent again", async () => {
  let n = 0;
  const p = load("?kind=note", async () => {
    if (++n === 1) throw new Error("no");
  });
  await p.submit();
  await p.submit();
  assert.equal(n, 2);
});
