declare const m: {
  APP_DIR: string;
  dataDir(env?: NodeJS.ProcessEnv, home?: string, platform?: string): string;
  defaultDataDir(env?: NodeJS.ProcessEnv, home?: string, platform?: string): string;
  callsDir(env?: NodeJS.ProcessEnv, home?: string, platform?: string): string;
  briefsDir(env?: NodeJS.ProcessEnv, home?: string, platform?: string): string;
  attachDir(env?: NodeJS.ProcessEnv, home?: string): string;
  entitiesFile(env?: NodeJS.ProcessEnv, home?: string): string;
  legacyDirs(appDir?: string): { calls: string; private: string };
  legacyCandidates(appDir?: string): { calls: string; private: string }[];
  resolveUserPath(p: string, env?: NodeJS.ProcessEnv, home?: string, appDir?: string): string;
  isRedirected(env?: NodeJS.ProcessEnv): boolean;
};
export = m;
