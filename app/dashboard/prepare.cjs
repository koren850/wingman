"use strict";
// "Prepare" for a meeting plan: run src/prepare-cli.ts (the digest) as a child process and read the saved digest back. No Electron here, so tests can run it.
//   runPrepare({ exec, plan, attachDir, out, lang, timeoutMs })  -> { ok, digest: boolean, reason?, counts? }   (never throws, never returns file text)
//   readDigestModel(file)                                       -> the "before the call" model from the saved digest.json, or null
// exec(args, opts, cb) is execTsx from window.cjs (a test passes a fake). The child makes at most one model call (the digest) and prints one JSON line.
const nodeFs = require("node:fs");
const K = require("./knowslib.js");

const PLAN_KEYS = ["title", "who", "goal", "notes", "mustCover"];
const REASONS = ["empty", "no-digest", "failed", "raw", "timeout"];

function runPrepare(o) {
  const exec = o.exec;
  const plan = {};
  for (const k of PLAN_KEYS) plan[k] = typeof (o.plan || {})[k] === "string" ? o.plan[k].slice(0, 4000) : "";
  return new Promise((resolve) => {
    let done = false;
    const fin = (r) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    const timeoutMs = o.timeoutMs || 90_000;
    let p;
    try {
      p = exec(
        ["src/prepare-cli.ts"],
        {
          cwd: o.cwd,
          timeout: timeoutMs,
          maxBuffer: 1_000_000,
          env: { ...(o.env || process.env), WINGMAN_ATTACH_DIR: o.attachDir, FORCE_COLOR: "0", NO_COLOR: "1" },
        },
        (err, stdout) => {
          const line =
            String(stdout || "")
              .trim()
              .split("\n")
              .filter(Boolean)
              .pop() || "";
          /** @type {any} */
          let j = null;
          try {
            j = JSON.parse(line);
          } catch {
            /* no answer */
          }
          if (j && j.ok === true) {
            const reason = REASONS.includes(j.reason) ? j.reason : "";
            return fin({
              ok: true,
              digest: j.digest === true,
              ...(reason ? { reason } : {}),
              ...(j.counts && typeof j.counts === "object" ? { counts: j.counts } : {}),
            });
          }
          fin({ ok: true, digest: false, reason: err && err.killed ? "timeout" : "failed" });
        },
      );
      if (p && p.stdin) {
        p.stdin.on("error", () => {});
        p.stdin.end(JSON.stringify({ out: o.out, lang: o.lang === "he" ? "he" : "en", plan }));
      }
    } catch {
      fin({ ok: true, digest: false, reason: "failed" });
    }
  });
}

/** The model for "What Wingman knows" before the call, from digest.json. Null when the file is missing or not a digest. */
function readDigestModel(file, fs = nodeFs) {
  try {
    if (fs.statSync(file).size > 400_000) return null;
    const m = K.fromDigest(JSON.parse(fs.readFileSync(file, "utf8")));
    return K.count(m) ? m : null;
  } catch {
    return null;
  }
}

module.exports = { runPrepare, readDigestModel };
