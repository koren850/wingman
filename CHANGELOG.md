# Changelog

Milestones from the git history. Wingman has no versioned releases yet.

## 2026-11-03

- Live meeting assistant: answers for you ("For you" cards, Ctrl+Opt+A, local math), the `wingman` CLI over an owner-only socket, API keys moved to the macOS Keychain.
- Deep-test fixes: a speech outage no longer ends a call, socket leak, orphan answer window, disk errors, price-versus-math, guard patterns, Deepgram `multi` stall, and more.
- UX audit (54 problems, 52 fixed): glossary (Prepared, AI, Buy time, Tip, For you, Math, Answer window, Plan, Readiness check, Quiet mode, Start listening), conversation hidden behind a button, Start anyway, call phases and stop steps, Skip summary, copy chips Ctrl+Opt+1/2/3.
- Consent step is off by default; the optional "Ask me before listening starts" setting is kept. Consent wording removed from the CLI, readiness check and docs.
- Documentation rewritten for publishing; planning documents moved to `docs/history/`.

## 2026-11-02

- Menu-bar app, reconnect buffer, split-question joining, sleep warning.
- Wingman brand: capybara logo, icons, wordmark.
- Dashboard (calls, card rating, speed, cost, settings), offline end-to-end call test.
- Stage 0b: speakers mode (mic gate and echo filter), capture box, rewind panel, typed AI notes, fact cards from a local snapshot, live notes, Plan with must-cover reminders.
- Default speech language `multi` (better English terms).
- Dashboard v3, synthetic QA harness, post-call summary, practice call, safety and bug-hunt fixes. Call frame, tips and background files (understands any kind of call).
- Plan update: speakers mode, context cards, instant start, new ideas; corrected Claude prices.

## 2026-11-01

- First commit: plan, structure and the Stage 0 dogfood tool (live listening, Deepgram Hebrew, question detector, 41-card bank, Haiku answers with guards, answer window, health bars, `pnpm call`, `pnpm tag`, `pnpm purge`, readiness check, STT gate), verified by a review round, plus settings and swappable providers.
