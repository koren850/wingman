"use strict";
// Start-up and navigation. Loaded last (app.js, home.js, live.js and settings.js define $, api, state and the views).
$("brand").addEventListener("click", () => viewHome());
$("nav-home").addEventListener("click", () => viewHome());
$("nav-list").addEventListener("click", () => {
  loadList()
    .then(() => viewInbox())
    .catch(() => showListError());
});
$("nav-settings").addEventListener("click", () => viewSettings());
// Theme override only for screenshots/tests (?theme=light|dark); normally follows the system.
{
  const th = new URLSearchParams(location.search).get("theme");
  if (th === "light" || th === "dark") document.documentElement.dataset.theme = th;
}

// `api` is the preload bridge (window.wingman). The menu bar can ask the open window to go somewhere (Plan, Readiness check). It never opens the window by itself during a call.
api.onCallState((s) => onCallState(s));
api.onNav((o) => {
  if (o && o.view === "call" && o.id) {
    loadList()
      .then(() => openCall(String(o.id), { tab: o.tab || undefined }))
      .catch(() => showListError());
    return;
  }
  if (o && o.view === "settings") return viewSettings(o.focus);
  if (o && o.view === "inbox")
    return loadList()
      .then(() => viewInbox())
      .catch(() => showListError());
  viewHome(o && o.focus);
});

setNav();
Promise.all([
  loadList(),
  api
    .callState()
    .then((s) => {
      state.call = s;
      renderCallSlot();
    })
    .catch(() => {}),
])
  .then(() => {
    const q = new URLSearchParams(location.search); // screenshot aids: ?call=<id>&tab=rate&x=unrated  |  ?view=home|inbox|settings&focus=plan|advanced
    const view = q.get("view");
    if (view === "settings" || view === "system") return viewSettings(q.get("focus"));
    if (view === "inbox" || view === "calls") return viewInbox();
    if (q.get("call")) {
      const n = normTab(q.get("tab"), q.get("x"));
      return openCall(q.get("call"), { tab: n.tab || undefined, filter: n.filter, line: n.line, sub: n.sub });
    }
    viewHome(q.get("focus"));
  })
  .catch(() => {
    const main = $("main");
    main.textContent = "";
    main.append(errorState("Wingman could not load", () => location.reload()));
    ready();
  });
