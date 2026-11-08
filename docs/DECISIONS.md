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
