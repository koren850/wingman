// The one place that names every provider and its key. Plain data with no imports, so settings.ts, env.ts and the
// registries can all read it without an import cycle. Add a provider: one line here + its adapter (STT_PROVIDERS in
// stt/index.ts, or the package in LLM_PROVIDERS). The compiler checks that the registries cover every id listed here.

/** STT providers. keyVar = env var that holds the key (none for the offline "script" double). */
export const STT_CATALOG = {
  deepgram: { keyVar: "DEEPGRAM_API_KEY" },
  soniox: { keyVar: "SONIOX_API_KEY" },
  gladia: { keyVar: "GLADIA_API_KEY" },
  script: {}, // offline test double (src/providers/scripted.ts)
} as const satisfies Record<string, { keyVar?: string }>;
export type SttId = keyof typeof STT_CATALOG;
export const STT_IDS = Object.keys(STT_CATALOG) as [SttId, ...SttId[]];

/** LLM providers: npm package, factory export name, key env var (none for the offline double). */
export const LLM_CATALOG = {
  anthropic: { pkg: "@ai-sdk/anthropic", factory: "createAnthropic", keyVar: "ANTHROPIC_API_KEY" },
  openai: { pkg: "@ai-sdk/openai", factory: "createOpenAI", keyVar: "OPENAI_API_KEY" },
  google: { pkg: "@ai-sdk/google", factory: "createGoogleGenerativeAI", keyVar: "GOOGLE_GENERATIVE_AI_API_KEY" },
  mistral: { pkg: "@ai-sdk/mistral", factory: "createMistral", keyVar: "MISTRAL_API_KEY" },
  groq: { pkg: "@ai-sdk/groq", factory: "createGroq", keyVar: "GROQ_API_KEY" },
  scripted: { pkg: "./scripted.ts", factory: "createScripted" }, // offline test double, no key
} as const satisfies Record<string, { pkg: string; factory: string; keyVar?: string }>;
export type LlmId = keyof typeof LLM_CATALOG;

type KeyEntries<T> = { [K in keyof T as T[K] extends { keyVar: string } ? K : never]: T[K] extends { keyVar: infer V } ? V : never };
type Merge<A, B> = { [K in keyof A | keyof B]: K extends keyof A ? A[K] : K extends keyof B ? B[K] : never };

function keyVars<T extends Record<string, object>>(cat: T): KeyEntries<T> {
  const out: Record<string, string> = {};
  for (const [id, e] of Object.entries(cat)) if ("keyVar" in e && typeof e.keyVar === "string") out[id] = e.keyVar;
  return out as KeyEntries<T>;
}

/** provider id -> env var holding its key (STT and LLM providers together; the ids do not overlap). */
export const KEY_VARS_ALL = { ...keyVars(LLM_CATALOG), ...keyVars(STT_CATALOG) } as Merge<KeyEntries<typeof LLM_CATALOG>, KeyEntries<typeof STT_CATALOG>>;
