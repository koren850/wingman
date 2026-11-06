# Live call checklist

A checklist for using Wingman on a real call. For first-time setup see the [user guide](../docs/USER-GUIDE.md#first-run).

## Before the call (about 10 minutes)

- Run the readiness check until it reports READY (**Home, Run readiness check**, or `pnpm run doctor`).
- Turn on Do Not Disturb. Wired headphones work best (AirPods switch audio profiles and can degrade the microphone). Pick the microphone in **Settings, Setup guide, Microphone**.
- Permissions: Microphone and System Audio Recording are allowed, and Wingman was restarted after System Audio Recording was allowed.
- Second screen connected. Test your screen-share mode (window, primary screen, secondary screen, all screens) before the call. Never share the screen that shows the answer window.
- Keys: **Settings, Keys**, then Test both. Each should read "Saved in Keychain". If you still have an old `keys.env` file, use Move to Keychain once.
- Spend limits are set with Deepgram and Anthropic. For a first call, consider **Quick call without AI** (or `--no-ai`), which shows prepared cards only.
- Start a call from **Home**: **Quick call** (no Plan) or **Start** on a prepared meeting. To prepare one, use **Prepare a meeting** (who, goal, notes, must-cover points, background files). `pnpm call` in Terminal also works.
- Rehearsal: create the meeting with `--kind interview` (see the [app README](README.md#practice-and-prep-mode-kind-interview)). Real interviews and exams that forbid outside help are out of scope.
- Tell the other people on the call that you use a live assistant, and follow the recording-consent laws that apply to you. Listening starts with the call; to require a click first, turn on Settings, "Ask me before listening starts".

## During the call

- Cards are hints, not scripts. Read them, rephrase them, and do not quote prices, dates or promises from them.
- Home shows the timer, **Quiet mode**, **Add note**, **Confirm client** (when Wingman proposes one), **Stop call** and any health warning. **Stop and delete this call** is in the menu-bar menu and asks first. The window never opens by itself; open it from the menu bar (**Open Wingman**) or the call chip. In Terminal: `q` for quiet, `a` to ask Wingman.
- **Ctrl+Opt+A** asks Wingman: your next sentence (within 10 s) is a question for it, and the answer appears in the violet "For you" card. It works even when "Answer my own questions" is off.
- **Ctrl+Opt+R** shows what they said in the last 30 s as text. **Ctrl+Opt+K** copies the newest captured phone number, email or domain (or click it). **Ctrl+Opt+C** clears the answer window and **Ctrl+Opt+P** pauses it.
- Echo handling: `audio.echo.mode: auto` (default) checks the output device. On the Mac speakers it mutes the microphone while the other side talks and drops echo lines. With headphones it only drops echo lines, so your words are kept when you talk over the other side.
- Several people on the other side: lines show their names (from introductions or the meeting's attendees; rename a voice in the dashboard or with `wingman speaker <n> "<name>"`). When two or more of them talk among themselves while you are quiet, a muted "מדברים ביניהם" line shows who and about what, and answer cards wait. When someone says your name, an orange "פונים אליך" alert shows who. Turn this off with `flow.enabled: false`.
- Health bars: a red bar means speech to text, the microphone or system audio is down. Audio sources restart on their own, so wait a few seconds. After the Mac sleeps, an amber bar says part of the call was not heard. "I only hear you" means there is no audio from the other side and no call app open, which is normal when testing alone.
- Fallback rule: if three cards in a row are wrong or late, go quiet, stop the call, start once more, and if it persists continue without Wingman.
- To discard a call: **Stop and delete this call** (menu-bar menu), or Ctrl+C in a terminal call and answer `y`.
- Low disk space: an amber bar under 500 MB and a red bar under 100 MB. Free space, or the call may not save.
- Problems: [docs/TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md).

## After the call

- Home shows **Summary ready, Open follow-up**. Rate the cards under **Waiting for you** (or `pnpm tag`) soon after the call.
- Delete calls you do not need: **Calls, Delete call**, or `pnpm purge <id>`. Calls are stored in `~/Library/Application Support/Wingman/calls/`.

## First-run order (from a terminal)

1. `pnpm run doctor`
   (`pnpm synth` builds the synthetic audio used in steps 2 and 3.)
2. `pnpm start --file data/synthetic/call1.wav --no-ai`
3. `pnpm gate data/gold/synthetic.wav`, then your own recordings
4. `pnpm call` with a Hebrew video playing
5. `pnpm tag`
