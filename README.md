# Wingman

A live meeting assistant for macOS. It listens to your call (the other side on system audio, you on the microphone), transcribes it in real time, and shows short answer cards on a second screen: a ready-made answer from your own answer bank when the other side asks a common question, or a short AI answer when it does not. It also answers questions you ask it out loud, does simple math locally, keeps a checklist of what the call should cover, and writes a summary and follow-up email draft when the call ends. Hebrew (with English tech words mixed in) is the first-class language. The answer bank and house style are your own "pack"; an example web and hosting pack is included. Your name, how to address you and your business go in your profile.

![The Wingman answer window during a call: a "For you" card, a math result and a Prepared card, all invented examples](docs/ux/for-you-card.png)

*The answer window on the second screen. The cards here are invented examples. The window is right-to-left because the cards are Hebrew.*

> Wingman is in an early stage ("Stage 0"). It works and is tested, but it is not a polished product. See [Project status](#project-status).

## Key features

| Feature | What it does |
|---|---|
| **Prepared** cards | A local answer bank (your pack's `bank.yaml`; the example pack answers DNS, SSL, backups, slow site...) answers common questions in about half a second, with no AI call. |
| **AI** cards | When the bank has nothing, a small Claude model writes a short answer. AI cards are always marked as not verified. |
| **Buy time** lines | For prices, dates and promises Wingman never invents a number. It shows a safe stalling line ("I will check and come back with a proper price"). |
| **For you** cards | Ask Wingman a question out loud (or press Ctrl+Opt+A) and the answer shows in its own card. |
| **Math** | Arithmetic ("36 plus 42", "15% of 200", Hebrew and English number words) is computed locally. No AI, instant. |
| **Tip** cards | At most one short tip every two minutes (a question to ask, a reminder), never during an answer. |
| **Call checklist** | Wingman works out what the call is about (client, support, vendor, team, consult, personal) and keeps a checklist for that kind of call. |
| **Quick call and prepared meetings** | Start a **quick call** right now with no context, or save several **prepared meetings** (a Plan each: who, goal, notes, must-cover checklist, background files, optional time) and pick one at Start. A prepared meeting is used up by the call you start with it. |
| **Fact cards** | If you build a local snapshot of your clients and domains, a mention of a known client or domain shows what you already know. No network lookups during the call. |
| **Several speakers** | Several people on the other side are told apart ("Speaker 1", 2... or their names, from introductions or the meeting's attendees; rename with `wingman speaker <n> "<name>"`). When they talk among themselves a muted "talking among themselves" line shows who and about what, and answer cards wait. When someone turns to you, an orange "turned to you" alert shows who. Setting `flow.enabled`. |
| **Interview mode** | A prepared meeting of kind `interview` makes Wingman coach you as the candidate, from your prep notes and an optional file of your own prepared cards (see below). |
| **Profile and pack** | Your name, spellings, how to address you and your business live in a profile on your machine, not in the repo. The answer bank, house style and keyterms are a swappable pack. |
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

In the window: **Home -> Run check** until it says READY, optionally **Prepare a meeting**, then try **Practice call (offline, free)**. A pretend client plays through the real call loop and the real answer window, and nothing leaves your Mac. When you are ready, press **Quick call**, or **Start** on a prepared meeting.

Notes:
- `pnpm run doctor`, not `pnpm doctor` (the second one is pnpm's own command).
- Never put keys in the repo. They belong in the Keychain.
- No second screen yet? Use `WINGMAN_ALLOW_PRIMARY=1`, and never share that screen.

More operator detail (all commands, settings, hotkeys): [stage0/README.md](stage0/README.md).

## Profile and pack

Nothing about you is stored in this repository. Your details live on your machine:

- A **profile** file (`~/.config/wingman/profile.yaml`): your name and spellings, how to address you in Hebrew, a short "about" and your business. Set it with the `wingman profile set ...` command (see `wingman help`).
- A **pack** folder (`~/.config/wingman/pack/`): your answer bank, house style, keyterms and topic words. Without one, the invented example web/hosting pack in `stage0/data/example-pack/` is used.

## Interview mode

Create a prepared meeting with kind `interview` (`wingman plan new --kind interview ...`). Attach your prep notes as background files. To use your own prepared answers for that call, add a plan note `Prepared cards: <file.yaml>` (same format as the answer bank); they replace the normal bank. In this mode every question gets an answer, there are no "Buy time" lines, and answers are built only from your notes, never invented experience.

## Command line

```bash
cd stage0
pnpm -s wingman help         # full help
pnpm -s wingman status       # is the app running, is a call live
pnpm -s wingman start --practice
pnpm -s wingman start --quick           # no Plan; or: wingman plan list, then wingman start --plan <id>
```

The `wingman` command talks to the running menu-bar app over an owner-only local socket. It cannot read API keys.

## Privacy and safety in short

- Audio goes to **Deepgram** to be transcribed. Text of the call goes to **Anthropic** for AI answers and the summary. Nothing else leaves your Mac.
- Audio is **never saved**. Transcripts and cards are saved locally in `stage0/calls/<id>/` with owner-only permissions, until you delete them.
- API keys live in the macOS Keychain, not in files.
- **You are responsible for telling the other people on the call** that a transcription and AI tool is running, and for following the recording and privacy laws that apply to you. Wingman is not a consent tool and gives no legal advice.
- Some interviews, exams and meetings forbid outside help. Check the rules before using Wingman there.

Full details: [docs/PRIVACY-AND-SECURITY.md](docs/PRIVACY-AND-SECURITY.md) and [SECURITY.md](SECURITY.md).

## Project status

It is at "Stage 0": the live call loop, the app, the CLI, the summary and the QA harness are built and tested (about 380 unit tests, plus a synthetic QA harness that plays invented scenarios through real Deepgram and Haiku). It has been verified with synthetic and test calls; the real-call hand tests still open are listed in [docs/ROADMAP.md](docs/ROADMAP.md). Signed installers, Windows, plugins and a setup wizard are not built and will wait until a second real user needs them.

## Repo map

| Path | What is there |
|---|---|
| `stage0/` | The app: engine (`src/`), menu-bar app (`tray/`), window (`dashboard/`), answer window (`overlay/`), QA harness (`qa/`), settings (`config/`), data (`data/`) |
| `brand/` | Logo, icons and the script that builds them |
| `docs/` | Documentation (below) |
| `docs/ux/` | Screenshots and UX before/after images |
| `CHANGELOG.md` | Milestones |

## Documentation

| Doc | Read it for |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, call lifecycle, files, latency and cost, tests |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Decision log: what we chose and why |
| [docs/PRIVACY-AND-SECURITY.md](docs/PRIVACY-AND-SECURITY.md) | What data goes where, what is stored, how keys are handled |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Setup, scripts, tests, QA harness, building the app |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Open items, known limits, ideas |
| [stage0/README.md](stage0/README.md) | The detailed app and operator guide |

## License

MIT, see [LICENSE](LICENSE).
