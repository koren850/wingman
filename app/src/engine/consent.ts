// Start of listening: the consent card, and "Start listening" (immediately, or after the user confirms when privacy.requireConsentAck is on).
import { log, CONTROL, fileArg, S, CONSENT_SAY, confirmContext } from "./boot.ts";
import { setPhase, status } from "./out.ts";
import { st, mono } from "./state.ts";
import { setupKeys, setupControl } from "./control.ts";
import { emitCard, type Card } from "./cards.ts";
import { startMicWatch } from "./watchdogs.ts";
import { consentTitle, consentSayIt, consentStop, consentStart, consentStarted } from "./strings.ts";

/** Consent card: re-emitted every 20 s until confirmed (the answer window may start late and would miss a single one). */
const consentCard = (): Card => ({
  id: "consent",
  turnId: "start",
  badge: "info",
  question: consentTitle(),
  say: CONSENT_SAY,
  facts: [consentSayIt(), consentStop(CONTROL), consentStart(CONTROL)],
  at: Date.now(),
});
export let reemit: NodeJS.Timeout | undefined;
export function stopConsentTimer() {
  clearInterval(reemit);
}

/** Waits for "Start listening" when privacy.requireConsentAck is on; otherwise listening starts at once. Wires the keyboard / control channel. */
export function startConsent() {
  // privacy.requireConsentAck ("Ask me before listening starts", default off): wait for Start listening before any audio leaves the Mac.
  const needAck = S.privacy.requireConsentAck && !fileArg && (process.stdin.isTTY || CONTROL);
  const startForwarding = () => {
    if (st.call.consented || st.call.shuttingDown) return; // a "consent" queued behind Stop must not write phase "live" over "ended"
    st.call.consented = true;
    clearInterval(reemit);
    log.write("events", { type: needAck ? "consent.confirmed" : "listening.start" });
    if (needAck) {
      emitCard({ ...consentCard(), id: "consent", say: consentStarted(), facts: [] });
      console.log("\nListening started: audio is now being sent for transcription.");
    }
    status("consented", { id: log.id });
    confirmContext(); // the brief and files are kept until now. Later it could move to the first successful session-memory write ({ev:"memory"} for the tray).
    const consentedAt = Date.now();
    st.call.consentedMono = mono();
    setPhase("live", { liveAt: consentedAt });
    if (!fileArg) startMicWatch();
  };
  if (needAck) emitCard(consentCard());
  reemit = setInterval(() => {
    if (!st.call.consented && !st.call.shuttingDown && needAck) emitCard(consentCard());
  }, 20_000);
  if (!needAck) startForwarding();
  if (CONTROL) setupControl(startForwarding);
  else setupKeys(startForwarding);
  if (!st.call.consented) {
    console.log(
      `\nWaiting for you to start listening: nothing is sent to the cloud until you ${CONTROL ? 'click "Start listening" in the menu bar' : "press Enter"}.`,
    );
    setPhase("waiting");
    status("waiting", { id: log.id });
  }
}
