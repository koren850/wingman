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
| **Text**: transcript lines, the Plan (who, goal, notes, must-cover items), background files you attach, the answer bank text, house style, your profile (name, "about", business), the call frame, client facts matched in the call | **Anthropic** (the Claude model) | During a call (answers, frame, notes, tips, "is this for me" classifier) and after (summary and follow-up email) | AI answers and the summary |
| A tiny test request with your key | Deepgram, Anthropic | When you press Test on a key, or run the Readiness check | Checks the key works |

Nothing else is sent. There is no telemetry, no analytics, no automatic update check and no cloud account. (`wingman update` runs only when you start it, and talks to your git remote.) The window and the answer window load no web content (strict Content-Security-Policy, navigation blocked). If you configure a fallback provider (Soniox, Gladia, or another model vendor), the same data goes to that vendor when it is used.

**Deepgram model improvement.** By default Deepgram may use audio sent to it for its Model Improvement Program, under its own terms. Setting `stt.deepgram.mipOptOut: true` makes Wingman send `mip_opt_out=true` with every connection, which is Deepgram's documented opt-out ([docs](https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program)). The default here is **off**: Deepgram's documentation states no price for opting out, and community reports say that opting out can raise the rate, so Wingman does not change your bill without you choosing it. If call audio is sensitive, turn it on (and check the price with Deepgram).

Read your providers' own data-retention and training policies. Wingman does not control what they do with data they receive.

## What is stored on your Mac

Your data folder is `~/Library/Application Support/Wingman/` (override: `WINGMAN_DATA_DIR`). It is outside the repo. Folders are mode 700, files mode 600.

| What | Where | How long | Protection |
|---|---|---|---|
| Per call: `call.json`, `events.jsonl`, `transcript.jsonl`, `cards.jsonl`, `latency.jsonl`, `usage.jsonl`, `summary.json`, `tags.jsonl` | `<data folder>/calls/<id>/` | Until you delete it. The Readiness check lists calls older than `privacy.retentionDays` (30). | Owner-only file permissions (mode 600, umask 077). **Not encrypted**: use FileVault. |
| **Audio** | Nowhere | Never saved (`privacy.storeAudio` must stay false) | n/a |
| Prepared meetings and their background files | `<data folder>/briefs/` (files in `briefs/attachments/`) | A meeting with a time stays until 6 hours after it; one without a time stays 14 days after its last edit. A meeting a real call used is kept 7 days as a record, and its background files are deleted when it is used. | Mode 600 |
| Client snapshot (optional) | `<data folder>/entities.json` | Until you delete it | Owner-only |
| Your settings | `~/.config/wingman/settings.yaml` | Until you delete it | Mode 600; never contains keys |
| Your profile (name, "about", business, time zone) | `~/.config/wingman/profile.yaml` | Until you delete it | Never in the repo |
| Your pack (answer cards, house style, word lists) | `~/.config/wingman/pack/` | Until you delete it | Never in the repo |
| Menu-bar app log | `<data folder>/calls/tray.log` | Until you delete it | Status lines only, no call content, no keys |
| API keys | macOS Keychain, service `wingman` | Until you remove them | Keychain |

The data folder is also where Electron keeps its own files (cache, local storage). Wingman does not put call content there.

Delete a call: **Stop and delete this call** (asks first), `wingman calls purge <id> --yes`, or `pnpm purge <id> | --older-than N | --all`. Deleting a call folder removes its transcript, cards and summary.

Delete everything: `wingman uninstall --purge` removes the data folder, `~/.config/wingman` and the Keychain keys, after you type `DELETE`. Plain `wingman uninstall` removes only the app and the command link.

**Older versions** kept calls in `stage0/calls/` and meetings in `stage0/data/private/` inside the repo folder. The first start of a newer version **copies** them into the data folder. It never moves or overwrites anything and writes a marker so it runs once. The old folders stay where they were: **delete them yourself** when you are happy with the copy, and check they are not in a backup you share.

Important: the transcript and the summary of a real call can contain personal data and client secrets. Keep them out of backups you do not control and do not share the calls folder or the `qa/` output of real calls.

## API keys

- Stored in the macOS Keychain (service `wingman`). A legacy `~/.config/wingman/keys.env` is still read if present; **Settings -> Keys -> Move to Keychain** (or `pnpm keys migrate`) moves it: each key is written to the Keychain and read back, and only then is its line removed from `keys.env`. No backup copy is made (it would be one more plaintext copy of the key); if the Keychain write fails, `keys.env` is left untouched.
- **What the Keychain does and does not protect.** Items are created through `/usr/bin/security`, so `security` itself is the trusted program in the item's access list. Any other program you run as the same macOS user can run `security find-generic-password -s wingman ...` and read a key **without a prompt** while your login keychain is unlocked. The threat model: this protects against copies of files, backups, synced folders, screenshots and keys leaking into the repo. It does **not** protect against malware or a malicious script that runs as you. Run only code you trust, and set spend limits in the Deepgram and Anthropic consoles.
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
- A fixed list of commands. Starts are rate-limited. Destructive commands need `--yes`.
- Any process running as your macOS user can reach the socket, so treat your user account as the trust boundary. Two things are asked of **you**, in a window in the app, because a script cannot click:
  - **Starting a real call from the command line** (`privacy.askBeforeCliStart`, on by default). Without your click the start is refused. Practice calls never ask.
  - **Stopping and deleting a call** (`wingman stop --delete`). It always asks.
- `wingman plan attach --file` refuses symbolic links, key and `.env` style files, and the folders `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/wingman` and `~/Library/Keychains`. A file outside your home folder needs `--force`.
- Call content is private: the CLI help tells agents not to paste transcripts anywhere but your own terminal.

## The app itself

- The window and the answer window load no web content. They run with a strict Content-Security-Policy (the answer window's script is an external file, with no inline script), navigation is blocked, and the preload bridge exposes only a fixed list of commands.
- The built `Wingman.app` has three Electron fuses turned off: `RunAsNode`, the `NODE_OPTIONS` variable and `--inspect`. So the app cannot be used as a general Node runtime or attached to a debugger from outside.
- Errors are printed as short text, never as the raw error object, because it can contain prompts.
- Text the AI reads (transcript, background, notes) is wrapped in tags. Any tag-like text inside it is stripped until none is left, so a spoken or pasted payload cannot close the wrapper.
- Your profile file is checked on load. A bad file at start gives a clear error. A bad edit during a call keeps the last good profile.

## Git-ignored private folders

These are in `.gitignore` and must never be committed: `stage0/calls/` and `stage0/data/private/` (the old in-repo locations and the optional denylist), `stage0/data/gold/recordings/`, `stage0/qa/out/`, `stage0/qa/cache/`, `stage0/qa/calls/`, `*.env`. Your real data is outside the repo, in the data folder and `~/.config/wingman`. The QA scenarios and the demo call use invented clients only. Before you publish a fork, check `git status` and your history for anything from a real call. A test (the repo guard) can check the tracked files against your own private word list: see [CONTRIBUTING.md](../CONTRIBUTING.md#the-private-word-list-repo-guard).

## The answer window and screen sharing

The answer window has content protection on, which asks macOS to hide it from screen capture. This is untested with Zoom and may not work with every sharing tool. The real protection is the second screen: with one screen, the window refuses to open. Never share the screen that shows it.

## Safety of the answers

- AI text passes through code guards that replace prices, dates, timelines and promises with a stall line. Guards are patterns and can miss a paraphrase. Treat every card as a hint.
- AI cards are labelled "AI · not verified". Prepared cards are the ones you wrote.
- The summary and the follow-up email draft are drafts. Prices, dates and promises become `[להשלים: ...]` placeholders for you to fill in.

## Known gaps

- **Prebuilt audio binary.** System audio comes from the npm package `audiotee` (version pinned in `pnpm-lock.yaml` with a sha512 hash). It contains only a prebuilt universal Mach-O binary, ad-hoc signed, with no source in the package. Upstream source: [github.com/makeusabrew/audiotee](https://github.com/makeusabrew/audiotee). It receives system-audio access, so a compromised release would hear the other side of your calls. A lockfile install gets exactly the pinned file; review the diff before you update it.
- Keys in the Keychain can be read by other programs you run as your user (see API keys above).
- Call files are not encrypted at rest.
- Content protection is untested with real screen-sharing tools.
- Soniox, Gladia and non-Anthropic AI providers are tested with mocks only.
- No code signing or notarisation: the app runs the repo's code. It is only ad hoc signed.

## Reporting a problem

See [../SECURITY.md](../SECURITY.md).
