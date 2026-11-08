// The golden meeting file format (data/meetings/{dev,test}/<id>.json). Plan contract 3.4. Invented data only.
// `t` is the time of the line in SECONDS from the start of the meeting.
export type GoldenRole = "moment" | "memory" | "ask" | "digest";
export type GoldenScriptEntry = { role: GoldenRole; whenLastLine: string; reply: string; ms?: number };
export type Golden = {
  id: string;
  split: "dev" | "test";
  lang: "en" | "he" | "mixed";
  type: "sales" | "pricing" | "support" | "vendor" | "standup" | "one2one" | "kickoff" | "interview";
  variant: "clean" | "noisy";
  context?: string;
  profile?: { userName: string; aliases?: string[] };
  lines: { id: string; t: number; side: "me" | "them"; speaker?: string; text: string }[];
  moments: { id: string; afterLine: string; kind: "answer" | "prompt" | "check" | "fact"; mustMention?: string[]; latestMs: number }[];
  silent: { fromLine: string; toLine: string }[];
  memoryChecks?: { atLine: string; mustContain: string[] }[];
  script?: GoldenScriptEntry[];
};
