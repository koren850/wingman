// The hidden capture window's page. It records audio in the app itself, so users need no ffmpeg:
//   mic     getUserMedia on the chosen input device
//   system  getDisplayMedia with Electron's loopback audio (Windows only; the main process answers the request, see tray/capture-host.cjs)
// Both go through an AudioWorklet and come out as 16 kHz mono s16le chunks of 100 ms, sent to the main process, which forwards them to the engine.
// Commands from the main process: start { ch, name }, stop { ch }, devices. Every command gets one reply with the same id.
(function () {
  "use strict";
  const dsp = window.WingmanDsp;
  const api = window.wingmanCapture;
  /** @type {Record<string, {ctx: AudioContext, stream: MediaStream, node: AudioWorkletNode}>} */
  const live = {};

  const fail = (code, message) => Object.assign(new Error(message), { code });

  /** Maps a getUserMedia / getDisplayMedia error to a short code the app turns into clear text. */
  function codeOf(e) {
    const n = (e && e.name) || "";
    if (n === "NotAllowedError" || n === "SecurityError") return "permission";
    if (n === "NotFoundError" || n === "OverconstrainedError") return "no-device";
    if (n === "NotReadableError" || n === "AbortError") return "busy";
    return e && e.code ? e.code : "failed";
  }

  async function listInputs() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "audioinput");
  }

  async function openMic(name) {
    const base = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    let stream = await navigator.mediaDevices.getUserMedia({ audio: base });
    let fellBack = false;
    if (name) {
      // Labels are readable only after the first successful open. Open again on the saved device when it is not the default one.
      const want = dsp.pickDevice(await listInputs(), name);
      const have = stream.getAudioTracks()[0].getSettings().deviceId;
      if (want && want.deviceId !== have) {
        try {
          const next = await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: want.deviceId } } });
          stream.getTracks().forEach((t) => t.stop());
          stream = next;
        } catch (e) {
          fellBack = true; // the saved device is listed but will not open: keep the default one
        }
      } else if (!want) fellBack = true;
    }
    return { stream, fellBack };
  }

  async function openSystem() {
    if (!navigator.mediaDevices.getDisplayMedia) throw fail("unsupported", "no system audio capture here");
    // The main process answers this request with Electron's loopback audio. A video track is part of the request; it is stopped at once.
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (!stream.getAudioTracks().length) throw fail("unsupported", "the system gave no audio track");
    return { stream: new MediaStream(stream.getAudioTracks()), fellBack: false };
  }

  async function startChannel(ch, name) {
    await stopChannel(ch);
    let opened;
    try {
      opened = ch === "mic" ? await openMic(name) : await openSystem();
    } catch (e) {
      throw fail(codeOf(e), String((e && e.message) || e));
    }
    const { stream, fellBack } = opened;
    let ctx;
    try {
      ctx = new AudioContext({ sampleRate: dsp.RATE, latencyHint: "interactive" });
      await ctx.audioWorklet.addModule("worklet.js");
      const node = new AudioWorkletNode(ctx, "pcm-tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const resample = dsp.createResampler(ctx.sampleRate);
      const chunk = dsp.createChunker((bytes) => api.pcm(ch, bytes));
      let stopped = false;
      node.port.onmessage = (m) => {
        if (!stopped) chunk(resample(m.data));
      };
      // The node is pulled through a silent gain: Chromium only runs worklet nodes that reach the output. Nothing is played.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      ctx.createMediaStreamSource(stream).connect(node);
      node.connect(mute).connect(ctx.destination);
      await ctx.resume();
      const entry = { ctx, stream, node, close: () => (stopped = true) };
      live[ch] = entry;
      stream.getAudioTracks()[0].addEventListener("ended", () => {
        if (live[ch] !== entry) return;
        void stopChannel(ch);
        api.ended(ch, "the audio device stopped");
      });
    } catch (e) {
      // A failure after the device opened must not leave the microphone on.
      stream.getTracks().forEach((t) => t.stop());
      try {
        if (ctx) await ctx.close();
      } catch (err) {
        /* already closed */
      }
      throw fail(codeOf(e), String((e && e.message) || e));
    }
    return { fellBack };
  }

  async function stopChannel(ch) {
    const e = live[ch];
    if (!e) return;
    delete live[ch];
    e.close();
    e.stream.getTracks().forEach((t) => t.stop());
    try {
      await e.ctx.close();
    } catch (err) {
      /* already closed */
    }
  }

  // Starts and stops of one channel run one after the other, so two quick commands never leave a second stream open.
  const chains = {};
  api.onCommand((cmd) => {
    if (cmd.ch !== "mic" && cmd.ch !== "system") return void handle(cmd);
    chains[cmd.ch] = (chains[cmd.ch] || Promise.resolve()).then(() => handle(cmd));
  });

  async function handle(cmd) {
    try {
      if (cmd.op === "start") api.reply({ id: cmd.id, ok: true, ...(await startChannel(cmd.ch, cmd.name)) });
      else if (cmd.op === "stop") {
        await stopChannel(cmd.ch);
        api.reply({ id: cmd.id, ok: true });
      } else if (cmd.op === "devices") {
        let list = await listInputs();
        if (list.length && list.every((d) => !d.label)) {
          // Labels stay empty until a microphone was opened once. Open and close one (the app asked for permission before).
          try {
            (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
          } catch (e) {
            throw fail(codeOf(e), String((e && e.message) || e));
          }
          list = await listInputs();
        }
        const real = list.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications");
        api.reply({
          id: cmd.id,
          ok: true,
          devices: real.map((d, i) => ({ index: i, name: d.label })),
          defaultName: ((list.find((d) => d.deviceId === "default") || {}).label || "").replace(/^default\s*-\s*/i, ""),
        });
      } else api.reply({ id: cmd.id, ok: false, code: "failed", message: "unknown command" });
    } catch (e) {
      api.reply({ id: cmd.id, ok: false, code: e.code || "failed", message: String((e && e.message) || e) });
    }
  }
})();
