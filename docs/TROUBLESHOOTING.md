# Troubleshooting

Find your problem, then follow the steps. Run `./install.sh --check` any time to see what is present and what is missing. It changes nothing.

## No sound from the other side

Signs: a red bar "NOT HEARING THE OTHER SIDE" (when Zoom, Teams or a similar app is open), or a calm line "I only hear you" (when no call app is open).

1. Is the other side's audio playing on this Mac? Wingman records what the Mac plays. If the call plays on another device, there is nothing to hear.
2. Check System Audio Recording permission (next section).
3. Run the Readiness check (**Home, Run readiness check**). It tests the system audio.
4. If you only wanted to test alone, the calm line is fine. Ask Wingman anything with Ctrl+Opt+A.

## System Audio Recording permission

macOS has **no live status** for this permission, so Wingman cannot tell you if it is on.

1. Open **System Settings, Privacy & Security, Screen & System Audio Recording**.
2. Scroll to **System Audio Recording Only** and switch Wingman on. If you run from a terminal, switch the terminal app on instead.
3. **Quit and reopen Wingman.** macOS only applies the permission to a new start.
4. Run the Readiness check again.

Terminal tip: use Terminal.app. If you use iTerm, Warp or an editor terminal, add that app by hand with the plus button.

To start over, remove Wingman from the list with the minus button and add it again.

## Microphone permission

1. Open **System Settings, Privacy & Security, Microphone**.
2. Switch Wingman on (or your terminal app, if you run from a terminal).
3. Quit and reopen Wingman.

Still stuck? Reset the answer and let macOS ask again:

```bash
tccutil reset Microphone com.wingman.app
```

Then open Wingman and allow the question.

## The microphone is quiet or silent

Signs: a bar "MIC SILENT" ten seconds after listening starts, or the wrong mic is picked.

1. Open **Settings, Setup guide, Microphone** and choose the right one.
2. List the devices: `ffmpeg -f avfoundation -list_devices true -i ""`. Then set `audio.mic.device` (for example `":1"`), or run with `WINGMAN_MIC=":1"`.
3. Avoid AirPods and other Bluetooth headsets. They drop to phone quality when the mic is in use. Wingman warns you. Use the built-in mic or wired headphones.
4. If the device disappears during a call (headphones switched off), Wingman restarts that audio source by itself and falls back to the default mic after a couple of tries. A red or amber bar shows while it recovers.

## The Electron download failed

The install stops with "could not download the Electron runtime". The cause is almost always the network or a proxy.

```bash
cd stage0
node node_modules/electron/install.js
pnpm run make-app
```

Or run `./install.sh` again. It is safe to repeat.

## The app says the folder moved

Wingman.app remembers the folder it was built from. If you moved or renamed the folder, it shows a dialog.

1. Open Terminal in the new folder.
2. Run `./install.sh`.

That rebuilds the app and fixes the `wingman` command link. Your calls and settings are not touched.

## Node is too old

`./install.sh` or `pnpm install` stops with "Node ... is too old". Wingman needs Node 24 or newer.

```bash
brew install node@24       # then: brew link --overwrite node@24
# or
nvm install 24 && nvm use 24
```

Check with `node -v`. The installer never installs Node for you. The app also needs Node 24 when it starts. If it cannot find it, install Node and open the app again.

## "wingman: command not found"

The command is a link in `~/.local/bin`. That folder must be on your PATH. Add this line to `~/.zshrc`, then open a new Terminal:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

No link yet? Run `./install.sh` and say yes to the `wingman` command question. Without the link you can run `stage0/scripts/wingman-cli.sh`.

## The AI is slow

Signs: an amber bar "AI slow", cards arrive late, more "Buy time" lines.

Wingman steps down by itself: first it uses only Prepared cards and "Buy time" lines (reduced AI), then Prepared cards only. It steps back up after a minute of calm. The call never stops because of this.

What you can do:

1. Check your internet. Run the Readiness check and read the model line.
2. Check the Anthropic status page and your account limits.
3. Raise the spend cap if the bar says the cap was reached (`budget.maxUsdPerCall`).
4. For a call that must stay calm, start with **Quick call without AI**.

## The disk is nearly full

Signs: an amber bar under 500 MB free, a red bar under 100 MB.

A call that cannot write loses its transcript and summary, and a notification tells you. Free some space now.

- Delete calls you do not need: **Calls, Delete call**, or `wingman calls purge <id> --yes`, or `pnpm purge --older-than 30` in `stage0/`.
- Your calls are in `~/Library/Application Support/Wingman/calls/`.
- Cards still reach the answer window over a second channel while the disk is full.

## The Mac went to sleep during a call

When you close the lid or the Mac sleeps, audio and the speech connection die. After wake Wingman:

- shows an amber bar "the computer slept for N seconds, part of the call was not heard";
- restarts both audio sources and reopens the speech connection;
- starts the silence timer again, so sleep does not count as "nobody spoke".

If you missed something, ask the other side to repeat it. To keep the Mac awake on purpose, leave `system.caffeinate` on (the default).

## The answer window does not open

With one screen, the answer window refuses to open, so it cannot end up in a screen share. Connect a second screen. If you must use one screen, turn on **Setup guide, Your screens, Allow the answer window on this screen** (`overlay.allowPrimary`) and never share that screen.

## A call started from the command line does not begin

By default the app first asks you in a window (`privacy.askBeforeCliStart`). Without your click, `wingman start` is refused (exit code 4). Click the window, or turn the setting off in Settings. Practice calls never ask.

## Still stuck

- Look at the menu-bar app log: menu bar icon, **Show log**.
- Look at `events.jsonl` in the call folder. Errors are one line each.
- Open an issue. Describe what you did and what you saw. **Do not paste transcripts, keys or client data.** See [SECURITY.md](../SECURITY.md) for anything security-related.
