# Golden meetings

Invented calls used to measure Wingman. No real names, companies or data.

## What is here

- `dev/` (32 files): free to read and to tune on.
  - 16 core meetings: 8 types, each in English and in Hebrew.
  - 8 `dev-noq-*` meetings (problem, numbers, decision, objection, English and Hebrew): the card must show for a line with no "?" and no question word. `noq` means "no question".
  - 8 variety meetings (English and Hebrew): a 45 minute monologue, cross-talk, three speakers, speech-to-text errors, a meeting where silence is right.
- `test/` (8 files): held out. Different scenarios from dev, with noisy speech-to-text text (no question marks, near-sound words, split sentences). Two of them are Hebrew with English terms.
- `test-b/` (14 files): a second held-out split. 8 `noq` meetings, 2 speech-to-text error meetings, 2 cross-talk meetings and 2 silent meetings, English and Hebrew in equal number. It was written by the same author as the dev set, so it is weaker than a split from an independent author.
- `test-c/` (8 files): a third held-out split, 4 English and 4 Hebrew, for the release check. It has speech-to-text errors in Hebrew (a split prefix, a dropped word, a number said in words, an English word in Hebrew letters), a meeting with three speakers talking over each other, a 50 second silence, and a topic jump. Only `pnpm eval --final --ship` reads it: the loader refuses without the flag. Read it once per release candidate. Do not tune on it.
  - Known limit: it is not truly blind. The same author who built the dev set wrote it. It was not used to tune the engine, but before a real release it should be replaced by a split from an independent author who sees only the schema and this README, and then locked.
- `src/*.txt`: the hand-written sources. The JSON files are built from them. Format: see the header of `qa/golden-build.ts`.

## The lock files

`test.lock`, `test-b.lock` and `test-c.lock` are in this folder, next to the split folders of the same name. Each one holds the sha256 of the files of that split, so an accidental edit is caught. They are tracked on purpose, and code and tests read them. `pnpm eval --final` checks `test` and `test-b` and reads them; `pnpm eval --final --ship` also checks `test-c` and reads it. Do not read or tune on the held-out splits any other way. If you change a held-out meeting on purpose, rebuild (`tsx qa/golden-build.ts`) and say so in the commit.

## What a meeting file holds

Each meeting has lines (with the time each one becomes final), moments (a card of a kind is expected after a line, with tokens the card text must hold), silent windows (a card there is a failure), memory checks, and `script` entries (scripted model replies for the moment, memory, ask and digest roles). The files are marked `scripted: true`: they prove plumbing, timing and the grader. They do not prove model judgement or Hebrew quality. Record real replies with the cassette tool ([Recording evals](../../../docs/RECORDING-EVALS.md)).

Long pauses (`.. 40` in the sources) stand for screen sharing, reading and typing. They keep each meeting over 6 minutes.

## Commands (from `app/`)

    tsx qa/golden-build.ts          rebuild the JSON files and the lock files from src/*.txt
    pnpm eval                        live-reading metrics on dev, four bad-model controls and a Classic smoke test (in-sample, not the headline)
    pnpm eval --meetings             one line per dev meeting
    pnpm eval --update               rewrite qa/eval-baseline.json (review the diff)
    pnpm eval --ship                 also judge the absolute ship gates in qa/ship.json: pass or FAIL per line; recorded-only lines print n/a (scripted)
    pnpm eval --final                read the held-out splits test and test-b once (checks the lock files)
    pnpm eval --final --ship         also read test-c and judge the ship gates on it
    pnpm eval --broken shuffled      play a deliberately broken engine: the eval must exit 1
    tsx scripts/cassette-record.ts --suite dev --cap 5    record real model replies (needs a key, never in CI; prints an estimate first)

## Labels that matter

- `noq` (tag on a moment): the line, and the line before it, have no "?" and no question word, in English or Hebrew. The builder and a unit test enforce it (`qa/golden-noq.ts`). Whatever replaces the word lists is judged by these moments.
- `x:` (allowedExtra): a card that is not a labelled moment but is useful (a tip, an open loop, a term). If it matches, it is neither right nor wrong: precision ignores it.
- `silent` windows: a card there is a failure. A meeting of type `silence` is one big silent window.

## Ship gates (qa/ship.json)

`qa/eval-baseline.json` says "not worse than last time". `qa/ship.json` says "good enough to release": precision by kind at least 0.80, recall at least 0.80, recall with no "?" at least 0.85, duplicates at most 3 percent, at most 0.02 cards a minute in silent windows, at most 40 cards an hour, English and Hebrew within 5 points on recall and on precision, no wrong-language card, cost at most $0.25 an hour. Two lines, memory F1 and the direct-question first card p95, are `recordedOnly`: on scripted replies they print `n/a (scripted)`. The four bad-model controls must also fail the gate, or the gate can be fooled. A scripted pass is not a release pass: the release check needs the same lines to pass on a recorded cassette.

## Bad models (controls)

`qa/controls.ts` plays four deliberately bad models through the real engine: `null` (always SKIP), `noise` (random kind and words), `shuffled` (the scripted replies moved to other slots) and `always-ans` (one fixed answer for every call). Each must score under its limit (`CONTROL_LIMITS` in `qa/grade-golden.ts`). If one does not, the grader can be fooled and the eval fails. The eval runs them on every fourth meeting.

## Metrics (qa/grade-golden.ts, qa/eval-v2.ts, qa/judge.ts)

A moment is recalled when a card of the same kind shows between the line and `latestMs` later, and its text holds every `mustMention` token (letters and digits only, any case). Precision is correct cards over all cards except labelled extras. Also: direct-question recall, recall on `noq` moments, recall by language, time to card p50 and p95, cards per minute inside silent windows, wrong-card rate, duplicate rate, wrong-language rate, memory-check pass rate (`gradeMemory`), guard breaches on the answer and prompt cards, noisy-ASR loss (the same meetings without punctuation), modelled cost per hour, and a rubric judge (relevant, in the call language, not a repeat, inside the time window). `qa/judge.ts` also has a model judge that replays its verdicts from a cassette; only a maintainer with a key records new ones.

The replies in the golden files are scripted, so every number here proves plumbing, timing and the grader. It does not prove model judgement.
