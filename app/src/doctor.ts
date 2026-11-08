// wingman doctor: tests the CONFIGURED providers and their fallbacks, the settings, keys, local tools and the offline
// readiness checklist. Ends with READY / READY WITH WARNINGS / NOT READY (exit 1). Also run by the tray app as "readiness check".
// Top-level script on purpose: it runs top to bottom, printing sections as it goes; finish() exits.
//   pnpm run doctor              everything (mic, system audio, STT sockets, 1-2 small LLM calls per model: costs a few cents)
//   pnpm run doctor --offline    no audio, no network, no paid calls: settings, keys, packages, files, resources
import { execFile, execFileSync, spawn } from "node:child_process";
import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadKeysWithSources, KEYS_FILE, KEY_VARS, CALLS, type KeyName } from "./env.ts";
import { peakOf } from "./audio.ts";
import { backendFor, type AudioSource } from "./audio-platform.ts";
import { loadBank } from "./bank.ts";
import { readPack, packPath, packMixedIn, packDirs, EXAMPLE_PACK } from "./pack.ts";
import { checkProfile, profileFile } from "./profile.ts";
import { buildPrefix, runReflex } from "./reflex.ts";
import { loadSettings, SettingsError, formatSettingsError, expandHome, USER_SETTINGS_FILE, type Settings } from "./settings.ts";
import { ModelRegistry, parseModelRef, ConfigError, LLM_PROVIDERS } from "./providers/llm.ts";
import { getSttProvider, sttChain, loadKeyterms } from "./providers/stt/index.ts";
import { describe, classifyLlmError } from "./providers/errors.ts";
import { realKeychain } from "./keychain.ts";
import { guard } from "./guards.ts";
import { detect } from "./detector.ts";
import { micVerdict } from "./mic-check.ts";

// Running inside the installed Wingman app (Electron runtime, or the env var the tray sets): permissions belong to Wingman, not a terminal.
const IS_APP = !!process.versions.electron || process.env.WINGMAN_APP === "1";
const argv = process.argv.slice(2);
const offline = argv.includes("--offline");
const blocking: string[] = [];
let warnings = 0;
// Result printers: ok = pass, bad = blocking (exit 1), warn = counted but not blocking.
const ok = (m: string) => console.log(`  ✅ ${m}`);
const bad = (m: string, fix?: string) => {
  blocking.push(m);
  console.log(`  ❌ ${m}${fix ? `\n     fix: ${fix}` : ""}`);
};
const warn = (m: string, fix?: string) => {
  warnings++;
  console.log(`  ⚠️  ${m}${fix ? `\n     fix: ${fix}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dev = (t: string) => (IS_APP ? "" : t); // terminal-only hints stay out of the app's text
const section = (t: string) => console.log(`\n${t}`);

console.log(`Wingman readiness check${offline ? " (offline: no audio, no network, no paid calls)" : ""}`);

// Settings first: everything else depends on them. Invalid settings stop the run here.
section("Settings");
let S: Settings;
let profile: string | undefined;
try {
  const l = loadSettings({ argv, createStarter: true });
  S = l.settings;
  profile = l.profile;
  ok(
    `settings valid (defaults + ${existsSync(process.env.WINGMAN_USER_SETTINGS || USER_SETTINGS_FILE) ? "user file" : "no user file"}${profile ? ` + profile ${profile}` : ""})${dev("; see: pnpm settings")}`,
  );
} catch (e) {
  if (e instanceof SettingsError) {
    console.log(formatSettingsError(e));
    bad("settings invalid", IS_APP ? "fix the setting above, then run the readiness check again" : "fix the key above, then rerun");
  } else bad(`settings failed to load: ${(e as Error).message}`);
  finish();
}
S = S!;

section("Keys (source and last 4 characters only; values are never shown)");
const keyFile = expandHome(S.keys.file) || KEYS_FILE;
if (existsSync(keyFile) && process.platform !== "win32") {
  // Windows has no POSIX modes
  const mode = statSync(keyFile).mode & 0o777;
  mode === 0o600 ? ok(`keys file mode 600`) : bad(`keys file mode is ${mode.toString(8)}`, `chmod 600 ${keyFile}`);
}
const { keys, sources } = loadKeysWithSources(keyFile, process.env, realKeychain());
const llmRefs = [S.llm.reflex.model, ...S.llm.reflex.fallbacks];
const sttIds = sttChain(S);
const srcLabel = (n: KeyName) => (({ keychain: "Keychain", file: "file", env: "environment" }) as const)[sources[n]!];
const keyFix = (name: KeyName) =>
  IS_APP
    ? "Wingman → Settings → Keys: paste the key (it is stored in the macOS Keychain)"
    : `pnpm keys set ${name} (stored in the Keychain), or Wingman → Settings → Keys`;
const need = (name: KeyName, why: string, required: boolean) =>
  keys[name]
    ? ok(`${KEY_VARS[name]} present, source: ${srcLabel(name)}, ends ...${keys[name]!.slice(-4)} (${why})`)
    : required
      ? bad(`${KEY_VARS[name]} missing (${why})`, keyFix(name))
      : warn(`${KEY_VARS[name]} missing (${why}); that fallback cannot work`, keyFix(name));
sttIds.filter((id) => id !== "script").forEach((id, i) => need(id as KeyName, `STT ${i ? "fallback" : "primary"} ${id}`, i === 0));
if (!S.run.noAi)
  llmRefs.forEach((r, i) => {
    try {
      const k = LLM_PROVIDERS[parseModelRef(r).provider].key;
      if (k) need(k, `LLM ${i ? "fallback" : "reflex"} ${r}`, i === 0);
      else ok(`${r} needs no key (offline test double)`);
    } catch (e) {
      bad((e as Error).message);
    }
  });

section("Provider packages and models");
const registry = new ModelRegistry(keys);
for (const id of sttIds) {
  const p = getSttProvider(id);
  ok(`STT adapter ${id}${p.experimental ? " (EXPERIMENTAL: not tested live)" : ""}`);
}
if (!S.run.noAi)
  for (const [i, r] of llmRefs.entries()) {
    try {
      await registry.resolve(r);
      ok(`model ${r} resolves${registry.capabilities(r).cache ? "" : " (no Anthropic cache/effort options for this provider)"}`);
    } catch (e) {
      const m = e instanceof ConfigError ? e.message : (e as Error).message;
      i === 0 ? bad(m, e instanceof ConfigError ? e.fix : undefined) : warn(`fallback ${r}: ${m}`, e instanceof ConfigError ? e.fix : undefined);
    }
  }

section("Data");
try {
  const bank = loadBank();
  const ids = new Set(bank.map((c) => c.id));
  ids.size === bank.length && bank.length > 0
    ? ok(`Prepared cards load: ${bank.length} cards, unique ids`)
    : bad("Prepared cards: ids are not unique or the list is empty");
} catch (e) {
  bad(`Prepared cards failed to load: ${(e as Error).message}`);
}
try {
  const P = checkProfile();
  P.name || P.spellings.length
    ? ok(`profile: ${P.name || P.spellings[0]} (address: ${P.address})${packPath("bank.yaml")?.startsWith(EXAMPLE_PACK) ? ", example pack in use" : ""}`)
    : warn(
        "no user profile (name detection and the Hebrew address form are off)",
        `wingman profile set --name <name> --address male|female|neutral  (${profileFile()})`,
      );
} catch (e) {
  bad(`profile: ${(e as Error).message}`, "wingman profile set ... or fix the file");
}
for (const f of packMixedIn()) warn(`your pack has no ${f}: the example pack's ${f} is used instead (invented content)`, `add ${f} to ${packDirs()[0]}`);
const terms = loadKeyterms(S);
S.stt.keyterms.enabled === "off"
  ? ok("keyterms off by setting")
  : terms.length
    ? ok(`${terms.length} keyterms (max ${S.stt.keyterms.max})`)
    : warn("no keyterms loaded", `check ${S.stt.keyterms.file || "the pack's keyterms.txt"}`);
S.privacy.requireConsentAck && ok('"Ask me before listening starts" is on: listening starts after you confirm');
guard("זה עולה 500 ₪").ok === false && guard("נסיים עד יום חמישי").ok === false
  ? ok(`guards block price and date bait${dev(" (full corpus: pnpm test)")}`)
  : bad("guards let price/date bait through");
detect("כמה זה עולה").isQuestion ? ok(`detector sanity${dev(" (full corpus: pnpm detector)")}`) : bad("detector failed a basic question");

section("Tools and resources");
// Runs a local tool and returns trimmed stdout, or "" on any failure (missing tool, non-zero exit).
const run = (cmd: string, a: string[]) => {
  try {
    return execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
Number(process.versions.node.split(".")[0]) >= 24 ? ok(`Node ${process.versions.node}`) : warn(`Node ${process.versions.node} (24+ expected)`);
const sw = run("sw_vers", ["-productVersion"]);
if (sw) {
  const [a, b] = sw.split(".").map(Number);
  a > 14 || (a === 14 && b >= 2) ? ok(`macOS ${sw}`) : bad(`macOS ${sw}: system audio tap needs 14.2+`);
}
// Under the app the microphone is recorded by the app itself: no ffmpeg. A terminal run still uses ffmpeg for the microphone.
const appCapture = !!process.env.WINGMAN_CAPTURE_ENDPOINT && process.env.WINGMAN_MIC_ENGINE !== "ffmpeg";
if (appCapture) ok("audio is recorded by the Wingman app (no ffmpeg needed)");
else run("ffmpeg", ["-version"]) ? ok("ffmpeg present") : bad("ffmpeg not found", "install ffmpeg (brew install ffmpeg), then run the readiness check again");
const batt = run("pmset", ["-g", "batt"]);
if (batt) {
  const pct = Number(batt.match(/(\d+)%/)?.[1]);
  /AC Power/.test(batt) || pct > 20
    ? ok(`power ok (${pct}%${/AC Power/.test(batt) ? ", charging" : ""})`)
    : warn(`battery ${pct}% and not charging`, "plug in");
}
const df = run("df", ["-m", "."]).split("\n")[1]?.split(/\s+/);
const freeMb = df ? Number(df[3]) : NaN;
if (Number.isFinite(freeMb)) {
  freeMb > 500 ? ok(`free disk ${Math.round(freeMb / 1024)} GB`) : warn(`free disk ${freeMb} MB`, "free some space");
}
const orphans = run("pgrep", ["-f", "ffmpeg.*avfoundation|audiotee"]);
orphans
  ? warn("leftover ffmpeg/audiotee process found", IS_APP ? "quit Wingman from the menu bar and open it again" : "pkill -f 'ffmpeg.*avfoundation|audiotee'")
  : ok("no orphan audio processes");
if (S.overlay.enabled) {
  const displays = Number(run("sh", ["-c", "system_profiler SPDisplaysDataType 2>/dev/null | grep -c 'Resolution:'"]));
  displays >= 2
    ? ok(`${displays} displays: overlay goes to the second`)
    : displays === 1
      ? S.overlay.allowPrimary
        ? warn("one display and overlay.allowPrimary: the overlay will be on the shared screen")
        : bad("only one display: the overlay would refuse to open", "connect a second screen, or set overlay.allowPrimary: true (never share that screen)")
      : warn("could not count displays");
}

section("Budget and data hygiene");
{
  // Month-to-date spend = sum of each call's last totals row (role "summary") written this calendar month.
  let month = 0;
  const now = new Date();
  let old = 0;
  if (existsSync(CALLS))
    for (const d of readdirSync(CALLS)) {
      const dir = join(CALLS, d);
      let st;
      try {
        st = statSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (Date.now() - st.mtimeMs > S.privacy.retentionDays * 86400_000) old++;
      const uf = join(dir, "usage.jsonl");
      if (existsSync(uf))
        for (const line of readFileSync(uf, "utf8").split("\n").filter(Boolean)) {
          try {
            const r = JSON.parse(line);
            if (r.role === "summary" && new Date(r.t).getMonth() === now.getMonth()) month += Number(r.totalUsd) || 0;
          } catch {
            /* a log row that is not valid JSON is skipped */
          }
        }
    }
  S.budget.maxUsdPerMonth === null
    ? ok(`month-to-date $${month.toFixed(2)} (no monthly cap set)`)
    : month < S.budget.maxUsdPerMonth
      ? ok(`month-to-date $${month.toFixed(2)} of $${S.budget.maxUsdPerMonth}`)
      : warn(`month-to-date $${month.toFixed(2)} reached budget.maxUsdPerMonth $${S.budget.maxUsdPerMonth}`);
  old
    ? warn(
        `${old} saved call(s) older than ${S.privacy.retentionDays} days`,
        IS_APP ? "delete the old calls in the Wingman window (Calls tab)" : `pnpm purge --older-than ${S.privacy.retentionDays}`,
      )
    : ok("no calls past retention");
  // Soft hourly AI cap (moment engine). Estimates: typical about 0.09 USD an hour, a busy hour about 0.20 USD.
  {
    const cap = S.budget.maxLlmUsdPerHour,
      on = S.moments.engine === "v2";
    const tail = on ? "" : " (used by the New help engine, which is off)";
    cap === 0
      ? ok(`no hourly AI cap (budget.maxLlmUsdPerHour 0)${tail}`)
      : cap >= 0.2
        ? ok(`hourly AI cap ${cap} USD: a typical hour costs about 0.09 USD, a busy one about 0.20 USD${tail}`)
        : warn(
            `hourly AI cap ${cap} USD is below a busy hour (about 0.20 USD): the cheapest jobs stop early (memory clean-up at 60%, live reading at 80%)${tail}`,
            "raise budget.maxLlmUsdPerHour, or set it to 0 for no hourly cap",
          );
    if (on && !S.memory.enabled) warn("memory.enabled is off: the New help engine has no call memory (cards still work, but know less)");
  }
  const missingPrice = [...llmRefs, S.memory.model, S.digest.model].filter(
    (r, i, a) => a.indexOf(r) === i && !r.startsWith("scripted:") && !S.budget.prices.llm[r],
  );
  missingPrice.length ? warn(`no price in budget.prices.llm for ${missingPrice.join(", ")}: cost shows $0`) : ok("price table covers the configured models");
}

section("Prompt cache (usage of the last 5 calls)");
{
  const { recentUsageRows, cacheReport, formatCacheReport, cacheAdvice } = await import("./cost.ts");
  const { cacheMinTokens } = await import("./context/cache.ts");
  const rows = recentUsageRows(CALLS, 5);
  const rep = cacheReport(rows);
  // Calls from the scripted test models are fixtures, not real usage: say so on the report.
  const simulated = rows.length > 0 && rows.every((r) => typeof r.model === "string" && r.model.startsWith("scripted:"));
  const modelOf = (role: string) => (role === "memory" || role === "compact" ? S.memory.model : S.llm.reflex.model);
  if (!rep.length) ok("no saved calls with token counts yet: the report shows after the first call");
  else {
    for (const l of formatCacheReport(rep, { simulated })) console.log(`     ${l}`);
    const { blockAReport, formatBlockA } = await import("./cost.ts");
    for (const l of formatBlockA(blockAReport(rows, (role) => cacheMinTokens(modelOf(role))))) console.log(`     ${l}`);
    const adv = cacheAdvice(rep, (role) => cacheMinTokens(modelOf(role)));
    adv.length ? adv.forEach((a) => warn(a)) : ok("cache reads and the token estimate look right");
  }
  for (const m of [...new Set([S.llm.reflex.model, S.memory.model])]) {
    const min = cacheMinTokens(m);
    console.log(`     ${m}: caches prompts of ${min === Infinity ? "no size (this provider has no prompt cache here)" : `${min} tokens or more`}`);
  }
}

section("Screens and audio devices");
{
  const { readAudioDevices, bluetoothInUse } = await import("./devices.ts");
  const bt = bluetoothInUse(await readAudioDevices());
  bt
    ? warn(
        `${bt.device.name} is the ${bt.role === "mic" ? "microphone" : "speaker output"}: Bluetooth call audio lowers transcript quality`,
        "use the Mac microphone, or wired headphones",
      )
    : ok("no Bluetooth headset in use");
  const screens = await new Promise<number>((res) =>
    execFile("system_profiler", ["SPDisplaysDataType", "-json"], { timeout: 5000 }, (e, out) => {
      try {
        res(e ? -1 : ((JSON.parse(out).SPDisplaysDataType ?? []) as { spdisplays_ndrvs?: unknown[] }[]).flatMap((g) => g.spdisplays_ndrvs ?? []).length);
      } catch {
        res(-1);
      }
    }),
  );
  if (screens < 0) warn("could not count screens");
  else if (screens >= 2) ok(`${screens} screens: the answer window opens on the second one`);
  else if (S.overlay.allowPrimary) warn("only one screen: the answer window opens on it (overlay.allowPrimary). Do NOT share this screen");
  else warn("only one screen: the answer window will NOT open (it would show when you share your screen)", "connect the second screen before the call");
}

if (offline) {
  console.log("\n(skipped: microphone, system audio, STT sockets, LLM calls, network latency. Run without --offline before a call.)");
  finish();
}

section("Microphone (speak normally for 5 seconds)");
{
  const mic: AudioSource = backendFor().createMic(S.audio.mic.device);
  let peak = 0,
    chunks = 0;
  const micName = S.audio.mic.device.split("|")[1] || S.audio.mic.device;
  console.log(`  device: ${micName} (audio.mic.device; avoid AirPods for the first calls)`);
  if (/airpods|bluetooth/i.test(micName)) warn("Bluetooth mic drops to low-quality audio", "use the Mac microphone or a wired headset");
  mic.on("pcm", (b: Buffer) => {
    chunks++;
    peak = Math.max(peak, peakOf(b));
  });
  mic.on("error", (e: Error) => bad(`mic: ${e.message}`));
  try {
    await mic.start();
    await sleep(5000);
  } catch (e) {
    const code = (e as { code?: string }).code;
    bad(
      `mic: ${(e as Error).message}`,
      code === "permission"
        ? "allow Wingman to use the microphone in the system privacy settings, then run the readiness check again"
        : "check the microphone and the choice in Settings",
    );
  }
  await mic.stop();
  const v = micVerdict(chunks, peak);
  if (v === "fail")
    bad(
      "no sound from the microphone: it looks blocked",
      IS_APP
        ? "System Settings → Privacy & Security → Microphone: allow Wingman, then restart Wingman (or choose another device in Settings)"
        : "grant Microphone to your terminal app (Privacy & Security), restart it, or set audio.mic.device",
    );
  else if (v === "ok") ok(`mic level ok (peak ${peak.toFixed(2)})`);
  else
    warn(
      `mic is quiet (peak ${peak.toFixed(3)}): the microphone works, but the voice was weak`,
      "speak normally during the check, or move closer to the microphone",
    );
}
if (!IS_APP && process.env.TERM_PROGRAM && process.env.TERM_PROGRAM !== "Apple_Terminal")
  warn(`Terminal is ${process.env.TERM_PROGRAM}, not Terminal.app: permissions are per app`);

section(`System audio source: ${S.audio.system.source}`);
if (S.audio.system.source === "off") warn("audio.system.source is off: the client cannot be heard (transcript-only)");
else {
  const sys: AudioSource = backendFor().createSystem(S.audio.system.source === "device" ? "device" : "audiotee", S.audio.system.device);
  let err = "",
    peak = 0;
  sys.on("error", (e: Error) => {
    err = e.message;
  });
  sys.on("pcm", (b: Buffer) => {
    peak = Math.max(peak, peakOf(b));
  });
  try {
    await sys.start();
    // Play a system sound and a Hebrew phrase so the system-audio tap has something to hear; the sleeps give the tap time to see it.
    if (process.platform === "darwin") {
      spawn("afplay", ["/System/Library/Sounds/Glass.aiff"]);
      await sleep(400);
      spawn("say", ["-v", "Carmit", "בדיקת שמע"]);
      await sleep(2600);
    } else {
      // No built-in sound player to call on Windows: the check listens for a few seconds, so play any sound (a video, music) while it runs.
      console.log("  play any sound on this computer now (3 seconds)");
      await sleep(3000);
    }
    await sys.stop();
    peak > 0.01
      ? ok(`client audio hears this computer (peak ${peak.toFixed(2)})`)
      : bad(
          "client audio is silent",
          S.audio.system.source === "audiotee"
            ? IS_APP
              ? "volume up, or System Settings → Privacy & Security → allow System Audio Recording for Wingman, then restart Wingman"
              : "volume up, or grant System Audio Recording to your terminal, restart it"
            : `route the Mac output to ${S.audio.system.device}`,
        );
  } catch (e) {
    bad(`system source failed: ${(e as Error).message || err}`);
  }
}

section("STT providers (primary and fallbacks, opened exactly like a call)");
for (const [i, id] of sttIds.entries()) {
  const key = keys[id as KeyName],
    p = getSttProvider(id);
  if (!key) {
    i === 0 ? bad(`${id}: no key`) : warn(`${id} (fallback): no key, skipped`);
    continue;
  }
  const base = { apiKey: key, language: S.stt.language, endpointingMs: S.stt.endpointMs, model: S.stt.model };
  let r = await p.probe({ ...base, keyterms: terms });
  let note = `${terms.length} keyterms`;
  if (!r.ok && terms.length && r.error.kind === "bad_request") {
    const r2 = await p.probe({ ...base, keyterms: [] });
    if (r2.ok) {
      r = r2;
      note = "opens only WITHOUT keyterms (set stt.keyterms.enabled: off)";
      warn(`${id}: keyterms rejected`);
    }
  }
  r.ok
    ? ok(`${id}${i ? " (fallback)" : ""}: live socket opens (${S.stt.language}, ${note})${p.experimental ? " [experimental]" : ""}`)
    : (i === 0 ? bad : warn)(`${id}${i ? " (fallback)" : ""}: ${describe(r.error)} [${r.error.kind}] ${r.error.message}`);
}

if (!S.run.noAi) {
  section("LLM reflex (primary and fallbacks; the primary is called twice to check the prompt cache)");
  // The primary model is called twice with the same prefix: the second call should read the prompt cache (checked via cache-read tokens).
  let prefix!: ReturnType<typeof buildPrefix>;
  let prefixOk = true;
  try {
    prefix = buildPrefix(readPack("house-style.md"), loadBank());
  } catch (e) {
    prefixOk = false;
    bad(
      `The reflex prompt could not be built: ${(e as Error).message}`,
      "fix the profile, answer bank or house style file named above, then run the check again",
    );
  }
  for (const [mi, ref] of prefixOk ? llmRefs.entries() : ([] as [number, (typeof llmRefs)[number]][])) {
    for (const i of mi === 0 && registry.capabilities(ref).cache ? [1, 2] : [1]) {
      const t0 = Date.now();
      let first = 0,
        tag = "";
      try {
        await runReflex({
          registry,
          models: [ref],
          cfg: { ...S.llm.reflex, timeoutMs: 15000 },
          prefix,
          transcript: "them: היי, יש לי שאלה",
          question: "איך DNS עובד",
          signal: AbortSignal.timeout(20000),
          h: {
            onTag: (t) => {
              first ||= Date.now() - t0;
              tag = t.kind;
            },
            onSay() {},
            onFacts() {},
            onSayComplete() {},
            onDone: ({ usage, providerMetadata }) => {
              const u = usage as { inputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number }; cachedInputTokens?: number } | undefined;
              const pm = (providerMetadata as { anthropic?: { cacheReadInputTokens?: number } } | undefined)?.anthropic ?? {};
              const read = u?.inputTokenDetails?.cacheReadTokens ?? u?.cachedInputTokens ?? pm.cacheReadInputTokens ?? 0;
              console.log(`  ${ref} call ${i}: first tag ${first} ms (${tag}) · input ${u?.inputTokens} · cache read ${read}`);
              if (!["SKIP", "STALL", "ANS", "BANK"].includes(tag)) bad(`${ref}: reply had no valid tag`);
              else if (first > 2000) warn(`${ref}: first tag ${first} ms (> 2 s)`);
              if (i === 2)
                read > 0
                  ? ok("prompt cache works")
                  : warn(
                      "cache read is 0 on call 2: the prefix may be under the model's cache minimum",
                      IS_APP ? "safe to ignore: calls just cost a little more" : "pad buildPrefix() in src/reflex.ts (safe to ignore)",
                    );
              if (i === 1) ok(`${ref} answers${mi ? " (fallback)" : ""}`);
            },
          },
        });
      } catch (e) {
        const pe = classifyLlmError(ref.split(":")[0], e);
        (mi === 0 ? bad : warn)(`${ref}: ${describe(pe)} [${pe.kind}] ${pe.message}`);
        break;
      }
    }
  }
}
finish();

/** Print the verdict and exit: 1 if anything blocking, else 0. Hoisted, so it can also be called from the early settings-failure path. */
function finish(): never {
  console.log("");
  if (blocking.length) {
    console.log(`NOT READY: ${blocking[0]}${blocking.length > 1 ? ` (+${blocking.length - 1} more blocking)` : ""}`);
    process.exit(1);
  }
  console.log(warnings ? `READY WITH WARNINGS (${warnings})` : "READY");
  process.exit(0);
}
