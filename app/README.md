# Wingman app and operator guide (app)

This is the detailed guide for the app in `app/`. For what Wingman is, requirements and install steps, read the [root README](../README.md). Problems: [TROUBLESHOOTING](../docs/TROUBLESHOOTING.md). Writing your answer cards: [PACK-FORMAT](../docs/PACK-FORMAT.md). Design: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md). Decisions: [docs/DECISIONS.md](../docs/DECISIONS.md). Privacy: [docs/PRIVACY-AND-SECURITY.md](../docs/PRIVACY-AND-SECURITY.md). Developing: [docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md). Limits: macOS only, Hebrew first, needs Deepgram and Anthropic keys, costs money per call, and is not a recording or consent tool.

Wingman is a live call copilot for client, support and team calls. It listens to a call or meeting (any kind, or just you thinking aloud), answers questions the other side asks, answers questions **you** ask it, and notes, tips and summarises. The answer bank (your pack; an example web/hosting pack is included) is one knowledge source, used when the call is about that kind of work.

**Ask Wingman:** press **Ctrl+Opt+A**, then say your question within 10 s; the answer appears in a violet "For you" card. With `assist.answerMe: always` (default) it also answers questions you ask out loud that are clearly for it ("כמה זה 36 ועוד 42?", "מה ההבדל בין CDN ל-DNS?"), and stays quiet when you ask the other person ("מה התקציב שלכם?"). Arithmetic is computed locally, no AI.

Launched from the app or the terminal. Audio goes to Deepgram (and text to Anthropic) in the cloud. Call-day checklist: `CALL-DAY.md`.

## Setup (once)
1. Install with `./install.sh` at the repo root (see the [root README](../README.md#quick-start)). Then open Wingman. The first window is a guided setup: keys, About you, permissions, microphone, screens, pack, readiness check, practice call. You can reopen it from **Settings, Setup guide**.
2. Keys: in the setup, or **Settings, Keys**, paste each key (write-only box, Save). They are stored in the macOS Keychain (service `wingman`). Or `pnpm keys set deepgram|anthropic` (hidden prompt). If your keys are still in `~/.config/wingman/keys.env`: **Settings → Keys → Move to Keychain** (or `pnpm keys migrate`; makes a mode-600 backup first). Never put keys in this repo.
3. Permissions: allow **Microphone** and **System Audio Recording** for Wingman. After you allow System Audio Recording, quit and reopen Wingman: macOS gives no live status for it.
   When you run from a terminal instead of the app, the permission belongs to the terminal. Use Terminal.app. In iTerm/Warp/IDE terminals add the app by hand under Privacy & Security > Screen & System Audio Recording > System Audio Recording Only.
4. `pnpm run doctor` (the app calls it "Readiness check") checks keys, mic, system audio, Deepgram and Haiku (incl. prompt cache).
5. Set `audio.mic.device` (or `WINGMAN_MIC`) if the default mic is wrong (the setup has a microphone picker; or list devices with `ffmpeg -f avfoundation -list_devices true -i ""`, then e.g. `WINGMAN_MIC=":1"`). Avoid AirPods for the first call.

Working on the code without the app? `cd app && WINGMAN_SKIP_APP=1 pnpm install` skips the Electron download.

## Commands
Most people start calls from the app (Home, **Quick call**). `pnpm start` runs the engine alone in a terminal (cards print there; add `pnpm overlay` for the answer window), and `pnpm call` is the terminal launcher that starts the engine and the answer window together. The rest are tools for checks and after-call work.

| Command | What it does |
|---|---|
| **`pnpm call`** | **Start a call: opens the answer window and starts listening. Ctrl+C stops, saves the call and prints a speed summary** |
| `pnpm tag` | After a call: rate each card y/n (about 2 min). Prints useful cards/hour and how often the bank answered (usefulness gate) |
| `pnpm dashboard` | The Wingman app: menu bar plus a window with Home (start or plan a call, run it, readiness, what is waiting), Calls (calls list with the usefulness gate across live calls, call detail (transcript, cards with useful/not-useful rating written to `tags.jsonl`, side items, speed, cost, events), delete call), Settings (25 plain-words options in 6 groups, an Advanced list, About you, Setup guide). Local only, no network |
| `pnpm overlay` | Answer window on the second screen. Content protection is on but **untested with Zoom; use the second screen**. With one display it refuses to open unless `overlay.allowPrimary` (or `WINGMAN_ALLOW_PRIMARY=1`) is on. Ctrl+Opt+C = clear, Ctrl+Opt+P = pause, Ctrl+Opt+R = last 30 s as text, Ctrl+Opt+K = copy the newest captured phone/email/domain |
| `pnpm start` | Live call: system audio = the other side, mic = you. Wear headphones. Listening starts right away (turn on "Ask me before listening starts" in Settings to confirm with `Enter` first). Keys: `q` quiet on/off (cards logged, not shown), `a` ask Wingman (same as Ctrl+Opt+A in the app), Ctrl+C stop. Max ~3 new cards per 60 s |
| `pnpm start --discard` | Delete the call folder when the call ends (without it, Ctrl+C asks) |
| `pnpm purge <id>` / `--older-than N` / `--all` | Delete saved calls (transcripts and cards; audio is never saved) |
| `pnpm banktest` | Bank top-1 accuracy on 40 held-out utterances |
| `pnpm gate --count N` / `--ids t01,t02` / `--no-keyterms` | Score only the sentences you recorded (default all 40); A/B without keyterms |
| `pnpm start --file data/synthetic/call1.wav` | Replay a stereo recording (L = me, R = them) in real time |
| `pnpm start --no-ai` | Prepared cards only, no Haiku |
| `pnpm gate` | Hebrew STT gate on your recordings in `data/gold/recordings/` |
| `pnpm gate data/gold/synthetic.wav` | Dry run of the gate on the Mac's Hebrew voice |
| `pnpm detector` | Question-detector precision/recall on `data/questions.tsv` |
| `pnpm synth` | Rebuild the synthetic test audio (Carmit voice) |
| `pnpm settings` | Prints the effective settings, each value tagged with the layer it came from (never prints keys) |
| `pnpm run doctor` / `--offline` | Tests the configured providers and their fallbacks, settings and the checklist. Ends with READY / NOT READY. `--offline` makes no audio, network or paid calls |
| `pnpm test` | Unit tests |

## Your profile and pack
Your name, spellings, how to address you, your business and your time zone (an IANA name such as `Asia/Jerusalem`; empty means this Mac's zone) are in `~/.config/wingman/profile.yaml`. Set them in **Settings, About you** or with `wingman profile set ...`. A bad file keeps the last good profile during a call.

Your answer bank, house style, keyterms and topic words are a pack in `~/.config/wingman/pack/` (or the folder in `WINGMAN_PACK_DIR`). Without one, the example pack below is used, file by file. The Readiness check lists any file that fell back. Formats: [PACK-FORMAT](../docs/PACK-FORMAT.md). Nothing personal belongs in this repo.

Naming: the **profile** is `profile.yaml` (you). A **settings preset** is a file in `profiles/<name>.yaml`, used with `--profile <name>` (a bundle of setting overrides). They are different things.

## Example pack files (copy into your pack and edit)
- `data/example-pack/bank.yaml` answer cards (an invented web/hosting example; write your own)
- `data/example-pack/house-style.md` tone and never-say rules
- `data/example-pack/keyterms.txt` terms that help Deepgram hear English tech words
- `data/example-pack/topics.txt` words that mean "this call is about my own work"
- `data/example-pack/bank.en.yaml` English versions of the cards
- `data/aliases.yaml` (optional, read by `pnpm gate`) extra spellings per term, e.g. `DNS: ["די אן אס"]`
- `data/gold/SCRIPT.md` the 40 sentences to record for the STT gate

## Each call is saved to `<data folder>/calls/<id>/`
The data folder is `~/Library/Application Support/Wingman` (override: `WINGMAN_DATA_DIR`; only the calls folder: `WINGMAN_CALLS_DIR`; only the prepared meetings: `WINGMAN_BRIEFS_DIR`). Inside: `calls/`, `briefs/` (with `briefs/attachments/`) and `entities.json`. Settings, keys, profile and pack stay in `~/.config/wingman`. The data folder is also where Electron keeps its own files (cache, local storage), so extra entries there are normal. Older versions kept calls in `app/calls` and meetings in `app/data/private`: the first start copies them over (never moves, never overwrites). Delete the old folders yourself once the new ones look right.

`events.jsonl`, `transcript.jsonl`, `cards.jsonl`, `latency.jsonl` (speech end → bank card / tag / first words), `usage.jsonl` (tokens, STT seconds).
Files are user-only (umask 077). Delete calls you don't need with `pnpm purge`; no encryption yet (interim privacy policy). Env (still work, mapped onto settings): `WINGMAN_ENDPOINT_MS` (= `stt.endpointMs`, default 200; try 700-1000 if questions get split at pauses), `WINGMAN_SHOW_IN_CAPTURE=1` (= `overlay.contentProtection: false`, for the Zoom share test), `WINGMAN_MIC`, `WINGMAN_ALLOW_PRIMARY=1`.

Decision rule: client call only if the gate passes (term recall >= 85% after one alias/keyterm rerun, or the miss is understood and accepted); otherwise self-call with `--no-ai`.

## It works for any kind of call
Wingman does not assume a client call: it works for any kind of call. About once a minute a small model writes the **call frame** (kind: client, support, vendor, team, consult, personal or other; topic; goal; people; a checklist of what this kind of call should cover): `src/frame.ts`, settings `frame.*`. The frame feeds the answers, the **live tips** (`src/tips.ts`, settings `tips.*`: at most one small tip per two minutes), the summary (its sections follow the kind) and the answer window / dashboard (header line, `3/6` checklist). On a call that is not with a client, bank cards are weak (dimmed, the model may drop them); price / timeline / guarantee stall cards stay. A prepared meeting (the "Plan") also takes background files (.txt, .md, pasted text; .pdf when `pdftotext` is installed): `tray/attachments.cjs`. QA for this: `pnpm qa vendor-hosting team-planning consult-accountant personal-casual`.

## Several speakers and flow mode
**Several people on the other side.** With `stt.speakers` on (the default), the other side's voices are told apart ("Speaker 1", 2... or names taken from introductions and from the meeting's attendees). A name is only taken from an introduction when it matches an attendee or is a short intro line ("this is Zoom" does not name a voice). Rename a voice on the dashboard or with `wingman speaker <n> "<name>"` (`--clear` removes it). A rename also relabels the earlier lines, for the AI and the summary. Names live only for the call.

**Flow mode** (`flow.*`, `src/flow.ts`).
- When two or more of them talk among themselves while you are quiet (at least 3 lines in 30 s, you quiet for 20 s), a muted "talking among themselves" line shows who and what about (`flow.topic`, one small AI line every 45 s at most).
- While they do, answer cards wait (`flow.holdCards`). Price and date cards, and questions that use your name, still show.
- When someone says your name, or says "you" right after their own discussion, an orange "turned to you" alert shows who.
- Turn it all off with `flow.enabled: false`.

## Practice and prep mode (kind `interview`)
A prepared meeting of kind `interview` is for rehearsal: practice runs, prepared answers from your own notes, and a review after the call. It is not for live help in a real interview. Real interviews and exams that forbid outside help are out of scope; check the rules first ([ADR 35](../docs/DECISIONS.md#adr-35-scope-no-real-job-interviews-or-exams)).

```bash
wingman plan new --kind interview --title "Practice round" --who "Dan, Acme"
wingman plan attach --id <id> --file ~/notes/my-prep.md
wingman plan set --id <id> --add-note "Prepared cards: /full/path/my-cards.yaml"
wingman start --plan <id>
```

What changes (`src/brief.ts`, `src/run.ts`, `src/guards.ts`):
- **Facts come from your background files.** The AI never invents experience.
- **Every question gets an answer.** No card limit and no "Important cards only" filter.
- **No "Buy time" lines.** A stall never replaces an answer.
- **Salary-only guard.** In this mode the guards block only a salary figure (a number with a salary word). Dates, rates, token costs and your own numbers are content and pass. A salary answer must come from your own prepared card.
- **Your own cards.** The note `Prepared cards: <file.yaml>` points to a file in the answer bank format. For that call it replaces the normal bank. Each meeting can have its own file. If the note is missing, the call has no prepared cards and the AI answers from your notes. See [PACK-FORMAT](../docs/PACK-FORMAT.md#cards-for-a-practice-meeting).
- **No fact cards** about the user's own clients and servers, and **no self-check cards** (a misheard name must not become a red card mid-answer).
- Live tips follow the normal `tips.*` settings. Turn them off in Settings if you want a quieter screen.

## Settings and providers

Everything tunable is a setting; providers are swapped by setting, not by editing code.

**Where the files live (lowest to highest priority)**
1. `config/defaults.yaml` built-in defaults. Every key is documented there. Do not edit it for personal changes.
2. `~/.config/wingman/settings.yaml` your personal file (`WINGMAN_USER_SETTINGS` points elsewhere). A commented starter is created on first run; uncomment what you want.
3. `profiles/<name>.yaml`, a **settings preset**, used with `--profile <name>` (examples: `first-client-call`, `cheap-test`). Not the same as your `profile.yaml`.
4. Environment variables: `WINGMAN_ENDPOINT_MS`, `WINGMAN_MIC`, `WINGMAN_ALLOW_PRIMARY`, `WINGMAN_SHOW_IN_CAPTURE`, `WINGMAN_STT_PROVIDER`, `WINGMAN_STT_FALLBACK`, `WINGMAN_LLM_MODEL`, `WINGMAN_LLM_FALLBACKS`, `WINGMAN_PROFILE` (the settings preset).
5. CLI flags: `--file`, `--no-ai`, `--discard`, `--quiet`, `--profile`, `--stt`, `--stt-fallback a,b`, `--model`, `--endpoint-ms`, and the generic `--set key=value` (repeatable).

Invalid settings stop the start with the file, the key and the allowed values, exit code 2. `pnpm settings` shows what is in force and where each value came from. API keys are never settings. Other environment variables: `WINGMAN_DATA_DIR`, `WINGMAN_CALLS_DIR`, `WINGMAN_BRIEFS_DIR` (where your data lives), `WINGMAN_PACK_DIR` (your pack), `WINGMAN_PROFILE_FILE` (your profile file), `WINGMAN_APPS_DIR` and `WINGMAN_BIN_DIR` (where `install.sh` puts the app and the `wingman` link; defaults `/Applications` and `~/.local/bin`), `WINGMAN_SKIP_APP=1` (install without Electron and the app: CI and tests). Keys load in this order: process env, then the macOS Keychain (Deepgram, Anthropic), then the legacy `~/.config/wingman/keys.env` (`DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, and optionally `SONIOX_API_KEY`, `GLADIA_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`).

**The Settings page.** The app's Settings page has these 25 options. Everything else is in the Advanced list (read-only) or in `~/.config/wingman/settings.yaml`. `config/defaults.yaml` documents all 139 values. Two are shown inverted in the app: "Use the AI at all" is the opposite of `run.noAi`, and "Show answer window in screen share" is the opposite of `overlay.contentProtection`.

**Call**

| Label in the app | Setting | Default |
|---|---|---|
| Language the call is heard in | `stt.language` | multi |
| Ask me before listening starts | `privacy.requireConsentAck` | off |
| Ask before a call started from the command line starts listening | `privacy.askBeforeCliStart` | on |
| Stop by itself after silence | `budget.idleStopMin` | 15 minutes |
| Important cards only | `cards.focus` | on |
| Warn me when I commit to a price, date or promise | `selfCheck.careful` | on |
| Correct me when I contradict the meeting background | `selfCheck.fix` | on |

**Answers**

| Label in the app | Setting | Default |
|---|---|---|
| AI answers to my own questions | `assist.answerMe` | always |
| Use the AI at all | `run.noAi` | on |
| AI answers to the other side's questions | `reflex.allowAns` | on |
| Start every call in quiet mode | `cards.quiet` | off |
| Work out what the call is about | `frame.enabled` | on |
| Live tips | `tips.enabled` | on |
| Tell me when I talk too much | `tips.talkRatio` | on |

**After the call**

| Label in the app | Setting | Default |
|---|---|---|
| Write a summary when the call ends | `summary.enabled` | on |

**Money**

| Label in the app | Setting | Default |
|---|---|---|
| Spend cap per call | `budget.maxUsdPerCall` | 2 USD |

**Audio and screens**

| Label in the app | Setting | Default |
|---|---|---|
| Warn me about AirPods and Bluetooth | `audio.warnBluetooth` | on |
| Answer window goes to | `overlay.display` | secondary |
| Show what the other side just said | `overlay.showLastLine` | on |
| Size of the live text | `overlay.liveTextPt` | 22 pt |
| Show answer window in screen share | `overlay.contentProtection` | off |

**Fine-tuning**

| Label in the app | Setting | Default |
|---|---|---|
| Wait before a “Buy time” line | `reflex.stallAfterMs` | 1.8 seconds |
| How often to re-check the call | `frame.everyMs` | 60 seconds |
| Time between tips, at least | `tips.minGapMs` | 120 seconds |
| Background text the AI may read | `attachments.maxChars` | 40000 characters |


Notes on a few of them:
- `cards.focus` ("Important cards only"): a card only for a clear question to you (a question mark, a direct request, your name), at most 2 every 2 minutes. Price and date cards and the cards about what you said always show. Off: every likely question gets a card, up to `cards.maxPerMinute` (3). Interview mode ignores the limit.
- `privacy.askBeforeCliStart`: a call started with `wingman start` first asks you in a window in the app. Without your click the start is refused (exit 4). Practice calls never ask. Stopping a call with `--delete` always asks.
- `privacy.requireConsentAck`: the call waits for **Start listening** before any audio is sent.
- `overlay.allowPrimary`: lets the answer window open on the only screen. Never share that screen.
- `system.sleepGapMs` (5000): a gap longer than this between health ticks means the Mac slept. Wingman shows a warning, restarts the audio and reopens the speech connection. 0 turns the check off.
- `flow.*`: see Flow mode above. `selfCheck.*`: cards about what you said.

**Switch the speech-to-text provider**
```yaml
# ~/.config/wingman/settings.yaml
stt:
  provider: deepgram
  fallback: [soniox]        # used mid-call if Deepgram rejects the key, runs out of credit, or keeps failing
```
One-off: `pnpm call --stt soniox` or `WINGMAN_STT_PROVIDER=gladia pnpm call`. Soniox and Gladia are **experimental**: written from their public real-time docs and tested only against a local mock server. Run `pnpm gate` with the provider before trusting its Hebrew. When a channel switches provider, the overlay shows an amber bar and `events.jsonl` gets a `stt.switch` row.

**Switch the AI model**
```yaml
llm:
  reflex:
    model: "anthropic:claude-haiku-5-5"
    fallbacks: ["openai:gpt-5-mini"]     # tried when the first model has an auth/quota/rate/overload/network error
```
Model strings are `provider:model`. Only Anthropic is installed. For others run `pnpm add @ai-sdk/openai` (or `@ai-sdk/google`, `@ai-sdk/mistral`, `@ai-sdk/groq`) and add the key to `keys.env`; if the package is missing Wingman says exactly which command to run. Prompt caching, effort and thinking options are sent only to Anthropic models. A fallback is never tried after the answer has started, and never after a timeout. Measure the Hebrew quality of any fallback model before relying on it. Check the whole setup with `pnpm run doctor`.

**Audio**: `audio.system.source: audiotee | device | off`. `device` captures an avfoundation input through ffmpeg, for example BlackHole (`audio.system.device: "BlackHole 2ch"`). `audio.mic.device: ":1"` picks the mic (list with `ffmpeg -f avfoundation -list_devices true -i ""`).

**Cautious first call**: `pnpm call --profile first-client-call` (Prepared + Buy time cards only, 2 new cards a minute).

**Health bar and degrade ladder.** The answer window shows one persistent bar for the current mode: full -> reduced AI (bank + stall only; AI slow or rate-limited) -> provider switch (running on a fallback) -> bank-only (no usable AI, or `budget.maxUsdPerCall` reached) -> transcript-only (the other side's speech to text is down on every provider: it keeps retrying slowly, and your own questions still work) -> off (only when you stop the call). The mode changes only between questions and recovers after `health.recoverStableMs` of calm. A failed handler or a stray error is logged as `error.survived` and the call goes on; only repeated errors end it. Audio sources restart by themselves (a vanished mic falls back to the default mic), the call recovers after sleep, and a bar warns when the disk is under 500 MB (amber) or 100 MB (red). Transitions are logged as `ladder` rows; spend per role is logged as `usage` rows with USD, using the editable price table in `budget.prices` (estimates: check your provider's prices).

## Keys (security)
- Storage: macOS Keychain, generic passwords, service `wingman`, accounts `DEEPGRAM_API_KEY` / `ANTHROPIC_API_KEY`. All access goes through `src/keychain.cjs` (wraps `/usr/bin/security`, no shell). Writes use `security -i` with the command on stdin, so a key is never in `ps` output or the environment, and every write is read back and compared.
- Keys live in memory only. They are never written to `calls/`, `tray.log`, events, settings or snapshots. `run.ts` removes key variables from its own environment after loading, and the answer window, ffmpeg and caffeinate are started without them.
- Settings, Keys: write-only password box (cleared on Save), status "Saved in Keychain · …a9F2" / "In file · …a9F2" / "Missing", Test (one tiny authenticated request, answers only ok/invalid/network), Remove (native confirm). The page only ever sees the last 4 characters. IPC: main window only, provider allow-list, format checks, 5 Save/Test per minute.
- `pnpm keys status|set <provider>|remove <provider>|migrate`. `pnpm run doctor` shows source (Keychain/file/environment) and last 4 only.
- Migration (`pnpm keys migrate` or the Settings button, never automatic): backup `keys.env.bak-<date>` (600), write + verify each key in the Keychain, then remove that line from keys.env (atomic, 600). Delete the backup once calls work.
- Tests use a mocked `security` runner and fake keys (`src/keys.test.ts`); the real runner refuses to run under the test runner.

## Keys, stopping and quitting (menu-bar app)

| Key | What it does |
|---|---|
| Ctrl+Opt+A | Ask Wingman: your next sentence is a question for it. The menu shows "Listening for your question…" until it is taken or times out. |
| Ctrl+Opt+N | Add a note for the AI. |
| Ctrl+Opt+Return | Start listening. Registered only while a call is waiting ("Ask me before listening starts" on). |
| Ctrl+Opt+C / P / R / K / L | Answer window: clear, pause, rewind, copy newest capture, checklist. |
| Ctrl+Opt+1 / 2 / 3 | Answer window: copy capture chip 1, 2 or 3 (phone, email, domain). The menu-bar app never takes these. |

**Stopping.** Stop call saves the call and writes the summary in steps (saving, summary, done); `wingman status` shows the step while it runs. "Stop and delete this call…" asks first (Cancel is the default). **Quit Wingman** during a call asks too; if you confirm it stops and saves the call first (up to 20 s), then closes.

**Quick call and prepared meetings.** Home has two ways to start. **Quick call** starts right now with no Plan and never touches a prepared meeting. **Prepared meetings** is a list of Plans you wrote for specific calls (who, kind, topic, goal, notes, must-cover checklist, background files, an optional title and an optional date and time); pick one and press Start. The soonest one is highlighted ("Next: Dana at 14:30"). A meeting with a time stays until about 6 hours after it; one without a time stays 14 days; a real call started with it uses it up. The menu bar has Start quick call and a Start prepared meeting submenu. CLI: `wingman start --quick`, `wingman start --plan <id>`, `wingman plan list | new | set --id <id> | attach --id <id> | delete <id> --yes`. Plain `wingman start` picks a Plan only when exactly one meeting is scheduled within 30 minutes of now (no prepared meetings at all means a quick call; anything else is refused with the list). A Plan saved by an earlier version becomes one prepared meeting automatically.

**Practice call.** The practice call uses the next prepared meeting (or the only one) and says so on the button; the meeting is not used up. A practice with none (`wingman start --practice --quick`) is a plain practice.

## Answers for you (assist.*)
| Setting | Default | What it does |
|---|---|---|
| `assist.answerMe` | `always` | `always`: a question you ask out loud that is for Wingman gets a "For you" card. `hotkey`: only after Ctrl+Opt+A. `off`: never, except after the key. Settings → Answers → "Answer my own questions". |
| `assist.askWindowMs` | 10000 | After Ctrl+Opt+A the next thing you say within this time is for Wingman, whatever the setting. The answer window shows "Listening for your question…". |
| `assist.themQuietMs`, `minGapMs`, `maxPerMin`, `protectThemMs` | 4 s, 4 s, 6, 5 s | Unsure cases answer only when the other side was silent 4 s (or the call is solo). At most 6 unasked answers a minute, 4 s apart. A "For you" card never lands within 5 s after a card for the other side (an asked-for answer waits instead). |

How it decides (`src/assist.ts`): local cues first (math, "what does X mean", "אתם / שלכם" = the other side, the ask key), then, only if unsure, one tiny Haiku call (ASSIST / OTHER / NEITHER, about $0.0002) with the call frame as context. Arithmetic ("36 ועוד 42", "15% of 200", Hebrew and English number words) is computed locally by `src/calc.ts`: no AI, instant. The same evaluator keeps arithmetic and non-service prices ("כמה עולה דולר") away from the price stall line; real "כמה זה עולה" about services still stalls. Guards: answers for you never contain promises; prices and dates are blocked only when the question is about your own business.

Test it offline: `WINGMAN_CONTROL=1` plus the stdin command `ask` (see `src/e2e/me-answers.test.ts`).

**Only you on the line.** When the other side's audio is silent while you talk: a calm line (no call app open: "אני שומע רק אותך…": join the call or play its audio to get answers for the other side; ask me anything with Ctrl+Opt+A) or, when Zoom/Teams/FaceTime/etc. is running, the red NOT HEARING THE OTHER SIDE bar. Either way answers for you keep working; only cards for the other side pause (`WINGMAN_CALL_APP=none|zoom` forces the check in tests).

**Language.** `stt.language: he` is "Hebrew only" (Nova-3 supports Hebrew; steadier on short clips). With `multi`, a final whose letters are mostly not Hebrew/Latin (Telugu, Persian, Arabic...) is dropped and counted (`stt.dropForeignScript`, `foreign.summary` in events.jsonl).
