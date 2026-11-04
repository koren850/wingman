# Development

Everything is in `stage0/`. Run commands from there.

## Setup

For the full app, use the installer at the repo root:

```bash
./install.sh --check    # what is present, what is missing
./install.sh            # checks the Mac, installs, builds the app
```

For code work only (no Electron download, no app):

```bash
cd stage0
WINGMAN_SKIP_APP=1 pnpm install
./node_modules/.bin/tsc --noEmit -p .   # type check
pnpm test                               # unit tests (515, about 2 minutes)
```

Needs macOS 14.2 or newer, Node 24 or newer, pnpm 11 (through `corepack enable`; the version is pinned in `package.json`) and `ffmpeg`. Poppler (`pdftotext`) is optional, for PDF attachments. Keys are not needed for unit tests: they use mocks and fake keys, and the real Keychain runner refuses to run under the test runner. For live work, add keys with `pnpm keys set deepgram` and `pnpm keys set anthropic`. Never commit keys.

## Install, update, uninstall

`install.sh` at the repo root does all of it. It never uses sudo and never installs Node. It is safe to run again.

| Command | What it does |
|---|---|
| `./install.sh` | Checks macOS, Node, pnpm, ffmpeg. Runs `pnpm install --frozen-lockfile`. Builds `stage0/.app/Wingman.app`. Offers: copy it to `/Applications`, add the `wingman` link in `~/.local/bin`, `brew install ffmpeg`. |
| `./install.sh --check` | Only reports. Changes nothing. |
| `./install.sh --dry-run` | Prints every step it would run. |
| `./install.sh --yes` | Takes the default answer to each offer. Without a terminal and without `--yes`, every offer is declined. |
| `./install.sh --offline` | Passes `--offline` to pnpm (local package cache only). |
| `./install.sh --update` (or `wingman update`) | `git pull --ff-only`, `pnpm install`, rebuild the app. |
| `./install.sh --uninstall` (or `wingman uninstall`) | Removes the app copies and the `wingman` link. Your data stays. |
| `./install.sh --uninstall --purge` | Also deletes `~/Library/Application Support/Wingman`, `~/.config/wingman` and the Keychain keys, after you type `DELETE`. |
| `cd stage0 && pnpm run install-app` | Builds the app and copies it to `/Applications` (`make-app.sh --install`). |

Environment: `WINGMAN_APPS_DIR` (default `/Applications`), `WINGMAN_BIN_DIR` (default `~/.local/bin`), `WINGMAN_SKIP_APP=1` (skip the Electron download and the app build: CI and tests).

What `pnpm install` does in `stage0/`:

- `scripts/check-env.cjs` (preinstall) stops early with a clear message on Node older than 24 or macOS older than 14.2.
- `scripts/postinstall.cjs` downloads the Electron runtime (Electron 45 does not do it by itself) and builds the app. A failure stops the install and prints the fix. It is not swallowed.

`~/.local/bin` must be on your PATH for the `wingman` command.

## Scripts (`package.json`)

| Script | What it does |
|---|---|
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
| `pnpm gate` | Hebrew STT gate on recordings in `data/gold/recordings/` (`--count`, `--ids`, `--no-keyterms`, `--language`). |
| `pnpm synth` | Rebuilds the synthetic test audio with the macOS Hebrew voice. |
| `pnpm factscheck` | Counts false fact-card hits on ordinary lines. |
| `pnpm qa` | Synthetic QA harness (below). |
| `pnpm make-app` | Builds `.app/Wingman.app` (below). `scripts/make-app.sh --check` only reports. |
| `pnpm run install-app` | `make-app.sh --install`: build and copy to `/Applications`. |

## Tests

- Unit tests are `src/*.test.ts` (515 at the time of writing), run with `tsx --test --test-concurrency=1`. Run one file with `pnpm exec tsx --test src/guards.test.ts` (use the file you need).
- Do not start a second `pnpm test` while one is running; they share ports and files.
- Test names say what they protect. Bug fixes should come with a regression test.
- The "repo guard" test fails if a tracked source, data or config file contains a word from your private word list. Set it with `WINGMAN_DENYLIST="word1,word2" pnpm test`, or one word per line in the git-ignored `stage0/data/private/denylist.txt`. With no list it skips. How and why: [CONTRIBUTING.md](../CONTRIBUTING.md#the-private-word-list-repo-guard).
- Tests redirect user data with `WINGMAN_DATA_DIR`, `WINGMAN_CALLS_DIR` and friends, so they never touch your real calls.
- CI (`.github/workflows/ci.yml`) runs on macOS with Node 24: `WINGMAN_SKIP_APP=1 pnpm install --frozen-lockfile`, the type check, then the tests. There is no private word list in CI, so the repo guard skips there.
- There is an offline end-to-end test (`src/e2e.test.ts`) that runs a whole call with scripted speech and a scripted AI (`src/providers/scripted.ts`).

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

Used for UX checks and for the images in `docs/ux/`. In snapshot mode the app creates a hidden window, no tray, no global shortcuts, and never starts a call. Run snapshots one at a time.

- Window: set `WINGMAN_DASHBOARD_SNAPSHOT=<out.png>` and optionally `_VIEW=home|inbox|settings`, `_THEME`, `_SIZE`, `_OPEN`, `_FOCUS`, `_SCROLL`, `_EVAL`; `WINGMAN_DASHBOARD_FAKE_CALL=waiting|live|live-warn|stopping|ended`; `WINGMAN_DASHBOARD_FAKE_DOCTOR=ready|notready`. Use `WINGMAN_CALLS_DIR`, `WINGMAN_BRIEFS_DIR` (or `WINGMAN_DATA_DIR`) and `WINGMAN_USER_SETTINGS` to point at fixtures so real data is never shown.
- Answer window: `overlay/snapshot.sh <outDir> [scenario:keys ...]` (scenarios such as full, empty, listening, waiting, overflow, quiet, foryou, flow, flowyou, speakers; keys such as rewind, pause). Fixtures are in `overlay/fixtures.cjs`. For your own cards, write a `cards.jsonl` in a temp folder and run `WINGMAN_CALLS_DIR=<temp> WINGMAN_OVERLAY_SNAPSHOT=<out.png> stage0/node_modules/.bin/electron stage0/overlay/main.cjs`.
- Use only invented data in anything you publish.

## Building the .app

`pnpm make-app` (also run by `pnpm install` and `install.sh`) copies the Electron runtime to `stage0/.app/Wingman.app`, renames it to Wingman, sets the icon from `brand/Wingman.icns`, sets the permission texts in `Info.plist` (microphone and system audio), turns off three Electron fuses, and adds a small launcher that runs this repo's `tray/main.cjs`.

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
- User data paths come from `shared/paths.cjs` (and `src/env.ts`). Never hard-code `calls/` or `data/private/`. `stage0/data/` is for shipped data only.
- Print errors with `errText` (`src/errtext.ts`), not the raw error object: it can contain prompts.

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
