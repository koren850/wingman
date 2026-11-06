// Typed entry point for the Keychain module. The implementation is src/keychain.cjs (CommonJS) so Electron's main process
// and the tsx/ESM tools share one copy. This file only adds types; it re-exports the CJS functions unchanged.
import { createRequire } from "node:module";

/** Providers whose API key can live in the Keychain. */
export type Provider = "deepgram" | "anthropic";
/** Runs /usr/bin/security (or a test mock) synchronously. `input` goes to stdin, never to argv. */
export type Runner = (args: string[], input?: string) => { status: number; stdout: string; stderr: string };
export interface Keychain {
  get(p: Provider): string | null;
  set(p: Provider, v: string): true;
  remove(p: Provider): boolean;
}
/** Where a key was found. Lookup order: keychain, then env, then the legacy keys.env file. */
export type KeySource = "keychain" | "env" | "file" | "missing";
export interface KeyStatus {
  source: KeySource;
  last4: string;
  inFile: boolean;
  inKeychain: boolean;
}
export interface MigrateResult {
  moved: Provider[];
  alreadyInKeychain: Provider[];
  failed: { provider: Provider; reason: string }[];
  backup: string | null;
}

const m = createRequire(import.meta.url)("./keychain.cjs") as {
  SERVICE: string;
  ACCOUNTS: Record<Provider, string>;
  PROVIDERS: Provider[];
  KEY_ENV_VARS: string[];
  childEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  realRunner: Runner;
  createKeychain(run?: Runner): Keychain;
  checkKeyFormat(p: string, v: unknown): string | null;
  scrub(t: unknown, secrets?: string[]): string;
  last4(v: unknown): string;
  keyStatus(o: { keychain: Keychain; file: string; env?: NodeJS.ProcessEnv }): Record<Provider, KeyStatus>;
  resolveKey(o: { provider?: Provider | null; account: string; keychain?: Keychain | null; env?: NodeJS.ProcessEnv; fromFile?: Record<string, string> }): {
    value: string | null;
    source: KeySource;
  };
  migrateKeysToKeychain(o: { keychain: Keychain; file: string }): MigrateResult;
  testKey(p: string, key: string, f?: typeof fetch): Promise<"ok" | "invalid" | "network">;
};
export const {
  SERVICE,
  ACCOUNTS,
  PROVIDERS,
  KEY_ENV_VARS,
  childEnv,
  realRunner,
  createKeychain,
  checkKeyFormat,
  scrub,
  last4,
  keyStatus,
  resolveKey,
  migrateKeysToKeychain,
  testKey,
} = m;
/** The real macOS Keychain. Only the CLI, the app and the call tools use this; tests inject a mock runner instead. */
export const realKeychain = (): Keychain => createKeychain(realRunner);
