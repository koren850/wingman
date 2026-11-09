"use strict";
// Start-up and navigation. Loaded last (app.js, home.js, live.js and settings.js define $, api, state and the views).
// Window language first: everything drawn after this uses T(). ?lang=he|en is a screenshot aid and wins over the saved choice.
{
  const q = new URLSearchParams(location.search).get("lang");
  const loc = (navigator.languages && navigator.languages[0]) || navigator.language || "en";
  const lang = q === "he" || q === "en" ? q : WingmanI18n.resolve(windowLangChoice(), loc);
  WingmanI18n.setLang(lang);
  const root = document.documentElement;
  root.lang = lang;
  root.dir = WingmanI18n.dirOf(lang);
  const skip = document.querySelector("a.skip");
  if (skip) skip.textContent = T("nav.skip");
  const brand = $("brand");
  brand.setAttribute("aria-label", T("nav.homeAria"));
  brand.title = T("nav.homeTitle");
  document.querySelector("nav").setAttribute("aria-label", T("nav.main"));
}
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
      // An update pushed while this answer was on its way is newer than it: keep that one.
      if (state.call) return;
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
      const opened = openCall(q.get("call"), { tab: n.tab || undefined, filter: n.filter, line: n.line, sub: n.sub });
      // screenshot aid: x=saw opens "What this card saw" on the first card
      if (q.get("x") === "saw")
        return Promise.resolve(opened).then(() => {
          const b = document.querySelector("#cardlist .trust-btns button:last-child");
          if (b) b.click();
        });
      return opened;
    }
    viewHome(q.get("focus"));
  })
  .catch(() => {
    const main = $("main");
    main.textContent = "";
    main.append(errorState(T("app.loadError"), () => location.reload()));
    ready();
  });
