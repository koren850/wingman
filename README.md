# Wingman

A live meeting assistant for macOS. It listens to your call (the other side on system audio, you on the microphone), transcribes it in real time, and shows short answer cards on a second screen: a ready-made answer from your own answer bank when the other side asks a common question, or a short AI answer when it does not. It also answers questions you ask it out loud, does simple math locally, keeps a checklist of what the call should cover, and writes a summary and follow-up email draft when the call ends. It was built by Dan, who runs a small web and hosting agency in Israel, for his own Hebrew support and sales calls, so Hebrew (with English tech words mixed in) is the first-class language.

![The Wingman answer window during a call: a "For you" card, a math result and a Prepared card, all invented examples](docs/ux/for-you-card.png)

*The answer window on the second screen. The cards here are invented examples. The window is right-to-left because the cards are Hebrew.*

> Wingman is a personal tool in an early stage ("Stage 0"). It works and is tested, but it is not a polished product. See [Project status](#project-status).

## Key features

| Feature | What it does |
|---|---|
| **Prepared** cards | A local answer bank (`stage0/data/bank.yaml`, 41 cards) answers common questions (DNS, SSL, backups, slow site...) in about half a second, with no AI call. |
| **AI** cards | When the bank has nothing, a small Claude model writes a short answer. AI cards are always marked as not verified. |
| **Buy time** lines | For prices, dates and promises Wingman never invents a number. It shows a safe stalling line ("I will check and come back with a proper price"). |
| **For you** cards | Ask Wingman a question out loud (or press Ctrl+Opt+A) and the answer shows in its own card. |
| **Math** | Arithmetic ("36 plus 42", "15% of 200", Hebrew and English number words) is computed locally. No AI, instant. |
| **Tip** cards | At most one short tip every two minutes (a question to ask, a reminder), never during an answer. |
| **Call checklist** | Wingman works out what the call is about (client, support, vendor, team, consult, personal) and keeps a checklist for that kind of call. |
| **Plan** | A one-minute briefing before the call: who, goal, notes, must-cover items, background files. Used for one call. |
| **Fact cards** | If you build a local snapshot of your clients and domains, a mention of a known client or domain shows what you already know. No network lookups during the call. |
| **Capture chips** | Phone numbers, emails and domains spoken in the call appear as copyable chips. |
| **Summary** | After the call: summary, decisions, next steps, open questions and a follow-up email draft. Prices, dates and promises become `[להשלים: ...]` placeholders. |
| **Readiness check** | One command or button that tests mic, system audio, keys, speech service and the AI before you go live. |
| **Health and fallbacks** | A visible bar if something degrades. A degrade ladder keeps the call going (reduced AI, bank only, transcript only). Nothing blocks the call. |
| **Menu-bar app and CLI** | An Electron menu-bar app with a Home / Calls / Settings window, and a `wingman` command line that drives the running app. |

## How it works

```
mic (you) ----------------+                                   +--> Prepared bank (local, ~0.5 s)
                          +--> Deepgram Nova-3 --> question --+
system audio (them) ------+     speech to text     detector   +--> Claude Haiku (short AI answer
 (AudioTee, macOS)             (two channels)                       or "Buy time" line, ~1-2 s)
                                                                          |
                                                                          v
                                                         guards (no prices, dates, promises)
                                                                          |
                                                                          v
                                                    Answer window on your second screen
```

Two audio channels go to the speech service, one for each side, so Wingman always knows who said what. A local detector decides whether a line from the other side is a question. The bank is tried first because it is fast, free and written by you. A small AI model decides whether to skip, stall, pick a bank card or write an answer. Every AI line passes through code guards before it can be shown. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- **macOS only.** System audio is captured with AudioTee (Core Audio tap, macOS 14.2 or newer). There is no Windows or Linux support.
- Node.js 24 and pnpm.
- `ffmpeg` on your PATH (used for the microphone and for replaying audio files).
- A **Deepgram** API key (speech to text) and an **Anthropic** API key (the AI). Both are paid services. See [costs](docs/ARCHITECTURE.md#latency-budget-and-cost-model): roughly a dollar an hour of call for speech, plus a few cents of AI.
- A second screen is strongly recommended. With one screen the answer window refuses to open (so it cannot end up in a screen share).
- Microphone and System Audio Recording permission for the app that runs Wingman.

Honest limits: Hebrew-first (English works, other languages are untested); needs the internet and both keys; not a recording or consent tool; answers are hints, not facts.

## Quick start

The app lives in `stage0/`.

```bash
cd stage0
pnpm install                 # also builds .app/Wingman.app, a renamed Electron runtime

pnpm keys set deepgram       # hidden prompt; stored in the macOS Keychain
pnpm keys set anthropic      # (or paste them in the app: Settings -> Keys)

pnpm run doctor              # the Readiness check. Allow Microphone + System Audio Recording when macOS asks,
                             # then quit and reopen your terminal. Run it from Terminal.app.

pnpm dashboard               # opens the menu-bar app and its window
```

In the window: **Home -> Run check** until it says READY, optionally **Plan a call**, then try **Practice call (offline, free)**. A pretend client plays through the real call loop and the real answer window, and nothing leaves your Mac. When you are ready, press **Start call**.

Notes:
- `pnpm run doctor`, not `pnpm doctor` (the second one is pnpm's own command).
- Never put keys in the repo. They belong in the Keychain.
- No second screen yet? Use `WINGMAN_ALLOW_PRIMARY=1`, and never share that screen.

More operator detail (all commands, settings, hotkeys): [stage0/README.md](stage0/README.md).

## Command line

```bash
cd stage0
pnpm -s wingman help         # full help
pnpm -s wingman status       # is the app running, is a call live
pnpm -s wingman start --practice
```

The `wingman` command talks to the running menu-bar app over an owner-only local socket. It cannot read API keys.

## Privacy and safety in short

- Audio goes to **Deepgram** to be transcribed. Text of the call goes to **Anthropic** for AI answers and the summary. Nothing else leaves your Mac.
- Audio is **never saved**. Transcripts and cards are saved locally in `stage0/calls/<id>/` with owner-only permissions, until you delete them.
- API keys live in the macOS Keychain, not in files.
- **You are responsible for telling the other people on the call** that a transcription and AI tool is running, and for following the recording and privacy laws that apply to you. Wingman is not a consent tool and gives no legal advice.
- Not for real job interviews or exams.

Full details: [docs/PRIVACY-AND-SECURITY.md](docs/PRIVACY-AND-SECURITY.md) and [SECURITY.md](SECURITY.md).

## Project status

A personal tool, built and used by one person. It is at "Stage 0": the live call loop, the app, the CLI, the summary and the QA harness are built and tested (about 355 unit tests, plus a synthetic QA harness that plays invented scenarios through real Deepgram and Haiku). It has been verified with synthetic and test calls; the real-call hand tests still open are listed in [docs/ROADMAP.md](docs/ROADMAP.md). Signed installers, Windows, plugins and a setup wizard are not built and will wait until a second real user needs them.

## Repo map

| Path | What is there |
|---|---|
| `stage0/` | The app: engine (`src/`), menu-bar app (`tray/`), window (`dashboard/`), answer window (`overlay/`), QA harness (`qa/`), settings (`config/`), data (`data/`) |
| `brand/` | Logo, icons and the script that builds them |
| `docs/` | Documentation (below) |
| `docs/ux/` | Screenshots and UX before/after images |
| `docs/history/` | The original plan, structure, red-team review and proposals, kept for context |
| `CHANGELOG.md` | Milestones |

## Documentation

| Doc | Read it for |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, call lifecycle, files, latency and cost, tests |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Decision log: what we chose and why |
| [docs/PRIVACY-AND-SECURITY.md](docs/PRIVACY-AND-SECURITY.md) | What data goes where, what is stored, how keys are handled |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Setup, scripts, tests, QA harness, building the app |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Open items, known limits, ideas |
| [docs/history/](docs/history/README.md) | Original planning documents |
| [stage0/README.md](stage0/README.md) | The detailed app and operator guide |

## License

MIT, see [LICENSE](LICENSE).
