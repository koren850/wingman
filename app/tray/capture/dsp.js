// Audio helpers of the capture window: float samples to 16 kHz mono signed 16-bit PCM in 100 ms chunks.
// A plain script (the page loads it with <script>) that also works with require(), so the unit tests can run it without a browser.
(function (root) {
  "use strict";
  const RATE = 16000;
  const CHUNK = 1600; // samples per chunk: 100 ms

  /** Float samples (-1..1) to s16le bytes. Out-of-range values are clipped. */
  function toPcm16(floats) {
    const out = typeof Buffer !== "undefined" ? Buffer.alloc(floats.length * 2) : new Uint8Array(floats.length * 2);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    for (let i = 0; i < floats.length; i++) {
      const v = Math.max(-1, Math.min(1, floats[i]));
      view.setInt16(i * 2, v < 0 ? Math.round(v * 32768) : Math.round(v * 32767), true);
    }
    return out;
  }

  /** Average of the channels as one mono array. A single channel is returned as it is. */
  function mixToMono(channels) {
    if (channels.length === 1) return channels[0];
    const n = channels[0].length,
      out = new Float32Array(n);
    for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i] / channels.length;
    return out;
  }

  /**
   * Streaming resampler from inRate to RATE (box filter average, good enough for speech). The AudioContext is asked for 16 kHz and Chromium
   * normally delivers it; this is the safety net for a device or driver that does not. push(floats) returns the new output samples.
   */
  function createResampler(inRate) {
    if (inRate === RATE) return (f) => f;
    const step = inRate / RATE;
    let pos = 0, // position in input samples of the next output sample (relative to the start of `pending`)
      pending = new Float32Array(0);
    return (floats) => {
      const all = new Float32Array(pending.length + floats.length);
      all.set(pending);
      all.set(floats, pending.length);
      const out = [];
      while (pos + step <= all.length) {
        const a = Math.floor(pos),
          b = Math.min(all.length, Math.ceil(pos + step));
        let sum = 0;
        for (let i = a; i < b; i++) sum += all[i];
        out.push(sum / (b - a));
        pos += step;
      }
      const drop = Math.floor(pos);
      pending = all.slice(drop);
      pos -= drop;
      return Float32Array.from(out);
    };
  }

  /** Collects samples and calls emit(pcmBytes) for every full CHUNK. A trailing part waits for the next push. */
  function createChunker(emit) {
    let buf = new Float32Array(0);
    return (floats) => {
      if (!floats.length) return;
      const all = new Float32Array(buf.length + floats.length);
      all.set(buf);
      all.set(floats, buf.length);
      let off = 0;
      while (all.length - off >= CHUNK) {
        emit(toPcm16(all.subarray(off, off + CHUNK)));
        off += CHUNK;
      }
      buf = all.slice(off);
    };
  }

  /** Normalised device name for matching a saved microphone against the labels the browser lists. */
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\([0-9a-f]{4}:[0-9a-f]{4}\)/g, "")
      .replace(/\s+/g, " ")
      .trim();

  /**
   * Picks the device a saved name points to. devices: [{deviceId, label}]. Returns the match or undefined (then the default device is used).
   * An exact label wins over a partial one; the virtual "default" and "communications" entries are never chosen by name.
   */
  function pickDevice(devices, name) {
    const want = norm(name);
    if (!want) return undefined;
    const real = devices.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications");
    return real.find((d) => norm(d.label) === want) || real.find((d) => norm(d.label).includes(want) || (norm(d.label) && want.includes(norm(d.label))));
  }

  const api = { RATE, CHUNK, toPcm16, mixToMono, createResampler, createChunker, pickDevice, norm };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanDsp = api;
})(typeof self !== "undefined" ? self : globalThis);
