// The user profile: who Wingman is helping. Lives in the user's own config (~/.config/wingman/profile.yaml, override with
// WINGMAN_PROFILE_FILE), never in the repo. A missing file means neutral defaults: no name, prompts say "the user".
// Prompts get the persona() text; the detector and flow mode get nameRegex() (the user addressed by name).
import { readFileSync, writeFileSync, mkdirSync, statSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const USER_PROFILE_FILE = join(homedir(), ".config", "wingman", "profile.yaml");
export const profileFile = (env: NodeJS.ProcessEnv = process.env) => env.WINGMAN_PROFILE_FILE || USER_PROFILE_FILE;

export const ADDRESS = ["male", "female", "neutral"] as const;
export type Address = (typeof ADDRESS)[number];

/** Empty (= this machine's zone) or an IANA name that Intl accepts. */
export function validTimezone(tz: string): boolean {
  if (!tz) return true;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
const text = (max: number) => z.string().max(max).transform((s) => s.trim());
/** Strict like settings.ts: an unknown key in the file is an error, so a typo does not silently do nothing. */
export const profileSchema = z.strictObject({
  /** display name; may be empty */
  name: text(60).default(""),
  /** other spellings / scripts that speech-to-text produces for the name (for example the name in Hebrew letters) */
  spellings: z.array(text(60)).max(20).default([]),
  /** Hebrew grammatical form the AI uses when it addresses the user */
  address: z.enum(ADDRESS).default("neutral"),
  /** who the user is and what they do (free text, goes into the prompts) */
  about: text(1500).default(""),
  /** the user's own business (free text, optional): makes "client" and "support" calls meaningful */
  business: text(1500).default(""),
  /** IANA time zone used for "what time is it" answers; empty = this machine's time zone */
  timezone: text(60).refine(validTimezone, { message: "not a time zone this system knows (use a name like Asia/Jerusalem, or leave empty)" }).default(""),
});
export type Profile = z.infer<typeof profileSchema>;
export const EMPTY_PROFILE: Profile = profileSchema.parse({});

export class ProfileError extends Error {
  constructor(public file: string, message: string) { super(`${file}: ${message}`); this.name = "ProfileError"; }
}

/** Parses profile YAML text. Throws ProfileError naming the file. */
export function parseProfile(raw: string, file = "profile"): Profile {
  let doc: unknown;
  try { doc = YAML.parse(raw); } catch (e) { throw new ProfileError(file, `not valid YAML: ${(e as Error).message.split("\n")[0]}`); }
  if (doc == null) return EMPTY_PROFILE;
  const res = profileSchema.safeParse(doc);
  if (!res.success) throw new ProfileError(file, res.error.issues.map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`).join("; "));
  return res.data;
}

let override: Profile | undefined;
let cache: { file: string; mtime: number; profile: Profile } | undefined;
/** Test hook: use this profile instead of the file (undefined = back to the file). */
export function setProfile(p: Partial<Profile> | undefined) { override = p ? profileSchema.parse(p) : undefined; }

/**
 * The current profile: the file, re-read when its modification time changes (so `wingman profile set` takes effect after the next
 * prompt is built; the reflex prefix itself is built once per call, so a running call keeps the profile it started with for that part).
 * A missing or unreadable file gives neutral defaults. An INVALID file (hand edit, half-written save) NEVER throws here: this is called on
 * hot paths during a call, so the last good profile is kept (or the neutral default if there never was one). The explicit startup check is
 * checkProfile(), which throws ProfileError.
 */
export function getProfile(env: NodeJS.ProcessEnv = process.env): Profile {
  if (override) return override;
  const file = profileFile(env);
  let mtime: number;
  try { mtime = statSync(file).mtimeMs; } catch { return EMPTY_PROFILE; }
  if (cache && cache.file === file && cache.mtime === mtime) return cache.profile;
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch { return cache && cache.file === file ? cache.profile : EMPTY_PROFILE; }
  try {
    const profile = parseProfile(raw, file);
    cache = { file, mtime, profile };
    return profile;
  } catch {
    const keep = cache && cache.file === file ? cache.profile : EMPTY_PROFILE;
    cache = { file, mtime, profile: keep };   // do not re-parse the same broken bytes on every prompt
    return keep;
  }
}

/** The strict read for startup and the doctor: throws ProfileError when the file exists but is invalid. A missing file is fine (neutral defaults). */
export function checkProfile(env: NodeJS.ProcessEnv = process.env): Profile {
  if (override) return override;
  const file = profileFile(env);
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch { return EMPTY_PROFILE; }
  const profile = parseProfile(raw, file);
  cache = { file, mtime: (() => { try { return statSync(file).mtimeMs; } catch { return 0; } })(), profile };
  return profile;
}

/** Writes the profile (mode 600, folder 700). */
export function saveProfile(p: Profile, file = profileFile()): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const full = profileSchema.parse(p);
  const doc = Object.fromEntries(Object.entries(full).filter(([k, v]) => k === "name" || !(v === "" || (Array.isArray(v) && !v.length))));
  // Atomic: a call that reads the file at this moment sees the old or the new profile, never half of one.
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    writeFileSync(tmp, `# Wingman user profile: who Wingman is helping. Edit with: wingman profile set ...\n${YAML.stringify(doc)}`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* gone */ } throw e; }
  cache = undefined;
}

/** How prompts name the user: the profile name, or "the user". */
export const userName = (p: Profile = getProfile()) => p.name || "the user";
/** "the user's" / "Dan's" */
export const userPoss = (p: Profile = getProfile()) => `${userName(p)}'s`;

/** The Hebrew grammatical-gender rule for lines that address the user, as a short clause for prompts. */
export function hebrewAddressRule(p: Profile = getProfile()): string {
  const n = userName(p);
  if (p.address === "male") return `male: always address ${n} in the masculine, "שאל", never "שאלי"`;
  if (p.address === "female") return `female: always address ${n} in the feminine, "שאלי", never "שאל"`;
  return `address ${n} with gender-neutral Hebrew wording (plural or impersonal forms) where you can`;
}

/** Short text for the system prompts: name, how to address, about, business. Empty parts are left out. */
export function persona(p: Profile = getProfile()): string {
  const lines = [`The user is ${p.name ? p.name : 'unnamed (call them "the user")'} (${hebrewAddressRule(p)}).`];
  if (p.spellings.length) lines.push(`Speech-to-text may spell the name: ${[p.name, ...p.spellings].filter(Boolean).join(", ")}.`);
  if (p.about) lines.push(`About the user: ${p.about}`);
  if (p.business) lines.push(`The user's own business: ${p.business}`);
  return lines.join("\n");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let reCache: { key: string; re: RegExp } | undefined;
/** The user addressed by name: name + spellings, escaped. Matches nothing when both are empty. Same shape as the old NAME_RE. */
export function nameRegex(p: Profile = getProfile()): RegExp {
  const names = [...new Set([p.name, ...p.spellings].map((s) => s.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  const key = names.join("\u0000");
  if (reCache?.key === key) return reCache.re;
  const re = names.length ? new RegExp(`(^|[\\s,])(${names.map(escapeRe).join("|")})(?![\\p{L}])`, "iu") : /(?!)/u;
  reCache = { key, re };
  return re;
}
/** True when the profile names the user (so name detection can work at all). */
export const hasName = (p: Profile = getProfile()) => !!(p.name || p.spellings.length);

/** The user's time zone (profile, else this machine's). */
export const userTimezone = (p: Profile = getProfile()) => p.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** "Dan is male." / "Dan is female." / "" : grammatical gender for the Hebrew texts written about or as the user. */
export function genderNote(p: Profile = getProfile()): string {
  return p.address === "male" ? `${userName(p)} is male.` : p.address === "female" ? `${userName(p)} is female.` : "";
}
/** The label for the user's own side in stored summaries and transcripts sent to the summary model (Hebrew "me"). */
export const ME_LABEL = "אני";
/** Does this "who" label mean the user themself ("me", the Hebrew "me", the profile name or one of its spellings)? */
export function isMeLabel(s: string, p: Profile = getProfile()): boolean {
  const t = s.trim().toLowerCase();
  return t === "me" || t === ME_LABEL || [p.name, ...p.spellings].some((n) => n && n.trim().toLowerCase() === t);
}
/** The lower-case words of the name and its spellings (so "hello <name>" can be treated as a greeting). */
export const nameWords = (p: Profile = getProfile()): Set<string> =>
  new Set([p.name, ...p.spellings].flatMap((n) => n.toLowerCase().split(/\s+/)).filter(Boolean));
