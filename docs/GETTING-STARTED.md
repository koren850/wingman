# Getting started

For someone who has just found Wingman and wants to see it work, then use it on a real call, then make their own answers. About 15 minutes for Part 1, a few more for the rest.

Three parts:

1. [Try it with no keys](#part-1-try-it-with-no-keys): install, run the offline demo, run the checks. Nothing is sent anywhere.
2. [Use it with keys](#part-2-use-it-with-keys): add a Deepgram key and an Anthropic key, do a practice call, then a real one. Needs the Mac app.
3. [Make your own pack](#part-3-make-your-own-pack): write your own answer cards and check them.

Commands in Part 1 and Part 3 were run on macOS (Apple silicon, Node 24, pnpm 11) when this guide was written. The output shown is copied from those runs and trimmed.

## Part 1: try it with no keys

### 1. Get the code

```bash
git clone https://github.com/koren850/wingman.git
cd wingman
```

### 2. Check your Mac

```bash
./install.sh --check
```

This only reports. It changes nothing. On a ready Mac you see:

```text
== Checking this Mac (nothing is changed)
  ok    macOS 27.2 (14.2 or newer needed for system audio)
  ok    CPU: Apple silicon (arm64)
  ok    Node 24.21.0
  ok    pnpm 11.22.0
  ok    ffmpeg (/opt/homebrew/bin/ffmpeg)
  warn  pdftotext not found: optional, only needed to attach PDFs to a meeting.  brew install poppler
  ok    git
```

A `MISSING` line tells you what to install. The `pdftotext` warning is fine: you only need it to attach PDF files to a meeting. Node is never installed for you. See [Troubleshooting](TROUBLESHOOTING.md#node-is-too-old) if Node is too old.

### 3. Install the dependencies

For the full app (menu-bar app and answer window), run `./install.sh` and answer its questions. For this part you only need the code, so you can skip the Electron download:

```bash
cd app
WINGMAN_SKIP_APP=1 pnpm install
```

### 4. Run the demo

```bash
pnpm demo          # an English call
pnpm demo --he     # the same story in Hebrew
```

The demo plays a scripted call through the real engine. The speech and the AI are scripted, so it needs no keys, no network and no microphone. It takes about a minute and a half, because it plays the call at call speed. The call is invented: a client called Dana (from a made-up shop) asks about a slow site, backups and a price. The default call is in English; `--he` plays a Hebrew call. Wingman handles both, and calls that mix them.

You see the cards as they would appear in the answer window. This is a trimmed copy of the real output:

```text
Wingman · call 01M6VSSNZZQHB9VDE16GRS1FX9 · file .../silence.wav · 41 prepared cards

[🗂 fact] Acme Stores Ltd
   • acmestores.com · wordpress 6.9 · PHP 8.3

[🧭 call] Client · Slow site and backups · 0/5

[📗 prepared] A slow site is usually heavy images, missing cache, heavy plugins or a weak server. We check the cause first and then fix it.
   • Common causes: images, plugins, server
   • Measure before and after
   • Not always the server

[📗 prepared] Yes, we can work with automatic backups of the files and the database, and restore from them if something goes wrong.
   • Files and database
   • Keep a copy off the server
   • Frequency depends on the plan

[💡 tip] Ask where the backups are stored today and who is responsible for them.

[📗 prepared] The price depends on the scope and the requirements. I need to look at the details and I will come back with a clear quote.
   • Depends on scope and requirements
   • No number without details
   • Come back after checking

[📋 phone] 054-1234567
[📋 email] dana@acmestores.com

Speed: 4 questions · first card p50 0.3s / p95 0.3s · Prepared cards 3 (p50 0.3s)
Cost: AI $0.000 of $2 · STT $0.00 · total $0.00 (estimate from settings budget.prices)

📋 Call summary
  • The client called because her site loads slowly
  • She asked about backups for the site
  • She left a phone number and an email for the reply
  Next steps:
    - Me: Find out why the site is slow
    - Client: Send access to the site (this week)
```

The Hebrew call (`pnpm demo --he`) prints the same kinds of lines in Hebrew. Trimmed:

```text
Wingman · call 01M6V9ST8H6K7V8ETV1W7RJESV · file .../silence.wav · 41 prepared cards

[🗂 fact] אקמה סטורז בע"מ
   • acmestores.co.il · wordpress 6.9 · PHP 8.3

[🧭 call] לקוח · אתר איטי וגיבויים · 0/5

[📗 prepared] אתר איטי בדרך כלל נובע מתמונות כבדות, חוסר ב-cache, תוספים כבדים או שרת חלש. נבדוק מה הגורם ואז נטפל.
   • הגורמים הנפוצים: תמונות, תוספים, שרת
   • בודקים מהירות לפני ואחרי שינוי

[📗 prepared] המחיר תלוי בהיקף ובדרישות. אצטרך לבדוק את הפרטים ואחזור עם מחיר מסודר.
   • תלוי בהיקף ובדרישות
   • לא נותנים מספר בלי פרטים

[📋 phone] 054-1234567
[📋 email] dana@acmestores.co.il

Speed: 4 questions · first card p50 0.3s / p95 0.3s · Prepared cards 4 (p50 0.3s)
Cost: AI $0.000 of $2 · STT $0.00 (estimate from settings budget.prices)

📋 סיכום השיחה
  • הלקוחה פנתה בגלל אתר שנטען לאט
  • שאלה על גיבויים לאתר
  • השאירה טלפון ומייל לחזרה
  צעדים הבאים:
    - אני: לבדוק את סיבת האיטיות
    - לקוח: לשלוח גישה לאתר (השבוע)
```

How to read it:

| Label | Meaning |
|---|---|
| `📗 prepared` | A card from your answer pack, picked by keywords. Local, instant. |
| `🗂 fact` | A fact about a known client, from a local snapshot. |
| `🧭 call` | About the call: what kind of call, the topic, and a checklist (`0/5` done). |
| `📋 phone`, `📋 email` | Captured from what the other side said. In the app you copy them with a hotkey. |
| `Speed` | How long after the question the first card appeared. The demo timing is scripted, so it is not a speed test. |
| `Cost` | The demo uses no real AI, so it costs nothing. The `$2` is the default cap for one call (`budget.maxUsdPerCall`). |

Look at the price question. The client asks "how much" and Wingman shows a safe line, never a number. That is the main idea of the project: the answer is something you can say, and it never promises a price, a date or a result. [EXAMPLES.md](EXAMPLES.md#c-what-the-guards-do) shows what the guards block and why.

The demo writes to a temporary folder and deletes it at the end. It also ignores your own settings file, so it looks the same on every machine.

### 5. Run the checks

```bash
pnpm eval
```

This runs the quality checks on the question detector, the answer matcher and the guards. No keys, no network. Output:

```text
metric                                          count    now     baseline    
----------------------------------------------  -------  ------  --------  --
detector, questions.tsv (n=60): precision       30/30    100.0%  100.0%    ok
detector, questions.tsv (n=60): recall          30/30    100.0%  100.0%    ok
detector, QA scenario turns (n=217): precision  128/132  97.0%   97.0%     ok
detector, QA scenario turns (n=217): recall     128/128  100.0%  100.0%    ok
bank, top-1 right (n=40)                        37/40    92.5%   92.5%     ok
bank, wrong card                                1/40     2.5%    2.5%      ok
bank, no card                                   2/40     5.0%    5.0%      ok
guards, blocked with the right rule (n=76)      76/76    100.0%  100.0%    ok
guards, false positives (n=53)                  0/53     0.0%    0.0%      ok
salary guard, blocked (n=12)                    12/12    100.0%  100.0%    ok
salary guard, false positives (n=6)             0/6      0.0%    0.0%      ok
```

`now` is this run. `baseline` is the number saved in `app/qa/eval-baseline.json`. The command fails if a number gets worse than the baseline. Below the table it lists the "known misses": the few sentences the checks get wrong today, so you can see the limits.

You can also run the unit tests with `pnpm test:unit`.

## Part 2: use it with keys

This part needs the Mac app and two paid accounts, so it is described from the code and the other docs rather than from a recorded run.

### 1. Get the keys

| Key | What it does | Where to get it |
|---|---|---|
| Deepgram | Turns speech into text | Sign up at [console.deepgram.com/signup](https://console.deepgram.com/signup), then create a key in the console |
| Anthropic | The AI that writes answers and the summary | Create an account at [platform.claude.com](https://platform.claude.com), add credit under Billing, create a key under [Settings, API keys](https://platform.claude.com/settings/keys) |

Cost: about $1.40 an hour for speech plus roughly 5 to 20 cents an hour for the AI (about $1.50 in total, an estimate). Set a spend limit in both consoles too. Wingman has its own cap per call (`budget.maxUsdPerCall`, $2 by default).

### 2. Install the app

```bash
cd wingman
./install.sh
```

The installer checks the Mac, installs the dependencies, builds `app/.app/Wingman.app` and offers to copy it to `/Applications` and add the `wingman` command. It never uses sudo. Safe to run again.

You also need a second screen for the answer window. With one screen the answer window refuses to open, so it cannot end up in a screen share. See [Troubleshooting](TROUBLESHOOTING.md#the-answer-window-does-not-open).

### 3. Put the keys in

Open **Wingman**. The first window is a guided setup. Step 1 asks for the two keys. Paste them there. They are stored in the macOS Keychain (service `wingman`), not in a file and not in the repo.

From a terminal you can do the same. The key is typed at a hidden prompt, never as an argument:

```bash
cd app
pnpm keys set deepgram
pnpm keys set anthropic
pnpm keys status
```

`pnpm keys status` says only whether each key is present. It never prints a key.

### 4. Finish the setup guide

The guided setup has three steps: **Try it** (a practice call), **Connect** (your keys) and **Allow** (microphone, System Audio Recording and your screens; quit and reopen Wingman after you allow System Audio Recording). Below them, **Make it yours (optional)** has your name, your privacy choices (ask before listening starts, Deepgram model-training opt-out), the microphone, starter answers and the Readiness check. Details are in the [User guide](USER-GUIDE.md#first-run).

The Readiness check tests the mic, the system audio, the keys, the speech service and the AI. It ends with `READY`, `READY WITH WARNINGS` or `NOT READY`, and tells you what to fix. The full check costs a few cents. From the terminal, `pnpm run doctor --offline` runs the free part only.

### 5. Do a practice call

Press **Practice call** in the setup guide (or on Home). A pretend client plays through the real call loop and the real answer window. It is free and nothing leaves your Mac. It is the invented call from `pnpm demo`, now in the real window: in English when the interface language is English (`ui.language: en`), in Hebrew otherwise (the call from `pnpm demo --he`).

What you see:

![The answer window: the newest answer large, older ones small](ux/answer-window-hero.png)

- The **answer window** (second screen): the newest card is large, older cards get smaller. Each card has a label: Prepared (from your pack), AI, Buy time (a safe stalling line), Tip, For you (an answer to something you asked), Math. Bars at the top show problems, such as the other side not being heard. Capture chips show phone numbers, emails and domains.
- The **Wingman window** (Home, Calls, Settings): the live call, the readiness state, and after the call the summary and a follow-up email draft.

![The Wingman window, Home page](ux/home-window.png)

### 6. Start a real call

Press **Quick call** on Home, or from a terminal:

```bash
wingman start --quick
```

The app asks you in a window to confirm a call started from the command line. Then talk, or join your call. When it ends, press **Stop call**. Wingman saves the transcript and writes a summary. Everything is in `~/Library/Application Support/Wingman/calls/`. See [EXAMPLES.md](EXAMPLES.md#d-a-call-summary-and-follow-up-email) for what the summary looks like.

Tell the people you talk to that you use a call assistant if the law or your rules ask for it. See [Privacy and security](PRIVACY-AND-SECURITY.md).

## Part 3: make your own pack

A **pack** is plain files: your answer cards, your tone rules and two word lists. The format is in [PACK-FORMAT.md](PACK-FORMAT.md). A worked, tested example is in [EXAMPLES.md](EXAMPLES.md#a-a-full-pack).

### 1. Copy a starter pack

In the app: **Settings, Setup guide, Answer pack**. Pick a starter (sales, customer support, job interview practice, an empty pack, or the web hosting example) and press **Copy to my folder**. The starters are in Hebrew, with English text for English calls. Or by hand (swap `example-pack` for `starter-packs/sales`, `support`, `interview` or `empty`):

```bash
mkdir -p ~/.config/wingman/pack
cp -R app/data/example-pack/. ~/.config/wingman/pack/     # run from the repository root
```

Wingman looks in `~/.config/wingman/pack/` first (or in the folder named by `WINGMAN_PACK_DIR`), then in the example pack, file by file. Copy all five files so none of the invented example text mixes in.

### 2. Edit `bank.yaml`

One card looks like this:

```yaml
- id: backups
  title: Backups
  triggers: [backup, backups, restore, "do you have a backup"]
  say: Yes, we can set up automatic backups of the files and the database, and restore from them if something goes wrong.
  facts: [Files and database, Keep a copy off the server, How often depends on the plan]
```

Write what people really say in `triggers`. Write `say` as one or two short sentences you would say out loud. No prices, no dates, no promises.

### 3. Check that it loads and matches

To test a pack in a folder without touching your real one, point `WINGMAN_PACK_DIR` at it. From `app/`:

```bash
WINGMAN_PACK_DIR=/path/to/my-pack ./node_modules/.bin/tsx -e '
import { loadBank, matchBankFor } from "./src/bank.ts";
const bank = loadBank();
console.log(bank.length + " cards loaded");
const hit = matchBankFor(process.argv[1], bank);
console.log(hit ? hit.card.id + ": " + hit.card.say : "no card");
' "do you have a backup"
```

With the example pack from [EXAMPLES.md](EXAMPLES.md) this printed:

```text
7 cards loaded
backups: Yes, we can set up automatic backups of the site and the database, and restore from them if something goes wrong.
```

A broken card stops with a clear error, for example `bad bank card: {"id":"x"}` for a card with no `say` and no `triggers`. Duplicate ids are errors too.

Try a few real sentences. If the wrong card appears, add a longer phrase to the right card. A phrase of several words counts for more than one word.

### 4. Add the other files

- `bank.en.yaml` for English versions of the cards.
- `house-style.md` for tone and never-say rules, sent to the AI.
- `keyterms.txt` with product names and tech words, to help speech to text.
- `topics.txt` with words that mean "this call is about my work".

All of them are explained, with examples, in [EXAMPLES.md](EXAMPLES.md).

### 5. Run the Readiness check

In the app, **Home, Run readiness check**. It shows how many cards loaded, whether the ids are unique, and which files still come from the example pack. Changes apply to the next call.

Next: [Examples](EXAMPLES.md) · [User guide](USER-GUIDE.md) · [Pack format](PACK-FORMAT.md)
