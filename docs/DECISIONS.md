# Decision log

Each entry says what we decided, why, what else we looked at, and what it costs us. Entries are in rough build order. Status is "accepted" unless noted. Each entry carries the date it was first written down in this repository.

Context for all of them: Wingman was first built around one user's live calls. Calls are mostly Hebrew with English tech words mixed in. A wrong or slow answer on a live call is worse than no answer.

| # | Decision |
|---|---|
| [1](#adr-1-personal-tool-first) | Personal tool first, open source from source on macOS |
| [2](#adr-2-a-first-version-before-the-big-structure) | A small first version before the big structure |
| [3](#adr-3-numeric-gates-instead-of-opinions) | Numeric gates instead of opinions |
| [4](#adr-4-deepgram-nova-3-for-speech-to-text) | Deepgram Nova-3 for speech to text |
| [5](#adr-5-two-audio-channels-me-and-them) | Two audio channels: me and them |
| [6](#adr-6-audiotee-for-system-audio) | AudioTee for system audio |
| [7](#adr-7-speakers-mode-no-headphones-needed) | Speakers mode, no headphones needed |
| [8](#adr-8-english-and-hebrew-with-multi-language-speech-to-text) | English and Hebrew, with multi-language speech to text |
| [9](#adr-9-a-hebrew-aware-question-detector) | A Hebrew-aware question detector |
| [10](#adr-10-the-prepared-bank-comes-before-the-ai) | The Prepared bank comes before the AI |
| [11](#adr-11-claude-haiku-for-the-live-reflex) | Claude Haiku for the live reflex |
| [12](#adr-12-buy-time-stall-lines) | "Buy time" stall lines |
| [13](#adr-13-guards-are-code-not-prompts) | Guards are code, not prompts |
| [14](#adr-14-house-style-never-say-rules) | House-style never-say rules |
| [15](#adr-15-ai-cards-are-labelled-not-verified) | AI cards are labelled "not verified" |
| [16](#adr-16-fact-cards-from-a-local-snapshot) | Fact cards from a local snapshot, not live lookups |
| [17](#adr-17-math-is-computed-locally) | Math is computed locally |
| [18](#adr-18-answers-for-you-on-the-me-channel) | Answers for you on the "me" channel |
| [19](#adr-19-wingman-understands-any-call-the-call-frame) | Wingman understands any call (the call frame) |
| [20](#adr-20-tips-are-rare-and-guarded) | Tips are rare and guarded |
| [21](#adr-21-api-keys-in-the-macos-keychain) | API keys in the macOS Keychain |
| [22](#adr-22-plain-files-no-database-audio-never-saved) | Plain files, no database, audio never saved |
| [23](#adr-23-swappable-providers-behind-settings) | Swappable providers behind settings |
| [24](#adr-24-a-degrade-ladder-and-cost-caps) | A degrade ladder and cost caps |
| [25](#adr-25-an-electron-menu-bar-app) | An Electron menu-bar app |
| [26](#adr-26-the-answer-window-design) | The answer window design |
| [27](#adr-27-the-window-hides-the-live-conversation) | The window hides the live conversation behind a button |
| [28](#adr-28-start-gate-with-start-anyway) | Start gate with "Start anyway" |
| [29](#adr-29-consent-step-removed-optional-ask-me-before-listening-starts) | Consent step removed, optional "Ask me before listening starts" |
| [30](#adr-30-the-cli-over-an-owner-only-socket) | The CLI over an owner-only socket |
| [31](#adr-31-stop-is-a-sequence-with-skip-summary) | Stop is a sequence, with "Skip summary" |
| [32](#adr-32-synthetic-qa-instead-of-live-test-calls) | Synthetic QA instead of live test calls |
| [33](#adr-33-a-practice-call-that-runs-offline) | A practice call that runs offline |
| [34](#adr-34-a-small-user-visible-glossary) | A small user-visible glossary |
| [35](#adr-35-scope-no-real-job-interviews-or-exams) | Scope: no real job interviews or exams |
| [36](#adr-36-web-lookup-is-not-built) | Web lookup is not built (on purpose) |
| [37](#adr-37-quick-call-and-several-prepared-meetings) | Quick call and several prepared meetings |
| [38](#adr-38-one-module-per-language-and-a-call-language) | One module per language, and a call language |
| [39](#adr-39-focus-layout-is-the-default-answer-window) | Focus layout is the default answer window |
| [40](#adr-40-a-self-contained-unsigned-app-bundle) | A self-contained, unsigned app bundle |
| [41](#adr-41-setup-is-three-steps-and-practice-comes-first) | Setup is three steps, and practice comes first |
| [42](#adr-42-pack-drafts-from-notes-pass-the-guards-and-never-touch-the-live-pack) | Pack drafts from notes pass the guards and never touch the live pack |
| [43](#adr-43-model-tests-use-a-fake-that-obeys-and-cassettes-at-the-model-seam) | Model tests use a fake that obeys, and cassettes at the model seam |
| [44](#adr-44-the-model-decides-the-moment-code-keeps-the-plumbing) | The model decides the moment; code keeps the plumbing |
| [45](#adr-45-a-failing-model-or-network-never-leaves-an-empty-screen-and-every-wait-has-a-limit) | A failing model or network never leaves an empty screen, and every wait has a limit |
| [46](#adr-46-a-meeting-does-not-expire-and-is-not-used-up-the-window-has-two-languages) | A meeting does not expire and is not used up; the window has two languages |
| [47](#adr-47-the-moment-engine-runs-behind-a-switch-with-the-old-path-as-its-fallback) | The moment engine runs behind a switch, with the old path as its fallback |
| [48](#adr-48-ask-the-call-answers-from-memory-first-the-model-decides-who-a-question-is-for) | Ask the call answers from memory first; the model decides who a question is for |
| [49](#adr-49-the-v2-engine-is-proven-by-gate-tests-on-the-virtual-clock-and-prompts-are-snapshots) | The v2 engine is proven by gate tests on the virtual clock, and prompts are snapshots |
| [50](#adr-50-reliability-rules-for-restarts-stray-errors-startup-and-failback) | Reliability rules for restarts, stray errors, startup and failback |
| [51](#adr-51-wake-hints-without-word-lists-a-final-memory-pass-and-a-cache-layout-that-follows-how-often-a-block-changes) | Wake hints without word lists, a final memory pass, and a cache layout that follows how often a block changes |
| [52](#adr-52-context-sources-are-read-locally-and-treated-as-untrusted-people-are-remembered-from-saved-calls) | Context sources are read locally and treated as untrusted; people are remembered from saved calls |
| [53](#adr-53-every-number-is-scripted-or-recorded-and-budgets-are-calibrated-per-role) | Every number is scripted or recorded, and budgets are calibrated per role |
| [54](#adr-54-the-card-is-shown-whole-labels-are-never-taken-from-the-line-and-old-cards-fade-by-rule) | The card is shown whole, labels are never taken from the line, and old cards fade by rule |
| [55](#adr-55-one-morning-command-a-judgement-set-apart-from-the-meetings-and-stale-is-not-a-miss) | One morning command, a judgement set apart from the meetings, and stale is not a miss |
| [56](#adr-56-live-reading-is-the-default-word-lists-are-a-hint-and-the-offline-floor) | Live reading is the default; word lists are a hint and the offline floor |
| [57](#adr-57-precision-first-doubtful-cards-become-chips-labels-are-required-and-wingman-learns-from-ratings) | Precision first: doubtful cards become chips, labels are required, and Wingman learns from ratings |
| [58](#adr-58-a-card-is-short-by-construction-not-cut-afterwards) | A card is short by construction, not cut afterwards |
| [59](#adr-59-speaker-numbers-belong-to-one-connection-an-epoch) | Speaker numbers belong to one connection (an epoch) |
| [60](#adr-60-early-start-on-a-stable-partial-off-until-the-latency-is-recorded) | Early start on a stable partial, off until the latency is recorded |
| [61](#adr-61-ship-thresholds-are-absolute-and-the-final-read-uses-a-split-nobody-tuned-on) | Ship thresholds are absolute, and the final read uses a split nobody tuned on |
| [62](#adr-62-scripted-is-not-recorded-every-number-is-labelled-and-release-needs-the-recorded-run) | Scripted is not recorded: every number is labelled, and release needs the recorded run |
| [63](#adr-63-one-memory-the-call-frame-is-retired) | One memory: the call frame is retired |
| [64](#adr-64-modes-are-visible-lockable-and-writable-by-the-user) | Modes are visible, lockable and writable by the user |
| [65](#adr-65-web-lookup-is-opt-in-with-a-source-and-a-cap-replaces-adr-36) | Web lookup is opt-in, with a source and a cap (replaces ADR 36) |
| [66](#adr-66-measured-token-budgets-name-matching-and-a-compaction-check-what-shipped-for-adrs-63-and-64) | Measured token budgets, name matching and a compaction check |

---

## ADR 1: Personal tool first

Date: 2026-11-03

**Context.** The first plan was a general product: Windows and macOS installers, auto-update, plugins, a setup wizard. Every cost in that plan came before any proof of value.

**Decision.** Build for one user's real calls first and publish it as source for macOS. Broader packaging (signed installer, Windows, pack installer, polished wizard) follows demand.

**Why.** Proof of value on real calls is the only thing that matters early. Installer and cross-platform work is large and does not help prove that.

**Alternatives.** A full cross-platform product from day one (the original plan).

**Consequences.** macOS only. Run from a terminal or the local app, no signed build. A self-contained, still unsigned, .dmg build exists (ADR 40). The bank and house style in the repo are an invented example pack; replace them with your own pack.

## ADR 2: A first version before the big structure

Date: 2026-11-03

**Context.** The structure documents described a monorepo, three processes, replay clocks, encryption and more, about 3 to 4 weeks before the first call.

**Decision.** Build a first version: a rough, terminal-launched tool in `app/` that reuses the planned ideas but not the planned layout. A flat folder, one process per call, plain JSONL. Add an exit check: if it is not used on a real call by a set date, stop and rethink.

**Why.** It gets the value question answered in days. Infrastructure for replay, linting and process splitting can be added when it saves time on real use.

**Alternatives.** Build the full six-package structure first (rejected in review: it puts the cost before the proof).

**Consequences.** The code layout is flat and pragmatic.

## ADR 3: Numeric gates instead of opinions

Date: 2026-11-03

**Context.** Nobody knew if Deepgram handled Hebrew with English tech words, or if the cards would help.

**Decision.** Two gates with numbers. A **Hebrew STT gate**: you record 40 Hebrew sentences with English tech terms; pass is term recall of at least 85 percent and endpoint-to-final lag of at most about 600 ms. A **usefulness gate** after 3 to 5 real calls: you rate each card useful or not; pass is about 2 or more useful cards per hour.

**Why.** Numbers stop the project from drifting. If the gate fails, the fallback is clear (try another STT vendor, or keep only the bank plus the summary).

**Alternatives.** Judge by feel.

**Consequences.** `pnpm gate`, `pnpm tag` and the rating UI exist for this. The usefulness gate has not been completed on enough real calls yet (see [ROADMAP.md](ROADMAP.md)).

## ADR 4: Deepgram Nova-3 for speech to text

Date: 2026-11-03

**Context.** Wingman needs streaming speech to text with Hebrew, fast final results, and a way to boost English tech terms.

**Decision.** Deepgram Nova-3 over its live WebSocket, behind our own provider interface. Keyterms (up to 100, from `keyterms.txt` in the pack) are sent when supported.

**Why.** Nova-3 supports streaming Hebrew and keyterms, and had the fastest endpointing we measured (final lag p50 about 0.4 s at `endpointMs: 200`).

**Alternatives.** Soniox (about $0.12 an hour, much cheaper, claims good Hebrew and English switching) and Gladia. Both have adapters, tested only against a local mock server, so they are marked experimental. The AI SDK's own transcription helper was not used because its streaming support was not confirmed.

**Consequences.** Speech costs about $0.55 an hour per channel. Needs a Deepgram key. Real-call Hebrew quality is still the biggest unknown; the gate is the way to measure it.

## ADR 5: Two audio channels: me and them

Date: 2026-11-03

**Context.** To answer the other side's question and to not answer your own words, Wingman must know who spoke. Mixed-audio speaker detection is weaker, especially in Hebrew.

**Decision.** Capture system audio (the call app's output) as "them" and the microphone as "me", and open two separate streams to the speech service.

**Why.** Channel equals speaker, with no guessing. Costs twice the speech minutes, which we accept.

**Alternatives.** One mixed stream with diarization. Kept in the plan only for a future phone mode (speakerphone on the Mac mic).

**Consequences.** Speech cost is doubled. Needs two permissions (Microphone and System Audio Recording). If the other side is silent while you talk, Wingman says so ("I only hear you").

## ADR 6: AudioTee for system audio

Date: 2026-11-03

**Context.** On macOS, capturing what a call app plays usually needed a virtual device like BlackHole.

**Decision.** Use AudioTee (a Core Audio tap, macOS 14.2 or newer) by default. A `device` source through ffmpeg stays available (for example BlackHole).

**Why.** No driver install and no audio routing change for the user.

**Alternatives.** BlackHole or other loopback devices; Electron's own loopback capture (kept as a possible later route).

**Consequences.** macOS 14.2 or newer. Permission belongs to the app that runs it, so run from Terminal.app (or the Wingman app) and allow "System Audio Recording".

## ADR 7: Speakers mode, no headphones needed

Date: 2026-11-03

**Context.** On laptop speakers the mic also hears the other side, so their words would be answered as if "me".

**Decision.** Two cheap layers, on by default: a mic gate (the mic sends silence while the other side is loud) and an echo text filter (drop a "me" line that mostly repeats a recent "them" line). A voice print and real echo cancellation are left for later.

**Why.** Cheap, local, and good enough. Headphones remain better.

**Alternatives.** Require headphones. Voice-print speaker ID (planned, not built).

**Consequences.** Talking over each other on speakers loses some of your words. With headphones, the `filter` mode keeps your words when you interrupt.

## ADR 8: English and Hebrew, with multi-language speech to text

Date: 2026-11-03

**Context.** Calls are Hebrew with English tech terms ("cache", "plugin", "staging"). Hebrew-only recognition writes English words phonetically.

**Decision.** Default `stt.language: multi`. A synthetic test found 52 percent of English terms recognised in `multi` against 18 percent in `he`. `he` stays as "Hebrew only" for steadier short clips. In `multi`, finals written mostly in other scripts (Telugu, Persian and so on, hallucinated on short clips) are dropped and counted.

**Why.** Term recall was the project's main risk, and `multi` measured better.

**Alternatives.** `he` only; a post-processing alias table (still available, `data/aliases.yaml`).

**Consequences.** The measurement used a computer voice, not real speech; re-check with real recordings. Languages other than Hebrew and English are not supported yet; the engine shows a notice when it hears one.

## ADR 9: A Hebrew-aware question detector

Date: 2026-11-03

**Context.** A simple "four words or a question mark" rule misses real Hebrew questions ("כמה זה עולה?", "יש גיבוי?") and fires on "כן נכון".

**Decision.** A local rule-based detector with a head-word lexicon (כמה, יש, אפשר, מתי, האם, איך, למה...), a 2-word minimum, Hebrew prefixes, and a labelled test corpus with precision and recall targets. Ambiguity is left to the model's SKIP tag. Related: fragments cut by a pause are joined, and one final containing several questions is cut apart.

**Why.** Deciding locally is free and instant, and it can be tested on a corpus.

**Alternatives.** Ask the model about every line (slow, costly, noisy).

**Consequences.** A rule list needs upkeep as new phrasings appear. Recall was 98 percent in the project's deep test.

## ADR 10: The Prepared bank comes before the AI

Date: 2026-11-03

**Context.** Most web and hosting calls repeat the same questions: DNS, SSL, backups, slow site, domain transfer.

**Decision.** Keep a local keyword bank of short answer cards written by the user (Claude drafted the first versions). On a match, show the card at once. The AI is a second line, and it may drop a weak bank card with SKIP.

**Why.** The bank is fast (about half a second), free, and says exactly what you would say. The AI is slower, costs money and can be wrong.

**Alternatives.** AI for everything; embeddings search (planned for later, not built).

**Consequences.** You must maintain the bank. Keyword triggers can miss rephrasings, so the AI covers the gaps. Bank cards are the only ones shown as "Prepared".

## ADR 11: Claude Haiku for the live reflex

Date: 2026-11-03

**Context.** The live answer must start within about 1.5 seconds. Quality matters less than speed, because you read and rephrases the card.

**Decision.** Use Claude Haiku (`anthropic:claude-haiku-5-5`) with thinking off and low effort, streamed, with a cached prompt prefix. The same small model does frame, notes, tips, the "is this for me" classifier and the summary.

**Why.** Fast first tokens, cheap, good enough Hebrew. Measured about 0.85 s to the first tag and about 1.4 s to a first answer.

**Alternatives.** A larger model (slower and more costly per call; a price entry exists in the config for it). Other vendors through the provider interface (never tried in Hebrew).

**Consequences.** Haiku sometimes picks a wrong bank card or invents detail, which is why the guards exist (ADR 13). Needs an Anthropic key.

## ADR 12: "Buy time" stall lines

Date: 2026-11-03

**Context.** A live question about a price, a date or a promise must not get an invented number. A silent screen is also bad.

**Decision.** When the model has not tagged within 1.8 seconds, or the question is about price, timeline or guarantee, show a neutral stall line such as "I will check and come back with a proper price". Stall lines contain no time promise ("today" was removed). They are not hidden by the card rate limit.

**Why.** It gives you a safe sentence to say while you think.

**Alternatives.** Show nothing; let the model answer and hope the guard catches it.

**Consequences.** On non-client calls (team, personal), stall and bank cards are suppressed so they do not appear in the wrong place.

## ADR 13: Guards are code, not prompts

Date: 2026-11-03

**Context.** Telling a model "never say prices" works most of the time, not all of the time.

**Decision.** Every AI text passes through regular-expression guards before display: currency and numbers, price verbs with number words, relative dates, weekday and month names, deadlines, SLAs, promises and guarantees, in Hebrew and English. A hit replaces the text with a stall line. The same guards run on the summary email.

**Why.** A code check is testable and does not depend on model behaviour.

**Alternatives.** Prompt-only rules; a second model as a checker (slow).

**Consequences.** More false positives (a harmless sentence replaced by a stall line) rather than false negatives. Regex guards will not catch every paraphrase. The test corpus requires 0 leaks and the QA harness counts "guard leaks" (0 in the last run).

## ADR 14: House-style never-say rules

Date: 2026-11-03

**Context.** Cards are read aloud, so they must sound like you and never make you say something you cannot stand behind.

**Decision.** `house-style.md` (in the pack) is the tone and rule file, and it is part of the AI prompt. Cards are short (25 words at most), spoken Hebrew, gender-neutral where possible. Never: prices, dates, timelines or SLAs, promises or guarantees, blaming the client, unexplained jargon, client-specific facts not said by the owner.

**Why.** These are the mistakes that cost a business money or trust.

**Alternatives.** No style file (generic AI tone).

**Consequences.** The file is yours to rewrite (the repo has an example). Rules are enforced twice: in the prompt and, for prices, dates and promises, in the guards.

## ADR 15: AI cards are labelled "not verified"

Date: 2026-11-03

**Context.** An AI answer looks as confident as a bank answer.

**Decision.** AI cards carry a visible "AI · not verified" tag. Prepared cards carry a "Prepared" tag. Only code can mark something as checked; the model cannot.

**Why.** You need to know at a glance which cards you wrote and which a model made up.

**Alternatives.** One look for all cards.

**Consequences.** AI cards are shown a little quieter than Prepared ones.

## ADR 16: Fact cards from a local snapshot

Date: 2026-11-03

**Context.** It is useful to see what you already know about a client or domain when it is mentioned. A live lookup in a client database during a call is slow, can fail, and could show the wrong client's data.

**Decision.** Build a snapshot file before the call (`entities.json` in the Wingman data folder, outside the repo) and match names and domains against it locally. No network lookups during the call. Short or generic aliases never match alone. A client spotted when no Plan names one is only proposed ("looks like X, confirm") before the AI may use its details.

**Why.** Instant, offline, and the data scope is known. A false client match is a privacy mistake, so matching is conservative (the tool `pnpm factscheck` measures false hits on ordinary lines).

**Alternatives.** Live tool calls to a knowledge base (kept as a later idea); a network search.

**Consequences.** The snapshot goes stale; you rebuild it. The snapshot builder is not in this repo, so fact cards are off unless you provide the file.

## ADR 17: Math is computed locally

Date: 2026-11-03

**Context.** A model is slow and sometimes wrong at arithmetic, and a question like "what is 36 plus 42" must not trigger the price stall line.

**Decision.** A small evaluator (`calc.ts`) handles digits and Hebrew and English number words, percentages and fillers. It answers in under half a second with no AI. It also keeps arithmetic and non-service prices ("how much is a dollar") away from the price stall.

**Why.** Instant and exact.

**Alternatives.** Ask the model.

**Consequences.** Only simple arithmetic is covered.

## ADR 18: Answers for you on the "me" channel

Date: 2026-11-03

**Context.** In a live test the user asked Wingman a math question out loud and it worked, but the feature was an accident of the design. The wish: "it is a meeting assistant, not a sales tool".

**Decision.** Wingman can answer questions the user asks it ("For you" cards): out loud when it is clearly for Wingman (`assist.answerMe: always`), only after **Ctrl+Opt+A** (`hotkey`), or never. Local cues decide first; a tiny classifier call decides only when unsure. It stays quiet when you ask the other person ("what is your budget?"). It never answers yes or no on the owner's behalf, and a For-you card is never shown within a few seconds after a card for the other side.

**Why.** Dual use of one tool in one call, without cards fighting for the same space.

**Alternatives.** A separate ask box only.

**Consequences.** Some false triggers are possible; the setting can be set to hotkey-only.

## ADR 19: Wingman understands any call (the call frame)

Date: 2026-11-03

**Context.** The first version assumed client and sales calls. The goal was not a tool built around sales: it should understand what the call is about and give relevant help.

**Decision.** About once a minute a small model writes a call frame: kind (client, support, vendor, team, consult, personal, other), topic, goal, people and a checklist. The kind changes only after two updates agree; the checklist is made once, items only go from not done to done, and at most one is added per update. On calls that are not client or support calls, bank cards are dimmed and the model may drop them.

**Why.** The same loop then serves vendor negotiations, team meetings and consults. Stable labels avoid flicker.

**Alternatives.** Hard-coded meeting types chosen by the user in advance (the Plan still lets you set one).

**Consequences.** The kind is a guess after 20 or more words. The first question before any frame still gets client-call handling.

## ADR 20: Tips are rare and guarded

Date: 2026-11-03

**Context.** Extra suggestions during a live call distract.

**Decision.** At most one tip every two minutes, never within 20 seconds of an answer, never in Quiet mode, 140 characters at most, guards on every tip. "No tip" is the normal answer of the model. Local tips need no AI (you talk more than 75 percent of 5 minutes; a once-only nudge for missed must-cover items).

**Why.** A tool that talks too much gets turned off.

**Alternatives.** A constant stream of live notes (the notes rail exists but is limited to a few items).

**Consequences.** Tips are rarely visible; this is intended.

## ADR 21: API keys in the macOS Keychain

Date: 2026-11-03

**Context.** Keys were first in `~/.config/wingman/keys.env`. A plain file can leak through backups, sync or a stray `cat`.

**Decision.** Keys live in the macOS Keychain (service `wingman`). All access goes through one module that calls `/usr/bin/security` without a shell. Writes use stdin so a key never appears in `ps` or the environment, and every write is read back. The settings page only ever sees the last four characters. Migration from the old file is an explicit button or command (each key is read back from the Keychain before its line leaves keys.env; no plaintext backup is made), never automatic. Keys are removed from the engine's own environment after loading and are not passed to child processes.

**Why.** The Keychain is the platform's secret store; leaks through files are the common failure.

**Alternatives.** The `.env` file (still read as a legacy fallback); a third-party vault.

**Consequences.** macOS only. A key typed in the app is never shown again. Tests use a mocked `security` runner, and the real runner refuses to run under the test runner.

## ADR 22: Plain files, no database, audio never saved

Date: 2026-11-03

**Context.** A planned design had encrypted per-call storage and a SQLite index.

**Decision.** The first version stores plain JSONL files per call with owner-only permissions. No database. Audio is never saved (`privacy.storeAudio: false`). Retention is manual (`pnpm purge`, "Stop and delete this call"), and the readiness check lists calls older than 30 days.

**Why.** Files are easy to read, back up, delete and debug, and a crash leaves a valid log. Not saving audio removes the most sensitive data.

**Alternatives.** Encrypted storage (planned for later, needed before keeping many real client calls), SQLite as a rebuildable index.

**Consequences.** Transcripts on disk are not encrypted. Use FileVault and delete calls you do not need. See [PRIVACY-AND-SECURITY.md](PRIVACY-AND-SECURITY.md).

## ADR 23: Swappable providers behind settings

Date: 2026-11-03

**Context.** Vendors fail, change prices and add languages. A call must survive a provider outage.

**Decision.** Speech, the AI model and audio capture sit behind small interfaces. A provider is chosen by a setting, with an ordered fallback list that is used mid-call after repeated failures (auth, quota, outage). One error model classifies provider failures. The setting layers are defaults, user file, profile, environment, then command line, and unknown keys are errors.

**Why.** The right response to most failures is "switch by setting", not "write code".

**Alternatives.** Hard-code the two vendors.

**Consequences.** Fallback providers are only tested with mocks. Other LLM vendors need an extra package install. A fallback is never tried after an answer has started streaming.

**Update (2026-11-08).** Provider ids and key variables are listed once, in `providers/catalog.ts`; audio capture sits behind `AudioBackend` (macOS only, win32 and linux are stubs).

## ADR 24: A degrade ladder and cost caps

Date: 2026-11-03

**Context.** Slow or failing services must never block the call, and silence is the failure we cannot afford.

**Decision.** A health supervisor moves between: full, reduced AI (the AI is slow: answers keep coming and a late one is dropped), provider switch, bank only (Prepared cards and stall lines), transcript only, off. It changes only between questions and recovers after a calm minute. A persistent bar shows the current state. The AI spend per call is capped (default $2): at the cap Wingman drops to Prepared-only. Speech spend is shown but not capped. A speech outage retries forever instead of ending the call; only a rejected key or no credit ends it. The call stops itself after 15 minutes of silence.

**Why.** Rule 1: a failure never produces a wrong card. Rule 2: a failure is always visible. Rule 3: the fallback is always "carry on without Wingman".

**Alternatives.** Fail hard and stop the call.

**Consequences.** More states to test. Rung 1 keeps the model on while it is only slow, so a slow model costs some cards, not all of them (changed in round 8; the first version dropped to bank plus stall at once).

## ADR 25: An Electron menu-bar app

Date: 2026-11-03

**Context.** A terminal tool is not enough on a call: you need start/stop, a plan form, settings and a place to rate cards. The answer window also needs a native window that does not steal focus.

**Decision.** One Electron app (menu-bar icon plus a window), run from the repo. The engine runs as a child process per call, controlled over stdin and status lines. One call controller, one window, single instance. `pnpm make-app` builds a renamed Electron copy so the Dock and notifications say "Wingman", with a launcher that loads the repo code, so updates need no rebuild.

**Why.** The engine keeps no Electron imports, so it still runs from the command line, in tests and on replays. Electron gives always-on-top, non-focusable windows, global shortcuts and content protection.

**Alternatives.** A web page served locally (cannot do overlay windows or global shortcuts); Tauri (considered by similar tools; not chosen because the whole stack is TypeScript).

**Consequences.** A larger install. No signed or notarised build yet; macOS permissions attach to the app that runs it.

**Update (2026-11-07).** A self-contained app and .dmg can now be built (see ADR 40); the launcher that loads repo code is still the dev route.

## ADR 26: The answer window design

Date: 2026-11-03

**Context.** The user reads it in a glance while talking, on a second screen, mostly in Hebrew with English words.

**Decision.** A frameless always-on-top window that never takes focus. The newest answer is the hero: large, fixed font size (`overlay.fontPt`, default 30), right-to-left with isolated Latin runs. Older answers are small. Colour is reserved for state: red and amber only for problems. Pause hides the window's content but keeps collecting cards, so unpausing shows what was missed. Clear, pause, rewind ("what did they say", last 30 s as text), copy and checklist are global hotkeys, because a non-focusable window cannot take key presses. Content protection is on. With a single screen the window refuses to open by default, so it cannot be shared by accident; `overlay.allowPrimary` (a setup toggle) lets a user who accepts the risk open it on the main screen.

**Why.** Fixed sizes mean no jumping text while speaking; big text for a glance; protection from accidental screen share.

**Alternatives.** Auto-sizing text; a window on the main screen; three visual "skins" (built, tried, then deleted in the UX audit).

**Consequences.** Content protection is untested with Zoom: the second screen is the real protection. Never share the primary screen with the window on it.

**Update (2026-11-07).** The default layout is now Focus (see ADR 39). The description above is the `full` layout (`overlay.layout: full`).

## ADR 27: The window hides the live conversation

Date: 2026-11-03

**Context.** A UX audit (4 reviewers, 54 problems, 52 fixed) found that the Home window showed the live transcript during a call, which pulls the eyes away from the person you are talking to.

**Decision.** During a call the Home page shows the timer, phase, warnings, Quiet mode, notes and Stop, and hides the live conversation behind a **Show conversation** button.

**Why.** The answer window is for use during the call; the window is for control and review.

**Alternatives.** A live chat-style transcript always visible (the first version).

**Consequences.** One more click to see the transcript live. The window never opens or takes focus by itself during a call.

## ADR 28: Start gate with "Start anyway"

Date: 2026-11-03

**Context.** Starting a call when the system is not ready (no mic permission, no key) gives a bad call and a confusing error.

**Decision.** When the last Readiness check says NOT READY, **Start** warns and offers **Start anyway**. When the mic is blocked the check is a FAIL; when it is merely quiet it is a WARN.

**Why.** Warn, but never block: Rule 3, nothing may stop the user from using the tool when they know what they are doing.

**Alternatives.** A hard block on NOT READY.

**Consequences.** A user can start a call that will not work; the warning says why.

## ADR 29: Consent step removed, optional "Ask me before listening starts"

Date: 2026-11-03

**Context.** The first design had a consent gate: nothing was sent to the cloud until the user said a consent line and pressed a key. For a tool run by its own user it was friction, and the wording would need a legal review.

**Decision.** The step is off by default (`privacy.requireConsentAck: false`): listening starts with the call. The old behaviour stays as an optional setting, "Ask me before listening starts": the call waits in the `waiting` phase until **Start listening** (Ctrl+Opt+Return, the button, or `wingman confirm --yes`). Consent wording in the UI was removed. The default consent sentence stays in the settings file as text.

**Why.** Who to tell, and how, is the user's decision and responsibility. The README and the first-run guide say so plainly.

**Alternatives.** A mandatory consent gate.

**Consequences.** Wingman will not remind you to tell the other party. The documentation says clearly that this is your responsibility (see [PRIVACY-AND-SECURITY.md](PRIVACY-AND-SECURITY.md)).

## ADR 30: The CLI over an owner-only socket

Date: 2026-11-03

**Context.** The wish was for an AI coding agent to be able to prepare, run and review calls ("everything the user can do in the app, from a terminal").

**Decision.** The menu-bar app listens on a Unix socket (`~/.config/wingman/run/control.sock`: directory mode 700, socket mode 600, owner check, no network listener). Only a fixed command list is accepted. The `wingman` CLI is a thin client with `--json` output, exit codes 0 to 9, and rate limits on start and stop. Destructive commands need `--yes`. Key commands only report present or missing. The CLI never starts a second engine and never opens the app by itself. The built-in help tells an agent not to start a real call unless asked.

**Why.** One engine, one source of truth, no extra network surface.

**Alternatives.** A local HTTP API (a network listener, rejected); the CLI running its own engine (two calls could clash).

**Consequences.** The CLI needs the app to be running (exit code 3 otherwise).

## ADR 31: Stop is a sequence, with "Skip summary"

Date: 2026-11-03

**Context.** Stopping a call saves files and then waits for a summary model call. During the deep test the stop could look stuck.

**Decision.** Stopping has visible steps (`stopPhase`: saving, summary, done) and a **Skip summary** action. The summary has a 20-second limit and is skipped on timeout. A skipped summary can be written later. A stuck stop is forced off. Quit during a call asks first.

**Why.** Nothing should hold up the end of a call, and nobody should lose a call by quitting.

**Alternatives.** A synchronous stop.

**Consequences.** The call may end without a summary.

## ADR 32: Synthetic QA instead of live test calls

Date: 2026-11-03

**Context.** Live test calls need another person and are not repeatable.

**Decision.** Write call scripts with invented clients (JSON), render them with macOS text-to-speech voices into stereo audio with real pauses and overlaps, play them in real time through the real engine with real Deepgram and Haiku, and grade the result against expected outcomes. A replay mode re-plays what Deepgram heard for pennies. Spend is capped.

**Why.** Repeatable, cheap (about $0.35 for the full set at the time), and it exercises the real services.

**Alternatives.** Only manual tests; only mocked tests (we also have those, hundreds of them).

**Consequences.** Synthetic speech is cleaner than real speech, so accuracy numbers are optimistic. A real recording and the 40-sentence gold set are still needed.

## ADR 33: A practice call that runs offline

Date: 2026-11-03

**Context.** New users (and the author) need to see the product work without a real call, a key or any cost.

**Decision.** "Practice call" plays a scripted pretend client through the real call loop and the real answer window, offline and free. If a Plan is ready, the practice call uses it without using it up.

**Why.** It tests the whole path except audio and the network.

**Alternatives.** A video demo only.

**Consequences.** The script is fixed, so it shows the bank and stall paths, not live AI.

**Update (2026-11-08).** The practice call is bilingual and is the first of three setup steps (ADR 41).

## ADR 34: A small user-visible glossary

Date: 2026-11-03

**Context.** The UX audit found that internal words ("consent", "briefing", "skin", "reflex") confused users.

**Decision.** One vocabulary in the UI, CLI and docs: **Prepared** (a bank card), **AI** (a model answer), **Buy time** (a stall line), **Tip**, **For you** (an answer to your own question), **Math**, **Answer window**, **Plan** (the briefing), **Readiness check** (doctor), **Quiet mode**, **Start listening**.

**Why.** The same word everywhere makes the product learnable.

**Alternatives.** Keep the internal names.

**Consequences.** Some code and old documents still use the old names ("brief", "doctor", "consent", "reflex"). The CLI keeps old command names as aliases (for example `consent`).

## ADR 35: Scope: no real job interviews or exams

Date: 2026-11-03

**Context.** A live AI helper can be misused to deceive an interviewer or an examiner. Several similar tools are built for that.

**Decision.** Out of scope: real job interviews, exams or assessments where outside help is not allowed. Wingman starts only when the user starts it; there is no always-on mode. The rule is social, not technical, and stated honestly: a label cannot stop misuse.

**Why.** Hidden AI help in those settings misleads people.

**Alternatives.** Build for it (rejected).

**Consequences.** Documentation and the readiness material say so. The mode for a prepared meeting of kind `interview` is a mock-interview and practice coach: the user rehearses with their own prep notes, gets suggested answers in their own words, then reviews. It is documented that way. It is not a tool for a real interview or exam that forbids outside help. The rule above still applies to the user, and the user is responsible for following it.

## ADR 36: Web lookup is not built

Superseded in part by [ADR 65](#adr-65-web-lookup-is-opt-in-with-a-source-and-a-cap-replaces-adr-36): lookup now exists, off by default.

Date: 2026-11-03

**Context.** "Give relevant data live" could mean searching the web during a call.

**Decision.** Not built. An idea is recorded: a Tip type that searches for a named company or term and shows a one-line fact with its source.

**Why.** It needs a search provider, a spend cap and a guard against invented numbers. The local bank and snapshot cover the first use.

**Alternatives.** None built.

**Consequences.** Wingman knows only what it is told (Plan, bank, snapshot) plus what the model knows.

## ADR 37: Quick call and several prepared meetings

Date: 2026-11-03

**Context.** There was one saved Plan. Any real Start silently used it, so a Plan written for the 14:30 meeting could be used up by an unrelated spontaneous call, and a second meeting could not be prepared until the first was used or expired (6 h).

**Decision.** Starting a call is now an explicit choice. A **Quick call** has no Plan (the engine gets `--no-brief`) and never uses up or changes a prepared meeting. **Prepared meetings** are saved Plans, as many as 30, each with its own fields, background files, an optional title and an optional scheduled time; a call starts with one only when it is picked (window, menu bar submenu, `wingman start --plan <id>`). Expiry: a meeting with a time stays until 6 h after that time; one without a time stays 14 days after its last edit (the cap); a meeting a real call used is marked used, hidden from the list, its background files are dropped, and the record is kept 7 days so Calls can show which Plan a call used (the call log also records a `plan.used` event with the id). A practice call may use the next meeting without using it up. Plain `wingman start` (no flag): no prepared meetings means a quick call; exactly one meeting scheduled within 30 minutes of now is used; anything else is refused with exit 2 and a list of `--quick` / `--plan <id>`, and the JSON reply says which was used and why.

**Migration.** The first time the store is opened, `latest.yaml` and the flat `attachments/` folder become one prepared meeting (same who, goal, notes, kind, topic, must-cover, files; no time; created at the old file time), then the old files are removed. The meeting id comes from the file time, so a crash in the middle cannot create a copy.

**Why.** A Plan is context for one specific call, so choosing the call and the context together removes the surprise. A refusal is cheaper than starting a real call (which sends audio to a paid service) with the wrong Plan; for an AI agent driving the CLI it also forces a deliberate choice. 14 days keeps a meeting prepared for next week without keeping stale client notes forever.

**Alternatives.** Keep one Plan and add a Quick button (does not allow two meetings in one day). Pick the next meeting automatically on plain `start` (guesses wrong when two meetings are close). Delete a used meeting at once (loses which Plan a call had).

**Consequences.** `wingman plan set` without `--id` edits only when exactly one meeting exists (it creates the first one when none exist, and refuses with several). `plan clear` works only with one meeting. The control socket `start` and `practice` commands take `quick` / `planId`; `brief_refresh` keeps its name and now re-reads the meetings.

## ADR 38: One module per language, and a call language

Date: 2026-11-08

**Context.** The detector cues and the guard patterns were Hebrew lists spread over several files, with English added on the side. Adding a language meant finding every list, and a language without guard patterns would have passed price and date text unchecked. The helper prompts (summary, notes, tips, frame) always answered in Hebrew.

**Decision.** Each spoken language is one `Language` module in `src/lang/` (question heads and cues, request cues, fillers, number words, and the price, date, promise and salary patterns). The type has no optional fields, so a language cannot compile without its guard patterns, and `lang.test.ts` fails if a family is empty. Helper prompts use `callLanguage(text, stt.language)`: `en` when `stt.language` is `en`, otherwise by the share of Hebrew letters in the call text (25 percent or more is Hebrew). With no text, or too little to judge, it stays Hebrew.

**Why.** A new language is one file and cannot skip the guards (ADR 13). Keeping Hebrew as the default means a Hebrew call never changes behaviour. The move was checked with the eval: the numbers are byte-identical, and 23,000 test strings gave identical results before and after.

**Alternatives.** A per-call language setting only (users forget it, and mixed calls break it). Language detection by a model (a cost and a delay on every call).

**Consequences.** About 700 Hebrew lines (normalisation, some fact-card words) are still outside `src/lang/`. A call with a few English words in Hebrew speech stays Hebrew by design. Languages other than English and Hebrew are still not supported; the engine shows a notice (ADR 8).

## ADR 39: Focus layout is the default answer window

Date: 2026-11-07

**Context.** The first answer window (ADR 26) showed the newest answer large, older answers small, and every panel at once. In practice it was too busy to read in a glance while talking, and most of what it showed (checklist, client card, notes) is needed only in pauses.

**Decision.** The default layout (`overlay.layout: focus`) shows the other side's last line, one big answer and a bar with three main keys (Ask Wingman, More, Pause). The checklist, client card, notes and captured details sit in a **More** panel (Ctrl+Opt+L). The earlier layout stays as `overlay.layout: full`. The Settings page offers the choice.

**Why.** One thing to read at a time. The second screen is already the place for answers; the extra panels competed with them.

**Alternatives.** Keep the full layout and add a quiet mode (it hides everything, not just the extras). Auto-hide panels after a few seconds (text that moves is hard to read).

**Consequences.** Two layouts to test and photograph (the screenshots in `docs/ux/` show Focus). The font-size setting `overlay.fontPt` applies to the answer; `overlay.liveTextPt` applies to the other side's line.

## ADR 40: A self-contained, unsigned app bundle

Date: 2026-11-07

**Context.** The installer builds an app that loads the checkout and needs Node 24 at launch (ADR 25). That is fine for a developer and wrong for a person who only wants to try it. There is no Apple Developer account yet.

**Decision.** `pnpm dist` builds a self-contained `Wingman.app` and `.dmg` with electron-builder. esbuild bundles the engine into `src/*.mjs`. The app starts its own executable for each tool (`Wingman --wingman-tool <name>`, `Wingman --wingman-overlay`); only names in the allow-list `shared/bin.cjs` run, and no path from the command line is loaded. There is no asar, because the engine runs child processes and the audiotee binary from the app folder. The `RunAsNode` fuse stays off. The build is ad hoc signed, not notarised; signing and notarising are switched on by environment variables when an account exists. A release workflow builds the .dmg on a `v*` tag.

**Why.** One config for the .dmg, signing and the update files. The tool allow-list keeps the closed-down app from becoming a free Node runtime, which is the reason the fuse is off.

**Alternatives.** Electron Forge (a separate maker for each target). Bundling a Node binary next to a thin launcher (works, but leaves the fuse question open). Waiting for a signed build before publishing anything (delays real use by weeks).

**Consequences.** macOS asks the user to confirm the first start, and the microphone and system-audio permissions again after each build, because an ad hoc signature changes with every build. The `wingman` command line stays a dev feature. `ffmpeg` is found on the PATH. The release workflow has not run yet.

## ADR 41: Setup is three steps, and practice comes first

Date: 2026-11-08

**Context.** The first-run setup had about ten items in a row (keys, privacy, name, permissions, microphone, screens, pack, readiness check). New users met paid keys before they had seen the product work.

**Decision.** Three required steps: **Try it** (a free practice call with a pretend client, offline, no keys), **Connect** (the two keys, with a Test button and the cost shown), **Allow** (microphone, System Audio Recording, screens). Everything else moves under **Make it yours (optional)**: About you, privacy choices, microphone, starter answers, readiness check. Each can be skipped and reopened from Settings. The main window uses plain names (Quick call, Prepared meetings) and a small glossary (ADR 34).

**Why.** Show the product first, ask for money and permissions second. The privacy choices are real but have safe defaults (ADR 29), so they should not block a first call.

**Alternatives.** One long wizard (the first version). A video before setup.

**Consequences.** A user can reach "You're ready" without choosing a microphone, and the answer pack is the example one until they pick a starter (ADR 42). System Audio Recording has no live status in macOS, so Allow asks the user to confirm and restart.

## ADR 42: Pack drafts from notes pass the guards and never touch the live pack

Date: 2026-11-08

**Context.** Writing a bank by hand is the biggest cost of using Wingman. A model can draft cards from a user's FAQ or notes, but a drafted answer that states a price or a date would put an invented number into the fastest, most trusted path (Prepared cards, no AI label).

**Decision.** `wingman pack from-notes <file.txt|.md|.pdf>` makes one model call and writes a draft folder. Every draft card goes through `guard()`. A card whose answer states a price, a date or a promise is not kept as an answer: its triggers move to `stall-price`, `stall-timeline` or `stall-guarantee`, and the report says so. Nothing is written into the live pack; the user reads the draft and copies what they want. The notes file follows the same checks as `plan attach` (no links, no key files, inside the home folder unless forced). Starter packs (sales, support, interview practice, empty) ship in Hebrew and English as plain files the setup copies.

**Why.** Guards are code, not prompts (ADR 13): the same rule applies to drafts. A draft the user must read keeps a person responsible for what Wingman will say.

**Alternatives.** Let the model write the pack straight into place (fast, but an invented number can go live). Only starter packs (no help for a user's own business).

**Consequences.** Drafts need a human pass, and the model only sees the notes. The dashboard has no button for it yet; it is a CLI command. Tests use a scripted model double, so the real quality of drafts is unmeasured.

## ADR 43: Model tests use a fake that obeys, and cassettes at the model seam

Date: 2026-11-08

**Context.** The first offline fake model (`scriptedAnswer`) looked at phrases in the prompt and chose the answer itself. A prompt wording change could break it, and it could not fail, hang or lie on request. New features (moment cards, session memory) need tests for exactly those cases, and a real model call in a test is slow, costs money and is not repeatable.

**Decision.** Tests use a policy fake model: the test lists the replies and the faults, and the fake never decides by itself. A cassette layer wraps the model at `ModelRegistry.resolve`: `WINGMAN_LLM_MODE=replay` serves recorded or hand-written answers by a hash of role, model, prompt and options, with the original timing; a miss fails with a diff. `record` needs a key and is never run in CI. Prompts are compared with committed snapshots. A virtual clock replaces the timers so a 90 second meeting runs in milliseconds. The old fake stays as `legacyScripted` until the v2 engine is in.

**Why.** A fake that obeys makes a test say what it expects. Cassettes keep real answers without a key in CI. Snapshots turn a prompt change into a reviewed diff.

**Alternatives.** Keep adding phrases to the keyword fake (fragile). Call the real model in CI (cost, noise, secrets). Mock only `generateText` (misses the streaming path the engine uses).

**Consequences.** The engine is one process per call with a real clock, so engine-level tests run in real time; the virtual clock is for in-process code. A cassette can go stale when a prompt changes; the miss diff shows why.

## ADR 44: The model decides the moment; code keeps the plumbing

Date: 2026-11-08

**Context.** The question gate is a set of hand-written word lists per language. It misses objections, numbers and implied questions, it fires on questions that need no help, and each language needs a new file.

**Decision.** The moment engine asks the model "is a short private note useful now?" and parses a fixed reply. Code does intake noise filtering, timing, caps, novelty, feedback and fallbacks. The old detector stays as a frozen hint and as the offline gate; no new words go into it. The bank gets a language-neutral 3-gram scorer, and the turn language is passed as an argument instead of a module global.

**Why.** Meaning is a model job; budgets and safety are code jobs. A structural filter works in every language without a list.

**Alternatives.** Keep growing the word lists. Use embeddings for the bank (a download and a native dependency).

**Consequences.** The pieces exist and are tested, but the engine is not wired to them yet. The legacy `getTurnLang` and `setTurnLang` stay until the wiring package removes the last caller.

## ADR 45: A failing model or network never leaves an empty screen, and every wait has a limit

Date: 2026-11-09

**Context.** A review of the live paths found places where Wingman went quiet: an ask by the user that failed with a 529 showed nothing; a question from the other side with a network error got no card before the stall timer; several questions in one final aborted each other; a speech-to-text open could hang for as long as TCP allowed; a crash could be cut off before the call was saved; the engine texts were Hebrew for everyone.

**Decision.** One helper decides what a failed model call shows (a card for an ask by the user, the "Buy time" line for the other side when `reflex.stall` is on, nothing for auth or quota errors, which have their own bar). The bar comes after one failure for an ask by the user and after two otherwise. The parts of one final share a cancel scope. All speech-to-text opens use one 8 s limit. The crash path uses the normal stop path. Engine texts live in `htext.ts` (English and Hebrew) behind `engine/strings.ts`, and a test keeps Hebrew letters out of the engine string literals. The microphone is saved as index plus name and checked at every start.

**Why.** For a live helper, silence is the worst failure: the user cannot tell "no answer" from "broken". A time limit turns a hang into a message and a retry.

**Alternatives.** Always show an error card for the other side's questions (too noisy: most questions end with SKIP). A second STT timer in each adapter only (the channel-level limit also covers new adapters).

**Consequences.** With `reflex.stall` off (the default) a single failed question from the other side still shows nothing; the amber bar after the second failure is the signal. The 8 s limit is a constant, not a setting.

## ADR 46: A meeting does not expire and is not used up; the window has two languages

Date: 2026-11-08

**Context.** A prepared meeting lived 6 hours after its time, was marked used when the call went live, and lost its files then. A crash after Start lost the whole brief. The window was English only, and the words "Plan" and "Prepared meeting" were mixed.

**Decision.** (1) A meeting has no expiry and is never used up. `markLive` records that a call went live; `confirmUsed` records that the call saved its first memory (until the session memory exists, the end of a clean call). Nothing is deleted at either step, so the same meeting starts the next call. Only the owner deleting it, or 180 days with no touch (housekeeping), removes it. The single-Plan `latest.yaml` and its files are read without being changed and retired by `confirmContext()` once the call is live. (2) One optional "Meeting context" box: pasted text, files (.txt, .md, .pdf with pdftotext, .ics), a few small fields behind "More". Long text is cut into chunks of about 500 tokens when it is added. (3) The main window has one catalog per language (`dashboard/strings.en.js`, `strings.he.js`), `dir` follows the language, and every error is one row in `dashboard/errors.js` with a next step and a button.

**Why.** Losing a brief to a crash is the worst case for a tool used just before a call. Reuse is how people really work (weekly calls). Plain words and one error table make the window easier to read and to test.

**Alternatives.** Keep the 6 hour rule and only stop deleting files (the list still empties). Translate the window with a library (a dependency for about 450 strings).

**Consequences.** The meeting list can grow, so the limit is 50 and housekeeping is 180 days. Calls, Settings and Setup details are still English-first; a missing Hebrew key shows English. The digest ("Prepare") and the live memory feed "What Wingman knows" in wave 2; until then it shows a sample or the saved details.

## ADR 47: The moment engine runs behind a switch, with the old path as its fallback

Date: 2026-11-09

**Context.** The new engine asks the model on more lines than the old gate. It must not make the call worse when the model is slow, down or too expensive, and the old behaviour must stay available until the new one is proven.

**Decision.** (1) `moments.engine` is `legacy` or `v2`; the default stays `legacy` until the integrator's gates pass. (2) In `v2` a strong hint takes the old question path, with its bank card, calc and stall timer, and only the model call inside it changes. A weak hint or a long line goes to the observer window. (3) The scheduler and the guards decide what shows; the model only proposes. (4) When the AI is paused (cap, model down, no network) the old path runs without a model, with one calm bar. (5) A soft hourly cap on AI spend stops the cheapest jobs first. (6) Practice interviews keep the old engine, because their coaching prompt is not part of the moment prompt.

**Why.** Reusing the old question path keeps what it learned (agency gate, stall tier, repeat rule, latency rows). Only the decision about meaning moves to the model. A switch makes a bad night cheap to undo.

**Alternatives.** A new path next to the old one (two ways to show a bank card, more bugs). Replacing the old path at once (no fallback).

**Update (ADR 56).** The default is now `v2`, shown as Live reading; `legacy` is Classic, the rollback. The rest of this entry stands.

**Consequences.** `question.ts` has two model calls for one question, chosen per turn. The observer is not fast: a card comes about 1 to 3 s after the sentence. The interview mode needs its own moment prompt before it can use `v2`.

## ADR 48: Ask the call answers from memory first; the model decides who a question is for

Date: 2026-11-08

**Context.** Wingman only showed cards for detected questions. The user also needs to ask the call something ("what did they promise?") and to catch up after looking away. Phrase lists decided whom a question was for, which fails for any wording they do not list.

**Decision.** (1) Ask and Catch me up are one role, `ask`. The prompt holds the call memory and the transcript: all of it under 30k tokens, else the memory plus the best BM25 hits and the last lines. (2) Catch me up is Ctrl+Opt+U (R is rewind). (3) A call answer may not contain a number the call never said. (4) The model decides who a card is for; the phrase lists run only when the AI is off. (5) A failed ask or recap always shows a card, labelled "AI offline: from notes" when it comes from local search. (6) The digest keeps a fact only if its source line is in the pasted text.

**Why.** The memory is small and always fresh, so most answers need little context and stream fast. Local fallbacks mean no empty screen.

**Alternatives.** Embeddings for transcript search (a dependency and a download). Always sending the whole transcript (cost grows with the call).

**Consequences.** One extra model call per ask or recap (about a cent per ten uses). The overlay opens the sheet on `view` rows with `showRecap`; wiring the digest to the Prepare screen is left to the live UI package.

## ADR 49: The v2 engine is proven by gate tests on the virtual clock, and prompts are snapshots

Date: 2026-11-08

**Context.** The v2 engine has many parts (hint, observer, scheduler, memory loop, cards, ask, wrap-up). Unit tests of each part passed while the whole did not work: the moment and observer calls never saw the memory the loop built. Only a snapshot of the real prompt showed it.

**Decision.** (1) Six e2e files (`app/src/e2e/v2-*.test.ts`) test the whole engine: latency, cost, golden meetings, a failure matrix, a 3-hour soak, and prompts. (2) The policy fake reports usage computed from the real prompt, with a simulated prompt cache, so cost rows in `usage.jsonl` are honest even without a key. (3) Every role has a prompt snapshot in `data/snapshots/prompts/`, taken from a real call, with the cache marker of each block. A prompt change is a reviewed diff. (4) Prompt tuning uses the dev split only. With scripted replies it can fix structure, size, cache layout and parse robustness. It cannot fix model judgement.

**Why.** A reviewed text diff is the cheapest way to see what the model gets. A simulated cache makes cost regressions visible before a bill.

**Alternatives.** Only recorded cassettes (need a key and money for each run). Only unit tests (they missed the memory bug).

**Consequences.** The scripted scores are marked provisional. The release gate still needs a recorded run on the dev and test splits. The cache simulation assumes a 1024-token minimum for a cached prefix; a model with a larger minimum would cache less.

## ADR 50: Reliability rules for restarts, stray errors, startup and failback

Date: 2026-11-08

**Context.** A review found gaps in the seams between modules: a respawned audio source was not watched, a stray error during Stop ended the process before the call record was written, Stop pressed during a slow STT start was not read, and after a switch to the fallback STT provider the call never went back.

**Decision.** (1) The audio supervisor watches every spawned source, also while it is "down". A source that never delivers frames is rebuilt with back-off. A planned restart (wake) shows no red bar. (2) `endedAt` and phase `ended` are written before audio and sockets are closed. The 10 s hard exit also writes the STT usage row. (3) A stray error is logged and counted, also before consent and during Stop. Only a runaway count (200 in a minute) ends a live call, and nothing calls `process.exit` before the 16 s guard. (4) The tray stdin reader starts with the process. Stop commands run at once; other commands wait for the consent step. STT events are wired before the sockets open. (5) After a switch to the fallback for a transient reason, the channel tries the primary again after 60 s (`failbackAfterMs`). A refused key is not retried. (6) A wake-up does not reopen a socket that is open.

**Why.** Each rule keeps the call record and the live audio safe in the second failure, which is when the first fix usually breaks.

**Alternatives.** Ending the call on a stray at Stop (loses the record). A fixed wake reopen (drops finals in flight).

**Consequences.** A socket that died silently during sleep is found by the keep-alive and the dead-socket timer, not by the wake. Failback closes the fallback socket; finals still in flight on it at that moment are dropped (once per failback, at most about a second).

## ADR 51: Wake hints without word lists, a final memory pass, and a cache layout that follows how often a block changes

Date: 2026-11-08

**Context.** Three weak points of the call memory. (1) The final memory pass never ran: it asked the same gate as the periodic runs, and that gate is closed from the first second of Stop. The last 20 seconds of a call were missing from the wrap-up. (2) The updater was woken by a capital-letter regex and a unit word list, which do nothing in Hebrew. (3) The prompt cache was designed but not measured: the fixed rules of a role were not marked, the memory block was marked for roles that never read it again, and no usage row showed a cache read.

**Decision.** (1) The gate has a role `final`: allowed while closing, still bound by consent, the cost cap, a down model and a discarded call. (2) Wake hints use a digit, a question mark, a long line, the end of a turn, a pause, and a new word after a speaker change. No word list, no capitals. The unit list stays for practice interviews and the old engine only. (3) The system blocks are ordered shared, fixed role rules, memory, per-call facts, and each role has its own markers (`CACHE_POLICY`). Usage rows carry `cache_read`, `cache_write` and the estimate drift; `wingman doctor` prints the cache report. (4) The memory loop calls `topicChanged()` and the ratings reach the moment engine. (5) A memory-quality eval with two controls.

**Why.** A model reads the call better than a regex does, so the code only decides when to ask. A block earns a cache marker only if it is read again before it expires; the numbers (a write is 1.25 or 2 times, a read 0.1 times) make that easy to check per role on the fixtures.

**Alternatives.** A name regex per language (the same list problem). A cached transcript tail (built, measured, off: the memory block before it changes every patch). One marker for everything (the memory role would pay a write for a block nobody reads).

**Consequences.** Every prompt snapshot changed in order, not in text. The simulated cache assumes a 512-token minimum (the models in use). `CostMeter` prices every cache write at the 1 h rate, so the 5 minute writes of the memory block are over-estimated. The eval with the fake model tests the pipeline and the scorer only; a real score needs a recorded run.

## ADR 52: Context sources are read locally and treated as untrusted; people are remembered from saved calls

Date: 2026-11-08

**Context.** People have context in Word files, mail, web pages and calendars, not only in pasted text. They also meet the same people again, and Wingman forgot everything between calls.

**Decision.** (1) `shared/inputs.cjs` reads .docx (system `unzip -p`, refused with a clear message if missing), .eml, public https pages and a private .ics address. No npm dependency. Every result is cleaned (control and bidi characters out) and run through `untag`, so it cannot close the transcript wrapper of a prompt. (2) Web reads: https only, port 443, 8 s for the whole read including the name lookup, 1 MB cap, text types only, every resolved address and every redirect must be public. (3) Repeating calendar events are expanded for the simple rules (daily, weekly with BYDAY, monthly, yearly, INTERVAL, COUNT, UNTIL, EXDATE); other rules show the first date. The meeting is shown and used only after the user agrees. (4) `session/people.ts` indexes ended live calls by roster name in the data folder. A new call gets up to 5 facts with src `past`. No model call.

**Why.** Local reading keeps files and pages out of third-party converters. A strict address check stops a page from making the app fetch things inside the user's network. A local index is cheap and works with the model down.

**Alternatives.** An npm docx parser (new dependency to audit). A hosted page-to-text service (sends the user's links away). Asking the model to recall people (cost, and wrong without the saved text).

**Consequences.** Known gaps: DNS rebinding (the address is checked, then fetch resolves again); two different people with the same first name can share notes; rules such as "first Monday of the month" show the first date only.

## ADR 53: Every number is scripted or recorded, and budgets are calibrated per role

Date: 2026-11-08

**Context.** The golden meetings carry scripted model replies, written next to the moments they must satisfy. A score from them proves plumbing, timing and the grader, not model judgement. Cost and latency were checked against a plan table that was twice as high as the measured cost, so a doubling of one role would still pass.

**Decision.** (1) Each result is marked scripted or recorded, in the eval output and in the files (`scripted: true` in `qa/eval-baseline.json`, `basis` in `qa/budgets.json`). Recorded numbers come from `pnpm eval --cassette <file>`, which replays a cassette of the real model on the virtual clock and counts calls the cassette does not know. (2) Cost and latency budgets are measured per role and per card path from the golden run and stored in `qa/budgets.json`. A role or path more than 20 percent over its budget fails. The whole call stays under $0.25 an hour. (3) The held-out splits are printed one by one next to the dev baseline and are read once. (4) The judge has two parts: the rubric judge (always) and a model judge that replays recorded verdicts. (5) Prompt tuning waits for recorded numbers: tuning against scripted replies would change nothing and prove nothing.

**Why.** A budget that is 2 times too loose cannot fail. A number that looks like a measurement but is a script gives false comfort. A cassette makes the real model's answers repeatable and free after the first recording.

**Alternatives.** Keep the plan table as the only budget (too loose). Call the real model in CI (cost, flakiness, keys in CI). Tune prompts on the scripted dev replies (no signal).

**Consequences.** After the first recording the owner runs `pnpm eval --cassette ... --update` once to create the recorded baseline and budgets. A prompt change then changes the cassette keys: the replay reports misses, and the dev meetings must be recorded again before the next comparison. The recorded section may be rewritten only from a cassette that was made with the current prompts.

## ADR 54: The card is shown whole, labels are never taken from the line, and old cards fade by rule

Date: 2026-11-08

**Context.** The round 3 review of the answer window (score 72 of 100) found five problems. The hero line could end in the middle of a sentence. Chips used the first three words of the line when the model sent no label ("What is the"). Each chip had two dots. The transcript row was louder than the card. An answer from six minutes ago looked almost as live as a new one.

**Decision.** (1) The model never cuts the line. The hero shows the whole line; over 14 words, or when the engine marks `fit: false`, it clamps to 3 lines with a More button. (2) A chip shows the model's label, else the kind word. Facts show "label: value". There is one kind mark (a glyph), one bold dot for unseen, and an age. (3) The transcript is one line at about 60 percent size. (4) After 3 minutes a card fades, its age turns amber and an "about:" line says what it answered. After 6 minutes an answer or a prompt is only a chip. Checks, facts and pinned cards do not collapse, because a check that is not handled must not disappear. (5) Open, Promises, Cover and Earlier cards are one Context button with a count; Catch me up is the only primary button. (6) Controls show on hover, focus, or after one minute. "Fewer like this" writes a `fewer` rating and dismisses the card. (7) A screen reader hears a Check and the first card after 90 seconds of quiet. (8) The key hints hide after the first 3 cards of the app's life.

**Why.** A cut line can mislead the one person who only reads that line. A label made from the first words says nothing at a glance; the kind word is true and short. Time rules are simple and testable, and they answer the question "is this still about now?" without the model. A fade that keeps the text at full strength (only the surface and accent soften) keeps the 4.5:1 contrast in both themes.

**Alternatives.** Cut with an ellipsis (rejected: it hides the end of the sentence). Collapse checks too (rejected: an open check is the most important card). Keep two dots (rejected: no one could tell them apart). Make the window focusable so Tab always works (rejected: a focusable window can take the focus from the call; the global keys stay the main path).

**Consequences.** The fade is by text opacity of 0.6 with a text colour chosen per theme (white or black), not by element opacity, because element opacity of 0.6 cannot reach 4.5:1 for amber text on a light card. The in-page keys work only when the user gives the window focus; a "focus the answer window" hotkey is left for a later round. Old screenshots in `docs/ux/` show the earlier layout and are not regenerated here.

## ADR 55: One morning command, a judgement set apart from the meetings, and stale is not a miss

Date: 2026-11-09

**Context.** Every quality number so far came from scripted model replies. The recording steps existed but were separate commands, each with its own cap, and a changed prompt looked like a pile of cassette misses. The golden meetings measure the whole engine over time; nothing measured the judgement of one moment alone.

**Decision.** (1) `scripts/morning.ts` is the only command the owner needs: one cap for all steps, a printed estimate first, a yes before each held-out split, and it refuses without a key, in CI and over the cap. (2) A judgement set of 120 invented cases (60 English, 60 Hebrew) scores the moment role per verdict kind, with two bad models as controls and floors for recorded runs only. The verdict comes from the model reading the lines, not from word lists. (3) The memory eval has 24 calls and an objections class; F1 per class is printed. (4) Cassette entries carry a hash of the prompt and of the input. A miss with an entry of the same input and another prompt or model is a `CassetteStale`. (5) The recorded cost per role is compared with the simulated cost and fails above 15 percent. (6) `pnpm replay` shows what another prompt does to a real call, and turns "not useful" ratings into judgement cases after a no-real-names check.

**Why.** One command with one cap is hard to run wrongly while tired. A set of one-call cases shows which kind of card a prompt change breaks. A stale report tells the owner to record again instead of looking for a bug. The 15 percent check catches budgets that were set from modelled usage.

**Alternatives.** Keep separate commands (a cap per command adds up). Grade the judgement on the golden meetings only (a prompt change moves too many things at once). Fail the replay on any prompt change (hides which entries are only old).

**Consequences.** The floors for the judgement set and the memory eval are provisional; the owner moves them after the first recorded run and the report says by how much. The held-out size in the estimate is assumed from the file count because reading a split is a one-time act. `test-c` is skipped until that split exists.


## ADR 56: Live reading is the default; word lists are a hint and the offline floor

Date: 2026-11-09

**Context.** The first gate asked "is this line a grammatical question?" with hand-written word lists for Hebrew and English. It missed objections, numbers and promises, it fired on questions that need no help, and each new language needed a new file. The owner doubted that lists were the right design. The problem Wingman solves is different: "is a short private nudge useful now, given the whole call so far?"

**Decision.** (1) The model decides meaning ("is help useful now"). Code does plumbing, safety, timing, budgets and fallbacks. (2) `moments.engine` is `v2` by default and is shown as **Live reading (default)**. `legacy` is shown as **Classic (rollback)** and only in Settings, Advanced. (3) The old detector and `lang/*` lists are a frozen hint and a tiebreak. They never stop a model call on a line that passes the structural filter. No word is added to them. (4) With the AI paused or down, a language-neutral **floor** runs: the "?" from speech-to-text, digits and money, a stall-tier bank card, a bank score, your name, and the shape of a short sentence. It uses no word list. (5) Follow-up openers moved to `lang/`; the hosting topic logic sits behind a profile hook, so the core has no vertical words. (6) Tests of the old lists carry the header "hint tests, in-sample, not product truth".

**Why.** The lists cannot be right in every language, and a check of "is it a question" is not the product. A model that reads the memory and the last lines can tell a question, an objection and a promise apart in any language it speaks. The floor keeps the call useful when the model is not there.

**Alternatives.** Keep the lists and add more words (rejected: it never ends, and it does not fix recall on implied requests). Remove the lists at once (rejected: the offline path needs something). Embeddings for the floor and the bank (not now: it needs a dependency or a call; a better local word-plus-3-gram score was built instead and embeddings stay a decision for the owner).

**Consequences.** Scripted, in-sample, golden dev with the AI paused: the floor alone finds 63.1 percent of answer moments, and 88.1 percent with the hint (the same as the old detector alone, with fewer cards in quiet stretches: 44 against 57 of 172 lines). Replayed through the engine, 60 of 68 answer moments got a card with no model call. These are tuning-set numbers. The quality of live reading itself has no recorded number yet (ADR 62).

## ADR 57: Precision first: doubtful cards become chips, labels are required, and Wingman learns from ratings

Date: 2026-11-09

**Context.** Even with scripted replies about one card in three was noise: precision 0.68 to 0.70, 7.6 percent duplicates, 93 cards an hour. A tool that must not distract loses trust faster from noise than from a missed card.

**Decision.** (1) The moment reply has two more lines: `CONF: high | low` and `ABOUT` (at most 8 words). A `low` confidence or a VALUE of 1 is shown as a chip and never takes the hero seat. A Check card keeps its exemption from the per-minute cap. (2) `LABEL` is always asked for. If it is missing, the label is the bank card title, then the memory topic, then nothing. The first words of the line are never a label. (3) Fact cards carry the value itself. (4) The same words again inside 20 seconds are a repeat. (5) A "fewer like this" rating raises that kind's bar at once for the rest of the call. (6) `learn.json` keeps counts per kind: only after at least 3 negative ratings on at least 2 different calls does the bar rise by 1 (never more), and it falls back after 5 calls without a negative. It stores counts, no text, with mode 600, and a corrupt file starts empty. It never goes below the mode's own bar.

**Why.** A card Wingman is unsure about is still worth a glance as a chip; as a hero it costs attention. Learning from the owner's ratings makes the noise fall for this user without a model call, and the slow rule (3 and 2) stops one bad call from changing the product.

**Alternatives.** Raise all thresholds (rejected: it cut recall without removing the noise). Learn from the first rating (rejected: too jumpy). Store the text of rejected cards (rejected: privacy).

**Consequences.** Scripted dev run, before and after: precision 70.5 to 79.9 percent (answer 68.0 to 71.6, check 68.0 to 100, fact 68.3 to 71.1), duplicates 7.6 to 1.0 percent, recall 84.9 to 84.6. The constants were tuned on `dev` only, so these are in-sample. Cost: about 83 more prompt tokens per moment call, under 0.01 USD an hour. The ship thresholds of ADR 61 are not met yet for answer, prompt and fact precision.

## ADR 58: A card is short by construction, not cut afterwards

Date: 2026-11-09

**Context.** A line cut in the middle of a sentence can mislead the one person who only reads that line, and a chip label made from the first words says nothing.

**Decision.** (1) The prompt asks for a SAY of at most 12 words. The parser accepts up to 14. Longer than 14: an observer or open-loop card gets one retry with a short "shorter" instruction (a few percent of observer calls); a direct card is not retried, because of latency. (2) With no retry, the text is cut at the last clause end (comma, colon, dash, full stop, or just before "and" or "but"; Hebrew by punctuation only), the row gets `fit: false`, and the rest goes to `more`. The text is never cut with an ellipsis. (3) A reply over 40 words or 400 characters is garbage and becomes SKIP. (4) The overlay shows the whole line, or three lines with a More button when `fit` is false (ADR 54).

**Why.** The shape of a card is a contract between the prompt, the parser and the window. Doing it by construction means no layer needs to hide a problem from another.

**Alternatives.** Cut with an ellipsis in the overlay (rejected). Retry every long reply (rejected: it adds latency on the path that must be fast).

**Consequences.** A fuzz test (15 fixed and 300 random replies, final and streaming) always gives a valid moment or SKIP with at most 14 words. The extra retry call is booked in usage and logged as `moment.retry`.

## ADR 59: Speaker numbers belong to one connection (an epoch)

Date: 2026-11-09

**Context.** The speech service numbers the voices on the other side from 0 again on every new connection. After a reconnect, a provider switch or a failback, "speaker 0" was read as the same person as before. Cards and the summary then gave one person's words to another person.

**Decision.** The speaker book keys a raw id by `(epoch, raw)`. The engine calls `rebase("them")` on every reconnect, switch, failback and reopen. After a rebase the same raw id is a new voice and takes a new number. A new voice joins an earlier person only when it introduces itself, or the user names it, with the same name (case-insensitive). A burst of reconnects with no voice in between counts once. One line in the status says that voices may be relabelled. The API used by `ingest.ts` did not change.

**Why.** A wrong label is worse than a new label: a new number can be merged by a name, but a wrong merge cannot be undone.

**Alternatives.** Match voices by what they say (rejected: a guess presented as a fact). Never rebase (the bug).

**Consequences.** Under a reconnect storm a long call can show more speaker numbers than people. The 3-hour soak test (`r3-gates-soak`) moves the epoch 23 times in an 8-minute storm and checks the list stays bounded. The e2e `r3-gates-speakers` runs the real channel, wiring, ingest and book on a faked reconnect and a faked switch. Scripted fakes, not a recorded reconnect.

## ADR 60: Early start on a stable partial, off until the latency is recorded

Date: 2026-11-09

**Context.** A direct question waits for the final text from speech-to-text, about half a second after the speaker stops. A partial result of the same words is often stable earlier.

**Decision.** `moments.earlyStart` (default `false`, advanced). When on, a partial of the other side that does not change for 300 ms and ends in a "?", or that follows a 600 ms pause, starts the direct path before the final. One early start per utterance. A final with the same text is deduped (no second call). A final with other text, or that is no longer a question, aborts the early turn and runs normally. Several marked questions wait for the final.

**Why.** It can save 0.4 to 0.8 s, but only if the partials of real audio are stable. That is a fact about real audio and cannot be measured with fixtures.

**Alternatives.** Always on (rejected: unmeasured). Start on any partial (rejected: many aborted calls).

**Consequences.** Scripted, virtual clock: with a speech-to-text lag of 700 ms and a model delay of 800 ms, the card came 500 ms earlier after the end of speech (median 1500 to 1000 ms), with the same cards and no extra call. On the 10 golden dev meetings with 1 final in 12 revised, early start made 6 extra direct calls on 92 (6.5 percent). The lag and the revision rate are assumptions. The owner turns it on after the recorded latency run (ADR 62).

## ADR 61: Ship thresholds are absolute, and the final read uses a split nobody tuned on

Date: 2026-11-09

**Context.** The regression baseline only says "not worse than last time", so a baseline can drift down in small steps. The held-out splits `test` and `test-b` had been read more than once.

**Decision.** (1) `qa/ship.json` holds absolute lines, separate from the baseline: precision of all, answer, prompt, check and fact cards at least 0.80; recall at least 0.80; recall without a "?" and no question word at least 0.85; duplicates at most 3 percent; at most 0.02 cards a minute in silent stretches; at most 40 cards an hour; English and Hebrew within 5 points on recall and on precision; wrong-language rate 0; cost at most 0.25 USD an hour; memory F1 per class at least 0.75 and direct first card p95 at most 2.5 s (these two are `recordedOnly`). `pnpm eval --ship` prints pass or FAIL per line, and `n/a (scripted)` for a recorded-only line on scripted replies. Four bad models (null, noise, shuffled, always-answer) must fail the gate, or the run fails. (2) `test-c` is a third split behind its own lock; only `--final --ship` reads it, and it decides. (3) A lint rule or a behaviour test replaces a source-text grep wherever one can.

**Why.** An absolute line is a promise that a person can read. Controls prove that the grader cannot be fooled. A split that was not used for tuning is the only honest estimate left.

**Alternatives.** Raise the baseline each round (rejected: no ceiling). One shared held-out set (rejected: it is used up after the first look).

**Consequences.** **`test-c` is not truly blind.** The builder who wrote it had no independent author and had read the schema, the README and the other splits; it has been read twice (the builder's check, then the round 3 final read). It must be replaced by a split written by a person or a separate agent who sees only the schema and the README, and locked, before it counts for release. Every ship line is still scripted, so a scripted pass is not a release pass (ADR 62). On dev, 8 of 14 scored lines pass and 6 fail; on `test-c`, 8 pass and 6 fail.

## ADR 62: Scripted is not recorded: every number is labelled, and release needs the recorded run

Date: 2026-11-09

**Context.** Every quality number so far came from fixture replies of the model. Such a number proves the plumbing, the timing and the grader. It says nothing about whether the model's judgement is good, and a reader can easily take one for the other.

**Decision.** (1) Every number in the docs, the README and the reports is labelled **scripted** or **recorded**, and says which set it came from and whether that set was used for tuning. (2) The public repo stays delayed. The release gate needs: the recorded run made by the morning command (ADR 55) passes the ship thresholds of ADR 61, the memory and judgement floors hold, the cost check is within 15 percent, and the owner has rated a real low-risk call with `pnpm tag`. (3) The morning command (`pnpm morning --cap 5`, one page in [MORNING-KIT.md](MORNING-KIT.md)) is the only route to a recorded number. An agent never runs it, and CI refuses it.

**Why.** A reader who sees "recall 85%" should know in one word what kind of 85 it is. A release gate that a fixture can pass is no gate.

**Alternatives.** Let tests call the real model (rejected: cost, flakiness and secrets). Say "preliminary" in one place only (rejected: the label travels badly).

**Consequences.** Scores stay provisional. Moments, context, features and verification cannot go above the mid 80s without the recorded run. The README table says scripted on every row.

## ADR 63: One memory: the call frame is retired

Date: 2026-11-09

**Context.** Wingman had two memories of a call: the Frame (kind, topic, goal, people, checklist, one extra model call a minute) and the SessionMemory (topic, numbers, promises, open questions, roster). Two memories are two sets of bugs and two models of the same call.

**Decision.** SessionMemory is the only memory. The Frame loses its own model call, its own list of kinds and its module-level kind. The kind list lives in `session/types.ts`. The paused-AI and Classic ask paths read the SessionMemory plus a plain local tail of the transcript, not the last 12 lines. After each compaction a local check that every open question, open promise and unhandled objection survived, or was resolved; if one was lost it is kept and logged as `compact.lost`. `claims.ts`, `entities.ts` and `brief.ts` are used only by interview mode and the Classic path and say so in a header.

**Why.** One source of truth for what the call is about. The old second call is also a cost.

**Alternatives.** Keep both and sync them (rejected: this is the bug source).

**Consequences.** Shipped in round 3. The details of the budgets and the compaction check are in ADR 66.

## ADR 64: Modes are visible, lockable and writable by the user

Date: 2026-11-09

**Context.** The kind of call changes how much Wingman says, but it was a hidden guess made after about 20 words, and nobody could correct it or add their own.

**Decision.** (1) The kind is shown, as a guess, wherever the call is shown, and a picker lets the user choose "auto" or a kind. A chosen kind is **locked**: a later guess or a model patch cannot change it. (2) A prepared meeting stores its mode. (3) The control socket has a `mode` command. (4) The user can write up to 6 modes in `modes.yaml` in the pack: an id, a label, up to 600 characters of instructions, and optionally a minimum value and a cards-per-minute number. The text is the user's but is treated as untrusted: escaped, capped, control characters removed. It cannot turn off the guards. A bad entry is skipped.

**Why.** A visible guess can be corrected; a hidden one cannot. A user who runs renewals or demos knows better than any built-in list.

**Alternatives.** A free-form prompt override (rejected: it could weaken the guards). More built-in kinds (rejected: never enough).

**Consequences.** The overlay shows the kind as a read-only pill. The format is in [PACK-FORMAT.md](PACK-FORMAT.md#custom-modes). Shipped in round 3. The pill is read-only in the overlay and a picker is in the dashboard.

## ADR 65: Web lookup is opt-in, with a source and a cap (replaces ADR 36)

Date: 2026-11-09

**Context.** ADR 36 left web lookup out because it needs a search provider, a spend cap and a guard against invented numbers. The URL safety rules for context inputs now exist (https only, private addresses refused, size and time caps).

**Decision (if built).** Lookup is off by default (`lookup.enabled: false`). It is reached by `wingman lookup "<term>"` and an Ask-tab toggle, not by a live card, this round. It reads a page with the same safety rules as context inputs, shows one line, the source address and the sentence it came from, and only text found in the fetched page. The number guard applies. A spend cap per call (`lookup.maxUsdPerCall`) stops it.

**Why.** Wingman should know only what it is told, plus a sourced fact when the user asks. A fact with no source on a live call is a risk.

**Alternatives.** Live lookup cards (next round). Screen context (not this round: it needs a privacy design first).

**Consequences.** Shipped in round 3 (off by default).

## ADR 66: Measured token budgets, name matching and a compaction check (what shipped for ADRs 63 and 64)

Date: 2026-11-08

**Context.** Two memories were alive: the call frame (its own model call, its own kind list, a module-level kind) and the call memory. The question path without a memory loop sent the last 12 lines and no memory. The token estimate was never compared with the provider's count in a way a person could read. The trim order cut the background chunk first, even when the question was about a fact in a loaded file. The compactor could push an open item out of a full list. A garbled name was a new word to the updater.

**Decision.** (1) The frame has no model call; the call memory is the one source, and the kind list is in `session/types.ts`. The paused and legacy question path reads the memory and a size-based tail. (2) `kindLocked`: a kind the user (or a prepared meeting) chose cannot be changed by a patch; `auto` unlocks it. Custom modes from the pack sit on top of a kind and are capped (6 modes, 600 characters, escaped). (3) The report prints input, cache read, cache write, hit share and USD an hour per role; the drift warning is once per role per call; the estimate factors have a calibration module that a script fits from real rows. (4) Trim order: the summary detail first, the best chunk last of the background. (5) A local check after each compaction puts back lost open items. (6) A new word after a speaker change is matched to the roster by edit distance before the updater is asked.

**Why.** One memory cannot disagree with itself. A choice the user made is worth more than a guess. A number that is never compared with reality drifts. Losing an open promise is worse than keeping one item too many. Edit distance is cheap, works in any script and needs no list.

**Alternatives.** Keep the frame as an optional second opinion (two memories again). A model call to match names (cost on every new word). Raise the cache by padding block A (a write cost for text nobody needs). Turn the tail cache on (the simulator shows less than 10 percent for every role, and a loss for some).

**Consequences.** The legacy engine has no call frame and no frame tips. Numbers in the calibration are the old defaults until someone runs `scripts/calibrate-tokens.ts` on real calls; no saving is claimed. The simulated cache is a model of the documented rules, not a bill.
