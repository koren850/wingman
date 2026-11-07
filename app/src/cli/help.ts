// `wingman help`: written for an AI agent (Claude Code) that drives Wingman from a terminal.
// HELP is user-visible output: keep it in step with the commands in index.ts and the exit codes in common.ts.
export const HELP = `wingman: command line for the Wingman live-call assistant. Everything the user can do in the app, from a terminal.

HOW TO USE IT (for an AI agent)
  1. Run \`wingman status --json\` first. It tells you if the app is running, whether a call is live (call.phase), health problems and readiness.
  2. Add --json to ANY command for machine-readable output: {"ok":true,...} on success, {"ok":false,"error":{"code","message","hint"}} on failure.
     Read the exit code, then the "hint" text; it says what to do next.
  3. start / stop / ask / note / confirm drive the RUNNING menu-bar app, so the call shows in its windows. This CLI never starts a second engine.
     If the app is not running the exit code is 3: tell the user, or (only if they agree) run \`wingman app open\`. The CLI never opens the app by itself.
  4. Call content is private: never paste transcripts or cards anywhere except the user's own terminal. Never try to read keys.

TYPICAL FLOWS
  Prepare:   wingman plan new --title "Hosting move" --at "2026-11-03 14:30" --who "Dana, Levi Studio" --kind client --topic "hosting move" \\
                              --goal "agree migration date" --must "price" --must "downtime window" --note "She prefers WhatsApp"
             wingman plan attach --id <id> --file ~/notes/offer.md   (or --text "..." or --stdin)      wingman plan list      wingman plan show <id>
             Several prepared meetings can wait at once. Each has its own checklist and background files.
  Run:       wingman doctor (readiness check)            then   wingman start --plan <id>   (a prepared meeting)   or   wingman start --quick   (no Plan)
             wingman start --practice = offline pretend client, free (uses the next prepared meeting, or --plan <id>, or none with --quick)
             wingman status            phase "live" = listening ("waiting" only if the optional "Ask me before listening starts" setting is on)
  During:    wingman live [--follow]   transcript + answer cards          wingman ask "what did we say the price was?"
             wingman note "she is the owner"     wingman speaker 2 "Dana"     wingman quiet on|off     wingman client   (confirm the proposed client)
  Finish:    wingman stop   (or: wingman stop --delete --yes)     wingman calls summary latest     wingman calls email latest
  Review:    wingman calls list | show <id> | rate <id> <card> y|n | purge <id> --yes

COMMANDS
  status                       App running? Call phase (and which Plan the live call uses), health, last readiness check, the prepared meetings. Exit 3 when the app is not running.
                               While a call stops it shows the step (saving the call, writing the summary, finishing); --json: call.stopPhase.
                               call.listeningForQuestion = Ctrl+Opt+A is armed (call.questionSecondsLeft = seconds left in that window); call.aiMode = ai | prepared-only.
  doctor [--offline]           Readiness check, the same as Run readiness check in the app (microphone, audio, speech service, model). Full check costs a few cents and is refused while a call runs.
                               --offline: no audio, no network, no cost.
  plan list                    The prepared meetings, soonest first (id, time, checklist and file counts). --json: {"plans":[{id,name,title,who,goal,kind,topic,notes,mustCover,at,atText,attachments,expiresInMin}]}
  plan show [id]               One meeting in full. Without an id: the only meeting, or the list when there are several.
  plan new|set [--id <id>] [--title ..] [--at "2026-11-03 14:30"|none] [--who ..] [--goal ..] [--kind client|support|vendor|team|consult|personal|other|interview] [--topic ..]
               [--note ..]... [--add-note ..]... [--must ..]... [--add-must ..]... [--fresh]
                               new = a new meeting. set --id <id> = edit that one (fields you leave out are kept; --fresh starts its fields over).
                               set without --id and without --new: makes the first meeting, edits the only one, and with several it REFUSES (exit 2): name one with --id.
                               --at is your local time ("14:30" = today); --must items become the checklist. Time rule: a meeting with a time stays until about 6 hours
                               after it; without a time it stays 14 days after its last edit. A meeting is used up by the real call started with it (Practice never does).
                               --kind interview = a job interview: the user is the candidate. The AI answers technical questions and questions about them from the
                               background files only; no "buy time" lines, no card limit. Add --note "Prepared cards: <file.yaml>" for instant cards (bank format).
  plan attach [--id <id>] --file <.txt|.md|.pdf> [--force] | --text "<text>" | --stdin     Background the AI may read (2 MB per file, 40,000 characters per meeting). --id is needed when there are several meetings.
                               --file refuses symbolic links, key/.env style files and anything in ~/.ssh, ~/.aws, ~/.gnupg, ~/.config/wingman, ~/Library/Keychains (exit 4); files outside the home folder need --force.
  plan detach <file id> [--id <id>]       Remove one background file.
  plan delete <id> --yes       Delete a meeting and its background files (exit 6 without --yes).   (plan clear = the old name; it works only when exactly one meeting exists)
  start [--quick | --plan <id>] [--practice] [--no-ai] [--no-wait]    Start a call in the app. A Plan is never picked by guesswork:
                               --quick = a call with NO Plan (never touches a prepared meeting). --plan <id> = with that prepared meeting (id or unique prefix).
                               Plain \`wingman start\` (neither): no prepared meetings at all = a quick call; exactly ONE meeting scheduled within 30 minutes of now = that one;
                               anything else is refused (exit 2) with the list of ids. --json: {"mode":"quick"|"plan","plan":{id,name}|null,"reason":...}.
                               --practice = offline pretend client. --no-ai = Prepared cards only (no AI).
                               The app asks the user to confirm a real start in a window on their screen (setting "Ask before a call started from the
                               command line starts listening", on by default; --practice is exempt). Without their click it is refused (exit 4). Wait, do not retry.
  stop [--delete --yes] [--no-wait] [--no-summary]
                                              Stop and save. --delete erases the call, needs --yes AND the user's click on a confirmation window in the app. --no-summary keeps the call but
                                              skips the summary (write it later: wingman calls summary <id> --generate).
  confirm --yes                Only when the optional "Ask me before listening starts" setting is on (off by default): starts listening
                               on a call that is waiting (the "Start listening" step). Do it only when the user asked. (Old name: consent.)
  client                       Confirm the proposed client (the AI may then use their details).
  quiet on|off                 Quiet mode: hide cards in the answer window (they are still saved).
  note "<text>"                Add a context note for the AI (max 300 characters; \`-\` reads stdin).
  speaker <n> "<name>"         Name the other side's voice n (1-20, the "Speaker n" in the live view); \`speaker <n> --clear\` removes the name. Needs a running call.
  ask "<question>"             Type a question to Wingman during a live call; the answer appears as a card (read it with \`wingman live\`). Needs phase "live".
  ask --listen                 Same as the Ctrl+Opt+A key: the user's next spoken sentence is the question.
  live [--follow] [--last N] [--id <call>] [--timeout S]     Transcript with answer cards (NDJSON with --json --follow).
  calls list [--limit N] | show <id|latest> [--lines N] [--no-transcript] | summary <id> [--generate] | email <id>
        | rate <id> <card id> y|n|clear | purge <id> --yes
                               --generate writes a missing summary (one small paid model call).
  diagnose [call id|latest] [--out <file>]     One file for a bug report: versions, changed settings, health/ladder/latency/error events, device names, model and prompt ids, counts.
                               No transcript or card text, no emails, phone numbers or keys (cut out, not hidden). Prints the file path; read the file before you share it.
  profile show | set [--name N] [--spelling S ...] [--address male|female|neutral] [--about T] [--business T] [--timezone Z]
                               Who Wingman is helping: name (and the spellings speech-to-text gives it), the Hebrew form used to address the user, a line about them
                               and their business. Stored in ~/.config/wingman/profile.yaml, never in the repo. An empty value clears a field. Applies to the next call.
  settings list [--all] | get <key> | set <key> <value|default> [--advanced]     Same options and limits as the app's Settings. Applies to the next call.
  pack from-notes <file.txt|.md|.pdf> [--lang en|he] [--out <folder>] [--force] [--model provider:model]
                               Drafts answer cards from the user's own FAQ or notes with one model call (a few cents). Writes bank.yaml and bank.en.yaml into <folder>
                               (default ./pack-draft) as a DRAFT, never into the live pack, and never over existing files without --force (exit 4). Cards with a price, date
                               or promise become stalls and are listed in the output. The user must read every card. PDF needs pdftotext. --model default: summary.model.
  keys status                  Present or missing for each API key. Nothing else: keys are never printed, set or moved from here
                               (use \`pnpm keys\` in a terminal or the app's Settings > Keys).
  app status | app open        Is the app running / open /Applications/Wingman.app (only when you run it explicitly).
  help [--json]

EXIT CODES
  0 ok   1 failed   2 bad usage or invalid value   3 app not running   4 refused (wrong state, e.g. no live call, or a call is already running)
  5 not found   6 needs --yes   7 not ready (readiness check NOT READY, keys missing)   8 rate limited (starts: 1 per 1.5 s, 6 per minute)   9 timeout

SAFETY
  - The app listens on an owner-only socket (~/.config/wingman/run/control.sock, mode 600). Only a fixed list of commands is accepted.
  - Output never contains API keys. Destructive commands (stop --delete, calls purge, confirm) need --yes.
  - Do not start a real call unless the user asked for it in this session, and never choose a Plan for them: ask which meeting (or --quick). Use --practice to test.
`;
