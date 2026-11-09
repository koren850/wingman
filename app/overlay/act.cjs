"use strict";
// Answer window, main process side of the card controls (the `act` channel). The page sends { kind, cardId, ... } (validated again here by v2.cleanAct).
//   rate  -> calls/<id>/tags.jsonl, the same file and rows the Wingman window writes: { id, useful: "y" | "n", badge } (+ cardId, rating). "none" clears the rating.
//   event -> calls/<id>/overlay-events.jsonl, one row per control: { t, type: "overlay", name: pin | unpin | dismiss | recap, cardId }. The engine reads it (pinned cards stay, dismissed cards leave the memory loop).
// Files are owner-only. Every failure is returned as { ok:false, error }, never thrown: a control that cannot save must not stop the window.
const nodeFs = require("node:fs");
const nodePath = require("node:path");
const V2 = require("./v2.js");

const MAX_ROWS = 2000;
const readRows = (fs, file) => {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          const r = JSON.parse(l);
          return r && typeof r === "object" ? [r] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};

/** callDir: the call's folder (already resolved). msg: the raw message from the page. now: ms. */
function applyAct(callDir, msg, now, o) {
  const fs = (o && o.fs) || nodeFs,
    path = (o && o.path) || nodePath;
  const m = V2.cleanAct(msg && msg.kind, msg);
  if (!m) return { ok: false, error: "bad message" };
  try {
    if (m.kind === "rate") {
      const cards = readRows(fs, path.join(callDir, "cards.jsonl"));
      const card = [...cards].reverse().find((c) => c.id === m.cardId && !c.withdraw);
      if (!card || card.type === "capture" || card.health) return { ok: false, error: "card not ratable" };
      const file = path.join(callDir, "tags.jsonl");
      const tags = readRows(fs, file).filter((t) => t && t.id && t.id !== m.cardId);
      if (m.rating !== "none")
        tags.push({
          id: m.cardId,
          useful: m.rating === "useful" ? "y" : "n",
          badge: typeof card.badge === "string" ? card.badge : "ai",
          cardId: m.cardId,
          rating: m.rating,
        });
      const tmp = path.join(callDir, `.tags.jsonl.${process.pid}.tmp`);
      fs.writeFileSync(
        tmp,
        tags.length
          ? tags
              .slice(-MAX_ROWS)
              .map((t) => JSON.stringify(t))
              .join("\n") + "\n"
          : "",
        { mode: 0o600 },
      );
      fs.renameSync(tmp, file);
      return { ok: true };
    }
    fs.appendFileSync(path.join(callDir, "overlay-events.jsonl"), JSON.stringify({ t: now, type: "overlay", name: m.name, cardId: m.cardId }) + "\n", {
      mode: 0o600,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

/** The card ids the user pinned in this call: the last pin or unpin event of each card decides. Used to restore the pins when the page is reloaded. */
function pinnedIds(callDir, o) {
  const fs = (o && o.fs) || nodeFs,
    path = (o && o.path) || nodePath;
  const on = new Set();
  for (const r of readRows(fs, path.join(callDir, "overlay-events.jsonl"))) {
    if (typeof r.cardId !== "string") continue;
    if (r.name === "pin") on.add(r.cardId);
    else if (r.name === "unpin" || r.name === "dismiss") on.delete(r.cardId);
  }
  return [...on].slice(-200);
}

module.exports = { applyAct, pinnedIds };
