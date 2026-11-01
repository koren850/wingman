# Wingman

A live partner for meetings: Claude listens with full context and Dan's tools, and helps, corrects and improves the conversation as it happens. No missed points, no stuttering.

"Wingman" is a **codename** (name availability check pending; bundle id, keychain service and data-dir are neutral constants).

## Project status (2026-11-01)
- **Personal tool first.** Built for Dan's Hebrew client calls and his own tools. Published as open source: **works on macOS, from source.** Signed installers, Windows, the pack installer and a polished wizard wait until a second real user wants Wingman.
- `STRUCTURE.md` is the buildable structure (build order in §13, spikes in §14, red-team log in §16). `PLAN.md` is the requirements document: only its §0, §1, §1b, §5 and §9 are requirements; its technical sections are superseded by `STRUCTURE.md`. `REDTEAM.md` is the review that produced the 2026-11-01 changes.
- Nothing is built yet. License: Apache-2.0.

> **Next session: start with `NEXT-SESSION.md`.**

## TARGET: first real use by Sun 8 Nov 2026
Go/no-go Fri 6 Nov evening: client call only if the STT gate passes, consent wording is confirmed and a Zoom share test is done; otherwise first client call 11-12 Nov.

| When | Dan | Claude |
|---|---|---|
| Sun 1 Nov | Paste keys, `pnpm run doctor`, allow Mic + System Audio | Run the synthetic call end to end, fix, report speeds |
| Mon 2 Nov | Record 10 of the 40 gold sentences; live self-test with a Hebrew tech video; edit the top 10 cards | STT gate on the recording; tune cards and detector |
| Tue 3 Nov | 15-min Zoom with a friend playing a client | Review cards, fix misses, add bank cards |
| Wed 4 - Thu 5 Nov | Off | Polish |
| Fri 6 - Sun 8 Nov | **First real client call** (friendly client, consent line said) | Same-day fixes from the logs |
| By ~13 Nov | 3 real calls + `pnpm tag` after each | Usefulness gate decision |

Start a call with `cd stage0 && pnpm call`; after it, `pnpm tag`.

## STOP RULE
**If Wingman has not been used on a real call by 2026-11-22, or if a new job starts, freeze the project** and write down in this file where it stopped (what works, what is blocked, what the next step would have been). No more review rounds.

## Start here (next session): Stage 0, the dogfood tool (2-3 days)
Read `STRUCTURE.md` §13 "Stage 0" and §14 S2. Stage 0 is a rough terminal-launched tool plus the Hebrew STT gate. It is not the final architecture.

**Keys and accounts needed**
1. A **Deepgram API key** (deepgram.com, free starting credit).
2. An **Anthropic API key** (Haiku reflex).
3. Nothing else for Stage 0: no Apple Developer ID, no SignPath, no M365.

**Prep needed**
1. Audio: install **AudioTee** or **BlackHole** (whichever works first on this Mac, macOS 27.x) and grant Microphone and System Audio Recording. Headphones on. Second screen for the cards.
2. **Gold set (day 0-1):** Dan records himself speaking about **~40 English tech terms** (DNS, SSL, Cloudflare, WordPress, ...) in Hebrew sentences, plus **one consenting friend**, 3 consented recordings in total, plus **1 speakerphone clip**. Hand-label about 60 lines (this also seeds the 30-50 line Hebrew question corpus).
3. **Bank:** 30-60 answer cards in Dan's own words (Claude drafts, he edits), and a short `house-style.md` (never-say rules, no prices/dates/promises).
4. **Consent and privacy (before the first real client call):** settle the consent wording (STRUCTURE.md S15, short lawyer/consultant check) and pre-record consent decisions for the top clients. Interim privacy policy until encryption exists: plain files, manual purge (`wingman purge --older-than`), **synthetic or consented calls only**.
5. 30-minute **name availability check** (npm scope, GitHub org, domain).

**Stage 0 gate (numbers)**
- Term recall on the ~40 English terms >= ~85 %.
- Endpoint-to-final <= ~600 ms.
- Diarization works on Hebrew (`he`).
- If Deepgram fails, try Soniox; do not start Stage 1 until the vendor is decided.

**Then:** run Wingman on **3 real consented calls**, tag each card useful or not, and apply the **usefulness gate** (about 2+ useful cards per hour, plus the share of questions the bank answers). Only after it passes: Stage 1a (CLI replay), 1b (live audio + overlay) and later the brain. The fallback product, if the gate fails, is the keyword bank + Haiku plus a post-call summary and promises list. Optional: the NexQ test (PLAN.md §3), only to hear Deepgram Hebrew in a ready app.

## Stack (decided 2026-11-01, details in STRUCTURE.md)
TypeScript · **Deepgram Nova-3 `he`** over its live WebSocket behind our own `SttProvider` · **Claude Haiku 5.5** as the fast reflex via the Vercel AI SDK · keyword answer bank first (embeddings and the Sonnet brain only after the usefulness gate) · Electron overlay on the second screen from Stage 1b · plain JSONL/YAML files · tools through our ToolBroker (MCP) from Stage 2 · optional deep answers from Dan's own **Claude Code** login (opt-in, off by default). **M365/Outlook is read-only and reached only through that deep session's connector;** the post-call email is a local draft (.eml or clipboard) that Dan sends himself.

## Decisions already made
- Headphones: yes. Second screen: yes, and the answer window goes there.
- Call apps: Zoom, Teams, Google Meet.
- Opt-out clients: ask once per client at the first start.
- Fast model: Claude Haiku 5.5. Deep mode stays opt-in and off by default, owner's own login only.
- Real job interviews: off-limits. Practice mode only.
- Audio for Stages 0-1: AudioTee or BlackHole from the terminal; Electron loopback is tested on a signed build before the installer stage (macOS 27.x included).
- Phone: Dan has **Android**. **Phone mode is Stage P, right after the usefulness gate:** speakerphone + Mac mic, voice print to tell "me" from "client", one-tap start (tray/hotkey ⌃⌥W, Android home-screen button), and Tasker auto-start with the caller number picking the client profile. Fallback if speakerphone Hebrew is too poor: a cloud phone line (PLAN.md "Later ideas").
