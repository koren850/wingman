"use strict";
// Guided setup (Home) and "About you" (Settings). Loaded after settings.js; shares its globals ($, h, btn, chip, ico, api, state, H, KEYS, keyRow...).
// Short steps, each skippable and re-openable (Settings → Setup guide). Everything the page does goes through the fixed commands in preload.cjs;
// a typed key is handled by keyRow (settings.js, write-only). Which steps were skipped or confirmed is a per-viewer convenience kept in localStorage (it may be unavailable).

const SU = { status: null, profile: null, mics: null, draft: null, open: "auto", force: false, busy: new Set(), msg: {}, skipped: {}, acks: {} };
const SU_KEY = "wingman.setup.v1";
try {
  const s = JSON.parse(localStorage.getItem(SU_KEY) || "{}");
  SU.skipped = s.skipped || {};
  SU.acks = s.acks || {};
} catch {
  /* storage unavailable: steps just start open again */
}
function suSave() {
  try {
    localStorage.setItem(SU_KEY, JSON.stringify({ skipped: SU.skipped, acks: SU.acks }));
  } catch {
    /* ignore */
  }
}
const suRedraw = () => {
  if (state.view === "home") renderSide();
  else if (state.view === "settings") drawSettings();
};

/** Reads the profile and the setup facts (permission, screens, microphone setting, pack). Failures leave the old values. */
async function loadSetup() {
  const [p, s] = await Promise.all([api.profileGet().catch(() => null), api.setupStatus().catch(() => null)]);
  if (p && p.ok) {
    SU.profile = p.profile;
    if (!SU.draft) SU.draft = { ...p.profile, spellings: p.profile.spellings.join(", ") };
  }
  if (s && s.ok) SU.status = s;
  if (!KEYS.data && H.keys) KEYS.data = H.keys;
}
/** Run an action with a busy flag and a message line (SU.msg[id] = { ok, text }). */
async function suAct(id, fn, okText) {
  if (SU.busy.has(id)) return;
  SU.busy.add(id);
  SU.msg[id] = null;
  suRedraw();
  let r;
  try {
    r = await fn();
  } catch (e) {
    r = { ok: false, error: "Could not reach the app." };
  }
  SU.busy.delete(id);
  const text =
    r && r.ok !== false
      ? typeof okText === "function"
        ? okText(r)
        : okText
      : r && r.error === "preview"
        ? "This is a preview, nothing was changed."
        : (r && (r.message || r.error)) || "That did not work. Check the details and try again.";
  SU.msg[id] = { ok: !!(r && r.ok !== false), text };
  (SU.msg[id].ok ? announce : fail)(text);
  suRedraw();
  return r;
}
const suMsg = (id) => {
  const m = SU.msg[id];
  return m ? h("p", { class: m.ok ? "saved good" : "errline", role: m.ok ? "status" : "alert" }, m.text) : null;
};

/* ---------- About you (shared by the setup step and Settings) ---------- */
const ADDRESS_LABELS = [
  ["male", "Male (אתה)"],
  ["female", "Female (את)"],
  ["neutral", "Neutral: avoid gendered forms"],
];
const suDraftToProfile = (d) => ({
  name: d.name,
  spellings: String(d.spellings)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  address: d.address,
  about: d.about,
  business: d.business,
});
function aboutForm(idp) {
  const d = SU.draft || (SU.draft = { name: "", spellings: "", address: "neutral", about: "", business: "" });
  const bind = (el, k) => {
    el.addEventListener("input", () => {
      d[k] = el.value;
    });
    return el;
  };
  const f = (id, label, help, el) =>
    h("div", { class: "field" }, h("label", { for: id }, label), el, help ? h("p", { class: "help", id: id + "-h" }, help) : null);
  const name = bind(
    h("input", {
      type: "text",
      id: idp + "-name",
      maxlength: "60",
      autocomplete: "off",
      value: d.name,
      placeholder: "Your first name",
      "aria-describedby": idp + "-name-h",
    }),
    "name",
  );
  const sp = bind(
    h("input", {
      type: "text",
      id: idp + "-spellings",
      autocomplete: "off",
      value: d.spellings,
      placeholder: "e.g. the name in Hebrew letters, a nickname",
      "aria-describedby": idp + "-spellings-h",
    }),
    "spellings",
  );
  const addr = h(
    "select",
    { id: idp + "-address", "aria-describedby": idp + "-address-h" },
    ADDRESS_LABELS.map(([v, t]) => h("option", { value: v, selected: v === d.address }, t)),
  );
  addr.addEventListener("change", () => {
    d.address = addr.value;
  });
  const about = bind(
    h("textarea", {
      id: idp + "-about",
      maxlength: "1500",
      rows: "3",
      placeholder: "Who you are and what you do, in a sentence or two",
      "aria-describedby": idp + "-about-h",
    }),
    "about",
  );
  about.value = d.about;
  const biz = bind(
    h("textarea", {
      id: idp + "-business",
      maxlength: "1500",
      rows: "3",
      placeholder: "Your business, if you have one: what you sell, who your clients are",
      "aria-describedby": idp + "-business-h",
    }),
    "business",
  );
  biz.value = d.business;
  const form = h(
    "form",
    { class: "su-form", id: idp + "-form", novalidate: true },
    f(idp + "-name", "Name", "Wingman listens for it, to know when someone turns to you.", name),
    f(idp + "-spellings", "Other spellings (comma separated)", "How the speech service may write your name, for example in Hebrew letters.", sp),
    f(idp + "-address", "How to address you in Hebrew", "Wingman writes cards to you in this form.", addr),
    f(idp + "-about", "About you", "Free text. It goes into the AI's instructions.", about),
    f(idp + "-business", "Your business", "Optional. Makes client and support calls make sense.", biz),
    h(
      "div",
      { class: "actions" },
      h("button", { type: "submit", class: "btn primary", id: idp + "-save", disabled: SU.busy.has("about") }, ico("check"), h("span", {}, "Save")),
      h("span", { class: "sub" }, "Saved on this Mac only. Applies to the next call."),
    ),
    suMsg("about"),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await suAct("about", () => api.profileSet(suDraftToProfile(d)), "Saved. Applies to the next call.");
    if (r && r.ok) {
      SU.profile = r.profile;
      SU.draft = { ...r.profile, spellings: r.profile.spellings.join(", ") };
      suRedraw();
    }
  });
  return form;
}
/** Settings section "About you". */
function aboutBlock() {
  return h(
    "section",
    { class: "setgroup", "aria-labelledby": "g-about" },
    h("h2", { id: "g-about", class: "label", tabindex: "-1" }, "About you"),
    h("div", { class: "setlist" }, h("div", { class: "su-settings-form" }, SU.profile ? aboutForm("ab") : h("div", { class: "loading" }, "Loading…"))),
  );
}
/** Settings section "Setup guide": opens the guided setup on Home again. */
function setupGuideBlock() {
  return h(
    "section",
    { class: "setgroup", "aria-labelledby": "g-setup" },
    h("h2", { id: "g-setup", class: "label", tabindex: "-1" }, "Setup guide"),
    h(
      "div",
      { class: "setlist" },
      h(
        "div",
        { class: "keyfile" },
        h("p", { class: "help" }, "Keys, your name, permissions, microphone, screens and the answer pack, step by step. Steps you skipped come back."),
        h(
          "div",
          { class: "actions" },
          btn("Open the setup guide", {
            id: "open-setup",
            icon: "play",
            cls: "sm",
            onclick: () => {
              SU.force = true;
              SU.skipped = {};
              SU.open = "auto";
              suSave();
              viewHome();
            },
          }),
        ),
      ),
    ),
  );
}

/* ---------- steps ---------- */
const fmtMic = (v) => (v === ":default" ? "System default" : v);
function micChip() {
  const m = SU.status && SU.status.mic;
  return m === "granted"
    ? chip("Allowed", "good", { dot: true })
    : m === "denied" || m === "restricted"
      ? chip("Blocked", "bad", { dot: true })
      : m === "not-determined"
        ? chip("Not asked yet", "warn", { dot: true })
        : chip("Unknown", "", { dot: true });
}
const linkBtn = (which, label) => btn(label, { cls: "sm ghost", icon: "jump", onclick: () => api.setupOpenLink(which).catch(() => {}) });

/** "Try a practice call first": a pretend caller, offline and free. It needs no key, so it sits at the top of the first step. */
function practiceFirst() {
  return h(
    "div",
    { class: "su-row", id: "su-practice-first" },
    h(
      "div",
      { class: "grow" },
      h("div", { class: "st-t" }, "Try a practice call first (free, no keys)"),
      h(
        "div",
        { class: "faint st-w" },
        "A pretend caller talks to Wingman. It runs on your Mac only: nothing is sent anywhere and nothing is charged. Real calls need the keys below.",
      ),
    ),
    btn("Start practice call", {
      id: "su-practice-now",
      icon: "play",
      cls: "sm primary",
      onclick: () => act(() => api.practice({ quick: true }), "Practice call"),
    }),
  );
}

/** Responsible-use notice (first step). Informational: acknowledging it is remembered like the other setup flags and never blocks listening. */
function consentNotice() {
  return h(
    "div",
    { class: "su-row", id: "su-consent" },
    h(
      "div",
      { class: "grow" },
      h("div", { class: "st-t" }, "Responsible use"),
      h("div", { class: "faint st-w" }, "Tell the other people on the call that you use a live assistant, and follow your local recording-consent laws."),
    ),
    SU.acks.consent
      ? chip("You said you understand", "good", { dot: true })
      : btn("I understand", {
          id: "su-consent-ok",
          cls: "sm ghost",
          icon: "check",
          onclick: () => {
            SU.acks.consent = true;
            suSave();
            suRedraw();
          },
        }),
  );
}

/** The privacy choice: two switches, saved at once to your settings. The defaults stay until the user changes them. */
function privacyPanel() {
  const st = SU.status;
  if (!st) return h("div", { class: "loading" }, "Loading…");
  const sw = (id, key, on, label, text, note) => {
    const busy = SU.busy.has(id);
    return h(
      "div",
      { class: "su-row", id: "su-row-" + id },
      h(
        "div",
        { class: "grow" },
        h("div", { class: "st-t" }, label),
        h("div", { class: "faint st-w" }, text),
        note ? h("div", { class: "faint st-w" }, note) : null,
      ),
      h(
        "button",
        {
          type: "button",
          id: "su-" + id,
          class: "switch",
          role: "switch",
          "aria-checked": on ? "true" : "false",
          "aria-label": label,
          disabled: busy,
          onclick: () => suAct(id, () => api.setSetting(key, !on), "Saved. Applies to the next call.").then(() => loadSetup().then(suRedraw)),
        },
        h("span", { class: "knob", "aria-hidden": "true" }),
        h("span", { class: "sl" }, on ? "On" : "Off"),
      ),
    );
  };
  return h(
    "div",
    { class: "su-body" },
    h(
      "p",
      { class: "help" },
      "Wingman sends the call audio to Deepgram to turn it into text. It sends the text to Anthropic for the AI answers. Audio is never saved on your Mac. You decide two things:",
    ),
    sw(
      "consent",
      "privacy.requireConsentAck",
      st.requireConsent,
      "Ask me before listening starts",
      "On: every call waits until you press Start listening, so no audio leaves your Mac before that. Off: listening starts together with the call.",
    ),
    suMsg("consent"),
    sw(
      "mip",
      "stt.deepgram.mipOptOut",
      st.mipOptOut,
      "Keep my audio out of Deepgram's model training",
      "On: Deepgram is asked not to use your audio to improve its models. Off: it may.",
      "Cost note: Deepgram does not publish a price for opting out, and some users report a higher rate. Check your Deepgram bill after the first calls.",
    ),
    suMsg("mip"),
    h(
      "div",
      { class: "actions" },
      btn("Done, keep these choices", {
        id: "su-privacy-ok",
        cls: "sm primary",
        icon: "check",
        onclick: () => {
          SU.acks.privacy = true;
          suSave();
          suRedraw();
        },
      }),
      h("span", { class: "sub" }, "You can change both later in Settings."),
    ),
  );
}

const STEPS = [
  {
    id: "keys",
    title: "Add your keys",
    why: () =>
      keysMissing().length
        ? `Missing: ${keysMissing().join(" and ")}. Deepgram hears the call, Anthropic writes the AI answers.`
        : "Both keys are saved in the Keychain.",
    done: () => !!H.keys && !keysMissing().length,
    panel: () =>
      h(
        "div",
        { class: "su-body" },
        practiceFirst(),
        h(
          "p",
          { class: "help" },
          "For real calls you need two keys, both from paid services. Paste each one and press Save, then Test. Typical cost: about one dollar per hour of call for Deepgram (speech to text) plus roughly 5 to 20 cents an hour for Anthropic (the AI). New Deepgram accounts get free credit.",
        ),
        h("div", { class: "actions" }, linkBtn("deepgram", "Get a Deepgram key"), linkBtn("anthropic", "Get an Anthropic key")),
        h("div", { class: "setlist su-keys" }, keyRow("deepgram"), keyRow("anthropic")),
        consentNotice(),
      ),
  },
  {
    id: "privacy",
    title: "Your privacy",
    why: () => (SU.acks.privacy ? "Your choice is saved." : "Two choices about listening and your audio."),
    done: () => !!SU.acks.privacy,
    panel: () => privacyPanel(),
  },
  {
    id: "about",
    title: "About you",
    why: () =>
      SU.profile && SU.profile.name ? `Hello ${SU.profile.name}.` : "Your name and how to address you. Used in the AI's instructions, so cards fit you.",
    done: () => !!(SU.profile && SU.profile.name),
    panel: () => (SU.profile ? aboutForm("su") : h("div", { class: "loading" }, "Loading…")),
  },
  {
    id: "perms",
    title: "Permissions",
    why: () => "Microphone for your voice, System Audio Recording for the other side. macOS asks once.",
    done: () => !!(SU.status && SU.status.mic === "granted" && SU.acks.audio),
    panel: () => {
      const s = SU.status,
        m = s && s.mic;
      return h(
        "div",
        { class: "su-body" },
        h(
          "div",
          { class: "su-row" },
          h("div", { class: "grow" }, h("div", { class: "st-t" }, "Microphone"), h("div", { class: "faint st-w" }, "Lets Wingman hear you.")),
          micChip(),
          m === "granted"
            ? null
            : btn(m === "not-determined" ? "Allow microphone" : "Open Microphone settings", {
                id: "su-mic",
                cls: "sm",
                icon: "mic",
                disabled: SU.busy.has("mic"),
                onclick: () =>
                  suAct(
                    "mic",
                    async () => (m === "not-determined" ? api.setupAskMic() : api.setupOpenPrivacy("mic")),
                    (r) => (r && r.granted ? "Microphone allowed." : "Opened. Switch Wingman on, then press Check again."),
                  ).then(() => loadSetup().then(suRedraw)),
              }),
          btn("Check again", { cls: "sm ghost", icon: "refresh", onclick: () => loadSetup().then(suRedraw) }),
        ),
        suMsg("mic"),
        h(
          "div",
          { class: "su-row" },
          h(
            "div",
            { class: "grow" },
            h("div", { class: "st-t" }, "System Audio Recording"),
            h(
              "div",
              { class: "faint st-w" },
              "Lets Wingman hear the other side of the call. macOS does not tell apps whether this is on, so the readiness check tests it for real.",
            ),
          ),
          SU.acks.audio ? chip("You said it is on", "good", { dot: true }) : null,
          btn("Open System Audio Recording settings", {
            id: "su-audio",
            cls: "sm",
            icon: "jump",
            onclick: () => api.setupOpenPrivacy("audio").catch(() => {}),
          }),
          SU.acks.audio
            ? null
            : btn("I allowed it", {
                id: "su-audio-ok",
                cls: "sm ghost",
                icon: "check",
                onclick: () => {
                  SU.acks.audio = true;
                  suSave();
                  suRedraw();
                },
              }),
        ),
        h(
          "p",
          { class: "su-note" },
          ico("warning"),
          h(
            "span",
            {},
            "After you allow either permission, quit Wingman (menu bar icon, Quit Wingman) and open it again. macOS only applies it to a new start.",
          ),
        ),
      );
    },
  },
  {
    id: "mic",
    title: "Microphone",
    why: () => (SU.status ? `Now: ${fmtMic(SU.status.micDevice)}.` : "Which microphone Wingman listens to."),
    done: () => !!(SU.acks.mic || (SU.status && SU.status.micDevice !== ":default")),
    panel: () => micPanel(),
  },
  {
    id: "screen",
    title: "Your screens",
    why: () => (SU.status ? (SU.status.displays >= 2 ? `${SU.status.displays} screens found.` : "Only one screen found.") : "Where the answer window shows."),
    done: () => !!(SU.status && (SU.status.displays >= 2 || SU.status.allowPrimary || SU.acks.screen)),
    panel: () => screenPanel(),
  },
  {
    id: "pack",
    title: "Answer pack",
    why: () =>
      SU.status
        ? SU.status.pack.using === "user"
          ? "Your own pack is in use."
          : "The example pack is in use (invented web and hosting answers)."
        : "The answers Wingman prepares from.",
    done: () => !!(SU.status && (SU.status.pack.using === "user" || SU.acks.pack)),
    panel: () => packPanel(),
  },
];

/** The microphone list (SU.mics), fetched once. Returns it, or null while it loads (then the page redraws). */
function ensureMics() {
  if (SU.mics) return SU.mics;
  if (!SU.busy.has("mics")) {
    SU.busy.add("mics");
    api
      .setupMics()
      .then((r) => {
        SU.mics = r && r.ok ? r : { devices: [], defaultInput: "" };
      })
      .catch(() => {
        SU.mics = { devices: [], defaultInput: "" };
      })
      .finally(() => {
        SU.busy.delete("mics");
        suRedraw();
      });
  }
  return null;
}
function micPanel() {
  const s = SU.status;
  if (!ensureMics()) return h("div", { class: "loading" }, "Looking for microphones…");
  const cur = s ? s.micDevice : ":default";
  const sel = h(
    "select",
    { id: "su-micsel", "aria-label": "Microphone" },
    h("option", { value: ":default", selected: cur === ":default" }, "System default" + (SU.mics.defaultInput ? ` (${SU.mics.defaultInput})` : "")),
    SU.mics.devices.map((d) => h("option", { value: ":" + d.index, selected: cur === ":" + d.index }, d.name)),
  );
  const odd = cur !== ":default" && !/^:\d{1,2}$/.test(cur);
  return h(
    "div",
    { class: "su-body" },
    h(
      "p",
      { class: "help" },
      "The microphone Wingman listens to for your voice. Avoid AirPods or other Bluetooth headsets for the first calls: macOS drops the sound quality when they act as a microphone.",
    ),
    odd ? h("p", { class: "help" }, `Your settings use a custom device (${cur}). Choosing below replaces it.`) : null,
    h(
      "div",
      { class: "keyedit su-mic" },
      sel,
      btn("Save", {
        id: "su-micsave",
        cls: "sm primary",
        disabled: SU.busy.has("setmic"),
        onclick: () =>
          suAct("setmic", () => api.setupSetMic(sel.value), "Saved. Applies to the next call.").then((r) => {
            if (r && r.ok) {
              SU.acks.mic = true;
              suSave();
              loadSetup().then(suRedraw);
            }
          }),
      }),
      btn("Keep the default", {
        cls: "sm ghost",
        onclick: () => {
          SU.acks.mic = true;
          suSave();
          suRedraw();
        },
      }),
      btn("Look again", {
        cls: "sm ghost",
        icon: "refresh",
        onclick: () => {
          SU.mics = null;
          suRedraw();
        },
      }),
    ),
    suMsg("setmic"),
  );
}
function screenPanel() {
  const s = SU.status;
  if (!s) return h("div", { class: "loading" }, "Loading…");
  if (s.displays >= 2)
    return h(
      "div",
      { class: "su-body" },
      h(
        "p",
        { class: "help" },
        `${s.displays} screens found. The answer window opens on the second one. When you share your screen in a call, share the other screen (or one window), never the one with the answers.`,
      ),
    );
  return h(
    "div",
    { class: "su-body" },
    h(
      "p",
      { class: "help" },
      "Wingman shows its answers in a small window on a second screen, so they are never in your screen share. You have one screen, so by default the answer window stays closed. The call still works and every card is saved in the Wingman window.",
    ),
    s.allowPrimary
      ? h(
          "p",
          { class: "su-note" },
          ico("warning"),
          h("span", {}, h("b", {}, "The answer window is allowed on this screen. "), "Do not share this screen in a call. Share a single window instead."),
        )
      : null,
    h(
      "div",
      { class: "actions" },
      s.allowPrimary
        ? btn("Turn it off again", {
            id: "su-oneoff",
            cls: "sm",
            onclick: () =>
              suAct("onescreen", () => api.setupSetOneScreen(false), "Off. The answer window stays closed with one screen.").then(() =>
                loadSetup().then(suRedraw),
              ),
          })
        : btn("Allow the answer window on this screen", {
            id: "su-oneon",
            cls: "sm",
            onclick: () => suAct("onescreen", () => api.setupSetOneScreen(true), "On. Do not share this screen.").then(() => loadSetup().then(suRedraw)),
          }),
      btn("Keep it closed", {
        cls: "sm ghost",
        onclick: () => {
          SU.acks.screen = true;
          suSave();
          suRedraw();
        },
      }),
    ),
    suMsg("onescreen"),
  );
}
function packPanel() {
  const s = SU.status;
  if (!s) return h("div", { class: "loading" }, "Loading…");
  const p = s.pack;
  return h(
    "div",
    { class: "su-body" },
    h(
      "p",
      { class: "help" },
      p.using === "user"
        ? `Wingman answers from your own pack (${p.userFiles.join(", ")}) in ${p.userDir}.`
        : "Wingman answers from the example pack that comes with it: an invented web and hosting business. It works for a try-out. To make it yours, copy it to your own folder and edit the files there.",
    ),
    h(
      "div",
      { class: "actions" },
      p.canCopy
        ? btn("Copy the example pack to my folder", {
            id: "su-copypack",
            cls: "sm",
            icon: "folder",
            disabled: SU.busy.has("pack"),
            onclick: () =>
              suAct(
                "pack",
                () => api.setupCopyPack(),
                (r) => `Copied ${r.copied.length} files to ${r.dir}. Edit them there; changes apply to the next call.`,
              ).then(() => loadSetup().then(suRedraw)),
          })
        : null,
      p.using === "user" ? btn("Show my pack folder", { cls: "sm", icon: "folder", onclick: () => api.setupRevealPack().catch(() => {}) }) : null,
      p.using === "user"
        ? null
        : btn("Keep the example for now", {
            cls: "sm ghost",
            onclick: () => {
              SU.acks.pack = true;
              suSave();
              suRedraw();
            },
          }),
    ),
    suMsg("pack"),
  );
}

/** The guided setup card for Home. Null when nothing is left to do (unless the user opened it from Settings). */
function setupCard() {
  if (isRunning()) return null;
  const d = doc(),
    practiced = state.calls.some((c) => c.mode !== "live" && !c.crashed);
  const fullOk = !!(d && d.ok && d.at !== H.quickAt);
  const steps = [
    ...STEPS,
    {
      id: "check",
      title: "Run the readiness check",
      why: () => "Tests the microphone, system audio, the speech service and the AI. About 20 seconds, a few cents.",
      done: () => fullOk,
      panel: () =>
        h(
          "div",
          { class: "su-body" },
          h(
            "div",
            { class: "actions" },
            btn("Run readiness check", { id: "setup-check", cls: "sm", icon: "mic", disabled: checking(), onclick: () => runCheck(false) }),
          ),
        ),
    },
    {
      id: "practice",
      title: "Try a practice call",
      why: () => "A pretend call through the real answer window. Free, offline.",
      done: () => practiced,
      panel: () =>
        h(
          "div",
          { class: "su-body" },
          h(
            "div",
            { class: "actions" },
            btn("Practice call", { id: "setup-practice", cls: "sm", icon: "play", onclick: () => act(api.practice, "Practice call") }),
          ),
        ),
    },
  ];
  const isDone = (s) => s.done(),
    isSkipped = (s) => !!SU.skipped[s.id];
  const open = steps.filter((s) => !isDone(s) && !isSkipped(s));
  const old = keysMissing().length > 0 || !d || (state.calls.length === 0 && !fullOk); // the earlier rule: keys missing, or never checked
  const loaded = !!(SU.status && SU.profile);
  if (!SU.force && !old && !(loaded && open.some((s) => s.id === "about"))) return null;
  const nDone = steps.filter(isDone).length;
  const auto = SU.open === "auto" ? (open[0] ? open[0].id : "") : SU.open;
  const toggle = (id) => {
    SU.open = auto === id ? "" : id;
    suRedraw();
  };
  const items = steps.map((s) => {
    const isOpen = auto === s.id,
      dn = isDone(s),
      sk = isSkipped(s) && !dn;
    const row = h(
      "div",
      { class: "su-head" },
      dn ? ico("check") : h("span", { class: "tick" }),
      h("div", { class: "grow" }, h("div", { class: "st-t" }, s.title), h("div", { class: "faint st-w" }, s.why())),
      sk ? chip("Skipped", "") : null,
      h(
        "button",
        {
          type: "button",
          class: "btn sm" + (dn || sk ? " ghost" : ""),
          id: "su-toggle-" + s.id,
          "aria-expanded": isOpen ? "true" : "false",
          "aria-controls": "su-panel-" + s.id,
          onclick: () => toggle(s.id),
        },
        h("span", {}, isOpen ? "Close" : dn ? "Edit" : "Open"),
      ),
    );
    const panel = isOpen
      ? h(
          "div",
          { class: "su-panel", id: "su-panel-" + s.id },
          s.panel(),
          dn
            ? null
            : h(
                "div",
                { class: "actions su-skip" },
                isSkipped(s)
                  ? btn("Do this step after all", {
                      cls: "sm ghost",
                      onclick: () => {
                        delete SU.skipped[s.id];
                        suSave();
                        suRedraw();
                      },
                    })
                  : btn("Skip this step", {
                      id: "su-skip-" + s.id,
                      cls: "sm ghost",
                      onclick: () => {
                        SU.skipped[s.id] = true;
                        SU.open = "auto";
                        suSave();
                        announce(s.title + " skipped. You can come back from Settings, Setup guide.");
                        suRedraw();
                      },
                    }),
              ),
        )
      : null;
    return h("li", { class: (dn ? "done " : "") + "has-panel" }, row, panel);
  });
  return h(
    "section",
    { class: "card-big setup", "aria-labelledby": "setup-h" },
    h(
      "div",
      { class: "rhead" },
      h("h2", { id: "setup-h" }, "Set up Wingman"),
      chip(`${nDone} of ${steps.length} done`, nDone === steps.length ? "good" : "warn"),
      h("span", { class: "grow" }),
      SU.force && !old && !open.length
        ? btn("Close", {
            id: "su-close",
            cls: "sm",
            onclick: () => {
              SU.force = false;
              suRedraw();
            },
          })
        : null,
    ),
    h("ul", { class: "setuplist" }, items),
  );
}
