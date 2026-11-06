// Flow mode (several people on the other side): their own discussion, its topic line, and the moment they turn to the user.
import { type SpeakerInfo } from "../speakers.ts";
import { runTopic, type FlowEvent } from "../flow.ts";
import { log, flow, S, cost, notesAbort, registry, lineOf, transcript, sup, noAi, flowOn } from "./boot.ts";
import { st } from "./state.ts";

let flowTopic = "", flowTopicAt = 0, flowBusy = false;
export const voiceName = (w: SpeakerInfo) => w.name ?? `דובר ${w.spk}`;
/** Writes the flow rows the answer window and dashboard follow: {type:"flow", state, who, topic} and {type:"addressed", who, text}. */
export function flowEvents(evs: FlowEvent[]) {
  for (const e of evs) {
    if (e.type === "internal") {
      log.write("cards", { type: "flow", state: "internal", who: e.who, ...(flowTopic ? { topic: flowTopic } : {}), at: Date.now() });
      log.write("events", { type: "flow.internal", who: e.who });
      console.log(`\n[👥 talking among themselves] ${e.who.join(", ")}`);
    } else if (e.type === "open") {
      flowTopic = ""; flowTopicAt = 0;
      log.write("cards", { type: "flow", state: "open", at: Date.now() });
      log.write("events", { type: "flow.open" });
    } else {
      log.write("cards", { type: "addressed", who: e.who, text: e.text, at: Date.now() });
      log.write("events", { type: "flow.addressed", who: e.who });
      console.log(`\n[👉 to you${e.who ? ` · ${e.who}` : ""}] ${e.text}`);
    }
  }
}
/** Timer job: ends a discussion nobody continued, and refreshes its topic line (one small model call, at most every flow.topicEveryMs). */
export async function flowTick() {
  if (!flowOn || st.call.shuttingDown) return;
  flowEvents(flow.tick(Date.now()));
  if (!S.flow.topic || noAi || !flow.internal || flowBusy || !st.call.consented || !sup.caps.llm || cost.llmState() === "capped") return;
  if (Date.now() - flowTopicAt < S.flow.topicEveryMs) return;
  flowBusy = true; flowTopicAt = Date.now();
  try {
    const lines = transcript.slice(-14).map(lineOf);
    const r = await runTopic({ registry, model: S.flow.model, lines, signal: notesAbort.signal, timeoutMs: S.flow.timeoutMs });
    const c = cost.addLlm("flow", S.flow.model, r.usage, r.providerMetadata);
    log.write("usage", { role: "flow", model: S.flow.model, usage: r.usage, usd: c.usd });
    if (r.topic && flow.internal && !st.call.shuttingDown && r.topic !== flowTopic) {
      flowTopic = r.topic;
      log.write("cards", { type: "flow", state: "internal", who: flow.people, topic: r.topic, at: Date.now() });
      console.log(`\n[👥 topic] ${r.topic}`);
    }
  } catch (e) { log.write("events", { type: "flow.error", error: String((e as Error)?.message ?? e).slice(0, 200) }); }
  finally { flowBusy = false; }
}
