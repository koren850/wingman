// The golden meeting file format (data/meetings/{dev,test,test-b}/<id>.json). Plan contract 3.4. Invented data only.
// `t` of a line is in MILLISECONDS from the start of the meeting. The schema (zod) lives in qa/golden-schema.ts; this is the plain type.
export type { Golden } from "../../qa/golden-schema.ts";
export type GoldenRole = "moment" | "memory" | "ask" | "digest";
export type GoldenScriptEntry = { role: GoldenRole; whenLastLine: string; reply: string; ms?: number };
