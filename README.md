<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/png/lockup-dark.png">
    <img src="brand/png/lockup.png" alt="Wingman" width="420">
  </picture>
</h1>

<p align="center"><b>A live agent for your meetings. It listens, builds context as the meeting goes, and shows short help cards from what happens.</b></p>

<p align="center">
  <a href="https://github.com/koren850/wingman/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/koren850/wingman/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Platform: macOS 14.2+" src="https://img.shields.io/badge/platform-macOS%2014.2%2B-lightgrey.svg">
</p>

<p align="center">
  <img src="docs/ux/answer-window-live.png" alt="The Wingman answer window during a call (invented example): a Check card warns that the user made a promise, with chips for waiting cards, a Context button and a Catch me up button" width="560">
</p>

<p align="center">
  <img src="docs/ux/answer-window-he.png" alt="The answer window on a Hebrew call (invented example), right to left" width="340">
  <img src="docs/ux/home-live.png" alt="The Wingman window, Home page, during a live call (invented example)" width="340">
</p>

Wingman is a macOS app for English and Hebrew calls, built with Electron and TypeScript. It is a live agent for client, support and team meetings. Before a meeting you can give it context: an invite, an email, notes. That is optional. During the meeting it builds context by itself, like a Claude session that listens: who is on the call, what was decided, which numbers were said, what you promised. From what happens, it shows short cards on a second screen. A card can answer a question, warn that a number does not match your notes, or remind you of a topic you wanted to cover. After the call it writes a summary and a follow-up email draft.

A **moment** is a point in the call where a short, private nudge would help: a question, an objection, a number, a promise, an open point. Wingman looks at the call as a whole and decides, moment by moment, whether a card helps. Most lines get no card. It does not wait for a question mark. Old lists of question words are kept only as a hint and for the case when the AI is down.

## What you get

- **Live reading is the default.** The AI reads the call as it grows and decides when to help. **Classic** (the older question gate) is a fallback in the advanced settings. A language-neutral floor keeps working, without AI, when the AI is down.
- **Cards that stay short.** Answer, Check, Prompt and Fact cards. A line is shown whole. Low-confidence cards become small chips, and "Fewer like this" teaches Wingman what you do not want.
- **Your own answers first.** A local pack of prepared answers shows with no AI call. Prices, dates and promises are checked in code, never invented.
- **Call kinds and modes.** Wingman guesses the kind of call (client, support, team, practice and others) and adjusts how much it says. You can lock the kind or write your own mode.
- **A practice call first.** A pretend client plays through the real window. It is free and needs no keys.
- **English and Hebrew**, also mixed in one call, with right-to-left text.

## Quick start

Needs macOS 14.2 or newer, Node 24, a second screen for the answer window, and (for live calls) a Deepgram key and an Anthropic key.

```bash
git clone https://github.com/koren850/wingman.git
cd wingman && ./install.sh        # checks the Mac, installs, builds Wingman.app
```

1. **Install the app.** Open Wingman. The setup has three steps: Try it, Connect (paste the two keys), Allow (microphone and system audio).
2. **Try a practice call.** Press Practice call. A pretend client talks and the cards appear. No keys, nothing leaves your Mac.

No Mac at hand? `cd app && WINGMAN_SKIP_APP=1 pnpm install && pnpm demo` plays a scripted call in the terminal (about 1 to 2 minutes; run pnpm from `app/` so corepack uses the pinned version). Full steps: [Getting started](docs/GETTING-STARTED.md). Developers: [DEVELOPMENT.md](docs/DEVELOPMENT.md).

## How it works

```mermaid
flowchart LR
  mic["You (microphone)"] --> stt["Speech to text<br/>one stream per side"]
  sys["Them (system audio)"] --> stt
  ctx["Optional context<br/>(invite, notes)"] --> mem
  stt --> mem["Call memory<br/>(grows during the call)"]
  stt --> pick["Live reading<br/>is a card useful now?"]
  mem --> pick
  bank["Your prepared answers"] --> pick
  pick --> guards["Guards in code<br/>price, date, promise"]
  guards --> win["Cards on your second screen"]
```

Two audio streams keep who said what. A shared call memory (topic, numbers, promises, open questions) feeds every AI call. A health ladder keeps the call useful when a service fails: without AI, prepared answers and the language-neutral floor still work. More: [Architecture](docs/ARCHITECTURE.md).

## How good is it?

Quality numbers are scripted so far: the AI replies in the tests are fixtures, so they check the plumbing, the timing and the grader, not the AI's judgement. A recorded run with the real AI is the next step. The numbers and what they mean are on the [Roadmap](docs/ROADMAP.md#evidence-so-far).

AI cost is modelled at about $0.03 an hour; plan for 5 to 20 cents an hour. Speech costs about $1.40 an hour, so a call is about $1.50 an hour in total (an estimate, not a measurement).

## Privacy and responsible use

Audio goes to Deepgram to be transcribed. Call text goes to Anthropic for cards and the summary. By default nothing else is sent: no telemetry, no account. Three opt-in features contact the hosts you give them: a web address as context, a calendar .ics link, and web lookup (off by default). Audio is never saved. Tell the people on the call that you use an assistant, and follow the recording laws that apply to you. Practice mode is for rehearsal, not for real exams or interviews. Details: [Privacy and security](docs/PRIVACY-AND-SECURITY.md).

## Guides

- Use it: [Getting started](docs/GETTING-STARTED.md), [User guide](docs/USER-GUIDE.md), [Call-day checklist](app/CALL-DAY.md), [Troubleshooting](docs/TROUBLESHOOTING.md)
- Make it yours: [Pack format](docs/PACK-FORMAT.md), [Examples](docs/EXAMPLES.md), [Settings and hotkeys](app/README.md)
- How it works: [Architecture](docs/ARCHITECTURE.md), [Decisions](docs/DECISIONS.md), [Privacy and security](docs/PRIVACY-AND-SECURITY.md)
- Project: [Roadmap and known limits](docs/ROADMAP.md), [Changelog](CHANGELOG.md), [Development](docs/DEVELOPMENT.md), [Recording evals](docs/RECORDING-EVALS.md), [Contributing](CONTRIBUTING.md), [Security](SECURITY.md)

## Platforms

macOS 14.2 or newer is supported. The engine and the offline demo also run on Linux (CI); Windows passes the unit tests but has no audio capture yet. Help wanted.

## Languages

English and Hebrew, and calls that mix them. Other languages are not supported yet: Wingman shows a one-time notice and gives no cards for those lines.

## How it was built

Wingman is a solo project by [koren850](https://github.com/koren850), built with [Claude Code](https://claude.com/claude-code) as the coding agent. The decisions, trade-offs and quality bars are written down in [docs/DECISIONS.md](docs/DECISIONS.md). MIT license, see [LICENSE](LICENSE).
