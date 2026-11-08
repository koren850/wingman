declare const m: {
  T_JSON: number;
  T_PCM_MIC: number;
  T_PCM_SYSTEM: number;
  MAX_FRAME: number;
  CHANNELS: readonly ["mic", "system"];
  encodeJson(obj: unknown): Buffer;
  encodePcm(ch: "mic" | "system", pcm: Buffer): Buffer;
  createDecoder(): { push(chunk: Buffer): ({ json: any } | { ch: "mic" | "system"; pcm: Buffer })[] };
};
export = m;
