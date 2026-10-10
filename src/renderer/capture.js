// Hidden audio capture page for the recorder (src/recorder.js). Loaded with nodeIntegration from a local file only.
// startCap('sys') = system sound (getDisplayMedia, audio 'loopback'; main's display-media handler grants it), startCap('mic') = the default mic.
// Both are sent to main as interleaved 48 kHz float32 stereo chunks (50 ms) on 'rec<i>:pcm'.
const { ipcRenderer } = require('electron');
const inst = new URLSearchParams(location.search).get('i');
const caps = {};            // kind -> { stream, ctx }
const wanted = {};          // kind -> true while it should run (restarted on device changes)

const WORKLET = `class Pcm extends AudioWorkletProcessor {
  constructor() { super(); this.b = new Float32Array(4800); this.n = 0; }
  process(inputs) {
    const i = inputs[0];
    if (!i || !i.length) return true;
    const l = i[0], r = i[1] || i[0];
    for (let k = 0; k < l.length; k++) {
      this.b[this.n++] = l[k]; this.b[this.n++] = r[k];
      if (this.n >= this.b.length) { const o = this.b.slice(0); this.port.postMessage(o, [o.buffer]); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('pcm', Pcm);`;

async function open(kind) {
  let stream;
  if (kind === 'mic') {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } });
  } else {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    for (const t of stream.getVideoTracks()) { t.stop(); stream.removeTrack(t); }
    if (!stream.getAudioTracks().length) throw new Error('no loopback audio track');
  }
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  node.port.onmessage = e => ipcRenderer.send(`rec${inst}:pcm`, kind, new Uint8Array(e.data.buffer));
  const mute = ctx.createGain(); mute.gain.value = 0;      // keeps the worklet pulled by the graph; plays nothing
  src.connect(node); node.connect(mute); mute.connect(ctx.destination);
  await ctx.resume();
  caps[kind] = { stream, ctx };
}

async function stopCap(kind) {
  wanted[kind] = false;
  const c = caps[kind]; delete caps[kind];
  if (!c) return;
  for (const t of c.stream.getTracks()) t.stop();
  try { await c.ctx.close(); } catch { }
}

async function startCap(kind) {
  await stopCap(kind);
  wanted[kind] = true;
  await open(kind);
}

// the default device changed: reopen what is running (main fills the short gap with silence)
let devTimer = null;
navigator.mediaDevices.addEventListener('devicechange', () => {
  clearTimeout(devTimer);
  devTimer = setTimeout(async () => {
    for (const kind of Object.keys(wanted)) {
      if (!wanted[kind]) continue;
      try { const c = caps[kind]; delete caps[kind]; if (c) { for (const t of c.stream.getTracks()) t.stop(); try { await c.ctx.close(); } catch { } } await open(kind); }
      catch (e) { ipcRenderer.send(`rec${inst}:caperr`, kind, 'reopen failed: ' + (e && e.message || e)); }
    }
  }, 600);
});
