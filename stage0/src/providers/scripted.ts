// Offline test doubles for a whole call with no network and no keys (pnpm e2e, src/e2e.test.ts).
//   stt.provider: script      -> plays a transcript JSON ([{speaker: me|them, text}]) as STT finals, ignores audio.
//                                File: env WINGMAN_STT_SCRIPT; spacing: env WINGMAN_SCRIPT_GAP_MS (default 1200).
//   llm model "scripted:bank" -> a fake model: the reflex answers "BANK <id>" for the first bank card id named in
//                                the prompt's question line, STALL for prices, else SKIP; notes get one note.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { MockLanguageModelV4 } from "ai/test";
import type { SttOptions, SttProvider, SttResult, SttStreamLike } from "./stt/types.ts";
import { matchBank, loadBank } from "../bank.ts";

class ScriptStream extends EventEmitter implements SttStreamLike {
  isOpen = false; audioSeconds = 0; dropped = 0;
  private timers: NodeJS.Timeout[] = [];
  constructor(private o: SttOptions) { super(); }
  async open() {
    this.isOpen = true;
    const file = process.env.WINGMAN_STT_SCRIPT;
    if (!file) throw new Error("stt.provider script needs WINGMAN_STT_SCRIPT=<transcript.json>");
    const gap = Number(process.env.WINGMAN_SCRIPT_GAP_MS ?? 1200);
    const lines = (JSON.parse(readFileSync(file, "utf8")) as { speaker: string; text: string }[]);
    lines.forEach((l, i) => {
      if (l.speaker !== this.o.channel) return;
      this.timers.push(setTimeout(() => {
        const now = Date.now();
        const r: SttResult = { channel: this.o.channel, text: l.text, isFinal: true, speechFinal: true, words: [], speechEndWall: now - 300, arrivedAt: now };
        this.emit("result", r);
      }, 300 + i * gap));
    });
  }
  send(pcm: Buffer) { this.audioSeconds += pcm.length / 32000; return true; }
  async close() { this.isOpen = false; for (const t of this.timers) clearTimeout(t); this.emit("close"); }
}

export const script: SttProvider = {
  id: "script" as any, experimental: false,
  capabilities: { keyterms: false, diarize: false, interim: false, maxKeyterms: 0 },
  create: (o) => new ScriptStream(o),
  probe: async () => ({ ok: true }),
};

/** The reflex prompt ends with: The client just said: <call_transcript>QUESTION</call_transcript> */
function questionOf(prompt: string): string {
  const m = prompt.match(/The client just said: <call_transcript>([\s\S]*?)<\/call_transcript>/);
  return m?.[1] ?? "";
}
function promptText(o: any): string {
  return (o.prompt ?? []).map((m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((p: any) => p.text ?? "").join(""))).join("\n");
}
const bank = loadBank();
export function scriptedAnswer(prompt: string): string {
  if (prompt.includes("You keep short live notes")) return "- הלקוחה רוצה אתר מהיר יותר";
  const q = questionOf(prompt);
  if (/כמה (זה )?עולה|מחיר/.test(q)) return "STALL";
  const hit = matchBank(q, bank);
  return hit ? `BANK ${hit.card.id}` : "SKIP";
}
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const finish = { unified: "stop" as const, raw: "end_turn" };

export function createScripted() {
  return (modelId: string) => new MockLanguageModelV4({
    provider: "scripted", modelId,
    doGenerate: async (o: any) => ({ content: [{ type: "text", text: scriptedAnswer(promptText(o)) }], finishReason: finish, usage, warnings: [] }) as any,
    doStream: async (o: any) => {
      const text = scriptedAnswer(promptText(o));
      const parts = [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }, { type: "finish", usage, finishReason: finish }];
      return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) } as any;
    },
  });
}
