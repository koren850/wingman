# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 0.0.1 - 2026-11-07

First public release.

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
- **Electron menu-bar app** with Home, Calls and Settings (the Calls list loads in chunks, so a large history never freezes the menu bar), a guided first-run setup, a readiness check, quick calls and prepared meetings, and a separate answer window for the second screen (right-to-left aware).
- **`wingman` command line** that drives the running app over an owner-only local socket.
- **Installer** (`install.sh`) with check, dry run, update and uninstall modes; it never uses sudo.
- **Swappable pack and profile.** Answer bank, house style and keyterms live in a pack; your name and business live in a profile. An invented example pack is included.
- **Test and QA tooling.** 680+ tests (660+ unit and 21 end-to-end call tests) in 70+ files, `pnpm eval` with a quality baseline (detector, answer bank, guards) that CI enforces, a synthetic QA harness with 32 invented scenarios, snapshot tools for the windows, and a CI workflow.
- **English and Hebrew.** An English offline demo (`pnpm demo`; `pnpm demo --he` for Hebrew). A call in another language shows a one-time "not supported yet" notice. The English demo and the in-app Practice call also show the call frame, a tip, notes and the summary in English. Status texts, fact cards and the short summary follow the interface language, with a status dot in the answer window and on Home.
- **Documentation.** Architecture, 37 architecture decision records, privacy and security guide, development guide, troubleshooting, pack format and roadmap.

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
