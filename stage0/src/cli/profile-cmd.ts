// wingman profile show | set. The user profile (name, spellings, address form, about, business, time zone) lives in the user's own
// config (~/.config/wingman/profile.yaml, see src/profile.ts), not in the repo. Edits the file directly; applies to the NEXT call.
import { existsSync, readFileSync } from "node:fs";
import { CliError, EXIT, parse, usage, type Ctx, type Result } from "./common.ts";
import { ADDRESS, EMPTY_PROFILE, ProfileError, parseProfile, profileFile, saveProfile, type Profile } from "../profile.ts";

const read = (file: string): Profile => {
  if (!existsSync(file)) return EMPTY_PROFILE;
  try { return parseProfile(readFileSync(file, "utf8"), file); }
  catch (e) { if (e instanceof ProfileError) throw new CliError("invalid_profile", e.message, EXIT.FAIL, "Fix the file, or overwrite fields with: wingman profile set ..."); throw e; }
};
const lines = (p: Profile, file: string) => [
  `File:       ${file}${existsSync(file) ? "" : "  (not created yet: neutral defaults)"}`,
  `name:       ${p.name || "(none: prompts say \"the user\")"}`,
  `spellings:  ${p.spellings.join(", ") || "(none)"}`,
  `address:    ${p.address}`,
  `about:      ${p.about || "(none)"}`,
  `business:   ${p.business || "(none)"}`,
  `timezone:   ${p.timezone || "(this machine's)"}`,
  `claims:     ${p.claims.join(" · ") || "(none)"}`,
].join("\n");

/** show | set [--name N] [--spelling S ...] [--address male|female|neutral] [--about T] [--business T] [--timezone Z] [--claim C ...]. An empty value clears a field. */
export async function profile(ctx: Ctx, args: string[]): Promise<Result> {
  const sub = args[0] || "show", rest = args.slice(1);
  const file = profileFile(ctx.env);
  if (sub === "show") {
    parse(rest, {});
    const p = read(file);
    return { data: { file, exists: existsSync(file), profile: p }, text: lines(p, file) };
  }
  if (sub === "set") {
    const { values, positionals } = parse(rest, {
      name: { type: "string" }, spelling: { type: "string", multiple: true }, address: { type: "string" },
      about: { type: "string" }, business: { type: "string" }, timezone: { type: "string" }, claim: { type: "string", multiple: true },
    });
    if (positionals.length) throw usage("Usage: wingman profile set [--name N] [--spelling S ...] [--address male|female|neutral] [--about T] [--business T] [--timezone Z] [--claim C ...]");
    const next: Profile = { ...read(file) };
    let changed = 0;
    if (values.name !== undefined) { next.name = values.name; changed++; }
    if (values.spelling !== undefined) { next.spellings = values.spelling.filter((s) => s.trim()); changed++; }
    if (values.address !== undefined) {
      if (!(ADDRESS as readonly string[]).includes(values.address)) throw usage(`--address must be one of: ${ADDRESS.join(" | ")}`);
      next.address = values.address as Profile["address"]; changed++;
    }
    if (values.about !== undefined) { next.about = values.about; changed++; }
    if (values.claim !== undefined) { next.claims = values.claim.map((c) => c.trim()).filter(Boolean); changed++; }
    if (values.business !== undefined) { next.business = values.business; changed++; }
    if (values.timezone !== undefined) {
      if (values.timezone && !(() => { try { new Intl.DateTimeFormat("en", { timeZone: values.timezone }); return true; } catch { return false; } })()) throw usage(`--timezone: "${values.timezone}" is not a time zone name (example: Europe/Paris)`);
      next.timezone = values.timezone; changed++;
    }
    if (!changed) throw usage("Nothing to set. Give at least one of --name, --spelling, --address, --about, --business, --timezone.");
    try { saveProfile(next, file); } catch (e) { throw new CliError("invalid_profile", (e as Error).message.slice(0, 300), EXIT.USAGE); }
    const p = read(file);
    return { data: { file, profile: p }, text: `${lines(p, file)}\n\nSaved. Applies to the next call.` };
  }
  throw usage(`Unknown profile command "${sub.slice(0, 30)}". Use: wingman profile show | set ...`);
}
