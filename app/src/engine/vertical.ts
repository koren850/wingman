// The vertical hook: a product vertical (for the author, a web agency) may tell the core that a line is on its topic. The core keeps no vertical words.
// The default gate reads the pack's topics.txt (frame.ts isAgencyTopic), so the words live in the user's pack, not in the engine. A profile or a test
// may replace the gate with `setVerticalGate` (profile.vertical?.topicGate in the plan). The time of the last on-topic customer line keeps short follow-ups on topic.
import { isAgencyTopic } from "../frame.ts";
import { st } from "./state.ts";

export type TopicGate = (text: string) => boolean;
let gate: TopicGate = (t) => isAgencyTopic(t);
/** Replaces the topic gate (undefined = back to the pack's topics). */
export function setVerticalGate(g: TopicGate | undefined): void {
  gate = g ?? ((t) => isAgencyTopic(t));
}
/** A line from the other side: remember when the vertical topic was last on. */
export function noteTopicLine(text: string, now: number): void {
  if (gate(text)) st.turn.lastAgencyTopicAt = now;
}
