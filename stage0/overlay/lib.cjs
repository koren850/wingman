// Pure helpers for overlay/main.cjs (kept apart so tests can run them without Electron):
// call.json phase parsing and the Ctrl+Opt+1..3 "copy captured value" keys.

const PHASES = ["starting", "waiting", "live", "ended"];
const CAPTURE_MAX = 3;
const CAPTURE_MOD = "Control+Alt+";

/** call.json text -> { phase, liveAt } | { phase: null } (file fine, no phase yet: use the timer fallback) | null (unreadable). */
function callPhase(raw) {
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const liveAt = Number(j.liveAt) > 0 ? Number(j.liveAt) : 0;
  if (j.endedAt) return { phase: "ended", liveAt };
  if (PHASES.includes(j.phase)) return { phase: j.phase, liveAt };
  return { phase: null, liveAt };
}

/** Newest-first list of captured values: no repeats, at most 3. Returns the same array when nothing changed. */
function pushCapture(list, value) {
  if (typeof value !== "string" || !value || list.includes(value)) return list;
  return [value, ...list].slice(0, CAPTURE_MAX);
}

/** Accelerator string for capture chip n, e.g. "Control+Alt+2". */
const captureAccel = (n) => CAPTURE_MOD + n;

/** Registers Ctrl+Opt+1..3 (chip N = Nth newest). Keys already used by the window's own hotkeys are skipped. Returns the accelerators it holds. */
function registerCaptureKeys(gs, getList, onCopy, taken = []) {
  const held = [];
  for (let n = 1; n <= CAPTURE_MAX; n++) {
    const acc = captureAccel(n);
    if (taken.includes(acc)) continue;
    let ok = false;
    try { ok = gs.register(acc, () => { const v = getList()[n - 1]; if (v) onCopy(v); }); } catch {}
    if (ok) held.push(acc);
  }
  return held;
}
/** Releases the accelerators returned by registerCaptureKeys and empties `held`. */
function unregisterCaptureKeys(gs, held) { for (const a of held) { try { gs.unregister(a); } catch {} } held.length = 0; }

module.exports = { PHASES, CAPTURE_MAX, callPhase, pushCapture, captureAccel, registerCaptureKeys, unregisterCaptureKeys };
