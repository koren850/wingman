// Speech-to-text channels: creation, opening with retries, the reconnect loops, and the wiring of channel events to the transcript and the health bars.
import { eventError } from "../errtext.ts";
import type { Channel, SttResult } from "../providers/stt/types.ts";
import { SttChannel } from "../providers/stt/channel.ts";
import { getSttProvider, sttChain } from "../providers/stt/index.ts";
import { describe, type ProviderError } from "../providers/errors.ts";
import { isPermanentSttError } from "../health.ts";
import { SttRetryRegistry } from "./stt-retry.ts";
import { health, chHe, healthClear, safe, errBrief } from "./out.ts";
import { log, sup, S, keyterms, PHONE, keys, NO_KEY, phone, UI_LANG, speakers } from "./boot.ts";
import { ht } from "../htext.ts";
import { st, chans } from "./state.ts";
import { tickHealth } from "./degrade.ts";
import { onResult } from "./ingest.ts";

/** Channels that moved to the fallback STT provider (the ladder treats this as degraded). */
export const sttSwitchedCh = new Set<Channel>();

/** A new STT connection numbers its voices from 0 again: the speaker book must not read its raw ids as the old ones. One log line per rebase that took effect. */
function rebaseSpeakers(ch: string, why: string) {
  if (speakers.rebase(ch)) {
    log.write("events", { type: "speakers.rebase", ch, why, epoch: speakers.rebases });
    console.log(`voices may be relabelled after the ${why} (${ch})`);
  }
}

/** One STT channel (own socket, provider chain with fallback and circuit breaker). Keys come from memory, not env. */
function makeChannel(ch: Channel): SttChannel {
  return new SttChannel({
    channel: ch,
    chain: sttChain(S).map(getSttProvider),
    keyOf: (id) => (NO_KEY.has(id) ? "none" : (keys as Record<string, string | undefined>)[id]),
    base: {
      diarize: (ch === "them" && S.stt.speakers) || (PHONE && ch === "me"),
      language: S.stt.language,
      keyterms,
      endpointingMs: S.stt.endpointMs,
      utteranceEndMs: S.stt.utteranceEndMs,
      keepAliveMs: S.stt.keepAliveMs,
      model: S.stt.model,
      mipOptOut: S.stt.deepgram.mipOptOut,
    },
    circuit: S.stt.circuit,
    ringMs: S.stt.reconnect.ringMs,
  });
}

/** STT channel with no fallback left: keep reopening the current provider (backoff 1,2,4,8,10,10... s) until it works. A refused key / no credit
 *  (permanent) does not end the call: the other side's channel goes to rung 4 (transcript-only: your own questions still get answers), the red bar stays,
 *  and the reopen is retried slowly (every 30 s, so a top-up mid-call is picked up). "unknown" errors count as transient. */
const retries = new SttRetryRegistry();
const SLOW_RETRY_MS = Number(process.env.WINGMAN_STT_SLOW_RETRY_MS) || 30_000; // (the env override exists for tests)
function sttMarkPermanent(ch: string, e: ProviderError) {
  health(`stt-${ch}`, "red", ht(UI_LANG, "stt.refused", { ch: chHe(ch), err: describe(e), sec: Math.round(SLOW_RETRY_MS / 1000) }), e.message);
  if (ch === "them") sup.set({ themSttDown: true });
  log.write("events", { type: "stt.permanent", ch, kind: e.kind });
}
export function sttRetryLoop(s: SttChannel, ch: string, permanent = false, firstDelayMs?: number, skipIfOpen = false) {
  return retries.run(
    ch,
    {
      reopen: () => s.reopen(),
      healthy: skipIfOpen ? () => s.isOpen : undefined,
      stopped: () => st.call.shuttingDown,
      slowMs: SLOW_RETRY_MS,
      onPermanent: (e) => sttMarkPermanent(ch, e as ProviderError),
      onFail: (n, e) => {
        const pe = e as ProviderError;
        log.write("events", { type: "stt.retry.fail", ch, n, kind: pe.kind, error: eventError(pe) });
      },
      onRecovered: (attempts) => {
        healthClear(`stt-${ch}`);
        if (ch === "them") sup.set({ themSttDown: false });
        log.write("events", { type: "stt.recovered", ch, attempts });
      },
    },
    permanent,
    firstDelayMs,
  );
}

/** Initial open: transient errors (timeout, network, 5xx, closed) retry with backoff 1/2/4/8 s for ~30 s with a "connecting" line; auth/quota/spend-cap throw at once.
 *  After 30 s the call goes on exactly like a mid-call outage (red bar, retry forever): starting is safe, the consent card and mic checks do not depend on STT. */
export async function openChannel(ch: SttChannel, name: string) {
  const t0 = Date.now();
  for (let n = 0; ; n++) {
    try {
      await ch.open();
      if (n) healthClear(`stt-${name}`);
      return;
    } catch (e) {
      const pe = e as ProviderError;
      if (!pe.kind || (!pe.retryable && pe.kind !== "unknown")) throw e; // auth / quota / spend cap / bad request: fatal with its clear message
      log.write("events", { type: "stt.open.retry", ch: name, n: n + 1, kind: pe.kind, error: eventError(pe) });
      if (Date.now() - t0 > 30_000) {
        health(`stt-${name}`, "red", ht(UI_LANG, "stt.noconn", { ch: chHe(name), err: describe(pe) }));
        void sttRetryLoop(ch, name);
        return;
      }
      if (!n) health(`stt-${name}`, "amber", ht(UI_LANG, "stt.connecting", { name }));
      await new Promise((r) => setTimeout(r, Math.min(8000, 1000 * 2 ** n)));
    }
  }
}

/** Creates both channels (own socket each); nothing is opened yet. */
export function createChannels() {
  chans.me = makeChannel("me");
  chans.them = makeChannel("them");
  for (const id of sttChain(S)) if (getSttProvider(id).experimental) console.log(`⚠ STT provider "${id}" is EXPERIMENTAL (never tested live).`);
}

/** Both channels open in parallel; neither rejection is allowed to leave the other dangling (allSettled), and only a permanent error is fatal. */
export async function openBothChannels() {
  const opened = await Promise.allSettled([openChannel(chans.me, "me"), openChannel(chans.them, "them")]);
  const failed = opened.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (failed) throw failed.reason;
}

/** STT events -> transcript handling, health bars and the retry loops. */
export function wireChannels() {
  for (const s of [chans.me, chans.them]) {
    const ch = s === chans.me ? "me" : "them";
    s.on(
      "result",
      safe(`stt result ${ch}`, (r: SttResult) => {
        const rs = phone && ch === "me" ? phone.route(r) : [r];
        // STT lag is measured on the whole result (a split run ends earlier than the result arrives, which is not STT lag).
        if (rs.some((x) => x.channel === "them") && r.isFinal && r.speechFinal && r.speechEndWall) sup.recordSttLag(r.arrivedAt - r.speechEndWall);
        for (const x of rs) onResult(x);
        if (phone && ch === "me" && r.isFinal && r.speechFinal) log.write("events", { type: "phone.voices", ...phone.summary() });
      }),
    );
    s.on(
      "stt_error",
      safe(`stt_error ${ch}`, (e: ProviderError) => {
        console.error("stt error", ch, errBrief(e));
        log.write("events", { type: "stt.error", ch, kind: e.kind, error: eventError(e) });
      }),
    );
    s.on(
      "keyterms_off",
      safe("keyterms_off", () => {
        console.log("keyterms off for this provider (open was rejected with them)");
        log.write("events", { type: "stt.keyterms_off", ch });
      }),
    );
    s.on(
      "disconnected",
      safe(`disconnected ${ch}`, (d: { code?: number; reason?: string }) =>
        health(`stt-${ch}`, "red", ht(UI_LANG, "stt.disconnected", { ch: chHe(ch) }), JSON.stringify({ code: d.code, reason: d.reason })),
      ),
    );
    s.on(
      "reconnected",
      safe(`reconnected ${ch}`, () => {
        rebaseSpeakers(ch, "reconnect");
        healthClear(`stt-${ch}`);
        if (ch === "them") sup.set({ themSttDown: false });
        log.write("events", { type: "stt.reconnected", ch });
      }),
    );
    s.on(
      "switched",
      safe(`switched ${ch}`, (d: { from: string; to: string; kind: string; reason: string }) => {
        sttSwitchedCh.add(ch);
        rebaseSpeakers(ch, "provider switch");
        healthClear(`stt-${ch}`);
        if (ch === "them") sup.set({ themSttDown: false });
        log.write("events", { type: "stt.switch", ch, ...d });
        health(`stt-switch-${ch}`, "amber", ht(UI_LANG, "stt.switched", { ch: chHe(ch), from: d.from, to: d.to }), d.reason);
        tickHealth();
      }),
    );
    s.on(
      "failback",
      safe(`failback ${ch}`, (d: { from: string; to: string }) => {
        sttSwitchedCh.delete(ch);
        rebaseSpeakers(ch, "failback");
        healthClear(`stt-switch-${ch}`);
        log.write("events", { type: "stt.failback", ch, ...d });
        tickHealth();
      }),
    );
    s.on(
      "exhausted",
      safe(`exhausted ${ch}`, (e: ProviderError) => {
        log.write("events", { type: "stt.exhausted", ch, kind: e.kind, retryable: e.retryable });
        // Auth / quota / spend cap will not fix themselves: permanent red bar, the other side drops to transcript-only (rung 4), reopen retried every 30 s.
        // Anything else (wifi drop, 5xx, rate limit, unknown) is retried with backoff 1, 2, 4, 8, 10 s.
        if (isPermanentSttError(e)) {
          sttMarkPermanent(ch, e);
          void sttRetryLoop(s as SttChannel, ch, true);
          return;
        }
        health(`stt-${ch}`, "red", ht(UI_LANG, "stt.noconn", { ch: chHe(ch), err: describe(e) }));
        void sttRetryLoop(s as SttChannel, ch);
      }),
    );
  }
}
