// Imported first by every test: the tests run as an invented user ("Dan", male, a small web and hosting business) and never read the real
// ~/.config/wingman/profile.yaml or pack. Child processes started by a test inherit these variables.
import { join, dirname } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
process.env.WINGMAN_PROFILE_FILE = join(APP_DIR, "data", "test", "profile.yaml");
// The user data folder (calls, prepared meetings, snapshot) is a temp folder: tests never touch the real ~/Library/Application Support/Wingman.
process.env.WINGMAN_DATA_DIR ||= mkdtempSync(join(tmpdir(), "wingman-test-data-"));
process.env.WINGMAN_PACK_DIR = join(APP_DIR, "data", "test", "no-pack"); // does not exist: the pack falls back to data/example-pack
