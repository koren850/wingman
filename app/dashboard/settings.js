"use strict";
// Settings: about a dozen options that matter, in plain words, with real controls. Writes go through the main process,
// which validates with the same schema the call uses and edits ~/.config/wingman/settings.yaml without touching comments or other keys.
// Also the Keys section (write-only API key entry, see keys-ipc.cjs) and the read-only Advanced list. Loaded after home.js; viewSettings is called from boot.js.

// SET: settings state (data from main, in-flight keys, per-row errors, "Saved" timestamps). Rows are drawn from the catalog sent by main, not hard-coded.
const SET = { data: null, busy: new Set(), errors: {}, savedAt: {}, tuneOpen: false, advOpen: false };
// The few choices shown by default (catalog items marked main), in this order. The microphone row sits after the spend cap.
const MAIN_ORDER = [
  "stt.language",
  "privacy.requireConsentAck",
  "cards.quiet",
  "run.noAi",
  "summary.enabled",
  "budget.maxUsdPerCall",
  "@mic",
  "overlay.display",
  "ui.language",
];

/** Draw Settings. focus: "advanced" opens the debug list, "keys" jumps to the first key field. */
async function viewSettings(focus) {
  closePopover(false);
  state.view = "settings";
  state.gen++;
  setNav();
  busy();
  const main = $("main");
  main.textContent = "";
  main.append(
    h("div", { class: "page-head" }, h("h1", {}, T("nav.settings"))),
    h("div", { id: "set-body", class: "set" }, h("div", { class: "loading" }, "Loading settings…")),
  );
  let r;
  try {
    r = await api.getSettings();
  } catch (e) {
    r = { ok: false, message: e.message };
  }
  if (state.view !== "settings") return;
  SET.data = r;
  SET.errors = {};
  drawSettings();
  loadKeyState();
  loadSetup()
    .then(() => {
      if (state.view === "settings") drawSettings();
    })
    .catch(() => {});
  ready();
  if (focus === "advanced") {
    const d = $("adv");
    if (d) {
      d.open = true;
      const all = $("adv-all");
      if (all) all.open = true;
      d.scrollIntoView({ block: "start" });
      loadAdvanced();
    }
  } else if (focus === "keys") {
    const k = $("key-deepgram") || $("g-keys");
    if (k) {
      k.scrollIntoView({ block: "center" });
      k.focus({ preventScroll: true });
    } else focusTop();
  } else focusTop();
}

/** The language of this window (not of the answer window): same as the system, English or Hebrew. Kept in the page's own storage; the window reloads to apply it. */
function windowLanguageBlock() {
  const cur = windowLangChoice();
  const sel = h(
    "select",
    { id: "win-lang", "aria-describedby": "win-lang-h" },
    WingmanI18n.CHOICES.map((c) => h("option", { value: c, selected: c === cur ? "" : null }, T("lang." + c))),
  );
  sel.addEventListener("change", () => setWindowLanguage(sel.value));
  return h(
    "section",
    { class: "setgroup", "aria-labelledby": "g-lang" },
    h("h2", { id: "g-lang", class: "label", tabindex: "-1" }, T("lang.title")),
    h(
      "div",
      { class: "setlist" },
      h(
        "div",
        { class: "field" },
        h("label", { for: "win-lang", class: "sr" }, T("lang.title")),
        sel,
        h("p", { class: "help", id: "win-lang-h" }, T("lang.help")),
      ),
    ),
  );
}

// Redraw everything but keep keyboard focus (focus is matched by id / data-fk).
function drawSettings() {
  const body = $("set-body");
  if (!body) return;
  keepFocus(() => drawSettingsBody(body));
}
function drawSettingsBody(body) {
  body.textContent = "";
  const r = SET.data;
  if (!r || !r.ok) {
    body.append(
      h(
        "div",
        { class: "card-big errbox", role: "alert" },
        h("h2", {}, ico("warning"), "Your settings file has a problem"),
        h("p", {}, "Wingman cannot read it, so calls would not start. Fix or remove the file, then reopen this page."),
        h("pre", { class: "err" }, String((r && r.message) || "unknown error")),
        h(
          "div",
          { class: "actions" },
          btn("Show the file in Finder", { icon: "folder", onclick: () => api.reveal("settings") }),
          btn("Try again", { icon: "refresh", onclick: () => viewSettings() }),
        ),
      ),
    );
    body.append(advancedBlock());
    return;
  }
  const main = h("div", { class: "setmain" }),
    jump = []; // jump: [element id, title] for the "On this page" list
  main.append(
    h(
      "div",
      { class: "setintro" },
      h(
        "p",
        {},
        ico("clock"),
        h("span", {}, h("b", {}, "Changes apply to the next call."), " A call that is already running keeps the settings it started with."),
      ),
      h(
        "p",
        { class: "sub plain" },
        r.changed ? `${plural(r.changed, "setting")} changed from the defaults. ` : "Everything is on the defaults. ",
        "To check the microphone, keys and AI, use the ",
        h("b", {}, "Readiness check"),
        " on ",
        h("button", { type: "button", class: "linkbtn", id: "to-home", onclick: () => viewHome() }, "Home"),
        ".",
      ),
    ),
  );
  main.append(windowLanguageBlock());
  main.append(keysBlock(r));
  jump.push(["g-keys", "Keys"]); // keys first: nothing works without them
  const rows = MAIN_ORDER.map((k) => (k === "@mic" ? micRow() : settingRowFor(r, k))).filter(Boolean);
  main.append(
    h(
      "section",
      { class: "setgroup", "aria-labelledby": "g-main" },
      h("h2", { id: "g-main", class: "label", tabindex: "-1" }, "Main settings"),
      h("div", { class: "setlist" }, rows),
    ),
  );
  jump.push(["g-main", "Main settings"]);
  main.append(aboutBlock());
  jump.push(["g-about", "About you"]);
  main.append(setupGuideBlock());
  jump.push(["g-setup", "Setup guide"]);
  main.append(advancedBlock(r));
  jump.push(["adv", "Advanced"]);
  // The right side is a short "On this page" list (sticky), so a wide window has no empty third.
  const nav = h(
    "nav",
    { class: "setnav", "aria-label": "On this page" },
    h("div", { class: "label" }, "On this page"),
    jump.map(([id, t]) =>
      h(
        "button",
        {
          type: "button",
          class: "navlink",
          "data-fk": "nav-" + id,
          onclick: () => {
            const el = $(id);
            if (!el) return;
            if (el.tagName === "DETAILS") el.open = true;
            el.scrollIntoView({ block: "start" });
            if (el.tagName !== "DETAILS") el.focus({ preventScroll: true });
          },
        },
        t,
      ),
    ),
  );
  body.append(main, nav);
}

/** The row for one catalog key, or null when the catalog does not have it. */
function settingRowFor(r, key) {
  const i = r.items.find((x) => x.key === key);
  return i ? settingRow(i) : null;
}
/** The microphone choice (audio.mic.device is saved by the setup tool, not the catalog). Same list as the setup step. */
function micRow() {
  const cur = SU.status ? SU.status.micDevice : ":default",
    saving = SET.busy.has("audio.mic.device"),
    err = SET.errors["audio.mic.device"];
  const mics = ensureMics();
  const sel = h(
    "select",
    {
      id: "set-audio-mic-device",
      "aria-describedby": "set-audio-mic-device-h",
      disabled: saving || !mics || !SU.status,
      onchange: async (e) => {
        SET.busy.add("audio.mic.device");
        delete SET.errors["audio.mic.device"];
        drawSettings();
        let res;
        try {
          res = await api.setupSetMic(e.target.value);
        } catch (x) {
          res = { ok: false, message: x.message };
        }
        SET.busy.delete("audio.mic.device");
        if (res && res.ok) {
          SET.savedAt["audio.mic.device"] = Date.now();
          announce("Microphone saved. Applies to the next call.");
          setTimeout(() => state.view === "settings" && drawSettings(), 4100);
          await loadSetup();
        } else {
          SET.errors["audio.mic.device"] = (res && (res.message || res.error)) || "Not saved";
          fail("Microphone: " + SET.errors["audio.mic.device"]);
        }
        drawSettings();
      },
    },
    mics
      ? [
          h("option", { value: ":default", selected: cur === ":default" }, "System default" + (mics.defaultInput ? ` (${mics.defaultInput})` : "")),
          mics.devices.map((d) => h("option", { value: ":" + d.index, selected: cur === ":" + d.index }, d.name)),
        ]
      : h("option", {}, "Looking for microphones…"),
  );
  return h(
    "div",
    { class: "setrow" },
    h(
      "div",
      { class: "txt" },
      h("label", { class: "lab", for: "set-audio-mic-device" }, "Microphone"),
      h(
        "p",
        { class: "help", id: "set-audio-mic-device-h" },
        "The microphone Wingman listens to for your voice. Avoid Bluetooth headsets for the first calls.",
      ),
      err ? h("p", { class: "errline", role: "alert" }, ico("x"), err) : null,
    ),
    h("div", { class: "ctl" }, sel),
    h(
      "div",
      { class: "st" },
      SET.savedAt["audio.mic.device"] && Date.now() - SET.savedAt["audio.mic.device"] < 4000 ? h("span", { class: "saved good" }, ico("check"), "Saved") : null,
    ),
  );
}

/** One setting row from a catalog item (kind bool / select / number): label, help, control, changed chip, reset button. */
function settingRow(i) {
  const id = "set-" + i.key.replace(/\./g, "-");
  const err = SET.errors[i.key],
    saving = SET.busy.has(i.key);
  let control;
  if (i.kind === "bool") {
    control = h(
      "button",
      {
        type: "button",
        id,
        class: "switch",
        role: "switch",
        "aria-checked": i.value ? "true" : "false",
        "aria-describedby": id + "-h",
        disabled: saving,
        onclick: () => save(i, !i.value),
      },
      h("span", { class: "knob", "aria-hidden": "true" }),
      h("span", { class: "sl" }, i.value ? "On" : "Off"),
    );
  } else if (i.kind === "select") {
    control = h(
      "select",
      { id, "aria-describedby": id + "-h", disabled: saving, onchange: (e) => save(i, e.target.value) },
      i.options.map(([v, t]) => h("option", { value: v, selected: v === i.value }, t)),
    );
  } else {
    const inp = h("input", {
      type: "number",
      id,
      min: i.min,
      max: i.max,
      step: i.step,
      value: i.value,
      "aria-describedby": id + "-h",
      disabled: saving,
      class: "numin",
    });
    inp.addEventListener("change", () => {
      const v = inp.value.trim() === "" ? NaN : Number(inp.value);
      save(i, v);
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") inp.blur();
    });
    control = h("span", { class: "numwrap" }, inp, i.unit ? h("span", { class: "unit" }, i.unit) : null);
  }
  const warn = i.warn && i.value === i.warnWhen;
  return h(
    "div",
    { class: "setrow" + (i.changed ? " changed" : "") },
    h(
      "div",
      { class: "txt" },
      h("label", { class: "lab", for: id }, i.label),
      h("p", { class: "help", id: id + "-h" }, i.help),
      warn ? h("p", { class: "warnline" }, ico("warning"), i.warn) : null,
      err ? h("p", { class: "errline", role: "alert" }, ico("x"), err) : null,
    ),
    h("div", { class: "ctl" }, control),
    h(
      "div",
      { class: "st" },
      i.changed ? chip("changed", "warn", { dot: true }) : null,
      !i.changed
        ? null
        : h(
            "button",
            {
              type: "button",
              class: "btn ghost sm",
              disabled: !i.changed || saving,
              "aria-label": `Reset ${i.label} to the default`,
              title: "Back to the default",
              onclick: () => reset(i),
            },
            ico("undo"),
            "Reset",
          ),
      SET.savedAt[i.key] && Date.now() - SET.savedAt[i.key] < 4000 ? h("span", { class: "saved good" }, ico("check"), "Saved") : null,
    ),
  );
}

/** Save one setting (null resets it). Disables the row while saving, then shows a transient "Saved" or the error text. */
async function save(i, v) {
  if (SET.busy.has(i.key)) return;
  SET.busy.add(i.key);
  delete SET.errors[i.key];
  drawSettings();
  let r;
  try {
    r = await api.setSetting(i.key, v);
  } catch (e) {
    r = { ok: false, message: e.message };
  }
  SET.busy.delete(i.key);
  if (r.ok && r.state && r.state.ok) {
    SET.data = r.state;
    SET.savedAt[i.key] = Date.now();
    announce(`${i.label} saved. Applies to the next call.`);
    setTimeout(() => state.view === "settings" && drawSettings(), 4100);
  } else {
    SET.errors[i.key] = (r.message || "Not saved").replace(/^[^:]+: /, "");
    fail(`${i.label}: ${SET.errors[i.key]}`);
  }
  drawSettings();
}
const reset = (i) => save(i, null);

// Keys live in the macOS Keychain. The page can send a key to the main process and gets back only "ends ...abcd".
// The typed value is read from the input once, the input is cleared at once, and it is never kept in state, storage or attributes.
const KEYS = { data: null, busy: new Set(), msg: {} };
const KEY_NAMES = {
  deepgram: ["Deepgram", "Turns the call audio into text. Without it nothing is transcribed."],
  anthropic: ["Anthropic", "Writes AI answers and the summary. Without it only Prepared cards work."],
};
async function loadKeyState() {
  let r;
  try {
    r = await api.keysStatus();
  } catch (e) {
    r = null;
  }
  KEYS.data = r && r.ok ? r : null;
  if (state.view === "settings") drawSettings();
}
function keyStatusChip(st) {
  if (!st || st.source === "missing") return chip("Missing", "bad", { dot: true });
  const tail = "\u2026" + st.last4;
  if (st.source === "keychain") return chip("Saved in Keychain \u00b7 " + tail, "good", { dot: true });
  if (st.source === "file") return chip("In file \u00b7 " + tail, "warn", { dot: true });
  return chip("From environment \u00b7 " + tail, "", { dot: true });
}
/** Run a key action (set, test, remove, migrate) with a busy flag and a message line. The result carries status only; a key value is never part of it. */
async function keyAct(provider, fn, okMsg) {
  if (KEYS.busy.has(provider)) return;
  KEYS.busy.add(provider);
  KEYS.msg[provider] = null;
  drawSettings();
  let r;
  try {
    r = await fn();
  } catch (e) {
    r = { ok: false, message: "Could not reach the app." };
  }
  KEYS.busy.delete(provider);
  if (r && r.state && r.state.ok) KEYS.data = r.state;
  KEYS.msg[provider] = r && r.cancelled ? null : { ok: !!(r && r.ok), text: (r && r.message) || (r && r.ok ? okMsg : "Failed.") };
  if (KEYS.msg[provider]) (KEYS.msg[provider].ok ? announce : fail)(KEY_NAMES[provider][0] + ": " + KEYS.msg[provider].text);
  if (KEYS.data) H.keys = KEYS.data; // the guided setup on Home reads H.keys
  drawSettings();
  if (state.view === "home" && typeof suRedraw === "function") suRedraw();
}
function testText(r) {
  if (!r || !r.ok) return (r && r.message) || "Could not test the key. Check your connection and try again.";
  return (
    {
      ok: "The key works.",
      invalid: "The provider rejected this key.",
      network: "Could not reach the provider. Check your connection.",
      missing: "No key to test.",
    }[r.result] || "Could not test the key. Check your connection and try again."
  );
}
/** Row for one provider: status chip, write-only password field, Test and Remove. */
function keyRow(p) {
  const [name, what] = KEY_NAMES[p],
    st = KEYS.data && KEYS.data.providers[p],
    busy = KEYS.busy.has(p),
    m = KEYS.msg[p],
    id = "key-" + p;
  const inp = h("input", {
    type: "password",
    id,
    autocomplete: "off",
    spellcheck: "false",
    autocapitalize: "off",
    "aria-label": name + " key (write only)",
    placeholder: st && st.source !== "missing" ? "Paste a new key to replace it" : "Paste your key",
    class: "keyin",
    disabled: busy,
  });
  const submit = () => {
    const v = inp.value;
    inp.value = ""; // cleared before anything else happens
    if (!v) return;
    keyAct(p, () => api.keysSet(p, v), "Saved in the Keychain.");
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });
  return h(
    "div",
    { class: "keyrow keyrow2" },
    h(
      "div",
      { class: "txt" },
      h("span", { class: "lab" }, name),
      h("p", { class: "help" }, what),
      h("div", { class: "keyedit" }, inp, btn("Save", { cls: "sm", onclick: submit })),
      m ? h("p", { class: m.ok ? "saved good" : "errline", role: m.ok ? "status" : "alert" }, m.text) : null,
    ),
    h(
      "div",
      { class: "keyside" },
      KEYS.data ? keyStatusChip(st) : chip("Checking\u2026", ""),
      h(
        "div",
        { class: "actions" },
        st && st.source !== "missing"
          ? btn("Test", {
              cls: "sm ghost",
              onclick: () =>
                keyAct(
                  p,
                  async () => {
                    const r = await api.keysTest(p);
                    return { ok: r.ok && r.result === "ok", message: testText(r) };
                  },
                  "",
                ),
            })
          : null,
        st && st.inKeychain ? btn("Remove", { cls: "sm ghost", onclick: () => keyAct(p, () => api.keysRemove(p), "Removed.") }) : null,
      ),
    ),
  );
}
function keysBlock(r) {
  const anyFile = KEYS.data && Object.values(KEYS.data.providers).some((x) => x.source === "file");
  const anyInFile = KEYS.data && Object.values(KEYS.data.providers).some((x) => x.inFile);
  const mig = KEYS.msg.migrate;
  return h(
    "section",
    { class: "setgroup", "aria-labelledby": "g-keys" },
    h("h2", { id: "g-keys", class: "label" }, "Keys"),
    h(
      "div",
      { class: "setlist" },
      keyRow("deepgram"),
      keyRow("anthropic"),
      anyFile
        ? h(
            "div",
            { class: "keyfile" },
            h(
              "p",
              { class: "help" },
              "Your keys are still in a plain text file. Move both to the Keychain in one step. Each key is checked in the Keychain first, then its line is removed from the file. No copy of the file is kept.",
            ),
            h(
              "div",
              { class: "actions" },
              btn("Move to Keychain", { icon: "check", cls: "sm", onclick: () => keyAct("migrate", () => api.keysMigrate(), "Moved to the Keychain.") }),
            ),
          )
        : null,
      mig ? h("div", { class: "keyfile" }, h("p", { class: mig.ok ? "saved good" : "errline", role: mig.ok ? "status" : "alert" }, mig.text)) : null,
      h(
        "div",
        { class: "keyfile" },
        h(
          "p",
          { class: "help" },
          "Keys are stored in the macOS Keychain (item \u201cwingman\u201d), set here. Wingman never shows them: only the last 4 characters.",
          // Only for keys still in the old plain-text file; most users never had one.
          anyInFile ? h("span", {}, " ") : null,
          anyInFile ? h("button", { type: "button", class: "linkbtn", onclick: () => api.reveal("keys") }, "Show the old keys file in Finder") : null,
        ),
      ),
    ),
  );
}

/* ---- Advanced: one fold, closed by default (remembered). Holds every other setting, the settings file and the read-only list ---- */
let advLoaded = false;
function advancedBlock(r) {
  advLoaded = false;
  const body = h("div", { class: "advbody advmain" });
  if (r && r.ok) {
    for (const g of r.groups) {
      const rows = r.items.filter((i) => i.group === g.id && !i.main);
      if (!rows.length) continue;
      const list = h("div", { class: "setlist" }, rows.map(settingRow));
      if (g.id === "tune") {
        // expert numbers: folded away unless one was changed
        const open = rows.some((i) => i.changed) || SET.tuneOpen;
        const d = h(
          "details",
          { class: "collapsed adv tune", id: "tune", open },
          h("summary", {}, ico("chevron"), "Fine-tuning", h("span", { class: "faint" }, "\u00b7 limits and timings, the defaults are fine")),
          list,
        );
        d.addEventListener("toggle", () => {
          SET.tuneOpen = d.open;
        });
        body.append(d);
        continue;
      }
      body.append(
        h("section", { class: "setgroup", "aria-labelledby": "g-" + g.id }, h("h2", { id: "g-" + g.id, class: "label", tabindex: "-1" }, g.title), list),
      );
    }
  }
  body.append(
    h(
      "section",
      { class: "setgroup", "aria-labelledby": "g-file" },
      h("h2", { id: "g-file", class: "label", tabindex: "-1" }, "Settings file"),
      h(
        "div",
        { class: "setlist" },
        h(
          "div",
          { class: "keyfile" },
          h("p", { class: "help" }, "Your choices are saved in this file. You can edit it by hand."),
          r && r.userFile ? h("code", {}, r.userFile) : null,
          h("div", { class: "actions" }, btn("Show in Finder", { icon: "folder", cls: "sm", onclick: () => api.reveal("settings") })),
        ),
      ),
    ),
  );
  const all = h(
    "details",
    { class: "collapsed adv", id: "adv-all" },
    h("summary", {}, ico("chevron"), "All values (read only)", h("span", { class: "faint" }, "\u00b7 every setting, where each value comes from")),
    h("div", { id: "adv-body", class: "advbody" }, h("div", { class: "loading" }, "Loading\u2026")),
  );
  all.addEventListener("toggle", () => {
    if (all.open) loadAdvanced();
  });
  body.append(all);
  const d = h(
    "details",
    { class: "collapsed adv", id: "adv", open: SET.advOpen || !!SU.acks.advOpen },
    h("summary", {}, ico("chevron"), "Advanced", h("span", { class: "faint" }, "\u00b7 tuning, the settings file")),
    body,
  );
  d.addEventListener("toggle", () => {
    SET.advOpen = d.open;
    SU.acks.advOpen = d.open; // remembered with the other setup flags (kept by setup.js)
    suSave();
  });
  return d;
}
// Parse the text of `settings-cli` (lines "key   value   [source]") into groups by key prefix.
function parseSettingsText(text) {
  const groups = new Map();
  for (const line of String(text).split("\n")) {
    const m = /^(\S+)\s{2,}(.*?)\s+\[([^\]]+)\]\s*$/.exec(line);
    if (m) {
      const g = m[1].includes(".") ? m[1].split(".")[0] : "general";
      (groups.get(g) || groups.set(g, []).get(g)).push({ k: m[1], v: m[2], src: m[3] });
    }
  }
  return groups;
}
async function loadAdvanced() {
  if (advLoaded) return;
  advLoaded = true;
  const body = $("adv-body");
  if (!body) return;
  let r;
  try {
    r = await api.settingsText();
  } catch (e) {
    r = { ok: false, text: e.message };
  }
  body.textContent = "";
  const groups = parseSettingsText(r.text);
  if (!groups.size) {
    body.append(h("pre", { class: "err" }, String(r.text || "(no output)").trim()));
    return;
  }
  body.append(
    h("p", { class: "sub" }, "Read only. Edit ~/.config/wingman/settings.yaml, or use ", h("code", {}, "pnpm settings"), " in Terminal. Keys are never shown."),
  );
  const cfg = h("div", { class: "cfg" });
  for (const [g, rows] of groups)
    cfg.append(
      h(
        "section",
        {},
        h("h3", {}, g),
        h(
          "table",
          { "aria-label": g + " settings" },
          h(
            "tbody",
            {},
            rows.map((x) => {
              const ov = x.src !== "default";
              return h(
                "tr",
                { class: ov ? "ov" : "" },
                h(
                  "td",
                  { class: "k" },
                  ov ? h("span", { class: "odot", title: "Overridden by " + x.src }) : null,
                  x.k.includes(".") ? x.k.slice(x.k.indexOf(".") + 1) : x.k,
                ),
                h("td", { class: "v" }, ltr(x.v), h("span", { class: "chip src " + (ov ? "warn" : "") + " mono" }, ov ? x.src : "default")),
              );
            }),
          ),
        ),
      ),
    );
  body.append(cfg);
}
