/* eslint-disable @typescript-eslint/no-explicit-any -- a stand-in for page globals, typed loosely on purpose */
// A small loader for the dashboard page scripts (dashboard/*.js are classic scripts that share globals). It runs them in one vm context
// where every name the test does not provide is an inert stand-in, so a flow (start, readiness check, the plan editor, ...) can be driven
// with a fake `api` and `state` and its state read back. No window, no DOM, no network, no real app.
import vm from "node:vm";
import fs from "node:fs";
import { createRequire } from "node:module";
import { ROOT } from "./env.ts";

const req = createRequire(import.meta.url);
/** A value that can be called, indexed and awaited and does nothing. */
export function inert(): any {
  const f: any = new Proxy(function () {}, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" || typeof k === "symbol" ? undefined : inert()),
    apply: () => inert(),
    construct: () => inert(),
  });
  return f;
}
export type Dash = { ctx: vm.Context; g: Record<string, any>; run: (code: string) => any };
/** files: names under dashboard/. globals: names the page expects (api, state, document, T ...). Pure libs (homelib.js ...) are required as WingmanHome etc. */
export function loadDash(files: string[], globals: Record<string, any> = {}): Dash {
  const target: Record<string, any> = {
    WingmanHome: req(`${ROOT}/dashboard/homelib.js`),
    WingmanSetup: req(`${ROOT}/dashboard/setuplib.js`),
    document: { querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, addEventListener() {}, contains: () => false },
    T: (k: string) => k,
    $: () => null,
    ...globals,
  };
  const proxy: any = new Proxy(target, {
    has: () => true,
    get: (t, k) => (k in t ? t[k as string] : typeof k === "symbol" || k === "undefined" ? undefined : k in globalThis ? (globalThis as any)[k] : inert()),
    set: (t, k, v) => ((t[k as string] = v), true),
  });
  target.window = proxy;
  const ctx = vm.createContext(proxy);
  for (const f of files) vm.runInContext(fs.readFileSync(`${ROOT}/dashboard/${f}`, "utf8"), ctx, { filename: f });
  return { ctx, g: target, run: (code) => vm.runInContext(code, ctx) };
}
/** A promise that is settled by hand. */
export function deferred<T = any>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Runs a classic script from another folder of the app (for example tray/prompt.js) in a context with the given globals. */
export function runScript(file: string, globals: Record<string, any>) {
  vm.runInContext(fs.readFileSync(`${ROOT}/${file}`, "utf8"), vm.createContext({ ...globals }), { filename: file });
}
