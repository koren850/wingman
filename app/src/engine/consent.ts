// Start of listening: the consent card, and "Start listening" (immediately, or after the user confirms when privacy.requireConsentAck is on).
import { log, CONTROL, fileArg, S, CONSENT_SAY, confirmContext } from "./boot.ts";
import { status } from "./out.ts";
import { transition } from "./phase.ts";
import { st, mono } from "./state.ts";
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

/** Waits for "Start listening" when privacy.requireConsentAck is on; otherwise listening starts at once. `listen` wires the keyboard or the control
 *  channel (control.ts) to the function it is given; it is passed in so that this file does not import control.ts back (an import cycle). */
export function startConsent(listen: (startForwarding: () => void) => void) {
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
    transition("live", { liveAt: consentedAt });
    if (!fileArg) startMicWatch();
  };
  if (needAck) emitCard(consentCard());
  if (needAck) {
    // Only a call that waits for the user's yes needs the card again and again.
    reemit = setInterval(() => {
      if (!st.call.consented && !st.call.shuttingDown) emitCard(consentCard());
    }, 20_000);
    reemit.unref();
  }
  if (!needAck) startForwarding();
  listen(startForwarding);
  if (!st.call.consented) {
    console.log(
      `\nWaiting for you to start listening: nothing is sent to the cloud until you ${CONTROL ? 'click "Start listening" in the menu bar' : "press Enter"}.`,
    );
    transition("waiting");
    status("waiting", { id: log.id });
  }
}
