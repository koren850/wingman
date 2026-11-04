# Development

Everything is in `stage0/`. Run commands from there.

## Setup

```bash
cd stage0
pnpm install          # installs dependencies and runs scripts/make-app.sh (builds .app/Wingman.app)
pnpm exec tsc --noEmit   # type check
pnpm test             # unit tests (about 355, about 2 minutes, run one file at a time)
```

Needs macOS, Node 24, pnpm and `ffmpeg`. Keys are not needed for unit tests: they use mocks and fake keys, and the real Keychain runner refuses to run under the test runner. For live work, add keys with `pnpm keys set deepgram` and `pnpm keys set anthropic`. Never commit keys.

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
| `pnpm make-app` | Builds `.app/Wingman.app` (below). |

## Tests

- Unit tests are `src/*.test.ts`, run with `tsx --test --test-concurrency=1`. Run one file with `pnpm exec tsx --test src/guards.test.ts` (use the file you need).
- Do not start a second `pnpm test` while one is running; they share ports and files.
- Test names say what they protect. Bug fixes should come with a regression test.
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

Scenarios are in `qa/scenarios/*.json` and use invented clients only. `qa/render.ts` makes a stereo WAV with macOS voices (cached by text hash in `qa/cache/`), `qa/run-qa.ts` plays it through the engine with the `qa` profile and `WINGMAN_CALLS_DIR` pointing at `qa/calls/`, and `qa/grade.ts` scores it against each scenario's `expect` blocks. Output: `qa/report.md` and `qa/report.json`. `qa/out/`, `qa/cache/` and `qa/calls/` are git-ignored. It costs real money (about $0.35 for the full set at the time of writing), and TTS speech is cleaner than real speech, so numbers are optimistic.

## Snapshot tools (screenshots without showing windows)

Used for UX checks and for the images in `docs/ux/`. In snapshot mode the app creates a hidden window, no tray, no global shortcuts, and never starts a call. Run snapshots one at a time.

- Window: set `WINGMAN_DASHBOARD_SNAPSHOT=<out.png>` and optionally `_VIEW=home|inbox|settings`, `_THEME`, `_SIZE`, `_OPEN`, `_FOCUS`, `_SCROLL`, `_EVAL`; `WINGMAN_DASHBOARD_FAKE_CALL=waiting|live|live-warn|stopping|ended`; `WINGMAN_DASHBOARD_FAKE_DOCTOR=ready|notready`. Use `WINGMAN_CALLS_DIR`, `WINGMAN_BRIEFS_DIR` and `WINGMAN_USER_SETTINGS` to point at fixtures so real data is never shown.
- Answer window: `overlay/snapshot.sh <outDir> [scenario:keys ...]` (scenarios: full, empty, listening, waiting, overflow, quiet, rewind). Fixtures are in `overlay/fixtures.cjs`.
- Use only invented data in anything you publish.

## Building the .app

`pnpm make-app` copies the Electron runtime to `stage0/.app/Wingman.app`, renames it to Wingman, sets the icon from `brand/Wingman.icns`, and adds a small launcher that runs this repo's `tray/main.cjs`. It is a thin launcher, not a bundled app: it loads the repo code, so quit and reopen the app to pick up code changes. Re-run it after an Electron upgrade (`pnpm install` does). The output is git-ignored, is not signed or notarised, and contains the absolute path of your checkout. macOS permissions (microphone, system audio) belong to the app that runs the code: Wingman.app, or your terminal.

## Code conventions

- TypeScript run directly by `tsx` (ES modules, `.ts` imports with the extension). Electron and shared UI files are plain `.cjs` and `.js`, with no framework and no build step.
- The engine has no Electron imports. The app talks to it over stdin commands and `@@wingman {json}` status lines.
- Settings: every tunable goes in `config/defaults.yaml` with a comment and in the zod schema in `src/settings.ts`. Unknown keys are errors. Keys and secrets are never settings.
- Anything the AI says passes through `src/guards.ts`. Add a regression test for every new bait pattern.
- Never log or persist keys. Keep file permissions owner-only (`umask 077`, mode 600).
- A failure must never produce a wrong card; when unsure, show nothing or the stall line. A failure must be visible (bar, terminal line, `events.jsonl` row). Nothing may block the call.
- User-visible words follow the glossary (Prepared, AI, Buy time, Tip, For you, Math, Answer window, Plan, Readiness check, Quiet mode, Start listening).
- Examples, fixtures and docs use invented names (Dana, Acme, acme.co.il). Do not commit real client data.

## Folder map

| Path | Content |
|---|---|
| `src/` | Engine, providers (`providers/`), CLI (`cli/`), tests (`*.test.ts`) |
| `tray/` | Menu-bar app main process, call controller, control socket, attachments, settings catalog |
| `dashboard/` | The window (Home, Calls, Settings) |
| `overlay/` | The answer window and its snapshot fixtures |
| `shared/` | Design tokens and shared UI helpers |
| `config/defaults.yaml` | Every setting, documented |
| `profiles/` | Named setting overrides (`--profile`) |
| `data/` | `example-pack/` (bank, house style, keyterms), question corpus, gold-set script, demo and test fixtures; `data/private/` is git-ignored |
| `qa/` | Synthetic QA harness |
| `scripts/` | `wingman.sh` (start the app), `wingman-cli.sh`, `make-app.sh` |
| `../brand/` | Logo and icons |
| `../docs/` | Documentation |
