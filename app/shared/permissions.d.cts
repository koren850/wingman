declare const m: {
  denyPermissions(ses: any, allow?: string[]): void;
  grantSession(ses: any, permissions: string[]): void;
  install(app: any, allow?: string[]): void;
};
export = m;
