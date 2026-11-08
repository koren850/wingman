// wingman lookup "<term>"   Looks one term up on a public web page and prints one line, the address it came from and the sentence it was taken from.
// Off by default: settings lookup.enabled must be true (Settings, or the Ask tab toggle). One request per use, https only, no private addresses (session/lookup.ts).
import { CliError, EXIT, parse, usage, type Ctx, type Result } from "./common.ts";
import { loadSettings } from "../settings.ts";
import { lookup } from "../session/lookup.ts";

export async function lookupCmd(ctx: Ctx, args: string[]): Promise<Result> {
  const { positionals } = parse(args, {});
  let term = positionals.join(" ");
  if (term === "-") term = await ctx.stdin();
  term = term.replace(/\s+/g, " ").trim();
  if (!term) throw usage('Usage: wingman lookup "<term>"   (or an https address; - reads stdin)');
  if (term.length > 200) throw usage("Too long: the limit is 200 characters.");
  let s;
  try {
    s = loadSettings({ env: ctx.env, argv: [] }).settings;
  } catch {
    throw new CliError("settings", "The settings file has a problem. Run: wingman settings check", EXIT.FAIL);
  }
  const maxUsd = s.lookup.maxUsdPerCall;
  const r = await lookup(term, {
    enabled: s.lookup.enabled,
    maxUsd,
    ...(ctx.lookupFetch ? { fetch: ctx.lookupFetch } : {}),
    ...(ctx.lookupDns ? { dns: ctx.lookupDns } : {}),
  });
  if (!r.ok)
    throw new CliError(
      "lookup-" + r.code,
      r.message,
      r.code === "off" ? EXIT.REFUSED : r.code === "not-found" ? EXIT.NOT_FOUND : r.code === "timeout" ? EXIT.TIMEOUT : EXIT.FAIL,
      r.code === "off" ? "Turn it on: wingman settings set lookup.enabled true" : "",
    );
  return {
    data: { term: r.term, line: r.line, url: r.url, sentence: r.sentence, ai: r.ai, usd: r.usd },
    text: [r.line, `Source: ${r.url}`, `Sentence: "${r.sentence}"`].join("\n"),
  };
}
