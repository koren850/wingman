declare const m: {
  binCommand(
    name: string,
    args: string[] | undefined,
    root: string,
    o?: { platform?: string; path?: any; fs?: any; execPath?: string; env?: NodeJS.ProcessEnv; packaged?: boolean },
  ): { cmd: string; args: string[] };
  isPackaged(root: string, fs?: any): boolean;
  PACKED_TOOLS: string[];
  tsxCli(root: string, path?: any): string;
  electronExe(root: string, o?: { path?: any; fs?: any; env?: NodeJS.ProcessEnv }): string;
};
export = m;
