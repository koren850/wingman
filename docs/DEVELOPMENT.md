# Development

For people who want to build, test or change Wingman. Everything is in `app/`. Run commands from there. If you only want to use the app, download it instead: you need no Node for that (see [Getting started](GETTING-STARTED.md)). Node is only for developers.

## Setup

For the full app, use the installer at the repo root:

```bash
./install.sh --check    # what is present, what is missing
./install.sh            # checks the Mac, installs, builds the app
```

For code work only (no Electron download, no app):

```bash
cd app
WINGMAN_SKIP_APP=1 pnpm install
./node_modules/.bin/tsc --noEmit -p .   # type check
pnpm test:unit                          # the quick unit tests, no keys
pnpm test                               # unit plus end-to-end tests (about 2,000 in all)
pnpm demo                               # the offline demo call, no keys (1 to 2 minutes)
pnpm eval                               # detector, bank and guard quality numbers, no keys
```

Before you open a pull request, `pnpm check` runs the type check, lint, format check, unit tests and `pnpm eval` in one go.

To build and run the code you need Node 24 or newer, git and pnpm 11 (through `corepack enable`; the version is pinned in `package.json`). The full app and the macOS installer script need macOS 14.2 or newer. `ffmpeg` is optional: it is used only for file replay and terminal runs, because the app records the microphone itself. Poppler (`pdftotext`) is optional, for PDF attachments. The unit tests also run on Linux and Windows. Keys are not needed for unit tests: they use mocks and fake keys, and the real Keychain runner refuses to run under the test runner. For live work, add keys with `pnpm keys set deepgram` and `pnpm keys set anthropic`. Never commit keys.

## Try it from the code, with no keys

This is the walk-through for someone who has cloned the repository and wants to see the engine run before installing the app. Nothing is sent anywhere. Commands were run on macOS (Apple silicon, Node 24, pnpm 11) and the output is trimmed. Run `pnpm` from inside `app/`, so corepack uses the pinned version; a global pnpm of another version (for example 12) prints a notice, which is harmless. The demo is SCRIPTED: speech and AI are fixtures, so it shows plumbing, not model judgement.


### 1. Get the code

```bash
git clone https://github.com/koren850/wingman.git
cd wingman
```

### 2. Check your Mac

```bash
./install.sh --check
```

This only reports. It changes nothing. On a ready Mac you see:

```text
== Checking this Mac (nothing is changed)
  ok    macOS 27.2 (14.2 or newer needed for system audio)
  ok    CPU: Apple silicon (arm64)
  ok    Node 24.21.0
  ok    pnpm 11.22.0
  ok    ffmpeg (optional: only for terminal runs and file replay)
  warn  pdftotext not found: optional, only needed to attach PDFs to a meeting.  brew install poppler
  ok    git
```

A `MISSING` line tells you what to install. The `pdftotext` warning is fine: you only need it to attach PDF files to a meeting. Node is never installed for you. See [Troubleshooting](TROUBLESHOOTING.md#node-is-too-old-building-from-source) if Node is too old.

### 3. Install the dependencies

For the full app (menu-bar app and answer window), run `./install.sh` and answer its questions. For this part you only need the code, so you can skip the Electron download:

```bash
cd app
WINGMAN_SKIP_APP=1 pnpm install
```

### 4. Run the demo

```bash
pnpm demo          # an English call
pnpm demo --he     # the same story in Hebrew
```

The demo plays a scripted call through the real engine. The speech and the AI are scripted, so it needs no keys, no network and no microphone. It takes 1 to 2 minutes (about 100 seconds on a Mac with Apple silicon), because it plays the call at call speed. The call is invented: a client called Dana (from a made-up shop) asks about a slow site, backups and a price. The default call is in English; `--he` plays a Hebrew call. Wingman handles both, and calls that mix them.

You see the cards as they would appear in the answer window. This is a trimmed copy of the real output (the call id and the temporary paths change on every run, and a few status lines are left out):

```text
Wingman · call 01M6XVRRTAQZD198466JH82638 · file .../silence.wav · 41 prepared cards

[🗂 fact] Acme Stores Ltd
   • acmestores.com · wordpress 6.9 · PHP 8.3

Looks like a call with Acme Stores Ltd. Press y to confirm (adds it to the AI notes).

[📗 prepared] A slow site is usually heavy images, missing cache, heavy plugins or a weak server. We check the cause first and then fix it.
   • Common causes: images, plugins, server
   • Measure before and after
   • Not always the server

[📗 prepared] Yes, we can work with automatic backups of the files and the database, and restore from them if something goes wrong.
   • Files and database
   • Keep a copy off the server
   • Frequency depends on the plan

[📋 domain] acmestores.com

[📗 prepared] The price depends on the scope and the requirements. I need to look at the details and I will come back with a clear quote.
   • Depends on scope and requirements
   • No number without details
   • Come back after checking

[📋 phone] 054-1234567

[📋 email] dana@acmestores.com

Speed: 11 questions · first card p50 0.3s / p95 0.3s · Prepared cards 3 (p50 0.3s) · AI first words p50 -
Cost: AI $0.001 of $2 · STT $0.00 · total $0.00 (estimate from settings budget.prices)
Prompt cache: 77% of AI input tokens were cache hits

📋 Call summary
  • The client called because her site loads slowly
  • She asked about backups for the site
  • She left a phone number and an email for the reply
  Next steps:
    - Me: Find out why the site is slow
    - Client: Send access to the site (this week)
  Open questions: 1
  Email draft: ready (2 sentences replaced with [fill in]) · calls/<id>/summary.json · $0.0000

Demo done. It ran in a temporary folder, now deleted.
```

The Hebrew call (`pnpm demo --he`) prints the same kinds of lines in Hebrew. Trimmed:

```text
Wingman · call 01M6XVVVQJKPT2E9TM9XWQGD9R · file .../silence.wav · 41 prepared cards

[🗂 fact] אקמה סטורז בע"מ
   • acmestores.co.il · wordpress 6.9 · PHP 8.3

[📋 domain] acmestores.co.il

[📋 phone] 054-1234567

[📋 email] dana@acmestores.co.il

Speed: 7 questions · first card p50 - / p95 - · Prepared cards 0 (p50 -) · AI first words p50 -
Cost: AI $0.000 of $2 · STT $0.00 (estimate from settings budget.prices)

📋 סיכום השיחה
  • הלקוחה פנתה בגלל אתר שנטען לאט
  • שאלה על גיבויים לאתר
  • השאירה טלפון ומייל לחזרה
  צעדים הבאים:
    - אני: לבדוק את סיבת האיטיות
    - לקוח: לשלוח גישה לאתר (השבוע)
  שאלות פתוחות: 1
  טיוטת מייל: מוכנה (2 משפטים הוחלפו ב-[להשלים])

Demo done. It ran in a temporary folder, now deleted.
```

The Hebrew demo shows no Prepared card today (`Prepared cards 0`). The English call is the one that shows the answer bank at work.

How to read it:

| Label | Meaning |
|---|---|
| `📗 prepared` | A card from your answer pack, picked by keywords. Local, instant. |
| `🗂 fact` | A fact about a known client, from a local snapshot. |
| `📋 phone`, `📋 email`, `📋 domain` | Captured from what the other side said. In the app you copy them with a hotkey. |
| `Speed` | How long after the question the first card appeared. The demo timing is scripted, so it is not a speed test. |
| `Cost` | The demo uses no real AI, so it costs next to nothing. The `$2` is the default cap for one call (`budget.maxUsdPerCall`). |

Look at the price question. The client asks "how much" and Wingman shows a safe line, never a number. That is the main idea of the project: the answer is something you can say, and it never promises a price, a date or a result. [EXAMPLES.md](EXAMPLES.md#c-what-the-guards-do) shows what the guards block and why.

The demo writes to a temporary folder and deletes it at the end. It also ignores your own settings file, so it looks the same on every machine.

### 5. Run the checks

```bash
pnpm eval
```

This plays the 32 invented golden dev meetings through the real engine with scripted AI replies, grades the cards, runs four bad-model controls that must score low, and then prints the old word-list checks under a boxed "LEGACY SMOKE, in-sample" header. No keys, no network. It fails when a number is worse than `app/qa/eval-baseline.json`. `pnpm eval:ship` adds the absolute ship thresholds from `app/qa/ship.json`, one pass or FAIL line each. **It fails today:** a recorded run of the real model exists (November 2026), and most ship lines fail on it (see the [Roadmap](ROADMAP.md#evidence-so-far)). A failing `eval:ship` is not a broken checkout. Everything it prints is **scripted**; see [Release gates](#release-gates-pnpm-eval-budgets-held-out-snapshots).

You can also run the unit tests with `pnpm test:unit` (the quick option).

## Get your API keys

Live work needs two paid keys. Deepgram (speech to text): sign up at [console.deepgram.com/signup](https://console.deepgram.com/signup) and create a key in the console. Anthropic (the AI): create an account at [platform.claude.com](https://platform.claude.com), add credit under Billing and create a key under [Settings, API keys](https://platform.claude.com/settings/keys). Paste them in the app's first-run setup or **Settings, Keys**, or run `pnpm keys set deepgram` and `pnpm keys set anthropic`. Cost: about $1.30 to $1.40 an hour for speech plus roughly 5 to 20 cents an hour for AI. Unit tests need no keys.

## Install, update, uninstall

`install.sh` at the repo root does all of it. It never uses sudo and never installs Node. It is safe to run again.

| Command | What it does |
|---|---|
| `./install.sh` | Checks macOS, Node, pnpm, ffmpeg. Runs `pnpm install --frozen-lockfile`. Builds `app/.app/Wingman.app`. Offers: copy it to `/Applications`, add the `wingman` link in `~/.local/bin`, `brew install ffmpeg`. |
| `./install.sh --check` | Only reports. Changes nothing. |
| `./install.sh --dry-run` | Prints every step it would run. |
| `./install.sh --yes` | Takes the default answer to each offer. Without a terminal and without `--yes`, every offer is declined. |
| `./install.sh --offline` | Passes `--offline` to pnpm (local package cache only). |
| `./install.sh --update` (or `wingman update`) | `git pull --ff-only`, `pnpm install`, rebuild the app. |
| `./install.sh --uninstall` (or `wingman uninstall`) | Removes the app copies and the `wingman` link. Your data stays. |
| `./install.sh --uninstall --purge` | Also deletes `~/Library/Application Support/Wingman`, `~/.config/wingman` and the Keychain keys, after you type `DELETE`. It refuses a `WINGMAN_DATA_DIR` outside `~/Library/Application Support` or without "Wingman" in its path, unless you add `--force`. |
| `cd app && pnpm run install-app` | Builds the app and copies it to `/Applications` (`make-app.sh --install`). |

Environment: `WINGMAN_APPS_DIR` (default `/Applications`), `WINGMAN_BIN_DIR` (default `~/.local/bin`), `WINGMAN_SKIP_APP=1` (skip the Electron download and the app build: CI and tests).

What `pnpm install` does in `app/`:

- `scripts/check-env.cjs` (preinstall) stops early with a clear message on Node older than 24 or macOS older than 14.2.
- `scripts/postinstall.cjs` downloads the Electron runtime (Electron 45 does not do it by itself) and builds the app. A failure stops the install and prints the fix. It is not swallowed.

`~/.local/bin` must be on your PATH for the `wingman` command.

## Scripts (`package.json`)

| Script | What it does |
|---|---|
| `pnpm demo` | The offline demo: a scripted, invented English call (`--he` for Hebrew) through the real engine. No keys, no network. |
| `pnpm eval` | The release gate, offline: the golden dev meetings through the Live reading engine (`moments.engine: v2`; recall, precision, time to card, cost), four bad-model controls, cost and latency per role against `qa/budgets.json` (+20 percent fails), the memory eval and the rubric judge. The old word-list numbers come last as a smoke test. Fails if one drops below `qa/eval-baseline.json`. `--final` reads the held-out splits once, `--cassette <file>` plays a recording of the real model. See "Release gates" below. |
| `pnpm eval:memory` | Memory-quality eval (`qa/memory-eval.ts`): precision and recall of the final call memory on 24 labelled calls, with a null and a copy-all control. Offline with the policy fake; `WINGMAN_LLM_MODE=replay` reads a cassette. |
| `pnpm check` | Type check, lint, format check, unit tests and `pnpm eval`. |
| `pnpm start` | The call engine (`src/run.ts`) in the terminal. Flags: `--file x.wav` (replay a stereo WAV, left = me, right = them), `--no-ai`, `--discard`, `--profile`, `--set key=value`. |
| `pnpm call` | Starts a call and opens the answer window. Ctrl+C stops and saves. |
| `pnpm dashboard` | The menu-bar app with its window open (`scripts/wingman.sh --open-window`). |
| `pnpm tray` | The menu-bar app only. |
| `pnpm overlay` | The answer window alone. |
| `pnpm wingman <cmd>` | The CLI (`wingman help`). `scripts/wingman-cli.sh` is the same command and can be symlinked onto your PATH. |
| `pnpm run doctor [--offline]` | The Readiness check. (`pnpm doctor` is a different pnpm command.) |
| `pnpm keys status|set|remove|migrate` | The saved keys (macOS Keychain, Windows data protection). |
| `pnpm settings` | Prints the effective settings and which layer each value came from. |
| `pnpm brief` | Writes a Plan from the terminal. |
| `pnpm summary <id|latest>` | Writes or rebuilds a call's summary. |
| `pnpm tag [id]` | Rate each card y/n; prints useful cards per hour. |
| `pnpm purge <id>|--older-than N|--all` | Deletes saved calls. |
| `pnpm detector` | Question-detector precision and recall on `data/questions.tsv`. |
| `pnpm banktest` | Bank accuracy on held-out utterances. |
| `pnpm gate` | Hebrew STT gate on recordings in `data/gold/recordings/` (`--count`, `--ids`, `--no-keyterms`, `--language he|multi|en`). |
| `pnpm synth` | Rebuilds the synthetic test audio with the macOS Hebrew voice. |
| `pnpm factscheck` | Counts false fact-card hits on ordinary lines. |
| `pnpm qa` | Synthetic QA harness (below). |
| `pnpm make-app` | Builds `.app/Wingman.app` (below). `scripts/make-app.sh --check` only reports. |
| `pnpm dist` | Builds the self-contained `dist/Wingman-<version>-arm64.dmg` (below: Building the app). |
| `pnpm run install-app` | `make-app.sh --install`: build and copy to `/Applications`. |

## Tests

- Unit tests are `src/*.test.ts` (`pnpm test:unit`, about 1,800 tests; several minutes on a quiet Mac, and 18 minutes when the machine was busy); end-to-end tests that start the engine as a subprocess are `src/e2e/*.test.ts` (`pnpm test:e2e`). About 2,000 tests in all (unit plus end-to-end); a full `pnpm test` can take about half an hour on a busy machine, so use `pnpm test:unit` while you work. `pnpm test` runs both with `tsx --test --test-concurrency=1`. Run one file with `pnpm exec tsx --test src/guards-table.test.ts` (use the file you need).
- Do not start a second `pnpm test` while one is running; they share ports and files.
- Test names say what they protect. Bug fixes should come with a regression test.
- The "repo guard" test fails if a tracked source, data or config file contains a word from your private word list. Set it with `WINGMAN_DENYLIST="word1,word2" pnpm test`, or one word per line in the git-ignored `app/data/private/denylist.txt`. With no list it skips. How and why: [CONTRIBUTING.md](../CONTRIBUTING.md#the-private-word-list-repo-guard).
- Tests redirect user data with `WINGMAN_DATA_DIR`, `WINGMAN_CALLS_DIR` and friends, so they never touch your real calls.
- Some `WINGMAN_*` variables are test hooks and are not part of the product (for example `WINGMAN_DASHBOARD_EVAL`, which runs a script inside the dashboard page, `WINGMAN_KEYS_FILE` and `WINGMAN_PACK_DIR`). They only matter to someone who controls the environment a program is started from, which already means they run code as you.
- CI (`.github/workflows/ci.yml`; "Run workflow" has an `os` choice: all, macos, linux or windows) runs on Node 24 on macOS and Linux (both must pass) and on Windows (experimental, may fail). Every system runs `pnpm install --frozen-lockfile` (with `WINGMAN_SKIP_APP=1`), the type check and the unit tests. **Windows stops there.** macOS and Linux also run the end-to-end tests and `pnpm eval`. Lint, the format check and coverage run on macOS only. There is no private word list in CI, so the repo guard skips there. A separate macOS job runs `install.sh --check` and `--dry-run`. A Windows packaging job builds the installer and runs `.github/scripts/windows-smoke.ps1` (install, smoke check, tray start, uninstall); it runs only when started by hand or in a public repository.
- There is an offline end-to-end test (`src/e2e/scripted-call.test.ts`) that runs a whole call with scripted speech and a scripted AI (`src/providers/scripted.ts`).
- `src/e2e/chaos.test.ts` is a repeatable chaos test (about 45 s, offline): one scripted live call with AI timeouts, a mic drop, a 20 s speech-to-text outage and a sleep/wake, then it checks the health and ladder events and that the call recovers. Run it alone with `pnpm exec tsx --import ./src/test-setup.ts --test src/e2e/chaos.test.ts` from `app/`.

## Test kit (model tests without a key)

New model-driven features are tested with these tools, all in `app/src/testkit/` and `app/src/providers/cassette.ts`. None of them calls a real API.

- **Policy fake model** (`testkit/policy-model.ts`). The test declares what the model says; the fake never decides by itself. `pm.reply({ role: "moment", lastLine: "l3" }, text, { ms })`, and `garbage()`, `truncate(n)`, `hang()`, `refuse()`, `error(529)`, `slow(ms)`, `injection(text)`. A rule can match the role (`moment`, `memory`, `ask`, `digest`, `compact`, `wrapup`), the last transcript line (its `[id]` or its text) and any text in the system block. The first rule that matches wins. A call with no matching rule fails loudly. `pm.assertPrompt(...)` checks what the model received (a memory block, a token limit). `setUsage()` sets the tokens it reports, for cost tests. `pm.serve(golden.script)` serves the scripted replies of a golden meeting. A package that adds a role calls `registerRole(role, marker)` (in `testkit/prompt.ts`) with a phrase from its system prompt.
- **Cassettes** (`providers/cassette.ts`). `WINGMAN_LLM_MODE=live|record|replay`, default `live`. In `replay` every call must be in the cassette (`WINGMAN_CASSETTE`, default `data/cassettes/default.cassette.json`) and no key or network is used. A miss shows a diff against the nearest entry. `record` needs a key and is for the maintainer only; it is never run in CI. The folder `data/cassettes/` holds a first recording (dev, the judge, memory and the judgement set, about 8 MB). It was recorded at 4 times speed, so its model times are too long and replays drop answers as late: do not read release numbers from it. Record again at real speed (pace 1, about an hour for dev). Each entry says if it was `recorded` or `authored`.
- **Prompt snapshots** (`testkit/prompt-snapshot.ts`). `assertPromptSnapshot("moment", { system, user })` compares the prompt with `data/snapshots/prompts/moment.txt`. After an intended change run once with `WINGMAN_UPDATE_SNAPSHOTS=1` and review the diff of the file.
- **Virtual clock** (`testkit/vclock.ts`). `withVClock(async (vc) => { await vc.advance(90_000); })` fakes `Date.now`, `new Date()`, `performance.now`, `setTimeout`, `setInterval` and `setImmediate`. 90 seconds of meeting run in a few milliseconds. New code can read time through `wallNow()` and `monoNow()` in `clock.ts`.
- **Golden helpers** (`e2e/helpers.ts`). `replayOnVClock` plays `Golden.lines` in this process. `runGolden` plays them into the real engine (`src/run.ts`) with scripted speech and the policy fake (profile `e2e-policy`) and returns the card timeline: id, kind, text, and ms after the line. The engine is one process per call and keeps its real clock, so `runGolden` runs in real time (use `speed` to compress the gaps between lines).
- `legacyScripted` (also exported as `scriptedAnswer`) is the old keyword fake. It stays for the legacy engine; do not use it in new tests.

## v2 gate tests (`app/src/e2e/v2-*.test.ts`)

Six files prove the Live reading engine (setting `v2`) as a whole. They use no network and no key. Run one with `./node_modules/.bin/tsx --import ./src/test-setup.ts --test src/e2e/v2-<name>.test.ts`; all six together take about two minutes.

| File | What it proves |
|---|---|
| `v2-latency` | Time to the first card on the virtual clock: a model answer (p50 1.5 s, p95 2.5 s), a bank hit (0.6 s, 1.9 s), the stall line by 1.8 s, a late observer card (more than 6 s) dropped, a hung memory updater adds no delay. |
| `v2-cost` | Price per call and per role from `usage.jsonl`, replayed over the golden dev meetings, against the per-role budget table. Fails at +20 percent per role. Also dollars per hour (gate: $0.25) and a what-if for the cache layout. |
| `v2-golden` | The golden dev meetings through the real engine modules with the memory loop on, graded by `qa/grade-golden.ts`, with the null control, the noise control and the noisy-transcript delta. |
| `v2-resilience` | The failure matrix: model down, slow, 429 storm, truncated and garbage replies, STT down, both down, corrupt `session.json`, a real SIGKILL during a save, clock jump, no brief, a 5 MB brief. Each case: no empty screen, a bar when something is wrong, no crash. |
| `v2-soak` | A 3-hour call on the virtual clock with faults (disk full for the memory, a corrupt `session.json`, a 5-minute model outage, a clock jump). Calls per hour, cost per hour and memory size stay bounded. |
| `v2-prompts` | Prompt snapshots for moment, observer, memory, compact and wrap-up, the block layout, and a check that the memory reaches the moment and observer prompts. |

How they work: `v2-kit.ts` wraps the policy fake so that every call reports the usage of its real prompt, with a simulated prompt cache (a marked prefix is cached from 1024 tokens, read at the cache-read price, written at the cache-write price). `v2-worker.ts` plays one golden meeting in a child process, because the engine is one call per process. Scripted replies prove plumbing, timing, budgets and state logic. They do not prove model judgement or Hebrew quality; that needs a recorded run (`pnpm cassette:record`).

## Gate tests (`app/src/e2e/r3-gates-*.test.ts`)

Five end-to-end files that run the real engine modules on the virtual clock with fake streams and the policy fake model. No network, no key, no audio. Each file holds one engine, so run it alone (`tsx --import ./src/test-setup.ts --test src/e2e/gates-soak.test.ts`). All numbers they print are **scripted**. `gates-kit.ts` has the shared fake stream and provider (an open that can be a black hole).

| File | What it proves |
|---|---|
| `gates-speakers` | The same raw speaker id before and after a faked reconnect or provider switch is a different person; an introduction with the same name joins the earlier person; a burst of reconnects with no voice between counts once. Real `SttChannel`, `engine/stt.ts` wiring, ingest and speaker book. |
| `gates-ring` | 100 ms chunks sent from the first moment arrive in order, once, after an open that was a black hole for 1.5 s; after an open that never answers (8 s timeout, then the engine's retry), the newest 2 s are kept in order and every older chunk is counted as dropped. |
| `gates-early-start` | With `moments.earlyStart` on, over 12 questions the card comes earlier after the end of speech (median gain 500 ms), the cards are the same, and no extra model call is made. The speech-to-text lag (700 ms) and the model delay (800 ms) are assumptions. |
| `gates-floor` | Golden dev meetings replayed with the AI marked down: no model call, no error, 60 of 68 answer moments get a card, p95 of the card time is within the budget, quiet stretches stay mostly quiet. Dev is the tuning set, so it is in-sample. |
| `gates-soak` | 180 virtual minutes with a reconnect storm (8 minutes), a dead socket and provider switch, a slow model, a 529 storm, a dialog nobody answers (the menu-bar controller keeps reading engine lines) and a quit while the engine is wedged (a fake child gets a synchronous SIGKILL to its group). Eight probe questions each get a card inside the budget and the screen is never empty after the first card. State, timers and cost stay bounded ($0.13 an hour scripted). |

A note on the virtual clock: a large jump of the test clock can raise the "computer slept" bar in these runs. The tests do not assert on that bar.

## Release gates (`pnpm eval`, budgets, held-out, snapshots)

Every number is marked **scripted** (the replies in the golden files; they prove plumbing, timing and the grader) or **recorded** (replayed from a cassette of the real model; they measure the model). Only the recorded numbers can say the product is good.

| Command | What it does |
|---|---|
| `pnpm eval` | Dev meetings, Live reading engine, scripted. Metric table against `qa/eval-baseline.json` (`v2`), the four controls, the per-role budgets, the memory eval, the rubric judge. About 30 s on a quiet machine. |
| `pnpm eval --update` | Rewrites the baseline and `qa/budgets.json` (`scripted`). Read the diff first. No baseline value is zero (a metric that is truly zero is stored at a small floor). |
| `pnpm eval --final` | The held-out splits `test` and `test-b`, each played on its own, printed next to the dev baseline. Prints only and enforces only the hard limits. Read it once. Never tune after it. |
| `pnpm eval --cassette data/cassettes/dev.cassette.json` | Dev played against the recording. Marked RECORDED; compared with the `v2Recorded` baseline; the model judge reads `dev.judge.cassette.json` if it exists. `--update` writes the first recorded baseline and the `recorded` budgets. |
| `pnpm eval --only id1,id2` | Some dev meetings (numbers are not comparable with the baseline). |
| `pnpm snapshots` | `scripts/snapshot-check.sh [outDir]`: hidden overlay checks in English and Hebrew (44 specs each) and the dashboard matrix (24 pictures, both languages, light and dark, narrow). Fails on clipping, contrast, font size, direction or a window that took focus. About 2 to 4 minutes. |

Budgets (`qa/budgets.json`): per role, USD per call and USD per hour; per card path (direct question, observer), time to card p50 and p95; the whole call per hour (release gate $0.25). A role or path over its budget by more than 20 percent fails the eval, and `src/e2e/v2-cost.test.ts` fails the same way per call. The `oneShot` entries (digest, wrap-up) are measured by `v2-cost.test.ts`.

Fault soak: `src/e2e/soak.test.ts` runs an 80 minute call on the virtual clock with a hung audio respawn, a display unplug (injected screen), a dead STT socket, a slow model and a 529 storm, and a probe question inside each fault. A second case stops a real v2 process with a stray error. `WINGMAN_E2E_ENGINE=v2` plays the older child-process e2e files (`fault-injection`, `chaos`, `engine-reliability`) on the v2 engine instead of the pinned classic one.

## Recording a cassette (maintainer, by hand)

Recording calls the real model and costs money. An agent never runs it, CI refuses it. It needs `ANTHROPIC_API_KEY` in the environment of that one command (nothing reads a key file). To keep the key out of your shell history, run `read -s ANTHROPIC_API_KEY; export ANTHROPIC_API_KEY` once in that terminal. Order: dev, then test-b, then test.

```bash
cd app
ANTHROPIC_API_KEY=... pnpm cassette:record --suite dev --cap 1 --judge
ANTHROPIC_API_KEY=... pnpm cassette:record --suite test-b --final --cap 0.25 --judge
ANTHROPIC_API_KEY=... pnpm cassette:record --suite test --final --cap 0.25 --judge
pnpm eval --cassette data/cassettes/dev.cassette.json --update      # first recorded baseline and budgets
pnpm eval --final --cassette data/cassettes/test.cassette.json,data/cassettes/test-b.cassette.json   # the held-out, once
```

The command prints a one-page estimate first and refuses when it is over the cap (`--allow-partial` stops at the cap instead). Estimates (modelled cost per hour of the baseline times 2 for real prompt sizes; the judge at $0.0004 a card): dev about $0.25 (+ $0.28 judge) and about one hour of wall time at 4 meetings at a time; test-b about $0.03 (+ $0.04) and about 10 minutes; test about $0.05 (+ $0.06) and about 12 minutes. Treat these as floors. Check the first meeting's booked cost before you leave it alone. The recorder must play at real time (pace 1) because the real model answers in real time. A faster pace makes every recorded model time too long.

Held-out cassettes (`test`, `test-b`) must be recorded and replayed once, after the dev numbers are final. Do not edit a prompt after you have looked at them.

## The morning run (maintainer, by hand)

One command records everything the quality numbers need, with one cap for the whole run. An agent never runs it and CI refuses it. It needs `ANTHROPIC_API_KEY` in the environment of that one command.

```bash
cd app
pnpm morning --cap 5 --estimate        # prints the cost estimate and stops; needs no key
ANTHROPIC_API_KEY=... pnpm morning --cap 5
```

Order: the dev meetings (with the model judge), then `pnpm eval --cassette ... --update` and the cost check, then the memory eval (24 calls), then the judgement set (120 cases), then `test`, `test-b` and `test-c`. Each held-out split asks for a yes first, because reading it is a one-time act. After them one `pnpm eval --final --cassette ...` reads the recorded ones. Use `--only dev,judge` or `--skip test-c` to run part of it.

It writes `qa/recorded-baseline.json` (the `v2Recorded` section, with the cassette it came from) and a one-page `qa/out/morning.md`: what ran, what each step cost, the cost check, the dev eval and the held-out read. The estimate is about 0.8 USD for what exists today and is a floor. It refuses without a key, in CI, without `--cap`, and when the estimate is above the cap (`--allow-partial` stops at the cap instead).

**Cost check.** After the dev recording the same meetings are played once with the scripted replies (simulated usage) and once against the recording (usage the provider reported). The cost per role and per hour must be within 15 percent in total and in every role that is more than 5 percent of the cost. The report prints calls per hour per role. A failure means the budgets in `qa/budgets.json` are wrong, not that the engine is broken.

**Stale entries.** Every cassette entry carries the model id, a hash of the system prompt and a hash of the messages. When a call finds no entry, but there is one for the same messages recorded with another prompt text or another model, the replay says STALE (`CassetteStale`) and not "miss". The fix is to record again. `pnpm cassette:status [--cassette dev.cassette.json]` lists the files by role and model and, with a file, plays dev against it and prints coverage: calls found, stale and missing.

## Judgement set, memory eval and replay

- `pnpm eval:judge` scores the moment role on 120 invented cases in `data/judge-set` (60 English, 60 Hebrew; noisy speech-to-text, mixed languages, lines with no question mark). A case holds the call memory, the last 6 lines and the right verdict (SKIP or one card kind, with an accepted second verdict and the words a card must contain). It prints precision, recall and F1 per kind. Controls: a model that always says SKIP and one that always answers must stay under the limits in `qa/judge-set.ts`. Floors apply to a recorded run only: `pnpm eval:judge --mode model --cassette data/cassettes/judge-set.cassette.json`. Record: `pnpm eval:judge --record --cap 1` (maintainer).
- `pnpm eval:memory` scores the call memory on 24 invented calls in `data/memory-eval` (10 English, 9 Hebrew, 5 mixed; noisy speech-to-text; two voices on the user's side; one long call whose early promise must survive a compaction). It prints precision, recall and F1 for promises, open questions, numbers (with who said them), decisions and objections. The null and copy-all controls stay. Floors (`RECORDED_FLOORS`) apply to a recorded run only. Record: `pnpm eval:memory --record --cap 1` (maintainer).
- `pnpm replay <call-folder> [--prompt rules.txt] [--cassette file]` runs the final lines of a real call (`events.jsonl`) through the moment role and prints which cards are kept, new or gone against `cards.jsonl`. Without a cassette the policy fake repeats the original call, so the diff is empty: that checks the tool. A prompt is judged only through a recorded cassette. `--to-case` writes every card you rated "not useful" (`pnpm tag`) as a judgement case; emails and phone numbers are masked and a case with a word from the no-real-names list is not written. Read the files before you copy them into `data/judge-set`.

## QA harness

```bash
pnpm qa --all                    # all scenarios, real Deepgram + Haiku (about 13 min of audio, 4 in parallel)
pnpm qa split-questions backups  # some scenarios
pnpm qa --dry                    # render and print a cost estimate, send nothing
pnpm qa --no-ai                  # Prepared cards only
pnpm qa --replay                 # re-play what Deepgram heard last time (Haiku only)
pnpm qa --regrade                # grade the newest saved run again, no network
pnpm qa --cap 0.5                # spend cap in USD (default 0.90)
```

Scenarios are in `qa/scenarios/*.json` (32 of them) and use invented clients only. `qa/render.ts` makes a stereo WAV with macOS voices (cached by text hash in `qa/cache/`), `qa/run-qa.ts` plays it through the engine with the `qa` settings preset (`profiles/qa.yaml`) and `WINGMAN_CALLS_DIR` pointing at `qa/calls/`, and `qa/grade.ts` scores it against each scenario's `expect` blocks. Output: `qa/report.md` and `qa/report.json`. `qa/out/`, `qa/cache/` and `qa/calls/` are git-ignored. It costs real money (about $0.35 for the full set at the time of writing), and TTS speech is cleaner than real speech, so numbers are optimistic.

## Snapshot tools (screenshots without showing windows)

Used for UX checks and for the images in `docs/ux/`. They need the Electron runtime, so install without `WINGMAN_SKIP_APP=1` (or run `node node_modules/electron/install.js` once). In snapshot mode the app creates a hidden window, no tray, no global shortcuts, and never starts a call. Run snapshots one at a time.

- Window: set `WINGMAN_DASHBOARD_SNAPSHOT=<out.png>` and optionally `_VIEW=home|inbox|settings`, `_THEME`, `_SIZE`, `_OPEN`, `_FOCUS`, `_SCROLL`, `_EVAL`; `WINGMAN_DASHBOARD_FAKE_CALL=waiting|live|live-warn|stopping|ended`; `WINGMAN_DASHBOARD_FAKE_DOCTOR=ready|notready`. Use `WINGMAN_CALLS_DIR`, `WINGMAN_BRIEFS_DIR` (or `WINGMAN_DATA_DIR`) and `WINGMAN_USER_SETTINGS` to point at fixtures so real data is never shown.
- Window set (hidden, invented data): `dashboard/snapshot.sh <outDir> [name:lang:theme:view:fakeCall:focus ...]` writes English, Hebrew/RTL, light and dark pictures plus a clipping check (`clipcheck.js`); `WINGMAN_SNAP_EVAL=dashboard/focuscheck.js` checks the keyboard path of the Meeting context box. `WINGMAN_DASH_SNAP=1` runs them from `src/dashboard-i18n.test.ts`.
- Answer window: `overlay/snapshot.sh <outDir> [scenario:keys ...]` (scenarios such as full, empty, listening, waiting, overflow, quiet, foryou, flow, flowyou, speakers; keys such as rewind, pause, checklist). The labels are Hebrew unless you set `WINGMAN_OVERLAY_LANG=en`. `full` has Hebrew call content; the English version of the same screen is `fullEn` (not in the default list, so name it: `WINGMAN_OVERLAY_LANG=en overlay/snapshot.sh <outDir> fullEn fullEn:checklist`). The key that opens the More panel is `checklist` (`full:more` does nothing). Fixtures are in `overlay/fixtures.cjs`. For your own cards, write a `cards.jsonl` in a temp folder and run `WINGMAN_CALLS_DIR=<temp> WINGMAN_OVERLAY_SNAPSHOT=<out.png> app/node_modules/.bin/electron app/overlay/main.cjs`.
- Use only invented data in anything you publish.

## Building the app (.dmg and Windows installer)

`pnpm dist` builds the app of the system you run it on. It carries its own engine and needs no Node, no pnpm and no checkout. On macOS it writes `app/dist/Wingman-<version>-arm64.dmg` and the app itself in `app/dist/mac-arm64/`. On Windows it writes `app/dist/Wingman-Setup-<version>-x64.exe` (an NSIS installer: one click, current user only, no administrator rights) and the app folder in `app/dist/win-unpacked/`. A foreign build is refused (`scripts/build-target.cjs`); `pnpm dist --win --stage-only` (or `--mac`) only fills `app/.stage` and works anywhere. On Windows run `pnpm install` with `WINGMAN_SKIP_APP=1` first; electron-builder downloads the Windows Electron files itself. It needs a normal `pnpm install` first (esbuild and electron-builder are dev dependencies). The dev setup above (`pnpm`, `tsx`, `install.sh`, `make-app.sh`) does not change.

- **Why electron-builder.** It makes the .dmg, handles signing and notarizing, and writes the files an updater needs, all from one config (`electron-builder.cjs`). Electron Forge would need a separate maker for each of these.
- **The engine.** `scripts/package-app.cjs` bundles `src/*.ts` with esbuild into `src/*.mjs` (the call, the readiness check, the summary and the small settings tools) and copies the menu-bar code, the windows, the example pack, the practice-call data and the `audiotee` binary into `app/.stage/`. electron-builder packs that folder without an asar archive (the engine runs child processes from it).
- **How it runs.** The app starts its own executable for each tool: `Wingman --wingman-tool <name> -- <args>` and `Wingman --wingman-overlay` (`tray/app-entry.cjs`). Only the tool names listed in `shared/bin.cjs` can run, and no path from the command line is loaded. The `RunAsNode` fuse stays off (`scripts/after-pack.cjs` calls `scripts/set-fuses.cjs`). `shared/bin.cjs` switches to this mode when `packaged.json` is next to the code; in a checkout it never is.
- **Data.** Settings, keys, packs and calls are in the same places as for the dev app (`~/.config/wingman`, the Keychain, `~/Library/Application Support/Wingman`), so the two builds share them. Do not run both at once.
- **Windows differences.** There is no `audiotee` (macOS system audio only). Keys are kept with Windows data protection (DPAPI, through `src/securestore.cjs`) in `<data folder>\secrets\` instead of the Keychain; this also works under plain node in a dev checkout. The tray uses `brand/wingman.ico` (`shared/platform.cjs`). `shared/entry-guard.cjs` finds the parent process with `tasklist`. 
- **Install check.** `Wingman --wingman-smoke` (macOS and Windows) checks that the install is complete, tries the key store in a scratch folder (Windows), runs one bundled tool as a child, prints `WINGMAN-SMOKE {json}` and exits 0 or 1. It opens no window and uses no network or key. With `WINGMAN_SMOKE_OUT=<file>` the JSON is also written to a file (a Windows GUI program has no console). `.github/scripts/windows-smoke.ps1` runs it on the unpacked app and on the silently installed app, and also checks the fuses, the Start menu shortcut, a 15 second tray start and the silent uninstall.
- **Not needed in the app.** The app records the microphone itself (hidden capture window, `tray/capture/`), so users need no `ffmpeg`. Developers still need it for file replay (`--file`) and terminal runs, where it is found on the PATH with `/opt/homebrew/bin` added. Check the real capture page without a microphone with `./node_modules/.bin/electron scripts/capture-selftest.cjs`. `pdftotext` is optional. The `wingman` command-line tool stays a dev feature for now: it needs the checkout.
- **Unsigned.** There is no Apple Developer account yet, so the app is only ad hoc signed. A downloaded copy shows a macOS warning on first start: open System Settings, Privacy & Security, and choose "Open Anyway". An app you build yourself is not quarantined, so it normally opens without this. Microphone and system-audio permissions are asked again after each new build, because an ad hoc signature changes with every build.
- **Signing later.** Set `WINGMAN_SIGN=1` plus `CSC_LINK`, `CSC_KEY_PASSWORD` (Developer ID certificate) and `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (or an App Store Connect API key). `WINGMAN_NOTARIZE=0` signs without notarizing. The entitlements are in `build/entitlements.mac.plist`.
- **Release.** `.github/workflows/release.yml` runs on a `v*` tag: the `release` job makes a draft release if there is none, the `dmg` job (macOS runner) and the `exe` job (Windows runner) build, check and attach `Wingman-<version>-arm64.dmg` and `Wingman-Setup-<version>-x64.exe`. A public repository has free minutes for both runners. It has not been run yet.
- **Check a build without showing windows.** Run `dist/mac-arm64/Wingman.app/Contents/MacOS/Wingman` with `WINGMAN_DASHBOARD_SNAPSHOT=<out.png>` (hidden window), or run the offline demo from inside the bundle: `Wingman --wingman-tool run -- --profile demo-en --file silence.wav --no-brief` with `WINGMAN_DEMO=1`, `WINGMAN_STT_SCRIPT=<app>/Contents/Resources/app/data/demo/demo-call.en.json` and every `WINGMAN_*` path pointing at a scratch folder.

## Building the .app

`pnpm make-app` (also run by `pnpm install` and `install.sh`) copies the Electron runtime to `app/.app/Wingman.app`, renames it to Wingman, sets the icon from `brand/Wingman.icns`, sets the permission texts in `Info.plist` (microphone and system audio), turns off three Electron fuses, and adds a small launcher that runs this repo's `tray/main.cjs`.

- **Thin launcher.** It loads the repo code, so quit and reopen the app to pick up code changes. Re-run it after an Electron upgrade (`pnpm install` does).
- **The checkout path is baked in.** If you move the folder, the app says so in a dialog. Run `./install.sh` again from the new place.
- **Node 24 is needed at launch.** Node is looked up when the app starts, because apps opened from Finder have a bare PATH.
- **Fuses** (`scripts/set-fuses.cjs`): `RunAsNode`, `NODE_OPTIONS` and `--inspect` are turned off, so the app cannot be used as a free Node or debugged from outside. The script patches the binary directly and has no dependency.
- The output is git-ignored, is ad hoc signed only (not notarised), and contains the absolute path of your checkout. macOS permissions (microphone, system audio) belong to the app that runs the code: Wingman.app, or your terminal.

## Building from source on Windows

Install Node 24 (nodejs.org or `winget install OpenJS.NodeJS`) and git. Then, in PowerShell (the same steps CI runs):

```powershell
git clone https://github.com/koren850/wingman.git
cd wingman\app
npm install -g pnpm@11.22.0   # pnpm without administrator rights (the version in app/package.json)
$env:WINGMAN_SKIP_APP = "1"; $env:ELECTRON_SKIP_BINARY_DOWNLOAD = "1"
pnpm install --frozen-lockfile
pnpm test:unit        # the unit tests
pnpm dist             # builds dist\Wingman-Setup-<version>-x64.exe and dist\win-unpacked\
dist\Wingman-Setup-0.0.1-x64.exe   # run the installer
```

electron-builder downloads the Windows Electron files itself. `install.sh` is for macOS only. These Windows steps are what CI runs, but they have not been tried by hand on a real Windows machine.

## Code conventions

- TypeScript run directly by `tsx` (ES modules, `.ts` imports with the extension). Electron and shared UI files are plain `.cjs` and `.js`, with no framework and no build step.
- The engine has no Electron imports. The app talks to it over stdin commands and `@@wingman {json}` status lines.
- Settings: every tunable goes in `config/defaults.yaml` with a comment and in the zod schema in `src/settings.ts`. Unknown keys are errors. Keys and secrets are never settings.
- Anything the AI says passes through `src/guards.ts`. Add a regression test for every new bait pattern.
- Never log or persist keys. Keep file permissions owner-only (`umask 077`, mode 600).
- A failure must never produce a wrong card; when unsure, show nothing or the stall line. A failure must be visible (bar, terminal line, `events.jsonl` row). Nothing may block the call.
- User-visible words follow the glossary (Prepared, AI, Buy time, Tip, For you, Math, Answer window, Plan, Readiness check, Quiet mode, Start listening).
- Examples, fixtures and docs use invented names (Dan, Dana, Acme, example.com, example.co.il). Do not commit real client data. See [CONTRIBUTING.md](../CONTRIBUTING.md).
- User data paths come from `shared/paths.cjs` (and `src/env.ts`). Never hard-code `calls/` or `data/private/`. `app/data/` is for shipped data only.
- Print errors with `errText` (`src/errtext.ts`), not the raw error object: it can contain prompts.

## Extending

- **A speech or model provider.** Write the adapter (`app/src/providers/stt/<name>.ts`, or an AI SDK package for models). Add one line to `app/src/providers/catalog.ts` (id and key variable) and one to the registry (`STT_PROVIDERS` in `providers/stt/index.ts`). The settings schema, key names and types follow from the catalog, and the compiler fails if the registry and the catalog disagree. The Keys page in the dashboard lists only Deepgram and Anthropic on purpose.
- **A language.** See [Adding a language](#adding-a-language) below.
- **A platform.** Implement `AudioBackend` (`app/src/audio-platform.ts`): a mic source and a system-audio source. macOS (AudioTee, ffmpeg) and Windows (the app backend with Electron loopback) exist. Linux is a stub with a TODO note.
- **Lint rules.** "Never use X" checks (innerHTML, eval, hand-built `.bin` paths) are ESLint rules in `app/eslint.config.mjs`, not tests.

## Adding a language

Today the code knows two languages, `he` and `en`. The speech service and the AI model handle many languages, so a new one is mostly Wingman's own word files and texts. The steps, in the order to do them. The type checker (`"he" | "en"` appears in many files) shows you the places you missed.

1. **The language file.** Add `app/src/lang/<id>.ts` that satisfies the `Language` type in `lang/types.ts`: question heads and phrases, request cues, fillers, number words, and the price, date, promise and salary patterns the guards use. The type has no optional fields, so it does not compile without the guards. Add it to `LANGUAGES` in `lang/index.ts` and widen the `id` type. `lang.test.ts` fails if a guard family is empty. Copy `en.ts` as a start.
2. **Speech to text.** Add the language to the `stt.language` list in `src/settings.ts` and `config/defaults.yaml`, and pass the right code to Deepgram (`providers/stt/deepgram.ts`). Check that Deepgram Nova-3 supports it and whether it can mix with English (`multi` covers only some languages). `lang.ts` drops finals that are mostly in another script (`stt.dropForeignScript`): a new script must be allowed there, and `langwatch.ts` (the "unsupported language" notice) must know the language.
3. **The language of the call.** `calllang.ts` decides the language of summaries, notes and tips (today `he` or `en`, by the share of Hebrew letters). Extend it, and the language of the follow-up email and the summary labels (`summary.ts`, `summary-email.ts`, `htext.ts`).
4. **Window texts.** Add `dashboard/strings.<id>.js`, the language in `overlay/strings.js` and `tray/menu-text.cjs`, and the language list in `dashboard/i18n.js` (and the right-to-left rule if needed). `dashboard-i18n.test.ts` checks that every string exists in every language. Take new snapshots (see below).
5. **The pack.** Starter packs have a `bank.<id>.yaml` next to `bank.yaml` (`data/starter-packs/`). `bank.ts` picks cards by the language of the question.
6. **Tests and numbers.** Add test meetings in the new language to `data/meetings/dev` and run `pnpm eval`. Add question cases to `data/questions.tsv` and run `pnpm detector`. Run the unit tests and `pnpm snapshots`.

Plan for a real Hebrew-quality check before you call a language supported: record a short call and look at the cards. Our own numbers for Hebrew are weaker than for English (see the [Roadmap](ROADMAP.md#known-limits)).

## Folder map

| Path | Content |
|---|---|
| `src/` | Engine, providers (`providers/`), CLI (`cli/`), tests (`*.test.ts`) |
| `tray/` | Menu-bar app main process, call controller, control socket, attachments, settings catalog |
| `dashboard/` | The window (Home, Calls, Settings) |
| `overlay/` | The answer window and its snapshot fixtures |
| `shared/` | Design tokens, shared UI helpers, `paths.cjs` (where user data lives) and `migrate.cjs` (one-time copy from the old in-repo folders) |
| `config/defaults.yaml` | Every setting, documented |
| `profiles/` | Named setting overrides (`--profile`) |
| `data/` | Shipped data only: `example-pack/` (bank, house style, keyterms, topics), question corpus, gold-set script, demo and test fixtures. Your own data is in `~/Library/Application Support/Wingman`. `data/private/` is git-ignored and only holds the optional denylist |
| `qa/` | Synthetic QA harness |
| `scripts/` | `wingman.sh` (start the app), `wingman-cli.sh`, `make-app.sh`, `check-env.cjs`, `postinstall.cjs`, `set-fuses.cjs` |
| `../install.sh` | Installer, updater, uninstaller |
| `../.github/workflows/` | CI |
| `../brand/` | Logo and icons |
| `../docs/` | Documentation |

Next: [Architecture](ARCHITECTURE.md) · [Pack format](PACK-FORMAT.md) · [Troubleshooting](TROUBLESHOOTING.md) · [Contributing](../CONTRIBUTING.md)
