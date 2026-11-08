# Golden meetings

Invented calls used to measure Wingman. No real names, companies or data.

- `dev/` (16 files): free to read and to tune on. 8 types, each in English and in Hebrew.
- `test/` (8 files): held out. Different scenarios from dev, written in a second pass, with noisy ASR text (no question marks, near-sound words, split sentences). Two of them are Hebrew with English terms.
- `test.lock`: sha256 of the test files. `pnpm eval --final` checks it and reads the test split. Do not read or tune on test any other way. If you change a test meeting on purpose, rebuild (`tsx qa/golden-build.ts`) and say so in the commit.
- `src/*.txt`: the hand-written sources. The JSON files are built from them. Format: see the header of `qa/golden-build.ts`.

Each meeting has lines (with the time each one becomes final), moments (a card of a kind is expected after a line, with tokens the card text must hold), silent windows (a card there is a failure), memory checks, and `script` entries (scripted model replies for the moment, memory, ask and digest roles, in the PLAN 3.2 and 3.1 formats). The files are marked `scripted: true`: they prove plumbing, timing and the grader. They do not prove model judgement or Hebrew quality. Record real replies later with the cassette tool.

Long pauses (`.. 40` in the sources) stand for screen sharing, reading and typing. They keep each meeting over 6 minutes.

## Commands (from `app/`)

    tsx qa/golden-build.ts          rebuild the JSON files and test.lock from src/*.txt
    pnpm eval                        legacy gates (in-sample) + golden metrics on dev + negative controls
    pnpm eval --meetings             one line per dev meeting
    pnpm eval --update               rewrite qa/eval-baseline.json (review the diff)
    pnpm eval --final                read the held-out test split once

## Metrics (qa/grade-golden.ts)

A moment is recalled when a card of the same kind shows between the line and `latestMs` later, and its text holds every `mustMention` token (letters and digits only, any case). Precision is correct cards over all cards. Also: direct-question recall, time to card p50 and p95, cards per minute inside silent windows, wrong-card rate, duplicate rate, wrong-language rate, memory-check pass rate (`gradeMemory`), and guard breaches on answer and prompt cards.
