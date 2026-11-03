// Compatibility shim: the Deepgram socket moved to providers/stt/deepgram.ts (see providers/stt/index.ts for the registry).
// Only the gate tool and some tests import this path; the engine uses providers/stt/channel.ts and index.ts.
export { DeepgramStream as SttStream } from "./providers/stt/deepgram.ts";
export { speechEndWall } from "./providers/stt/types.ts";
export type { Channel, Word, SttResult, SttOptions } from "./providers/stt/types.ts";
