"use strict";
// The state of one capture channel (mic or system audio) inside the app's capture host.
//   idle        nothing runs
//   permission  the start waits for the microphone prompt (macOS can show it for as long as the user likes)
//   starting    the start command is on its way to the capture window; PCM is accepted from here on
//   live        the page confirmed it records
//   stopping    a stop command is on its way to the page
// Each state after idle carries a `tok` (an object made per start). A step that was waiting (the prompt, the window, the reply) checks that its
// token is still the current one; if a stop or a newer start came meanwhile, it gives up and the page is told to stop. Any state may go to idle
// (stop, failure, device ended). Other edges that are not in the table are ignored and logged. No electron import: unit-tested.

const EDGES = Object.freeze({
  idle: ["permission", "starting"],
  permission: ["starting", "idle"],
  starting: ["live", "stopping", "idle"],
  live: ["stopping", "idle"],
  stopping: ["idle"],
});

/** @param {(msg: string) => void} [log] @returns {any} */
function createChannels(log) {
  const state = { mic: { kind: "idle" }, system: { kind: "idle" } };
  return {
    kind: (ch) => state[ch].kind,
    /** True while PCM from the page is accepted and the channel counts as running: starting or live. */
    active: (ch) => state[ch].kind === "starting" || state[ch].kind === "live",
    /** True when `tok` is still the token of the channel's current start (a stop, a failure or a newer start ends it). */
    current: (ch, tok) => state[ch].tok === tok && ["permission", "starting", "live"].includes(state[ch].kind),
    tok: (ch) => state[ch].tok,
    /** Moves the channel to `kind` with token `tok`. Returns false (and logs) for an edge that is not allowed. */
    to(ch, kind, tok) {
      const from = state[ch].kind;
      if (from === kind && kind === "idle") return true;
      if (!(EDGES[from] || []).includes(kind)) {
        if (log) log(`capture ${ch}: ignored ${from} -> ${kind}`);
        return false;
      }
      state[ch] = kind === "idle" ? { kind } : { kind, tok };
      return true;
    },
  };
}

module.exports = { createChannels, EDGES };
