# Privacy and security

Wingman listens to calls. Read this before you use it on one.

## Your responsibility

- **Tell the people on your call** that a transcription and AI tool is running, if the law or good manners require it. Recording, transcription and cloud processing of calls are regulated differently in different countries and states, and some require consent from everyone on the call.
- Wingman is **not a recording or consent tool** and gives no legal advice. By default it starts listening as soon as you start a call and it does not ask for consent. If you want a pause first, turn on Settings -> "Ask me before listening starts": then nothing is sent to the cloud until you press **Start listening**.
- Do not use it where hidden AI help is not allowed, such as job interviews or exams.
- Do not use it on calls covered by an NDA or a client policy that forbids cloud processing.

## What leaves your Mac

| Data | Goes to | When | Why |
|---|---|---|---|
| **Audio** of both channels (your microphone and the system audio, 16 kHz) | **Deepgram** (speech to text) | While a call is listening | Transcription. Also sent during the full Readiness check (a short test tone or silence) and the STT gate. |
| **Text**: transcript lines, the Plan (who, goal, notes, must-cover items), background files you attach, the answer bank text, house style, the call frame, client facts matched in the call | **Anthropic** (the Claude model) | During a call (answers, frame, notes, tips, "is this for me" classifier) and after (summary and follow-up email) | AI answers and the summary |
| A tiny test request with your key | Deepgram, Anthropic | When you press Test on a key, or run the Readiness check | Checks the key works |

Nothing else is sent. There is no telemetry, no analytics, no update check and no cloud account. The window and the answer window load no web content (strict Content-Security-Policy, navigation blocked). If you configure a fallback provider (Soniox, Gladia, or another model vendor), the same data goes to that vendor when it is used.

Read your providers' own data-retention and training policies. Wingman does not control what they do with data they receive.

## What is stored on your Mac

| What | Where | How long | Protection |
|---|---|---|---|
| Per call: `call.json`, `events.jsonl`, `transcript.jsonl`, `cards.jsonl`, `latency.jsonl`, `usage.jsonl`, `summary.json`, `tags.jsonl` | `stage0/calls/<id>/` | Until you delete it. The Readiness check lists calls older than `privacy.retentionDays` (30). | Owner-only file permissions (mode 600, umask 077). **Not encrypted**: use FileVault. |
| **Audio** | Nowhere | Never saved (`privacy.storeAudio` must stay false) | n/a |
| Plan and attached background files | `stage0/data/private/briefs/` | A Plan expires after 6 hours and is used for one call; attachments are deleted when the call reads them | Mode 600 |
| Client snapshot (optional) | `stage0/data/private/entities.json` | Until you delete it | Git-ignored |
| Your settings | `~/.config/wingman/settings.yaml` | Until you delete it | Mode 600; never contains keys |
| Menu-bar app log | `stage0/calls/tray.log` | Until you delete it | Status lines only, no call content, no keys |
| API keys | macOS Keychain, service `wingman` | Until you remove them | Keychain |

Delete a call: **Stop and delete this call** (asks first), `wingman calls purge <id> --yes`, or `pnpm purge <id> | --older-than N | --all`. Deleting a call folder removes its transcript, cards and summary.

Important: the transcript and the summary of a real call can contain personal data and client secrets. Keep them out of backups you do not control and do not share the `calls/` folder or the `qa/` output of real calls.

## API keys

- Stored in the macOS Keychain (service `wingman`). A legacy `~/.config/wingman/keys.env` is still read if present; **Settings -> Keys -> Move to Keychain** (or `pnpm keys migrate`) moves it, after making a mode-600 backup. Delete that backup when calls work.
- All Keychain access goes through one module that runs `/usr/bin/security` without a shell. Keys are written through stdin, so they never show in the process list or the environment, and each write is read back.
- Keys are held in memory only. They are never written to call folders, logs, settings, events or snapshots. The engine removes key variables from its own environment after loading and starts the answer window, ffmpeg and caffeinate without them.
- The window only ever receives the last 4 characters of a key. The key box is write-only. The main window is the only one allowed to use the key IPC, with a provider allow-list, format checks and a rate limit (5 Save or Test per minute).
- The CLI can report "present or missing" only. It cannot read, set or move keys.
- Never put keys in this repo or paste them into a chat. A `.gitignore` rule blocks `*.env`.
- Set spend limits in the Deepgram and Anthropic consoles.

## The control socket

The menu-bar app listens on `~/.config/wingman/run/control.sock`.

- Directory mode 700, socket mode 600, and the owner is checked at start.
- A Unix socket: no network listener, nothing reachable from other machines.
- A fixed list of commands. Start and stop are rate-limited. Destructive commands need `--yes`.
- Any process running as your macOS user can use it, so treat your user account as the trust boundary. Do not run untrusted code as your user.
- Call content is private: the CLI help tells agents not to paste transcripts anywhere but your own terminal.

## Git-ignored private folders

These are in `.gitignore` and must never be committed: `stage0/calls/`, `stage0/data/private/`, `stage0/data/gold/recordings/`, `stage0/qa/out/`, `stage0/qa/cache/`, `stage0/qa/calls/`, `*.env`. The QA scenarios and the demo call use invented clients only. Before you publish a fork, check `git status` and your history for anything from a real call.

## The answer window and screen sharing

The answer window has content protection on, which asks macOS to hide it from screen capture. This is untested with Zoom and may not work with every sharing tool. The real protection is the second screen: with one screen, the window refuses to open. Never share the screen that shows it.

## Safety of the answers

- AI text passes through code guards that replace prices, dates, timelines and promises with a stall line. Guards are patterns and can miss a paraphrase. Treat every card as a hint.
- AI cards are labelled "AI · not verified". Prepared cards are the ones you wrote.
- The summary and the follow-up email draft are drafts. Prices, dates and promises become `[להשלים: ...]` placeholders for you to fill in.

## Known gaps

- Call files are not encrypted at rest.
- Content protection is untested with real screen-sharing tools.
- Soniox, Gladia and non-Anthropic AI providers are tested with mocks only.
- No code signing or notarisation: the app runs the repo's code.

## Reporting a problem

See [../SECURITY.md](../SECURITY.md).
