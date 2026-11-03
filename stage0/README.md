# Wingman app and operator guide (stage0)

This is the detailed guide for the app in `stage0/`. For what Wingman is, requirements and a quick start, read the [root README](../README.md). Design: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md). Decisions: [docs/DECISIONS.md](../docs/DECISIONS.md). Privacy: [docs/PRIVACY-AND-SECURITY.md](../docs/PRIVACY-AND-SECURITY.md). Developing: [docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md). Limits: macOS only, Hebrew first, needs Deepgram and Anthropic keys, costs money per call, and is not a recording or consent tool.

Wingman is a live meeting AI assistant. It listens to a call or meeting (any kind, or just you thinking aloud), answers questions the other side asks, answers questions **you** ask it, and notes, tips and summarises. It is not a sales or marketing tool. The agency answer bank is one knowledge source, used when the call is about web/hosting work.

**Ask Wingman:** press **Ctrl+Opt+A**, then say your question within 10 s; the answer appears in a violet "For you" card. With `assist.answerMe: always` (default) it also answers questions you ask out loud that are clearly for it ("כמה זה 36 ועוד 42?", "מה ההבדל בין CDN ל-DNS?"), and stays quiet when you ask the other person ("מה התקציב שלכם?"). Arithmetic is computed locally, no AI.

Stage 0: a personal tool, terminal or menu-bar launched. The original plan is in [`../docs/history/`](../docs/history/README.md). Audio goes to Deepgram (and text to Anthropic) in the cloud. Call-day checklist: `CALL-DAY.md`.

## Setup (once)
1. Keys: open the Wingman app, **Settings → Keys**, paste each key (write-only box, Save). They are stored in the macOS Keychain (service `wingman`). Or `pnpm keys set deepgram|anthropic` (hidden prompt). If your keys are still in `~/.config/wingman/keys.env`: **Settings → Keys → Move to Keychain** (or `pnpm keys migrate`; makes a mode-600 backup first). Never put keys in this repo.
2. `pnpm install`
3. `pnpm run doctor` (the app calls it "Readiness check") checks keys, mic, system audio, Deepgram and Haiku (incl. prompt cache).
   macOS will ask your terminal app for **Microphone** and **System Audio Recording**. Allow both, then quit and reopen the terminal.
   **Run from Terminal.app.** In iTerm/Warp/IDE terminals add the app by hand under Privacy & Security > Screen & System Audio Recording > System Audio Recording Only.
4. Set `audio.mic.device` (or `WINGMAN_MIC`) if the default mic is wrong (list devices: `ffmpeg -f avfoundation -list_devices true -i ""`, then e.g. `WINGMAN_MIC=":1"`). Avoid AirPods for the first call.

## Commands
| Command | What it does |
|---|---|
| **`pnpm call`** | **Start a call: opens the answer window and starts listening. Ctrl+C stops, saves the call and prints a speed summary** |
| `pnpm tag` | After a call: rate each card y/n (about 2 min). Prints useful cards/hour and how often the bank answered (usefulness gate) |
| `pnpm dashboard` | The Wingman app: menu bar plus a window with Home (start or plan a call, run it, readiness, what is waiting), Calls (calls list with the usefulness gate across live calls, call detail (transcript, cards with useful/not-useful rating written to `tags.jsonl`, side items, speed, cost, events), delete call), Settings (13 plain-words options, Advanced list). Local only, no network |
| `pnpm overlay` | Answer window on the second screen. Content protection is on but **untested with Zoom; use the second screen**. With one display it refuses to open unless `WINGMAN_ALLOW_PRIMARY=1`. Ctrl+Opt+C = clear, Ctrl+Opt+P = pause, Ctrl+Opt+R = last 30 s as text, Ctrl+Opt+K = copy the newest captured phone/email/domain |
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

## Data you own (edit freely)
- `data/bank.yaml` answer cards (drafted by Claude; edit into your own words)
- `data/house-style.md` tone and never-say rules
- `data/keyterms.txt` terms that help Deepgram hear English tech words
- `data/aliases.yaml` (optional) extra spellings per term, e.g. `DNS: ["די אן אס"]`
- `data/gold/SCRIPT.md` the 40 sentences to record for the STT gate

## Each call is saved to `calls/<id>/`
`events.jsonl`, `transcript.jsonl`, `cards.jsonl`, `latency.jsonl` (speech end → bank card / tag / first words), `usage.jsonl` (tokens, STT seconds).
Files are user-only (umask 077). Delete calls you don't need with `pnpm purge`; no encryption yet (interim privacy policy). Env (still work, mapped onto settings): `WINGMAN_ENDPOINT_MS` (= `stt.endpointMs`, default 200; try 700-1000 if questions get split at pauses), `WINGMAN_SHOW_IN_CAPTURE=1` (= `overlay.contentProtection: false`, for the Zoom share test), `WINGMAN_MIC`, `WINGMAN_ALLOW_PRIMARY=1`.

Decision rule: client call only if the gate passes (term recall >= 85% after one alias/keyterm rerun, or the miss is understood and accepted); otherwise self-call with `--no-ai`.

## It works for any kind of call
Wingman does not assume a client call and is not a sales tool. About once a minute a small model writes the **call frame** (kind: client, support, vendor, team, consult, personal or other; topic; goal; people; a checklist of what this kind of call should cover): `src/frame.ts`, settings `frame.*`. The frame feeds the answers, the **live tips** (`src/tips.ts`, settings `tips.*`: at most one small tip per two minutes), the summary (its sections follow the kind) and the answer window / dashboard (header line, `3/6` checklist). On a call that is not with a client, agency bank cards are weak (dimmed, the model may drop them); price / timeline / guarantee stall cards stay. "Plan a call" also takes background files (.txt, .md, pasted text; .pdf when `pdftotext` is installed): `tray/attachments.cjs`. QA for this: `pnpm qa vendor-hosting team-planning consult-accountant personal-casual`.

## Settings and providers

Everything tunable is a setting; providers are swapped by setting, not by editing code.

**Where the files live (lowest to highest priority)**
1. `config/defaults.yaml` built-in defaults. Every key is documented there. Do not edit it for personal changes.
2. `~/.config/wingman/settings.yaml` your personal file. A commented starter is created on first run; uncomment what you want.
3. `profiles/<name>.yaml` used with `--profile <name>` (examples: `first-client-call`, `cheap-test`).
4. Environment variables: `WINGMAN_ENDPOINT_MS`, `WINGMAN_MIC`, `WINGMAN_ALLOW_PRIMARY`, `WINGMAN_SHOW_IN_CAPTURE`, `WINGMAN_STT_PROVIDER`, `WINGMAN_STT_FALLBACK`, `WINGMAN_LLM_MODEL`, `WINGMAN_LLM_FALLBACKS`, `WINGMAN_PROFILE`.
5. CLI flags: `--file`, `--no-ai`, `--discard`, `--quiet`, `--profile`, `--stt`, `--stt-fallback a,b`, `--model`, `--endpoint-ms`, and the generic `--set key=value` (repeatable).

Invalid settings stop the start with the file, the key and the allowed values, exit code 2. `pnpm settings` shows what is in force and where each value came from. API keys are never settings. Load order: process env, then the macOS Keychain (Deepgram, Anthropic), then the legacy `~/.config/wingman/keys.env` (`DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, and optionally `SONIOX_API_KEY`, `GLADIA_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`).

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

**Health bar and degrade ladder.** The overlay shows one persistent bar for the current mode: full -> reduced AI (bank + stall only; AI slow or rate-limited) -> provider switch (running on a fallback) -> bank-only (no usable AI, or `budget.maxUsdPerCall` reached) -> transcript-only (client audio or bank down) -> off. The mode changes only between questions and recovers after `health.recoverStableMs` of calm. Transitions are logged as `ladder` rows; spend per role is logged as `usage` rows with USD, using the editable price table in `budget.prices` (estimates: check your provider's prices).

## Keys (security)
- Storage: macOS Keychain, generic passwords, service `wingman`, accounts `DEEPGRAM_API_KEY` / `ANTHROPIC_API_KEY`. All access goes through `src/keychain.cjs` (wraps `/usr/bin/security`, no shell). Writes use `security -i` with the command on stdin, so a key is never in `ps` output or the environment, and every write is read back and compared.
- Keys live in memory only. They are never written to `calls/`, `tray.log`, events, settings or snapshots. `run.ts` removes key variables from its own environment after loading, and the answer window, ffmpeg and caffeinate are started without them.
- Settings → Keys: write-only password box (cleared on Save), status "Saved in Keychain · …a9F2" / "In file · …a9F2" / "Missing", Test (one tiny authenticated request, answers only ok/invalid/network), Remove (native confirm). The page only ever sees the last 4 characters. IPC: main window only, provider allow-list, format checks, 5 Save/Test per minute.
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

**Practice call.** If a Plan is ready, the practice call uses it (offline and free, the Plan is not used up).

## Answers for you (assist.*)
| Setting | Default | What it does |
|---|---|---|
| `assist.answerMe` | `always` | `always`: a question you ask out loud that is for Wingman gets a "For you" card. `hotkey`: only after Ctrl+Opt+A. `off`: never, except after the key. Settings → Answers → "Answer my own questions". |
| `assist.askWindowMs` | 10000 | After Ctrl+Opt+A the next thing you say within this time is for Wingman, whatever the setting. The overlay shows "Listening for your question…". |
| `assist.themQuietMs`, `minGapMs`, `maxPerMin`, `protectThemMs` | 4 s, 4 s, 6, 15 s | Unsure cases answer only when the other side was silent 4 s (or the call is solo). At most 6 unasked answers a minute, 4 s apart. A "For you" card never lands within 15 s after a card for the other side (an asked-for answer waits instead). |

How it decides (`src/assist.ts`): local cues first (math, "what does X mean", "אתם / שלכם" = the other side, the ask key), then, only if unsure, one tiny Haiku call (ASSIST / OTHER / NEITHER, about $0.0002) with the call frame as context. Arithmetic ("36 ועוד 42", "15% of 200", Hebrew and English number words) is computed locally by `src/calc.ts`: no AI, instant. The same evaluator keeps arithmetic and non-service prices ("כמה עולה דולר") away from the price stall line; real "כמה זה עולה" about services still stalls. Guards: answers for you never contain promises; prices and dates are blocked only when the question is about your own business.

Test it offline: `WINGMAN_CONTROL=1` plus the stdin command `ask` (see `src/me-answers.test.ts`).

**Only you on the line.** When the other side's audio is silent while you talk: a calm line (no call app open: "אני שומע רק אותך…": join the call or play its audio to get answers for the other side; ask me anything with Ctrl+Opt+A) or, when Zoom/Teams/FaceTime/etc. is running, the red NOT HEARING THE OTHER SIDE bar. Either way answers for you keep working; only cards for the other side pause (`WINGMAN_CALL_APP=none|zoom` forces the check in tests).

**Language.** `stt.language: he` is "Hebrew only" (Nova-3 supports Hebrew; steadier on short clips). With `multi`, a final whose letters are mostly not Hebrew/Latin (Telugu, Persian, Arabic...) is dropped and counted (`stt.dropForeignScript`, `foreign.summary` in events.jsonl).
