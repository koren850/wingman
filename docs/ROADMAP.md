# Roadmap, known limits and ideas

For anyone who wants to know how finished Wingman is, what has and has not been checked, and where it could go. Wingman is an early release (v0.0.1). The public release is delayed until it scores high on recorded evidence. This page lists what is done, the evidence with each number labelled **scripted** (fixture replies of the model) or **recorded** (the real AI), what is not verified yet, the known limits and ideas. It is a status page, not a promise.

## What is done

- Live call loop: two-channel speech to text, **live reading** (the default: the AI reads the call and decides when a card helps), a shared call memory that grows during the call, optional pre-meeting context with a review step, Prepared bank, AI answers with guards, answer window. **Classic** (the older question gate) is the rollback and a language-neutral floor runs when the AI is down.
- Precision rules (confidence chips, required labels, a 12-word line, "fewer like this", per-user learning), speaker numbers that survive a reconnect, a ring that keeps the audio before the first connect, an early start on stable partials (off), and ship thresholds with a held-out split.
- Menu-bar app with Home, Calls and Settings; prepared meetings; practice call; Readiness check; keys in the Keychain.
- An installer (`install.sh`, with update and uninstall), a guided first-run setup, and user data in `~/Library/Application Support/Wingman` with a one-time copy migration.
- Practice and mock-interview mode (kind `interview`, a practice coach) and group call mode (several people on the other side).
- Reliability: audio sources restart by themselves, the call survives sleep, a stray error and a full disk, and a dead speech channel steps down to transcript-only instead of ending the call.
- Security: confirmation in the app before a CLI start or delete, safe file attach, strict Content-Security-Policy, Electron fuses set at build time, short error text, profile validation.
- Answers for you, local math, call frame and checklist, tips, fact cards (with your own snapshot), capture chips, summary and follow-up draft.
- Health ladder, reconnect buffer, cost caps, idle stop, sleep recovery, disk-space warning.
- The `wingman` CLI over an owner-only socket.
- A self-contained app and .dmg build (unsigned), `wingman diagnose`, bilingual starter packs and `wingman pack from-notes`, a Focus layout for the answer window, language modules for the detector and guards.
- A test suite of about 1,800 tests (unit, end-to-end on a virtual clock, snapshot gates for the windows), a CI workflow (type check, tests and `pnpm eval` on macOS and Linux, Windows experimental) and a synthetic QA harness with 32 invented scenarios.
- The round 3 end-to-end gates: speaker rebase across a faked reconnect, no audio lost before the first open, early-start latency, the AI-paused floor, and a 3-hour soak with a reconnect storm, a provider switch, a slow model, a 529 storm, a stalled dialog and a quit with a wedged engine.
- An older deep test round on the **Classic** engine (real Deepgram and Haiku, a 60-minute soak, failure injection, a 166-utterance answer-quality judge) on synthetic voices. **Recorded, Classic engine, synthetic voices, older build:** question recall 98 percent, right card about 86 percent on replay, Prepared first card p50 0.57 s and p95 1.9 s, math 0.43 s, AI answer for you 1.65 s, AI answer for them 1.4 s, 0 guard leaks, AI cost about 20 cents an hour in the longest test. Synthetic voices are cleaner than real speech, so treat these as optimistic. **They say nothing about live reading.**

## Evidence now (round 3, 9 November)

Nothing below is recorded. "In-sample" means the set was used while tuning.

| What | Result | Basis |
|---|---|---|
| Golden dev, 32 invented meetings, 292 moments: card recall, precision | 84.6 percent, 79.7 percent | scripted, in-sample |
| Same: duplicates, cards an hour, cards a minute in silent stretches | 1.0 percent, 82, 0.02 | scripted, in-sample |
| Same: time to a card p50 and p95 (direct path) | 900 ms and 1500 ms (observer path 1500 and 4000 ms) | scripted, virtual clock |
| Ship thresholds on dev (`pnpm eval --ship`) | 8 pass, 6 FAIL, 2 not scored (recorded-only) | scripted, in-sample |
| FAIL lines on dev | precision all 79.7 percent, answer 70.8, prompt 77.4, fact 71.1 (need 80); cards an hour 82 (need 40); wrong-language 0.6 percent (need 0) | scripted |
| `test-c`, 8 meetings, 37 moments, read with `--final --ship` | recall 91.9 percent, precision 73.9 percent, 8 pass and 6 FAIL | scripted, **not truly blind** |
| `test` (7 meetings) and `test-b` (14 meetings), printed next to it | precision 73.3 and 98.3 percent, recall 86.7 and 89.2 percent | scripted, read before |
| AI paused, the floor alone, 34 meetings, 84 answer moments | recall 63.1 percent; with the old hint 88.1 percent | scripted, in-sample |
| AI paused, engine replay of the 32 dev meetings | 60 of 68 answer moments got a card, no model call | scripted, in-sample |
| Early start (assumed 700 ms speech-to-text lag, 800 ms model) | card 500 ms earlier (median 1500 to 1000 ms after the end of speech); 6.5 percent extra direct calls | scripted, assumed |
| Modelled AI cost, all roles | $0.032 an hour (limit $0.25) | scripted, modelled usage |
| Memory eval (12 invented calls, scripted updater) | F1 88 percent | scripted, scorer check only |
| Judgement set, memory floors, cost check against real usage, direct first card p95 | not run | needs `pnpm morning` |

**Why the 6 FAIL lines are not fixed by tuning.** The constants of the scheduler were tuned on `dev` already (precision went from 70.5 to 79.9 percent, duplicates from 7.6 to 1.0). More tuning on a scripted set only fits the script. The honest next number is the recorded one.

**`test-c` is not truly blind.** Its builder had no independent author and had read the schema, README and other splits; it was read twice. Replace it with a split written by an independent author (a person, or an agent that sees only the schema and the README), lock it, and read it once. Until then the held-out columns are comparison, not a release estimate.

## Verification status: not yet checked on real audio

Everything above ran on scripted replies, synthetic voices and hidden-window snapshots. Not yet recorded or checked on real calls:

- **A recorded run of live reading:** `pnpm morning --cap 5` ([Morning kit](MORNING-KIT.md)). It gives recorded recall and precision, the model judge, the memory F1, the judgement set, the cost check against real usage and the cache share.
- A real call rated with `pnpm tag`: useful cards an hour, and how many cards you would have rather not seen.
- Latency with real partials: whether early start is stable enough to turn on, and the real first-card time of the direct path.
- Speaker numbers after a real reconnect (so far a fake stream), and the ring after a real slow first connect.
- The review step ("What Wingman knows") on a real call: its edits are applied by memory id, and a renamed id would drop an edit silently.
- The pre-start review is not shown for a call started from the tray menu or the command line (they have no window).
- About 300 strings in the setup card, Settings and the Calls view are English only.

- The Readiness check with a real voice, online.
- Hotkeys Ctrl+Opt+1, 2, 3 (copy capture chips) and Ctrl+Opt+A (ask) on a real call.
- The Stop steps (saving, summary, done) and Skip summary on a real call; Quit during a call with the confirm.
- The "only you on the line" and monologue banners clear correctly with real audio.
- Real window plus a real call click path (checks so far used hidden snapshots with fake states).
- Screen-share behaviour of the answer window's content protection (Zoom, Meet, Teams).
- The usefulness gate ([ADR 3](DECISIONS.md#adr-3-numeric-gates-instead-of-opinions)): a few real calls rated, with a target of 2 or more useful cards an hour.
- The 40-sentence Hebrew gate on a real recording (so far only the synthetic voice).
- The installer and the guided setup on a clean Mac (real macOS permission prompts, a real Electron download).
- The one-time migration with a real, large set of old calls.
- The .dmg on a clean Mac, and the release workflow (it has not run yet).
- `pack from-notes` with a real model and a real notes file (tests use a scripted double).
- Audio restart after a real device change (AirPods off, a USB mic unplugged) and after a real lid close.

## Known limits

- **macOS only** for the full app (system audio capture needs macOS 14.2 or newer). The engine and file replay run on Linux (tested in CI) and pass unit tests on Windows in CI; system audio capture and an installer are not done, and the live app does not run there. Help wanted.
- **English and Hebrew** (and calls that mix them). Other languages are not supported yet: a call in one shows a one-time notice. More languages are possible later; see the roadmap below.
- Needs **Deepgram and Anthropic keys** and the internet. Costs about $1.50 an hour (an estimate): about $1.40 for speech with Deepgram add-ons plus roughly 5 to 20 cents for AI. Prices in the config are estimates.
- Not a recording or consent tool; the user is responsible for telling participants (see [PRIVACY-AND-SECURITY.md](PRIVACY-AND-SECURITY.md)).
- Call files are not encrypted at rest.
- No signed or notarised build (only ad hoc signed). The app built by `install.sh` runs the repo's code and needs Node 24 at launch; the .dmg from `pnpm dist` carries its own engine and needs neither. Permissions attach to the app or terminal that runs it.
- Answer quality gaps seen in testing: slow-site, talk-over and vendor-hosting scenarios pick the right card less often than the baseline (speech garble and model choices); a Hebrew-English mix misses "גרסה של PHP"; team-call tech questions may get no card.
- The old question detector and its word lists are only a hint and the offline fallback ([ADR 56](DECISIONS.md#adr-56-live-reading-is-the-default-word-lists-are-a-hint-and-the-offline-floor)). They are in Hebrew and English only; other languages have no floor.
- Two chips can still show for one line when the direct path and the observer both chip it (found by the fuzz test, not fixed).
- Live reading shows more cards than the ship line allows (82 an hour scripted; the line is 40).
- Soniox, Gladia and non-Anthropic AI models are tested only with mocks.
- Fact cards need a snapshot file you build yourself; the builder is not part of this repo.
- The Haiku prompt-cache minimum may need a longer prefix (the Readiness check reports it).
- Deepgram keyterm effect for Hebrew is unmeasured (the gate has a `--no-keyterms` A/B).
- Endpointing is 200 ms. Raise it (350 to 700) if real speech gets questions split at pauses.
- The "kind" of call is a guess after about 20 words. Locking it and writing your own modes are second-wave items ([ADR 64](DECISIONS.md#adr-64-modes-are-visible-lockable-and-writable-by-the-user-proposed-second-wave)); check the changelog for what shipped.
- AirPods and Bluetooth headsets lower transcript quality (a warning is shown). If a device disappears, the audio source restarts and falls back to the default mic.
- Shared design tokens are only partly adopted across the windows.

## Ideas (not built)

- A voice print so Wingman can tell you from the other side on speakers, and remember people's voices across calls.
- Phone mode: speakerphone on the Mac microphone with one mixed channel and diarization.
- Web lookup as a Tip type (a company or term, one line, with a source), with a cost cap and a guard against invented numbers. An opt-in CLI and Ask-tab version was a stretch item of round 3 ([ADR 65](DECISIONS.md#adr-65-web-lookup-is-opt-in-with-a-source-and-a-cap-proposed-replaces-adr-36-only-if-it-ships)); screen context needs a privacy design first.
- Live lookups in a client knowledge base through MCP, bound to the current client.
- Embedding-based bank, cue and memory matching. It needs a dependency or an API call. The local word-plus-3-gram score gains little on this bank (held-out bank accuracy 40 of 41, as before); the owner decides after a cost number.
- Encrypted call storage with a retention sweeper.
- A second STT or AI vendor proven on real Hebrew calls.
- A signed, notarised installer.
- Windows and Linux support for the live app (engine and replay first). The `AudioBackend` interface exists; win32 and linux backends are stubs. Help wanted.
- Optional ring-buffer polish after STT reconnects and connection keep-warm.

Next: [Architecture](ARCHITECTURE.md) · [Development](DEVELOPMENT.md) · [Decisions](DECISIONS.md)
