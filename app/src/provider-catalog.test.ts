// The provider catalog is the single source of ids and key names. These tests tie the registries, the settings schema and env.ts to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STT_CATALOG, STT_IDS, LLM_CATALOG } from "./providers/catalog.ts";
import { STT_PROVIDERS } from "./providers/stt/index.ts";
import { LLM_PROVIDERS } from "./providers/llm.ts";
import { KEY_VARS } from "./env.ts";
import { schema } from "./settings.ts";

test("catalog: every STT id has an adapter whose id matches", () => {
  assert.deepEqual(Object.keys(STT_PROVIDERS).sort(), Object.keys(STT_CATALOG).sort());
  for (const [id, p] of Object.entries(STT_PROVIDERS)) assert.equal(p.id, id);
});

test("catalog: LLM registry covers the catalog, and keyed providers point at their own key", () => {
  assert.deepEqual(Object.keys(LLM_PROVIDERS), Object.keys(LLM_CATALOG));
  for (const [id, spec] of Object.entries(LLM_PROVIDERS)) assert.equal(spec.key, "keyVar" in LLM_CATALOG[id as keyof typeof LLM_CATALOG] ? id : undefined);
});

test("catalog: KEY_VARS is exactly the keyed providers, in the same order as before", () => {
  assert.deepEqual(KEY_VARS, {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GOOGLE_GENERATIVE_AI_API_KEY",
    mistral: "MISTRAL_API_KEY",
    groq: "GROQ_API_KEY",
    deepgram: "DEEPGRAM_API_KEY",
    soniox: "SONIOX_API_KEY",
    gladia: "GLADIA_API_KEY",
  });
  assert.deepEqual(Object.keys(KEY_VARS), ["anthropic", "openai", "google", "mistral", "groq", "deepgram", "soniox", "gladia"]);
});

test("catalog: the settings schema accepts exactly the STT ids", () => {
  const sttProvider = (schema.shape.stt.shape.provider as unknown as { options: string[] }).options;
  assert.deepEqual([...sttProvider], [...STT_IDS]);
});
