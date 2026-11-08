// Edge cases for context modes: mode switching, custom mode parsing, the local tail, name matching limits. Offline and pure.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCustomModes, MAX_MODE_TEXT } from "./pack.ts";
import { setMode } from "./session/patch.ts";
import { emptyMemory } from "./session/types.ts";
import { localTail, memoryForAsk } from "./engine/tail.ts";
import { matchRoster, foldName, editDistance } from "./context/names.ts";
import { fitCalibration } from "./context/calibration.ts";

test("setMode: built-in locks, custom id keeps the kind and locks, auto unlocks and clears, unknown is refused", () => {
  const m0 = emptyMemory(0, "other");
  const t = setMode(m0, "team", 5)!;
  assert.equal(t.kind, "team");
  assert.equal(t.kindLocked, true);
  assert.equal(setMode(t, "team", 6), t, "same mode again changes nothing");
  assert.equal(setMode(m0, "nope", 5), undefined);
  assert.equal(setMode(m0, "nope", 5, ["other-id"]), undefined);
  const c = setMode(t, "deep-dive", 7, ["deep-dive"])!;
  assert.equal(c.modeId, "deep-dive");
  assert.equal(c.kind, "team");
  assert.equal(c.kindLocked, true);
  const a = setMode(c, "auto", 8)!;
  assert.equal(a.kindLocked, false);
  assert.equal(a.modeId, undefined);
  assert.equal(setMode(a, "auto", 9), a, "auto on an unlocked memory changes nothing");
  assert.equal(setMode(t, "interview", 9)!.modeId, undefined, "a built-in kind clears a custom id");
});

test("custom modes: wrapper form, ids that clash with kinds or auto, duplicates and non-strings are skipped; the cap counts characters", () => {
  const raw = `modes:
  - id: auto
    instructions: x
  - id: team
    instructions: x
  - id: Deep-Dive
    label: Deep
    instructions: "😀${"a".repeat(700)}"
  - id: deep-dive
    instructions: dup
  - id: 5
    instructions: x
  - id: empty
    instructions: "   "
  - id: ok
    instructions: 12
`;
  const m = parseCustomModes(raw);
  assert.deepEqual(
    m.map((x) => x.id),
    ["deep-dive"],
  );
  assert.equal(Array.from(m[0].instructions).length, MAX_MODE_TEXT);
  assert.deepEqual(parseCustomModes("not: [valid"), []);
  assert.deepEqual(parseCustomModes(""), []);
});

test("localTail: empty input, one huge line, and the line cap", () => {
  assert.equal(localTail([]), "");
  const big = localTail(["x".repeat(20000)], 100);
  assert.ok(big.length <= 300);
  const many = localTail(
    Array.from({ length: 200 }, () => "a"),
    100000,
    30,
  );
  assert.equal(many.split("\n").length, 30);
  assert.equal(memoryForAsk(emptyMemory(0)), "");
});

test("names: short names and unrelated words do not match; folding is stable", () => {
  assert.equal(matchRoster("al", ["Alex"]), undefined);
  assert.equal(matchRoster("budget", ["Dana"]), undefined);
  assert.equal(matchRoster("Dana", []), undefined);
  assert.equal(matchRoster("דינה", ["דנה"])?.name, "דנה");
  assert.equal(foldName("Dána"), "dana");
  assert.equal(editDistance("", "abc"), 3);
  assert.equal(editDistance("ab", "ba"), 1);
});

test("calibration: a fit with all-zero ascii counts is refused instead of throwing", () => {
  const rows = Array.from({ length: 10 }, () => ({ chars: { ascii: 0, hebrew: 0, other: 0 }, actual: 10 }));
  assert.equal(fitCalibration(rows), undefined);
  const hebOnly = Array.from({ length: 10 }, (_, i) => ({ chars: { ascii: 0, hebrew: 100 + i, other: 0 }, actual: 60 + i * 0.6 }));
  const f = fitCalibration(hebOnly);
  assert.ok(f === undefined || f.hebrewTokensPerChar > 0);
});
