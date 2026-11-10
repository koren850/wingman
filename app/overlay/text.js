"use strict";
// Pure text helpers for the answer window page (classic script in the page, require() in tests).
// RTL/bidi: Hebrew text with Latin or number "islands" (brand names, dates) is split into segments so the page can isolate each island and keep its order.
(function (root) {
  const bidi = typeof module !== "undefined" && module.exports ? require("../dashboard/bidi.js") : root.WingmanBidi;

  /** The shared bidi tokenizer: a short number or word next to an island ("8 Nov", "Node 18", "Facebook Ads") joins it, so word order never flips. */
  function segments(text) {
    return bidi.splitBidi(text);
  }

  /** True for a line with Latin letters and no Hebrew: it is shown left to right as a whole (an English interview card). */
  function isLatin(text) {
    const t = String(text ?? "");
    return /[A-Za-z]/.test(t) && !/[\u0590-\u05FF]/.test(t);
  }

  const S = typeof module !== "undefined" && module.exports ? require("./strings.js") : root.WingmanStrings;
  const HEB = /[\u0590-\u05FF]/; // allow-listed Hebrew: the engine writes its health texts in Hebrew
  const num = (raw) => (/\d+/.exec(raw) || ["?"])[0];
  /** English wording for the engine's Hebrew health texts (the engine is not translated). Keyed by the health id without "health-"; null = no entry. */
  function englishHealth(key, raw) {
    const n = num(raw);
    if (/^stt-switch-/.test(key)) {
      const m = /מ-(\S+) ל-(\S+)/.exec(raw);
      return m ? `Transcription switched from ${m[1]} to ${m[2]}` : "Transcription switched to another provider";
    }
    if (/^stt-(me|them)$/.test(key)) {
      const who = S.t("en", "health.who." + key);
      if (/מתחבר/.test(raw)) return "Connecting to the transcription service…";
      if (/התנתק/.test(raw)) return `${who}: transcription disconnected, reconnecting` + S.t("en", "health.checkNet");
      if (/אין חיבור/.test(raw)) return `${who}: transcription has no connection, retrying until it returns` + S.t("en", "health.checkNet");
      return `${who}: transcription error. Check the key and credit in Settings, retrying`;
    }
    if (/^ai(-|$)/.test(key))
      return key === "ai"
        ? "AI is not responding: only prepared cards are shown. Check your internet connection and the key in Settings."
        : "AI error. Check the key and credit in Settings.";
    switch (key) {
      case "disk":
        return "Cannot save the call to disk (no space?). The call continues, but the recording and summary may be incomplete. Free up disk space.";
      case "control":
        return `The Wingman menu app was closed. The call continues and will stop by itself after ${n} minutes without speech.`;
      case "sleep":
        return `The computer slept for ${n} seconds. Part of the call was not heard. If you missed something, ask them to repeat it.`;
      case "idle":
        return `Nobody has spoken for ${n} minutes. The call will stop by itself in about 2 minutes.`;
      case "minutes":
        return `The call has been running ${n} minutes. If it is over, click Stop call.`;
      case "mic":
        return /הרשאת/.test(raw)
          ? "The microphone is not picking up sound. Check microphone permission and selection in Settings, then run the readiness check."
          : "I have not heard you for a few minutes. If you spoke, check the microphone.";
      case "them-silent":
        return "No audio from the other side (the system audio channel sends nothing). Cards about what you say still work. Check that the call audio is on and the volume is up.";
      default:
        return null;
    }
  }

  /** Fault / advisory text for the window in the UI language, with a next step when the engine text has none. English: the engine's Hebrew texts are replaced by a known English wording (unknown ids keep the engine text). */
  function healthText(id, text, askKey, lang) {
    const raw = String(text ?? "");
    const L = S.normLang(lang);
    if (id === "health-only-you") return S.t(L, "health.onlyYou") + (askKey ? S.t(L, "health.askMe", { key: askKey }) : "");
    const key = String(id).replace(/^health-/, "");
    if (L === "en" && HEB.test(raw)) {
      const e = englishHealth(key, raw);
      if (e) return e;
    }
    const m = /^[A-Z][A-Za-z0-9 ()_.,/]*?\s[–-]\s(.+)$/.exec(raw); // "NOT HEARING THE OTHER SIDE – ...", "STT (them) – ...": drop the English tag
    let t = m ? m[1] : raw;
    if (S.STRINGS[L]["health.who." + key] && m) t = `${S.t(L, "health.who." + key)}: ${t}`;
    if (/^stt-(me|them)$/.test(key) && !/בדוק|מנסה|check|retry/i.test(t)) t += S.t(L, "health.checkNet");
    else if (/^stt-(me|them)$/.test(key) && /מנסה|retry/i.test(t) && !/בדוק|check/i.test(t)) t += S.t(L, "health.checkNetShort");
    return t;
  }

  /** Worst state of the health bars for the status dot: "red" (not working), "amber" (degraded), else "ok". Info bars and the quiet bar do not count. */
  function healthLevel(bars) {
    let level = "ok";
    for (const [id, h] of bars) {
      if (id === "health-quiet" || !h) continue;
      if (h.level === "red") return "red";
      if (h.level === "amber") level = "amber";
    }
    return level;
  }

  /**
   * Is an AI answer card still "writing"? Yes while its text changed in the last 0.8 s, or (for 2.5 s after it first shows) when it stops mid-sentence.
   * Once the engine says the stream is done, never: a finished answer without a final full stop is not unfinished.
   * c = { ai, done, updated, age (ms since the text last changed), text }
   */
  function isWriting(c) {
    if (!c.ai || c.done) return false;
    return (c.updated && c.age < 800) || (c.age < 2500 && !/[.!?…:;)"\u201d\u05f4]$/.test(String(c.text || "").trim()));
  }

  /**
   * The text split after each sentence end (. ! ? … or the Hebrew punctuation mark), spaces kept at the join.
   * A full stop inside a number ("3.9") or between letters ("e.g.x") is not an end: it needs a space or the end of the text after it.
   */
  function sentences(text) {
    const t = String(text ?? "").trim();
    if (!t) return [];
    return t
      .match(/.+?(?:[.!?…\u05c3]+["'\u201d)]*(?=\s|$)|$)/gsu)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  /**
   * The longest run of whole sentences from the start of the text that passes fits(candidate). "" when not even the first sentence fits.
   * Used for a collapsed card: it ends at a sentence end, never mid-sentence.
   */
  function sentencePrefix(text, fits) {
    const parts = sentences(text);
    for (let n = parts.length - 1; n >= 1; n--) {
      const cand = parts.slice(0, n).join(" ");
      if (fits(cand)) return cand;
    }
    return "";
  }

  const api = { segments, healthText, isLatin, healthLevel, isWriting, sentences, sentencePrefix };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanText = api;
})(typeof window !== "undefined" ? window : globalThis);
