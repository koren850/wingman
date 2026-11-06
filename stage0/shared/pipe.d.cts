declare const m: {
  usesPipes(platform?: string): boolean;
  pipeName(name: string, user?: string, platform?: string): string;
  endpoint(name: string, filePath: string, platform?: string, user?: string): string;
};
export = m;
