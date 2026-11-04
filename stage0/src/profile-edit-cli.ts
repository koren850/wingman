// Child process for the Wingman window (dashboard/setup-ipc.cjs): read or write the user profile (the same file and code as `wingman profile set`).
// `read`: prints {ok, profile, file, exists}. `write`: reads {name, spellings, address, about, business} JSON from stdin, keeps the other fields
// (timezone), validates with the profile schema and saves with saveProfile. One JSON line on stdout. WINGMAN_PROFILE_FILE redirects the file (tests).
import { existsSync, readFileSync } from "node:fs";
import { EMPTY_PROFILE, ProfileError, parseProfile, profileFile, profileSchema, saveProfile, type Profile } from "./profile.ts";

const file = profileFile(), mode = process.argv[2];
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const read = (): Profile => (existsSync(file) ? parseProfile(readFileSync(file, "utf8"), file) : EMPTY_PROFILE);
try {
  if (mode === "read") out({ ok: true, profile: read(), file, exists: existsSync(file) });
  else if (mode === "write") {
    let raw = ""; for await (const c of process.stdin) raw += c;
    const d = JSON.parse(raw);
    if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("bad profile");
    const keys = Object.keys(d);
    if (keys.some((k) => !["name", "spellings", "address", "about", "business"].includes(k))) throw new Error("unknown profile field");
    const next = profileSchema.parse({ ...read(), ...d });
    saveProfile(next, file);
    out({ ok: true, profile: read(), file });
  } else out({ ok: false, message: "mode must be read or write" });
} catch (e) {
  out({ ok: false, message: e instanceof ProfileError ? e.message.slice(0, 300) : String((e as Error).message || e).slice(0, 300) });
}
