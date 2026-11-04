// The user profile (profile.ts), the pack look-up (pack.ts), the `wingman profile` command, and that no prompt carries a hardcoded name.
// Offline: temp folders only; the real ~/.config/wingman is never read (WINGMAN_PROFILE_FILE / WINGMAN_PACK_DIR point elsewhere).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseProfile, getProfile, setProfile, saveProfile, persona, nameRegex, hebrewAddressRule, userName, isMeLabel, genderNote, ProfileError, EMPTY_PROFILE, profileFile, USER_PROFILE_FILE,
} from "./profile.ts";
import { packPath, readPack, packDirs, EXAMPLE_PACK, USER_PACK, parseTopics, loadTopics } from "./pack.ts";
import { main } from "./cli/index.ts";
import { buildPrefix, reflexUserMessage, interviewBlock, nowText } from "./reflex.ts";
import { classifySystem, classifyUserMessage } from "./assist.ts";
import { tipsSystem, masculine } from "./tips.ts";
import { summarySystem, kindGuidance, buildPrompt } from "./summary.ts";
import { notesSystem } from "./notes.ts";
import { selfcheckSystem } from "./selfcheck.ts";
import { frameSystem, frameUserMessage, isAgencyTopic, resetTrackedKind } from "./frame.ts";
import { topicSystem } from "./flow.ts";
import { isClearQuestion } from "./detector.ts";
import { loadKeyterms } from "./providers/stt/index.ts";
import { loadSettings } from "./settings.ts";

const tmp = (n: string) => mkdtempSync(join(tmpdir(), `wm-profile-${n}-`));
afterEach(() => { setProfile(undefined); });

test("profile: no file means neutral defaults; the real user file is only the default path", () => {
  const dir = tmp("none");
  const p = getProfile({ WINGMAN_PROFILE_FILE: join(dir, "absent.yaml") });
  assert.deepEqual(p, EMPTY_PROFILE);
  assert.equal(p.name, ""); assert.equal(p.address, "neutral"); assert.deepEqual(p.spellings, []);
  assert.equal(profileFile({}), USER_PROFILE_FILE);
  assert.equal(profileFile({ WINGMAN_PROFILE_FILE: "/x/y.yaml" }), "/x/y.yaml");
});

test("profile: parses a file, trims text, rejects unknown keys and bad values (naming the file)", () => {
  const dir = tmp("parse"), f = join(dir, "profile.yaml");
  writeFileSync(f, "name: ' Mia '\nspellings: [מיה, Mea]\naddress: female\nabout: ' a designer '\nbusiness: ''\n");
  const p = getProfile({ WINGMAN_PROFILE_FILE: f });
  assert.equal(p.name, "Mia"); assert.deepEqual(p.spellings, ["מיה", "Mea"]); assert.equal(p.address, "female"); assert.equal(p.about, "a designer"); assert.equal(p.business, "");
  assert.throws(() => parseProfile("nmae: x", f), (e: any) => e instanceof ProfileError && e.message.includes(f));
  assert.throws(() => parseProfile("address: robot"), ProfileError);
  assert.throws(() => parseProfile("name: [unclosed"), ProfileError);
  assert.deepEqual(parseProfile(""), EMPTY_PROFILE);
});

test("profile: a changed file is re-read; save writes mode 600 and round-trips", () => {
  const dir = tmp("save"), f = join(dir, "sub", "profile.yaml");
  saveProfile({ ...EMPTY_PROFILE, name: "Noa", address: "female", spellings: ["נועה"] }, f);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(getProfile({ WINGMAN_PROFILE_FILE: f }).name, "Noa");
  saveProfile({ ...EMPTY_PROFILE, name: "Ori" }, f);
  const later = new Date(Date.now() + 5000);
  utimesSync(f, later, later);
  assert.equal(getProfile({ WINGMAN_PROFILE_FILE: f }).name, "Ori");
});

test("nameRegex: name and spellings, whole words only, case-insensitive, escaped; matches nothing when empty", () => {
  const re = nameRegex({ ...EMPTY_PROFILE, name: "Dan", spellings: ["דן", "Dann"] });
  assert.ok(re.test("hello Dan, can you")); assert.ok(re.test("דן, מה אתה אומר")); assert.ok(re.test("היי דן")); assert.ok(re.test("dann are you there"));
  assert.ok(!re.test("Dana is here")); assert.ok(!re.test("דנה פה")); assert.ok(!re.test("abandon plans"));
  const esc = nameRegex({ ...EMPTY_PROFILE, name: "A.B", spellings: ["(x)+"] });
  assert.ok(esc.test("hi A.B ok")); assert.ok(!esc.test("hi AxB ok")); assert.ok(esc.test("so (x)+ here"));
  const none = nameRegex(EMPTY_PROFILE);
  for (const t of ["", "Dan", "anything at all", "(^|[\\s,])"]) assert.ok(!none.test(t));
  assert.ok(!nameRegex({ ...EMPTY_PROFILE, name: "  ", spellings: [" "] }).test("  "));
});

test("persona and address rule: name, form of address, about and business; empty parts are left out", () => {
  const male = { ...EMPTY_PROFILE, name: "Dan", address: "male" as const, about: "a consultant", business: "a hosting shop" };
  const t = persona(male);
  assert.match(t, /Dan/); assert.match(t, /masculine/); assert.match(t, /a consultant/); assert.match(t, /a hosting shop/);
  assert.match(hebrewAddressRule({ ...male, address: "female" }), /feminine/);
  assert.match(hebrewAddressRule(EMPTY_PROFILE), /gender-neutral/);
  assert.equal(genderNote(EMPTY_PROFILE), ""); assert.match(genderNote(male), /male/);
  const bare = persona(EMPTY_PROFILE);
  assert.ok(!/About the user|own business/.test(bare)); assert.match(bare, /the user/);
  assert.equal(userName(EMPTY_PROFILE), "the user");
  assert.ok(isMeLabel("me") && isMeLabel("אני") && isMeLabel("dan", male) && !isMeLabel("dana", male));
});

test("masculine fix only applies when the profile addresses the user in the masculine", () => {
  setProfile({ address: "male" }); assert.equal(masculine("שאלי אותם"), "שאל אותם");
  setProfile({ address: "female" }); assert.equal(masculine("שאלי אותם"), "שאלי אותם");
  setProfile({}); assert.equal(masculine("שאלי אותם"), "שאלי אותם");
});

test("pack: look-up order is the user's pack folder, then the example pack, per file", () => {
  const dir = tmp("pack");
  writeFileSync(join(dir, "house-style.md"), "MY STYLE");
  const env = { WINGMAN_PACK_DIR: dir };
  assert.deepEqual(packDirs(env), [dir, EXAMPLE_PACK]);
  assert.equal(packPath("house-style.md", env), join(dir, "house-style.md"));
  assert.equal(readPack("house-style.md", env), "MY STYLE");
  assert.equal(packPath("bank.yaml", env), join(EXAMPLE_PACK, "bank.yaml"));   // not in the user pack: falls back
  assert.equal(packPath("nope.txt", env), undefined); assert.equal(readPack("nope.txt", env), "");
  assert.equal(packDirs({})[0], USER_PACK);
  for (const f of ["bank.yaml", "bank.en.yaml", "house-style.md", "keyterms.txt", "topics.txt"]) assert.ok(existsSync(join(EXAMPLE_PACK, f)), f);
});

test("pack: topics.txt compiles to the loose and strict regexes (=word is a whole word, [strict] counts on its own)", () => {
  const t = parseTopics("# c\nsite\n=cat\n[strict]\nplugin x\n=dns\n");
  assert.ok(t.loose!.test("a SITE here") && t.loose!.test("the cat sat") && !t.loose!.test("concatenate") && t.loose!.test("dns"));
  assert.ok(t.strict!.test("plugin x") && t.strict!.test("DNS") && !t.strict!.test("site") && !t.strict!.test("dnsx"));
  const none = parseTopics("# only a comment\n");
  assert.equal(none.loose, undefined); assert.equal(none.strict, undefined);
  const dir = tmp("topics"); writeFileSync(join(dir, "topics.txt"), "banana\n[strict]\nkiwi\n");
  const env = { WINGMAN_PACK_DIR: dir };
  assert.ok(loadTopics(env).loose!.test("a banana") && !loadTopics(env).strict!.test("a banana") && loadTopics(env).strict!.test("kiwi"));
});

test("pack: isAgencyTopic uses the user's topics.txt, and an empty pack means no topic words", () => {
  resetTrackedKind();
  const dir = tmp("agency"); writeFileSync(join(dir, "topics.txt"), "bicycle\n[strict]\nderailleur\n");
  const old = process.env.WINGMAN_PACK_DIR;
  try {
    process.env.WINGMAN_PACK_DIR = dir;
    assert.equal(isAgencyTopic("my bicycle broke", undefined), true);
    assert.equal(isAgencyTopic("my bicycle broke", "vendor"), false);
    assert.equal(isAgencyTopic("the derailleur broke", "vendor"), true);
    assert.equal(isAgencyTopic("אתר איטי", undefined), false, "the example words are not used when the user's pack has its own topics.txt");
  } finally { process.env.WINGMAN_PACK_DIR = old; }
});

test("pack: stt.keyterms.file empty = the pack's keyterms; an explicit file still wins", () => {
  const dir = tmp("kt"); writeFileSync(join(dir, "keyterms.txt"), "alpha\nbeta\n\n");
  const old = process.env.WINGMAN_PACK_DIR;
  try {
    process.env.WINGMAN_PACK_DIR = dir;
    const S = loadSettings({ env: {}, userFile: join(dir, "absent.yaml") }).settings;
    assert.equal(S.stt.keyterms.file, "");
    assert.deepEqual(loadKeyterms(S), ["alpha", "beta"]);
    const explicit = { ...S, stt: { ...S.stt, keyterms: { ...S.stt.keyterms, file: "data/example-pack/keyterms.txt" } } };
    assert.ok(loadKeyterms(explicit).includes("DNS"));
  } finally { process.env.WINGMAN_PACK_DIR = old; }
});

// ---- no prompt carries a name ----
const SENTINEL = "Zorblax";
function allPrompts(): Record<string, string> {
  const frame = { kind: "vendor" as const, topic: "t", goal: "g", people: [], entities: [], checklist: [] };
  return {
    prefix: buildPrefix("style", [{ id: "a", title: "A", triggers: ["a"], say: "s", facts: [] }], "", "<background_files>x</background_files>"),
    prefixInterview: buildPrefix("style", [], "", "<background_files>x</background_files>", true),
    interview: interviewBlock(),
    userMsgThem: reflexUserMessage({ transcript: "t", question: "q", noAgency: true, context: ["c"] }),
    userMsgMe: reflexUserMessage({ transcript: "t", question: "q", asker: "me", solo: true }),
    classify: classifySystem(), classifyUser: classifyUserMessage({ text: "t", recent: "r", themQuietMs: 1000 } as any),
    tips: tipsSystem(), summary: summarySystem(), summaryGuide: ["vendor", "team", "consult", "personal", "other"].map((k) => kindGuidance(k as any)).join("\n"),
    summaryPrompt: buildPrompt({ lines: [{ ch: "me", text: "hi" }, { ch: "them", text: "yo" }], contextNotes: [], aiNotes: [], frame }),
    notes: notesSystem(), selfcheck: selfcheckSystem(), frame: frameSystem(), frameUser: frameUserMessage({ transcript: "t", contextNotes: [], current: undefined }), topic: topicSystem(),
  };
}

test("prompts: with an empty profile no prompt names anyone; they say 'the user' and carry no address or business text", () => {
  setProfile({});
  for (const [k, p] of Object.entries(allPrompts())) {
    assert.ok(!/\bDan\b|דן/.test(p), `${k} has a name`);
    assert.ok(!/\$\{u\}|\$\{P\./.test(p), `${k} has an unexpanded placeholder`);
    assert.ok(!/\b(his|him|himself)\b/.test(p), `${k} has a gendered pronoun`);
  }
  const all = allPrompts();
  assert.match(all.prefix, /the user/); assert.ok(!/masculine|feminine/.test(all.prefix)); assert.ok(!/web and hosting/.test(all.prefix + all.frame + all.summary));
  assert.match(all.tips, /gender-neutral/);
});

test("prompts: a profile name, address form, about and business are injected into the prompts", () => {
  setProfile({ name: SENTINEL, address: "female", about: "ABOUT-TEXT", business: "BUSINESS-TEXT" });
  const all = allPrompts();
  for (const k of ["prefix", "prefixInterview", "interview", "userMsgMe", "classify", "tips", "summary", "notes", "selfcheck", "frame", "topic"]) assert.match(all[k], new RegExp(SENTINEL), k);
  assert.match(all.prefix, /feminine/); assert.match(all.tips, /feminine/); assert.match(all.prefix, /ABOUT-TEXT/); assert.match(all.prefix, /BUSINESS-TEXT/);
  assert.match(all.summary, /BUSINESS-TEXT/); assert.match(all.frame, /BUSINESS-TEXT/);
  assert.ok(!/masculine/.test(all.prefix));
});

test("detector: the user addressed by name follows the profile; no name means no name alerts", () => {
  setProfile({ name: "Mia", spellings: ["מיה"] });
  assert.ok(isClearQuestion("Mia, what do you think", "unknown")); assert.ok(isClearQuestion("היי מיה", "unknown")); assert.ok(!isClearQuestion("Dan, what do you think", "unknown"));
  setProfile({});
  assert.ok(!isClearQuestion("Mia, what do you think", "unknown"));
});

test("time zone: the profile zone is used for 'now' in ME requests, else this machine's", () => {
  setProfile({ timezone: "Asia/Tokyo" });
  assert.match(nowText(new Date("2026-11-02T13:00:00Z")), /22:00 \(Asia\/Tokyo, UTC\+9\)/);
  setProfile({});
  assert.match(nowText(new Date("2026-11-02T13:00:00Z")), new RegExp(`\\(${Intl.DateTimeFormat().resolvedOptions().timeZone.replace("/", "\\/")},`));
});

// ---- the CLI ----
async function cli(file: string, ...argv: string[]) {
  let out = "", err = "";
  const code = await main(argv, { env: { ...process.env, WINGMAN_PROFILE_FILE: file }, out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { code, out, err, json: (() => { try { return JSON.parse(out.trim().split("\n")[0]); } catch { return undefined; } })() };
}

test("wingman profile: show defaults, set fields (repeatable --spelling, empty clears), validation, file mode 600", async () => {
  const f = join(tmp("cli"), "p", "profile.yaml");
  let r = await cli(f, "profile", "show", "--json");
  assert.equal(r.code, 0); assert.equal(r.json.exists, false); assert.equal(r.json.profile.address, "neutral");
  r = await cli(f, "profile", "set", "--name", "Ada", "--spelling", "עדה", "--spelling", "Adah", "--address", "female", "--about", "an engineer", "--business", "a studio", "--timezone", "Europe/Paris", "--json");
  assert.equal(r.code, 0); assert.deepEqual(r.json.profile.spellings, ["עדה", "Adah"]);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(getProfile({ WINGMAN_PROFILE_FILE: f }).name, "Ada");
  r = await cli(f, "profile", "set", "--about", "", "--json");
  assert.equal(r.code, 0); assert.equal(r.json.profile.about, ""); assert.equal(r.json.profile.name, "Ada", "other fields are kept");
  r = await cli(f, "profile", "show");
  assert.match(r.out, /Ada/); assert.match(r.out, /female/);
  assert.equal((await cli(f, "profile", "set", "--address", "robot")).code, 2);
  assert.equal((await cli(f, "profile", "set", "--timezone", "Mars/Base")).code, 2);
  assert.equal((await cli(f, "profile", "set")).code, 2);
  assert.equal((await cli(f, "profile", "bogus")).code, 2);
  writeFileSync(f, "nmae: typo\n");
  r = await cli(f, "profile", "show", "--json");
  assert.equal(r.code, 1); assert.equal(r.json.error.code, "invalid_profile");
});

// ---- the repo itself carries no personal words ----
// Tracked files plus new files that are not ignored (so it also works before the first commit). The denylist is NOT in the repo: set WINGMAN_DENYLIST (words separated by commas) or put one word or regex per line in the untracked
// stage0/data/private/denylist.txt. Without either, this test only checks that the mechanism works.
import { execFileSync } from "node:child_process";
import { ROOT } from "./env.ts";
const SCANNED = ["src", "tray", "dashboard", "overlay", "shared", "config", "data", "profiles", "scripts"];
const EXCLUDE = /^(src\/profile\.test\.ts)$/;
function denylist(): RegExp | undefined {
  const file = join(ROOT, "data", "private", "denylist.txt");
  const words = [
    ...(process.env.WINGMAN_DENYLIST ?? "").split(","),
    ...(existsSync(file) ? readFileSync(file, "utf8").split("\n") : []),
  ].map((w) => w.trim()).filter((w) => w && !w.startsWith("#"));
  return words.length ? new RegExp(words.join("|"), "i") : undefined;
}
function trackedFiles(): string[] {
  try { return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...SCANNED], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean); } catch { return []; }
}
test("repo guard: no tracked source, data or config file contains a word from the private denylist", (t) => {
  const re = denylist();
  const files = trackedFiles();
  if (!files.length) return t.skip("not a git checkout");
  assert.ok(files.some((f) => f.endsWith("src/profile.ts")), "the scan lists the source files");
  if (!re) return t.skip("no denylist configured (set WINGMAN_DENYLIST or data/private/denylist.txt)");
  const hits: string[] = [];
  for (const rel of files) {
    if (EXCLUDE.test(rel.replace(/^stage0\//, ""))) continue;
    let text: string; try { text = readFileSync(join(ROOT, rel.replace(/^stage0\//, "")), "utf8"); } catch { continue; }
    text.split("\n").forEach((l, i) => { if (re.test(l) || re.test(rel)) hits.push(`${rel}:${i + 1}`); });
  }
  assert.deepEqual(hits.slice(0, 20), [], "personal words in the repo");
});
