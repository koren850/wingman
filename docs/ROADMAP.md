# Early release status

Wingman is an early release (v0.0.1). This page says what is built, what the numbers are and how each was measured, what has not been checked on a real call, the known limits and some ideas. It is a status page, not a promise.

Every number is labelled **scripted** (the model replies are fixtures) or **recorded** (the real AI answered). A scripted number checks the plumbing and the grader, not the AI's judgement.

## What is built

- Live call loop: two-channel speech to text, **live reading** (the default: the AI reads the call and decides when a card helps), a shared call memory that grows during the call, optional pre-meeting context with a review step, Prepared bank, AI answers with guards, answer window. **Classic** (the older question gate) is a fallback and a language-neutral floor runs when the AI is down.
- Precision rules (confidence chips, required labels, a 12-word line, "fewer like this", per-user learning), speaker numbers that survive a reconnect, a ring that keeps the audio before the first connect, an early start on stable partials (off), and ship thresholds with a held-out split.
- Menu-bar app with Home, Calls and Settings; prepared meetings; practice call; Readiness check; keys in the Keychain (Mac) or encrypted for your Windows account.
- Shipped, not yet proven on a real call: your own modes (lock the call kind or write a mode, [ADR 64](DECISIONS.md#adr-64-modes-are-visible-lockable-and-writable-by-the-user)) and web lookup (opt-in, with a source and a cost cap, [ADR 65](DECISIONS.md#adr-65-web-lookup-is-opt-in-with-a-source-and-a-cap-replaces-adr-36)). Context can also come from a web address, a calendar link or your next calendar event.
- A downloadable app for macOS (.dmg) and Windows (.exe), both unsigned. For developers, an installer (`install.sh`, with update and uninstall). A first window that asks for the two keys, a practice call, and user data in `~/Library/Application Support/Wingman` (`%APPDATA%\Wingman` on Windows).
- Practice and mock-interview mode (kind `interview`, a practice coach) and group call mode (several people on the other side).
- Reliability: audio sources restart by themselves, the call survives sleep, a stray error and a full disk, and a dead speech channel steps down to transcript-only instead of ending the call.
- Security: confirmation in the app before a CLI start or delete, safe file attach, strict Content-Security-Policy, Electron fuses set at build time, short error text, profile validation.
- Answers for you, local math, call frame and checklist, tips, fact cards (with your own snapshot), capture chips, summary and follow-up draft.
- Health ladder, reconnect buffer, cost caps, idle stop, sleep recovery, disk-space warning.
- The `wingman` CLI over an owner-only socket.
- A self-contained app and .dmg build (unsigned), `wingman diagnose`, bilingual starter packs and `wingman pack from-notes`, a Focus layout for the answer window, language modules for the detector and guards.
- A test suite of about 2,000 tests (unit, end-to-end on a virtual clock, snapshot checks for the windows). CI runs the type check, unit tests, end-to-end tests and `pnpm eval` on macOS and Linux. Windows CI runs the type check, the unit tests and a packaging check (build, install, start, uninstall). A synthetic QA harness has 32 invented scenarios.
- End-to-end checks on a virtual clock with fake streams: speaker rebase across a faked reconnect, no audio lost before the first open, early-start latency, the AI-paused floor, and a 3-hour soak with a reconnect storm, a provider switch, a slow model, a 529 storm, a stalled dialog and a quit with a wedged engine.
- An older deep test on the **Classic** engine (real Deepgram and Haiku, a 60-minute soak, failure injection, a 166-utterance answer-quality judge) on synthetic voices. **Recorded, Classic engine, synthetic voices, older build:** question recall 98 percent, right card about 86 percent on replay, Prepared first card p50 0.57 s and p95 1.9 s, math 0.43 s, AI answer for you 1.65 s, AI answer for them 1.4 s, 0 guard leaks, AI cost about 20 cents an hour in the longest test. Synthetic voices are cleaner than real speech, so treat these as optimistic. **They say nothing about live reading.**

## Evidence so far

### A recorded run (November 2026)

A first run with the real AI was made (two passes, about $1.20 in total, with invented scripts and text-to-speech voices). It did **not** pass.

**Re-recorded after the fixes (v0.0.1 prompts, 32 dev meetings, real model, pace 1):** 6 of 16 ship lines pass (was 4): duplicates 2.9 percent, cards an hour 36, wrong language 0 percent, the two English and Hebrew gap lines, and cost $0.064 an hour for the model. Still failing: card precision 10.9 percent, recall 5.1 percent, cards in silent stretches 0.11 a minute, memory F1, and the first card of a direct question (p95 4.6 s). The model judge rated 32 percent of the recorded cards useful. Card quality is still the weak part of v0.0.1. Held-out meetings were not read again.

**Re-recorded again before release (figures from the user's own notes allowed):** 3 of 16 ship lines pass: wrong language 0 percent, the English and Hebrew recall gap, and cost $0.053 an hour. Card precision 9.6 percent, recall 5.8 percent, duplicates 6.8 percent, 47 cards an hour, first card of a direct question p50 1.2 s and p95 4.6 s. The judge rated 26 percent of the cards useful. A second fresh recording of the code without that change also passed 3 of 16 (163 cards, 28 percent useful), so the drop from 6 is the spread between recordings, not the change. Read single recordings with care.

**Final recording for v0.0.1 (all fixes in, room for the full instructions, replay on the shipped call clock):** 5 of 16 ship lines pass: the two English and Hebrew gap lines, wrong language 0 percent, 35 cards an hour, and cost $0.065 an hour. Card precision 12.2 percent, recall 5.5 percent, duplicates 4.6 percent, first card of a direct question p50 1.0 s and p95 3.4 s (21 of 56 direct questions got a card in time). The judge rated 33 percent of the cards useful. An earlier recording of the same code, replayed on the wrong clock, showed stall lines the app does not show (4 of 16, 23 percent useful). A replay of a real recording always misses some model calls (30 to 55 here), because the replay clock is not the live clock.

The table below is the first recording, before those fixes.

**These numbers are from the build before the fixes that followed.** Since then the recording tool keeps its key and records every call, the judge no longer returns empty answers, the example answers are opt-in, and the prompts, the reply parser, the memory patch check and the language check changed. The recorded replays in `app/data/cassettes/` are stale for the changed prompts. The table below is therefore the state before the fixes, not the state of v0.0.1. Run `pnpm morning` again to refresh it ([Recording evals](RECORDING-EVALS.md)).

| What | Result |
|---|---|
| Short real calls (8 calls, English, Hebrew and mixed, with real Deepgram and the real model) | No crash, no AI error, no stuck call. Every question was heard and detected. |
| Speech to text, words right | English about 92 percent, Hebrew 77 to 83 percent, mixed speech lower |
| Time from end of speech to a card | Prepared card 0.3 to 0.7 s. AI card 1.0 to 3.5 s |
| Cost | About $1.40 an hour for the whole call, 90 percent of it speech to text. The AI part was about $0.14 an hour in these short calls (the model of the replays: $0.03 to $0.04 an hour) |
| Ship lines (`pnpm eval --ship`) on a replay of the real AI against the 32 dev meetings | 4 pass, 12 FAIL. Card recall and precision were close to zero, wrong-card rate 83 percent, wrong language 6.8 percent, first card of a direct question p95 6.1 s |
| Held-out meetings (`test`, `test-b`) on the recording | 2 hard limits fail (cards in silent stretches, guard breaches). Recall 0.5 to 1.4 percent |
| Memory of the call (24 invented calls) | F1 well below the floors (open questions 14, numbers 9, objections 0) |

What the failures looked like in the real calls: direct questions to the user often got no card; the prepared example answers (web hosting) showed in unrelated calls; some cards were in the wrong language; the model sometimes wrote its coaching text into the card; "Still unanswered" tips came back after the user had answered; a check card compared two unrelated numbers. Two of the numbers above are partly measurement problems and are not trusted yet: a replay of the same recording misses about 10 percent of the calls, and the model judge returned empty answers in most cases. So read the table as "card quality is not proven and probably weak", not as exact figures.

What this means for v0.0.1: the app, the install, the two-key setup, the languages and the call loop work. The usefulness of the cards on a real call is unproven. Use it on calls where a wrong or missing card does no harm, and check every card before you say it.

### Scripted numbers

"In-sample" means the set was used while tuning. These are scripted: the model replies are fixtures.

| What | Result | Basis |
|---|---|---|
| Golden dev, 32 invented meetings, 292 moments: card recall, precision | 84.6 percent, 79.7 percent | scripted, in-sample |
| Same: duplicates, cards an hour, cards a minute in silent stretches | 1.0 percent, 82, 0.02 | scripted, in-sample |
| Same: time to a card p50 and p95 (direct path) | 900 ms and 1500 ms (observer path 1500 and 4000 ms) | scripted, virtual clock |
| Ship thresholds on dev (`pnpm eval --ship`) | 8 pass, 6 FAIL, 2 not scored (recorded-only) | scripted, in-sample |
| FAIL lines on dev | precision all 79.7 percent, answer 70.8, prompt 77.4, fact 71.1 (need 80); cards an hour 82 (need 40); wrong-language 0.6 percent (need 0) | scripted |
| `test-c`, 8 meetings, 37 moments, read with `--final --ship` | recall 91.9 percent, precision 73.9 percent, 8 pass and 6 FAIL | scripted, **not truly blind** |
| `test` (7 meetings) and `test-b` (14 meetings), printed next to it | precision 73.3 and 98.3 percent, recall 86.7 and 89.2 percent | scripted, read before |
| AI paused, the floor alone, 34 meetings, 84 answer moments | recall 63.1 percent of answer moments (about 43 of 68 on the dev replay) | scripted, in-sample |
| AI paused (floor plus old hint), engine replay of the 32 dev meetings | 60 of 68 answer moments (88 percent) got a card, no model call | scripted, in-sample |
| Early start (assumed 700 ms speech-to-text lag, 800 ms model) | card 500 ms earlier (median 1500 to 1000 ms after the end of speech); 6.5 percent extra direct calls | scripted, assumed |
| Modelled AI cost, all roles | $0.032 an hour (limit $0.25); plan for 5 to 20 cents an hour | scripted, modelled usage |
| Memory eval (24 invented calls: 10 English, 9 Hebrew, 5 mixed; scripted updater) | F1 88 percent | scripted, scorer check only |
| Judgement set, memory floors, cost check against real usage, direct first card p95 | not run | needs a recorded run ([Recording evals](RECORDING-EVALS.md)) |

**Why the 6 FAIL lines are not fixed by tuning.** The constants of the scheduler were tuned on `dev` already (precision went from 70.5 to 79.9 percent, duplicates from 7.6 to 1.0). More tuning on a scripted set only fits the script. The honest next number is the recorded one.

**`test-c` is not truly blind.** Its builder had no independent author and had read the schema, README and other splits; it was read twice. Replace it with a split written by an independent author (a person who sees only the schema and the README), lock it, and read it once. Until then the held-out columns are comparison, not a release estimate.

## Not yet checked on real audio

The recorded run above used synthetic voices and invented scripts. Not yet recorded or checked on real people and real calls:

- **A clean recorded run of live reading** after the fixes: `pnpm morning --cap 5` ([Recording evals](RECORDING-EVALS.md)). The two recording tool bugs found in the first run are fixed: the real key is kept, so a real recording works, and the model judge no longer returns empty answers. The numbers in the table above still predate these fixes, and the cassettes are stale for the changed prompts, so `pnpm morning` must be run again to refresh them.
- A real call rated with `pnpm tag`: useful cards an hour, and how many cards you would have rather not seen.
- Latency with real partials: whether early start is stable enough to turn on, and the real first-card time of the direct path.
- Speaker numbers after a real reconnect (so far a fake stream), and the ring after a real slow first connect.
- The receive check for a dead speech socket ([ADR 67](DECISIONS.md#adr-67-a-socket-that-hears-nothing-is-dead-and-readers-use-call-wide-indexes)): whether Deepgram answers every few seconds in real silence, and a real sleep and wake. So far only fake streams. The idle auto-stop counts transcribed text, not audio level.
- The review step ("What Wingman knows") on a real call: its edits are applied by memory id, and a renamed id would drop an edit silently.
- The pre-start review is not shown for a call started from the tray menu or the command line (they have no window).
- Some strings in the setup card, Settings and the Calls view are English only.

- The Readiness check with a real voice, online.
- Hotkeys Ctrl+Opt+1, 2, 3 (copy capture chips) and Ctrl+Opt+A (ask) on a real call.
- The Stop steps (saving, summary, done) and Skip summary on a real call; Quit during a call with the confirm.
- The "only you on the line" and monologue banners clear correctly with real audio.
- Real window plus a real call click path (checks so far used hidden snapshots with fake states).
- Screen-share behaviour of the answer window's content protection (Zoom, Meet, Teams).
- The usefulness gate ([ADR 3](DECISIONS.md#adr-3-numeric-gates-instead-of-opinions)): a few real calls rated, with a target of 2 or more useful cards an hour.
- Your own modes and web lookup on a real call.
- The 40-sentence Hebrew gate on a real recording (so far only the synthetic voice).
- The installer and the guided setup on a clean Mac (real macOS permission prompts, a real Electron download).
- The .dmg on a clean Mac, and the release workflow (it has not run yet).
- `pack from-notes` with a real model and a real notes file (tests use a scripted double).
- Audio restart after a real device change (AirPods off, a USB mic unplugged) and after a real lid close.

## Known limits

- **macOS and Windows.** macOS needs 14.2 or newer (Apple Silicon only) for system audio. On Windows 10 or 11 (64-bit) the app records the microphone and the system audio itself (Electron loopback). A CI run built the installer, installed it for the user, found the Start menu shortcut, started the tray app and uninstalled it. The first run of the install check failed on a hanging tool; a fix is in this release but has not been run on Windows again. Windows audio capture, the key store and the tool process have been tested with fakes only. The engine and file replay also run on Linux (tested in CI); there is no Linux app.
- **English and Hebrew** (and calls that mix them). Other languages are not supported yet: a call in one shows a one-time notice. More languages are possible later; see the roadmap below.
- Needs **Deepgram and Anthropic keys** and the internet. Costs about $1.50 an hour (an estimate; $1.40 measured in short test calls): about $1.30 to $1.40 for speech with Deepgram add-ons plus roughly 5 to 20 cents for AI. Prices in the config are estimates.
- Not a recording or consent tool; the user is responsible for telling participants (see [PRIVACY-AND-SECURITY.md](PRIVACY-AND-SECURITY.md)).
- Call files are not encrypted at rest.
- No signed or notarised build: macOS needs the Open Anyway step and Windows shows SmartScreen on the first start. The app built by `install.sh` runs the repo's code and needs Node 24 at launch; the downloaded .dmg and .exe carry their own engine and need no Node. Permissions attach to the app or terminal that runs it.
- Answer quality gaps seen in testing: slow-site, talk-over and vendor-hosting scenarios pick the right card less often than the baseline (speech garble and model choices); a Hebrew-English mix misses "גרסה של PHP"; team-call tech questions may get no card.
- The old question detector (Classic) and its word lists are a hint and the offline fallback ([ADR 56](DECISIONS.md#adr-56-live-reading-is-the-default-word-lists-are-a-hint-and-the-offline-floor)). They cover Hebrew and English only; for other languages only the language-neutral floor remains. Plan: remove the legacy detector after 0.1.
- Deepgram may use call audio to improve its models unless you turn the opt-out on (`stt.deepgram.mipOptOut`, off by default because opting out may change the price). A choice at first run is not built yet.
- Hebrew speech to text is weaker than English (77 to 83 percent of words right against about 92 percent in our synthetic tests), and Hebrew numbers and dates are sometimes written oddly ("60 1000" for sixty thousand). Check numbers before you say them.
- The Readiness check (doctor) still has macOS-only checks, and some error texts in the setup are English only.
- Two chips can still show for one line when the direct path and the observer both chip it (found by the fuzz test, not fixed).
- Live reading shows more cards than the ship line allows (82 an hour scripted; the line is 40).
- Soniox, Gladia and non-Anthropic AI models are tested only with mocks.
- Fact cards need a snapshot file you build yourself; the builder is not part of this repo.
- The Haiku prompt-cache minimum may need a longer prefix (the Readiness check reports it).
- Deepgram keyterm effect for Hebrew is unmeasured (the gate has a `--no-keyterms` A/B).
- Endpointing is 200 ms. Raise it (350 to 700) if real speech gets questions split at pauses.
- The "kind" of call is a guess after about 20 words. You can lock it or write your own mode ([ADR 64](DECISIONS.md#adr-64-modes-are-visible-lockable-and-writable-by-the-user)).
- AirPods and Bluetooth headsets lower transcript quality (a warning is shown). If a device disappears, the audio source restarts and falls back to the default mic.
- Shared design tokens are only partly adopted across the windows.
- Web lookup and context from a web address or a calendar link contact the hosts you give them; see [Privacy and security](PRIVACY-AND-SECURITY.md).

## Ideas (not built)

- Next (0.0.2): a conversation state model. The call memory also keeps the phase of the call, each speaker's role and stance, the user's goal and the likely next questions with prepared answers. Local delivery signals (speaking rate, pauses, interruptions) steer when cards appear. See [ADR 76](DECISIONS.md#adr-76-a-conversation-state-model-call-flow-tone-and-what-comes-next-proposed).
- A voice print so Wingman can tell you from the other side on speakers, and remember people's voices across calls.
- Phone mode: speakerphone on the Mac microphone with one mixed channel and diarization.
- Web lookup as a live Tip (a company or term, one line, with a source). The opt-in lookup in the Ask tab and the CLI is built ([ADR 65](DECISIONS.md#adr-65-web-lookup-is-opt-in-with-a-source-and-a-cap-replaces-adr-36)); showing it during a call needs a cost cap and a guard against invented numbers. Screen context needs a privacy design first.
- Live lookups in a client knowledge base through MCP, bound to the current client.
- Embedding-based bank, cue and memory matching. It needs a dependency or an API call. The local word-plus-3-gram score gains little on this bank (held-out bank accuracy 40 of 41, as before). The decision waits for a cost number.
- Encrypted call storage with a retention sweeper.
- A second STT or AI vendor proven on real Hebrew calls.
- A signed, notarised macOS installer and a signed Windows installer (SmartScreen warns on the unsigned one).
- Verify the Windows live app on real machines, and Linux support for the live app (engine and replay first). Linux has no audio backend yet. Help wanted.
- More languages. The detector hints, the guards and the window texts need one file set per language ([how](DEVELOPMENT.md#adding-a-language)).
- Optional ring-buffer polish after STT reconnects and connection keep-warm.

Next: [Architecture](ARCHITECTURE.md) · [Development](DEVELOPMENT.md) · [Decisions](DECISIONS.md)
