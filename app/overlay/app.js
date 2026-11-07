// Answer window renderer: reads the call's cards.jsonl rows, health bars and alerts through the preload bridge
// and draws them as cards (labels in Hebrew or English, see strings.js). Presentation only; the engine decides what is shown.
// UI language (setting ui.language, resolved by the engine side to "he" | "en"): the page learns it from ?lang= at load and from the config event. Labels live in strings.js.
let LANG = WingmanStrings.normLang(new URLSearchParams(location.search).get("lang"));
let UIDIR = WingmanStrings.dirOf(LANG); // direction of the window chrome; card content keeps its own per-line direction (isLatin)
const tr = (key, vars) => WingmanStrings.t(LANG, key, vars); // not named t: many functions below have a local t (a text span)
const cardsBox = document.getElementById("cards");
const healthBox = document.getElementById("health");
const emptyBox = document.getElementById("empty");
const cards = new Map(); // id -> element
const bars = new Map(); // health id -> {level, text}
let MAX = 4;
const SHOW_OLDER = 2; // older answers shown next to the hero
let paused = false,
  quiet = false,
  phase = "starting",
  realPhase = false,
  liveAt = 0,
  pausedNew = 0,
  HK = { ask: "Control+Alt+A", pause: "Control+Alt+P" };

// Mixed Hebrew/English text: every Latin/number run (domains, emails, phones, prices, "API") is an isolated LTR island, so it never flips neighbours.
// Built with text nodes + <bdi> only (never innerHTML).
// Shared bidi tokenizer (dashboard/bidi.js) plus the overlay joins, see text.js.
function mixed(el, text) {
  // An English line reads left to right as a whole; inside Hebrew text it is an isolated island.
  if (el._dir0 === undefined) el._dir0 = el.getAttribute("dir");
  if (!el.childNodes.length) {
    if (WingmanText.isLatin(text)) el.dir = "ltr";
    else if (el._dir0) el.dir = el._dir0;
    else el.removeAttribute("dir");
  }
  if (WingmanText.isLatin(text) && el.dir !== "ltr") {
    const b = document.createElement("bdi");
    b.dir = "ltr";
    b.textContent = String(text);
    el.append(b);
    return el;
  }
  if (WingmanText.isLatin(text) && el.dir === "ltr") {
    el.append(document.createTextNode(String(text)));
    return el;
  } // a whole English line in an LTR box: one text node (no per-word pieces in a flex box)
  for (const seg of WingmanText.segments(String(text ?? ""))) {
    if (!seg.ltr) {
      el.append(document.createTextNode(seg.text));
      continue;
    }
    const b = document.createElement("bdi");
    b.dir = "ltr";
    b.textContent = seg.text;
    el.append(b);
  }
  return el;
}
const div = (cls, dir = UIDIR) => {
  const d = document.createElement("div");
  if (cls) d.className = cls;
  d.dir = dir;
  return d;
};
const span = (cls, text) => {
  const s = document.createElement("span");
  if (cls) s.className = cls;
  if (text != null) s.textContent = text;
  return s;
};
const fmtKey = (a) =>
  String(a || "")
    .split("+")
    .map((p) => ({ Control: "Ctrl", Alt: "Opt", Option: "Opt", Command: "Cmd" })[p] || p)
    .join("+");

// ---- status word next to the dot: ended > paused > quiet > starting > listening ----
const stateEl = document.getElementById("state"),
  emptyT = document.getElementById("emptyT"),
  emptyS = document.getElementById("emptyS");
function refreshState() {
  const s =
    phase === "ended" ? "ended" : phase === "waiting" ? "waiting" : paused ? "paused" : quiet ? "quiet" : phase === "starting" ? "starting" : "listening";
  for (const n of ["ended", "paused", "quiet", "starting", "waiting"]) document.body.classList.toggle(n, s === n);
  const key = (n, part) => "state." + n + (part ? "." + part : "");
  const T = [tr(key(s)), tr(key(s, "title")), s === "listening" || s === "ended" || s === "quiet" || s === "starting" ? tr(key(s, "sub")) : null];
  stateEl.textContent = T[0];
  emptyT.textContent = T[1];
  emptyS.replaceChildren();
  if (s === "paused") mixed(emptyS, tr("state.paused.sub", { key: fmtKey(HK.pause) }));
  else if (s === "waiting") mixed(emptyS, tr("state.waiting.sub", { key: fmtKey("Control+Alt+Return") }));
  else if (s === "listening" && liveAt) emptyS.textContent = T[2] + tr("state.listening.for", { time: elapsed(Date.now() - liveAt) });
  else emptyS.textContent = T[2];
  emptyCheck();
}
const elapsed = (ms) => {
  const m = Math.floor(ms / 60000);
  return m < 1 ? tr("time.lessThanMinute") : m === 1 ? tr("time.oneMinute") : tr("time.minutes", { n: m });
};
let startTimer;
// First card or line = we are live, but only when call.json writes no phase (then a 4 s timer is the fallback too).
function listening() {
  if (phase === "starting" && !realPhase) {
    phase = "listening";
    clearTimeout(startTimer);
    refreshState();
  }
}

// Fade the bottom of the card list only when it overflows (checked next frame, after layout).
function fadeCheck() {
  requestAnimationFrame(() => cardsBox.classList.toggle("fade", cardsBox.scrollHeight > cardsBox.clientHeight + 2));
}
function emptyCheck() {
  fadeCheck();
  emptyBox.style.display = cards.size && !paused && phase !== "ended" ? "none" : "flex";
}
function clearCards() {
  for (const el of cards.values()) el.remove();
  cards.clear();
  emptyCheck();
}

// ---- warnings: ONE red fault line (blind now) + ONE muted advisory line ----
const cleanText = (id, text) => WingmanText.healthText(id, text, fmtKey(HK.ask), LANG);
function drawHealth() {
  healthBox.replaceChildren();
  const faults = [],
    advs = [];
  for (const [id, h] of bars) {
    if (id === "health-quiet") continue; // shown as the status word
    if (id === "health-cost") continue; // cost alone changes nothing; the reduced-AI notice covers a cap
    (h.level === "red" ? faults : advs).push(cleanText(id, h.text));
  }
  if (faults.length) {
    const el = div("fault");
    el.setAttribute("role", "alert");
    mixed(el, faults.join(" · "));
    healthBox.append(el);
  }
  if (advs.length) {
    const el = div("adv");
    mixed(el, advs[0] + (advs.length > 1 ? `  (+${advs.length - 1})` : ""));
    healthBox.append(el);
  }
  drawHealthDot();
  fadeCheck();
}
// One small always-visible dot from the same bars: green ok, amber degraded, red not working. Tooltip = the first reason, one line.
const hdot = document.getElementById("hdot"),
  hlabel = document.getElementById("hlabel");
function drawHealthDot() {
  const level = WingmanText.healthLevel(bars);
  let reason = "";
  if (level !== "ok")
    for (const [id, h] of bars)
      if (h.level === level && id !== "health-quiet") {
        reason = cleanText(id, h.text);
        break;
      }
  const word = tr(level === "red" ? "dot.down" : level === "amber" ? "dot.degraded" : "dot.ok");
  const tip = reason ? `${word}: ${reason}` : word;
  hdot.className = level;
  hdot.title = tip;
  hdot.setAttribute("aria-label", tip);
  hlabel.textContent = level === "ok" ? "" : word;
}
function renderHealth(c) {
  if (c.id === "health-quiet") {
    quiet = !c.clear;
    refreshState();
    return;
  }
  if (c.clear) bars.delete(c.id);
  else bars.set(c.id, { level: c.level || "red", text: c.say });
  drawHealth();
}

const rail = document.getElementById("rail"),
  notesBox = document.getElementById("notes"),
  noteList = document.getElementById("notelist");
const sides = new Map();
/** Side rail items (facts, reminders, info) and AI notes. Rail keeps the 2 newest; notes list keeps 3. */
function renderSide(c) {
  if (c.badge === "note") {
    const li = document.createElement("li");
    li.dir = "rtl";
    mixed(li, c.say);
    noteList.append(li);
    while (noteList.children.length > 3) noteList.firstElementChild.remove();
    notesBox.style.display = "block";
    return;
  }
  let el = sides.get(c.id);
  if (!el) {
    el = document.createElement("div");
    sides.set(c.id, el);
    rail.prepend(el);
  }
  el.className = `side ${c.badge}${c.warn ? " warn" : ""}`;
  el.replaceChildren();
  const t = div("t");
  const reminder = c.badge === "reminder" && c.say === WingmanStrings.STRINGS.he["reminder.title"]; // the engine's fixed Hebrew heading: shown in the UI language
  mixed(t, reminder ? tr("reminder.title") : c.say);
  el.append(t);
  if (c.facts?.length) {
    const ul = document.createElement("ul");
    for (const f of c.facts) {
      const li = document.createElement("li");
      li.dir = "rtl";
      const pre = WingmanStrings.STRINGS.he["reminder.more"].replace("{n}", ""),
        n = reminder && String(f).startsWith(pre) ? String(f).slice(pre.length) : "";
      mixed(li, /^\d+$/.test(n) ? tr("reminder.more", { n }) : f);
      ul.append(li);
    }
    el.append(ul);
  }
  while (sides.size > 2) {
    const [k, v] = sides.entries().next().value;
    v.remove();
    sides.delete(k);
  }
}

// Card types (glossary): Prepared / AI / Buy time / For you / Math / Tip. Each has a glyph + label + tint.
const TYPE = {
  bank: { gl: "✔" },
  ai: { gl: "✦" },
  stall: { gl: "◷" },
  me: { gl: "☆" },
  fix: { gl: "✕" },
  careful: { gl: "!" },
  calc: { gl: "∑" },
  info: { gl: "ℹ" },
  consent: { gl: "◔" },
};
const typeLabel = (b) => tr("badge." + b);
/** Newest = hero, the rest = compact rows (max 2 shown). Font size is fixed per type, so nothing shrinks while text streams. */
function layoutRoles() {
  const els = [...cards.values()],
    hero = els[els.length - 1];
  let older = 0;
  for (let i = els.length - 2; i >= 0; i--) {
    els[i].classList.toggle("extra", ++older > SHOW_OLDER);
  }
  els.forEach((el) => {
    el.classList.toggle("compact", el !== hero && !el.classList.contains("consent"));
  });
  if (hero) hero.classList.remove("extra");
  updateAges();
}
// Age: older cards say how old they are and fade by age.
function ageText(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? tr("age.seconds", { n: s }) : tr("age.minutes", { n: Math.round(s / 60) });
}
function updateAges() {
  const now = Date.now();
  for (const el of cards.values()) {
    const a = el.querySelector(".age");
    if (!a) continue;
    const ms = now - (el._at || now),
      hero = !el.classList.contains("compact");
    a.textContent = ms >= (hero ? 45000 : 20000) ? ageText(ms) : "";
    el.classList.toggle("age-1", ms > 60000);
    el.classList.toggle("age-2", ms > 180000);
  }
}
setInterval(() => {
  updateAges();
  if (phase === "listening" && liveAt && !cards.size) refreshState();
}, 10000);

// ---- call frame header + checklist ----
const KINDS = ["client", "support", "vendor", "team", "consult", "personal", "other"];
const frameBox = document.getElementById("frame"),
  frameTxt = frameBox.querySelector(".ft"),
  chipEl = document.getElementById("chip"),
  clBox = document.getElementById("cl");
function renderFrame(f) {
  if (!f || typeof f !== "object") return;
  const list = Array.isArray(f.checklist) ? f.checklist.filter((c) => c && typeof c.item === "string").slice(0, 12) : [];
  const kind = tr("kind." + (KINDS.includes(f.kind) ? f.kind : "other")),
    topic = typeof f.topic === "string" ? f.topic : "";
  frameTxt.replaceChildren();
  const b = document.createElement("b");
  b.textContent = kind;
  frameTxt.append(b);
  if (topic) {
    frameTxt.append(document.createTextNode(" · "));
    mixed(frameTxt, topic);
  }
  const done = list.filter((c) => c.done).length;
  chipEl.style.display = list.length ? "" : "none";
  chipEl.textContent = `${done}/${list.length}`;
  chipEl.classList.toggle("all", list.length > 0 && done === list.length);
  clBox.replaceChildren();
  if (f.goal) {
    const g = div("goal");
    g.textContent = tr("frame.goal");
    mixed(g, f.goal);
    clBox.append(g);
  }
  const ul = document.createElement("ul");
  for (const c of list) {
    const li = document.createElement("li");
    li.dir = "rtl";
    if (c.done) li.className = "done";
    const t = document.createElement("span");
    mixed(t, c.item);
    li.append(t);
    if (c.must) {
      const m = document.createElement("span");
      m.className = "must";
      m.textContent = tr("frame.must");
      li.append(m);
    }
    ul.append(li);
  }
  clBox.append(ul);
  frameBox.style.display = "flex";
}
window.wingman.onFrame(renderFrame);
// ---- flow: their own discussion, and the moment they turn to you ----
const flowBox = document.getElementById("flow"),
  youBox = document.getElementById("you");
let youTimer;
window.wingman.onFlow((f) => {
  if (f.state !== "internal") {
    flowBox.classList.remove("on");
    return;
  }
  flowBox.querySelector(".fw").textContent = (f.who || []).map((w) => (/^\d+$/.test(w) ? tr("flow.speaker", { n: w }) : w)).join(tr("flow.and"));
  const fx = flowBox.querySelector(".fx");
  fx.replaceChildren();
  if (f.topic) mixed(fx, "· " + f.topic);
  flowBox.classList.add("on");
});
window.wingman.onAddressed((a) => {
  flowBox.classList.remove("on");
  const yt = youBox.querySelector(".yt");
  yt.replaceChildren();
  mixed(yt, (a.who ? a.who + ": " : "") + (a.text || ""));
  youBox.classList.add("on");
  announce(tr("flow.youLabel"), a.text || "");
  clearTimeout(youTimer);
  youTimer = setTimeout(() => youBox.classList.remove("on"), 10000);
});
window.wingman.onChecklist(() => {
  frameBox.classList.toggle("open");
  clearTimeout(frameBox._t);
  if (frameBox.classList.contains("open")) frameBox._t = setTimeout(() => frameBox.classList.remove("open"), 15000);
});

// ---- tips ----
const tipsBox = document.getElementById("tips"),
  tipEls = new Map();
const TIP_KINDS = ["ask", "clarify", "term", "remind", "note"];
const SVG = "http://www.w3.org/2000/svg";
function tipIcon() {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z");
  s.append(p);
  return s;
}
function renderTip(c) {
  let el = tipEls.get(c.id);
  if (!el) {
    el = div("tip");
    tipEls.set(c.id, el);
    tipsBox.append(el);
    while (tipEls.size > 2) {
      const [k, v] = tipEls.entries().next().value;
      v.remove();
      tipEls.delete(k);
    }
    setTimeout(() => {
      el.remove();
      tipEls.delete(c.id);
    }, 90000);
  }
  el.replaceChildren(tipIcon());
  const k = document.createElement("span");
  k.className = "k";
  k.textContent = tr("tip.prefix") + " · " + (TIP_KINDS.includes(c.tipType) ? tr("tip." + c.tipType) : tr("tip.prefix"));
  el.append(k);
  const t = document.createElement("span");
  t.className = "tx";
  mixed(t, c.say);
  el.append(t);
}

// ---- answer cards: built once, then only the text is updated while it streams ----
const liveEl = document.getElementById("live");
let liveTimer;
function announce(label, text) {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    liveEl.textContent = `${label}: ${text}`;
  }, 1500);
}

/** The bold first sentence is decided once, when that sentence is complete; after that it never changes. */
function setSay(el, say) {
  const s = el._say;
  s.dir = WingmanText.isLatin(say) ? "ltr" : "rtl";
  if (el._cut == null && say.length > 90) {
    const i = say.search(/[.!?]\s/);
    if (i > 15 && i < say.length - 12) {
      el._cut = i + 1;
    }
  }
  if (el._cut != null && !say.startsWith(el._first ?? say.slice(0, el._cut))) el._cut = null; // text was rewritten: decide again
  if (el._cut != null) {
    const first = say.slice(0, el._cut);
    if (!s._b || el._first !== first) {
      s.replaceChildren();
      s._b = document.createElement("b");
      mixed(s._b, first);
      s._rest = span("rest");
      s.append(s._b, document.createTextNode(" "), s._rest);
      el._first = first;
    }
    s._rest.replaceChildren();
    mixed(s._rest, say.slice(el._cut).trimStart());
  } else {
    s._b = null;
    el._first = null;
    s.replaceChildren();
    mixed(s, say);
  }
}
/** (Re)builds the static parts of a card. Called only when its signature changes; streaming text goes through setSay. */
function buildCard(el, c, consent) {
  const calc = c.source === "calc";
  el.className = `card ${c.badge}${c.dim ? " dim" : ""}${consent ? " consent" : ""}${calc ? " calc" : ""}${el.classList.contains("compact") ? " compact" : ""}${el.classList.contains("extra") ? " extra" : ""}`;
  el.replaceChildren();
  el._cut = null;
  el._first = null;
  const tk = consent ? "consent" : calc && c.badge === "ai" ? "calc" : c.badge;
  const kind = { gl: (TYPE[tk] || { gl: "" }).gl, label: TYPE[tk] ? typeLabel(tk) : c.badge };
  const top = div("top");
  const pill = span("pill");
  pill.append(span("gl", kind.gl), document.createTextNode(kind.label + (calc && c.badge === "me" ? tr("badge.calcSuffix") : "")));
  top.append(pill, span("age"));
  el.append(top);
  if (c.question && !consent) {
    const q = div("q", UIDIR === "ltr" && WingmanText.isLatin(c.question) ? "ltr" : "rtl");
    q.append(span("ql", c.badge === "fix" || c.badge === "careful" ? tr("card.youSaid") : tr("card.answering")));
    mixed(q, c.question);
    el.append(q);
  }
  el._say = div("say", "rtl");
  el.append(el._say);
  if (c.facts?.length) {
    const ul = document.createElement("ul");
    for (const f of c.facts) {
      const li = document.createElement("li");
      li.dir = "rtl";
      mixed(li, f);
      ul.append(li);
    }
    el.append(ul);
  }
  if (c.dim) {
    const n = div("note-line");
    n.textContent = tr("card.dim");
    el.append(n);
  }
  el._label = kind.label;
}

/** Handles one row from calls/latest/cards.jsonl. The same id arrives again as the answer streams or is rewritten, so cards are updated in place. */
function render(c) {
  if (phase === "ended") return;
  listening();
  if (c.badge === "tip") {
    renderTip(c);
    return;
  }
  if (c.health) {
    renderHealth(c);
    return;
  }
  if (c.turnId === "side") {
    renderSide(c);
    return;
  } // facts/notes/reminders are kept even while paused
  if (c.withdraw) {
    cards.get(c.id)?.remove();
    cards.delete(c.id);
    layoutRoles();
    emptyCheck();
    return;
  }
  // Paused: cards still arrive and are kept (just not shown); on resume the latest is on screen.
  let el = cards.get(c.id);
  const isNew = !el;
  const consent = c.turnId === "start" || c.id === "consent";
  if (!el) {
    el = document.createElement("div");
    el._at = Number(c.at) || Date.now();
    cards.set(c.id, el);
    cardsBox.prepend(el);
    while (cards.size > MAX) {
      const [k, v] = cards.entries().next().value;
      v.remove();
      cards.delete(k);
    }
    if (paused) pausedNew++;
  }
  const sig = [c.badge, c.dim, consent, c.source, c.question, (c.facts || []).join("\u0001")].join("\u0002");
  if (el._sig !== sig) {
    buildCard(el, c, consent);
    el._sig = sig;
  }
  setSay(el, String(c.say || ""));
  layoutRoles();
  emptyCheck();
  if (!paused && !consent && c.badge !== "info") announce(el._label, String(c.say || ""));
  if (isNew && !consent) newInRewind(el, c);
}

// Rewind: keep recent transcript lines; the hotkey shows the last N seconds (auto-hides after 20 s).
const lines = [];
let REWIND_S = 30,
  rewindTimer;
const rewindBox = document.getElementById("rewind"),
  rContent = document.getElementById("rcontent"),
  rNew = document.getElementById("rnew"),
  capBox = document.getElementById("capture");
const rewindOpen = () => rewindBox.style.display === "flex";
function showNewBar(el, c) {
  rNew.replaceChildren(span("rl", tr("rewind.newAnswer") + el._label));
  const t = span("rt");
  mixed(t, String(c.say || ""));
  rNew.append(t);
  rNew.style.display = "block";
  rNew._id = c.id;
}
// A new answer while the sheet is open: a bar on top of the sheet, so it is never hidden.
function newInRewind(el, c) {
  if (rewindOpen() && c.badge !== "info") showNewBar(el, c);
}
/** Hotkey toggle for the "what did they say" sheet; it hides itself after 20 s. */
function showRewind() {
  if (rewindOpen()) {
    rewindBox.style.display = "none";
    rNew.style.display = "none";
    return;
  }
  const since = Date.now() - REWIND_S * 1000;
  const fresh = lines.some((l) => l.t >= since);
  let recent = lines.filter((l) => l.t >= since);
  if (!recent.length) recent = lines.slice(-4); // quiet for a while: show the last few lines anyway
  rContent.replaceChildren();
  rNew.style.display = "none";
  const h = div("h");
  const ht = document.createElement("span");
  ht.textContent = fresh ? tr("rewind.recent", { s: REWIND_S }) : tr("rewind.latest");
  const hk = document.createElement("span");
  hk.className = "k";
  hk.textContent = tr("rewind.close", { key: fmtKey(HK.rewind) });
  h.append(ht, hk);
  rContent.append(h);
  const body = div("body");
  if (!recent.length) {
    const e = div("l");
    e.textContent = tr("rewind.empty");
    body.append(e);
  }
  for (const l of recent) {
    const d = div(`l ${l.ch}`, "rtl"); // transcript text is call content: per-line direction, not the chrome direction
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = whoLabel(l);
    d.append(who);
    mixed(d, l.text);
    body.append(d);
  }
  rContent.append(body);
  rewindBox.style.display = "flex";
  body.scrollTop = body.scrollHeight;
  clearTimeout(rewindTimer);
  rewindTimer = setTimeout(() => {
    rewindBox.style.display = "none";
    rNew.style.display = "none";
  }, 20000);
}
// Live strip: the newest line from either side, labelled (overlay.showLastLine). Text nodes only.
// A short "me" line (< 3 words: "yes", "okay") does not replace the other side's sentence, so the question stays readable.
let SHOW_LAST = true;
const lastBox = document.getElementById("last"),
  lastTxt = lastBox.querySelector(".txt"),
  lastWho = lastBox.querySelector(".who");
// partial = words still being spoken (live.jsonl); the final line replaces them. A partial never re-triggers the fade-in.
// Who said it: "Me", the name, "Speaker 2" when the voices are told apart, else "Other side". Text only (names come from the call).
// Names given during the call (an introduction, or the user renamed a voice): they also apply to lines already received.
const NAMES = new Map();
const whoLabel = (l) =>
  l.ch === "me"
    ? tr("who.me")
    : (Number.isInteger(l.spk) && NAMES.get(l.spk)) ||
      (typeof l.name === "string" && l.name ? l.name.slice(0, 40) : Number.isInteger(l.spk) ? tr("flow.speaker", { n: l.spk }) : tr("who.them"));
function showLast(text, ch, partial, who) {
  if (!SHOW_LAST || !text) {
    lastBox.style.display = "none";
    return;
  }
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (ch === "me" && clean.split(" ").length < 3 && lastBox.style.display === "flex") return;
  lastBox.classList.toggle("partial", !!partial);
  lastTxt.replaceChildren();
  mixed(lastTxt, clean.slice(-220));
  lastWho.textContent = who || (ch === "me" ? tr("who.me") : tr("who.them"));
  lastBox._line = { ch, spk: lastBox._spkNext };
  lastBox.classList.toggle("me", ch === "me");
  if (!partial && !lastBox._wasPartial) {
    lastBox.classList.remove("fresh");
    void lastBox.offsetWidth;
    lastBox.classList.add("fresh");
  }
  lastBox._wasPartial = !!partial;
  lastBox.style.display = "flex";
}
window.wingman.onLine((l) => {
  if (phase === "ended") return;
  listening();
  lines.push(l);
  while (lines.length > 400) lines.shift();
  lastBox._spkNext = l.spk;
  showLast(l.text, l.ch, false, whoLabel(l));
});
window.wingman.onPartial((l) => {
  if (phase === "ended") return;
  listening();
  lastBox._spkNext = l.spk;
  showLast(l.text, l.ch, true, whoLabel(l));
});
window.wingman.onSpeaker((s) => {
  if (s.name) NAMES.set(s.spk, s.name);
  else NAMES.delete(s.spk);
  if (lastBox._line && lastBox._line.ch === "them" && lastBox._line.spk === s.spk) lastWho.textContent = whoLabel(lastBox._line); // the strip on screen follows at once
});
window.wingman.onRewind(showRewind);
const caps = new Map(); // value -> chip, newest first (same order as main.cjs: chip N = Ctrl+Opt+N)
const numberChips = () =>
  [...capBox.children].forEach((el, i) => {
    el.querySelector(".n").textContent = String(i + 1);
    el.setAttribute("aria-label", `${el.dataset.kind} ${el.dataset.value}, ${fmtKey("Control+Alt+" + (i + 1))}`);
  });
window.wingman.onCapture((c) => {
  if (phase === "ended" || caps.has(c.value)) return;
  const el = document.createElement("div");
  el.className = "cap";
  el.setAttribute("role", "button");
  el.dataset.kind = ["phone", "email", "domain"].includes(c.kind) ? tr("cap." + c.kind) : c.kind;
  el.dataset.value = c.value;
  const n = document.createElement("kbd");
  n.className = "n";
  const k = document.createElement("span");
  k.className = "k";
  k.textContent = el.dataset.kind;
  const v = document.createElement("span");
  v.textContent = c.value;
  el.append(n, k, v);
  el.addEventListener("click", () => window.wingman.copy(c.value));
  caps.set(c.value, el);
  capBox.prepend(el);
  capBox.style.display = "flex";
  while (caps.size > 3) {
    const [key, node] = caps.entries().next().value;
    node.remove();
    caps.delete(key);
  }
  numberChips();
});
window.wingman.onCopied((t) => {
  const el = caps.get(t);
  if (el) {
    el.classList.add("copied");
    setTimeout(() => el.classList.remove("copied"), 1200);
  }
});
window.wingman.onConfig((c) => {
  if (c.language) setLanguage(c.language);
  SHOW_LAST = c.showLastLine !== false;
  if (!SHOW_LAST) lastBox.style.display = "none";
  REWIND_S = c.rewindSeconds || 30;
  MAX = c.maxCards;
  HK = { ask: "Control+Alt+A", ...(c.hotkeys || {}) };
  document.documentElement.style.setProperty("--say-pt", c.fontPt + "px");
  if (c.liveTextPt) document.documentElement.style.setProperty("--live-pt", c.liveTextPt + "px");
  // Key legend: shared modifiers once, then one key chip per action.
  const items = ["ask", "rewind", "checklist", "pause", "clear"].filter((k) => HK[k]).map((k) => [fmtKey(HK[k]).split("+"), tr("keys." + k)]);
  items.splice(Math.min(3, items.length), 0, [["Ctrl", "Opt", "1-3"], tr("keys.copy")]); // chip keys (fixed in main.cjs); Ctrl+Opt+K = chip 1, so it has no row of its own
  let common = items.length ? items[0][0].slice(0, -1) : [];
  for (const [p] of items) {
    let n = 0;
    while (n < common.length && p[n] === common[n] && n < p.length - 1) n++;
    common = common.slice(0, n);
  }
  const keys = document.getElementById("keys");
  keys.replaceChildren();
  if (common.length) {
    const it = span("it");
    it.dir = "ltr";
    common.forEach((m, i) => {
      it.append(Object.assign(document.createElement("kbd"), { textContent: m }));
      if (i < common.length - 1) it.append("+");
    });
    it.append(" +");
    keys.append(it);
  }
  for (const [p, label] of items) {
    const it = span("it");
    it.dir = UIDIR;
    const kb = document.createElement("kbd");
    kb.textContent = p.slice(common.length).join("+");
    it.append(kb, span("", label));
    keys.append(it);
  }
  refreshState();
});
// "Listening for your question…" indicator: shown from the ask key until the user has spoken or `until` passes.
const askEl = document.getElementById("ask");
let askTimer,
  askUntil = 0;
// seconds left come from the real armed window (run.ts askUntil), redrawn every second
const drawAsk = () => {
  const s = WingmanAsk.askSecondsLeft(askUntil, Date.now());
  if (s === null) {
    askEl.style.display = "none";
    clearInterval(askTimer);
    return;
  }
  askEl.style.display = "flex";
  askEl.textContent = tr("ask.listening", { left: s < 60 ? tr("ask.seconds", { n: s }) : Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") });
};
window.wingman.onAsk((a) => {
  clearInterval(askTimer);
  askUntil = a && a.on ? a.until || 0 : 0;
  // a row replayed from an old call (window reloaded) has `until` in the past: no indicator
  drawAsk();
  if (askUntil) askTimer = setInterval(drawAsk, 500);
});
window.wingman.onCard(render);
/** Applies the UI language to the page chrome: <html lang/dir>, the direction of the strips, and every [data-i18n] label. Card content keeps its own line direction. */
function setLanguage(lang) {
  const L = WingmanStrings.normLang(lang),
    changed = L !== LANG;
  LANG = L;
  UIDIR = WingmanStrings.dirOf(L);
  const root = document.documentElement;
  root.lang = L;
  root.dir = UIDIR;
  for (const id of ["frame", "flow", "you", "last"]) document.getElementById(id).dir = UIDIR;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = tr(el.dataset.i18n);
  if (changed) {
    refreshState();
    drawHealth();
  }
}
setLanguage(LANG);
drawHealthDot();
// Clears everything about the call (client data too), so nothing stays on screen after the call or when a new call starts.
function wipe() {
  askUntil = 0;
  clearInterval(askTimer);
  askEl.style.display = "none";
  frameBox.style.display = "none";
  frameBox.classList.remove("open");
  for (const v of tipEls.values()) v.remove();
  tipEls.clear();
  lastBox.style.display = "none";
  clearCards();
  for (const v of sides.values()) v.remove();
  sides.clear();
  noteList.replaceChildren();
  notesBox.style.display = "none";
  lines.length = 0;
  for (const n of caps.values()) n.remove();
  caps.clear();
  capBox.style.display = "none";
  rewindBox.style.display = "none";
  rNew.style.display = "none";
  bars.clear();
  NAMES.clear();
  flowBox.classList.remove("on");
  youBox.classList.remove("on");
  drawHealth();
  quiet = false;
  pausedNew = 0;
  liveEl.textContent = "";
}
window.wingman.onReset(() => {
  wipe();
  phase = "starting";
  realPhase = false;
  liveAt = 0;
  clearTimeout(startTimer);
  refreshState();
});
// Real phase from call.json. {phase:null} = the call writes none: fall back to the 4 s timer.
window.wingman.onPhase((p) => {
  if (!p || phase === "ended") return;
  if (p.phase === null) {
    realPhase = false;
    if (phase === "starting") {
      clearTimeout(startTimer);
      startTimer = setTimeout(listening, 4000);
    }
    return;
  }
  realPhase = true;
  clearTimeout(startTimer);
  liveAt = p.liveAt || 0;
  phase = p.phase === "live" ? "listening" : p.phase;
  refreshState();
});
window.wingman.onEnded(() => {
  wipe();
  phase = "ended";
  refreshState();
});
window.wingman.onClear(clearCards);
window.wingman.onPause(() => {
  paused = !paused;
  document.body.classList.toggle("paused", paused);
  if (!paused && pausedNew > 0) {
    // back from pause: the latest answer that came in is on screen, marked for a few seconds
    const hero = [...cards.values()].pop();
    if (hero) {
      hero.classList.add("fresh");
      setTimeout(() => hero.classList.remove("fresh"), 4000);
      announce(hero._label, hero.querySelector(".say")?.textContent || "");
    }
  }
  pausedNew = 0;
  layoutRoles();
  refreshState();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") clearCards();
});
refreshState();
