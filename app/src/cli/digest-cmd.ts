// wingman digest [<file.txt|.md|.pdf|.docx|.eml|https://address>...] [--text "<pasted text>"] [--stdin] [--out <digest.json>] [--model provider:model]
// The pre-meeting digest (src/digest.ts) from the command line: one small model call turns notes into people, agenda, facts with their source line
// and likely questions. With --out the digest is saved (mode 600) for the next call. Without a key or when the model fails, the raw text is kept as
// plain background and the command says so. Also the entry the app can start for the "Prepare" step. Nothing is sent anywhere else.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { CliError, EXIT, parse, usage, type Ctx, type Result } from "./common.ts";
import { loadSettings, SettingsError, formatSettingsError, expandHome, type Settings } from "../settings.ts";
import { loadKeys, type KeyName } from "../env.ts";
import { realKeychain, type Keychain } from "../keychain.ts";
import { ModelRegistry, parseModelRef } from "../providers/llm.ts";
import { readNotes, NotesError } from "../packgen.ts";
import { runDigest, saveDigest } from "../digest.ts";
import { readSource } from "../session/inputs.ts";

const attachments = createRequire(import.meta.url)("../../tray/attachments.cjs") as {
  readSourceFile(file: string, o?: { force?: boolean; home?: string }): Buffer;
};
const USAGE =
  'Usage: wingman digest [<file.txt|.md|.pdf|.docx|.eml|https://page>...] [--text "<text>"] [--stdin] [--out <digest.json>] [--model provider:model]';

export async function digest(ctx: Ctx, args: string[]): Promise<Result> {
  const { values, positionals } = parse(args, {
    text: { type: "string" },
    stdin: { type: "boolean" },
    out: { type: "string" },
    model: { type: "string" },
    force: { type: "boolean" },
  });
  const files: { name: string; text: string }[] = [];
  for (const f of positionals) {
    try {
      // A web address (https://), a Word file or a mail file is read by session/inputs.ts; other files by readNotes (same checks as before).
      if (/^https?:\/\//i.test(f)) {
        const r = await readSource({ type: "url", url: f });
        files.push({ name: r.label, text: r.text });
      } else if (/\.(docx|eml)$/i.test(f)) {
        // the same checks as any attached file (no links, no key files, inside the home folder unless --force), then the Word or mail reader
        const bytes = attachments.readSourceFile(f, { force: !!values.force, home: ctx.home }) as Buffer;
        const r = await readSource({ type: "file", name: f.split(/[\\/]/).pop() ?? "file", bytes });
        files.push({ name: r.label, text: r.text });
      } else files.push({ name: f.split(/[\\/]/).pop() ?? "file", text: await readNotes(f, { force: !!values.force, home: ctx.home }) });
    } catch (e) {
      // NotesError (txt, md, pdf) and the errors of the Word, mail and web readers (a plain Error with a short .code) are both a refusal the user can read.
      const code =
        e instanceof NotesError
          ? e.code
          : typeof (e as { code?: unknown })?.code === "string" && /^[a-z]+$/.test((e as { code: string }).code)
            ? (e as { code: string }).code
            : "";
      if (!code) throw e;
      throw new CliError(code === "missing" ? "not_found" : "refused", (e as Error).message, code === "missing" ? EXIT.NOT_FOUND : EXIT.REFUSED);
    }
  }
  const text = [values.text ?? "", values.stdin ? await ctx.stdin() : ""].filter(Boolean).join("\n");
  if (!files.length && !text.trim()) throw usage(USAGE);

  let S: Settings;
  try {
    S = loadSettings({ argv: [], env: ctx.env, ...(ctx.userSettings ? { userFile: ctx.userSettings } : {}) }).settings;
  } catch (e) {
    if (e instanceof SettingsError) throw new CliError("invalid_settings", formatSettingsError(e), EXIT.FAIL, "Fix the settings file, then run this again.");
    throw e;
  }
  // digest.model (a settings key added by the moment-engine package) when it exists, else the summary model
  const model = values.model ?? (S as unknown as { digest?: { model?: string } }).digest?.model ?? S.summary.model;
  let provider: string;
  try {
    provider = parseModelRef(model).provider;
  } catch (e) {
    throw usage((e as Error).message);
  }
  const keychain = provider === "scripted" ? null : ((ctx.keychain as Keychain | undefined) ?? realKeychain());
  const keys = loadKeys(expandHome(S.keys.file), ctx.env, keychain);
  const haveKey = provider === "scripted" || !!keys[provider as KeyName];
  const r = await runDigest({ text, files }, { registry: new ModelRegistry(keys), models: haveKey ? [model] : [], signal: ctx.signal });
  if (values.out) saveDigest(resolve(values.out), r.digest);
  const d = r.digest;
  const lines = [
    r.source === "ai"
      ? `Digest: ${d.roster.length} people, ${d.agenda.length} agenda items, ${d.facts.length} facts, ${d.likelyQuestions.length} likely questions, ${d.chunks.length} text chunks.`
      : `The raw text was kept as plain background (${d.chunks.length} chunks). Reason: ${r.why}.${r.why === "no-ai" ? " No API key for the model." : ""}`,
    ...(r.droppedFacts ? [`${r.droppedFacts} fact(s) were left out because their source line is not in the text.`] : []),
    ...(values.out ? [`Saved: ${resolve(values.out)}`] : []),
    "Nothing is used in a call until you start it with this meeting.",
  ];
  return {
    data: { source: r.source, why: r.why ?? "", droppedFacts: r.droppedFacts, digest: d, out: values.out ? resolve(values.out) : "" },
    text: lines.join("\n"),
  };
}
