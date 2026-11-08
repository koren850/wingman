# Pack format

For anyone who wants Wingman to answer in their own words about their own business. A **pack** is the business content Wingman answers from: your answer cards, your tone rules, and word lists. It is plain files. Nothing in a pack goes into the repo. A complete small pack, explained line by line, is in [EXAMPLES.md](EXAMPLES.md#a-a-full-pack) (the files are in [`docs/examples/studio-pack/`](examples/studio-pack/)).

## Where Wingman looks

For each file, in this order:

1. The folder in `WINGMAN_PACK_DIR`, if you set it. Otherwise `~/.config/wingman/pack/`.
2. `app/data/example-pack/` (an invented web and hosting example).

The lookup is **per file**. If your pack has `bank.yaml` but no `topics.txt`, the example `topics.txt` is used. That would mix invented example words into your setup, so the Readiness check lists every file that falls back. Copy all the files you need into your pack.

The easy way: open the app, **Setup guide, Starter answers**, pick a starter and press **Copy to my folder**. Starters (in `app/data/starter-packs/`, all invented, in Hebrew with English versions in `bank.en.yaml`): sales (B2B software), customer support, job interview practice (practice mode only), and an empty pack with only the safe "check and come back" cards. The web hosting example is the fifth choice. Then edit the copies. Changes apply to the next call.

## The files

| File | What it is | Needed |
|---|---|---|
| `bank.yaml` | Your answer cards (below) | Yes |
| `bank.en.yaml` | English versions of the cards | No |
| `house-style.md` | Tone and never-say rules, sent to the AI | No, but write it |
| `keyterms.txt` | Words that help speech to text hear your terms | No |
| `topics.txt` | Words that mean "this call is about my own work" | No |
| `modes.yaml` | Your own call modes (up to 6), see [Custom modes](#custom-modes) | No |

## bank.yaml

A list of cards. Each card:

```yaml
- id: backups
  title: Backups
  triggers: [backup, backups, restore, "do you have a backup"]
  say: Yes, we can set up automatic backups of the files and the database, and restore from them if something goes wrong.
  facts: [Files and database, Keep a copy off the server, How often depends on the plan]
```

| Field | Rule |
|---|---|
| `id` | Required. Unique. Short, lower case, with dashes. |
| `title` | A short name. Shown to the AI and in lists. |
| `triggers` | The field must be there (it can be empty, for a card only the AI picks). Words or phrases. **They are hints, not the only way in:** Wingman also scores the question against each card's `title`, `triggers` and `say` text (word match and 3-letter pieces, so a paraphrase can find a card). An exact trigger is fast and wins ties. Add triggers for the words people really say; a good title and `say` line already help. |
| `say` | Required. What you can say out loud. One or two short sentences. |
| `facts` | A few short bullets shown under the answer. |
| `alts` | Optional. Other ways to say it. Used by stall cards, in turn, to avoid sounding canned. |
| `tags` | Optional labels. |
| `priority` | Optional number. Breaks a tie between two cards that match equally. |

How matching works:

- It is local and instant. No AI call.
- A phrase of several words counts for more than a single word. A single word counts for less.
- Spelling variants are handled: Hebrew prefixes and final letters, plural endings. Write the phrases people actually say. Add the way speech to text might spell a term (for example a term written in Hebrew letters).
- If two cards match, the stronger match wins.
- A file with a missing `id`, `say` or `triggers`, or with a repeated `id`, does not load. The Readiness check tells you.

Special cards:

- `stall` is the generic "I will check and come back" line. It is also what replaces an AI answer that a guard blocks. It needs few triggers, or none. It can have `alts`, other ways to say it, used in turn so repeated stalls do not sound canned. If your bank has no `stall` card, Wingman uses a built-in Hebrew line.
- `stall-price`, `stall-timeline` and `stall-guarantee` always win when they match. A question about price, time or a promise gets a safe stalling line, never a topical answer. The AI cannot replace them.
- Do not put prices, dates or promises in any card. The guards block them in AI text, but your own cards are shown as written.

## bank.en.yaml

English versions, keyed by card id:

```yaml
backups:
  say: Yes, we can set up automatic backups, and restore from them if something goes wrong.
  facts: [Files and database, Keep a copy off the server]
  alts: ["We can restore from a backup if needed."]
```

When the other side speaks English, a card with an entry here is shown in English. A card with no entry is not shown in English: the AI answers in English instead. The file sits next to the bank file and has the same name with `.en` added.

## house-style.md

Free text. It is sent to the AI with every answer, so write rules it can follow. The example pack shows the shape: tone, then a "Never say" list (no prices, no dates or timelines, no promises, no blaming the client), then good and bad examples.

Keep it short. Long files cost money on every call.

## keyterms.txt

One term per line. Every non-empty line counts, so do not add comment lines. These are sent to the speech service as hints. Put in the English product names and tech words that appear inside your calls (for example `WordPress`, `Cloudflare`).

At most `stt.keyterms.max` terms are sent (100 by default). To use a file somewhere else, set `stt.keyterms.file` to a path (absolute, or starting with `~/`; a relative path is read from the `app/` folder).

## topics.txt

Words that mean "this call is about my own work". One word or phrase per line. Lines starting with `#` are comments.

```text
# loose list
website
hosting
=dns
[strict]
wordpress
```

- A line starting with `=` matches only as a whole word.
- Lines under `[strict]` are the unmistakable terms. Only these count on supplier and team calls. The loose list is everything above `[strict]` plus the strict terms.
- No file means no topic words. Then nothing counts as your own work.

Whole-word matching works for Hebrew too.

## Custom modes

A **mode** tells Wingman how to behave for one kind of call: how much to say, and what to look for. The built-in kinds are client, support, vendor, team, consult, personal, interview and other. If none fits, write your own in `modes.yaml` in your pack folder. This file is read at the start of a call. A missing or broken file means no custom modes, and a bad entry is skipped, never fatal.

```yaml
- id: renewal
  label: Renewal call
  instructions: >
    This is a renewal call. Watch for price pressure, a competitor name and any
    date the customer gives for a decision. Prefer Check and Prompt cards.
  minValue: 3        # optional, 1 to 3: the least value a card needs to show
  maxPerMinute: 2    # optional, 1 to 6: cards a minute before a card becomes a chip
```

| Field | Rule |
|---|---|
| `id` | Required. Lower case letters, digits and dashes, up to 24 characters. It may not be a built-in kind (or `auto`), and each id appears once. |
| `label` | The name in the mode picker. Up to 40 characters. Defaults to the id. |
| `instructions` | Required. Up to 600 characters. Plain English or Hebrew. It is added to the moment prompt as text from you: angle brackets and ampersands are escaped, control characters are removed. It cannot switch off the guards. |
| `minValue`, `maxPerMinute` | Optional whole numbers in the range shown above. |

At most 6 modes are used. A mode never lets a price, date or promise through: the guards run after every mode. A prepared meeting stores its mode. A locked mode is not changed by Wingman's later guess about the kind of call.

Choose a mode in a live call with `mode <id>` through the control socket, or `mode auto` to let Wingman guess again. An unknown id is refused. There is no example file in the example pack, so nobody gets a mode they did not write.

## Cards for a practice meeting

A practice meeting (kind `interview`) can have its own cards, in the same format as `bank.yaml` (and an optional `.en.yaml` file next to it). Save the file anywhere you like, then add this note to the meeting:

```bash
wingman plan set --id <id> --add-note "Prepared cards: /full/path/to/my-interview-cards.yaml"
```

Use the full path. For that call these cards **replace** the normal bank. Card text is yours, so a salary answer can live here: the AI is never allowed to write a salary figure. See [Practice and prep mode](../app/README.md#practice-and-prep-mode-kind-interview).

## Build answers from your notes

If you already have an FAQ or notes (a `.txt`, `.md` or `.pdf` file), Wingman can draft the cards for you. From `app/`:

```bash
pnpm run pack:from-notes ~/notes/faq.md --lang he --out ~/Desktop/pack-draft
```

(`wingman pack from-notes ...` does the same.) It reads the file, makes one call to the model from your settings (`summary.model`, or `--model provider:model`), and writes `bank.yaml` and `bank.en.yaml` into the folder. This costs a few cents. A PDF needs the `pdftotext` tool; if you do not have it, save the notes as `.txt`.

What to know:

- It is a **draft**. The default folder is `./pack-draft`, never your live pack. Read every card, fix the words and the triggers, then copy the files into your pack folder. It will not replace existing files unless you add `--force`.
- `--lang he` or `--lang en` sets the language of the cards. Without it, Wingman picks from the text. A Hebrew draft also gets English text for each card.
- It follows your `house-style.md` and uses only what is in your notes.
- The guards check every card. If the answer in your notes is a price, a date or a promise, the card is not kept as an answer. Its triggers move to `stall-price`, `stall-timeline` or `stall-guarantee`, so that question gets a safe "I will check and come back". The command lists every card it changed this way. A fact or alternative line with a price is left out. A card with no answer or no triggers is dropped, and the command says so.
- The four safe stall cards are always added.
- Your notes go to the model company you chose. Do not use notes you cannot share.

Notes that are already in question and answer form work best.

## Check your pack

To test cards without the app, point `WINGMAN_PACK_DIR` at a folder and ask which card a sentence picks (run from `app/`):

```bash
WINGMAN_PACK_DIR=/path/to/my-pack ./node_modules/.bin/tsx -e '
import { loadBank, matchBankFor } from "./src/bank.ts";
const bank = loadBank();
console.log(bank.length + " cards loaded");
const hit = matchBankFor(process.argv[1], bank);
console.log(hit ? hit.card.id + ": " + hit.card.say : "no card");
' "do you have a backup"
```

A bad card stops with an error such as `bad bank card: {"id":"x"}` or `duplicate bank id backups`.

Run the Readiness check (**Home, Run readiness check**, or `pnpm run doctor` in `app/`; add `--offline` for the free part; without keys it ends `NOT READY`, because missing keys are errors). It shows how many cards loaded, whether the ids are unique, how many keyterms were found, and which files fell back to the example pack.

Next: [Examples](EXAMPLES.md) · [User guide](USER-GUIDE.md) · [Getting started, Part 4](GETTING-STARTED.md#part-4-make-your-own-pack)
