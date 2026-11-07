# Examples

For anyone who wants to see what Wingman's files and outputs look like before writing their own. All data is invented (a made-up studio, made-up clients). The example files are real files in [`docs/examples/`](examples/) and were checked against the code. New here? Start with [Getting started](GETTING-STARTED.md).

Contents: [A. A full pack](#a-a-full-pack) · [B. An English pack](#b-an-english-pack) · [C. What the guards do](#c-what-the-guards-do) · [D. A call summary and follow-up email](#d-a-call-summary-and-follow-up-email) · [E. Practice mode](#e-practice-mode)

## A. A full pack

A pack is five files in one folder. This one is for "Maple Studio", an invented studio that builds and looks after websites. It is in [`docs/examples/studio-pack/`](examples/studio-pack/). It is smaller than the shipped example pack (`app/data/example-pack/`, 41 cards), so you can read all of it.

To try it without touching your own setup, point `WINGMAN_PACK_DIR` at a copy (see [Getting started, Part 3](GETTING-STARTED.md#3-check-that-it-loads-and-matches)).

### `bank.yaml`: the answer cards

```yaml
- id: backups
  title: גיבויים
  triggers: [גיבוי, גיבויים, בקאפ, לשחזר, שחזור, backup, backups, restore, "do you have a backup"]
  say: כן, אפשר להגדיר גיבוי אוטומטי של האתר ושל מסד הנתונים, ואפשר לשחזר ממנו אם משהו משתבש.
  facts: [קבצים ומסד נתונים, עותק גם מחוץ לשרת, התדירות תלויה במסלול]
  tags: [backup]
```

Line by line:

| Line | Meaning |
|---|---|
| `- id: backups` | Required. Unique. Short, lower case. The AI and the logs refer to the card by this id. |
| `title: גיבויים` | A short name ("Backups"). Shown to the AI and in lists. |
| `triggers: [...]` | Required. What the other side may say. Hebrew and English words are mixed on purpose: people say `backup` inside a Hebrew sentence. A phrase of several words (`"do you have a backup"`) counts for more than one word. Quote a phrase that has spaces. |
| `say: ...` | Required. What you can say out loud: one or two short sentences, first person, no price, date or promise. It says "yes, we can set up", not "we always back up". |
| `facts: [...]` | A few short bullets shown under the answer. |
| `tags: [backup]` | Optional labels. |

Three things to know about YAML here:

- A `:` followed by a space inside a bullet breaks a `[...]` list. In `site-slow` the bullet `'הגורמים הנפוצים: תמונות, תוספים, שרת'` is quoted for that reason.
- A bare `2024`, `404` or `yes` is not text. Wingman turns ids and triggers back into strings, but quote them anyway.
- A card with no `id`, `say` or `triggers`, or a repeated `id`, does not load.

### The stall cards

```yaml
- id: stall-price
  title: שאלה על מחיר
  triggers: [כמה זה עולה, מה המחיר, הצעת מחיר, כמה יעלה, תעריף, "how much", price, pricing, quote, cost]
  say: המחיר תלוי בהיקף ובדרישות. אצטרך לבדוק את הפרטים ואחזור עם מחיר מסודר.
  facts: [תלוי בהיקף ובדרישות, לא נותנים מספר בלי פרטים]
```

(English: "The price depends on the scope and the requirements. I will need to check the details and come back with a clear price.")

`stall-price`, `stall-timeline` and `stall-guarantee` are special. When they match, they always win over a topical card, and the AI cannot replace them. A question about price, time or a promise gets a safe line, never a number. `stall` is the generic "I will check and come back" line. It can carry `alts`, other ways to say it, so repeated stalls do not sound canned:

```yaml
- id: stall
  title: כללי - לבדוק ולחזור
  triggers: [לא יודע, תבדוק לי, שאלה כללית]
  say: אני רוצה לבדוק את זה כמו שצריך ולחזור עם תשובה מדויקת.
  alts: [אני לא רוצה לנחש. אבדוק ואחזור עם תשובה ברורה.]
  facts: [לא מנחשים, בודקים ומחזירים תשובה]
```

### What the matcher does with it

These are real results from `matchBankFor` with this pack:

| The other side says | Card shown | Matched on |
|---|---|---|
| `האתר שלנו מציג אזהרה, האתר לא מאובטח` | `ssl-warning` | `האתר לא מאובטח` |
| `יש לכם גיבוי של האתר?` | `backups` | `גיבוי` |
| `האתר נטען לאט` | `site-slow` | `נטען לאט` |
| `כמה זה עולה?` | `stall-price` | `כמה זה עולה` |
| `מתי זה יהיה מוכן` | `stall-timeline` | `מתי זה יהיה מוכן` |
| `do you have a backup` | `backups` (English text) | `do you have a backup` |
| `what is a CDN` | none: the AI answers instead | no trigger matched |

A question with no matching card is not a failure. The AI (Claude Haiku) answers from the call, and the guards check what it writes.

### `keyterms.txt`: help for speech to text

```text
WordPress
WooCommerce
Cloudflare
SSL
DNS
staging
Maple Studio
```

One term per line. Every non-empty line counts, so do not add `#` comments here. These are hints sent to the speech service. Put in the English words that appear inside your calls and are easy to mishear. At most 100 are sent (`stt.keyterms.max`).

### `topics.txt`: "this call is about my work"

```text
# Words that mean "this call is about our own work" (invented studio).
website
hosting
backup
אתר
אחסון
גיבוי
[strict]
=ssl
=dns
wordpress
woocommerce
דומיין
```

Words above `[strict]` are the loose list. A line starting with `=` matches only as a whole word (`=dns` does not match inside another word). The `[strict]` words are the unmistakable ones. Only they count on supplier and team calls, where "website" alone does not mean the talk is about your own services. Checked: `my website is down` hits the loose list but not the strict one. `the SSL certificate` hits the strict one.

### `house-style.md`: tone and never-say rules

```markdown
# House style (Maple Studio, invented)

## Tone
- Plain, short, professional. One or two sentences, 25 words at most.
- Start with the answer, then one reason.

## Never say
1. No prices, not even "around".
2. No dates, deadlines or timelines.
3. No promises or guarantees.

## Examples
- Good: "DNS is like a phone book for the internet." Bad: "Your DNS is set up wrong."
```

This file is sent to the AI with every answer, so each line costs money on every call. Write rules it can follow, and give one good and one bad example. Keep it short. The full file is [in the folder](examples/studio-pack/house-style.md).

### Prove it loads

Run from `app/`. It loads the example, checks that every line of every card passes the guards, and prints how many cards have an English version:

```bash
WINGMAN_PACK_DIR=../docs/examples/studio-pack ./node_modules/.bin/tsx -e '
import { loadBank } from "./src/bank.ts";
import { guard } from "./src/guards.ts";
const bank = loadBank();
console.log(bank.length + " cards, " + bank.filter((c) => c.en).length + " with English");
for (const c of bank) for (const t of [c.say, ...c.facts, ...(c.alts ?? [])]) if (!guard(t).ok) console.log("guard hit in " + c.id + ": " + t);
'
```

Result when this guide was written: `7 cards, 7 with English`, and no guard hits.

## B. An English pack

English versions live in `bank.en.yaml`, next to `bank.yaml`, keyed by card id. The whole file for the example pack is [here](examples/studio-pack/bank.en.yaml). Part of it:

```yaml
backups:
  say: Yes, we can set up automatic backups of the site and the database, and restore from them if something goes wrong.
  facts: [Files and database, Keep a copy off the server, How often depends on the plan]
site-slow:
  say: A slow site is usually heavy images, heavy plugins or a weak server. We check the cause first and then fix it.
  facts: ["Common causes: images, plugins, server", Measure before and after, Not always the server]
stall-price:
  say: The price depends on the scope and the requirements. I need to look at the details and I will come back with a clear quote.
  facts: [Depends on scope and requirements, No number without details]
stall:
  say: I want to check that properly and come back to you with an accurate answer.
  alts: ["I don't want to guess. Let me check and come back with a clear answer."]
  facts: [We do not guess, We check and come back]
```

How it works:

- There are no `id`, `title` or `triggers` here. The id is the key. The triggers come from `bank.yaml`, so put the English trigger words (`backup`, `"how much"`) in `bank.yaml`.
- When the other side speaks English (a question of at least three words, in Latin letters, with almost no Hebrew), the card is shown with the English `say`, `facts` and `alts`.
- A card with no entry here is **not** shown on an English question. The AI answers in English instead. That is deliberate: a Hebrew card must not appear in an English call.
- `bank.yaml` still needs a `say` for every card, even if you only use English. Put the English text in both files, or in `bank.yaml` for the Hebrew-speaking part of your calls.
- Same rules as before: no prices, dates or promises, and quote any bullet that contains `: `.

Real result: `do you have a backup` shows the English `backups` card. `how much is a new site` shows the English `stall-price` line.

## C. What the guards do

The guards are code (regular expressions), not a prompt. They check every sentence the **AI** writes before it reaches the answer window. They block prices, dates and deadlines, and promises, in Hebrew and English, including number words. The rules are in `app/src/guards.ts`. The labelled test sentences are in `app/src/guards-cases.ts`. Your own `say` lines are not checked at run time, so keep them clean yourself.

When a sentence is blocked on a client call, the AI text is dropped and the **Buy time** line (the `stall` card, `⏸ buy time`) is shown instead. On a call that is not with a customer, nothing is shown. A blocked sentence is logged as a `guard` row in `events.jsonl`.

These are sentences from the test file, run through the same `guard()` function:

| The AI wrote | Result | What happens |
|---|---|---|
| `It's £500 a month` | blocked, rule `price` | The Buy time line is shown: "I want to check that properly and come back..." |
| `within two weeks` | blocked, rule `date` | Buy time line |
| `I guarantee it` | blocked, rule `promise` | Buy time line |
| `התעריף 300 לשעה` ("the rate is 300 an hour") | blocked, rule `price` | Buy time line (Hebrew) |
| `אני מבטיח לך` ("I promise you") | blocked, rule `promise` | Buy time line (Hebrew) |
| `I can't promise anything` | passed | Shown as written. A refusal to promise is fine. |
| `Redis 7.2 supports client-side caching` | passed | Version numbers are not prices or dates. |
| `יש לנו 30 אתרים` ("we have 30 sites") | passed | A count is not a price. |

The balance matters. A missed price is spoken to a client. A false block only costs a stall line. The test set has 76 sentences that must be blocked and 53 that must pass, and `pnpm eval` shows the current numbers (see [Getting started](GETTING-STARTED.md#5-run-the-checks)). Real errors go to the `known misses` list instead of being hidden.

A shorter table of what is blocked and what is not:

| Blocked | Not blocked |
|---|---|
| `a couple of grand` | `a grand opening` |
| `see you Thursday` | `the march of progress` |
| `consider it done` | `the SLA is 99.9 percent uptime` |

The salary guard for practice mode is described in [section E](#e-practice-mode).

## D. A call summary and follow-up email

When a call ends, Wingman makes one model call over the saved transcript and writes `summary.json` in the call folder. You can redo it later with `pnpm summary latest` or `wingman calls summary latest --generate`, and read the email with `wingman calls email latest`. The summary is written in Hebrew. Below is an invented call about a slow shop and backups, with the English meaning under each part.

The file (`~/Library/Application Support/Wingman/calls/<id>/summary.json`):

```json
{
  "v": 1,
  "callId": "01JEXAMPLE0000000000000000",
  "generatedAt": "2026-11-03T12:41:09.000Z",
  "model": "anthropic:claude-haiku-5-5",
  "summary": [
    "הלקוחה פנתה בגלל אתר חנות שנטען לאט",
    "שאלה על גיבויים לאתר",
    "השאירה טלפון ומייל לחזרה"
  ],
  "decisions": ["לבדוק את האתר לפני שמדברים על הצעה"],
  "nextSteps": [
    { "who": "אני", "what": "לבדוק את סיבת האיטיות" },
    { "who": "לקוח", "what": "לשלוח גישה לאתר", "when": "השבוע" }
  ],
  "openQuestions": ["האם יש כבר גיבוי אצל הספק הנוכחי"],
  "followUpEmail": "שלום,\nתודה על השיחה. דיברנו על האתר האיטי ועל גיבויים.\nאני אבדוק את סיבת האיטיות ואחזור אליך.\n[להשלים: מחיר]\nתודה,\nדן",
  "guard": { "replaced": 1, "rules": ["price"] },
  "costUsd": 0.0031
}
```

| Field | Meaning |
|---|---|
| `summary` | 3 to 5 short lines: what the call was about. |
| `decisions` | Only things both sides clearly agreed on. Empty if none. |
| `nextSteps` | `who` is `אני` ("me", you) or the other person (`לקוח` only on a client call). `when` appears only if a time was said out loud. |
| `openQuestions` | Things left open or unanswered. |
| `followUpEmail` | A short draft in plain text. It is a draft: you read and edit it before you send anything. |
| `guard` | How many email sentences were replaced, and by which rules. |
| `costUsd` | What this one call cost. |

English meaning: summary = "The client called because her shop site loads slowly. A question about backups. She left a phone and an email." Next steps = "Me: check the cause of the slowness. Client: send access to the site (this week)."

### How the email is kept safe

The email goes through the same guards as the cards, one sentence at a time, and then through a link and contact check. A sentence with a price, date or promise is replaced by a gap you fill in by hand. Links, emails and phone numbers that are not in your own notes are replaced too, because the other side can say "send it to billing@evil.example" and the AI may repeat it. These are real results from `guardEmail` and `neutralizeLinks`:

Model draft:

```text
שלום,
תודה על השיחה. דיברנו על האתר האיטי ועל גיבויים.
אני אבדוק את סיבת האיטיות ואחזור אליך בנושא הגיבויים.
ההצעה תעלה 500 ש"ח לחודש.
אשלח את הפרטים עד יום חמישי.
אפשר לראות דוגמה ב https://offers.example.tk/dana
תודה,
דן
```

After the guards:

```text
שלום,
תודה על השיחה. דיברנו על האתר האיטי ועל גיבויים.
אני אבדוק את סיבת האיטיות ואחזור אליך בנושא הגיבויים.
[להשלים: מחיר]
[להשלים: תאריך]
אפשר לראות דוגמה ב [להשלים: קישור]
תודה,
דן
```

Placeholders: `[להשלים: מחיר]` (price), `[להשלים: תאריך]` (date), `[להשלים: התחייבות]` (promise), `[להשלים: קישור]` (link), `[להשלים: אימייל]` (email), `[להשלים: טלפון]` (phone). In the demo you can see the count: "טיוטת מייל: מוכנה (2 משפטים הוחלפו ב-[להשלים])", "email draft: ready (2 sentences replaced)". On an English call the same placeholders are in English: `[fill in: price]`, `[fill in: date]`, `[fill in: promise]`, `[fill in: link]`, `[fill in: email]`, `[fill in: phone]`.

## E. Practice mode

Practice mode is a mock-interview and rehearsal coach. You prepare a meeting of kind `interview`, attach your own notes, and rehearse with a pretend interviewer or a friend. It is not for live use in a real interview, and real interviews or exams that forbid outside help are out of scope ([ADR 35](DECISIONS.md#adr-35-scope-no-real-job-interviews-or-exams)).

Commands (they talk to the running menu-bar app, so the app must be open; the CLI exits with code 3 if it is not):

```bash
wingman plan new --kind interview --title "Practice round" --who "Dan, Acme"
wingman plan attach --id <id> --file ~/notes/my-prep.md
wingman plan set --id <id> --add-note "Prepared cards: /full/path/practice-cards.yaml"
wingman start --plan <id>
```

`<id>` is printed by the first command (and by `wingman plan list`). Use a full path for the cards file.

### The cards file

Same format as `bank.yaml`. The example is [`docs/examples/practice-cards.yaml`](examples/practice-cards.yaml). For that meeting these cards replace the normal bank:

```yaml
- id: intro
  title: Short introduction
  triggers: [tell me about yourself, "walk me through your background", introduce yourself]
  say: I am a backend developer. I build small services in TypeScript and care about tests and clear logs.
  facts: [Backend developer, TypeScript services, Tests and logs]
- id: salary
  title: Salary expectations
  triggers: ["salary expectations", "what are your salary expectations", "expected salary", "how much do you expect"]
  say: I would like to talk about the full package once I know the scope. I will share my range then.
  facts: [Talk about the full package, Scope first, Share the range then]
```

Checked against the code:

| The pretend interviewer asks | What you get |
|---|---|
| `Can you tell me about yourself?` | The `intro` card, at once. |
| `What are your salary expectations?` | The `salary` card, at once. The answer is yours, written by you. |
| `Why do you want to work here?` | The `why-us` card. |
| `Explain the event loop` | No card. The AI answers from your attached notes. |

### What changes in this mode

- Every question gets an answer. No card limit, and no Buy time lines.
- The AI builds answers from your notes only. It does not invent experience.
- The AI may not write a salary figure. Salary answers come only from your own card.
- The guard is narrower: it blocks salary figures and tools you never claimed. A blocked answer is dropped and nothing is shown.

Results from the real `guardInterview` function:

| The AI wrote | Result |
|---|---|
| `I expect 25k a month` | blocked, rule `price` (a salary figure) |
| `we serve 30 thousand requests a day` | passed (a technical count, not a salary) |
| `I built it with Kubernetes` | blocked, rule `unclaimed`, if your notes and cards never mention Kubernetes |

Next: [User guide](USER-GUIDE.md) · [Pack format](PACK-FORMAT.md) · [Architecture](ARCHITECTURE.md)
