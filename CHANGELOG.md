# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.0.1 - unreleased

Initial release. The date is added when the release is published.

Highlights: a live agent for meetings that builds context as the call goes and shows short cards from what happens, in English and Hebrew, on macOS and Windows, with a practice call that needs no keys. You download the app and paste two keys; no Node, Homebrew or ffmpeg is needed. A first run with the real AI did not pass the quality lines, so card quality is not proven; see [docs/ROADMAP.md](docs/ROADMAP.md#evidence-so-far).

### Added

- **No ffmpeg for users.** The app records the microphone itself in a hidden window and hands 16 kHz audio to the engine over a private local socket. On Windows the other side's audio is captured with Electron's loopback audio. macOS system audio is still the bundled AudioTee. ffmpeg stays only as a developer fallback (`WINGMAN_MIC_ENGINE=ffmpeg`, terminal runs, file replay). A blocked microphone or a microphone used by another program now shows its own bar, in English and Hebrew.
- **Live call loop.** Two audio channels (microphone for you, system audio for the other side through a Core Audio tap on macOS or loopback on Windows) go to two Deepgram Nova-3 streams, so the speaker is always known. A reconnect buffer replays the last two seconds after a dropped connection, and speaker numbers restart with each connection so one person never gets another person's label.
- **Live reading.** The default engine. The AI reads the call as it grows and decides when a card helps: answers, replies, checks, terms, prompts and notes. A strong question asks the model at once; other lines wait in an observer window. Classic (the older question gate) is kept as a fallback in the advanced settings.
- **Call memory.** A small model keeps a short memory of the call (topic, people, numbers, promises, open questions) and every model call reads it. A new call can start with "Last time" facts about people you met before. The memory is checked on a long call, after a name the speech-to-text garbles, and at Stop.
- **Cards that stay short.** Answer, Check, Prompt and Fact cards. A line is shown whole. Low-confidence cards become small chips, and "Fewer like this" teaches Wingman what you do not want. Open, Promises, Cover and Earlier cards sit behind one Context button, and Catch me up is the main button.
- **Guards in code.** Prices, dates and promises in AI text become a "Buy time" line. Numbers you say are checked against your notes and the call memory, and a mismatch shows a Check card. Practice mode adds a salary guard.
- **A floor without AI.** When the AI is paused, a language-neutral floor (speech-to-text question marks, digits and money, your name, short sentence shape) and your prepared answers still decide where a card helps. A calm "AI paused" bar says so. An optional early start (off) begins the direct call on a stable partial.
- **Your own answers.** A pack holds your answer bank, house style and keyterms, and a profile holds your name and business. Starter packs for sales, support, job-interview practice and an empty pack come in Hebrew and English. `wingman pack from-notes` drafts cards from your own notes; every draft goes through the guards.
- **Context and modes.** Give context as pasted text, dropped files (.txt, .md, .docx, .eml, .pdf, .ics), a web address (https), a calendar link, or your next calendar event. Wingman shows **What Wingman knows** once before the call: untick or edit lines. Wingman guesses the kind of call; you can lock it or write your own mode. Web lookup of one term is opt-in, with a source and a cost cap.
- **Ask, recap and summary.** Ctrl+Opt+A asks Wingman a question and shows a "For you" card; arithmetic is computed locally. Catch me up gives a five-line sheet. After the call, a summary with decisions, next steps and a follow-up email draft; prices, dates and promises become placeholders.
- **First run is two keys.** The first window asks only for the Deepgram and Anthropic keys. Each is checked with one cheap request and saved only when the service accepts it. A wrong key, no credit, no network and a blocked microphone each get a plain message and a fix button, in English and Hebrew. Then it offers a practice call and a real call. Keys are kept in the macOS Keychain, or encrypted with Windows data protection on Windows (ADR 70).
- **Menu-bar app.** Home, Calls and Settings; a guided first-run setup (Try it, Connect, Allow); a readiness check; quick calls, prepared meetings and an offline practice call with a pretend client. The window follows the system language (English or Hebrew), including right-to-left layout.
- **Answer window.** A second-screen window with one large card, small chips, a status dot and a Focus layout. Long lines clamp with More and are never cut with an ellipsis. Cards fade after a few minutes. Hebrew and mixed text is right-to-left aware.
- **Group calls and practice.** Several speakers on the other side are told apart; their own talk is shown muted and cards wait; an alert shows when someone turns to you. Interview mode is a practice coach that builds on your own notes.
- **Command line and installer.** The `wingman` command drives the running app over an owner-only local socket. `install.sh` has check, dry run, update and uninstall modes and never uses sudo. `pnpm dist` builds an unsigned, self-contained `Wingman.app` and `.dmg` on a Mac, and an unsigned per-user `Wingman-Setup-<version>-x64.exe` on Windows (keys kept with Windows data protection, `Wingman --wingman-smoke` install check). The release workflow builds and attaches both on a `v*` tag; no download is published yet.
- **Evaluation tools.** `pnpm eval` with a quality baseline and ship thresholds (`pnpm eval:ship`, which fails today on purpose until a recorded run exists); 32 invented dev meetings and three held-out splits; a memory eval of 24 invented calls; a 120-case judgement set; cassette recording and replay (`pnpm morning`, `pnpm replay`); and a bad-model control that must fail the gate. See [docs/RECORDING-EVALS.md](docs/RECORDING-EVALS.md).
- **Tests and CI.** About 2,000 unit and end-to-end tests on a virtual clock with fake models and streams, snapshot checks for the windows in English and Hebrew, and a CI workflow. Windows CI runs the type check, the unit tests and a packaging check (build, install, start, uninstall); Linux and macOS also run end-to-end tests and `pnpm eval`.
- **Documentation.** Step-by-step install for macOS and Windows (including the unsigned-app steps), the two-key setup with costs, languages and how to add one, the call memory design, troubleshooting, architecture, 73 architecture decision records, privacy and security guide, user guide, getting started, development guide, troubleshooting, pack format, examples and the roadmap.

### Changed in the last round before release

- **Example answers are opt-in.** A new user has no prepared cards until they copy a starter pack or write one. The practice call and the demo still use the invented example pack.
- **Hebrew numbers and weekdays.** Speech to text sometimes writes "60 1000" or "יום 4º"; these are now read as 60000 and as the weekday name before Wingman uses the text.
- **Fewer false "still unanswered" tips.** No tip while the memory is being updated, none for a question the user answered, and no repeat of a promise that was already offered.
- **Replies with a missing field are kept.** A card is no longer dropped because its value or aim line is missing. The memory patch reader accepts plain-text facts.
- **Card language follows the call.** A card in the wrong language for the question is dropped, and a promise tip carries a label in its own language.
- **Recording tools.** `--pace` above 1 is refused for a real recording unless `--fast-ok` is given, and the evaluation refuses a paced recording for the ship lines.

### Fixed

- **Windows.** The call memory file could not be saved on Windows (the disk flush needed a writable handle). Short tools now end after a time limit instead of staying open, and the install check says how a tool ended.
- **Reliability.** Audio sources restart by themselves and the call survives sleep, stray errors and a full disk. A speech socket that opens but hears nothing for 20 s is reopened. Opens and reconnects have a time limit, and the red bar shows if the call starts without speech. Stop writes the call record first, and shutdown has one deadline. A failing AI never leaves an empty screen: an ask that fails shows a short card and the "AI not answering" bar.
- **Very long calls.** On a call of about 40,000 words the memory loop keeps a call-wide cursor, so it does not stop reading new lines after the transcript drops its middle.

### Security and privacy

- No telemetry and no cloud account. Audio is never stored. By default nothing leaves your Mac except audio to Deepgram and call text to Anthropic. Three opt-in features contact the hosts you give them: a web address as context, a calendar .ics link, and web lookup (off by default).
- API keys are kept in the Keychain on macOS and in files encrypted for your Windows user (DPAPI) on Windows, with one lookup order everywhere (key store, then environment variable, then a legacy `keys.env`).
- The control socket and call files are owner-only. The app asks for confirmation before a call is started or deleted from the command line.
- Strict Content-Security-Policy in the Electron windows; Electron fuses are set at build time.
- Optional Deepgram model-improvement opt-out (`stt.deepgram.mipOptOut`).

### Known limits

- The app supports macOS 14.2 or newer (Apple Silicon) and Windows 10 or 11 (64-bit). Windows audio capture, the key store and the tool process were tested with fakes only, not yet on a real Windows machine. There is no Linux app. See [docs/ROADMAP.md](docs/ROADMAP.md).
- English and Hebrew (including mixed speech) are supported; other languages are not supported yet and show a notice.
- Builds are unsigned: macOS needs the Open Anyway step and Windows shows SmartScreen. The release workflow has not run yet.
- A first recorded run with the real AI failed most quality lines (few useful cards, some wrong or in the wrong language). Hebrew speech to text is weaker than English. See [docs/ROADMAP.md](docs/ROADMAP.md#evidence-so-far).
