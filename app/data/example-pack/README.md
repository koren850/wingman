# Example pack

An invented pack for a small web and hosting business. Wingman uses it when you have not made your own pack, file by file. All names and numbers here are made up.

To make your own, copy this folder to `~/.config/wingman/pack/` (or point `WINGMAN_PACK_DIR` at it) and edit the copy. Do not put personal data in this repo.

| File | What it is |
|---|---|
| `bank.yaml` | The answer cards ("Prepared" cards). Each has an `id`, a `title`, `triggers` (words that select it), the `say` line and short `facts`. |
| `bank.en.yaml` | English versions of the cards, keyed by `id`. A card without an entry is not shown in English turns. |
| `house-style.md` | Tone and never-say rules for AI answers. |
| `keyterms.txt` | One term per line. Helps the speech engine hear English tech words. |
| `topics.txt` | Words that mean "this call is about my own work". |

Formats and rules: [docs/PACK-FORMAT.md](../../../docs/PACK-FORMAT.md). A test (`src/example-pack.test.ts`) checks that this pack stays valid.

The scripted call in `../demo/demo-call.json` is the pretend client used by the practice call and `pnpm demo`.
