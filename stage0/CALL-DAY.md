# Call day checklist (Stage 0)

## Before (10 min)
- `pnpm run doctor` is all green. Do Not Disturb on. Wired headphones (not AirPods). Set `WINGMAN_MIC` if needed.
- Second screen connected; Zoom share-mode test done (window, primary, secondary, all screens). Never share the primary screen with the overlay on it.
- Keys: Settings → Keys → Move to Keychain (once), then Test both (shows ok). Status should read "Saved in Keychain · …xxxx" for both.
- Deepgram and Anthropic spend limits set. Consider `--no-ai` for call one.
- Run `pnpm dashboard` from Terminal.app (menu bar icon plus the Wingman window; `pnpm tray` = menu bar only). On **Home**: **Ready for a call?** → Re-check until READY. Optional: **Plan a call** (who, goal, notes, must cover; Save). Click **Start call** (or **Start without AI** for call one); `pnpm call` in Terminal still works.
- Listening starts with the call (personal use: no consent step). To get a consent click first, turn on Settings → "Ask me before listening starts".

## During
- Cards are hints, not scripts: read, rephrase, never quote prices, dates or promises.
- During the call, Home shows the timer, **Quiet mode**, **Add note**, **Confirm client**, **Stop call** and **Stop and delete** (asks first), plus any health warning in plain words. The window never opens by itself: open it from the menu bar (**Open Wingman**) or the call chip. In Terminal: `q` = quiet, `n` = note.
- **Ctrl+Opt+A = ask Wingman**: your next sentence (within 10 s) is a question for it; the answer shows in the violet "For you" card. Works even when "Answer my own questions" is off.
- Ctrl+Opt+R = "what did they say?" (last 30 s as text). Ctrl+Opt+K = copy the newest captured phone/email/domain (or click it). Ctrl+Opt+C clears the window, Ctrl+Opt+P pauses it.
- Headphones are optional. `audio.echo.mode: auto` (default) checks the output: on the Mac speakers it mutes the mic while the other side talks and drops echo lines; with headphones it only drops echo lines, so your words are kept when you talk over the other side.
- Several people on the other side: lines show their names (from introductions or the meeting's attendees; rename a voice on the dashboard or with `wingman speaker <n> "<name>"`). When two or more of them talk among themselves while you are quiet, a muted "מדברים ביניהם" line shows who and what about, and answer cards wait. When someone says your name (or "you" right after), an orange "פונים אליך" alert shows who. Turn it off with `flow.enabled: false`.
- Red bar = STT/mic/system audio down. "I only hear you" (calm line) = no audio from the other side and no call app open: fine for testing alone. Abort rule: three wrong or late cards in a row, go quiet. Ctrl+C, one restart, then continue without Wingman.
- Want this call gone: Stop and delete (… menu on the call panel), or Ctrl+C and answer `y`.

## After
- Home shows **Summary ready → Open follow-up**; rate the cards from **Waiting for you** (or `pnpm tag`) within 15 min. Delete with `pnpm purge <id>` if not needed.
- "Used" = at least 15 min of a live client call with transcript and cards logged and tagged.

## First-run order
1. `pnpm run doctor`
2. `pnpm start --file data/synthetic/call1.wav --no-ai`
3. `pnpm gate data/gold/synthetic.wav` (then your own recordings, all 40 sentences)
4. `pnpm call` with a Hebrew video playing
5. `pnpm tag`
