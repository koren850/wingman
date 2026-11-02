"use strict";
// Start-up and navigation. Loaded last (home.js and settings.js define the views).
$("brand").addEventListener("click", () => viewHome());
$("nav-home").addEventListener("click", () => viewHome());
$("nav-list").addEventListener("click", () => { loadList().then(() => viewInbox()); });
$("nav-settings").addEventListener("click", () => viewSettings());
// Visual skin: "" = original look; "a" (Night yuzu), "b" (Warm paper), "c" (Bold focus). ?skin= is for screenshots (WINGMAN_DASHBOARD_SKIN).
// To make one permanent, set DEFAULT_SKIN below, e.g. const DEFAULT_SKIN = "b";
const DEFAULT_SKIN = "";
{ const sk = new URLSearchParams(location.search).get("skin") || DEFAULT_SKIN; if (/^[abc]$/.test(sk)) document.documentElement.dataset.skin = sk; }
// Theme override only for screenshots/tests (?theme=light|dark); normally follows the system.
{ const th = new URLSearchParams(location.search).get("theme"); if (th === "light" || th === "dark") document.documentElement.dataset.theme = th; }

// The menu bar can ask the open window to go somewhere (Plan a call, Check everything). It never opens the window by itself during a call.
api.onCallState((s) => onCallState(s));
api.onNav((o) => {
  if (o && o.view === "call" && o.id) { loadList().then(() => openCall(String(o.id), { tab: o.tab || undefined })); return; }
  if (o && o.view === "settings") return viewSettings(o.focus);
  if (o && o.view === "inbox") return loadList().then(() => viewInbox());
  viewHome(o && o.focus);
});

setNav();
Promise.all([loadList(), api.callState().then((s) => { state.call = s; renderCallSlot(); }).catch(() => {})]).then(() => {
  const q = new URLSearchParams(location.search); // screenshot aids: ?call=<id>&tab=rate&x=unrated  |  ?view=home|inbox|settings&focus=plan|advanced
  const view = q.get("view");
  if (view === "settings" || view === "system") return viewSettings(q.get("focus"));
  if (view === "inbox" || view === "calls") return viewInbox();
  if (q.get("call")) { const n = normTab(q.get("tab"), q.get("x")); return openCall(q.get("call"), { tab: n.tab || undefined, filter: n.filter, line: n.line, sub: n.sub }); }
  viewHome(q.get("focus"));
}).catch((e) => { $("main").textContent = "Could not load: " + e.message; ready(); });
