<p align="center">
  <img src="docs/ux/hero.gif" alt="The Wingman answer window during a call: a client asks about a CDN, a migration and a price, and answer cards appear within about a second (invented example)" width="560">
</p>

<h1 align="center">Wingman</h1>

<p align="center"><b>Real-time answer cards for live calls. Hears both sides, shows a short answer in about a second.<br>macOS, Electron, TypeScript.</b></p>

<p align="center">
  <a href="https://github.com/koren850/wingman/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/koren850/wingman/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Platform: macOS 14.2+" src="https://img.shields.io/badge/platform-macOS%2014.2%2B-lightgrey.svg">
  <img alt="Node 24" src="https://img.shields.io/badge/node-24-339933.svg">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6.svg">
</p>

Wingman is a live call copilot for client, sales and support calls. It listens to your call (the other side on system audio, you on the microphone), transcribes it in real time and shows short answer cards on a second screen: a ready-made answer from your own answer bank when the other side asks a common question, or a short AI answer when it does not. After the call it writes a summary and a follow-up email draft. It is Hebrew-first and works in English too: the main window is English, and the answer window's labels switch between Hebrew and English (setting `ui.language`).

## Why it's interesting

- **Fast, and fast without AI.** Prepared answers from a local bank appear about 0.6 s after the speaker stops (p95 about 1.9 s). Only questions the bank cannot answer go to Claude Haiku, behind a stall line.
- **Guards are code, not prompts.** Every AI line passes deterministic filters for prices, dates and promises before it can be shown. A hit becomes a "buy time" line instead of an invented number.
- **Built for live audio that goes wrong.** Two audio channels, reconnect buffers, a circuit breaker and a degrade ladder keep the call useful when a provider fails, instead of failing the call.

## Screenshots

| Answer window | Main window |
|---|---|
| ![The answer window with an AI card, a buy-time line and a prepared card](docs/ux/answer-window-hero.png) | ![The Home view of the main window during a live call](docs/ux/home-window.png) |

All screenshots use invented data. The answer window with English labels, and with Hebrew cards (it turns right-to-left by itself):

![The answer window with English labels: an AI card, a buy-time line, captured details and notes](docs/ux/answer-window-en-ui.png)

![The answer window with Hebrew cards](docs/ux/for-you-card.png)

## Features

| Feature | What it does |
|---|---|
| **Prepared** cards | A local answer bank (your pack's `bank.yaml`) answers common questions in about half a second, with no AI call. |
| **AI** cards | When the bank has nothing, a small Claude model writes a short answer, always marked "not verified". |
| **Buy time** lines | For prices, dates and promises Wingman never invents a number. It shows a safe line such as "I will check and come back with a proper price". |
| **For you** and math | Ask out loud (Ctrl+Opt+A) and get an answer in its own card. Arithmetic, in Hebrew or English, is computed locally. |
| **Call frame, tips and checklist** | Detects what kind of call it is, keeps a checklist of what it should cover and shows at most one tip every two minutes. |
| **Flow mode** | Tells several speakers apart. When they talk among themselves, cards wait; when someone turns to you, an alert shows who. |
| **Practice and prep mode** | Rehearse with a pretend client and your own notes, then review. See [responsible use](#responsible-use). |
| **Summary** | Summary, decisions, next steps, open questions and a follow-up email draft. Prices and promises become placeholders for you to fill in. |
| **Health and fallbacks** | A visible bar when something degrades, and a ladder that keeps the call going. See [How it works](#how-it-works). |
| **Menu-bar app and CLI** | Home, Calls and Settings in an Electron app, a guided first-run setup, a readiness check and a `wingman` command line. |

More in the [user guide](docs/USER-GUIDE.md) and the [operator guide](app/README.md).

## How it works

```mermaid
flowchart LR
  mic["Microphone (you)"] --> stt
  sys["System audio (them)<br/>AudioTee, Core Audio tap"] --> stt
  stt["Deepgram Nova-3<br/>one stream per channel"] --> det["Question detector<br/>(local, Hebrew-aware)"]
  det --> bank["Prepared bank<br/>(local, about 0.6 s)"]
  det --> llm["Claude Haiku reflex<br/>skip, stall, bank pick or answer<br/>(about 1-2 s)"]
  bank --> guards["Guards<br/>price, date, promise"]
  llm --> guards
  guards --> overlay["Answer window<br/>(second screen)"]
  health["Health supervisor<br/>degrade ladder + cost cap"] -. "full, reduced AI,<br/>provider switch, bank only,<br/>transcript only" .-> llm
  health -.-> stt
```

Two audio channels go to the speech service, one per side, so Wingman always knows who said what. A local detector decides whether a line from the other side is a question. The bank is tried first because it is fast, free and written by you. A small AI model decides whether to skip, stall, pick a bank card or write an answer, and every AI line passes the code guards before it can be shown. If a provider fails or the spend cap is reached, the health supervisor steps down a rung (reduced AI, provider switch, bank only, transcript only) between questions, and steps back up when things are stable. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Engineering highlights

For reviewers who want the short version. Numbers come from this repository; latency figures are from the project's own synthetic-voice test rounds, so real calls with room noise will be slower.

- **Latency budget.** Prepared card p50 about 0.6 s and p95 about 1.9 s after the speaker stops (including about 0.4 s of speech-to-text final lag). A Haiku answer reaches its first words at about 1 to 2 s; a stall line is forced at 1.8 s, and answers to questions older than 4 s are dropped. Each call writes a `latency.jsonl`. See [the latency budget](docs/ARCHITECTURE.md#latency-budget-and-cost-model).
- **Guards are code, not prompts** ([ADR 13](docs/DECISIONS.md#adr-13-guards-are-code-not-prompts)). Three deterministic rules (price, date, promise) apply to every AI line, plus a salary guard and an unclaimed-term guard in practice mode.
- **Two audio channels, always known who spoke.** Mic and system audio go to two Deepgram Nova-3 streams; a ring buffer replays the last 2 s after a reconnect.
- **Degrade ladder and cost caps** ([ADR 24](docs/DECISIONS.md#adr-24-a-degrade-ladder-and-cost-caps)). Six rungs: full, reduced AI, provider switch, bank only, transcript only, off (user stop only). Rungs change only between questions, and recovery needs a stable period. A per-call USD cap (default $2) drops the model while prepared cards keep working; a circuit breaker stops calling a failing model.
- **Tested without a live call.** More than 500 test cases in 52 files, an offline end-to-end replay with scripted speech and AI, and a synthetic QA harness with 32 invented scenarios rendered to audio. Quality gates use numbers ([ADR 3](docs/DECISIONS.md#adr-3-numeric-gates-instead-of-opinions)). About 89% line coverage (84% branch), measured with Node's built-in coverage (`pnpm test:coverage`) over the `src/`, `shared/` and `tray/` files the tests load; the Electron window code (`tray/main.cjs`, the renderers) is exercised by the snapshot tools, not by unit tests.
- **Hebrew-first.** A Hebrew-aware question detector, Unicode whole-word matching, English technical terms mixed in, and a right-to-left aware answer window.
- **Privacy by design.** No telemetry, no cloud account, audio never stored, keys in the macOS Keychain, owner-only files and control socket, strict Content-Security-Policy in the Electron windows.
- **37 written design decisions.** [docs/DECISIONS.md](docs/DECISIONS.md) records context, decision, alternatives and consequences, including what was left out on purpose ([ADR 35](docs/DECISIONS.md#adr-35-scope-no-real-job-interviews-or-exams), [ADR 36](docs/DECISIONS.md#adr-36-web-lookup-is-not-built)).

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| Engine | TypeScript on Node 24 (tsx), zod | One typed process per call; plain JSONL files, no database |
| Speech to text | Deepgram Nova-3 (Soniox and Gladia adapters, experimental) | Streaming, per-channel, handles Hebrew with English terms |
| AI | Claude Haiku through the Vercel AI SDK | Low time to first token; prompt prefix cached |
| System audio | AudioTee (Core Audio tap), ffmpeg for the microphone | No virtual audio driver needed |
| App | Electron (menu-bar app, window, answer window) | Content protection and second-screen placement |
| Tests and CI | Node test runner, GitHub Actions on macOS | Offline end-to-end replay, synthetic QA |

## Quick start

Needs macOS 14.2 or newer, Node 24 and, if you do not have them, [Homebrew](https://brew.sh) and Xcode Command Line Tools (`xcode-select --install`) for git.

```bash
brew install node@24                       # skip if you already have Node 24
git clone https://github.com/koren850/wingman.git
cd wingman && ./install.sh                 # checks the Mac, installs, builds Wingman.app
```

`./install.sh --check` shows what is present and changes nothing; `--dry-run` shows every step; `--uninstall` removes it. The installer never uses sudo and asks before it copies the app to `/Applications`, adds the `wingman` command in `~/.local/bin` or runs `brew install ffmpeg`. Put `~/.local/bin` on your PATH (`export PATH="$HOME/.local/bin:$PATH"` in `~/.zshrc`).

Then open **Wingman**. A guided setup walks you through keys, your name, permissions, microphone, screens, the answer pack, a readiness check and a **practice call** (a pretend client; free, offline, no keys needed). Full steps: [docs/USER-GUIDE.md](docs/USER-GUIDE.md#first-run). Problems: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

### Fresh Mac

On a Mac with no developer tools, install them first (each step is skipped if you already have it):

```bash
xcode-select --install                                  # Xcode Command Line Tools (git); finish the dialog that opens
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"   # Homebrew, from brew.sh
brew install node@24 && brew link --overwrite node@24   # Node 24 (or: nvm install 24)
corepack enable                                         # gives you pnpm; ./install.sh also does this
brew install ffmpeg                                     # microphone capture and file replay
brew install poppler                                    # optional: attach PDF files to a meeting
```

Then run the `git clone` and `./install.sh` lines above.

**First launch.** The app you build is ad-hoc signed, not notarised, so macOS may refuse to open it the first time. Right-click `Wingman.app` and choose **Open**, then confirm. Or try to open it once, then go to **System Settings, Privacy & Security**, scroll to the message about Wingman and click **Open Anyway**.

**Permissions.** Wingman asks for **Microphone** (your voice) and **System Audio Recording** (the other side of the call). macOS may also ask to allow notifications, which is optional. It does not need Screen Recording, Accessibility or Camera. After you allow System Audio Recording, quit and reopen Wingman. The guided setup walks through both.

Requirements in full:

- **macOS 14.2 or newer** for the full app. System audio is captured with AudioTee (a Core Audio tap). See [Platform support](#platform-support) for Windows and Linux.
- **Node.js 24 or newer.** The installer does not install it for you (`brew install node@24`).
- **pnpm 11**, which comes through corepack (the installer turns it on).
- **`ffmpeg`** (used for the microphone and for replaying audio files). The installer offers `brew install ffmpeg`.
- Optional: **poppler** (`brew install poppler`) to attach PDF files to a meeting.
- A **Deepgram** API key (speech to text) and an **Anthropic** API key (the AI). Both are paid services; see [Get your API keys](#get-your-api-keys) and the [cost model](docs/ARCHITECTURE.md#latency-budget-and-cost-model). Roughly $1.15 to $1.30 per hour of call in total.
- A second screen is strongly recommended. With one screen the answer window refuses to open (so it cannot end up in a screen share).
- Microphone and System Audio Recording permission for Wingman (or for the terminal that runs it). The guided setup shows you how.

Honest limits: Hebrew-first (English works, other languages are untested); needs the internet and both keys; not a recording or consent tool; answers are hints, not facts.

## Get your API keys

Wingman needs two keys (both are paid services, billed to you by the provider):

1. **Deepgram** (speech to text): sign up at [console.deepgram.com/signup](https://console.deepgram.com/signup). New accounts have usually received free starting credit; check their pricing page. Create an API key in the console.
2. **Anthropic** (the AI): create an account at [platform.claude.com](https://platform.claude.com) (the old console.anthropic.com address redirects there), add a few dollars of credit under Billing, and create a key under [Settings, API keys](https://platform.claude.com/settings/keys).

Paste both keys into the first-run setup (step 1, "Keys") or later in **Settings, Keys**. They are stored in the macOS Keychain. From a terminal you can use `pnpm keys set deepgram` and `pnpm keys set anthropic`. Never put keys in the repo.

## Cost

About $1.10 an hour of call for speech (Deepgram Nova-3, two channels at about $0.55 per hour each) plus roughly 5 to 20 cents an hour for AI, so roughly $1.15 to $1.30 an hour. A per-call cap (default $2) limits AI spend. Prices in the config are estimates; check your providers' price pages. See [the cost model](docs/ARCHITECTURE.md#latency-budget-and-cost-model).

## Privacy and security

- Audio goes to **Deepgram** to be transcribed. Text of the call goes to **Anthropic** for AI answers and the summary. Nothing else leaves your Mac.
- Audio is **never saved**. Transcripts and cards are saved locally in `~/Library/Application Support/Wingman/calls/<id>/` with owner-only permissions, until you delete them.
- API keys live in the macOS Keychain, not in files.
- **You are responsible for telling the other people on the call** that a transcription and AI tool is running, and for following the recording and privacy laws that apply to you. Wingman is not a consent tool and gives no legal advice.
- **Audio capture uses a prebuilt binary.** System audio is captured by [AudioTee](https://github.com/makeusabrew/audiotee), a small helper whose npm package `audiotee` ships only a prebuilt, ad-hoc-signed universal binary (no source in the package; upstream project: [github.com/makeusabrew/audiotee](https://github.com/makeusabrew/audiotee)). It is pinned (with a hash) by `pnpm-lock.yaml`, so an install from the lockfile gets exactly that file; a dependency update would pull a new one, so review it first.
- **Keychain note.** Keys are stored through `/usr/bin/security`, so other programs you run as the same macOS user can read them without a prompt. It protects against file copies and backups, not against malware running as you. See [PRIVACY-AND-SECURITY.md](docs/PRIVACY-AND-SECURITY.md).
- **Deepgram model improvement.** By default Deepgram may use audio for its model improvement program. Turn on `stt.deepgram.mipOptOut` to opt out (it may cost more). See the privacy guide.

Full details: [docs/PRIVACY-AND-SECURITY.md](docs/PRIVACY-AND-SECURITY.md) and [SECURITY.md](SECURITY.md).

## Responsible use

Wingman listens to call audio and sends it to Deepgram and Anthropic. Tell the other people on the call that you use it, and follow the recording and privacy laws that apply to you (some places require everyone's consent). It is not a recording or consent tool and gives no legal advice. It does not store audio. Do not use it where outside help is forbidden, such as exams or job interviews that prohibit assistance. Practice and prep mode (a prepared meeting of kind `interview`) is for rehearsal with your own notes: practice runs, prepared answers and a review after the call. See [ADR 35](docs/DECISIONS.md#adr-35-scope-no-real-job-interviews-or-exams) and the [user guide](docs/USER-GUIDE.md#practice-and-prep-mode).

## Platform support

| Platform | Status |
|---|---|
| macOS 14.2 or newer | Supported: the full app, live calls and the installer. |
| Windows, Linux | The engine and file replay (`--file`) are being made to run there; live system-audio capture, the menu-bar app and the installer are macOS only. **Help wanted.** See [CONTRIBUTING.md](CONTRIBUTING.md). |

Languages: Hebrew first, English works, other languages are untested. Wingman needs the internet and both keys.

## Roadmap

Wingman is an early release (v0.1.0): the live call loop, the app, the CLI, the summary and the QA harness are built and tested on synthetic and test calls. Still open: checking the hotkeys, stop sequence and screen-share behaviour on real calls, a clean-Mac install check, a signed and notarised build, and Windows and Linux support for the live app. See [docs/ROADMAP.md](docs/ROADMAP.md) for the full list and the known limits.

## Documentation

| Doc | Read it for |
|---|---|
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | First run, updating, where files live, profile and pack, practice mode, flow mode, command line |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, call lifecycle, files, latency and cost, tests |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 37 architecture decision records: what was chosen and why |
| [docs/PRIVACY-AND-SECURITY.md](docs/PRIVACY-AND-SECURITY.md) | What data goes where, what is stored, how keys are handled |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Setup, scripts, tests, QA harness, snapshot tools, building the app |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | No sound, permissions, install problems, slow AI, disk, sleep |
| [docs/PACK-FORMAT.md](docs/PACK-FORMAT.md) | How to write your answer cards and word lists |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Verification status, known limits, ideas |
| [app/README.md](app/README.md) | The detailed app and operator guide: settings, hotkeys, commands |
| [brand/README.md](brand/README.md) | The capybara logo and how the icons are built |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, tests, commit style, no private data |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability |
| [CHANGELOG.md](CHANGELOG.md) | Release notes |

Repo layout: `install.sh` (installer), `app/` (engine `src/`, menu-bar app `tray/`, window `dashboard/`, answer window `overlay/`, QA `qa/`, settings `config/`, shipped data `data/`), `docs/`, `brand/`, `.github/`.

## Contributing

Issues and pull requests are welcome; small focused changes are the easiest to review. Read [CONTRIBUTING.md](CONTRIBUTING.md) first (setup, checks, commit style, and the rule that no real people, companies or call data go in the repo). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md) and report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE).
