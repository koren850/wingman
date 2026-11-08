// Runs on the audio thread. Collects 128-sample blocks into 1600-sample frames and posts them to the page (capture.js), which converts them to PCM.
// Posts the first channel only after mixing all channels; the page sets the sample rate it was given.
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(1600);
    this.fill = 0;
  }
  process(inputs) {
    const ch = inputs[0];
    if (!ch || !ch.length) return true;
    const n = ch[0].length;
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let c = 0; c < ch.length; c++) v += ch[c][i];
      this.frame[this.fill++] = v / ch.length;
      if (this.fill === this.frame.length) {
        this.port.postMessage(this.frame.slice(0));
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
