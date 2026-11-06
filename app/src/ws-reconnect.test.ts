// WsStream (Soniox/Gladia base): a failed open leaves no live socket; a dead server ends in one terminal error after the retry limit.
import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type WebSocket from "ws";
import { WsStream } from "./providers/stt/ws-base.ts";

class TestStream extends WsStream {
  throwOnOpen = false;
  constructor(private url: string) {
    super("test", { channel: "mic", apiKey: "k", baseUrl: url } as never, 3, [10, 20, 30]);
  }
  protected async connectUrl() {
    return this.url;
  }
  protected onOpen(_ws: WebSocket) {
    if (this.throwOnOpen) throw new Error("config rejected");
  }
  protected onMessage() {}
}
const listen = () =>
  new Promise<{ wss: WebSocketServer; url: string; socks: ServerSocket[] }>((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    const socks: ServerSocket[] = [];
    wss.on("connection", (s) => socks.push(s));
    wss.on("listening", () => resolve({ wss, url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, socks }));
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("ws-base: a rejected open leaves no live socket and does not reconnect in the background", async () => {
  const { wss, url, socks } = await listen();
  const st = new TestStream(url);
  st.throwOnOpen = true;
  st.on("error", () => {});
  await assert.rejects(st.open());
  await sleep(300);
  assert.equal(socks.length, 1, "no reconnect after a failed open");
  assert.equal(socks.filter((s) => s.readyState === 1).length, 0, "the failed socket is closed");
  assert.equal(st.isOpen, false);
  await new Promise((r) => wss.close(r));
});

test("ws-base: after the server dies, retries stop at the limit and one terminal error is emitted", async () => {
  const { wss, url, socks } = await listen();
  const st = new TestStream(url);
  const errors: unknown[] = [];
  let disconnected = 0;
  st.on("error", (e) => errors.push(e));
  st.on("disconnected", () => disconnected++);
  await st.open();
  for (const c of wss.clients) c.terminate();
  await new Promise((r) => wss.close(r));
  await sleep(1200);
  assert.equal(errors.length, 1, `terminal errors: ${errors.length}`);
  assert.equal(disconnected, 1);
  assert.equal(socks.length, 1);
  await st.close();
});
