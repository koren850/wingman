export interface MigrationResult {
  status: "none" | "done-before" | "skipped" | "migrated" | "failed" | "redirected";
  files: number;
  bytes: number;
  copied: number;
  message?: string;
}
declare const m: {
  MARKER: string;
  PENDING: string;
  hasUserData(root: string, names?: string[]): boolean;
  migrateUserData(o: { dataDir: string; oldCalls: string; oldPrivate: string; log?: (m: string) => void }): MigrationResult;
  ensureUserData(o?: { env?: NodeJS.ProcessEnv; home?: string; appDir?: string; force?: boolean; log?: (m: string) => void }): MigrationResult;
};
export = m;
