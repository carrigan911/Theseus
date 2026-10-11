// Screen recorder for Theseus (tools, part B). Own code; the ffmpeg command lines are adapted from the old Mode Buttons recorder.
// Video: ffmpeg ddagrab (screen / region) or gfxcapture (window, gdigrab as fallback) -> hevc_nvenc cq 23, 60 fps (no NVIDIA:
// hevc_amf, else software libx264; found once by a one-frame test encode).
// Audio: a hidden capture page (renderer/capture.html) records the system sound (getDisplayMedia, audio 'loopback') and the mic (getUserMedia)
// as 48 kHz float stereo PCM; main feeds it to ffmpeg through Windows named pipes (\\.\pipe\...), so a file has video + up to 2 audio streams.
// Nothing runs while neither a recording nor the replay buffer is on.
//
//   const rec = require('./recorder').create({ ffmpeg, tmpDir });
//   rec.on('state', s => {})   // { recording, since (ms epoch|null), file, replay, replaySec }
//   rec.on('error', e => {})   // { where, message }            (extra, not in the fixed interface)
//   rec.on('saved', e => {})   // { kind, file, error }         only when ffmpeg ended by itself (extra)
//   rec.on('levels', l => {})  // { mic, sys }  0..1 (dB scaled, null = that stream is not recorded), 10 times a second, only while recording / replay
//   rec.on('lowdisk', e => {}) // { freeGB, dir, where }       under 10 GB free at a start / while recording (one notice per crossing; nothing is stopped)
//   rec.on('recovered', e => {}) // { file, from }              a crash-left <prefix>_*.mkv turned into .mp4 by recover()
//   await rec.recover(dir) -> [{ file, from }]     rec.cleanReplay() -> clears old replay pieces when the replay is off
//   await rec.start({ source, display, region, hwnd, outDir, mic, system })      -> { file }  (the .mkv being written)
//   await rec.stop()                                                             -> { file }  (.mp4)
//   await rec.setReplay(on, sec, opts)    await rec.saveReplay(outDir)           -> { file, sec }
//   await rec.screenshot({ source, display, region, hwnd, outDir })              -> { file }  (PNG)
//   await rec.pickRegion()  -> {x,y,w,h} physical px or null     await rec.listWindows() -> [{ hwnd, title, exe }]
//   rec.dispose()
'use strict';
const { app, BrowserWindow, ipcMain, screen, desktopCapturer, session } = require('electron');
const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const RATE = 48000, BPF = 8;                       // 48 kHz, 2 x float32 per frame
const LOW_DISK = 10 * 1024 ** 3;                    // warn under 10 GB free
const MIN_DB = -60;                                 // level meter floor
const DEFAULT_FFMPEG = '';                          // main passes the ffmpeg setting (or the one found on PATH)
let instances = 0;
const liveProcs = new Set();                        // ffmpeg children, killed when this process exits
process.on('exit', () => { for (const p of liveProcs) { try { p.kill(); } catch { } } });

const pad2 = n => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
}
function uniquePath(dir, base, ext) {                 // <prefix>_<stamp>.ext, with _2, _3 ... if it already exists
  let f = path.join(dir, base + ext), n = 2;
  while (fs.existsSync(f)) f = path.join(dir, `${base}_${n++}${ext}`);
  return f;
}
const even = v => Math.max(2, Math.floor(v) - (Math.floor(v) & 1));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tail = (f, n = 600) => { try { const s = fs.readFileSync(f, 'utf8'); return s.slice(-n).trim(); } catch { return ''; } };

// ---------- displays (Electron DIPs <-> physical pixels) ----------
function allDisplays() { return screen.getAllDisplays(); }
function physBounds(d) { return screen.dipToScreenRect(null, d.bounds); }
function pickDisplay(id) {
  const all = allDisplays();
  if (id != null) { const d = all.find(x => x.id === Number(id)); if (d) return d; }
  return screen.getPrimaryDisplay();
}
const outputIdx = d => Math.max(0, allDisplays().findIndex(x => x.id === d.id));   // ddagrab output_idx = position in the display list (as Screen.AllScreens did)

// ---------- a named pipe that ffmpeg reads as raw f32le stereo 48 kHz ----------
// Data comes in with push(); when less arrives than the wall clock needs (loopback sends nothing during silence, the page is late),
// silence fills the gap so audio stays in step with the video. Data that runs far ahead of the clock is dropped.
let pipeSeq = 0;
function makeFeeder(kind) {
  const name = `sessionsphere_rec_${kind}_${process.pid}_${++pipeSeq}`;
  const f = { kind, path: `\\\\.\\pipe\\${name}`, sock: null, closed: false, written: 0, t0: process.hrtime.bigint(), timer: null, dropped: 0, connectMs: 0 };
  const server = net.createServer();
  f.connected = new Promise(resolve => {
    server.on('connection', sock => {
      if (f.sock || f.closed) { sock.destroy(); return; }
      f.sock = sock; f.connectMs = Number((process.hrtime.bigint() - f.t0) / 1000000n);
      sock.on('error', () => { });
      sock.on('close', () => { f.sock = null; clearInterval(f.timer); });
      f.timer = setInterval(() => f.fill(), 20);
      try { server.close(); } catch { }
      resolve(true);
    });
    f.resolveNever = () => resolve(false);
  });
  const expected = () => Number((process.hrtime.bigint() - f.t0) * BigInt(RATE) / 1000000000n);
  f.fill = () => {
    if (!f.sock) return;
    const gap = expected() - f.written - RATE / 100;
    if (gap > RATE / 20) f.write(Buffer.alloc(Math.min(gap, RATE) * BPF));
  };
  f.write = buf => {
    const s = f.sock; if (!s || s.destroyed) return;
    if (s.writableLength > 16e6) { f.dropped += buf.length; return; }   // ffmpeg not reading
    s.write(buf); f.written += buf.length / BPF;
  };
  f.push = buf => {
    if (!f.sock) return;
    f.pushed = (f.pushed || 0) + buf.length;
    if (f.written - expected() > RATE / 2) { f.dropped += buf.length; return; }   // far ahead of the clock
    f.write(buf);
  };
  f.close = () => {
    f.closed = true; clearInterval(f.timer);
    try { server.close(); } catch { }
    if (f.sock) { try { f.sock.end(); } catch { } const s = f.sock; setTimeout(() => { try { s.destroy(); } catch { } }, 500); }
    f.resolveNever();
  };
  server.on('error', () => { });
  server.listen(f.path);
  return f;
}

// ---------- the module ----------
function create(opts = {}) {
  // file names start with the prefix (opts.prefix: a string or a function, read at each use; letters, digits, _ and - only)
  const pre = () => (String((typeof opts.prefix === 'function' ? opts.prefix() : opts.prefix) || 'Recording').replace(/[^\w-]+/g, '_').slice(0, 30) || 'Recording');
  // the ffmpeg path: a function is asked each time (a path set later in settings works without a restart)
  const ffmpegOf = () => (typeof opts.ffmpeg === 'function' ? opts.ffmpeg() : opts.ffmpeg) || DEFAULT_FFMPEG;
  // the video encoder: the first that encodes a test frame here; SPHERE_ENC forces one (tests)
  const ENC = {
    hevc_nvenc: ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0'],
    hevc_amf: ['-c:v', 'hevc_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23'],
    libx264: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'],
  };
  let encP = null, encFor = '';
  const tryEnc = e => new Promise(res => {
    let p; try { p = spawn(ffmpegOf(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.1', '-frames:v', '1', ...ENC[e], '-f', 'null', '-'], { windowsHide: true, stdio: 'ignore' }); } catch { return res(false); }
    const t = setTimeout(() => { try { p.kill(); } catch { } res(false); }, 10000);
    p.on('error', () => { clearTimeout(t); res(false); }); p.on('exit', c => { clearTimeout(t); res(c === 0); });
  });
  function encoder() {
    if (encP && encFor === ffmpegOf()) return encP;
    encFor = ffmpegOf();
    const order = ENC[process.env.SPHERE_ENC] ? [process.env.SPHERE_ENC] : ['hevc_nvenc', 'hevc_amf', 'libx264'];
    return (encP = (async () => { for (const e of order) if (await tryEnc(e)) return e; return 'libx264'; })());
  }
  const tagFor = codec => codec === 'hevc' ? ['-tag:v', 'hvc1'] : codec === 'h264' ? ['-tag:v', 'avc1'] : [];   // mp4 tags by codec
  const tmpDir = opts.tmpDir || path.join(os.tmpdir(), 'SessionSphere', 'rec');
  const inst = ++instances;
  const ch = n => `rec${inst}:${n}`;
  const ee = new EventEmitter();
  let disposed = false;
  let recJob = null, replayJob = null, replaySec = 60, replayOpts = null, stopping = null;
  let seq = 0;
  let replayCodec = 'hevc';                          // the replay ring's codec (its saves are tagged by it)
  const busyOut = new Set();                          // recording files in use (being written or being remuxed): recover() leaves them alone

  const logPath = tag => path.join(tmpDir, `ffmpeg-${tag}.log`);
  const replayDir = () => path.join(tmpDir, 'replay');
  const emitErr = (where, e) => { try { ee.emit('error', { where, message: String(e && e.message || e) }); } catch { } };
  // an 'error' event with no listener would throw; keep a no-op listener so C can opt in
  ee.on('error', () => { });
  // ffmpeg left over from an app that died hard (its pipes are named sessionsphere_rec_*; the parent is gone): it would grab the screen forever
  if (!opts.keepOrphans) execFile('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe'\" | ? { $_.CommandLine -match 'sessionsphere_rec_' -and -not (Get-Process -Id $_.ParentProcessId -EA SilentlyContinue) } | % { Stop-Process -Id $_.ProcessId -Force }"],
    { windowsHide: true, timeout: 20000 }, () => { });
  const state = () => ({ recording: !!recJob, since: recJob ? recJob.started : null, file: recJob ? recJob.output : null, replay: !!replayJob, replaySec });
  const emitState = () => { if (!disposed) try { ee.emit('state', state()); } catch { } };

  // ----- capture page (hidden): feeds PCM to every running ffmpeg job -----
  let capWin = null, capReady = null, capCloseTimer = null;
  const subs = { sys: new Set(), mic: new Set() };       // feeders per stream kind
  const active = { sys: false, mic: false };
  const part = 'rec-capture-' + inst;
  let capSession = null;

  function ensureCapWin() {
    if (capWin && !capWin.isDestroyed()) return capReady;
    capSession = session.fromPartition(part);
    capSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media' || perm === 'display-capture'));
    capSession.setPermissionCheckHandler((wc, perm) => perm === 'media' || perm === 'display-capture');
    capSession.setDisplayMediaRequestHandler((req, cb) => {
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
        .then(src => cb({ video: src[0], audio: 'loopback' })).catch(() => cb({}));
    });
    capWin = new BrowserWindow({
      show: false, width: 200, height: 100, skipTaskbar: true,
      webPreferences: { session: capSession, nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' }
    });
    const w = capWin;
    w.on('closed', () => { if (capWin === w) { capWin = null; capReady = null; active.sys = active.mic = false; } });
    capReady = new Promise((res, rej) => {
      w.webContents.once('did-finish-load', () => res());
      w.webContents.once('did-fail-load', (e, code, desc) => rej(new Error('capture page: ' + desc)));
    });
    w.loadFile(path.join(__dirname, 'renderer', 'capture.html'), { query: { i: String(inst) } });
    return capReady;
  }
  const onPcm = (e, kind, data) => {
    if (!capWin || e.sender !== capWin.webContents) return;
    const set = subs[kind]; if (!set || !set.size) return;
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    meter(kind, buf);
    for (const f of set) f.push(buf);
  };
  // ----- levels: RMS of the PCM per stream kind, reported 10 times a second while a recording or the replay runs -----
  const lv = { sys: { sum: 0, n: 0 }, mic: { sum: 0, n: 0 } };
  let levelTimer = null;
  function meter(kind, buf) {
    const a = lv[kind]; if (!a || !levelTimer) return;
    const n = buf.length >> 2; if (!n) return;
    let sum = 0;
    if ((buf.byteOffset & 3) === 0) { const fa = new Float32Array(buf.buffer, buf.byteOffset, n); for (let i = 0; i < n; i++) { const v = fa[i]; sum += v * v; } }
    else for (let i = 0; i < n; i++) { const v = buf.readFloatLE(i * 4); sum += v * v; }
    if (sum === sum) { a.sum += sum; a.n += n; }            // NaN samples are skipped
  }
  const levelOf = kind => {
    const a = lv[kind], on = subs[kind].size > 0;
    const r = a.n ? Math.sqrt(a.sum / a.n) : 0; a.sum = 0; a.n = 0;
    if (!on) return null;
    if (!(r > 0)) return 0;
    return Math.max(0, Math.min(1, (20 * Math.log10(r) - MIN_DB) / -MIN_DB));
  };
  function levelTick() {
    if (disposed || (!recJob && !replayJob)) { stopLevels(); return; }
    try { ee.emit('levels', { mic: levelOf('mic'), sys: levelOf('sys') }); } catch { }
  }
  function startLevels() { if (!levelTimer) { levelTimer = setInterval(levelTick, 100); if (levelTimer.unref) levelTimer.unref(); } }
  function stopLevels() { if (levelTimer) { clearInterval(levelTimer); levelTimer = null; lv.sys.sum = lv.sys.n = lv.mic.sum = lv.mic.n = 0; } }

  // ----- free disk space: a notice under 10 GB at a start and once per crossing every 30 s while recording; never refuses or stops -----
  let lowWarned = false, diskTimer = null;
  const freeBytes = opts.freeBytes || (async dir => {
    let d = path.resolve(dir || os.homedir());
    for (let i = 0; i < 8 && !fs.existsSync(d); i++) d = path.dirname(d);   // a folder not made yet: its drive is the same
    const s = await fs.promises.statfs(d);
    return Number(s.bavail) * Number(s.bsize);
  });
  const lowLimit = opts.lowDiskBytes || LOW_DISK;
  async function checkDisk(dir, where, atStart) {
    if (disposed) return;
    let free; try { free = await freeBytes(dir); } catch { return; }
    if (!(free >= 0)) return;
    if (free < lowLimit) {
      if (atStart || !lowWarned) { try { ee.emit('lowdisk', { freeGB: Math.round(free / 1024 ** 3 * 10) / 10, dir, where }); } catch { } }
      lowWarned = true;
    } else lowWarned = false;
  }
  function startDiskWatch(dir) {
    stopDiskWatch();
    diskTimer = setInterval(() => { if (recJob) checkDisk(dir, 'recording', false); else stopDiskWatch(); }, 30000);
    if (diskTimer.unref) diskTimer.unref();
  }
  function stopDiskWatch() { if (diskTimer) { clearInterval(diskTimer); diskTimer = null; } }
  const onCapErr = (e, kind, msg) => emitErr('capture-' + kind, msg);
  ipcMain.on(ch('pcm'), onPcm);
  ipcMain.on(ch('caperr'), onCapErr);

  async function capCall(kind, on) {
    try {
      await ensureCapWin();
      if (!capWin) return;
      await capWin.webContents.executeJavaScript(`${on ? 'startCap' : 'stopCap'}(${JSON.stringify(kind)})`, true);
      active[kind] = on;
    } catch (e) { emitErr('capture-' + kind, e); }
  }
  async function attach(kind, feeder) {
    clearTimeout(capCloseTimer);
    subs[kind].add(feeder);
    if (!active[kind] && subs[kind].size === 1) await capCall(kind, true);
  }
  function detach(kind, feeder) {
    subs[kind].delete(feeder);
    if (!subs[kind].size && active[kind]) capCall(kind, false);
    if (!subs.sys.size && !subs.mic.size) {                // nothing left: free the page after a short grace
      clearTimeout(capCloseTimer);
      capCloseTimer = setTimeout(() => { if (!subs.sys.size && !subs.mic.size && capWin && !capWin.isDestroyed()) capWin.close(); }, 3000);
    }
  }

  // ----- ffmpeg video input for a source -----
  function resolveSource(o) {
    const source = o.source || 'screen';
    if (source === 'window') {
      if (!o.hwnd) throw new Error('window source needs hwnd');
      return { source, hwnd: Number(o.hwnd) };
    }
    if (source === 'region') {
      const r = o.region;
      if (!r || !(r.w >= 32) || !(r.h >= 32)) throw new Error('region too small or missing (min 32 x 32)');
      const all = allDisplays();
      let d = all.find(x => { const b = physBounds(x); return r.x >= b.x && r.x < b.x + b.width && r.y >= b.y && r.y < b.y + b.height; }) || pickDisplay(o.display);
      const b = physBounds(d);
      const x0 = Math.max(r.x, b.x), y0 = Math.max(r.y, b.y), x1 = Math.min(r.x + r.w, b.x + b.width), y1 = Math.min(r.y + r.h, b.y + b.height);
      if (x1 - x0 < 32 || y1 - y0 < 32) throw new Error('region is outside the display');
      return { source, display: d, rect: { x: x0 - b.x, y: y0 - b.y, w: even(x1 - x0), h: even(y1 - y0) } };
    }
    return { source: 'screen', display: pickDisplay(o.display) };
  }
  function videoInput(s, useGdi, title) {
    if (s.source === 'window') {
      if (useGdi) return ['-f', 'gdigrab', '-framerate', '60', '-i', 'title=' + title];
      return ['-f', 'lavfi', '-i', `gfxcapture=hwnd=${s.hwnd}:max_framerate=60:width=-2:height=-2:capture_border=0:display_border=0`];
    }
    const idx = outputIdx(s.display);
    if (s.source === 'region') {
      const r = s.rect;
      return ['-f', 'lavfi', '-i', `ddagrab=output_idx=${idx}:framerate=60:offset_x=${r.x}:offset_y=${r.y}:video_size=${r.w}x${r.h}`];
    }
    return ['-f', 'lavfi', '-i', `ddagrab=output_idx=${idx}:framerate=60`];
  }

  function runFfmpeg(args, tag, stdin) {
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { }
    const lp = logPath(tag);
    try { if (fs.existsSync(lp) && fs.statSync(lp).size > 2e6) fs.unlinkSync(lp); } catch { }
    try { fs.appendFileSync(lp, `${new Date().toISOString()} ffmpeg ${args.join(' ')}\n`); } catch { }
    const p = spawn(ffmpegOf(), args, { windowsHide: true, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    liveProcs.add(p);
    const out = fs.createWriteStream(lp, { flags: 'a' });
    out.on('error', () => { });                     // a failed log open or a late write never takes main down
    let logged = 0;
    p.frames = 0;
    p.stderr.on('data', d => { if (out.writableEnded || (logged += d.length) > 5e6) return; out.write(d); });   // capped at 5 MB a job
    p.stdout.on('data', d => { const m = String(d).match(/frame=(\d+)/g); if (m) p.frames = parseInt(m[m.length - 1].slice(6), 10) || p.frames; });   // -progress pipe:1
    let fin; p.exited = new Promise(res => { fin = res; });
    p.on('error', e => { if (!out.writableEnded) out.end('spawn error ' + e.message + '\n'); liveProcs.delete(p); fin(-1); });   // spawn failure: 'exit' never fires
    p.on('exit', c => { liveProcs.delete(p); fin(c); });
    p.on('close', c => { if (!out.writableEnded) out.end('exit ' + c + '\n'); });   // after stderr has drained
    if (stdin) p.stdin.on('error', () => { });
    return p;
  }

  // Starts an ffmpeg job (recording or replay ring) and resolves when it is up (inputs open, still alive 0.5 s later).
  async function startJob(kind, o, outputArgs, output, useGdi = false) {
    if (!ffmpegOf()) throw new Error('ffmpeg was not found: install it, or set its path under General settings > Paths');
    const s = resolveSource(o), enc = await encoder();
    let title = '';
    if (useGdi) { const w = (await listWindows()).find(x => x.hwnd === s.hwnd); if (!w) throw new Error('window not found'); title = w.title; }
    const feeders = [];
    const wantSys = !!o.system, wantMic = !!o.mic;
    if (wantSys) feeders.push(makeFeeder('sys'));
    if (wantMic) feeders.push(makeFeeder('mic'));
    const args = ['-hide_banner', '-nostats', '-progress', 'pipe:1', '-loglevel', 'warning', '-y', ...videoInput(s, useGdi, title)];
    let n = 1; const maps = ['-map', '0:v'], meta = [];
    for (const f of feeders) {
      args.push('-thread_queue_size', '4096', '-f', 'f32le', '-ar', String(RATE), '-ac', '2', '-i', f.path);
      maps.push('-map', `${n}:a`); { const nm = f.kind === 'sys' ? 'System' : 'Mic'; meta.push(`-metadata:s:a:${n - 1}`, `title=${nm}`, `-metadata:s:a:${n - 1}`, `handler_name=${nm}`); } n++;
    }
    args.push(...maps, '-fps_mode', 'cfr', '-r', '60');
    // screen and window capture hand over GPU frames: a software encoder gets them copied down first
    const vf = useGdi ? 'pad=ceil(iw/2)*2:ceil(ih/2)*2' : enc === 'libx264' ? 'hwdownload,format=bgra,pad=ceil(iw/2)*2:ceil(ih/2)*2' : '';
    if (vf) args.push('-vf', vf);
    args.push(...ENC[enc], '-g', '120', '-force_key_frames', 'expr:gte(t,n_forced*2)');
    if (kind === 'replay') replayCodec = enc === 'libx264' ? 'h264' : 'hevc';
    if (feeders.length) args.push('-c:a', 'aac', '-b:a', '192k', ...meta);
    args.push(...outputArgs);
    const job = { kind, feeders, output, started: Date.now(), proc: null, exited: false, opts: o, source: s, useGdi };
    for (const f of feeders) attach(f.kind, f);
    for (const f of feeders) f.t0 = process.hrtime.bigint();   // audio clock starts when ffmpeg does (its video clock starts about then); the first fill pads the lead-in
    const proc = runFfmpeg(args, kind, true);
    job.proc = proc;
    proc.exited.then(code => { job.exited = true; job.code = code; });
    const dead = proc.exited.then(c => ({ dead: true, code: c }));
    const timeout = sleep(15000).then(() => ({ dead: true, code: 'timeout' }));
    const up = Promise.all(feeders.map(f => f.connected)).then(() => ({ dead: false }));
    let r = await Promise.race([up, dead, timeout]);
    if (!r.dead) {                                         // inputs open: wait for the first encoded frame (a window that never changes may send none)
      const limit = Date.now() + (s.source === 'window' && !useGdi ? 4000 : 10000);
      while (!proc.frames && !job.exited && Date.now() < limit) await sleep(100);
      if (job.exited) r = { dead: true, code: job.code };
      else if (!proc.frames) r = { dead: true, code: 'no frames' };
    }
    if (r.dead) {
      const msg = tail(logPath(kind));
      cleanupJob(job); try { proc.kill(); } catch { }
      if (s.source === 'window' && !useGdi) { try { return await startJob(kind, o, outputArgs, output, true); } catch { /* report the gfxcapture failure below */ } }
      throw new Error(`ffmpeg ${kind} failed to start (${r.code}): ${msg.split('\n').slice(-4).join(' | ')}`);
    }
    return job;
  }
  function cleanupJob(job) {
    for (const f of job.feeders) { try { fs.appendFileSync(logPath(job.kind), `feeder ${f.kind}: audio from page ${((f.pushed || 0) / BPF / RATE).toFixed(2)} s, written ${(f.written / RATE).toFixed(2)} s, dropped ${(f.dropped / BPF / RATE).toFixed(2)} s, connected after ${f.connectMs} ms
`); } catch { } }
    for (const f of job.feeders) { detach(f.kind, f); f.close(); }
    job.feeders = [];
  }
  // clean end: "q" on stdin, kill after 8 s
  async function endJob(job) {
    try { if (!job.exited) job.proc.stdin.write('q'); } catch { }
    const r = await Promise.race([job.proc.exited, sleep(8000).then(() => 'timeout')]);
    if (r === 'timeout') { try { job.proc.kill(); } catch { } await Promise.race([job.proc.exited, sleep(2000)]); }
    cleanupJob(job);
  }

  // How far the audio runs ahead of the video: both end at the same stop, so the difference of their lengths is the audio that was recorded
  // before the first video frame arrived (a window sends its first frame late). -> { lead: seconds to cut from the audio's start or 0, codec }
  function audioLead(file) {
    return new Promise(res => {
      const probe = path.join(path.dirname(ffmpegOf()), 'ffprobe.exe');
      execFile(probe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:stream_tags=DURATION:stream=duration', '-of', 'json', file], { windowsHide: true, timeout: 15000 }, (err, out) => {
        try {
          const st = JSON.parse(out).streams;
          const dur = x => { const t = x.tags && x.tags.DURATION; if (t) { const m = /(\d+):(\d+):([\d.]+)/.exec(t); if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]); } return parseFloat(x.duration); };
          const v = st.find(x => x.codec_type === 'video'), au = st.filter(x => x.codec_type === 'audio');
          const vd = v && dur(v); const lead = au.length ? Math.min(...au.map(dur)) - vd : 0;
          res({ lead: isFinite(lead) && lead > 0.2 && lead < 30 ? lead : 0, codec: v && v.codec_name });
        } catch { res({ lead: 0, codec: '' }); }
      });
    });
  }
  // mkv -> mp4 without re-encoding; the mkv is kept if the mp4 is not sound
  async function remux(mkv) {
    const mp4 = mkv.replace(/\.mkv$/i, '.mp4');
    if (!fs.existsSync(mkv) || fs.statSync(mkv).size < 1024) return { file: null, error: 'nothing recorded (see ' + logPath('rec') + ')' };
    const { lead, codec } = await audioLead(mkv);
    const tail_ = ['-c', 'copy', ...tagFor(codec || 'hevc'), '-movflags', '+faststart', mp4];
    const attempts = lead ? [['-i', mkv, '-ss', lead.toFixed(3), '-i', mkv, '-map', '0:v', '-map', '1:a?', '-map_metadata', '0'], ['-i', mkv, '-map', '0']] : [['-i', mkv, '-map', '0']];
    const limit = 120000 + fs.statSync(mkv).size / 5e4;   // 2 min + 20 s a GB (a copy runs far faster; a long recording is not cut off)
    for (const a of attempts) {
      try { fs.unlinkSync(mp4); } catch { }
      const p = runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', ...a, ...tail_], 'remux', false);
      const code = await Promise.race([p.exited, sleep(limit).then(() => 'timeout')]);
      if (code === 0 && fs.existsSync(mp4) && fs.statSync(mp4).size > 1024) { try { fs.unlinkSync(mkv); } catch { } return { file: mp4, audioTrimmed: lead || 0 }; }
      try { p.kill(); } catch { }
      await Promise.race([p.exited, sleep(5000)]);         // the mp4 is locked until it is gone
    }
    return { file: mkv, error: 'kept as .mkv (remux failed)' };
  }

  // ----- recording -----
  async function start(o = {}) {
    if (disposed) throw new Error('disposed');
    if (recJob || stopping) throw new Error('already recording');
    const outDir = o.outDir || path.join(os.homedir(), 'Videos');
    fs.mkdirSync(outDir, { recursive: true });
    const file = uniquePath(outDir, pre() + '_' + stamp(), '.mkv');
    recJob = { starting: true, started: Date.now(), output: file, feeders: [] };   // placeholder so a second start is refused
    busyOut.add(file);
    checkDisk(outDir, 'recording', true);
    let job;
    try { job = await startJob('rec', o, [file], file); }
    catch (e) { recJob = null; busyOut.delete(file); emitState(); throw e; }
    job.started = Date.now();
    recJob = job;
    startLevels(); startDiskWatch(outDir);
    job.proc.exited.then(async () => {                   // ffmpeg ended by itself (not through stop())
      if (recJob !== job) return;
      recJob = null; stopDiskWatch(); cleanupJob(job); emitState();
      let r; try { r = await remux(job.output); } finally { busyOut.delete(job.output); }
      ee.emit('saved', { kind: 'rec', file: r.file, error: r.error || 'recording stopped (ffmpeg exited)' });
    });
    emitState();
    return { file };
  }
  async function stop() {
    if (stopping) return stopping;
    const job = recJob;
    if (!job || job.starting) return { file: null, error: 'not recording' };
    recJob = null; stopDiskWatch(); emitState();
    stopping = (async () => {
      try { await endJob(job); return await remux(job.output); }
      finally { stopping = null; busyOut.delete(job.output); }
    })();
    return stopping;
  }

  // ----- replay ring -----
  const ringCount = sec => Math.ceil(sec / 2) + 3;
  // one change at a time, in order: quick clicks on the length box never start a second ring ffmpeg, and the last call wins
  let replayQ = Promise.resolve();
  function setReplay(on, sec, o) { const r = replayQ.then(() => setReplayNow(on, sec, o)); replayQ = r.catch(() => { }); return r; }
  async function setReplayNow(on, sec, o) {
    if (disposed) throw new Error('disposed');
    if (sec) replaySec = Math.max(4, Math.min(1800, Math.round(sec)));
    if (!on) {
      const j = replayJob; replayJob = null; replayOpts = null; emitState();
      if (j) { await endJob(j); }
      try { for (const f of fs.readdirSync(replayDir())) if (/^seg\d+\.ts$/.test(f)) fs.unlinkSync(path.join(replayDir(), f)); } catch { }
      return state();
    }
    if (o) replayOpts = o;
    if (!replayOpts) replayOpts = { source: 'screen', mic: true, system: true };
    const sameOpts = (a, b) => JSON.stringify({ ...a, outDir: 0 }) === JSON.stringify({ ...b, outDir: 0 });   // outDir is only for the disk check
    if (replayJob) {                                      // running: restart only if length or source changed
      const same = replayJob.sec === replaySec && sameOpts(replayJob.opts, replayOpts);
      if (same) return state();
      const j = replayJob; replayJob = null; await endJob(j);
    }
    fs.mkdirSync(replayDir(), { recursive: true });
    for (const f of fs.readdirSync(replayDir())) if (/^seg\d+\.ts$/.test(f)) { try { fs.unlinkSync(path.join(replayDir(), f)); } catch { } }
    checkDisk(replayOpts.outDir, 'replay', true);
    const sec0 = replaySec;
    const job = await startJob('replay', replayOpts,
      ['-f', 'segment', '-segment_time', '2', '-segment_format', 'mpegts', '-segment_wrap', String(ringCount(sec0)), '-reset_timestamps', '0', path.join(replayDir(), 'seg%03d.ts')], null);
    job.sec = sec0;
    replayJob = job; startLevels();
    job.proc.exited.then(() => {
      if (replayJob !== job) return;
      replayJob = null; cleanupJob(job); emitState(); emitErr('replay', 'replay buffer stopped (ffmpeg exited)');
    });
    emitState();
    return state();
  }
  async function saveReplay(outDir) {
    if (!replayJob) throw new Error('replay buffer is off');
    const sec = replayJob.sec, ropts = replayJob.opts;
    outDir = outDir || path.join(os.homedir(), 'Videos');
    fs.mkdirSync(outDir, { recursive: true });
    const dir = replayDir();
    let segs = fs.readdirSync(dir).filter(f => /^seg\d+\.ts$/.test(f)).map(f => ({ f, st: fs.statSync(path.join(dir, f)) }))
      .filter(x => x.st.size > 0).sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
    const take = Math.max(1, Math.floor((sec - 1) / 2)) + 1;       // whole 2 s segments plus the one being written
    if (segs.length > take) segs = segs.slice(segs.length - take);
    if (!segs.length) throw new Error('buffer still empty');
    // copy first: ffmpeg keeps rewriting the ring while we read
    // (async, own folder per save: a long ring never freezes the app, and two quick saves do not share files)
    const tmp = path.join(dir, 'save' + Date.now() + '_' + (++seq)); fs.mkdirSync(tmp, { recursive: true });
    let list = '';
    try {
      for (let i = 0; i < segs.length; i++) {
        const c = path.join(tmp, 'p' + String(i).padStart(3, '0') + '.ts');
        await fs.promises.copyFile(path.join(dir, segs[i].f), c);
        list += `file '${c.replace(/\\/g, '/')}'\n`;
      }
    } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
    const lf = path.join(tmp, 'list.txt'); fs.writeFileSync(lf, list);
    const out = uniquePath(outDir, pre() + '_replay_' + stamp(), '.mp4');
    const names = []; [ropts.system && 'System', ropts.mic && 'Mic'].filter(Boolean).forEach((nm, i) => names.push(`-metadata:s:a:${i}`, `title=${nm}`, `-metadata:s:a:${i}`, `handler_name=${nm}`));
    const p = runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lf, '-map', '0', '-c', 'copy', ...tagFor(replayCodec), ...names, '-movflags', '+faststart', out], 'replaysave', false);
    const code = await Promise.race([p.exited, sleep(120000).then(() => 'timeout')]);
    if (code === 'timeout') { try { p.kill(); } catch { } await Promise.race([p.exited, sleep(5000)]); }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
    if (code !== 0 || !fs.existsSync(out)) { throw new Error('replay save failed: ' + tail(logPath('replaysave'), 300)); }
    return { file: out, sec };
  }

  // ----- recovery at start -----
  // A <prefix>_*.mkv left by a crash (no .mp4 beside it, not being written, untouched for 30 s) is turned into .mp4 one by one in the background.
  let recovering = null;
  function recover(dir, minAgeMs = 30000) {
    if (disposed) return Promise.resolve([]);
    if (recovering) return recovering;
    recovering = (async () => {
      const done = [];
      let names = []; try { names = await fs.promises.readdir(dir); } catch { return done; }
      for (const n of names) {
        if (disposed) break;
        if (!n.toLowerCase().startsWith(pre().toLowerCase() + '_') || !/\.mkv$/i.test(n)) continue;
        const mkv = path.join(dir, n), mp4 = mkv.replace(/\.mkv$/i, '.mp4');
        if (busyOut.has(mkv) || (recJob && recJob.output === mkv)) continue;
        try {
          const st = await fs.promises.stat(mkv);
          if (!st.isFile() || st.size < 1024 || Date.now() - st.mtimeMs < minAgeMs || fs.existsSync(mp4)) continue;
        } catch { continue; }
        busyOut.add(mkv);
        try {
          const r = await remux(mkv);
          if (r.file && r.file !== mkv) { done.push({ file: r.file, from: mkv }); try { ee.emit('recovered', { file: r.file, from: mkv }); } catch { } }
          else emitErr('recover', `${n}: ${r.error || 'failed'}`);
        } catch (e) { emitErr('recover', e); }
        finally { busyOut.delete(mkv); }
      }
      return done;
    })().finally(() => { recovering = null; });
    return recovering;
  }
  // old replay pieces (seg*.ts) and half-made save folders (save*) from a run that died; only when the replay is not running
  function cleanReplay() {
    if (replayJob) return 0;
    let n = 0;
    try {
      for (const f of fs.readdirSync(replayDir())) {
        if (/^seg\d+\.ts$/.test(f) || /^save/.test(f)) { try { fs.rmSync(path.join(replayDir(), f), { recursive: true, force: true }); n++; } catch { } }
      }
    } catch { }
    return n;
  }

  // ----- screenshot -----
  async function screenshot(o = {}) {
    if (disposed) throw new Error('disposed');
    const outDir = o.outDir || path.join(os.homedir(), 'Pictures');
    fs.mkdirSync(outDir, { recursive: true });
    const file = uniquePath(outDir, pre() + '_' + stamp(), '.png');
    const source = o.source || 'screen';
    if (source === 'window') {
      if (!o.hwnd) throw new Error('window source needs hwnd');
      try { await ffmpegFrame(['-f', 'lavfi', '-i', `gfxcapture=hwnd=${Number(o.hwnd)}:max_framerate=10:capture_border=0:display_border=0`], file, 'hwdownload,format=bgra', 5000); }
      catch {                                              // a window that is not changing sends no frame: GDI grab by title
        const w = (await listWindows()).find(x => x.hwnd === Number(o.hwnd)); if (!w) throw new Error('window not found');
        await ffmpegFrame(['-f', 'gdigrab', '-framerate', '10', '-i', 'title=' + w.title], file, null, 8000);
      }
      return { file };
    }
    // the display: given, else (region) the one holding the box, else the one under the mouse (as the old bar did)
    let d;
    if (source === 'region') {
      const r = o.region; if (!r || !(r.w >= 1) || !(r.h >= 1)) throw new Error('region missing');
      d = allDisplays().find(x => { const b = physBounds(x); return r.x >= b.x && r.x < b.x + b.width && r.y >= b.y && r.y < b.y + b.height; }) || pickDisplay(o.display);
    } else d = o.display != null ? pickDisplay(o.display) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const b = physBounds(d);
    let img = null;
    try {
      const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: b.width, height: b.height } });
      const s = srcs.find(x => x.display_id === String(d.id)) || srcs[outputIdx(d)] || srcs[0];
      if (s && !s.thumbnail.isEmpty()) { const sz = s.thumbnail.getSize(); if (sz.width === b.width && sz.height === b.height) img = s.thumbnail; }
    } catch { /* fall through to ffmpeg */ }
    if (!img) {                                            // exact-size fallback: one ddagrab frame
      const tmpPng = path.join(tmpDir, `shot_${Date.now()}.png`);
      fs.mkdirSync(tmpDir, { recursive: true });
      await ffmpegFrame(['-f', 'lavfi', '-i', `ddagrab=output_idx=${outputIdx(d)}:framerate=10`], tmpPng, 'hwdownload,format=bgra');
      const { nativeImage } = require('electron');
      img = nativeImage.createFromPath(tmpPng); try { fs.unlinkSync(tmpPng); } catch { }
    }
    if (source === 'region') {
      const r = o.region;
      const x = Math.max(0, r.x - b.x), y = Math.max(0, r.y - b.y);
      img = img.crop({ x, y, width: Math.min(r.w, b.width - x), height: Math.min(r.h, b.height - y) });
    }
    fs.writeFileSync(file, img.toPNG());
    return { file };
  }
  async function ffmpegFrame(input, outFile, vf, limitMs = 20000) {
    const p = runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', ...input, ...(vf ? ['-vf', vf] : []), '-frames:v', '1', outFile], 'shot', false);
    const code = await Promise.race([p.exited, sleep(limitMs).then(() => 'timeout')]);
    if (code !== 0 || !fs.existsSync(outFile)) { try { p.kill(); } catch { } throw new Error('screenshot failed: ' + tail(logPath('shot'), 300)); }
  }

  // ----- region picker: a dimmed window on every display; the first drag wins -----
  let picker = null;
  function pickRegion(probe = false) {   // probe: windows stay hidden; true = just load, {drag:{x1,y1,x2,y2}} = also drag a box with injected mouse events
    if (disposed) return Promise.resolve(null);
    if (picker) return picker.promise;
    const wins = []; let finished = false, timer = null, resolve;
    const promise = new Promise(r => { resolve = r; });
    const finish = v => {
      if (finished) return; finished = true; clearTimeout(timer);
      ipcMain.removeListener(ch('region'), onRegion);
      for (const w of wins) { try { if (!w.isDestroyed()) w.destroy(); } catch { } }
      picker = null; resolve(v);
    };
    const onRegion = (e, rect) => {
      const w = wins.find(x => !x.isDestroyed() && x.webContents === e.sender); if (!w) return;
      if (!rect) return finish(null);
      const d = w._display;
      const p = screen.dipToScreenRect(w, { x: d.bounds.x + rect.x, y: d.bounds.y + rect.y, width: rect.w, height: rect.h });
      finish({ x: p.x, y: p.y, w: p.width, h: p.height });
    };
    ipcMain.on(ch('region'), onRegion);
    let loaded = 0;
    for (const d of allDisplays()) {
      const w = new BrowserWindow({
        x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, show: false, frame: false, transparent: true, hasShadow: false,
        resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, fullscreenable: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
      });
      w._display = d; wins.push(w);
      w.setAlwaysOnTop(true, 'screen-saver');
      w.webContents.once('did-finish-load', () => {
        loaded++;
        if (probe) {
          if (loaded !== wins.length) return;
          if (!probe.drag) return finish(true);
          const wc = wins[0].webContents, g = probe.drag, ev = (type, x, y) => wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
          ev('mouseDown', g.x1, g.y1); ev('mouseMove', (g.x1 + g.x2) >> 1, (g.y1 + g.y2) >> 1); ev('mouseMove', g.x2, g.y2); ev('mouseUp', g.x2, g.y2);
          return;
        }
        w.setBounds(d.bounds); w.show(); w.focus();
      });
      w.loadFile(path.join(__dirname, 'renderer', 'region.html'), { query: { i: String(inst) } });
    }
    timer = setTimeout(() => finish(probe ? false : null), probe ? 15000 : 120000);
    picker = { promise };
    return promise;
  }

  // ----- windows (for the source menu) -----
  async function listWindows() {
    let srcs = [];
    try { srcs = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }); } catch { }
    const exes = await new Promise(res => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { "$($_.MainWindowHandle)|$($_.ProcessName).exe" }'],
        { windowsHide: true, timeout: 8000 }, (err, out) => res(err ? '' : String(out)));
    });
    const map = new Map();
    for (const line of exes.split(/\r?\n/)) { const [h, e] = line.split('|'); if (h && e) map.set(h.trim(), e.trim()); }
    const mine = new Set(BrowserWindow.getAllWindows().filter(w => w._display || w === capWin).map(w => { try { return String(w.getNativeWindowHandle().readUIntLE(0, 6)); } catch { return ''; } }));
    const out = [];
    for (const s of srcs) {
      const m = /^window:(\d+):/.exec(s.id); if (!m || !s.name || mine.has(m[1])) continue;
      out.push({ hwnd: Number(m[1]), title: s.name, exe: map.get(m[1]) || '' });
    }
    return out;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(capCloseTimer); stopLevels(); stopDiskWatch();
    for (const j of [recJob, replayJob]) if (j && j.proc) { try { j.proc.stdin.write('q'); } catch { } setTimeout(() => { try { j.proc.kill(); } catch { } }, 1500); cleanupJob(j); }
    recJob = replayJob = null;
    ipcMain.removeListener(ch('pcm'), onPcm); ipcMain.removeListener(ch('caperr'), onCapErr);
    if (capWin && !capWin.isDestroyed()) capWin.destroy();
    capWin = null;
    if (picker) { try { for (const w of BrowserWindow.getAllWindows()) if (w._display) w.destroy(); } catch { } picker = null; }
  }

  Object.assign(ee, {
    start, stop, setReplay, saveReplay, screenshot, pickRegion: () => pickRegion(false), listWindows, dispose,
    recover, cleanReplay, state, _probePicker: drag => pickRegion(drag ? { drag } : true),
    get _ffmpeg() { return ffmpegOf(); }, _tmpDir: tmpDir, _encoder: encoder
  });
  return ee;
}

module.exports = { create };
