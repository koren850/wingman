# Development

For people who want to build, test or change Wingman. Everything is in `app/`. Run commands from there. If you only want to try it, see [Getting started](GETTING-STARTED.md).

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
pnpm test                               # all tests (750+, about 5 minutes)
pnpm demo                               # the offline demo call, no keys (about 90 seconds)
pnpm eval                               # detector, bank and guard quality numbers, no keys
```

Before you open a pull request, `pnpm check` runs the type check, lint, format check, unit tests and `pnpm eval` in one go.

Needs macOS 14.2 or newer, Node 24 or newer, pnpm 11 (through `corepack enable`; the version is pinned in `package.json`) and `ffmpeg`. Poppler (`pdftotext`) is optional, for PDF attachments. Keys are not needed for unit tests: they use mocks and fake keys, and the real Keychain runner refuses to run under the test runner. For live work, add keys with `pnpm keys set deepgram` and `pnpm keys set anthropic`. Never commit keys.

## Get your API keys

Live work needs two paid keys. Deepgram (speech to text): sign up at [console.deepgram.com/signup](https://console.deepgram.com/signup) and create a key in the console. Anthropic (the AI): create an account at [platform.claude.com](https://platform.claude.com), add credit under Billing and create a key under [Settings, API keys](https://platform.claude.com/settings/keys). Paste them in the app's first-run setup or **Settings, Keys**, or run `pnpm keys set deepgram` and `pnpm keys set anthropic`. Cost: about $1.10 an hour for speech plus roughly 5 to 20 cents an hour for AI. Unit tests need no keys.

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
| `pnpm eval` | The release gate, offline: the golden dev meetings through the v2 engine (recall, precision, time to card, cost), four bad-model controls, cost and latency per role against `qa/budgets.json` (+20 percent fails), the memory eval and the rubric judge. The old word-list numbers come last as a smoke test. Fails if one drops below `qa/eval-baseline.json`. `--final` reads the held-out splits once, `--cassette <file>` plays a recording of the real model. See "Release gates" below. |
| `pnpm eval:memory` | Memory-quality eval (`qa/memory-eval.ts`): precision and recall of the final call memory on 12 labelled calls, with a null and a copy-all control. Offline with the policy fake; `WINGMAN_LLM_MODE=replay` reads a cassette. |
| `pnpm check` | Type check, lint, format check, unit tests and `pnpm eval`. |
| `pnpm start` | The call engine (`src/run.ts`) in the terminal. Flags: `--file x.wav` (replay a stereo WAV, left = me, right = them), `--no-ai`, `--discard`, `--profile`, `--set key=value`. |
| `pnpm call` | Starts a call and opens the answer window. Ctrl+C stops and saves. |
| `pnpm dashboard` | The menu-bar app with its window open (`scripts/wingman.sh --open-window`). |
| `pnpm tray` | The menu-bar app only. |
| `pnpm overlay` | The answer window alone. |
| `pnpm wingman <cmd>` | The CLI (`wingman help`). `scripts/wingman-cli.sh` is the same command and can be symlinked onto your PATH. |
| `pnpm run doctor [--offline]` | The Readiness check. (`pnpm doctor` is a different pnpm command.) |
| `pnpm keys status|set|remove|migrate` | Keychain keys. |
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

- Unit tests are `src/*.test.ts` (`pnpm test:unit`, about 40 s); end-to-end tests that start the engine as a subprocess are `src/e2e/*.test.ts` (`pnpm test:e2e`, about 4 min). `pnpm test` runs both with `tsx --test --test-concurrency=1`. Run one file with `pnpm exec tsx --test src/guards-table.test.ts` (use the file you need).
- Do not start a second `pnpm test` while one is running; they share ports and files.
- Test names say what they protect. Bug fixes should come with a regression test.
- The "repo guard" test fails if a tracked source, data or config file contains a word from your private word list. Set it with `WINGMAN_DENYLIST="word1,word2" pnpm test`, or one word per line in the git-ignored `app/data/private/denylist.txt`. With no list it skips. How and why: [CONTRIBUTING.md](../CONTRIBUTING.md#the-private-word-list-repo-guard).
- Tests redirect user data with `WINGMAN_DATA_DIR`, `WINGMAN_CALLS_DIR` and friends, so they never touch your real calls.
- Some `WINGMAN_*` variables are test hooks and are not part of the product (for example `WINGMAN_DASHBOARD_EVAL`, which runs a script inside the dashboard page, `WINGMAN_KEYS_FILE` and `WINGMAN_PACK_DIR`). They only matter to someone who controls the environment a program is started from, which already means they run code as you.
- CI (`.github/workflows/ci.yml`) runs on Node 24 on macOS and Linux (both must pass) and on Windows (experimental, may fail): `WINGMAN_SKIP_APP=1 pnpm install --frozen-lockfile`, the type check, unit tests, end-to-end tests and `pnpm eval`. Lint, the format check and coverage run on macOS only. There is no private word list in CI, so the repo guard skips there. A separate macOS job runs `install.sh --check` and `--dry-run`.
- There is an offline end-to-end test (`src/e2e/scripted-call.test.ts`) that runs a whole call with scripted speech and a scripted AI (`src/providers/scripted.ts`).
- `src/e2e/chaos.test.ts` is a repeatable chaos test (about 45 s, offline): one scripted live call with AI timeouts, a mic drop, a 20 s speech-to-text outage and a sleep/wake, then it checks the health and ladder events and that the call recovers. Run it alone with `pnpm exec tsx --import ./src/test-setup.ts --test src/e2e/chaos.test.ts` from `app/`.

## Test kit (model tests without a key)

New model-driven features are tested with these tools, all in `app/src/testkit/` and `app/src/providers/cassette.ts`. None of them calls a real API.

- **Policy fake model** (`testkit/policy-model.ts`). The test declares what the model says; the fake never decides by itself. `pm.reply({ role: "moment", lastLine: "l3" }, text, { ms })`, and `garbage()`, `truncate(n)`, `hang()`, `refuse()`, `error(529)`, `slow(ms)`, `injection(text)`. A rule can match the role (`moment`, `memory`, `ask`, `digest`, `compact`, `wrapup`), the last transcript line (its `[id]` or its text) and any text in the system block. The first rule that matches wins. A call with no matching rule fails loudly. `pm.assertPrompt(...)` checks what the model received (a memory block, a token limit). `setUsage()` sets the tokens it reports, for cost tests. `pm.serve(golden.script)` serves the scripted replies of a golden meeting. A package that adds a role calls `registerRole(role, marker)` (in `testkit/prompt.ts`) with a phrase from its system prompt.
- **Cassettes** (`providers/cassette.ts`). `WINGMAN_LLM_MODE=live|record|replay`, default `live`. In `replay` every call must be in the cassette (`WINGMAN_CASSETTE`, default `data/cassettes/default.cassette.json`) and no key or network is used. A miss shows a diff against the nearest entry. `record` needs a key and is for the owner only; it is never run in CI. Each entry says if it was `recorded` or `authored`.
- **Prompt snapshots** (`testkit/prompt-snapshot.ts`). `assertPromptSnapshot("moment", { system, user })` compares the prompt with `data/snapshots/prompts/moment.txt`. After an intended change run once with `WINGMAN_UPDATE_SNAPSHOTS=1` and review the diff of the file.
- **Virtual clock** (`testkit/vclock.ts`). `withVClock(async (vc) => { await vc.advance(90_000); })` fakes `Date.now`, `new Date()`, `performance.now`, `setTimeout`, `setInterval` and `setImmediate`. 90 seconds of meeting run in a few milliseconds. New code can read time through `wallNow()` and `monoNow()` in `clock.ts`.
- **Golden helpers** (`e2e/helpers.ts`). `replayOnVClock` plays `Golden.lines` in this process. `runGolden` plays them into the real engine (`src/run.ts`) with scripted speech and the policy fake (profile `e2e-policy`) and returns the card timeline: id, kind, text, and ms after the line. The engine is one process per call and keeps its real clock, so `runGolden` runs in real time (use `speed` to compress the gaps between lines).
- `legacyScripted` (also exported as `scriptedAnswer`) is the old keyword fake. It stays until the v2 engine is in; do not use it in new tests.

## v2 gate tests (`app/src/e2e/v2-*.test.ts`)

Six files prove the v2 engine as a whole. They use no network and no key. Run one with `./node_modules/.bin/tsx --import ./src/test-setup.ts --test src/e2e/v2-<name>.test.ts`; all six together take about two minutes.

| File | What it proves |
|---|---|
| `v2-latency` | Time to the first card on the virtual clock: a model answer (p50 1.5 s, p95 2.5 s), a bank hit (0.6 s, 1.9 s), the stall line by 1.8 s, a late observer card (more than 6 s) dropped, a hung memory updater adds no delay. |
| `v2-cost` | Price per call and per role from `usage.jsonl`, replayed over the golden dev meetings, against the PLAN table. Fails at +20 percent per role. Also dollars per hour (gate: $0.25) and a what-if for the cache layout. |
| `v2-golden` | The golden dev meetings through the real engine modules with the memory loop on, graded by `qa/grade-golden.ts`, with the null control, the noise control and the noisy-transcript delta. |
| `v2-resilience` | The failure matrix: model down, slow, 429 storm, truncated and garbage replies, STT down, both down, corrupt `session.json`, a real SIGKILL during a save, clock jump, no brief, a 5 MB brief. Each case: no empty screen, a bar when something is wrong, no crash. |
| `v2-soak` | A 3-hour call on the virtual clock with faults (disk full for the memory, a corrupt `session.json`, a 5-minute model outage, a clock jump). Calls per hour, cost per hour and memory size stay bounded. |
| `v2-prompts` | Prompt snapshots for moment, observer, memory, compact and wrap-up, the block layout, and a check that the memory reaches the moment and observer prompts. |

How they work: `v2-kit.ts` wraps the policy fake so that every call reports the usage of its real prompt, with a simulated prompt cache (a marked prefix is cached from 1024 tokens, read at the cache-read price, written at the cache-write price). `v2-worker.ts` plays one golden meeting in a child process, because the engine is one call per process. Scripted replies prove plumbing, timing, budgets and state logic. They do not prove model judgement or Hebrew quality; that needs a recorded run (`pnpm cassette:record`).

## Release gates (`pnpm eval`, budgets, held-out, snapshots)

Every number is marked **scripted** (the replies in the golden files; they prove plumbing, timing and the grader) or **recorded** (replayed from a cassette of the real model; they measure the model). Only the recorded numbers can say the product is good.

| Command | What it does |
|---|---|
| `pnpm eval` | Dev meetings, v2 engine, scripted. Metric table against `qa/eval-baseline.json` (`v2`), the four controls, the per-role budgets, the memory eval, the rubric judge. About 30 s on a quiet machine. |
| `pnpm eval --update` | Rewrites the baseline and `qa/budgets.json` (`scripted`). Read the diff first. No baseline value is zero (a metric that is truly zero is stored at a small floor). |
| `pnpm eval --final` | The held-out splits `test` and `test-b`, each played on its own, printed next to the dev baseline. Prints only and enforces only the hard limits. Read it once. Never tune after it. |
| `pnpm eval --cassette data/cassettes/dev.cassette.json` | Dev played against the recording. Marked RECORDED; compared with the `v2Recorded` baseline; the model judge reads `dev.judge.cassette.json` if it exists. `--update` writes the first recorded baseline and the `recorded` budgets. |
| `pnpm eval --only id1,id2` | Some dev meetings (numbers are not comparable with the baseline). |
| `pnpm snapshots` | `scripts/snapshot-check.sh [outDir]`: hidden overlay checks in English and Hebrew (44 specs each) and the dashboard matrix (24 pictures, both languages, light and dark, narrow). Fails on clipping, contrast, font size, direction or a window that took focus. About 2 to 4 minutes. |

Budgets (`qa/budgets.json`): per role, USD per call and USD per hour; per card path (direct question, observer), time to card p50 and p95; the whole call per hour (release gate $0.25). A role or path over its budget by more than 20 percent fails the eval, and `src/e2e/v2-cost.test.ts` fails the same way per call. The `oneShot` entries (digest, wrap-up) are measured by `v2-cost.test.ts`.

Fault soak: `src/e2e/r2-soak.test.ts` runs an 80 minute call on the virtual clock with a hung audio respawn, a display unplug (injected screen), a dead STT socket, a slow model and a 529 storm, and a probe question inside each fault. A second case stops a real v2 process with a stray error. `WINGMAN_E2E_ENGINE=v2` plays the older child-process e2e files (`reliability-r2`, `chaos`, `engine-reliability`) on the v2 engine instead of the pinned classic one.

## Recording a cassette (owner, by hand)

Recording calls the real model and costs money. An agent never runs it, CI refuses it. It needs `ANTHROPIC_API_KEY` in the environment of that one command (nothing reads a key file). Order: dev, then test-b, then test.

```bash
cd app
ANTHROPIC_API_KEY=... pnpm cassette:record --suite dev --cap 1 --judge
ANTHROPIC_API_KEY=... pnpm cassette:record --suite test-b --final --cap 0.25 --judge
ANTHROPIC_API_KEY=... pnpm cassette:record --suite test --final --cap 0.25 --judge
pnpm eval --cassette data/cassettes/dev.cassette.json --update      # first recorded baseline and budgets
pnpm eval --final --cassette data/cassettes/test.cassette.json,data/cassettes/test-b.cassette.json   # the held-out, once
```

The command prints a one-page estimate first and refuses when it is over the cap (`--allow-partial` stops at the cap instead). Estimates (modelled cost per hour of the baseline times 2 for real prompt sizes; the judge at $0.0004 a card): dev about $0.25 (+ $0.28 judge) and about one hour of wall time at 4 meetings at a time; test-b about $0.03 (+ $0.04) and about 10 minutes; test about $0.05 (+ $0.06) and about 12 minutes. Treat these as floors. Check the first meeting's booked cost before you leave it alone. The recorder plays at real time (pace 1) because the real model answers in real time.

Held-out cassettes (`test`, `test-b`) must be recorded and replayed once, after the dev numbers are final. Do not edit a prompt after you have looked at them.

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

## Building the app (.dmg)

`pnpm dist` builds a Wingman.app that carries its own engine and needs no Node, no pnpm and no checkout. It writes `app/dist/Wingman-<version>-arm64.dmg` and the app itself in `app/dist/mac-arm64/`. It needs a normal `pnpm install` first (esbuild and electron-builder are dev dependencies). The dev setup above (`pnpm`, `tsx`, `install.sh`, `make-app.sh`) does not change.

- **Why electron-builder.** It makes the .dmg, handles signing and notarizing, and writes the files an updater needs, all from one config (`electron-builder.cjs`). Electron Forge would need a separate maker for each of these.
- **The engine.** `scripts/package-app.cjs` bundles `src/*.ts` with esbuild into `src/*.mjs` (the call, the readiness check, the summary and the small settings tools) and copies the menu-bar code, the windows, the example pack, the practice-call data and the `audiotee` binary into `app/.stage/`. electron-builder packs that folder without an asar archive (the engine runs child processes from it).
- **How it runs.** The app starts its own executable for each tool: `Wingman --wingman-tool <name> -- <args>` and `Wingman --wingman-overlay` (`tray/app-entry.cjs`). Only the tool names listed in `shared/bin.cjs` can run, and no path from the command line is loaded. The `RunAsNode` fuse stays off (`scripts/after-pack.cjs` calls `scripts/set-fuses.cjs`). `shared/bin.cjs` switches to this mode when `packaged.json` is next to the code; in a checkout it never is.
- **Data.** Settings, keys, packs and calls are in the same places as for the dev app (`~/.config/wingman`, the Keychain, `~/Library/Application Support/Wingman`), so the two builds share them. Do not run both at once.
- **Not in the app.** `ffmpeg` (the microphone) is found on the PATH at run time, with `/opt/homebrew/bin` added; `pdftotext` is optional. The `wingman` command-line tool stays a dev feature for now: it needs the checkout.
- **Unsigned.** There is no Apple Developer account yet, so the app is only ad hoc signed. On first start macOS says it cannot verify the app: open System Settings, Privacy & Security, and choose "Open Anyway". Microphone and system-audio permissions are asked again after each new build, because an ad hoc signature changes with every build.
- **Signing later.** Set `WINGMAN_SIGN=1` plus `CSC_LINK`, `CSC_KEY_PASSWORD` (Developer ID certificate) and `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (or an App Store Connect API key). `WINGMAN_NOTARIZE=0` signs without notarizing. The entitlements are in `build/entitlements.mac.plist`.
- **Release.** `.github/workflows/release.yml` builds the .dmg on a `v*` tag and attaches it to a draft release. It has not been run yet.
- **Check a build without showing windows.** Run `dist/mac-arm64/Wingman.app/Contents/MacOS/Wingman` with `WINGMAN_DASHBOARD_SNAPSHOT=<out.png>` (hidden window), or run the offline demo from inside the bundle: `Wingman --wingman-tool run -- --profile demo-en --file silence.wav --no-brief` with `WINGMAN_DEMO=1`, `WINGMAN_STT_SCRIPT=<app>/Contents/Resources/app/data/demo/demo-call.en.json` and every `WINGMAN_*` path pointing at a scratch folder.

## Building the .app

`pnpm make-app` (also run by `pnpm install` and `install.sh`) copies the Electron runtime to `app/.app/Wingman.app`, renames it to Wingman, sets the icon from `brand/Wingman.icns`, sets the permission texts in `Info.plist` (microphone and system audio), turns off three Electron fuses, and adds a small launcher that runs this repo's `tray/main.cjs`.

- **Thin launcher.** It loads the repo code, so quit and reopen the app to pick up code changes. Re-run it after an Electron upgrade (`pnpm install` does).
- **The checkout path is baked in.** If you move the folder, the app says so in a dialog. Run `./install.sh` again from the new place.
- **Node 24 is needed at launch.** Node is looked up when the app starts, because apps opened from Finder have a bare PATH.
- **Fuses** (`scripts/set-fuses.cjs`): `RunAsNode`, `NODE_OPTIONS` and `--inspect` are turned off, so the app cannot be used as a free Node or debugged from outside. The script patches the binary directly and has no dependency.
- The output is git-ignored, is ad hoc signed only (not notarised), and contains the absolute path of your checkout. macOS permissions (microphone, system audio) belong to the app that runs the code: Wingman.app, or your terminal.

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
- **A language.** Add `app/src/lang/<id>.ts` that satisfies the `Language` type (question heads, request cues, fillers, price/date/promise/salary patterns) and list it in `lang/index.ts`. `lang.test.ts` fails if a guard family is empty. Run `pnpm eval` after any list change.
- **A platform.** Implement `AudioBackend` (`app/src/audio-platform.ts`): a mic source and a system-audio source. win32 and linux are stubs with TODO notes.
- **Lint rules.** "Never use X" checks (innerHTML, eval, hand-built `.bin` paths) are ESLint rules in `app/eslint.config.mjs`, not tests.

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
