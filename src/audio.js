// Talks to audio.ps1 (one long-lived PowerShell, -MTA): default output / mic, volume, mute, device-change events and voice commands.
//   const audio = require('./audio').create();      // spawns lazily; respawns with backoff once it has been used
//   audio.on('state', s => {})    s = { out:{id,name,vol,mute}, mic:{..}, outs:[{id,name}], mics:[{id,name}] }   (any change, < 1 s)
//   audio.on('command', c => {})  c = { cmd, arg?, text, confidence, wake }  (wake: the phrase began with "Theseus")
//   audio.on('listening', bool)   audio.on('error', info)  (the 'error' event only when a listener is attached)
//   await audio.get() / setDefault(id, role) / next(role, cycleIds) / setVolume(role, v) / setMute(role, true|false|'toggle')
//        -> the state, or null on failure (audio.lastError says why)
//   await audio.listen('off'|'ptt'|'wake'|'always') -> true/false
//   audio.dispose()
// { lite: true }: no voice, no safety refresh. Test hooks: testWav, testKey, testInput, send.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');

function create(opts = {}) {
  const em = new EventEmitter();
  let ps = null, buf = '', nextId = 1, fails = 0, startedAt = 0, retryAt = 0, ready = false;
  let wanted = false, disposed = false, respawnTimer = null, listenMode = 'off', testInput = null;
  let last = null, lastKey = '';
  const waiting = new Map();   // id -> { res, timer }; replies are matched by id, a stray line is dropped

  function done(id, r) { const w = waiting.get(id); if (!w) return; waiting.delete(id); clearTimeout(w.timer); w.res(r); }
  // a state from a reply or an event: emit 'state' when it differs from the last one seen
  function takeState(s) {
    if (!s || !s.out) return;
    const k = JSON.stringify(s);
    last = s; if (k === lastKey) return;
    lastKey = k; em.emit('state', s);
    // voice commands wanted but not running (no mic at start, a failed call): try again when a mic is there, at most every 30 s
    if (wantMode !== listenMode && s.mic && Date.now() >= listenRetryAt) { listenRetryAt = Date.now() + 30000; api.listen(wantMode); }
  }
  let wantMode = 'off', listenRetryAt = 0, wantAsk = false, wantWake = opts.wake || 'Theseus';
  function onLine(line) {
    let r; try { r = JSON.parse(line); } catch { return; }
    if (!r) return;
    if (typeof r.id === 'number') { if (r.state) takeState(r.state); done(r.id, r); return; }
    switch (r.event) {
      case 'ready': ready = true; break;
      case 'state': takeState(r.state); break;
      case 'command': { const { event, ...c } = r; em.emit('command', c); break; }
      case 'listening': em.emit('listening', !!r.on); break;
      case 'error': if (em.listenerCount('error')) em.emit('error', r); break;
      case 'heard': em.emit('heard', r); break;
      case 'question': em.emit('question', r); break;   // Voice Ask: { wav, sec, confidence, follow }
      case 'wake': em.emit('wake'); break;               // "Theseus" heard (Voice Ask on): a question may follow
    }
  }
  // the helper is gone (exit, spawn error): fail what waits; quick deaths back off 1, 2, 4 ... 30 s; a used helper comes back by itself
  function gone(p, hung) {   // hung: killed for not answering, counts as a quick death (no restart every 9 s)
    if (ps !== p) return;
    ps = null; buf = ''; ready = false;
    fails = Date.now() - startedAt < 30000 ? fails + 1 : hung ? 1 : 0;   // (a helper that answers and then dies within 30 s still backs off)
    if (fails) retryAt = Date.now() + Math.min(30000, 1000 * 2 ** (fails - 1));
    for (const id of [...waiting.keys()]) done(id, { ok: false, why: 'helper exited' });
    if (wanted && !disposed && !respawnTimer) {
      respawnTimer = setTimeout(() => { respawnTimer = null; if (!disposed && !ps) revive(); }, Math.max(500, retryAt - Date.now() + 50));   // +50: a timer may fire a little early, and start() would refuse
      if (respawnTimer.unref) respawnTimer.unref();
    }
  }
  // after a respawn: push the voice mode back in and refresh the state
  function revive() {
    if (!start()) return;
    if (testInput) send({ cmd: 'testInput', path: testInput });
    if (wantAsk) send({ cmd: 'ask', on: true });
    if (wantMode !== 'off') send({ cmd: 'listen', mode: wantMode }, 20000).then(r => { listenMode = r && r.ok ? wantMode : 'off'; });
    send({ cmd: 'get' });
  }
  function start() {
    if (ps) return true;
    if (disposed) return false;
    if (Date.now() < retryAt) return false;
    const args = ['-NoProfile', '-MTA', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'audio.ps1')];
    if (opts.lite) args.push('-Lite');
    args.push('-Wake', wantWake);
    let p;
    try { p = spawn('powershell.exe', args, { windowsHide: true }); } catch { fails++; retryAt = Date.now() + 1000; return false; }
    ps = p; startedAt = Date.now(); buf = ''; ready = false;
    p.on('error', () => gone(p));
    p.on('exit', () => gone(p));
    p.stdin.on('error', () => {});               // EPIPE after the helper died: the exit handler fails the waiters
    p.stderr.on('data', () => {});               // drained, so a chatty helper can never block
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', d => {
      if (ps !== p) return;   // a killed helper's last output never joins the next helper's lines
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(line); }
    });
    return true;
  }

  // send({cmd, ...}, timeoutMs) -> Promise of the raw reply (never rejects; {ok:false} on failure); the helper handles commands in order.
  // No reply in time = a hung call: the helper is killed and starts fresh. The first call may wait for the one-time compile.
  function send(cmd, ms = 8000) {
    if (disposed) return Promise.resolve({ ok: false, why: 'disposed' });
    wanted = true;
    if (!ps && !start()) return Promise.resolve({ ok: false, why: 'helper down' });
    const p = ps, id = nextId++;
    return new Promise(res => {
      const timer = setTimeout(() => { done(id, { ok: false, why: 'timeout' }); try { p.kill(); } catch {} gone(p, true); }, ms + (ready ? 0 : 30000));
      waiting.set(id, { res, timer });
      try { p.stdin.write(JSON.stringify({ id, ...cmd }) + '\n'); } catch { done(id, { ok: false, why: 'write failed' }); }
    });
  }
  const st = r => { if (r && r.ok && r.state) return r.state; api.lastError = (r && r.why) || 'failed'; return null; };

  const api = Object.assign(em, {
    lastError: '',
    send,
    get: () => send({ cmd: 'get' }).then(st),
    setDefault: (id, role) => send({ cmd: 'setDefault', dev: id, role }).then(st),
    next: (role, cycleIds) => send({ cmd: 'next', role, cycle: Array.isArray(cycleIds) ? cycleIds : [] }).then(st),
    setVolume: (role, v) => send({ cmd: 'volume', role, value: v }).then(st),
    setMute: (role, v) => send({ cmd: 'mute', role, value: v }).then(st),
    listen(mode) {
      wantMode = mode;
      return send({ cmd: 'listen', mode }, 20000).then(r => {
        if (r && r.ok) { listenMode = mode; return true; }
        api.lastError = (r && r.why) || 'failed'; return false;
      });
    },
    // the wake word (the assistant's name): the grammar is rebuilt by listening again
    wake(name) { wantWake = name; return send({ cmd: 'wake', name }).then(() => wantMode !== 'off' ? api.listen(wantMode) : true); },
    ask(on) { wantAsk = !!on; return send({ cmd: 'ask', on: wantAsk }, 20000); },   // Voice Ask questions on / off (rebuilds the recogniser)
    follow: ms => send({ cmd: 'follow', ms: Math.max(0, ms | 0) }),          // follow-up window after an answer
    phrases: () => send({ cmd: 'phrases' }).then(r => (r && r.phrases) || []),     // [[phrase, cmd, arg]]
    // test hooks
    testWav: (file, mode = 'always') => send({ cmd: 'testWav', path: file, mode }, 30000),
    testKey: down => send({ cmd: 'testKey', down: !!down }),
    testInput(file) { testInput = file || null; return send({ cmd: 'testInput', path: file || null }); },
    dispose() {
      disposed = true; clearTimeout(respawnTimer);
      const p = ps; if (p) { try { p.stdin.end(); } catch {} try { p.kill(); } catch {} gone(p); }
      em.removeAllListeners();
    },
  });
  Object.defineProperty(api, 'state', { get: () => last });
  Object.defineProperty(api, 'pid', { get: () => (ps ? ps.pid : 0) });   // the last state seen
  return api;
}
module.exports = { create };
