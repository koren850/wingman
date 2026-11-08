"use strict";
// IPC for the guided setup and the "About you" settings. Runs in the Electron MAIN process; every handler is registered through the host's
// sender-checked handle() (window.cjs). The page can only ask for fixed actions: no path, URL or command ever comes from it.
//   profile:get / profile:set    your name, spellings, how to address you, about, business (the same code as `wingman profile set`)
//   setup:status                 platform, microphone permission, number of screens, mic, screen and privacy settings, which pack is in use
//   setup:askMic / setup:openPrivacy / setup:openLink   the Microphone prompt, the Privacy panes (macOS, Windows) and the key and billing pages (fixed addresses)
//   setup:mics / setup:setMic    list microphones, save audio.mic.device
//   setup:setOneScreen           save overlay.allowPrimary
//   setup:copyPack / setup:revealPack   copy a starter pack (or the example pack) into your own pack folder (never overwrites)
// Snapshot/preview mode (o.preview) never reads or writes anything real.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PANES = Object.freeze({
  mic: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  audio: "x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture",
});
/** The Windows page for the microphone switch. Windows needs no permission for the sound of the call itself. */
const WIN_PANES = Object.freeze({ mic: "ms-settings:privacy-microphone" });
const paneFor = (which, platform) => (platform === "win32" ? WIN_PANES[which] : platform === "darwin" ? PANES[which] : undefined);
const LINKS = Object.freeze({
  deepgram: "https://console.deepgram.com/signup",
  anthropic: "https://console.anthropic.com/settings/keys",
  deepgramBilling: "https://console.deepgram.com/billing",
  anthropicBilling: "https://console.anthropic.com/settings/billing",
});
const ADDRESS = ["male", "female", "neutral"];
const PACK_FILES = ["bank.yaml", "bank.en.yaml", "house-style.md", "keyterms.txt", "topics.txt"];
const preview = { ok: false, error: "preview" };

/** Strict check of the About-you form. Same limits as src/profile.ts (which validates again). Throws Error("bad profile: ...") on anything else. */
function cleanProfile(d) {
  const bad = (m) => {
    throw new Error("bad profile: " + m);
  };
  if (!d || typeof d !== "object" || Array.isArray(d)) bad("not an object");
  const keys = Object.keys(d);
  if (keys.length !== 5 || keys.some((k) => !["name", "spellings", "address", "about", "business"].includes(k))) bad("fields");
  const str = (v, max, what) => {
    if (typeof v !== "string") bad(what);
    const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim(); // keep tab and newline (about/business are free text)
    if (s.length > max) bad(what + " too long");
    return s;
  };
  const name = str(d.name, 60, "name");
  if (/[\n\r\t]/.test(name)) bad("name");
  if (!Array.isArray(d.spellings) || d.spellings.length > 20) bad("spellings");
  const spellings = [...new Set(d.spellings.map((s) => str(s, 60, "spelling")).filter(Boolean))];
  if (spellings.some((s) => /[\n\r\t]/.test(s))) bad("spelling");
  if (typeof d.address !== "string" || !ADDRESS.includes(d.address)) bad("address");
  return { name, spellings, address: d.address, about: str(d.about, 1500, "about"), business: str(d.business, 1500, "business") };
}
/** audio.mic.device: ":default" or ":N" (the avfoundation index from the list). null = back to the default. */
function cleanMic(v) {
  if (v === null) return null;
  if (typeof v !== "string" || !/^:(default|\d{1,2})$/.test(v)) throw new Error("bad microphone");
  return v;
}

/** ":2" + the device list -> ":2|Name" (the name cleaned: no control characters, no "|", at most 80 characters). No such index in the list: ":2". */
function withMicName(dev, devices) {
  const d = Array.isArray(devices) ? devices.find((x) => x && ":" + x.index === dev && typeof x.name === "string") : undefined;
  const name = d
    ? d.name
        .replace(/[\u0000-\u001f\u007f|]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80)
    : "";
  return name ? dev + "|" + name : dev;
}

/** Folder of the user's own pack and the shipped example. env.WINGMAN_PACK_DIR redirects the user pack (tests). */
function packDirs(root, env = process.env, home = os.homedir()) {
  return { user: env.WINGMAN_PACK_DIR || path.join(home, ".config", "wingman", "pack"), example: path.join(root, "data", "example-pack") };
}
/** Which pack answers: "user" when the user's folder has at least one pack file, else "example". */
function packInfo(root, env, home) {
  const d = packDirs(root, env, home);
  const mine = PACK_FILES.filter((f) => {
    try {
      return fs.statSync(path.join(d.user, f)).isFile();
    } catch {
      return false;
    }
  });
  return { using: mine.length ? "user" : "example", userDir: d.user, userFiles: mine, canCopy: !mine.length };
}
/** Packs the user can start from: "example" (data/example-pack) or a folder in data/starter-packs. */
const STARTERS = ["example", "sales", "support", "interview", "empty"];
/** Copies a starter pack (default: the example pack) into the user pack folder (folder 700, files 600). Refuses when the user already has pack files. */
function copyExamplePack(root, env, home, pick = "example") {
  if (!STARTERS.includes(pick)) return { ok: false, error: "Unknown starter answers." };
  const d = packDirs(root, env, home),
    info = packInfo(root, env, home);
  if (pick !== "example") d.example = path.join(root, "data", "starter-packs", pick);
  if (!info.canCopy) return { ok: false, error: "Your answers folder already has files, so nothing was copied." };
  fs.mkdirSync(d.user, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const f of PACK_FILES) {
    const src = path.join(d.example, f),
      dst = path.join(d.user, f);
    if (!fs.existsSync(src)) continue;
    try {
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(dst, 0o600);
      copied.push(f);
    } catch (e) {
      if (e.code !== "EEXIST") return { ok: false, error: "Could not copy the answers: " + String(e.message).slice(0, 120) };
    }
  }
  if (!copied.length) return { ok: false, error: "Those starter answers are not part of this install, so nothing was copied." };
  return { ok: true, copied, dir: d.user };
}

/**
 * o: { handle, child(args, input) -> Promise<json>, root, systemPreferences, shell, screen, preview (bool), env?, home? }
 */
function register(o) {
  const env = o.env || process.env,
    home = o.home || os.homedir(),
    platform = o.platform || process.platform;
  const lastAsk = { at: 0 };
  const done = (r) => (r && r.ok ? r : { ok: false, message: String((r && r.message) || "Failed.").slice(0, 300) });

  o.handle("profile:get", async () =>
    o.preview
      ? { ok: true, profile: { name: "", spellings: [], address: "neutral", about: "", business: "", timezone: "" }, preview: true }
      : done(await o.child(["src/profile-edit-cli.ts", "read"])),
  );
  o.handle("profile:set", async (d) => {
    const clean = cleanProfile(d); // throws on a bad shape: the page gets a plain error
    if (o.preview) return preview;
    const r = await o.child(["src/profile-edit-cli.ts", "write"], JSON.stringify(clean));
    return done(r);
  });

  o.handle("setup:status", async () => {
    const pack = packInfo(o.root, env, home);
    let mic = "unknown",
      displays = 1;
    try {
      mic = o.systemPreferences.getMediaAccessStatus("microphone");
    } catch {
      /* not macOS */
    }
    try {
      displays = o.screen.getAllDisplays().length;
    } catch {
      /* keep 1 */
    }
    let micDevice = ":default",
      allowPrimary = false,
      requireConsent = false,
      mipOptOut = false;
    if (!o.preview) {
      const s = await o.child(["src/settings-edit-cli.ts", "read"]);
      if (s && s.ok && s.values) {
        micDevice = String(s.values["audio.mic.device"] || ":default").split("|")[0]; // the saved name after "|" is for the engine
        allowPrimary = s.values["overlay.allowPrimary"] === true;
        requireConsent = s.values["privacy.requireConsentAck"] === true;
        mipOptOut = s.values["stt.deepgram.mipOptOut"] === true;
      }
    }
    return { ok: true, platform, mic, systemAudio: "unknown", displays, micDevice, allowPrimary, requireConsent, mipOptOut, pack };
  });
  o.handle("setup:askMic", async () => {
    if (o.preview) return preview;
    if (Date.now() - lastAsk.at < 1500) return { ok: false, error: "wait" };
    lastAsk.at = Date.now();
    let granted = false;
    try {
      granted = await o.systemPreferences.askForMediaAccess("microphone");
    } catch {
      granted = false;
    }
    let mic = "unknown";
    try {
      mic = o.systemPreferences.getMediaAccessStatus("microphone");
    } catch {
      /* ignore */
    }
    return { ok: true, granted: !!granted, mic };
  });
  o.handle("setup:openPrivacy", async (which) => {
    if (typeof which !== "string" || !Object.prototype.hasOwnProperty.call(PANES, which)) throw new Error("bad pane");
    if (o.preview) return preview;
    const url = paneFor(which, platform);
    if (!url) return { ok: false, error: "This system has no such page." };
    try {
      await o.shell.openExternal(url);
      return { ok: true };
    } catch {
      return { ok: false, error: "Could not open the system settings." };
    }
  });
  o.handle("setup:openLink", async (which) => {
    if (typeof which !== "string" || !Object.prototype.hasOwnProperty.call(LINKS, which)) throw new Error("bad link");
    if (o.preview) return preview;
    try {
      await o.shell.openExternal(LINKS[which]);
      return { ok: true };
    } catch {
      return { ok: false, error: "Could not open the browser." };
    }
  });
  /** The microphones for the list: the app's own capture window when there is one (no ffmpeg), else the engine tool (ffmpeg, macOS only). */
  const listMics = async () => {
    if (o.listMics) {
      try {
        const r = await o.listMics();
        return { ok: true, devices: r.devices, defaultInput: r.defaultName };
      } catch (e) {
        return {
          ok: false,
          message: e && e.code === "permission" ? "Microphone access is off. Allow Wingman in the system privacy settings." : "Could not read the microphones.",
        };
      }
    }
    return o.child(["src/mics-cli.ts"]);
  };
  o.handle("setup:mics", async () =>
    o.preview
      ? {
          ok: true,
          devices: [
            { index: 0, name: "MacBook Pro Microphone" },
            { index: 1, name: "External USB Microphone" },
          ],
          defaultInput: "MacBook Pro Microphone",
          preview: true,
        }
      : done(await listMics()),
  );
  o.handle("setup:setMic", async (v) => {
    const dev = cleanMic(v);
    if (o.preview) return preview;
    // Save the device name next to the index (":2|Name"): indexes move when a headset or a USB mic connects, the engine re-checks the name at every start.
    let saved = dev;
    if (dev && /^:\d{1,2}$/.test(dev)) {
      try {
        const list = await listMics();
        saved = withMicName(dev, list && list.ok ? list.devices : []);
      } catch {
        saved = dev; // the list is only a help: the index alone still works as before
      }
    }
    return done(await o.child(["src/settings-edit-cli.ts", "write"], JSON.stringify({ "audio.mic.device": saved })));
  });
  o.handle("setup:setOneScreen", async (on) => {
    if (typeof on !== "boolean") throw new Error("bad argument");
    if (o.preview) return preview;
    return done(await o.child(["src/settings-edit-cli.ts", "write"], JSON.stringify({ "overlay.allowPrimary": on ? true : null })));
  });
  o.handle("setup:copyPack", (pick) => (o.preview ? preview : copyExamplePack(o.root, env, home, typeof pick === "string" ? pick : "example")));
  o.handle("setup:revealPack", async () => {
    if (o.preview) return preview;
    const d = packDirs(o.root, env, home).user;
    if (!fs.existsSync(d)) return { ok: false, error: "You have no answers folder yet." };
    const err = await o.shell.openPath(d);
    return err ? { ok: false, error: "Could not open the folder." } : { ok: true };
  });
}

module.exports = { register, LINKS, WIN_PANES, paneFor, cleanProfile, cleanMic, withMicName, packInfo, copyExamplePack, packDirs, PANES, PACK_FILES };
