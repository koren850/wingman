// `wingman help`: written for an AI agent (Claude Code) that drives Wingman from a terminal.
// HELP is user-visible output: keep it in step with the commands in index.ts and the exit codes in common.ts.
export const HELP = `wingman: command line for the Wingman live-call assistant. Everything Dan can do in the app, from a terminal.

HOW TO USE IT (for an AI agent)
  1. Run \`wingman status --json\` first. It tells you if the app is running, whether a call is live (call.phase), health problems and readiness.
  2. Add --json to ANY command for machine-readable output: {"ok":true,...} on success, {"ok":false,"error":{"code","message","hint"}} on failure.
     Read the exit code, then the "hint" text; it says what to do next.
  3. start / stop / ask / note / confirm drive the RUNNING menu-bar app, so the call shows in its windows. This CLI never starts a second engine.
     If the app is not running the exit code is 3: tell Dan, or (only if he agrees) run \`wingman app open\`. The CLI never opens the app by itself.
  4. Call content is private: never paste transcripts or cards anywhere except Dan's own terminal. Never try to read keys.

TYPICAL FLOWS
  Prepare:   wingman plan set --who "Dana, Levi Studio" --kind client --topic "hosting move" --goal "agree migration date" \\
                              --must "price" --must "downtime window" --note "She prefers WhatsApp"
             wingman plan attach --file ~/notes/offer.md        (or --text "..." or --stdin)      wingman plan show
  Run:       wingman doctor (readiness check)            then   wingman start       (or: wingman start --practice  = offline pretend client, free)
             wingman status            phase "live" = listening ("waiting" only if the optional "Ask me before listening starts" setting is on)
  During:    wingman live [--follow]   transcript + answer cards          wingman ask "what did we say the price was?"
             wingman note "she is the owner"     wingman quiet on|off     wingman client   (confirm the proposed client)
  Finish:    wingman stop   (or: wingman stop --delete --yes)     wingman calls summary latest     wingman calls email latest
  Review:    wingman calls list | show <id> | rate <id> <card> y|n | purge <id> --yes

COMMANDS
  status                       App running? Call phase, health, last readiness check, Plan. Exit 3 when the app is not running.
                               While a call stops it shows the step (saving the call, writing the summary, finishing); --json: call.stopPhase.
                               call.listeningForQuestion = Ctrl+Opt+A is armed (call.questionSecondsLeft = seconds left in that window); call.aiMode = ai | prepared-only.
  doctor [--offline]           Readiness check, the same as Run readiness check in the app (microphone, audio, speech service, model). Full check costs a few cents and is refused while a call runs.
                               --offline: no audio, no network, no cost.
  plan [show]                  Show the Plan for the next meeting and its background files.
  plan set|prepare  [--who ..] [--goal ..] [--kind client|support|vendor|team|consult|personal|other] [--topic ..]
                    [--note ..]... [--add-note ..]... [--must ..]... [--add-must ..]... [--fresh]
                               Create or edit the Plan. Fields you leave out are kept (--fresh starts over). --must items become a checklist.
                               The Plan is used for ONE call and expires after 6 hours.
  plan attach --file <.txt|.md|.pdf> | --text "<text>" | --stdin     Background the AI may read (2 MB per file, 40,000 characters in total).
  plan detach <file id>        plan clear      Remove one background file / the whole Plan.
  start [--practice] [--no-ai] [--no-wait]    Start a call in the app. --practice = offline pretend client. --no-ai = Prepared cards only (no AI).
  stop [--delete --yes] [--no-wait] [--no-summary]
                                              Stop and save. --delete erases the call and needs --yes. --no-summary keeps the call but
                                              skips the summary (write it later: wingman calls summary <id> --generate).
  confirm --yes                Only when the optional "Ask me before listening starts" setting is on (off by default): starts listening
                               on a call that is waiting (the "Start listening" step). Do it only when Dan asked. (Old name: consent.)
  client                       Confirm the proposed client (the AI may then use their details).
  quiet on|off                 Quiet mode: hide cards in the answer window (they are still saved).
  note "<text>"                Add a context note for the AI (max 300 characters; \`-\` reads stdin).
  ask "<question>"             Type a question to Wingman during a live call; the answer appears as a card (read it with \`wingman live\`). Needs phase "live".
  ask --listen                 Same as the Ctrl+Opt+A key: Dan's next spoken sentence is the question.
  live [--follow] [--last N] [--id <call>] [--timeout S]     Transcript with answer cards (NDJSON with --json --follow).
  calls list [--limit N] | show <id|latest> [--lines N] [--no-transcript] | summary <id> [--generate] | email <id>
        | rate <id> <card id> y|n|clear | purge <id> --yes
                               --generate writes a missing summary (one small paid model call).
  settings list [--all] | get <key> | set <key> <value|default> [--advanced]     Same options and limits as the app's Settings. Applies to the next call.
  keys status                  Present or missing for each API key. Nothing else: keys are never printed, set or moved from here
                               (use \`pnpm keys\` in a terminal or the app's Settings > Keys).
  app status | app open        Is the app running / open /Applications/Wingman.app (only when you run it explicitly).
  help [--json]

EXIT CODES
  0 ok   1 failed   2 bad usage or invalid value   3 app not running   4 refused (wrong state, e.g. no live call, or a call is already running)
  5 not found   6 needs --yes   7 not ready (readiness check NOT READY, keys missing)   8 rate limited (start/stop: 1 per 1.5 s, 6 per minute)   9 timeout

SAFETY
  - The app listens on an owner-only socket (~/.config/wingman/run/control.sock, mode 600). Only a fixed list of commands is accepted.
  - Output never contains API keys. Destructive commands (stop --delete, calls purge, confirm) need --yes.
  - Do not start a real call unless Dan asked for it in this session. Use --practice to test.
`;
