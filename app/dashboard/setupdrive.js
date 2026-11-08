// Page script for WINGMAN_DASHBOARD_EVAL (dashboard/snapshot.sh): drives the first-run window like a person would, in the hidden window, and writes what it saw to
// <snapshot>.json. Steps (from the focus "setup-keys"): paste a fake key in each field, press Check and save, wait, then report the state of the window.
// Used with WINGMAN_DASHBOARD_FAKE_CONNECT=ok|invalid|nocredit|network|unavailable (main process answers keys:connect with that word; nothing real is touched).
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (sel) => (document.querySelector(sel) ? document.querySelector(sel).textContent.replace(/\s+/g, " ").trim() : null);
  const out = { before: { step: text(".wiz-steps li[aria-current] "), inputs: document.querySelectorAll("#wizard input[type=password]").length } };
  for (const p of ["deepgram", "anthropic"]) {
    const el = document.getElementById("wiz-key-" + p);
    if (el) el.value = p === "deepgram" ? "dgFAKEFAKEFAKEFAKEFAKEFAKE0001" : "sk-ant-FAKEFAKEFAKEFAKEFAKEFAKE0002";
  }
  const b = document.getElementById("wiz-check");
  out.hadButton = !!b;
  if (b) b.click();
  await wait(700);
  out.after = {
    step: text(".wiz-steps li[aria-current]"),
    errors: [...document.querySelectorAll("#wizard .wiz-err")].map((e) => e.textContent.replace(/\s+/g, " ").trim()),
    chips: [...document.querySelectorAll("#wizard .chip")].map((e) => e.textContent.replace(/\s+/g, " ").trim()),
    fixes: [...document.querySelectorAll("#wizard [id^=wiz-fix-], #wizard [id^=wiz-recheck-]")].map((e) => e.id),
    inputsLeft: [...document.querySelectorAll("#wizard input[type=password]")].map((e) => e.value.length),
    next: !!document.getElementById("wiz-next"),
  };
  const nxt = document.getElementById("wiz-next");
  if (nxt) {
    nxt.click();
    await wait(400);
    out.afterContinue = { step: text(".wiz-steps li[aria-current]"), heading: text("#wiz-h") };
  }
  return out;
})();
