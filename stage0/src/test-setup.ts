// Imported first by every test: the tests run as an invented user ("Dan", male, a small web and hosting business) and never read the real
// ~/.config/wingman/profile.yaml or pack. Child processes started by a test inherit these variables.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const STAGE0 = join(dirname(fileURLToPath(import.meta.url)), "..");
process.env.WINGMAN_PROFILE_FILE = join(STAGE0, "data", "test", "profile.yaml");
process.env.WINGMAN_PACK_DIR = join(STAGE0, "data", "test", "no-pack");   // does not exist: the pack falls back to data/example-pack
