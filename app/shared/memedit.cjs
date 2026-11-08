"use strict";
// The one rule for "the user edits what Wingman knows": a strict validator for the edit message. Used by the window's main process
// (dashboard/window.cjs), by the engine side (src/session/useredit.ts) and by the tests, so both sides accept exactly the same thing.
//
//   { op: "edit",   id, text }     change the text of one line (ids look like f3, q2, c1; ids are made by code, never by the model)
//   { op: "remove", id }           take one line away
//   { op: "add",    list, text }   add one line (facts, decisions, openQuestions, commitments, mustCover)
//
// Text is cleaned (no control or bidi characters, one line) and must be 1 to 200 characters. Anything else is rejected with a short reason.
const ID_RE = /^([fncqdomp])([1-9]\d{0,5})$/;
const ADD_LISTS = ["facts", "decisions", "openQuestions", "commitments", "mustCover"];
const MAX_TEXT = 200;
const MAX_RAW = 2000;
const BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** One line, no control or bidi characters. Not clipped here: too long is a rejection. */
function cleanLine(v) {
  if (typeof v !== "string" || v.length > MAX_RAW) return "";
  return v.replace(BAD, "").replace(/\s+/g, " ").trim();
}

/** @returns {{ ok: true, edit: object } | { ok: false, reason: string }} */
function validateEdit(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not an object" };
  const keys = Object.keys(raw);
  const only = (allowed) => keys.every((k) => allowed.includes(k));
  const op = raw.op;
  if (op === "remove") {
    if (!only(["op", "id"])) return { ok: false, reason: "unknown field" };
    if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) return { ok: false, reason: "bad id" };
    return { ok: true, edit: { op, id: raw.id } };
  }
  if (op === "edit") {
    if (!only(["op", "id", "text"])) return { ok: false, reason: "unknown field" };
    if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) return { ok: false, reason: "bad id" };
    const text = cleanLine(raw.text);
    if (!text) return { ok: false, reason: "empty text" };
    if (Array.from(text).length > MAX_TEXT) return { ok: false, reason: "text too long" };
    return { ok: true, edit: { op, id: raw.id, text } };
  }
  if (op === "add") {
    if (!only(["op", "list", "text"])) return { ok: false, reason: "unknown field" };
    if (!ADD_LISTS.includes(raw.list)) return { ok: false, reason: "bad list" };
    const text = cleanLine(raw.text);
    if (!text) return { ok: false, reason: "empty text" };
    if (Array.from(text).length > MAX_TEXT) return { ok: false, reason: "text too long" };
    return { ok: true, edit: { op, list: raw.list, text } };
  }
  return { ok: false, reason: "unknown op" };
}

/** The section names the window uses -> the memory list an added line goes to. */
const SECTION_LIST = {
  soFar: "facts",
  decisions: "decisions",
  open: "openQuestions",
  promises: "commitments",
  mustCover: "mustCover",
  facts: "facts",
  agenda: "mustCover",
};

module.exports = { ID_RE, ADD_LISTS, MAX_TEXT, cleanLine, validateEdit, SECTION_LIST };
