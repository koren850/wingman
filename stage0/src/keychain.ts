// Typed entry point for the Keychain module (the implementation is src/keychain.cjs so Electron's main process can share it).
import { createRequire } from "node:module";

export type Provider = "deepgram" | "anthropic";
export type Runner = (args: string[], input?: string) => { status: number; stdout: string; stderr: string };
export interface Keychain { get(p: Provider): string | null; set(p: Provider, v: string): true; remove(p: Provider): boolean }
export type KeySource = "keychain" | "env" | "file" | "missing";
export interface KeyStatus { source: KeySource; last4: string; inFile: boolean; inKeychain: boolean }
export interface MigrateResult { moved: Provider[]; alreadyInKeychain: Provider[]; failed: { provider: Provider; reason: string }[]; backup: string | null }

const m = createRequire(import.meta.url)("./keychain.cjs") as {
  SERVICE: string; ACCOUNTS: Record<Provider, string>; PROVIDERS: Provider[]; KEY_ENV_VARS: string[];
  childEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv; realRunner: Runner; createKeychain(run?: Runner): Keychain;
  checkKeyFormat(p: string, v: unknown): string | null; scrub(t: unknown, secrets?: string[]): string; last4(v: unknown): string;
  keyStatus(o: { keychain: Keychain; file: string; env?: NodeJS.ProcessEnv }): Record<Provider, KeyStatus>;
  migrateKeysToKeychain(o: { keychain: Keychain; file: string }): MigrateResult;
  testKey(p: string, key: string, f?: typeof fetch): Promise<"ok" | "invalid" | "network">;
};
export const { SERVICE, ACCOUNTS, PROVIDERS, KEY_ENV_VARS, childEnv, realRunner, createKeychain, checkKeyFormat, scrub, last4, keyStatus, migrateKeysToKeychain, testKey } = m;
/** The real macOS Keychain. Only the CLI, the app and the call tools use this; tests inject a mock runner instead. */
export const realKeychain = (): Keychain => createKeychain(realRunner);
