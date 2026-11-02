# Call day checklist (Stage 0)

## Before (10 min)
- Written yes from the client, and the consent wording confirmed with your consultant.
- `pnpm run doctor` is all green. Do Not Disturb on. Wired headphones (not AirPods). Set `WINGMAN_MIC` if needed.
- Second screen connected; Zoom share-mode test done (window, primary, secondary, all screens). Never share the primary screen with the overlay on it.
- Deepgram and Anthropic spend limits set. Consider `--no-ai` for call one.
- Run `pnpm call`. Say the consent line first (it is the first card), wait for a clear yes, then press Enter.

## During
- Cards are hints, not scripts: read, rephrase, never quote prices, dates or promises.
- `q` = quiet (cards logged, not shown). `n` = type a note for the AI ("this is about the shop migration"), Enter adds it.
- Ctrl+Opt+R = "what did they say?" (last 30 s as text). Ctrl+Opt+K = copy the newest captured phone/email/domain (or click it). Ctrl+Opt+C clears the window, Ctrl+Opt+P pauses it.
- Headphones are optional: speakers mode (`audio.echo.mode: both`) mutes the mic while the client talks and drops echo lines. With headphones, `WINGMAN_ECHO=filter` keeps your words when you talk over the client.
- Red bar = STT/mic/system audio down. Abort rule: three wrong or late cards in a row, go quiet. Ctrl+C, one restart, then continue without Wingman.
- Consent withdrawn: Ctrl+C and answer `y` to delete.

## After
- `pnpm tag` within 15 min. Delete with `pnpm purge <id>` if not needed.
- "Used" = at least 15 min of a live client call with transcript and cards logged and tagged.

## First-run order
1. `pnpm run doctor`
2. `pnpm start --file data/synthetic/call1.wav --no-ai`
3. `pnpm gate data/gold/synthetic.wav` (then your own recordings, all 40 sentences)
4. `pnpm call` with a Hebrew video playing
5. `pnpm tag`
