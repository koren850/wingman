// Loaded by every test script (node --import ./src/test-setup.ts) and imported first by most tests: the tests run as an invented user ("Dan", male, a small web and hosting business) and never read the real
// ~/.config/wingman/profile.yaml or pack. Child processes started by a test inherit these variables.
import { join, dirname, sep } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
process.env.WINGMAN_PROFILE_FILE = join(APP_DIR, "data", "test", "profile.yaml");
// The user data folder (calls, prepared meetings, snapshot) is a temp folder: tests never touch the real ~/Library/Application Support/Wingman.
// A caller's WINGMAN_DATA_DIR is kept only when it is already under the temp folder; anything else is replaced.
const fresh = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const underTmp = (p: string | undefined) => !!p && (p === tmpdir() || p.startsWith(tmpdir() + sep));
if (!underTmp(process.env.WINGMAN_DATA_DIR)) process.env.WINGMAN_DATA_DIR = fresh("wingman-test-data-");
// The user settings file is a fresh path too (it may not exist yet), so the caller's ~/.config settings never leak in.
process.env.WINGMAN_USER_SETTINGS = join(fresh("wingman-test-settings-"), "settings.yaml");
process.env.WINGMAN_PACK_DIR = join(APP_DIR, "data", "test", "no-pack"); // does not exist: the pack falls back to data/example-pack, which tests ask for
process.env.WINGMAN_EXAMPLE_PACK = "1"; // without this a missing pack means no prepared cards (the product default)
// Placeholder keys so the subprocess tests never need (or read) a real key. They only fill gaps: the model and the speech source are fakes in tests.
for (const v of ["DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY"]) process.env[v] ||= "test-placeholder-key";
