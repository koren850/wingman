// Gate test: speaker numbers across a reconnect, through the real engine. The speech service numbers voices from 0 again on every new connection; the engine
// must not read "speaker 0" after a reconnect as the person who was speaker 0 before. Real parts: SttChannel (reconnect, provider switch), engine/stt.ts
// wiring, ingest, the speaker book, the call log. Faked parts: the provider streams. Virtual clock, no network.
import "../test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupEngine, type Engine } from "../testkit/engine-inproc.ts";
import { SttChannel } from "../providers/stt/channel.ts";
import { ProviderError } from "../providers/errors.ts";
import { FakeStream, fakeProvider, said, type Row } from "./gates-kit.ts";

let e: Engine;
const themStreams: FakeStream[] = [];
const fallbackStreams: FakeStream[] = [];
let them: SttChannel;
before(async () => {
  e = await setupEngine();
  const { chans } = await import("../engine/state.ts");
  const stt = await import("../engine/stt.ts");
  const mk = (channel: "me" | "them", chain: ReturnType<typeof fakeProvider>[]) =>
    new SttChannel({ channel, chain, keyOf: () => "k", base: {}, circuit: { failures: 99, windowMs: 10_000 }, ringMs: 2000 });
  them = mk("them", [fakeProvider("deepgram", themStreams), fakeProvider("soniox", fallbackStreams)]);
  chans.them = them;
  chans.me = mk("me", [fakeProvider("deepgram", [])]);
  stt.wireChannels((await import("../engine/ingest.ts")).onResult, (await import("../engine/degrade.ts")).tickHealth);
  await them.open();
});
after(async () => {
  await them?.close();
  e?.stop();
});

const events = () =>
  readFileSync(e.boot.log.dir + "/events.jsonl", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);
/** Say a line as raw provider speaker `raw` on the CURRENT stream of the channel; returns who the engine put on it. */
async function hear(stream: FakeStream, text: string, raw: number) {
  const n = e.boot.transcript.length;
  stream.emit("result", said(text, raw, Date.now()));
  await e.vc.advance(400);
  const line = e.boot.transcript.slice(n).find((t) => t.text === text);
  assert.ok(line, `the line reached the transcript: ${text}`);
  return line.who ? e.boot.speakers.current(line.who) : undefined;
}

test("speaker numbers after a reconnect: the same raw id is a new person; an introduction with the same name joins the earlier person", async () => {
  await e.reset();
  const s1 = themStreams[0];
  const dana = await hear(s1, "Hi, I'm Dana.", 0);
  const omer = await hear(s1, "I'm Omer.", 1);
  assert.deepEqual([dana?.spk, dana?.name], [1, "Dana"]);
  assert.deepEqual([omer?.spk, omer?.name], [2, "Omer"]);

  // the socket drops and the adapter reconnects: the provider counts from 0 again, and the voice that is "0" now is somebody else
  s1.drop();
  await e.vc.advance(1000);
  s1.back();
  await e.vc.advance(200);
  const fresh = await hear(s1, "And the invoices go out on the first of every month.", 0);
  assert.ok(fresh, "a speaker label is still attached");
  assert.notEqual(e.boot.speakers.resolve(fresh.spk), e.boot.speakers.resolve(dana!.spk), "raw id 0 after the reconnect is not Dana");
  assert.equal(fresh.name, undefined, "no name is guessed for a new voice");

  // it says who it is: same name as an earlier person, so it is that person
  const intro = await hear(s1, "I'm Omer, by the way.", 0);
  assert.equal(e.boot.speakers.resolve(intro!.spk), e.boot.speakers.resolve(omer!.spk), "a named introduction maps to the earlier Omer");
  const later = await hear(s1, "Please send the report to the shared mailbox.", 0);
  assert.equal(later!.name, "Omer", "his earlier line and his later line carry the same name");

  const rebases = events().filter((x) => x.type === "speakers.rebase");
  assert.equal(rebases.length, 1, JSON.stringify(rebases));
  assert.equal(rebases[0].why, "reconnect");
});

test("a burst of reconnects with no voice in between is one rebase, and a provider switch is another", async () => {
  await e.reset();
  const s1 = themStreams[0];
  await hear(s1, "Good morning everyone, shall we begin with the agenda.", 3); // a voice is numbered: the next reconnect starts a new epoch
  const before = e.boot.speakers.rebases;
  for (let i = 0; i < 4; i++) {
    s1.drop();
    await e.vc.advance(300);
    s1.back();
    await e.vc.advance(300);
  }
  assert.equal(e.boot.speakers.rebases, before + 1, "four reconnects with no voice in between moved the epoch once");
  const after1 = await hear(s1, "Let us start with the budget numbers for the quarter.", 0);
  const nBefore = e.boot.speakers.count;

  // dead socket, switch to the fallback provider (a real channel switch)
  await them.switchNext(new ProviderError("network", "deepgram" as never, "socket closed"));
  await e.vc.advance(200);
  assert.equal(them.provider, "soniox");
  const s2 = fallbackStreams[0];
  assert.ok(s2?.isOpen, "the fallback stream is open");
  const onFallback = await hear(s2, "Can you hear me now on the new connection please.", 0);
  assert.notEqual(e.boot.speakers.resolve(onFallback!.spk), e.boot.speakers.resolve(after1!.spk), "the switch started a new epoch");
  assert.equal(e.boot.speakers.count, nBefore + 1);
  const why = events()
    .filter((x) => x.type === "speakers.rebase")
    .map((x) => x.why);
  assert.ok(why.includes("provider switch"), JSON.stringify(why));
});
