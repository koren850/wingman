// One-time setup: writes the user profile (~/.config/wingman/profile.yaml) and fills the user's pack folder (~/.config/wingman/pack/).
// The personal values are NOT in this file: pass them on the command line or in a YAML file (--from).
//
//   npx tsx scripts/make-personal-profile.ts --name "<name>" --spelling "<other spelling>" --spelling "<other>" --address male|female|neutral \
//       --about "<who you are>" --business "<your business>" --timezone "<IANA zone>" [--pack-from <folder>] [--force] [--dry-run]
//   npx tsx scripts/make-personal-profile.ts --from my-profile.yaml --dry-run
//
// Profile: refused if the file exists, unless --force. Pack: only files that are missing in the pack folder are copied, so nothing
// you edited is overwritten. The pack files come from --pack-from <folder> (for example your old data/ folder), and for every file not
// found there from data/example-pack/. WINGMAN_PROFILE_FILE and WINGMAN_PACK_DIR redirect both targets (useful to try it in a temp folder).
// --dry-run prints what would happen and writes nothing.
import { parseArgs } from "node:util";
import { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import YAML from "yaml";
import { ADDRESS, EMPTY_PROFILE, ProfileError, parseProfile, profileFile, profileSchema, type Profile } from "../src/profile.ts";
import { EXAMPLE_PACK, PACK_FILES, USER_PACK } from "../src/pack.ts";

const die = (m: string): never => { console.error(`make-personal-profile: ${m}`); process.exit(2); };

const { values } = parseArgs({
  options: {
    name: { type: "string" }, spelling: { type: "string", multiple: true }, address: { type: "string" }, about: { type: "string" },
    business: { type: "string" }, timezone: { type: "string" }, from: { type: "string" }, "pack-from": { type: "string" },
    force: { type: "boolean" }, "dry-run": { type: "boolean" },
  },
  strict: true,
});

let base: Profile = EMPTY_PROFILE;
if (values.from) {
  if (!existsSync(values.from)) die(`--from file not found: ${values.from}`);
  try { base = parseProfile(readFileSync(values.from, "utf8"), values.from); } catch (e) { if (e instanceof ProfileError) die(e.message); throw e; }
}
const merged: Record<string, unknown> = { ...base };
if (values.name !== undefined) merged.name = values.name;
if (values.spelling) merged.spellings = values.spelling;
if (values.address !== undefined) { if (!(ADDRESS as readonly string[]).includes(values.address)) die(`--address must be ${ADDRESS.join(" | ")}`); merged.address = values.address; }
if (values.about !== undefined) merged.about = values.about;
if (values.business !== undefined) merged.business = values.business;
if (values.timezone !== undefined) merged.timezone = values.timezone;
const res = profileSchema.safeParse(merged);
if (!res.success) die(res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
const profile = res.data!;

const dry = !!values["dry-run"];
const pfile = profileFile(), packDir = process.env.WINGMAN_PACK_DIR || USER_PACK;
const packFrom = values["pack-from"];
if (packFrom && !existsSync(packFrom)) die(`--pack-from folder not found: ${packFrom}`);
const say = (m: string) => console.log(dry ? `[dry run] ${m}` : m);

// 1. the profile
if (existsSync(pfile) && !values.force) say(`profile: ${pfile} exists, left as it is (use --force to overwrite)`);
else {
  const doc = Object.fromEntries(Object.entries(profile).filter(([k, v]) => k === "name" || !(v === "" || (Array.isArray(v) && !v.length))));
  say(`profile: ${existsSync(pfile) ? "overwrite" : "write"} ${pfile}:\n${YAML.stringify(doc).replace(/^/gm, "    ")}`);
  if (!dry) { mkdirSync(dirname(pfile), { recursive: true, mode: 0o700 }); writeFileSync(pfile, `# Wingman user profile (edit with: wingman profile set ...)\n${YAML.stringify(doc)}`, { mode: 0o600 }); }
}

// 2. the pack: only files that are missing
for (const f of PACK_FILES) {
  const dest = join(packDir, f);
  if (existsSync(dest)) { say(`pack: ${dest} exists, left as it is`); continue; }
  const src = [packFrom && join(packFrom, f), join(EXAMPLE_PACK, f)].filter((x): x is string => !!x).find((x) => existsSync(x));
  if (!src) { say(`pack: ${f} not found anywhere, skipped`); continue; }
  say(`pack: copy ${src} -> ${dest}`);
  if (!dry) { mkdirSync(packDir, { recursive: true, mode: 0o700 }); copyFileSync(src, dest); }
}
say(dry ? "nothing was written." : "done. Check with: npx tsx src/cli/index.ts profile show");
