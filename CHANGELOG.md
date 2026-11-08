# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 0.0.1 - unreleased

First public release. Nothing is published yet; the date is set on the day it is.

### Added

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
- **Documentation.** Architecture, 42 architecture decision records, privacy and security guide, development guide, troubleshooting, pack format and roadmap.

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
