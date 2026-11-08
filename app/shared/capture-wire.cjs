"use strict";
// Wire format between the Wingman app (it owns the microphone and Windows loopback capture, see tray/capture-bridge.cjs) and the engine
// process (src/capture-client.ts). One local socket, owner-only; a frame is  type (1 byte) · length (4 bytes, little endian) · payload.
//   type 1  JSON control message (UTF-8)     type 2  PCM of the microphone     type 3  PCM of the system audio
// PCM is 16 kHz mono signed 16-bit little-endian with a whole number of samples. No electron import: unit-tested on any machine.

const T_JSON = 1;
const T_PCM_MIC = 2;
const T_PCM_SYSTEM = 3;
/** Largest payload accepted. 100 ms of audio is 3200 bytes; a bigger frame means a broken or hostile peer. */
const MAX_FRAME = 1 << 20;

const CHANNELS = ["mic", "system"];
const pcmType = (ch) => (ch === "mic" ? T_PCM_MIC : T_PCM_SYSTEM);
const channelOf = (type) => (type === T_PCM_MIC ? "mic" : type === T_PCM_SYSTEM ? "system" : undefined);

function frame(type, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32LE(payload.length, 1);
  return Buffer.concat([head, payload]);
}
/** A control message as one frame. */
const encodeJson = (obj) => frame(T_JSON, Buffer.from(JSON.stringify(obj), "utf8"));
/** PCM for one channel as one frame. */
const encodePcm = (ch, pcm) => frame(pcmType(ch), pcm);

/**
 * Stream decoder. push(chunk) returns the frames completed by that chunk: { json } or { ch, pcm }.
 * Throws on an unknown type, an oversized frame or bad JSON: the caller drops the connection.
 */
function createDecoder() {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const out = [];
      while (buf.length >= 5) {
        const type = buf.readUInt8(0),
          len = buf.readUInt32LE(1);
        if (len > MAX_FRAME) throw new Error("capture frame too large");
        if (type !== T_JSON && !channelOf(type)) throw new Error("unknown capture frame type");
        if (buf.length < 5 + len) break;
        const payload = buf.subarray(5, 5 + len);
        buf = buf.subarray(5 + len);
        if (type === T_JSON) out.push({ json: JSON.parse(payload.toString("utf8")) });
        else out.push({ ch: channelOf(type), pcm: Buffer.from(payload) });
      }
      return out;
    },
  };
}

module.exports = { T_JSON, T_PCM_MIC, T_PCM_SYSTEM, MAX_FRAME, CHANNELS, encodeJson, encodePcm, createDecoder };
