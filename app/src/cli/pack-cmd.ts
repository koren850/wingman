// wingman pack from-notes <file.txt|.md|.pdf> [--lang en|he] [--out dir] [--force] [--model provider:model]
// Drafts a bank (bank.yaml + bank.en.yaml) from the user's own notes with one model call (src/packgen.ts). The result is a DRAFT in a
// folder of its own (default ./pack-draft). It never goes into the live pack by itself and never replaces an existing bank without --force.
import { lstatSync, mkdirSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError, EXIT, parse, usage, type Ctx, type Result } from "./common.ts";
import { loadSettings, SettingsError, formatSettingsError, expandHome, type Settings } from "../settings.ts";
import { loadKeys, type KeyName } from "../env.ts";
import { realKeychain, type Keychain } from "../keychain.ts";
import { ModelRegistry, ConfigError, parseModelRef } from "../providers/llm.ts";
import { errText } from "../errtext.ts";
import { readPack } from "../pack.ts";
import { NotesError, MAX_NOTES_CHARS, detectLang, draftCards, finalizeDraft, readNotes, renderDraft, type Lang } from "../packgen.ts";

const USAGE =
  "Usage: wingman pack from-notes <file.txt|.md|.pdf> [--lang en|he] [--out <folder>] [--force] [--model provider:model]   (default folder: ./pack-draft)";

export async function pack(ctx: Ctx, args: string[]): Promise<Result> {
  const sub = args[0];
  if (sub !== "from-notes") throw usage(USAGE);
  const { values, positionals } = parse(args.slice(1), {
    lang: { type: "string" },
    out: { type: "string" },
    force: { type: "boolean" },
    model: { type: "string" },
  });
  if (positionals.length !== 1) throw usage(USAGE);
  if (values.lang !== undefined && values.lang !== "en" && values.lang !== "he") throw usage('--lang must be "en" or "he".');
  const file = positionals[0];

  let S: Settings;
  try {
    S = loadSettings({ argv: [], env: ctx.env, ...(ctx.userSettings ? { userFile: ctx.userSettings } : {}) }).settings;
  } catch (e) {
    if (e instanceof SettingsError) throw new CliError("invalid_settings", formatSettingsError(e), EXIT.FAIL, "Fix the settings file, then run this again.");
    throw e;
  }
  // The output folder is checked before the model is called: a refusal must not cost money.
  const out = resolve(values.out ?? "pack-draft");
  const bankFile = join(out, "bank.yaml"),
    enFile = join(out, "bank.en.yaml");
  // lstat, not exists: a link (even a dangling one) is never written through.
  const present = (f: string) => {
    try {
      return lstatSync(f);
    } catch {
      return undefined;
    }
  };
  const link = [bankFile, enFile].find((f) => present(f)?.isSymbolicLink());
  if (link) throw new CliError("refused", `${link} is a link. Nothing was written.`, EXIT.REFUSED, "Remove the link or choose another folder with --out.");
  const clash = [bankFile, enFile].filter((f) => present(f));
  if (clash.length && !values.force)
    throw new CliError(
      "exists",
      `${clash.join(" and ")} already exists. Nothing was written.`,
      EXIT.REFUSED,
      "Choose another folder with --out, or add --force to replace it.",
    );

  let notes: string;
  try {
    notes = await readNotes(file, { force: !!values.force, home: ctx.home });
  } catch (e) {
    if (!(e instanceof NotesError)) throw e;
    throw new CliError(e.code === "missing" ? "not_found" : "refused", e.message, e.code === "missing" ? EXIT.NOT_FOUND : EXIT.REFUSED);
  }
  const cut = notes.length > MAX_NOTES_CHARS;
  if (cut) notes = notes.slice(0, MAX_NOTES_CHARS);
  const lang: Lang = (values.lang as Lang | undefined) ?? detectLang(notes);

  const model = values.model ?? S.summary.model;
  let provider: string;
  try {
    provider = parseModelRef(model).provider;
  } catch (e) {
    throw usage((e as Error).message);
  }
  const keychain = provider === "scripted" ? null : ((ctx.keychain as Keychain | undefined) ?? realKeychain());
  const keys = loadKeys(expandHome(S.keys.file), ctx.env, keychain);
  if (provider !== "scripted" && !keys[provider as KeyName])
    throw new CliError("not_ready", `No API key for ${provider}.`, EXIT.NOT_READY, "Add it in Wingman Settings, Keys (or run: pnpm keys).");

  let raw;
  try {
    raw = await draftCards({ registry: new ModelRegistry(keys), model, notes, lang, houseStyle: readPack("house-style.md", ctx.env), signal: ctx.signal });
  } catch (e) {
    if (e instanceof ConfigError) throw new CliError("not_ready", e.message, EXIT.NOT_READY, e.fix ?? "");
    throw new CliError("model_failed", `The model call failed: ${errText(e)}`, EXIT.FAIL, "Nothing was written. Run the command again.");
  }
  const draft = finalizeDraft(raw.cards, lang);
  const text = renderDraft(draft, file.split(/[\\/]/).pop() ?? "notes", model);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  for (const [f, body] of [
    [bankFile, text.bank],
    [enFile, text.en],
  ] as const) {
    if (present(f)) unlinkSync(f); // only reached with --force; "wx" below fails if something appears meanwhile
    writeFileSync(f, body, { mode: 0o600, flag: "wx" });
    try {
      chmodSync(f, 0o600);
    } catch {
      /* best effort */
    }
  }

  const kept = draft.notes.filter((n) => n.action === "kept"),
    changed = draft.notes.filter((n) => n.action !== "kept");
  const lines = [
    `Draft written to ${out}`,
    `  bank.yaml, bank.en.yaml: ${kept.length} answer card(s) and the 4 safe stall cards. Model ${model}, language ${lang}.`,
    ...(cut ? [`  The notes were cut to the first ${MAX_NOTES_CHARS} characters.`] : []),
    ...changed.map((n) => `  ${n.action === "stalled" ? "Turned into a stall" : "Dropped"}: ${n.id} (${n.why})`),
    ...draft.warnings.map((w) => `  Check: ${w}`),
    "Read every card before you use it. To use the draft, copy bank.yaml and bank.en.yaml into your pack folder (see docs/PACK-FORMAT.md).",
  ];
  return {
    data: { out, files: [bankFile, enFile], lang, model, cards: kept.map((n) => n.id), changed, warnings: draft.warnings, notesCut: cut },
    text: lines.join("\n"),
  };
}
