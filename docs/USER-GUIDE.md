# User guide

For people who have installed Wingman and use it on calls. It covers everyday use after it is installed: what Wingman does, the first run, the windows, the review step before a call, call kinds and modes, updating, where your files live, profile and pack, practice and prep mode, group call mode, words used in Wingman and the command line. For install and requirements see the [README](../README.md); for a first walk-through see [Getting started](GETTING-STARTED.md); for every setting and hotkey see [app/README.md](../app/README.md).

Contents: [What Wingman does](#what-wingman-does) · [First run](#first-run) · [Tour of the windows](#tour-of-the-windows) · [Before a call: What Wingman knows](#before-a-call-what-wingman-knows) · [Call kinds and modes](#call-kinds-and-modes) · [The menu-bar menu](#the-menu-bar-menu) · [Update and uninstall](#update-and-uninstall) · [Where your files live](#where-your-files-live) · [Profile and pack](#profile-and-pack) · [Practice and prep mode](#practice-and-prep-mode) · [Group call mode](#group-call-mode) · [Words used in Wingman](#words-used-in-wingman) · [Command line](#command-line)

## What Wingman does

Wingman is a live agent for your meeting. You can give it context before the meeting (optional). During the meeting it builds context by itself, like a Claude session that listens: who is there, what was decided, which numbers were said, what you promised, what is still open. From what happens it shows short cards in the answer window.

A **moment** is a point in the call where a short private nudge would help: a question, an objection, a number that does not fit, a term you may not know, a promise, a topic you planned to cover. Wingman checks the call after each line and decides if a card helps. Most lines are not a moment and get no card.

**Live reading** is the default help engine. **Classic** is the older mode that reacts to questions only; it is a rollback in Settings, Advanced, and it is also what runs when the AI is down. **Scripted** and **recorded** are words you will see in the docs: a scripted number comes from test replies written in advance and shows that the parts work; a recorded number comes from the real AI. Wingman has no recorded quality numbers for live reading yet ([ROADMAP](ROADMAP.md)).

## First run

Open **Wingman** (Spotlight or Launchpad). The first window is a guided setup with three steps. The chip at the top shows your progress, for example "2 of 3".

1. **Try it.** A practice call: a pretend client plays through the real call loop and the real answer window. Free, no keys, and nothing leaves your Mac.
2. **Connect.** Paste your Deepgram and Anthropic keys. They go into the macOS Keychain. Press **Test** to check each one. The step shows the cost: about $1.40 per hour of call for Deepgram plus roughly 5 to 20 cents an hour for Anthropic.
3. **Allow.** Allow the microphone and System Audio Recording. After you allow System Audio Recording, **quit and reopen Wingman**: macOS gives no live status for it. Then choose your screens. Wingman shows its answers in a small window on a second screen, because that window must never be in your screen share. With one screen the answer window stays closed (the call still works, and every answer is saved in the Wingman window). You can allow the window on your one screen, but then never share that whole screen.

Then it says "You're ready". Press **Quick call**, or **Start** on a saved meeting. The way to your first real card is three steps on screen: Connect (keys), Allow (microphone and system audio, then quit and open Wingman once) and Try it (a free practice call).

**Meeting context (optional).** Choose **Add meeting context** to give Wingman background before a call: paste an invite, an email or notes, or drop a .txt, .md, .pdf or .ics file. Under **More details** you can add who is joining, the goal and what you must cover. **Prepare** shows what Wingman understood; you can fix or remove any line. A saved meeting stays until you delete it and can start many calls. The window language is under Settings, Window language (English, Hebrew, or the system language).

The Wingman window itself is in English only. The setting `ui.language` (Settings, Audio and screens) sets the language of the labels in the answer window: `auto` shows Hebrew unless the speech language is English; `he` and `en` force one.

Below the three steps is **Make it yours (optional)**. Nothing in it is needed to start, and each item can be skipped:

- **About you.** Your name and how to address you. (Also in Settings later.)
- **Your privacy.** Two choices: ask before listening starts, and keep your audio out of Deepgram's model training.
- **Choose your microphone.** Pick the one you use. Avoid AirPods for the first call.
- **Starter answers.** Pick a starter (sales, customer support, job interview practice, empty, or the web hosting example). It is copied to your own folder and you edit the copy.
- **Run the readiness check.** Tests the mic, system audio, keys, speech service and the AI.

Every step can be skipped and reopened from **Settings, Setup guide**.

Without the app, from the terminal: `cd app && pnpm dashboard`. See [app/README.md](../app/README.md) for all commands, settings and hotkeys.

Notes:
- `pnpm run doctor`, not `pnpm doctor` (the second one is pnpm's own command).
- Never put keys in the repo. They belong in the Keychain.
- No second screen yet? Turn on the one-screen option in the setup (step 3, Allow), and never share that screen.

## Tour of the windows

All pictures use invented data. The client, the numbers and the answers are made up.

### The answer window

This is the window you read during a call. Put it on the second screen. By default it uses the **Focus** layout: what they said, one big answer, one small line for the answer before it, and a **More** button. In **Settings, Answer window layout** you can switch to **Full**, which shows everything at once.

**Help engine (Settings, Advanced).** *Live reading (default)* lets the AI read the whole call and decide when a card helps: a question, an objection, a number that does not fit, a term you may not know, a point you planned to cover. Most lines get no card. A prepared card or a sum shows first; an AI card replaces it only if it is better. If you say a number that does not match your notes, you get a Check card. Live reading keeps a short memory of the call. The scripted cost model puts this part at about 3 US cents an hour; that is a model of the usage, not a measurement with the real AI. Settings, Money, has a soft cap per hour. *Classic (rollback)* shows a card when the other side asks a question. Use it only if live reading misbehaves. Practice interviews keep Classic. A change takes effect on the next call. If the AI is paused or down, Wingman falls back to prepared answers and a language-neutral check (a "?" from speech-to-text, digits, your name, the shape of the sentence); no AI is called. Measured offline, scripted: 60 of 68 answer moments in the 32 dev meetings still got a card.

<img src="ux/answer-window-en-ui.png" alt="The answer window in the Focus layout: the other side's last line, one big AI answer, a buy-time line, a More button and the key bar" width="520">

1. **Listening** (top): Wingman hears the call. It says **Paused** when you pause it. Next to it are two small dots: the first shows the call state, the last one is the health dot. Green means everything works, amber means something is degraded (for example a weak microphone), red means something is not working. Hover over it to read the reason.
2. **Other side**: the last thing the other person said.
3. **AI · unverified** (dashed border): the one big answer, written by the AI. Check it before you say it. A line starting "Answering:" shows which question it answers.
4. **Prepared** (green, not shown here): an answer from your own answer pack. You wrote it, so you can trust it more.
5. **Buy time**: the small line under the big card. It is the answer before this one. Here it is a safe line to say while you check a number. Wingman uses it instead of inventing a price or a date.
6. **More: 8** (Ctrl+Opt+L): opens the extra panel, shown next. It closes by itself after a while.
7. **Key bar** (bottom): Ctrl+Opt+A asks the AI, L opens More, P pauses. Press **?** to see all of them (R shows what they said, C clears, 1-3 copy a detail).
8. **Writing...**: while an AI answer is still arriving, its label says so. Wait until it stops before you read it out.

#### The More panel

<img src="ux/answer-window-more.png" alt="The answer window with the More panel open: numbered chips for a phone number, an email and a domain, a checklist, a client card and AI notes" width="520">

1. **Numbered chips** (Phone, Email, Domain): details heard in the call. Press Ctrl+Opt and the number to copy one.
2. **You have not talked about:** your checklist of topics still open.
3. **Levy Electronics** is the client card. **AI notes** are points the AI noticed.

In the Full layout all of this is on screen all the time.

#### Cards, chips and keys (answer window v3)

- **The card is the biggest thing on screen.** What they said is one small line above it. The card shows its line in full. A long line shows three lines and a **More** button; More opens the rest. A card never ends in a cut sentence.
- **A card Wingman is unsure about** becomes a chip, not a card. Wingman shows a card only when it is useful enough; the bar is higher for kinds of cards you rated down.
- **Chips** are the waiting cards. A chip shows its label, or the kind word (Answer, Check, Prompt, Fact) when it has no label. A fact chip reads "label: value". Every chip has a small mark for its kind, its age, and a bold dot while you have not seen it yet.
- **Old cards fade.** After 3 minutes an answer fades, its age turns amber, and a line "about: ..." says which question it answered. After 6 minutes an answer or a prompt becomes a chip. A Check and a pinned card stay until you handle them.
- **Check.** A new Check flashes amber and takes the card seat. The card it replaced moves to the chips.
- **Context** is one button with a count. It opens a small list: open questions, promises, topics not covered yet, and earlier cards. **Catch me up** is the one highlighted button.
- **Buttons on a card** (useful, not useful, more) appear when you point at the card, when the card has the keyboard focus, or when it is a minute old. Under the three dots: Pin, Copy, **Fewer like this** and Dismiss. Fewer like this tells Wingman that this kind of card was not worth showing. The card leaves, and Wingman raises the bar for that kind for the rest of the call. Undo brings the card back for 30 seconds. Wingman also remembers across calls which kinds of cards you rate down, and shows fewer of them. It keeps only counts, no text.
- **Keys.** The window never takes the focus by itself, so the global keys (Ctrl+Opt+S pin, H useful, X not useful, D dismiss, M more, Z undo, U catch me up) are the normal way. If you give the window the keyboard focus, Tab moves between the card, its buttons and the chips, with a clear ring. Enter opens More, Esc dismisses (or closes a list first), P pins, 1 and 2 rate.
- **Screen readers** hear a Check, and the first card after a quiet time of 90 seconds. Other cards are silent, so they do not talk over the call.
- **Key hints** at the bottom show for the first 3 cards you ever see. After that only a small ? stays; press it to see all keys.

### Home, before a call

**Start** is the one main button. If Wingman is not ready (a key is missing, or the readiness check failed), Start is off and a line under it says why in plain words, with a **Fix it** button. After a failed check, a small **Start anyway** link remains. Until you have saved a first call, **Practice call** sits next to Start. The next meeting is a row of the meetings list with a **Next** tag.

### Home, during a call

<img src="ux/home-window.png" alt="The Home view of the main window during a call, with the timer, a client suggestion, quiet mode and a note box" width="640">

1. **Timer and state**: how long the call has run, and whether Wingman is listening. The dot next to the timer is green while it listens, and amber or red if something needs attention.
2. **Looks like ... Confirm client**: Wingman guesses who the call is with. Press **Confirm client** if it is right. The AI then gets that client's details.
3. **Quiet mode**: hides the cards in the answer window. They are still saved for the review.
4. **Note for the AI** and **Ask Wingman**: type a short note, or ask a question. **Listen for my question** lets you ask by voice.
5. **Show conversation**: the live text is hidden so it does not appear if you share your screen.
6. **Stop call** ends the call. To remove a call and everything saved from it, use **Calls**, then **Delete call**.

### Calls

<img src="ux/calls-page.png" alt="The Calls page with the next call to review, the card usefulness meter and a table of calls" width="640">

1. **Next up**: the call that most needs you. **Review** opens it.
2. **Card usefulness**: how many useful cards you get per hour. It needs a few rated calls before it shows a result.
3. **Search transcripts**: find a word in all your calls.
4. **To do** column: **3 to rate** means three cards wait for a rating. **Summary** opens the written summary.

### One call: Summary

<img src="ux/call-detail-followup.png" alt="A finished call opening on the Summary tab: big Copy follow-up email and Copy summary buttons, the summary, next steps, decisions and the email draft" width="640">

1. **Live** or **Practice** shows what kind of call it was. **Delete call** removes it.
2. **Tabs**: **Summary**, **Rate** (mark each card useful or not), **Transcript**, **Missed questions** (questions with no card) and **Details**.
3. **Next steps**: tick them off when done. **Me** is for you, **Client** is for the other side.
4. **Follow-up email**: a draft written by the AI. Read it, then press **Copy follow-up email** (big button at the top; **Copy summary** is next to it). Placeholders such as `[fill in: ...]` are highlighted. The ended banner has an **Open summary** button, and a finished call opens on this tab. Rating cards (**Rate**) is optional. Wingman never sends anything.

### Setup guide

<img src="ux/setup-step.png" alt="The setup guide on the Home page: three steps (Try it, Connect, Allow) with the practice call open, then Make it yours (optional)" width="520">

1. **Set up Wingman** shows how many of the 3 steps are done ("2 of 3"). The first step, **Try it**, is a free practice call: a pretend caller talks to Wingman on your Mac, so you can see the windows before you pay for anything.
2. **Open** shows the details of a step. **Close** hides them again.
3. **Connect** has the two key fields (Deepgram and Anthropic). Paste a key, press **Save**, then **Test**. **Allow** covers the microphone, System Audio Recording and your screens.
4. **Make it yours (optional)** lists About you, Your privacy, Choose your microphone, Starter answers and the readiness check.
5. **Skip this step** is always allowed. You can come back from **Settings, Setup guide**.

The **Starter answers** item offers starter packs, so you do not begin with an empty folder:

<img src="ux/setup-starter-packs.png" alt="The Starter answers item open, with a Start from list: Sales, Customer support, Job interview practice, Empty pack and Web hosting example, and a Copy to my folder button" width="520">

1. **Start from**: pick the starter closest to your work. **Web hosting (example)** is the invented example Wingman uses until you choose.
2. **Copy to my folder** copies the starter to your own pack folder. You edit the copy there. **Keep the example for now** changes nothing.

## Before a call: What Wingman knows

If a meeting has context (pasted text, a file, a calendar event), Wingman shows **What Wingman knows** once, before the call starts. It lists who is joining, the kind of call, and the facts, each with the line it came from. Untick a line to leave it out, or edit it. A warning appears if two facts disagree, for example the same item with two different numbers. **Start without review** skips the step in one click. A meeting with no context goes straight to the call; that is a normal state, because Wingman learns from the call itself. The tray menu and the command line start a call without this step, because they have no window.

During the call the same lists grow in the live view (**So far**, **What Wingman knows**). You can fix or remove a line there too.

## Call kinds and modes

Wingman guesses the kind of call after about 20 words: client, support, vendor, team, consult, personal, interview (practice) or other. The kind sets how much Wingman says: a practice call gets an answer for every question; a team call gets fewer cards. The guess is shown on the **So far** card, in the review step and on a meeting row, as a guess. Choosing a kind yourself, a picker on Home and in the live view, locking the kind so a later guess cannot change it, and your own modes (up to 6, written in your pack, see [PACK-FORMAT](PACK-FORMAT.md#custom-modes)) are in this build.

## The menu-bar menu

The menu-bar icon has: **Open Wingman**, **Start quick call**, **Start prepared meeting**, **Start quick call without AI (Prepared cards only)**, **Prepare a meeting**, **Try a practice call (offline, free)**, **Start listening** (when you asked to be asked first), **Confirm client**, **Ask Wingman: my next sentence is for you**, **Catch me up: where we are**, **Add a note for the AI**, **Quiet mode**, **Stop call**, **Stop and delete this call**, **Run readiness check**, **Show log** and **Quit Wingman**. If you quit during a call, Wingman asks first; quitting stops the call, saves it and writes the summary (up to 20 seconds). If the engine does not answer to Stop, quitting ends it for you. The note window follows the interface language and works in the dark theme.

## Settings

Settings has five tabs: **Basics** (window language, About you, the setup guide), **Keys**, **Help engine**, **Privacy** and **Advanced** (every other setting, including Live reading or Classic). Plain words are used for every status, and a message that needs an action has a button for it (Open Keys, Allow microphone).

## Update and uninstall

```bash
wingman update                 # git pull (fast-forward only), install, rebuild the app
wingman uninstall              # removes the app copies and the wingman link; your data stays
wingman uninstall --purge      # also deletes your data and settings, after you type DELETE
```

The same work is done by `./install.sh --update` and `./install.sh --uninstall [--purge]`. The app starts from the folder you cloned. If you move that folder, run `./install.sh` again from the new place.

## Where your files live

Nothing about you is stored in this repository.

| Folder | What is there |
|---|---|
| `~/Library/Application Support/Wingman/` | Your data: `calls/` (transcripts, cards, summaries), `briefs/` (prepared meetings, with `briefs/attachments/`), `entities.json` (optional client snapshot). Override with `WINGMAN_DATA_DIR`. |
| `~/.config/wingman/` | `settings.yaml`, `profile.yaml`, `pack/`, and the old `keys.env` if you still have one. |
| macOS Keychain, service `wingman` | Your API keys. |

If you used an older version that kept calls in the repo folder (`calls/` and `data/private/` inside the repo folder, `stage0/`), the first start **copies** them to the new folder. It never moves or overwrites. The old folders stay until you delete them.

## Profile and pack

- A **profile** file (`~/.config/wingman/profile.yaml`): your name and spellings, how to address you in Hebrew, a short "about", your business and your time zone (for example `Asia/Jerusalem`). Set it in **Settings, About you**, or from the terminal (see `wingman help`):

  ```bash
  wingman profile set --name Dana --spelling Dana --address female --timezone Asia/Jerusalem
  wingman profile show
  ```
- A **pack** folder (`~/.config/wingman/pack/`, or `WINGMAN_PACK_DIR`): your answers (the file `bank.yaml`), house style, keyterms and topic words. Without one, the invented example web/hosting pack in `app/data/example-pack/` is used. File formats: [docs/PACK-FORMAT.md](PACK-FORMAT.md).
- **Build answers from your notes.** If you have an FAQ file, `pnpm run pack:from-notes <file.txt|.md|.pdf>` (in `app/`) drafts the cards for you into a separate folder. You read and fix them, then copy them into your pack. Prices, dates and promises in your notes become safe "I will check" cards. Details: [Build answers from your notes](PACK-FORMAT.md#build-answers-from-your-notes).

Do not confuse these with a **settings preset** (`app/profiles/<name>.yaml`, used with `--profile <name>`). A preset is a set of setting overrides, such as `first-client-call`. It has nothing to do with `profile.yaml`.

## Practice and prep mode

A mock-interview and practice coach: rehearse with your own notes, get suggested answers in your own words, and review after the call. It is not for live use in a real interview. Create a prepared meeting with kind `interview` (`wingman plan new --kind interview ...`; the kind is set from the command line). Attach your prep notes as background files.

In this mode:

- Every question gets an answer, with no card limit.
- There are no "Buy time" lines.
- Answers are built from your notes only, never invented experience.
- The AI may not write a salary figure. Salary comes only from your own prepared card.
- There are no fact cards and no self-check cards.
- To use your own prepared answers, add the meeting note `Prepared cards: /full/path/cards.yaml`. The file has the same format as the answer bank ([docs/PACK-FORMAT.md](PACK-FORMAT.md#cards-for-a-practice-meeting)). For that call it replaces the normal bank. Each meeting can point to its own file.

Real interviews and exams that forbid outside help are out of scope ([ADR 35](DECISIONS.md#adr-35-scope-no-real-job-interviews-or-exams)). You are responsible for following the rules that apply to you.

## Group call mode

For calls with several people on the other side (needs `stt.speakers`, on by default; turn it off with `flow.enabled: false`). The setting keys still start with `flow`.

- When two or more of them talk to each other and you are quiet, a muted line shows who is talking and about what. Answer cards wait (`flow.holdCards`). Price and date cards, and questions with your name, still show.
- When someone turns to you (says your name, or "you" right after their own discussion), an orange alert shows who.
- Nothing is kept between calls. Names only live for the call.

## Words used in Wingman

The window uses plain words. Some older docs, file names and settings keep the internal names. This table links the two. Names in files and settings did not change.

| Old or internal term | Name in the app | What it means |
|---|---|---|
| Bank, answer bank (`bank.yaml`) | Your answers | The answers you wrote before the call. Cards from it are marked **Prepared**. |
| Pack, answer pack | Starter answers / your answers folder | The folder of your answers, tone rules and word lists. |
| Bank card | Prepared | An answer from your own files. Local and instant. |
| AI card | AI · unverified | An answer written by the AI. Check it before you say it. |
| Stall line | Buy time | A safe line to say while the real answer is found. |
| Moment | (not shown) | A point in the call where a short private nudge would help. The engine decides moment by moment if a card is useful. |
| Live reading, `moments.engine: v2` | Live reading (default) | The AI reads the call as it grows and decides when a card helps. |
| Classic, `moments.engine: legacy` | Classic (rollback) | The older mode that reacts to questions. Also what runs with no AI. |
| Scripted, recorded | (docs only) | A number from replies written in advance, or from the real AI. |
| Call frame | About the call | What kind of call it is, its topic and goal, and a checklist of what to cover. |
| Frame kind | Client, Support, Vendor, Team, Consult, Personal, Interview, Other | The kind of call. |
| Flow mode | Group call mode | Several people on the other side: cards wait while they talk to each other. |
| Capture chip | Detail 1 to 3 (phone, email, domain) | Details Wingman picked up, ready to copy. |
| Reflex | Answers (in the cost table) | The part that writes answers while someone speaks. |
| STT | Speech to text | Turns the call audio into text. Shown as a cost. |
| LLM | AI | The model that writes answers. Shown as a cost. |
| Haiku tag | AI decision | What the AI chose for a question: No card, Buy time, Prepared or AI. |
| Latency | Time to answer | How long after the question a card showed. |
| Degrade ladder, rung | Health bar | The steps Wingman takes when something is slow or down. |
| Brief, plan, prepared meeting | Plan, prepared meeting | The notes for one specific call. |
| Doctor | Readiness check | Tests the microphone, system audio, keys and services. |

## Ask the call and Catch me up

- **Catch me up** (Ctrl+Opt+U): a sheet with five lines: where we are, decided, open, you promised, they asked of you. It fills in about two seconds. `wingman recap` prints the same in the terminal.
- **Ask the call**: type `ask what did they say about the deadline?` or run `wingman ask "..."`. Wingman looks in what it learned in the call, then in the transcript, then uses general knowledge. If the call does not say, it says so. It never invents a number.
- **Follow-up**: `wingman followup` prints a draft message for the other side from the saved call. Prices, dates and promises show as `[fill in]` for you to complete.
- **Pre-meeting digest**: `wingman digest` reads pasted notes and files and finds people, agenda, facts and likely questions. This is optional. With no AI, the raw text is kept as background.
- **Meeting context box**: one box for everything Wingman should know before a call. Paste text, drop a file (.txt, .md, .docx, .eml, .pdf, .ics), type a web address, or press "Use my next calendar event". Below the box, "Wingman understood: ..." says what it took from it, and "What Wingman knows" lists each fact with where it came from. You can remove any fact.
- **Web addresses and calendar**: only public https pages are read (8 seconds, 1 MB). Addresses inside your network are refused. For the calendar, paste the private .ics address from your calendar settings into Settings, "My calendar address". Wingman picks the meeting nearest to now, shows it, and uses it only after you say yes. A `.docx` file needs the `unzip` tool, which macOS and Linux have.
- **Last time**: when a person on the call was on an earlier call, the new call starts with up to 5 short notes (open promises first, then the last topic). The first time that person is named, one Fact card may show a note. This is local and uses no AI call. Turn it off with "Remember people from earlier calls".
- When the AI is offline, answers come from your notes and are labelled "AI offline: from notes".

## Command line

```bash
cd app
pnpm -s wingman help         # full help
pnpm -s wingman status       # is the app running, is a call live
pnpm -s wingman start --practice
pnpm -s wingman start --quick           # no Plan; or: wingman plan list, then wingman start --plan <id>
```

After `./install.sh` you can type `wingman ...` from any folder.

A prepared meeting for a client call, then a start (these talk to the running app, so open Wingman first):

```bash
wingman plan new --title "Hosting move" --at "2026-11-03 14:30" --who "Dana, Levi Studio" --kind client \
  --topic "hosting move" --goal "agree migration date" --must "price" --must "downtime window"
wingman plan list                  # shows the id of each meeting
wingman start --plan <id>          # or: wingman start --quick
wingman live --follow              # transcript and cards in the terminal
wingman stop                       # saves the call and writes the summary
wingman calls summary latest       # read the summary
```

The `wingman` command talks to the running menu-bar app over an owner-only local socket. It cannot read API keys. By default the app asks you in a window before it starts a real call that came from the command line (setting `privacy.askBeforeCliStart`), and before it deletes a call.

Next: [Examples](EXAMPLES.md) · [Pack format](PACK-FORMAT.md) · [Troubleshooting](TROUBLESHOOTING.md) · [Privacy and security](PRIVACY-AND-SECURITY.md)
