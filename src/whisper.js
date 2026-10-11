// Local speech-to-text: talks to tools/whisper/whisper_srv.py (faster-whisper, large-v3-turbo on the GPU) over JSON lines.
//   const whisper = require('./whisper');
//   await whisper.transcribe('x.wav') -> { text, ms }   (rejects on error / timeout)
//   whisper.running() -> bool           whisper.stop()  kills the helper    whisper.warm()  starts it now
// Started lazily (the first call waits for the model, up to 60 s); one request at a time; 15 s per request;
// a crash restarts it once and retries the request. The helper exits itself after 10 idle minutes and starts again on demand.
// Env: SPHERE_WHISPER_PY (python.exe), SPHERE_WHISPER_SRV (whisper_srv.py).
const { spawn } = require('child_process');
const path = require('path');

const PY = () => require('./paths').whisperPy();   // the whisperPy setting (SPHERE_WHISPER_PY in tests)
const SRV = () => process.env.SPHERE_WHISPER_SRV || path.join(__dirname, '..', 'tools', 'whisper', 'whisper_srv.py');
const T_REQ = 15000, T_COLD = 60000;

let proc = null, buf = "", ready = false, nextId = 1;
let cur = null;                 // { id, wav, res, rej, timer, tries }
let readyWaiters = [];          // [{ res, rej }] waiting for the ready line
const queue = [];               // [{ wav, res, rej }]

function start() {
  const p = spawn(PY(), ['-u', SRV()], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  proc = p; buf = ''; ready = false;
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', d => {
    if (p !== proc) return;   // a killed server's last output never joins the next one's lines
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); }
  });
  p.stderr.on('data', () => {});   // logs; drained so the pipe never fills
  p.stdin.on('error', () => {});
  p.on('error', e => onExit(p, e));
  p.on('exit', () => onExit(p));
  return p;
}

function onLine(l) {
  let r; try { r = JSON.parse(l); } catch { return; }
  if (r.ready) { ready = true; for (const w of readyWaiters.splice(0)) w.res(); return; }
  if (!cur || r.id !== cur.id) return;
  const c = cur; cur = null; clearTimeout(c.timer);
  if (r.error) c.rej(new Error(r.error)); else c.res({ text: r.text || '', ms: r.ms || 0 });
  pump();
}

function onExit(p, err) {
  if (p !== proc) return;
  proc = null; ready = false;
  for (const w of readyWaiters.splice(0)) w.rej(err || new Error('whisper helper exited'));
  if (cur) {
    const c = cur;
    if (c.tries < 2 && !c.timedOut) { c.tries++; c.sent = false; send(c); }   // crashed mid-request: restart once, retry
    else { cur = null; clearTimeout(c.timer); c.rej(err || new Error('whisper helper exited')); pump(); }
  }
}

// waits for the model (first start can take a while), then writes the request
function send(c) {
  clearTimeout(c.timer);
  c.timer = setTimeout(() => { c.timedOut = true; c.rej(new Error('whisper timeout')); cur = null; kill(); pump(); }, ready ? T_REQ : T_COLD);
  const go = () => {
    if (cur !== c || !proc) return;
    clearTimeout(c.timer);
    c.timer = setTimeout(() => { c.timedOut = true; c.rej(new Error('whisper timeout')); cur = null; kill(); pump(); }, T_REQ);
    try { proc.stdin.write(JSON.stringify({ id: c.id, wav: c.wav }) + '\n'); } catch { /* exit handler retries */ }
  };
  if (!proc) start();
  if (ready) go(); else readyWaiters.push({ res: go, rej: () => {} });
}

function pump() {
  if (cur || !queue.length) return;
  const q = queue.shift();
  cur = { id: nextId++, wav: q.wav, res: q.res, rej: q.rej, tries: 1, timer: null, timedOut: false };
  send(cur);
}

function kill() { const p = proc; proc = null; ready = false; if (p) { try { p.kill(); } catch {} } }

function transcribe(wav) {
  return new Promise((res, rej) => { queue.push({ wav: path.resolve(String(wav)), res, rej }); pump(); });
}
function stop() {
  for (const q of queue.splice(0)) q.rej(new Error('stopped'));
  if (cur) { const c = cur; cur = null; clearTimeout(c.timer); c.rej(new Error('stopped')); }
  kill();
}
const running = () => !!proc;
// load the model ahead of a question (the wake word was heard, the push-to-talk key went down): saves the cold start
function warm() { if (!proc) start(); }

module.exports = { transcribe, stop, running, warm };
