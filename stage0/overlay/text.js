"use strict";
// Pure text helpers for the answer window page (classic script in the page, require() in tests).
// RTL/bidi: Hebrew text with Latin or number "islands" (brand names, dates) is split into segments so the page can isolate each island and keep its order.
(function (root) {
  const bidi = typeof module !== "undefined" && module.exports ? require("../dashboard/bidi.js") : root.WingmanBidi;
  const SHORT = /^[A-Za-z0-9]{1,2}$/;

  /** Shared bidi tokenizer plus the overlay rule: a short number or word next to an island ("8 Nov", "Node 18", "Facebook Ads") joins it, so word order never flips. */
  function segments(text) {
    const out = [];
    for (const seg of bidi.splitBidi(text)) out.push({ ...seg });
    // pull a short Latin/number token (e.g. "8 ") from the neutral text into the island next to it
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      if (s.ltr) continue;
      const before = out[i - 1], after = out[i + 1];
      if (after && after.ltr) { const m = /(?:^|[\s(])([A-Za-z0-9]{1,2}) $/.exec(s.text); if (m) { const cut = s.text.length - m[1].length - 1; after.text = m[1] + " " + after.text; s.text = s.text.slice(0, cut); } }
      if (before && before.ltr) { const m = /^ ([A-Za-z0-9]{1,2})(?=$|[\s).,:;!?])/.exec(s.text); if (m) { before.text += " " + m[1]; s.text = s.text.slice(m[0].length); } }
    }
    // two islands separated by a single space are one island
    const merged = [];
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      if (s.text === "") continue;
      const last = merged[merged.length - 1];
      if (last && last.ltr && s.ltr) { last.text += s.text; continue; }
      if (s.ltr === false && s.text === " " && last && last.ltr && out[i + 1] && out[i + 1].ltr) { last.text += " " + out[i + 1].text; i++; continue; }
      merged.push(s);
    }
    return merged;
  }

  /** True for a line with Latin letters and no Hebrew: it is shown left to right as a whole (an English interview card). */
  function isLatin(text) { const t = String(text ?? ""); return /[A-Za-z]/.test(t) && !/[\u0590-\u05FF]/.test(t); }

  const S = typeof module !== "undefined" && module.exports ? require("./strings.js") : root.WingmanStrings;
  const HEB = /[\u0590-\u05FF]/;   // allow-listed Hebrew: the engine writes its health texts in Hebrew
  const num = (raw) => (/\d+/.exec(raw) || ["?"])[0];
  /** English wording for the engine's Hebrew health texts (the engine is not translated). Keyed by the health id without "health-"; null = no entry. */
  function englishHealth(key, raw) {
    const n = num(raw);
    if (/^stt-switch-/.test(key)) { const m = /מ-(\S+) ל-(\S+)/.exec(raw); return m ? `Transcription switched from ${m[1]} to ${m[2]}` : "Transcription switched to another provider"; }
    if (/^stt-(me|them)$/.test(key)) {
      const who = S.t("en", "health.who." + key);
      if (/מתחבר/.test(raw)) return "Connecting to the transcription service…";
      if (/התנתק/.test(raw)) return `${who}: transcription disconnected, reconnecting` + S.t("en", "health.checkNet");
      if (/אין חיבור/.test(raw)) return `${who}: transcription has no connection, retrying until it returns` + S.t("en", "health.checkNet");
      return `${who}: transcription error. Check the key and credit in Settings, retrying`;
    }
    if (/^ai(-|$)/.test(key)) return key === "ai" ? "AI is not responding: only prepared cards are shown. Check your internet connection and the key in Settings." : "AI error. Check the key and credit in Settings.";
    switch (key) {
      case "disk": return "Cannot save the call to disk (no space?). The call continues, but the recording and summary may be incomplete. Free up disk space.";
      case "control": return `The Wingman menu app was closed. The call continues and will stop by itself after ${n} minutes without speech.`;
      case "sleep": return `The computer slept for ${n} seconds. Part of the call was not heard. If you missed something, ask them to repeat it.`;
      case "idle": return `Nobody has spoken for ${n} minutes. The call will stop by itself in about 2 minutes.`;
      case "minutes": return `The call has been running ${n} minutes. If it is over, click Stop call.`;
      case "mic": return /הרשאת/.test(raw) ? "The microphone is not picking up sound. Check microphone permission and selection in Settings, then run the readiness check." : "I have not heard you for a few minutes. If you spoke, check the microphone.";
      case "them-silent": return "No audio from the other side (the system audio channel sends nothing). Answers for you still work. Check that the call audio is on and the volume is up.";
      default: return null;
    }
  }

  /** Fault / advisory text for the window in the UI language, with a next step when the engine text has none. English: the engine's Hebrew texts are replaced by a known English wording (unknown ids keep the engine text). */
  function healthText(id, text, askKey, lang) {
    const raw = String(text ?? "");
    const L = S.normLang(lang);
    if (id === "health-only-you") return S.t(L, "health.onlyYou") + (askKey ? S.t(L, "health.askMe", { key: askKey }) : "");
    const key = String(id).replace(/^health-/, "");
    if (L === "en" && HEB.test(raw)) { const e = englishHealth(key, raw); if (e) return e; }
    const m = /^[A-Z][A-Za-z0-9 ()_.,\/]*?\s[–-]\s(.+)$/.exec(raw);   // "NOT HEARING THE OTHER SIDE – ...", "STT (them) – ...": drop the English tag
    let t = m ? m[1] : raw;
    if (S.STRINGS[L]["health.who." + key] && m) t = `${S.t(L, "health.who." + key)}: ${t}`;
    if (/^stt-(me|them)$/.test(key) && !/בדוק|מנסה/.test(t)) t += S.t(L, "health.checkNet");
    else if (/^stt-(me|them)$/.test(key) && /מנסה/.test(t) && !/בדוק/.test(t)) t += S.t(L, "health.checkNetShort");
    return t;
  }

  const api = { segments, healthText, isLatin };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.WingmanText = api;
})(typeof window !== "undefined" ? window : globalThis);
