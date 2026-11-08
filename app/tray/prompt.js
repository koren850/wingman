// Page script for prompt.html: shows the "note" form (or "brief" via ?kind=brief) in English or Hebrew (?lang=), sends the fields to main through preload's window.wingman.submit.
// Esc and Cancel close the window. Main closes it after a submit. (Separate file because the CSP allows only script-src 'self'.)
const params = new URLSearchParams(location.search);
const kind = params.get("kind") === "brief" ? "brief" : "note";
const lang = params.get("lang") === "he" ? "he" : "en";
document.documentElement.lang = lang;
document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
for (const el of document.querySelectorAll("[data-t]")) el.textContent = window.WingmanPromptText.pt(lang, el.getAttribute("data-t"));
const form = document.getElementById(kind);
form.hidden = false;
const first = form.querySelector("input");
first && first.focus();
for (const b of document.querySelectorAll(".cancel")) b.addEventListener("click", () => window.close());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.close();
});
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = (id) => document.getElementById(id).value;
  const data = kind === "note" ? { text: v("noteText") } : { who: v("who"), goal: v("goal"), notes: v("notes"), mustCover: v("mustCover") };
  await window.wingman.submit(kind, data);
});
document.body.dataset.ready = "1";
