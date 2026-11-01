// Compatibility shim: the Deepgram socket moved to providers/stt/deepgram.ts (see providers/stt/index.ts for the registry).
export { DeepgramStream as SttStream } from "./providers/stt/deepgram.ts";
export { speechEndWall } from "./providers/stt/types.ts";
export type { Channel, Word, SttResult, SttOptions } from "./providers/stt/types.ts";
