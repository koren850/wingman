// Pure helpers for overlay/main.cjs (kept apart so tests can run them without Electron):
// call.json phase parsing and the Ctrl+Opt+1..3 "copy captured value" keys.

const PHASES = ["starting", "waiting", "live", "ended"];
const CAPTURE_MAX = 3;
const CAPTURE_MOD = "Control+Alt+";

/** call.json text -> { phase, liveAt } | { phase: null } (file fine, no phase yet: use the timer fallback) | null (unreadable). */
function callPhase(raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
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
    try {
      ok = gs.register(acc, () => {
        const v = getList()[n - 1];
        if (v) onCopy(v);
      });
    } catch {}
    if (ok) held.push(acc);
  }
  return held;
}
/** Releases the accelerators returned by registerCaptureKeys and empties `held`. */
function unregisterCaptureKeys(gs, held) {
  for (const a of held) {
    try {
      gs.unregister(a);
    } catch {}
  }
  held.length = 0;
}

// The overlay's own small settings file (overlay-state.json in the data folder): how many cards it has shown in its life.
// The key hints hide after the first few. Owner-only file; a missing or broken file counts as zero; a write that fails is ignored.
const STATE_FILE = "overlay-state.json";
const MAX_SHOWN = 1e6;
/** Cards shown so far, from the state file text. Anything unreadable is 0. */
function parseShown(raw) {
  try {
    const n = Number(JSON.parse(raw).cardsShown);
    return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_SHOWN) : 0;
  } catch {
    return 0;
  }
}
/** Reads the count. `fs` and `dir` are injected so a test needs no Electron. */
function readShown(fs, path, dir) {
  try {
    return parseShown(fs.readFileSync(path.join(dir, STATE_FILE), "utf8"));
  } catch {
    return 0;
  }
}
/** Writes the count through a temp file and a rename. Returns true when it was saved. */
function writeShown(fs, path, dir, n) {
  try {
    const file = path.join(dir, STATE_FILE);
    const tmp = file + "." + process.pid + ".tmp";
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify({ cardsShown: Math.min(MAX_SHOWN, Math.max(0, Math.floor(n))) }) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The orphan guard's exit: clears every timer and listener the window owns, then exits. Safe to call twice, never throws.
 * timers() returns the handles that exist now (they change over the window's life), follow is the display follower, unregister drops the global keys, exit ends the process.
 */
function makeBye({ timers, follow, unregister, exit }) {
  let done = false;
  return function bye() {
    if (done) return;
    done = true;
    try {
      for (const t of timers()) {
        clearInterval(t);
        clearTimeout(t);
      }
    } catch {}
    try {
      const f = follow();
      if (f) f.detach();
    } catch {}
    try {
      unregister();
    } catch {}
    exit(0);
  };
}

module.exports = {
  makeBye,
  STATE_FILE,
  parseShown,
  readShown,
  writeShown,
  PHASES,
  CAPTURE_MAX,
  callPhase,
  pushCapture,
  captureAccel,
  registerCaptureKeys,
  unregisterCaptureKeys,
};
