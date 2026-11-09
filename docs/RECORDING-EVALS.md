# Recording evals

For maintainers. This page explains how to record a run where the real AI answers. That is the only way to get a **recorded** quality number. Everything else in the repository is **scripted** (fixtures), which checks the plumbing and the grader, not the AI's judgement ([ADR 62](DECISIONS.md#adr-62-scripted-is-not-recorded-every-number-is-labelled-and-release-needs-the-recorded-run)). The run costs money and needs real keys, so CI refuses it and automated agents must not start it.

## The command

Run pnpm from `app/`, so corepack uses the pinned version.

```bash
cd app
pnpm morning --cap 5 --estimate        # prints the cost and stops; needs no key
read -s ANTHROPIC_API_KEY; export ANTHROPIC_API_KEY    # paste the key, press Enter
pnpm morning --cap 5
```

`read -s` keeps the key out of the shell history and the screen. The key lives in the environment of this shell only; nothing reads a key file. Close the shell when you are done. Run it on a quiet machine, once. Use `--only dev,judge` to run part of it and `--skip test-c` to leave a split out.

## What it costs

One cap for the whole run. `--estimate` prints (a floor, from the modelled usage):

| Step | What it records | Estimate |
|---|---|---|
| dev | the 32 dev meetings, with the model judge, then the dev eval and the cost check | about $0.49 |
| memory | 24 calls through the real memory updater | about $0.04 |
| judge | 120 judgement cases through the real moment role | about $0.03 |
| test, test-b, test-c | the held-out meetings (each asks for a yes first) | about $0.06, $0.11, $0.06 |
| total | | about $0.79 |

Treat these as floors; plan for **3 to 5 USD** and keep `--cap 5`. Check the booked cost of the first step before you walk away. It refuses without a key, in CI, without `--cap`, and when the estimate is above the cap (`--allow-partial` stops at the cap instead). Wall time: about an hour for dev at real speed, about 10 to 15 minutes for each held-out split.

Reading a held-out split is a one-time act. The command asks "yes?" before each one. Answer no if you tuned anything since the last read.

## What it writes

- The folder `data/cassettes/` is created by the run. In it: `dev.cassette.json`, `memory.cassette.json`, `judge-set.cassette.json` and one file per held-out split. These are the recordings. Keep them; later runs replay them for free.
- `qa/recorded-baseline.json`: the `v2Recorded` numbers and the cassette they came from. Not written if the dev eval against the recording failed.
- `qa/out/morning.md`: one page with what ran, what each step cost, the cost check, the dev eval and the held-out read. Open this first.

## Then, by hand

The record command does not judge the ship lines. After it, from `app/`:

```bash
pnpm eval --ship --cassette data/cassettes/dev.cassette.json
```

Each line prints pass or FAIL, and now the two recorded-only lines (memory F1, direct first card p95) count. Then run one real, low-risk call and rate its cards with `pnpm tag`. Both are on the release gate ([ADR 62](DECISIONS.md#adr-62-scripted-is-not-recorded-every-number-is-labelled-and-release-needs-the-recorded-run)).

## If a line fails

| What you see | What it means | What to do |
|---|---|---|
| `refusing to run in CI`, `--cap ... is required`, `no ANTHROPIC_API_KEY` | A guard, not a bug. | Fix the command line or the environment. |
| `the estimate is above the cap` | Not enough budget for the steps you asked for. | Raise `--cap`, use `--only`, or add `--allow-partial`. |
| A step says `failed` | The call, the file or the key failed in that step. The others still ran. | Read the note in `qa/out/morning.md`. Re-run only that step: `--only <step>`. Recordings that exist are kept. |
| The recording has 0 entries and every call fails with "ANTHROPIC_API_KEY is missing" | Known bug: the engine start removes the key from the environment before the recording worker reads it (`src/engine/boot.ts`, `src/e2e/v2-worker.ts`). Not fixed in 0.0.1. | Read the key under another variable name for the worker. Check "0 entries" before you wait for a long run. |
| Model times in the recording look 4 times too long | The recording ran faster than real time (`--pace` above 1). | Record again at pace 1. |
| `STALE` or many cassette misses | A prompt changed after the recording. This is not a bug. | Record again (`--only dev`). `pnpm cassette:status --cassette <file>` shows the coverage. |
| Cost check over 15 percent (total or any role above 5 percent of cost) | The budgets in `qa/budgets.json` came from modelled usage and are wrong. | Do not change the engine. Move the budgets with `pnpm eval --cassette <file> --update` after you read the diff. |
| `recorded-baseline.json` not written | The dev eval against the recording failed. | Open the dev eval text in `qa/out/morning.md`; fix the cause, then run `pnpm eval --cassette data/cassettes/dev.cassette.json --update`. |
| A ship line FAILs on the recorded run | The AI's judgement is below the promise. | Do not lower `qa/ship.json`. Use `pnpm replay <call-folder> --prompt <file> --cassette <file>` to see what another prompt does, then record `dev` again. |
| A control (null, noise, shuffled, always-answer) passes the gate | The grader can be fooled. | Stop. The numbers of that run mean nothing. Open an issue. |
| The held-out numbers are far below dev | Dev was tuned on. Expected, to a degree. | Report both. Do not tune on the held-out split. Replace `test-c` by a split from an independent author ([ADR 61](DECISIONS.md#adr-61-ship-thresholds-are-absolute-and-the-final-read-uses-a-split-nobody-tuned-on)). |

## What a good run looks like

`qa/out/morning.md` says "all steps that ran are fine", the cost check is inside 15 percent, `eval --ship` on the recording passes every line, a real call was rated with at least 2 useful cards an hour, and the numbers are written in the docs with the word **recorded** next to them. Until then the docs keep the word **scripted** next to every number. A first recorded run was made in November 2026; its result is in the [Roadmap](ROADMAP.md#evidence-so-far). It does not pass.

Next: [Development](DEVELOPMENT.md) · [Roadmap](ROADMAP.md) · [Decisions](DECISIONS.md)
