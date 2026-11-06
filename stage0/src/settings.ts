// Settings layers (lowest to highest): config/defaults.yaml < ~/.config/wingman/settings.yaml
// < profiles/<name>.yaml (--profile) < WINGMAN_* env vars < CLI flags. Validated with zod; every value remembers its layer
// (`sources`), so an error can name the file/flag that set the bad value. Layers are merged as flat dotted keys ("llm.reflex.model").
// Every key must exist in config/defaults.yaml; the schema is strict, so a typo in a user file fails loudly instead of being ignored.
// Used by run.ts, doctor.ts, the tray and the CLI tools.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";

const HERE = dirname(fileURLToPath(import.meta.url));
export const STAGE0 = join(HERE, "..");
export const DEFAULTS_FILE = join(STAGE0, "config", "defaults.yaml");
export const PROFILES_DIR = join(STAGE0, "profiles");
export const USER_SETTINGS_FILE = join(homedir(), ".config", "wingman", "settings.yaml");
export const expandHome = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const modelRef = z.string().regex(/^[a-z0-9_-]+:.+$/i, "expected provider:model, e.g. anthropic:claude-haiku-5-5");
const sttName = z.enum(["deepgram", "soniox", "gladia", "script"]); // script = offline test double (src/providers/scripted.ts)
const price = z.strictObject({
  inUsdPerM: z.number().min(0),
  outUsdPerM: z.number().min(0),
  cacheReadUsdPerM: z.number().min(0).optional(),
  cacheWriteUsdPerM: z.number().min(0).optional(),
});

/** The full settings shape. strictObject everywhere: unknown keys are errors. Ranges are sanity bounds, not recommendations (see defaults.yaml). */
export const schema = z.strictObject({
  v: z.literal(1),
  stt: z.strictObject({
    provider: sttName,
    fallback: z.array(sttName),
    model: z.string().min(1),
    speakers: z.boolean(),
    language: z.enum(["he", "en", "multi", "auto"]),
    endpointMs: int(100, 2000),
    utteranceEndMs: int(500, 3000),
    keepAliveMs: int(2000, 8000),
    flushFallbackMs: int(300, 5000),
    joinWindowMs: int(0, 5000),
    keyterms: z.strictObject({ enabled: z.enum(["auto", "on", "off"]), file: z.string(), max: int(0, 100) }),
    circuit: z.strictObject({ failures: int(1, 10), windowMs: int(1000, 120000) }),
    reconnect: z.strictObject({ ringMs: int(0, 10000) }),
    dropForeignScript: z.boolean(),
    deepgram: z.strictObject({ mipOptOut: z.boolean() }),
  }),
  llm: z.strictObject({
    reflex: z.strictObject({
      model: modelRef,
      fallbacks: z.array(modelRef),
      timeoutMs: int(500, 30000),
      maxTokens: int(50, 600),
      maxRetries: int(0, 2),
      effort: z.enum(["low", "medium", "high"]),
      thinking: z.boolean(),
      cache: z.enum(["off", "5m", "1h"]),
      slowMs: int(200, 10000),
    }),
    circuit: z.strictObject({ failures: int(1, 10), cooldownMs: int(1000, 600000) }),
  }),
  reflex: z
    .strictObject({ stallAfterMs: int(800, 5000), dropStaleMs: int(1500, 10000), allowAns: z.boolean(), stall: z.boolean().default(false) })
    .refine((r) => r.stallAfterMs < r.dropStaleMs, {
      path: ["stallAfterMs"],
      message: "must be smaller than reflex.dropStaleMs, otherwise the stall line is always judged too late to show",
    }),
  assist: z.strictObject({
    answerMe: z.enum(["always", "hotkey", "off"]),
    askWindowMs: int(3000, 30000),
    model: modelRef,
    classifyTimeoutMs: int(500, 10000),
    themQuietMs: int(1000, 30000),
    minGapMs: int(0, 60000),
    maxPerMin: int(1, 20),
    protectThemMs: int(0, 60000),
  }),
  cards: z.strictObject({
    focus: z.boolean(),
    maxPerMinute: int(1, 20),
    windowMs: int(5000, 600000),
    lockoutMs: int(0, 5000),
    maxOnScreen: int(1, 8),
    quiet: z.boolean(),
  }),
  audio: z.strictObject({
    system: z.strictObject({ source: z.enum(["audiotee", "device", "off"]), device: z.string().min(1) }),
    mic: z.strictObject({ device: z.string().min(1) }),
    watchdog: z.strictObject({
      silentThemMs: int(3000, 60000),
      silentPeak: z.number().min(0).max(1),
      micSilentMs: int(3000, 60000),
      micPeak: z.number().min(0).max(1),
    }),
    warnBluetooth: z.boolean(),
    echo: z.strictObject({
      mode: z.enum(["auto", "gate", "filter", "both", "off"]),
      gatePeak: z.number().min(0).max(1),
      gateHangoverMs: int(0, 3000),
      filterWindowMs: int(500, 10000),
      filterThreshold: z.number().min(0.3).max(1),
      filterDelayMs: int(0, 3000),
    }),
  }),
  capture: z.strictObject({ enabled: z.boolean() }),
  facts: z.strictObject({ enabled: z.boolean(), file: z.string().min(1), sslWarnDays: int(0, 365), minAliasLen: int(2, 10), proposeClient: z.boolean() }),
  notes: z.strictObject({ enabled: z.boolean(), model: modelRef, everyMs: int(10000, 600000), minNewWords: int(5, 500), timeoutMs: int(2000, 30000) }),
  summary: z.strictObject({ enabled: z.boolean(), model: modelRef, minWords: int(0, 100000), timeoutMs: int(2000, 120000) }),
  reminders: z.strictObject({ enabled: z.boolean(), firstAfterMin: int(1, 120), everyMin: int(1, 120) }),
  frame: z.strictObject({
    enabled: z.boolean(),
    model: modelRef,
    everyMs: int(10000, 600000),
    minNewWords: int(5, 500),
    windowMin: int(1, 10),
    timeoutMs: int(2000, 30000),
  }),
  flow: z.strictObject({
    enabled: z.boolean(),
    holdCards: z.boolean(),
    topic: z.boolean(),
    model: modelRef,
    topicEveryMs: int(15000, 600000),
    timeoutMs: int(2000, 30000),
  }),
  selfCheck: z.strictObject({ enabled: z.boolean(), careful: z.boolean(), fix: z.boolean(), minGapMs: int(1000, 120000), timeoutMs: int(2000, 30000) }),
  tips: z.strictObject({
    enabled: z.boolean(),
    model: modelRef,
    minGapMs: int(10000, 1800000),
    afterAnswerMs: int(0, 120000),
    talkRatio: z.boolean(),
    wrapUpAfterMin: int(5, 240),
    timeoutMs: int(2000, 30000),
  }),
  attachments: z.strictObject({ maxChars: int(0, 40000) }),
  health: z.strictObject({ tickMs: int(200, 10000), recoverStableMs: int(1000, 600000), slowSttMs: int(200, 10000), minSamples: int(1, 20) }),
  budget: z.strictObject({
    maxUsdPerCall: z.number().min(0),
    warnAt: z.number().min(0).max(1),
    maxMinutesPerCall: int(1, 600),
    idleStopMin: int(0, 240),
    maxUsdPerMonth: z.number().min(0).nullable(),
    prices: z.strictObject({ llm: z.record(z.string(), price), stt: z.record(z.string(), z.number().min(0)) }),
  }),
  privacy: z.strictObject({
    requireConsentAck: z.boolean(),
    askBeforeCliStart: z.boolean(),
    consentText: z.string().min(10),
    storeAudio: z.literal(false),
    retentionDays: int(1, 365),
  }),
  ui: z.strictObject({ language: z.enum(["auto", "he", "en"]) }),
  overlay: z.strictObject({
    enabled: z.boolean(),
    display: z.enum(["secondary", "primary"]),
    allowPrimary: z.boolean(),
    contentProtection: z.boolean(),
    fontPt: int(18, 60),
    showLastLine: z.boolean(),
    liveTextPt: int(14, 40),
    hotkeys: z.strictObject({
      clear: z.string().min(1),
      pause: z.string().min(1),
      rewind: z.string().min(1),
      copy: z.string().min(1),
      checklist: z.string().min(1),
    }),
    rewindSeconds: int(5, 300),
    restartMax: int(0, 5),
  }),
  system: z.strictObject({ caffeinate: z.boolean(), sleepGapMs: int(0, 600000) }),
  keys: z.strictObject({ file: z.string().min(1) }),
  run: z.strictObject({ file: z.string().nullable(), noAi: z.boolean(), discard: z.boolean() }),
});
export type Settings = z.infer<typeof schema>;

/** Language of the answer window labels: ui.language, with "auto" = Hebrew unless the call language (stt.language, which a profile can set) is English only. */
export function resolveUiLanguage(s: Pick<Settings, "ui" | "stt">): "he" | "en" {
  if (s.ui.language !== "auto") return s.ui.language;
  return s.stt.language === "en" ? "en" : "he";
}

export type LayerName = "default" | "user" | "profile" | "env" | "cli";
export type Source = { layer: LayerName; file?: string; detail?: string };
export type Flat = Record<string, unknown>;
type Layer = { name: LayerName; file?: string; flat: Flat; details?: Record<string, string> };

export type SettingsIssue = { file: string; key: string; layer: LayerName; message: string; allowed?: string };
/** Thrown for any invalid settings; `issues` carries file, key and layer so the message points at the culprit. */
export class SettingsError extends Error {
  constructor(public issues: SettingsIssue[]) {
    super(issues.map((i) => `${i.file}: ${i.key}: ${i.message}`).join("\n"));
    this.name = "SettingsError";
  }
}
/** Human-readable multi-line text for a SettingsError (shown in the terminal and the app). */
export function formatSettingsError(e: SettingsError): string {
  return [
    "Wingman settings are invalid:",
    ...e.issues.map((i) => `  file:    ${i.file}\n  key:     ${i.key}\n  problem: ${i.message}${i.allowed ? `\n  allowed: ${i.allowed}` : ""}\n`),
  ].join("\n");
}

// Records that are keyed by model/provider ids (which may contain dots): kept as one leaf, merged key by key.
const RECORD_LEAVES = new Set(["budget.prices.llm", "budget.prices.stt"]);

/** Nested object -> flat dotted keys. Arrays and the RECORD_LEAVES stay as single values. */
export function flatten(obj: unknown, prefix = "", out: Flat = {}): Flat {
  if (obj && typeof obj === "object" && !Array.isArray(obj) && !RECORD_LEAVES.has(prefix)) {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out[prefix] = obj;
  return out;
}
/** Inverse of flatten(): dotted keys -> nested object. */
export function unflatten(flat: Flat): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, v] of Object.entries(flat)) {
    const parts = path.split(".");
    let o = root;
    for (const p of parts.slice(0, -1)) {
      if (typeof o[p] !== "object" || o[p] === null || Array.isArray(o[p])) o[p] = {};
      o = o[p] as Record<string, unknown>;
    }
    o[parts.at(-1)!] = v;
  }
  return root;
}

/** Reads a settings YAML into flat keys. An empty file is fine; invalid YAML or a non-mapping top level throws SettingsError. */
function readYaml(file: string, label: string, defaults?: Flat): Flat {
  let doc: unknown;
  try {
    doc = YAML.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new SettingsError([{ file, key: "(file)", layer: "user", message: `${label} is not valid YAML: ${(e as Error).message.split("\n")[0]}` }]);
  }
  if (doc == null) return {};
  if (typeof doc !== "object" || Array.isArray(doc))
    throw new SettingsError([{ file, key: "(file)", layer: "user", message: "top level must be a mapping of keys" }]);
  const flat = flatten(doc);
  // A section header with every child commented out ("stt:") parses to null: it means "no overrides", not "set stt to null".
  if (defaults)
    for (const k of Object.keys(flat)) if (flat[k] === null && !(k in defaults) && Object.keys(defaults).some((d) => d.startsWith(`${k}.`))) delete flat[k];
  return flat;
}

/** Parse a string from env or the CLI the way YAML would; comma lists become arrays where the default is an array. */
export function parseScalar(raw: string, def: unknown): unknown {
  let v: unknown;
  try {
    v = YAML.parse(raw);
  } catch {
    v = raw;
  }
  if (Array.isArray(def)) {
    if (Array.isArray(v)) return v;
    return String(raw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof def === "string" && typeof v !== "string") return raw; // "1" for a string key stays "1"
  return v === undefined ? null : v;
}

// WINGMAN_* environment overrides (layer "env"). Only these variables are read; `map` converts the string where YAML parsing is not right.
const ENV_MAP: { env: string; key: string; map?: (v: string) => unknown }[] = [
  { env: "WINGMAN_ENDPOINT_MS", key: "stt.endpointMs" },
  { env: "WINGMAN_MIC", key: "audio.mic.device", map: (v) => v },
  { env: "WINGMAN_ECHO", key: "audio.echo.mode" },
  { env: "WINGMAN_ALLOW_PRIMARY", key: "overlay.allowPrimary", map: (v) => v === "1" || v === "true" },
  { env: "WINGMAN_SHOW_IN_CAPTURE", key: "overlay.contentProtection", map: (v) => !(v === "1" || v === "true") },
  { env: "WINGMAN_STT_PROVIDER", key: "stt.provider" },
  { env: "WINGMAN_STT_FALLBACK", key: "stt.fallback" },
  { env: "WINGMAN_LLM_MODEL", key: "llm.reflex.model" },
  { env: "WINGMAN_LLM_FALLBACKS", key: "llm.reflex.fallbacks" },
];

/** Parsed command line: the chosen profile, flat overrides and, per key, the flag that set it (for error messages). */
export type Cli = { profile?: string; flat: Flat; details: Record<string, string> };
/** Flags: --file X, --no-ai, --discard, --quiet, --profile N, --stt P, --stt-fallback a,b, --model M, --endpoint-ms N, --set key=value (repeatable). Each also takes the --flag=value form. Other flags are ignored. */
export function parseCli(rawArgv: string[], defaults: Flat): Cli {
  // "--profile=x" is the same as "--profile x" (split on the first "="; "--set a=b" stays two arguments).
  const argv = rawArgv.flatMap((a) => {
    const eq = a.indexOf("=");
    return a.startsWith("--") && eq > 2 ? [a.slice(0, eq), a.slice(eq + 1)] : [a];
  });
  const flat: Flat = {},
    details: Record<string, string> = {};
  let profile: string | undefined;
  const set = (key: string, v: unknown, flag: string) => {
    flat[key] = v;
    details[key] = flag;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i],
      next = () => argv[++i];
    if (a === "--profile") profile = next();
    else if (a === "--file") set("run.file", next(), a);
    else if (a === "--no-ai") set("run.noAi", true, a);
    else if (a === "--discard") set("run.discard", true, a);
    else if (a === "--quiet") set("cards.quiet", true, a);
    else if (a === "--stt") set("stt.provider", next(), a);
    else if (a === "--stt-fallback") set("stt.fallback", parseScalar(next() ?? "", []), a);
    else if (a === "--model") set("llm.reflex.model", next(), a);
    else if (a === "--endpoint-ms") set("stt.endpointMs", parseScalar(next() ?? "", 0), a);
    else if (a === "--set") {
      const kv = next() ?? "";
      const eq = kv.indexOf("=");
      if (eq < 1) throw new SettingsError([{ file: "CLI", key: "--set", layer: "cli", message: `expected key=value, got "${kv}"` }]);
      const k = kv.slice(0, eq);
      set(k, parseScalar(kv.slice(eq + 1), defaults[k]), `--set ${k}`);
    }
  }
  return { profile, flat, details };
}

export type LoadOptions = { argv?: string[]; env?: NodeJS.ProcessEnv; userFile?: string; defaultsFile?: string; profilesDir?: string; createStarter?: boolean };
export type Loaded = { settings: Settings; sources: Record<string, Source>; profile?: string; userFile: string };

/**
 * Merge all layers (default < user < profile < env < cli), validate, and return settings plus where each key came from.
 * Throws SettingsError. `createStarter` writes a commented-out starter file to the user path on first run (mode 600, best effort).
 * Takes argv/env/file paths as options so tests can run without touching the real home directory.
 */
export function loadSettings(o: LoadOptions = {}): Loaded {
  const env = o.env ?? process.env,
    userFile = o.userFile ?? (env.WINGMAN_USER_SETTINGS || USER_SETTINGS_FILE);
  const defaults = readYaml(o.defaultsFile ?? DEFAULTS_FILE, "defaults");
  if (o.createStarter && !existsSync(userFile)) {
    try {
      mkdirSync(dirname(userFile), { recursive: true, mode: 0o700 });
      writeFileSync(userFile, STARTER, { mode: 0o600 });
    } catch {
      /* read-only home: ignore */
    }
  }
  const layers: Layer[] = [{ name: "default", file: o.defaultsFile ?? DEFAULTS_FILE, flat: defaults }];
  if (existsSync(userFile)) layers.push({ name: "user", file: userFile, flat: readYaml(userFile, "settings file", defaults) });
  const cli = parseCli(o.argv ?? [], defaults);
  const profile = cli.profile ?? env.WINGMAN_PROFILE;
  if (profile) {
    // the name is checked before it becomes a path: no "../" out of profiles/
    const pf = join(o.profilesDir ?? PROFILES_DIR, `${profile}.yaml`);
    if (!/^[\w-]+$/.test(profile) || !existsSync(pf))
      throw new SettingsError([
        { file: pf, key: "--profile", layer: "profile", message: `profile "${profile}" not found`, allowed: "a file profiles/<name>.yaml" },
      ]);
    layers.push({ name: "profile", file: pf, flat: readYaml(pf, "profile", defaults) });
  }
  const envFlat: Flat = {},
    envDetails: Record<string, string> = {};
  for (const m of ENV_MAP) {
    const raw = env[m.env];
    if (raw === undefined || raw === "") continue;
    envFlat[m.key] = m.map ? m.map(raw) : parseScalar(raw, defaults[m.key]);
    envDetails[m.key] = m.env;
  }
  if (Object.keys(envFlat).length) layers.push({ name: "env", file: "environment", flat: envFlat, details: envDetails });
  if (Object.keys(cli.flat).length) layers.push({ name: "cli", file: "command line", flat: cli.flat, details: cli.details });

  const flat: Flat = {},
    sources: Record<string, Source> = {};
  for (const l of layers) {
    for (const [k, v] of Object.entries(l.flat)) {
      // price tables merge key by key, so a user file can add one model's price without replacing the whole table
      flat[k] = RECORD_LEAVES.has(k) && flat[k] && typeof v === "object" ? { ...(flat[k] as object), ...(v as object) } : v;
      sources[k] = { layer: l.name, file: l.file, detail: l.details?.[k] };
    }
  }
  const res = schema.safeParse(unflatten(flat));
  if (!res.success) throw new SettingsError(res.error.issues.flatMap((iss) => issuesFor(iss, sources)));
  return { settings: res.data, sources, profile, userFile };
}

/** Turn one zod issue into a SettingsIssue that names the layer/file that set the key (walks up to the nearest parent key that has a source). */
function issuesFor(iss: z.core.$ZodIssue, sources: Record<string, Source>): SettingsIssue[] {
  const base = iss.path.map(String).join(".");
  const find = (k: string): Source => {
    for (let key = k; key; key = key.includes(".") ? key.slice(0, key.lastIndexOf(".")) : "") if (sources[key]) return sources[key];
    const sub = Object.keys(sources).find((s) => s.startsWith(k + ".")); // object-level problem: blame the first key inside it
    return sources[sub ?? ""] ?? { layer: "default", file: DEFAULTS_FILE };
  };
  const mk = (key: string, message: string, allowed?: string): SettingsIssue => {
    const s = find(key);
    return { file: s.detail ? `${s.file} (${s.detail})` : (s.file ?? "?"), key, layer: s.layer, message, allowed };
  };
  if (iss.code === "unrecognized_keys")
    return iss.keys.map((k: string) => mk(base ? `${base}.${k}` : k, "unknown key (typo?)", "see config/defaults.yaml for every valid key"));
  if (iss.code === "invalid_value") return [mk(base, "value not allowed", iss.values.map(String).join(" | "))];
  if (iss.code === "invalid_type" && /received undefined/.test(iss.message))
    return [mk(base, "missing (config/defaults.yaml is out of sync with the schema)", String(iss.expected))];
  if (iss.code === "invalid_type") return [mk(base, iss.message, String(iss.expected))];
  return [mk(base, iss.message, iss.message.replace(/^(Too small|Too big): /, ""))];
}

/** CLI entry helper: print a clear error and exit 2 on invalid settings. */
export function loadSettingsOrExit(argv: string[] = process.argv.slice(2), o: LoadOptions = {}): Loaded {
  try {
    return loadSettings({ argv, createStarter: true, ...o });
  } catch (e) {
    if (e instanceof SettingsError) {
      console.error(formatSettingsError(e));
      process.exit(2);
    }
    throw e;
  }
}

/** Masks anything that looks like a secret before printing. */
export function redact(key: string, v: unknown): string {
  if (/(apikey|secret|token|password)$/i.test(key)) return "***";
  return JSON.stringify(v).replace(/\b(sk-[A-Za-z0-9_-]{16,}|[A-Fa-f0-9]{32,})\b/g, "***");
}

/** Template for the user's settings file: everything commented out, so nothing changes until a line is uncommented. */
export const STARTER = `# Wingman personal settings (layer 2). Everything here is commented out, so nothing changes until you uncomment a line.
# Every key and its default is documented in stage0/config/defaults.yaml. Check the result with: pnpm settings
# API keys do NOT go here: they live in ~/.config/wingman/keys.env.

# stt:
#   provider: deepgram          # deepgram | soniox | gladia (experimental)
#   fallback: []                # e.g. [soniox]
#   endpointMs: 200             # 700-1000 if questions get split at pauses
# llm:
#   reflex:
#     model: "anthropic:claude-haiku-5-5"    # or "openai:gpt-5-mini" after: pnpm add @ai-sdk/openai
#     fallbacks: []
# reflex:
#   allowAns: true              # false = bank + stall only (good for a first client call)
# assist:
#   answerMe: always            # always | hotkey | off: answers to questions you ask Wingman (Ctrl+Opt+A always works)
# audio:
#   mic:
#     device: ":default"        # ffmpeg -f avfoundation -list_devices true -i ""
#   system:
#     source: audiotee          # audiotee | device | off
# budget:
#   maxUsdPerCall: 2
# overlay:
#   fontPt: 30
`;
