export type SourceSpec =
  | { type: "file"; path?: string; name?: string; bytes?: Uint8Array }
  | { type: "eml"; path?: string; name?: string; bytes?: Uint8Array }
  | { type: "url"; url: string }
  | { type: "calendar"; url: string };
export type SourceKind = "docx" | "eml" | "url" | "calendar" | "text";
export type SourceResult = {
  text: string;
  kind: SourceKind;
  label: string;
  truncated?: boolean;
  /** calendar only: plan fields of the picked event, and its start (epoch ms) */
  fields?: { title: string; at: number; who: string };
  when?: number;
};
export type ReadOptions = {
  fetch?: typeof fetch;
  lookup?: (host: string, o: { all: true }) => Promise<{ address: string; family: number }[]>;
  exec?: (...a: unknown[]) => unknown;
  now?: number;
  timeoutMs?: number;
  maxBytes?: number;
};
declare const m: {
  readSource(spec: SourceSpec, o?: ReadOptions): Promise<SourceResult>;
  readUrl(url: string, o?: ReadOptions): Promise<{ text: string; label: string; truncated: boolean }>;
  readCalendarUrl(
    url: string,
    o?: ReadOptions,
  ): Promise<{ text: string; label: string; fields: { title: string; at: number; who: string }; events: number; when: number }>;
  fetchSafe(url: string, o?: ReadOptions & { accept?: string }): Promise<{ body: string; type: string; truncated: boolean; url: string }>;
  docxText(bytes: Uint8Array, o?: ReadOptions): Promise<string>;
  docxXmlToText(xml: string): string;
  emlText(bytes: Uint8Array): { text: string; subject: string };
  htmlToText(html: string): string;
  isPrivateAddress(ip: string): boolean;
  checkUrl(url: string): URL;
  nearestEvent<T extends { startMs: number; endMs: number; cancelled: boolean }>(events: T[], now: number): T | null;
  untag(s: string): string;
  cleanText(s: string): string;
  safeText(s: string): string;
  WEB_TIMEOUT_MS: number;
  WEB_MAX_BYTES: number;
};
export = m;
