// One-time move of the user's data from the repo folder (app/calls, app/data/private) to the data folder (shared/paths.cjs).
// COPY, never move: the old folders stay where they are, you can delete them later. Never overwrites a user's file in the new folder (copyOne explains the rule).
// Safe to run twice (a marker file ends it) and safe to be interrupted (a half-done copy resumes, files already copied are kept).
//   <app>/calls/<id>/...         -> <data>/calls/<id>/...       (the "latest" link and tray.log are not copied)
//   <app>/data/private/<x>       -> <data>/<x>                  (briefs/, entities.json, ...; denylist.txt and node_modules are not user data)
// <app> is the app folder (see paths.legacyCandidates).
const fs = require("node:fs");
const path = require("node:path");
const paths = require("./paths.cjs");

const MARKER = ".migrated-from-repo.json";
const PENDING = ".migrating.json";
const SKIP_PRIVATE = new Set(["denylist.txt", "node_modules", ".DS_Store"]);

/** All regular files below `dir` as { rel, size, mtimeMs }. Symlinks are ignored (never followed).
 *  @param {string} dir
 *  @param {(name: string) => boolean} [skipTop] names to skip at the top level */
function walk(dir, skipTop = () => false, rel = "", out = []) {
  let names;
  try {
    names = fs.readdirSync(path.join(dir, rel));
  } catch {
    return out;
  }
  for (const n of names) {
    const r = rel ? path.join(rel, n) : n;
    if (!rel && skipTop(n)) continue;
    let st;
    try {
      st = fs.lstatSync(path.join(dir, r));
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(dir, skipTop, r, out);
    else if (st.isFile()) out.push({ rel: r, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

/** Does the data folder already hold user data? Only the entries Wingman itself keeps count (`names`: calls, briefs, entities.json...):
 *  the folder is also Electron's own userData folder (Cache, Local Storage, ...), and our markers and the tray log are not data. */
function hasUserData(root, names = ["calls", "briefs", "entities.json"]) {
  return (
    names.some((n) => walk(path.join(root, n)).some((f) => !(n === "calls" && f.rel === "tray.log") && !f.rel.startsWith(".DS_Store"))) ||
    names.some((n) => {
      try {
        return fs.lstatSync(path.join(root, n)).isFile();
      } catch {
        return false;
      }
    })
  );
}

function mkdir700(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* not ours to chmod */
  }
}

/**
 * Is `dst` a truncated earlier copy of `src`: shorter, and byte-for-byte the beginning of it? That is exactly what a crash in the middle of an
 * older, non-atomic copy left behind.
 */
function isTruncatedCopy(src, dst, srcSize, dstSize) {
  if (dstSize >= srcSize) return false;
  try {
    return Buffer.compare(fs.readFileSync(src).subarray(0, dstSize), fs.readFileSync(dst)) === 0;
  } catch {
    return false;
  }
}

/**
 * Copies one file through "<dst>.part" and a rename, so a crash can never leave a short file under the real name.
 * Folders 700, file 600, same modified time (the retention purge goes by it). Returns:
 *   "copied"  the file was not there and is now;
 *   "repaired" (only while resuming) dst was a truncated earlier copy and was completed;
 *   "kept"    dst exists and is left alone.
 * The ownership rule: a file in the data folder is overwritten ONLY if it is provably our own unfinished copy (shorter, and a byte-prefix of the
 * source). Anything else that differs (the app or the user changed it after the first copy) belongs to the user: it is never touched, and it
 * does not count against the verification, so one rewritten file can never make the migration fail on every launch.
 */
function copyOne(src, dst, mtimeMs, size, resuming) {
  mkdir700(path.dirname(dst));
  let how = "copied";
  /** @type {import("node:fs").Stats | null} */
  let st = null;
  try {
    st = fs.lstatSync(dst);
  } catch {
    /* not there */
  }
  if (st) {
    if (!st.isFile()) throw new Error(`${dst} exists and is not a file`);
    if (resuming && st.isFile() && isTruncatedCopy(src, dst, size, st.size)) how = "repaired";
    else return "kept";
  }
  const part = dst + ".part";
  fs.copyFileSync(src, part);
  try {
    fs.chmodSync(part, 0o600);
  } catch {
    /* no POSIX modes (Windows) */
  }
  try {
    fs.utimesSync(part, mtimeMs / 1000, mtimeMs / 1000);
  } catch {
    /* cosmetic */
  }
  fs.renameSync(part, dst);
  return how;
}

/**
 * o: { dataDir, oldCalls, oldPrivate, log(msg) }. Returns { status, files, bytes, copied, message? }.
 * status: "none" (nothing to migrate) | "done-before" | "skipped" (new folder already has data) | "migrated" | "failed".
 */
function migrateUserData(o) {
  const sameSize = (f) => {
    try {
      return fs.statSync(f.dst).size === f.size;
    } catch {
      return false;
    }
  };
  const log = o.log || (() => {});
  const root = o.dataDir,
    newCalls = path.join(root, "calls");
  const marker = path.join(root, MARKER),
    pending = path.join(root, PENDING);
  if (fs.existsSync(marker)) return { status: "done-before", files: 0, bytes: 0, copied: 0 };
  const plan = [
    ...walk(o.oldCalls, (n) => n === "latest" || n === "tray.log").map((f) => ({ ...f, src: path.join(o.oldCalls, f.rel), dst: path.join(newCalls, f.rel) })),
    ...walk(o.oldPrivate, (n) => SKIP_PRIVATE.has(n)).map((f) => ({ ...f, src: path.join(o.oldPrivate, f.rel), dst: path.join(root, f.rel) })),
  ];
  if (!plan.length) return { status: "none", files: 0, bytes: 0, copied: 0 };
  const resuming = fs.existsSync(pending);
  const tops = [
    "calls",
    ...new Set(
      plan.filter((f) => f.dst.startsWith(root + path.sep) && !f.dst.startsWith(newCalls + path.sep)).map((f) => path.relative(root, f.dst).split(path.sep)[0]),
    ),
  ];
  if (!resuming && fs.existsSync(root) && hasUserData(root, tops)) {
    // The new folder is already in use: never mix. Remember the decision so this check (and the message) happens once.
    mkdir700(root);
    fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), status: "skipped", reason: "the data folder already had data" }, null, 2) + "\n", {
      mode: 0o600,
    });
    const message = `Wingman: your data folder ${root} already has data, so the older copy in ${path.dirname(o.oldCalls)} was not copied.`;
    log(message);
    return { status: "skipped", files: plan.length, bytes: 0, copied: 0, message };
  }
  mkdir700(root);
  fs.writeFileSync(pending, JSON.stringify({ at: new Date().toISOString(), files: plan.length }) + "\n", { mode: 0o600 });
  let copied = 0,
    bytes = 0;
  const kept = []; // files already in the data folder that we do not own (see copyOne): left as they are
  try {
    for (const f of plan) {
      const how = copyOne(f.src, f.dst, f.mtimeMs, f.size, resuming);
      if (how === "kept") {
        if (!sameSize(f)) kept.push(f.rel);
      } else copied++;
      bytes += f.size;
    }
    // Verify what this run wrote: every source file must be there, and the ones copied now must have the source's size.
    const bad = plan.filter((f) => {
      try {
        return !kept.includes(f.rel) && fs.statSync(f.dst).size !== f.size;
      } catch {
        return true;
      }
    });
    if (bad.length) throw new Error(`${bad.length} file(s) did not copy correctly (first: ${bad[0].rel})`);
  } catch (e) {
    const message = `Wingman: copying your data to ${root} failed (${/** @type {Error} */ (e).message}). Nothing was changed in the old folders; it will try again next start.`;
    log(message);
    return { status: "failed", files: plan.length, bytes, copied, message };
  }
  fs.writeFileSync(
    marker,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        status: "migrated",
        from: { calls: o.oldCalls, private: o.oldPrivate },
        files: plan.length,
        bytes,
        ...(kept.length ? { userOwned: kept } : {}),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  try {
    fs.rmSync(pending, { force: true });
  } catch {
    /* harmless */
  }
  const message = `Wingman: your data now lives in ${root} (${plan.length} files copied). The old copy was left in place: ${o.oldCalls} and ${o.oldPrivate}. Delete those yourself once you have checked.${kept.length ? ` ${kept.length} file(s) in the new folder differ from the old copy (changed since the first copy) and were left as they are, e.g. ${kept[0]}.` : ""}`;
  log(message);
  return { status: "migrated", files: plan.length, bytes, copied, message };
}

/** Runs the migration for a normal start. Does nothing when the environment redirects the data (tests, QA). Never throws. */
function ensureUserData(o = {}) {
  const env = o.env || process.env;
  try {
    if (paths.isRedirected(env) && !o.force) return { status: "redirected", files: 0, bytes: 0, copied: 0 };
    // Take the first old folder that has any data.
    const candidates = paths.legacyCandidates(o.appDir);
    const old = candidates.find((c) => fs.existsSync(c.calls) || fs.existsSync(c.private)) || candidates[candidates.length - 1];
    return migrateUserData({ dataDir: paths.dataDir(env, o.home), oldCalls: old.calls, oldPrivate: old.private, log: o.log || ((m) => console.error(m)) });
  } catch (e) {
    return { status: "failed", files: 0, bytes: 0, copied: 0, message: String((e && /** @type {Error} */ (e).message) || e) };
  }
}

module.exports = { migrateUserData, ensureUserData, hasUserData, MARKER, PENDING };
