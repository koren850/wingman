# Call day checklist (Stage 0)

## Before (10 min)
- The Readiness check is green (**Home, Run readiness check**, or `pnpm run doctor`). Do Not Disturb on. Wired headphones are best (not AirPods). Pick the right mic in **Settings, Setup guide, Microphone**.
- Permissions: Microphone and System Audio Recording are allowed, and you restarted Wingman after allowing System Audio Recording.
- Second screen connected; Zoom share-mode test done (window, primary, secondary, all screens). Never share the primary screen with the overlay on it.
- Keys: **Settings → Keys**, then Test both (shows ok). Status should read "Saved in Keychain · …xxxx" for both. (Old `keys.env` file? Use Move to Keychain once.)
- Deepgram and Anthropic spend limits set. Consider `--no-ai` for call one.
- Open Wingman (Spotlight, Launchpad, or `pnpm dashboard` in `stage0/`). On **Home**: **Ready for a call?** → **Re-check** until READY. Optional: **Prepare a meeting…** (who, goal, notes, must cover, background files; Save). Then press **Quick call** (no Plan), or **Start** on the prepared meeting. For call one use **Quick call without AI**. `pnpm call` in Terminal still works.
- Interview practice: make the meeting with `--kind interview` (see the [stage0 README](README.md#practice-and-prep-mode-kind-interview)). Real interviews and exams that forbid outside help are out of scope.
- Listening starts with the call (personal use: no consent step). To get a consent click first, turn on Settings → "Ask me before listening starts".

## During
- Cards are hints, not scripts: read, rephrase, never quote prices, dates or promises.
- During the call, Home shows the timer, **Quiet mode**, **Add note**, **Confirm client** (when Wingman proposes one) and **Stop call**, plus any health warning in plain words. **Stop and delete this call…** is in the menu-bar menu and asks first. The window never opens by itself: open it from the menu bar (**Open Wingman**) or the call chip. In Terminal: `q` = quiet, `a` = ask Wingman.
- **Ctrl+Opt+A = ask Wingman**: your next sentence (within 10 s) is a question for it; the answer shows in the violet "For you" card. Works even when "Answer my own questions" is off.
- Ctrl+Opt+R = "what did they say?" (last 30 s as text). Ctrl+Opt+K = copy the newest captured phone/email/domain (or click it). Ctrl+Opt+C clears the window, Ctrl+Opt+P pauses it.
- Headphones are optional. `audio.echo.mode: auto` (default) checks the output: on the Mac speakers it mutes the mic while the other side talks and drops echo lines; with headphones it only drops echo lines, so your words are kept when you talk over the other side.
- Several people on the other side: lines show their names (from introductions or the meeting's attendees; rename a voice on the dashboard or with `wingman speaker <n> "<name>"`). When two or more of them talk among themselves while you are quiet, a muted "מדברים ביניהם" line shows who and what about, and answer cards wait. When someone says your name (or "you" right after), an orange "פונים אליך" alert shows who. Turn it off with `flow.enabled: false`. If the call went quiet because they are talking to each other, that is on purpose: cards wait.
- Red bar = speech to text, mic or system audio down. Audio sources restart by themselves; wait a few seconds. After the Mac slept, an amber bar says part of the call was not heard. "I only hear you" (calm line) = no audio from the other side and no call app open: fine for testing alone. Abort rule: three wrong or late cards in a row, go quiet. Stop the call, start again once, then continue without Wingman.
- Want this call gone: **Stop and delete this call…** (menu-bar menu), or Ctrl+C in a terminal call and answer `y`.
- Low disk space: an amber bar under 500 MB, red under 100 MB. Free space now, or the call may not save.
- Not working? [docs/TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md).

## After
- Home shows **Summary ready → Open follow-up**; rate the cards from **Waiting for you** (or `pnpm tag`) within 15 min. Delete a call you do not need: **Calls, Delete call**, or `pnpm purge <id>`. Calls live in `~/Library/Application Support/Wingman/calls/`.
- "Used" = at least 15 min of a live client call with transcript and cards logged and tagged.

## First-run order
1. `pnpm run doctor`
2. `pnpm start --file data/synthetic/call1.wav --no-ai`
3. `pnpm gate data/gold/synthetic.wav` (then your own recordings, all 40 sentences)
4. `pnpm call` with a Hebrew video playing
5. `pnpm tag`
