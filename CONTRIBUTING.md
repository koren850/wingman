# Contributing

Thank you for helping. Wingman is a small project with one maintainer, so short and focused changes are the easiest to review.

## Set up

You need a Mac (macOS 14.2 or newer), Node 24 or newer, and `ffmpeg`.

```bash
# clone the repository as shown in the README quick start, then:
cd wingman
./install.sh --check        # what is present, what is missing
./install.sh                # installs, builds the app
```

To work on code only (no app, no Electron download):

```bash
cd app
WINGMAN_SKIP_APP=1 pnpm install
```

pnpm 11 comes through corepack (`corepack enable`). The version is fixed in `app/package.json`.

More detail: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Run the checks

From `app/`:

```bash
pnpm typecheck     # type check
pnpm lint          # ESLint
pnpm format:check  # Prettier
pnpm test:unit     # unit tests, about 40 s
pnpm test:e2e      # end-to-end tests (whole calls in a subprocess), about 4 min
pnpm eval          # detector, bank and guard numbers against qa/eval-baseline.json
pnpm check         # all of the above except the end-to-end tests
```

All of them must pass before you open a pull request. Tests need no API keys. They use mocks and fake keys, and they never read your real keys or call data.

Run one test file while you work:

```bash
pnpm exec tsx --test src/guards-table.test.ts
```

Do not run two test runs at the same time. They share ports and files.

## The private word list (repo guard)

One test, the "repo guard", fails if a tracked file contains a word from a private list. The list is not in the repo. It is a way to keep your own names, clients, servers and emails out of what you publish.

Make your own list:

- Put the words in the environment, separated by commas:
  `WINGMAN_DENYLIST="word1,word2" pnpm test`
- Or put one word (or regex) per line in `app/data/private/denylist.txt`. That file is git-ignored.

Use words that must never appear: your name, your employer, client names, your own domains, your phone number. If no list is set, the test skips itself. That is what happens in CI.

The guard scans the code, data, config and scripts folders and the Markdown docs.

## No private data

This repo must contain nothing personal and nothing from a real call.

- Examples, fixtures and docs use invented people and companies: "Dan", "Dana", "Acme", `example.com`, `example.co.il`, phone `050-1234567`.
- Never commit API keys, transcripts, recordings, call folders, screenshots of a real call, or your profile and pack.
- Your own data lives outside the repo: `~/Library/Application Support/Wingman` and `~/.config/wingman`.
- Screenshots in `docs/ux/` must be made from test fixtures (see the snapshot tools in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)).

## Code rules

The short version. The full list is in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#code-conventions).

- A bug fix comes with a regression test.
- Every new setting goes in `app/config/defaults.yaml` (with a comment) and in the schema in `app/src/settings.ts`.
- Anything the AI says passes through `src/guards.ts`. Add a test for each new pattern it must block.
- Keys and secrets are never logged, saved in settings, or put in a call folder.
- A failure must never produce a wrong card. When unsure, show nothing or a "Buy time" line.
- Keep the visible words from the glossary (Prepared, AI, Buy time, Tip, For you, Math, Answer window, Plan, Readiness check, Quiet mode, Start listening).

## Commit style

- Small, logical commits. One idea each.
- A short first line in the imperative: "Guard: block a salary figure in practice mode". Under 72 characters.
- If it needs it, a blank line and a few plain sentences about why.
- Do not mix a refactor with a behavior change.

## Pull requests

- Say what changed and why, in a few sentences.
- Say how you checked it (which tests, anything you tried by hand).
- Docs change with the code. If you change a setting, a command or a path, update the docs in the same pull request.
- CI runs the type check and the tests on macOS. It must be green.

## Security problems

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your work is under the MIT license, like the rest of the project.
