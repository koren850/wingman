# Roadmap, known limits and ideas

State as of 4 November 2026. Wingman is at "Stage 0". This list is honest, not a promise.

## What is done

- Live call loop: two-channel speech to text, question detector, Prepared bank, AI reflex with guards, answer window.
- Menu-bar app with Home, Calls and Settings; prepared meetings; practice call; Readiness check; keys in the Keychain.
- An installer (`install.sh`, with update and uninstall), a guided first-run setup, and user data in `~/Library/Application Support/Wingman` with a one-time copy migration.
- Interview mode and flow mode (several people on the other side).
- Reliability: audio sources restart by themselves, the call survives sleep, a stray error and a full disk, and a dead speech channel steps down to transcript-only instead of ending the call.
- Security: confirmation in the app before a CLI start or delete, safe file attach, strict Content-Security-Policy, Electron fuses turned off, short error text, profile validation.
- Answers for you, local math, call frame and checklist, tips, fact cards (with your own snapshot), capture chips, summary and follow-up draft.
- Health ladder, reconnect buffer, cost caps, idle stop, sleep recovery, disk-space warning.
- The `wingman` CLI over an owner-only socket.
- 515 unit tests; a CI workflow (type check and tests on macOS); a synthetic QA harness with 32 invented scenarios; a UX audit with 52 of 54 findings fixed.
- A deep test round (real Deepgram and Haiku, a 60-minute soak, failure injection, a 166-utterance answer-quality judge). Reported numbers: question recall 98 percent, right card about 86 percent on replay, Prepared first card p50 0.57 s and p95 1.9 s, math 0.43 s, AI answer for you 1.65 s, AI answer for them 1.4 s, 0 guard leaks, AI cost about 20 cents an hour.

## Hand tests still to do (need a real person or real audio)

- The Readiness check with a real voice, online.
- Hotkeys Ctrl+Opt+1, 2, 3 (copy capture chips) and Ctrl+Opt+A (ask) on a real call.
- The Stop steps (saving, summary, done) and Skip summary on a real call; Quit during a call with the confirm.
- The "only you on the line" and monologue banners clear correctly with real audio.
- Real window plus a real call click path (checks so far used hidden snapshots with fake states).
- Screen-share behaviour of the answer window's content protection (Zoom, Meet, Teams).
- The usefulness gate: about 3 real calls rated with `pnpm tag` or the rating UI, then the result (2 or more useful cards an hour).
- The 40-sentence Hebrew gate on a real recording (so far only the synthetic voice).
- The installer and the guided setup on a clean Mac (real macOS permission prompts, a real Electron download).
- The one-time migration with a real, large set of old calls.
- Audio restart after a real device change (AirPods off, a USB mic unplugged) and after a real lid close.

## Known limits

- **macOS only** (system audio capture needs macOS 14.2 or newer). No Windows or Linux.
- **Hebrew first.** English works; other languages are untested.
- Needs **Deepgram and Anthropic keys** and the internet. Costs about $1.10 an hour for speech plus a few cents for AI. Prices in the config are estimates.
- Not a recording or consent tool; the user is responsible for telling participants (see [PRIVACY-AND-SECURITY.md](PRIVACY-AND-SECURITY.md)).
- Call files are not encrypted at rest.
- No signed or notarised build (only ad hoc signed); the app runs the repo's code and needs Node 24 at launch. Permissions attach to the app or terminal that runs it.
- Answer quality gaps seen in testing: slow-site, talk-over and vendor-hosting scenarios pick the right card less often than the baseline (speech garble and model choices); a Hebrew-English mix misses "גרסה של PHP"; team-call tech questions may get no card.
- The question detector is rule-based and needs upkeep.
- Soniox, Gladia and non-Anthropic AI models are tested only with mocks.
- Fact cards need a snapshot file you build yourself; the builder is not part of this repo.
- The Haiku prompt-cache minimum may need a longer prefix (the Readiness check reports it).
- Deepgram keyterm effect for Hebrew is unmeasured (the gate has a `--no-keyterms` A/B).
- Endpointing is 200 ms. Raise it (350 to 700) if real speech gets questions split at pauses.
- The "kind" of call is a guess after about 20 words.
- AirPods and Bluetooth headsets lower transcript quality (a warning is shown). If a device disappears, the audio source restarts and falls back to the default mic.
- A header brand mark in the window still needs final art; shared design tokens are only partly adopted.

## Ideas (not built)

- A voice print so Wingman can tell you from the other side on speakers, and remember people's voices across calls.
- Phone mode: speakerphone on the Mac microphone with one mixed channel and diarization.
- Web lookup as a Tip type (a company or term, one line, with a source), with a cost cap and a guard against invented numbers.
- Live lookups in a client knowledge base through MCP, bound to the current client.
- Embedding-based bank matching.
- Encrypted call storage with a retention sweeper.
- A second STT or AI vendor proven on real Hebrew calls.
- A signed, notarised installer, if a second real user wants Wingman.
- Windows support (also only if there is demand).
- Optional ring-buffer polish after STT reconnects and connection keep-warm.

## Stop rule

A stop rule keeps the project honest: if Wingman is not used on a real call by a chosen date, freeze it and write down where it stopped.
