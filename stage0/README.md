# Wingman Stage 0 (dogfood tool)

Rough, terminal-launched. See `../STRUCTURE.md` §13 Stage 0. Use only on synthetic, self, friend or consented calls: Stage 0 live calls are for consented parties only. Audio goes to Deepgram (and text to Anthropic) in the cloud. Call-day checklist: `CALL-DAY.md`.

## Setup (once)
1. Keys: fill in `~/.config/wingman/keys.env` (DEEPGRAM_API_KEY, ANTHROPIC_API_KEY). Never put keys in this repo.
2. `pnpm install`
3. `pnpm run doctor` checks keys, mic, system audio, Deepgram and Haiku (incl. prompt cache).
   macOS will ask your terminal app for **Microphone** and **System Audio Recording**. Allow both, then quit and reopen the terminal.
   **Run from Terminal.app.** In iTerm/Warp/IDE terminals add the app by hand under Privacy & Security > Screen & System Audio Recording > System Audio Recording Only.
4. Set `audio.mic.device` (or `WINGMAN_MIC`) if the default mic is wrong (list devices: `ffmpeg -f avfoundation -list_devices true -i ""`, then e.g. `WINGMAN_MIC=":1"`). Avoid AirPods for the first call.

## Commands
| Command | What it does |
|---|---|
| **`pnpm call`** | **Start a call: opens the answer window and starts listening. Ctrl+C stops, saves the call and prints a speed summary** |
| `pnpm tag` | After a call: rate each card y/n (about 2 min). Prints useful cards/hour and how often the bank answered (usefulness gate) |
| `pnpm dashboard` | Review window: calls list with the usefulness gate across live calls, call detail (transcript, cards with useful/not-useful rating written to `tags.jsonl`, side items, speed, cost, events), delete call, settings and offline doctor. Local only, no network |
| `pnpm overlay` | Answer window on the second screen. Content protection is on but **untested with Zoom; use the second screen**. With one display it refuses to open unless `WINGMAN_ALLOW_PRIMARY=1`. Ctrl+Opt+C = clear, Ctrl+Opt+P = pause, Ctrl+Opt+R = last 30 s as text, Ctrl+Opt+K = copy the newest captured phone/email/domain |
| `pnpm start` | Live call: system audio = client, mic = you. Wear headphones. **Nothing is sent to the cloud until you press Enter (consent confirmed).** Keys: `Enter` start, `q` quiet on/off (cards logged, not shown), Ctrl+C stop. Max ~3 new cards per 60 s |
| `pnpm start --discard` | Delete the call folder when the call ends (without it, Ctrl+C asks) |
| `pnpm purge <id>` / `--older-than N` / `--all` | Delete saved calls (transcripts and cards; audio is never saved) |
| `pnpm banktest` | Bank top-1 accuracy on 40 held-out utterances |
| `pnpm gate --count N` / `--ids t01,t02` / `--no-keyterms` | Score only the sentences you recorded (default all 40); A/B without keyterms |
| `pnpm start --file data/synthetic/call1.wav` | Replay a stereo recording (L = me, R = them) in real time |
| `pnpm start --no-ai` | Answer bank only, no Haiku |
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
Files are user-only (umask 077). Delete calls you don't need with `pnpm purge`; no encryption yet (interim privacy policy). Env (still work, mapped onto settings): `WINGMAN_ENDPOINT_MS` (= `stt.endpointMs`, default 350; try 700-1000 if questions get split at pauses), `WINGMAN_SHOW_IN_CAPTURE=1` (= `overlay.contentProtection: false`, for the Zoom share test), `WINGMAN_MIC`, `WINGMAN_ALLOW_PRIMARY=1`.

Decision rule: client call only if the gate passes (term recall >= 85% after one alias/keyterm rerun, or the miss is understood and accepted); otherwise self-call with `--no-ai`.

## Settings and providers

Everything tunable is a setting; providers are swapped by setting, not by editing code.

**Where the files live (lowest to highest priority)**
1. `config/defaults.yaml` built-in defaults. Every key is documented there. Do not edit it for personal changes.
2. `~/.config/wingman/settings.yaml` your personal file. A commented starter is created on first run; uncomment what you want.
3. `profiles/<name>.yaml` used with `--profile <name>` (examples: `first-client-call`, `cheap-test`).
4. Environment variables: `WINGMAN_ENDPOINT_MS`, `WINGMAN_MIC`, `WINGMAN_ALLOW_PRIMARY`, `WINGMAN_SHOW_IN_CAPTURE`, `WINGMAN_STT_PROVIDER`, `WINGMAN_STT_FALLBACK`, `WINGMAN_LLM_MODEL`, `WINGMAN_LLM_FALLBACKS`, `WINGMAN_PROFILE`.
5. CLI flags: `--file`, `--no-ai`, `--discard`, `--quiet`, `--profile`, `--stt`, `--stt-fallback a,b`, `--model`, `--endpoint-ms`, and the generic `--set key=value` (repeatable).

Invalid settings stop the start with the file, the key and the allowed values, exit code 2. `pnpm settings` shows what is in force and where each value came from. API keys are never settings: they stay in `~/.config/wingman/keys.env` (`DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, and optionally `SONIOX_API_KEY`, `GLADIA_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`).

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

**Cautious first call**: `pnpm call --profile first-client-call` (bank + stall lines only, 2 new cards a minute).

**Health bar and degrade ladder.** The overlay shows one persistent bar for the current mode: full -> reduced AI (bank + stall only; AI slow or rate-limited) -> provider switch (running on a fallback) -> bank-only (no usable AI, or `budget.maxUsdPerCall` reached) -> transcript-only (client audio or bank down) -> off. The mode changes only between questions and recovers after `health.recoverStableMs` of calm. Transitions are logged as `ladder` rows; spend per role is logged as `usage` rows with USD, using the editable price table in `budget.prices` (estimates: check your provider's prices).
