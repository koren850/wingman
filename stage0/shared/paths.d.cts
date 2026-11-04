declare const m: {
  STAGE0: string;
  dataDir(env?: NodeJS.ProcessEnv, home?: string): string;
  callsDir(env?: NodeJS.ProcessEnv, home?: string): string;
  briefsDir(env?: NodeJS.ProcessEnv, home?: string): string;
  attachDir(env?: NodeJS.ProcessEnv, home?: string): string;
  entitiesFile(env?: NodeJS.ProcessEnv, home?: string): string;
  legacyDirs(stage0?: string): { calls: string; private: string };
  resolveUserPath(p: string, env?: NodeJS.ProcessEnv, home?: string, stage0?: string): string;
  isRedirected(env?: NodeJS.ProcessEnv): boolean;
};
export = m;
