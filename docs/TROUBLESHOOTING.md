# Troubleshooting

For anyone whose Wingman does not install, does not hear, or does not show answers. Find your problem, then follow the steps. If you installed the downloaded app, start with the sections that name your system. Developers who build from source can run `./install.sh --check` any time to see what is present and what is missing. It changes nothing. For a quick offline check of the engine itself, run `pnpm demo` in `app/` (no keys needed): if it prints cards, the engine works and the problem is audio, permissions, keys or the app.

The Wingman window follows your system language (English or Hebrew). The bars in the answer window follow the setting `ui.language`: `auto` shows Hebrew unless the speech language is English, and `en` or `he` force one. The descriptions below say what each bar means.

## macOS will not open the app

Signs: "Wingman Not Opened. Apple could not verify Wingman is free of malware", or "Wingman is damaged and can't be opened".

The app is not signed yet, so macOS blocks the first start. Do this once:

1. Double-click Wingman in Applications. Press **Done** in the warning.
2. Open **System Settings, Privacy & Security**, scroll to **Security** and press **Open Anyway** next to "Wingman was blocked". Enter your password or use Touch ID, then press **Open Anyway** again.
3. If **Open Anyway** is not there, or "damaged" is shown, run this in Terminal and open the app again:

```bash
xattr -dr com.apple.quarantine /Applications/Wingman.app
```

Right-click, **Open** does not work on macOS 15 and newer. The Open Anyway button shows for about an hour after the block; double-click the app again if it is gone. Permissions are asked again after each new build, because an unsigned build has a new identity each time.

## Windows shows "Windows protected your PC"

This is SmartScreen. The installer is not signed yet. Press **More info**, then **Run anyway**. If your company blocks unsigned installers, ask your administrator or use [build from source](DEVELOPMENT.md#building-the-app-dmg-and-windows-installer). If an antivirus program removes the file, restore it and add an exception.

## Windows: I do not see Wingman

The app has no Dock icon. It lives in the notification area at the bottom right. Press the small arrow to show hidden icons, or start **Wingman** from the Start menu again: a second start opens the window of the running app. To remove the app: Settings, Apps, Wingman. Your calls stay in `%APPDATA%\Wingman` until you delete that folder.

## No sound from the other side on Windows

The app records the sound that the computer plays (loopback). It needs no permission, but it needs the call to play on this computer. If it stays silent, run the Readiness check (Home, **Run readiness check**) and close other programs that take the audio device for themselves. Windows audio capture has been tested with fakes only, so please open an issue and say what you see.

## A key is not accepted

The first window checks each key with one small request:

- **"did not accept this key"**: you copied part of it, or it was switched off. Press **Get a new key** and paste the whole key.
- **"The key is right, but the account has no credit"**: add credit in the provider's billing page (Anthropic: platform.claude.com, Billing; Deepgram: the console) and press **Check again**. You can still run a practice call.
- **"Could not reach ..."**: check your internet, a proxy or a firewall, and press **Try again**.
- **Too many tries**: wait a minute. Keys are checked at most 12 times a minute.

Keys are stored in the macOS Keychain, or encrypted for your Windows account. If the store fails, the window says so. Developers: `pnpm keys status` says only whether a key is present.

## Hebrew or English is not recognised

- The default setting (`stt.language: multi`) hears both. Under Settings, "Language the call is heard in", you can force `he` or `en`. A forced language can be steadier on short clips but misses the other one.
- Speech to text is weaker on Hebrew than on English (about 77 to 83 percent of words right, against about 92 percent, in our synthetic tests), and numbers and dates in Hebrew are sometimes written in an odd way ("60 1000"). Check numbers before you say them.
- Other languages are not supported. Wingman shows one notice and gives no cards for those lines.
- A microphone that is far away or a Bluetooth headset makes it worse. Use the built-in microphone or wired headphones.

## No sound from the other side on a Mac

Signs: a red bar that says the other side is not heard (when Zoom, Teams or a similar app is open), or a calm line "Hearing only you" (when no call app is open).

1. (Mac) Is the other side's audio playing on this Mac? Wingman captures what the Mac plays. If the call plays on another device, there is nothing to hear.
2. Check System Audio Recording permission (next section).
3. Run the Readiness check (**Home, Run readiness check**). It tests the system audio.
4. If you only wanted to test alone, the calm line is fine. Ask Wingman anything with Ctrl+Opt+A (Ctrl+Alt+A on Windows).

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

Signs: a red bar that says the microphone is not picking up, ten seconds after listening starts (`audio.watchdog.micSilentMs`), or the wrong mic is picked.

1. Open **Settings, Setup guide, Choose your microphone** and choose the right one.
2. If the right microphone is not in the list, plug it in and open the list again. A microphone that another program holds (a video call app in exclusive mode) shows a bar that says so. Developer runs from a terminal still use ffmpeg: list the devices with `ffmpeg -f avfoundation -list_devices true -i ""` and set `audio.mic.device` (for example `":1"`).
   - If the bar says Wingman is not allowed to use the microphone: on macOS open System Settings, Privacy & Security, Microphone and switch Wingman on; on Windows open Settings, Privacy & security, Microphone and switch on "Let desktop apps access your microphone". Then start the call again.
3. Avoid AirPods and other Bluetooth headsets. They drop to phone quality when the mic is in use. Wingman warns you. Use the built-in mic or wired headphones.
4. The setup window saves the microphone with its name (`audio.mic.device` is then like `":2|External USB Microphone"`). When a headset connects, the numbers can move; Wingman looks the name up again at every start and uses the right number. If the name is not found, it uses the default microphone and shows an amber bar. Choose the microphone again in Settings to fix it.
5. If the device disappears during a call (headphones switched off), Wingman restarts that audio source by itself and falls back to the default mic after a couple of tries. A red or amber bar shows while it recovers.

## The Electron download failed (building from source)

The install stops with "could not download the Electron runtime". The cause is almost always the network or a proxy.

```bash
cd app
node node_modules/electron/install.js
pnpm run make-app
```

Or run `./install.sh` again. It is safe to repeat.

## The app says the folder moved (built from source)

A Wingman.app built by `install.sh` remembers the folder it was built from. If you moved or renamed the folder, it shows a dialog.

1. Open Terminal in the new folder.
2. Run `./install.sh`.

That rebuilds the app and fixes the `wingman` command link. Your calls and settings are not touched.

## Node is too old (building from source)

The downloaded app needs no Node. `./install.sh` or `pnpm install` stops with "Node ... is too old". Wingman needs Node 24 or newer.

```bash
brew install node@24       # then: brew link --overwrite node@24
# or
nvm install 24 && nvm use 24
```

Check with `node -v`. The installer never installs Node for you. The app also needs Node 24 when it starts. If it cannot find it, install Node and open the app again.

## "wingman: command not found"

The `wingman` command is a developer feature (a checkout on a Mac). It is not in the downloaded app and not on Windows. The command is a link in `~/.local/bin`. That folder must be on your PATH. Add this line to `~/.zshrc`, then open a new Terminal:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

No link yet? Run `./install.sh` and say yes to the `wingman` command question. Without the link you can run `app/scripts/wingman-cli.sh`.

## The AI is slow

Signs: an amber bar "AI slow", cards arrive late, more "Buy time" lines (the bar may be in Hebrew).

Wingman steps down by itself: first, when the AI is slow, answers keep coming but one that arrives too late is not shown (reduced AI), then Prepared cards only. It steps back up after a minute of calm. The call never stops because of this.

What you can do:

1. Check your internet. Run the Readiness check and read the model line.
2. Check the Anthropic status page and your account limits.
3. Raise the spend cap if the bar says the cap was reached (`budget.maxUsdPerCall`).
4. For a call that must stay calm, start with **Quick call without AI**.

## The disk is nearly full

Signs: an amber bar under 500 MB free, a red bar under 100 MB.

A call that cannot write loses its transcript and summary, and a notification tells you. Free some space now.

- Delete calls you do not need: **Calls, Delete call**, or `wingman calls purge <id> --yes`, or `pnpm purge --older-than 30` in `app/`.
- Your calls are in `~/Library/Application Support/Wingman/calls/` on a Mac and `%APPDATA%\Wingman\calls\` on Windows.
- Cards still reach the answer window over a second channel while the disk is full.

## The Mac went to sleep during a call

When you close the lid or the Mac sleeps, audio and the speech connection die. After wake Wingman:

- shows an amber bar "the computer slept for N seconds, part of the call was not heard";
- restarts both audio sources and reopens the speech connection;
- starts the silence timer again, so sleep does not count as "nobody spoke".

If you missed something, ask the other side to repeat it. To keep the Mac awake on purpose, leave `system.caffeinate` on (the default).

## The answer window does not open

With one screen, the answer window refuses to open, so it cannot end up in a screen share. Connect a second screen. If you must use one screen, turn on **Setup guide, Allow, Allow the answer window on this screen** (`overlay.allowPrimary`) and never share that screen.

## A call started from the command line does not begin

By default the app first asks you in a window (`privacy.askBeforeCliStart`). Without your click, `wingman start` is refused (exit code 4). Click the window, or turn the setting off in Settings. Practice calls never ask.

## Check that the engine works

If you are not sure whether the problem is your setup or the code, run the offline demo. It needs no keys, no microphone and no network:

```bash
cd app
pnpm demo
```

Run `pnpm` from inside `app/`, so corepack uses the pinned pnpm version. A global pnpm of another version prints a notice; it is harmless.

It takes 1 to 2 minutes, prints cards and a call summary, then `Demo done`. If it does, the engine is fine. Then check audio permission, keys (`pnpm keys status`) and the Readiness check (`pnpm run doctor --offline` for the free part; without keys it ends NOT READY, because missing keys count as errors). If `pnpm demo` fails, open an issue with the last lines of its output.

## A bar says "AI paused"

Live reading, the default help engine, could not use the AI: the spend cap (per call or per hour) was reached, the model is not answering, or there is no internet. Prepared cards, sums and the buy-time line still work. The bar goes away by itself when the AI works again (for the hourly cap: when the spend of the last hour is below the cap). To change the cap: the **Money** group in Settings. To see why the model fails: the call's events file (`events.jsonl`, rows `llm.error` and `ai.paused`).

## A context file or web address is refused

Wingman reads pasted text, `.txt`, `.md`, `.docx`, `.eml`, `.pdf` and `.ics` files, https web addresses, a calendar link and your next calendar event. The full list and its limits are in the [User guide](USER-GUIDE.md#meeting-context-what-you-can-add). A `.pdf` needs `pdftotext` (`brew install poppler`). Web addresses inside your network and plain http are refused. If a file will not read, paste its text instead.

## Reporting a bug

Run `pnpm diagnose` (or `wingman diagnose`) after the call that went wrong. Use `wingman diagnose <call id>` for an older call. It writes one JSON file and prints where it is.

The file has: the Wingman, Node, Electron and macOS versions, the settings that differ from the defaults, the health, ladder, latency and error events of the call, audio device names, model and prompt ids, and counts. It has no transcript text and no card text (only their lengths). Emails, phone numbers, key-like strings and your home folder name are removed.

Read the file before you share it. Attach it to the issue. Do not paste transcripts, keys or client data.

## Still stuck

- Look at the menu-bar app log: menu bar icon, **Show log**.
- Look at `events.jsonl` in the call folder. Errors are one line each.
- Open an issue with the file from `pnpm diagnose`. Describe what you did and what you saw. **Do not paste transcripts, keys or client data.** See [SECURITY.md](../SECURITY.md) for anything security-related.

Next: [User guide](USER-GUIDE.md) · [Development](DEVELOPMENT.md) · [Privacy and security](PRIVACY-AND-SECURITY.md)
