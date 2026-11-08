// Engine side of "ask the call" and "Catch me up": gathers the live inputs (memory from session.json, the transcript, the usable models) and
// hands them to session/askflow.ts. The jobs themselves are in session/ask.ts.
import { bankIndex } from "../context/shared.ts";
import { userName, getProfile } from "../profile.ts";
import { loadMemory } from "../session/store.ts";
import { answerAsk, showRecap, type FlowDeps } from "../session/askflow.ts";
import type { AskEnv } from "../session/ask.ts";
import { ht } from "../htext.ts";
import { log, cost, S, registry, transcript, speakers, houseStyle, bank, UI_LANG } from "./boot.ts";
import { usableModels, llmFailed } from "./degrade.ts";
import { emitCard } from "./cards.ts";
import { st } from "./state.ts";
import { askError, askNoCall, askNothing, askOffline, recapEmpty } from "./strings.ts";

let seq = 0;
const lines = () =>
  transcript.map((l) => {
    const who = l.ch === "them" ? speakers.current(l.who)?.name : undefined;
    return { side: l.ch, text: l.text, ...(who ? { name: who } : {}) };
  });

/** The call memory: the live one (the engine keeps it current) unless the file on disk is newer (a restarted engine, a user edit). */
function freshest() {
  const disk = loadMemory(log.dir, Date.now()).mem;
  return st.m.mem.ver >= disk.ver ? st.m.mem : disk;
}

/** Models for ask and recap: the same chain as the reflex, minus any model whose circuit is open. Empty = AI unavailable. */
const models = () => (cost.llmState() === "capped" ? [] : usableModels());

function env(offline = false): AskEnv {
  const p = getProfile();
  return {
    registry,
    models: offline ? [] : models(),
    cfg: { timeoutMs: Math.min(S.llm.reflex.timeoutMs, 9000), maxTokens: 220, cache: S.llm.reflex.cache, effort: "low", thinking: false },
    memory: freshest(),
    lines: lines(),
    shared: {
      rules: `You are Wingman, a live meeting assistant for ${userName()}. In the transcript "me" is ${userName()} and "them" is the other side.`,
      profile: [p.about, p.business].filter(Boolean).join("\n"),
      houseStyle,
      bankIndex: bankIndex(bank),
    },
    labels: { offline: askOffline(), noCall: askNoCall(), nothing: askNothing() },
    onFail: (m, e) => llmFailed(m, e),
  };
}

const deps = (offline = false): FlowDeps => ({
  env: () => env(offline),
  emit: emitCard,
  log: (stream, row) => log.write(stream, row),
  addCost: (role, model, usage, meta) => cost.addLlm(role, model, usage, meta),
  now: () => Date.now(),
  seq: () => ++seq,
  labels: { offline: askOffline(), noCall: askNoCall(), nothing: askNothing(), error: askError(), recapEmpty: recapEmpty() },
  recapLabel: (k) => ht(UI_LANG, `recap.${k}`),
});

/** A question about the call (typed, or spoken after the ask key). Always ends in a card. `offline`: skip the model (it just failed); answer from the notes. */
export function askTheCall(question: string, o: { offline?: boolean } = {}): Promise<void> {
  if (st.call.shuttingDown) return Promise.resolve();
  return answerAsk(deps(!!o.offline), question);
}
/** Ctrl+Opt+U / the `recap` control command. */
export function catchMeUp(): Promise<void> {
  if (st.call.shuttingDown || !st.call.consented) return Promise.resolve();
  return showRecap(deps());
}
