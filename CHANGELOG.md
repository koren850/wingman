# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 0.1.0 - 2026-11-06

First public release.

### Added

- **Live call loop.** Two audio channels (microphone for you, system audio for the other side through a Core Audio tap) go to two Deepgram Nova-3 streams, so the speaker is always known. A reconnect buffer replays the last two seconds after a dropped connection.
- **Answer cards in about a second.** A Hebrew-aware question detector feeds a local answer bank ("Prepared" cards, no AI call) and a Claude Haiku reflex that skips, stalls, picks a bank card or writes a short answer. AI cards are labelled "not verified".
- **Guards in code.** Deterministic filters for prices, dates and promises turn a risky AI line into a "Buy time" line. House-style never-say rules. Practice mode adds a salary guard and an unclaimed-term guard.
- **Answers for you.** Ask out loud (Ctrl+Opt+A) and get a "For you" card. Arithmetic is computed locally.
- **Call frame and tips.** The call type is detected, a checklist of what the call should cover is kept, and at most one short tip is shown every two minutes.
- **Flow mode.** Several speakers on the other side are told apart; their own discussion is shown muted and answer cards wait; an alert shows when someone turns to you.
- **Practice and prep mode** for rehearsal with your own notes, and an offline **practice call** with a pretend client.
- **Post-call summary** with decisions, next steps, open questions and a follow-up email draft; prices, dates and promises become placeholders.
- **Fact cards** from an optional local snapshot of clients and domains, and copyable capture chips for phone numbers, emails and domains.
- **Degrade ladder and cost caps.** Reduced AI, provider switch, bank only, transcript only, with a per-call spend cap, a circuit breaker and experimental fallback speech providers (Soniox, Gladia).
- **Reliability.** Audio sources restart by themselves; the call survives sleep, stray errors and a full disk; a dead speech channel steps down instead of ending the call.
- **Electron menu-bar app** with Home, Calls and Settings, a guided first-run setup, a readiness check, quick calls and prepared meetings, and a separate answer window for the second screen (right-to-left aware).
- **`wingman` command line** that drives the running app over an owner-only local socket.
- **Installer** (`install.sh`) with check, dry run, update and uninstall modes; it never uses sudo.
- **Swappable pack and profile.** Answer bank, house style and keyterms live in a pack; your name and business live in a profile. An invented example pack is included.
- **Test and QA tooling.** More than 500 unit tests, an offline end-to-end call test, a synthetic QA harness with 32 invented scenarios, snapshot tools for the windows, and a CI workflow.
- **Documentation.** Architecture, 37 architecture decision records, privacy and security guide, development guide, troubleshooting, pack format and roadmap.

### Security and privacy

- No telemetry and no cloud account. Audio is never stored.
- API keys are kept in the macOS Keychain.
- The control socket and call files are owner-only. The app asks for confirmation before a call is started or deleted from the command line.
- Strict Content-Security-Policy in the Electron windows; Electron fuses are set at build time.
- Optional Deepgram model-improvement opt-out (`stt.deepgram.mipOptOut`).

### Known limits

- The full app supports macOS 14.2 or newer only. See [docs/ROADMAP.md](docs/ROADMAP.md).
- Hebrew is the first-class language; English works; other languages are untested.
- Builds are ad-hoc signed, not notarised.
