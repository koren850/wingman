# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 0.0.1 - unreleased

First public release. Nothing is published yet; the date is set on the day it is.

### Fixed

- **Reliability round 2.** An audio source that hangs after a restart is rebuilt until frames flow, and a wake no longer flashes the red bar. Stop writes the call record first, so a slow close cannot lose it, and a stray error never ends a stopping call early. Stop pressed during a slow start is read at once. STT events are wired before the sockets open. The call goes back to the primary STT provider after a stable minute, a wake leaves healthy sockets alone, and a failing first open no longer opens two fallback sockets. The tray controller caps its stdout buffer, parses a last line without a newline, and recovers from a failed spawn.

### Added

- Test `r2-wordlist-guard`: no new word list (array, Set or word regex) outside `src/lang/`. Existing lists are counted per file and cannot grow.

- **v2 gate tests.** Six e2e files for the whole v2 engine: latency budgets, cost per role against the plan table, golden dev meetings with null and noise controls, a failure matrix (model down, STT down, both, 429 storm, corrupt `session.json`, kill during a save, clock jump, huge brief), a 3-hour soak with faults, and prompt snapshots for every role. See `docs/DEVELOPMENT.md`.
- **Ask the call, Catch me up, pre-meeting digest.** Ctrl+Opt+U opens a five line sheet (where we are, decided, open, you promised, they asked of you). Typing `ask <text>` or `wingman ask "..."` answers from the call memory first, then the transcript, then general knowledge; a failed ask always shows a card. `wingman recap` and `wingman followup` print the recap and the follow-up draft. `wingman digest` turns pasted notes and files into people, agenda, facts (each with its source line) and likely questions; without a model the raw text is kept as background. Who a question is for is now decided by the model; the phrase lists are only the offline fallback.
- **Moment engine in the live call (setting `moments.engine`, default `legacy`).** With `v2`, every kept line can get help: a strong question asks the model at once, other lines wait in an observer window (6 calls a minute at most). Cards for answers, replies, checks, terms, prompts and notes. Local bank and calc cards show first. A number you say is checked against your notes and the call memory. A soft hourly cap on AI spend (`budget.maxLlmUsdPerHour`) and a calm "AI paused" bar when the AI cannot be used.
- **Moment engine core.** Pure modules in `app/src/moments/`: a tag-first reply parser, a structural intake filter, a frozen question hint, a card scheduler, an observer pacing window and the moment prompt. The bank gets a local 3-gram scorer, so a paraphrase of a card finds it without a model call, and it no longer keeps a global turn language.
- **Memory loop and card pipeline v2 (runs with `moments.engine` = `v2`).** A small model keeps the call memory up to date every 20 s (or at once on a number, a new name, a long-open question, a topic shift or a pause), saves `session.json` after each patch and sends the memory view to the windows. Open questions and promises that nobody picked up give one short PROMPT card. Cards get v2 rows (`kind`, `value`, `why`, `ref`, `closes`, `ctx`), a Check card is never dropped by the per-minute cap, and ratings in `tags.jsonl` tune the thresholds. A model answer with a figure nobody said is replaced by the stall line, in any language. The wrap-up reads the memory (open loops, guarded follow-up draft) and falls back to the transcript summary. Cost: about $0.04 an hour for the updater.
- **Hebrew main window.** The window follows the system language (Settings, Window language can change it). Right-to-left layout, one string catalog per language, a test that both have the same keys.
- **Meeting context.** One optional box on Home: paste text or drop .txt, .md, .pdf (needs pdftotext) or .ics. Long files are cut into parts of about 500 tokens. A meeting never expires and can start the next call too; a crash after Start loses nothing.
- **What Wingman knows** and **So far** panels (sample data in this version): lines can be edited, removed or added, and the exact AI text can be shown.
- **Errors with a next step.** One table of messages; each has a button (Open Keys, Allow microphone, Paste the text instead, ...).
- **Live call loop.** Two audio channels (microphone for you, system audio for the other side through a Core Audio tap) go to two Deepgram Nova-3 streams, so the speaker is always known. A reconnect buffer replays the last two seconds after a dropped connection.
- **Answer cards in about a second.** A question detector that handles English, Hebrew and mixed speech feeds a local answer bank ("Prepared" cards, no AI call) and a Claude Haiku step that skips, stalls, picks a bank card or writes a short answer. AI cards are labelled "not verified".
- **Guards in code.** Deterministic filters for prices, dates and promises turn a risky AI line into a "Buy time" line. House-style never-say rules. Practice mode adds a salary guard and an unclaimed-term guard.
- **Answers for you.** Ask out loud (Ctrl+Opt+A) and get a "For you" card. Arithmetic is computed locally.
- **Call frame and tips.** The call type is detected, a checklist of what the call should cover is kept, and at most one short tip is shown every two minutes.
- **Flow mode.** Several speakers on the other side are told apart; their own discussion is shown muted and answer cards wait; an alert shows when someone turns to you.
- **Practice and prep mode** for rehearsal with your own notes, and an offline **practice call** with a pretend client.
- **Post-call summary** with decisions, next steps, open questions and a follow-up email draft; prices, dates and promises become placeholders.
- **Fact cards** from an optional local snapshot of clients and domains, and copyable capture chips for phone numbers, emails and domains.
- **Degrade ladder and cost caps.** Reduced AI (a slow AI keeps answering; a late answer is dropped), provider switch, bank only, transcript only, with a per-call spend cap (and an amber warning at `budget.warnUsdPerCall`; the cost estimate includes Deepgram add-ons), a circuit breaker and experimental fallback speech providers (Soniox, Gladia).
- **Reliability.** Audio sources restart by themselves; the call survives sleep, stray errors and a full disk; a dead speech channel reconnects or steps down instead of ending the call; if the call folder fails, the call is kept in memory and saved as a rescue copy.
- **Electron menu-bar app** with Home, Calls and Settings (29 options in plain words; the Calls list loads in chunks, so a large history never freezes the menu bar), a guided first-run setup in three required steps (Try it, Connect, Allow) plus an optional "Make it yours", a readiness check, quick calls and prepared meetings, and a separate answer window for the second screen (right-to-left aware).
- **Focus layout for the answer window.** The default shows the other side's line, one big answer and three main keys; a More panel holds the checklist, client card, notes and captured details. The old all-at-once layout stays as `overlay.layout: full`.
- **Self-contained app.** `pnpm dist` builds an unsigned `Wingman.app` and `.dmg` that carries its own engine (no Node, no checkout), with a release workflow for tagged builds. No download is published yet.
- **`wingman` command line** that drives the running app over an owner-only local socket.
- **Installer** (`install.sh`) with check, dry run, update and uninstall modes; it never uses sudo.
- **Swappable pack and profile.** Answer bank, house style and keyterms live in a pack; your name and business live in a profile. Starter packs for sales, support, job-interview practice and an empty pack come in Hebrew and English, and the setup copies one into your folder. `wingman pack from-notes <file>` drafts bank cards from your own notes, FAQ or PDF; every draft goes through the guards, and a card that states a price, date or promise becomes a stall line.
- **Test and QA tooling.** 750+ tests (730+ unit and 21 end-to-end call tests) in 80+ files, `pnpm eval` with a quality baseline (detector, answer bank, guards) that CI enforces, a synthetic QA harness with 32 invented scenarios, snapshot tools for the windows, and a CI workflow.
- **Diagnostics and internals.** `wingman diagnose` writes one file for a bug report (no transcript or card text); every card records its model and prompt id. Providers are listed in one catalog, audio capture sits behind an `AudioBackend` interface (macOS only so far), and "never use X" source checks are ESLint rules.
- **English and Hebrew.** An English offline demo (`pnpm demo`; `pnpm demo --he` for Hebrew). A call in another language shows a one-time "not supported yet" notice. The English demo and the in-app Practice call also show the call frame, a tip, notes and the summary in English. Status texts, fact cards and the short summary follow the interface language, with a status dot in the answer window and on Home. Summary, notes, tips, frame and self-check follow the call language. Language rules for the detector and the guards live in one module per language (`src/lang/`), so a new language is one file.
- **Documentation.** Architecture, 43 architecture decision records, privacy and security guide, development guide, troubleshooting, pack format and roadmap.

- **A failing AI never leaves an empty screen.** An ask by you (Ctrl+Opt+A) that hits a network, 5xx, 429 or 529 error now shows a short card ("could not get an answer") and the "AI not answering" bar after the first failure. A question from the other side with the same errors shows the "Buy time" line at once (when `reflex.stall` is on) instead of waiting for the stall timer; the bar comes after two failures. Several questions in one final each get their own answer.
- **Speech-to-text opens and reconnects have a time limit.** Every open gives up after 8 seconds (Deepgram, Gladia, Soniox), is retried, and after 30 seconds the call starts anyway with the red bar. A stream that is opened while Stop is pressed is closed. A failed open closes its socket. Audio that was waiting to be replayed is kept if the socket drops again during the replay.
- **The microphone is saved with its name.** The setup window stores the device name next to its number. At every start Wingman checks the name against the plugged-in microphones: if the number moved (a headset connected) the right one is used; if the name is gone, the default microphone is used and an amber bar says so.
- **Texts follow the interface language.** The consent card, the "ask failed" card, the 90 second tip, the reminders, the client proposal, the menu-bar menu and the quit confirmation are in English or Hebrew by `ui.language`. A test keeps Hebrew letters out of the engine source.
- **Stop and quit.** A crash saves the call with the same time budget as a normal stop (sources stop in parallel). Cmd+Q during a call asks first, like the menu item. A call that hangs after it was saved is still ended by the 12 s and 20 s escalation. The practice call writes its sound file in its own private folder. A dead answer-window page stops the 100 ms poll until it is reloaded. A failed start of the engine is reported instead of an uncaught error.

- **Test kit for model behaviour.** A policy fake model, a cassette layer (`WINGMAN_LLM_MODE=replay`), prompt snapshots, a virtual clock and golden-meeting helpers, so model-driven features can be tested with no key and no network. No change for users.

### Fixed

- **The moment and observer calls now read the call memory.** The memory loop learned facts, promises and open questions, but the prompts of the direct and observer calls were built from a copy that only held the pre-meeting notes. They now carry the memory block (`engine/coach.ts` and `engine/moments.ts`).

### Security and privacy

- No telemetry and no cloud account. Audio is never stored.
- API keys are kept in the macOS Keychain. One lookup order everywhere (Keychain, then environment variable, then the legacy `keys.env`), so the source Settings shows is the key a call uses.
- The control socket and call files are owner-only. The app asks for confirmation before a call is started or deleted from the command line.
- Strict Content-Security-Policy in the Electron windows; Electron fuses are set at build time.
- Optional Deepgram model-improvement opt-out (`stt.deepgram.mipOptOut`).

### Known limits

- The full app supports macOS 14.2 or newer only. See [docs/ROADMAP.md](docs/ROADMAP.md).
- English and Hebrew (including mixed speech) are supported; other languages are not supported yet and show a notice.
- Builds are ad-hoc signed, not notarised.
- The .dmg is unsigned and the release workflow has not run yet.
