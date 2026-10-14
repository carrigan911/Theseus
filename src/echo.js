// Echo (Echo_Spec): the Amazon Echo speaks Theseus's alerts through Voice Monkey, and "Alexa, ask Theseus ..." answers from
// the sessions. Replaces EchoStatus's hook, announce.py and skill_server.py. Lines are rendered in Theseus's voice (Kokoro ->
// wav -> ffmpeg mp3 48 kbps 16 kHz mono) and served once on a random path under /alexa/a/ (Tailscale Funnel gives the public
// https address); when the audio isn't ready in time the text goes instead, in Alexa's voice.
//   const echo = require('./echo').create({ log, dataDir, settings: () => s, token: () => str, echoDir: () => dir, ffmpeg: () => exe,
//     night: () => bool, whoNeeds: () => line, whatIs: name => line | null, name: () => 'Theseus' })
//   echo.announce(kind, sessionId, title) -> Promise<result>   kind: waiting / permission / finished / stuck
//   echo.test() -> Promise<result>;  echo.start() / echo.stop();  echo.funnel() -> Promise<{ ok, host, why }>;  echo.status()
// SPHERE_ECHO_DRY=1: nothing goes to Voice Monkey, the request is logged (token hidden).
// SPHERE_ECHO_TEST_CERT=<pem>: the skill's cert chain is read from this file (its last cert is trusted), not fetched.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = 8787;                 // EchoStatus's port: an existing `tailscale funnel 8787` keeps working
const DEBOUNCE = 20000;            // one announcement per session every 20 s
const AUDIO_WAIT = 8000;           // announcement audio later than this: the text goes instead
const SKILL_WAIT = 6000;           // a skill answer must be back well inside Alexa's ~8 s
const KEEP = 10 * 60000;           // served audio paths live 10 minutes
const LINES = { waiting: t => `${t} has a question`, permission: t => `${t} needs permission`, finished: t => `${t} finished`, stuck: t => `${t} is stuck` };

// ---------- Alexa request check (a port of skill_server.py's verify, plus the chain to a trusted root) ----------
const pemBlocks = pem => String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
let sysRoots = null;
const rootsOf = () => sysRoots || (sysRoots = tls.rootCertificates.map(p => { try { return new crypto.X509Certificate(p); } catch { return null; } }).filter(Boolean));
function certUrlOk(u) {
  let x; try { x = new URL(u); } catch { return false; }   // URL() resolves /echo.api/../ before the path check
  return x.protocol === 'https:' && x.hostname.toLowerCase() === 's3.amazonaws.com' && x.pathname.startsWith('/echo.api/') && (x.port === '' || x.port === '443') && !x.search && !x.hash;   // (no query: one cache entry per cert)
}
const inDates = (c, now) => now >= Date.parse(c.validFrom) && now <= Date.parse(c.validTo);
// o: { skillId, now, roots: [X509Certificate], chain: url -> Promise<pem> }. Throws with the reason; resolves when good.
async function verify(headers, raw, body, o) {
  const now = o.now || Date.now();
  const ts = Date.parse(body && body.request && body.request.timestamp);
  if (!isFinite(ts) || Math.abs(now - ts) > 150000) throw new Error('stale timestamp');
  const app = (body.session && body.session.application) || (body.context && body.context.System && body.context.System.application) || {};
  if (!o.skillId || app.applicationId !== o.skillId) throw new Error('wrong skill id');
  const url = headers['signaturecertchainurl'] || '';
  if (!certUrlOk(url)) throw new Error('bad cert url');
  const certs = pemBlocks(await o.chain(url)).map(p => new crypto.X509Certificate(p));
  if (!certs.length) throw new Error('no cert');
  const leaf = certs[0];
  if (!certs.every(c => inDates(c, now))) throw new Error('cert expired');
  if (!String(leaf.subjectAltName || '').split(/,\s*/).includes('DNS:echo-api.amazon.com')) throw new Error('cert SAN');
  for (let i = 0; i + 1 < certs.length; i++) if (!certs[i].checkIssued(certs[i + 1]) || !certs[i].verify(certs[i + 1].publicKey)) throw new Error('cert chain');
  const top = certs[certs.length - 1], roots = o.roots || rootsOf();
  if (!roots.some(r => r.fingerprint256 === top.fingerprint256 || (top.checkIssued(r) && top.verify(r.publicKey)))) throw new Error('untrusted cert');
  const sig = Buffer.from(headers['signature-256'] || '', 'base64');
  if (!sig.length || !crypto.verify('sha256', raw, leaf.publicKey, sig)) throw new Error('bad signature');
}

const xml = s => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const reply = (speech, end = true) => ({ version: '1.0', response: { outputSpeech: speech, shouldEndSession: end } });
const plain = t => ({ type: 'PlainText', text: t });
const ssmlAudio = u => ({ type: 'SSML', ssml: `<speak><audio src="${xml(u)}"/></speak>` });
const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms).unref())]);
const sh = (exe, args, ms) => new Promise(res => execFile(exe, args, { windowsHide: true, timeout: ms }, (e, out, err) => res({ ok: !e, out: String(out || ''), err: String(err || e && e.message || '') })));

function create(o) {
  const log = m => o.log && o.log('echo: ' + m);
  const S = () => o.settings() || {};
  const dry = () => !!process.env.SPHERE_ECHO_DRY;
  const dir = path.join(o.dataDir, 'echo'), cacheDir = path.join(dir, 'cache');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
  const served = new Map();        // id -> { file, until, temp }
  const last = new Map();          // sessionId -> time of its last announcement
  const certCache = new Map();     // cert url -> { pem, at }
  let server = null, serverWhy = '', host = '', sweep = null;

  // ----- Theseus's voice as an mp3 (cached per line, voice and speed) -----
  const rendering = new Map();
  // fmt 'skill': Alexa's SSML audio (MPEG-2, 48 kbps, 16 kHz); 'vm': Voice Monkey's audio (44.1 kHz, its media docs)
  function mp3Of(text, fmt = 'skill') {
    const s = S(), ed = o.echoDir && o.echoDir(), ff = o.ffmpeg && o.ffmpeg();
    if (!ed || !ff) return Promise.resolve(null);
    const key = crypto.createHash('sha1').update(`${s.voice}|${s.voiceSpeed}|${text}${fmt === 'vm' ? '|vm' : ''}`).digest('hex').slice(0, 20);
    const out = path.join(cacheDir, key + '.mp3');
    try { if (fs.statSync(out).size > 0) { fs.utimes(out, new Date(), new Date(), () => {}); return Promise.resolve(out); } } catch {}
    if (rendering.has(key)) return rendering.get(key);
    const wav = path.join(dir, key + '.wav');
    const p = (async () => {
      const py = path.join(ed, 'voice', 'kokoro', 'venv', 'Scripts', 'python.exe');
      const r = await sh(py, [path.join(ed, 'kokoro_speak.py'), text, '--voice', s.voice || 'bm_lewis', '--speed', String(s.voiceSpeed || 1), '--out', wav], 30000);
      if (!r.ok) { log('kokoro failed: ' + r.err.slice(-160)); return null; }
      const f = await sh(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-ac', '1', '-ar', fmt === 'vm' ? '44100' : '16000', '-b:a', fmt === 'vm' ? '64k' : '48k', '-c:a', 'libmp3lame', out], 20000);
      fs.unlink(wav, () => {});
      if (!f.ok) { log('ffmpeg failed: ' + f.err.slice(-160)); fs.unlink(out, () => {}); return null; }
      trimCache();
      return out;
    })().finally(() => rendering.delete(key));
    rendering.set(key, p);
    return p;
  }
  function trimCache() {   // keep the 200 newest lines
    try {
      const l = fs.readdirSync(cacheDir).map(f => ({ f: path.join(cacheDir, f), t: fs.statSync(path.join(cacheDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const x of l.slice(200)) fs.unlink(x.f, () => {});
    } catch {}
  }
  // a short-lived public address for a cached mp3 (a copy, so the cache file never leaves through a guessable path)
  function serve(file) {
    if (!host || !server) return null;
    const id = crypto.randomBytes(12).toString('hex'), temp = path.join(dir, id + '.mp3');
    try { fs.copyFileSync(file, temp); } catch { return null; }
    served.set(id, { file: temp, until: Date.now() + KEEP });
    return `https://${host}/alexa/a/${id}.mp3`;
  }
  async function audioUrl(text, ms, fmt) { const f = await withTimeout(mp3Of(text, fmt), ms); return f ? serve(f) : null; }
  function sweepServed() {
    const now = Date.now();
    for (const [id, x] of served) if (now > x.until) { served.delete(id); fs.unlink(x.file, () => {}); }
  }

  // ----- Voice Monkey -----
  // API v3 (api-v3 /announce, the spoken text is `speech`) for accounts made since v3; accounts still on v2 answer v3 with
  // a token/user error, so v2 (api-v2 /announcement, `text`) is tried next and remembered while Theseus runs
  let vmV2 = false;
  const VM_USER = /INVALID_TOKEN|USER_NOT_FOUND|UNAUTHORIZED|user could not be retrieved/i;
  async function vmSend(q) {
    const s = S(), token = o.token ? o.token() : '';
    if (!token || !s.echoDevice) return { ok: false, why: 'Voice Monkey token or device not set' };
    if (!vmV2) {
      const v3 = { ...q }; if ('text' in v3) { v3.speech = v3.text; delete v3.text; }
      const r = await vmGet('https://api-v3.voicemonkey.io/announce?' + new URLSearchParams({ token, device: s.echoDevice, ...v3 }), token);
      if (r.ok || r.dry || !VM_USER.test(r.why || '')) return r;
      const r2 = await vmGet('https://api-v2.voicemonkey.io/announcement?' + new URLSearchParams({ token, device: s.echoDevice, ...q }), token);
      if (r2.ok) { vmV2 = true; log('voice monkey: this account is on API v2'); return r2; }
      return { ...r, why: `${r.why} (v2: ${r2.why || r2.status})` };
    }
    return vmGet('https://api-v2.voicemonkey.io/announcement?' + new URLSearchParams({ token, device: s.echoDevice, ...q }), token);
  }
  function vmGet(url, token) {
    if (dry()) { log('dry ' + url.replace(encodeURIComponent(token), '***')); return Promise.resolve({ ok: true, dry: true, url: url.replace(encodeURIComponent(token), '***') }); }
    return new Promise(res => {
      const r = https.get(url, { timeout: 10000 }, x => {
        let body = ''; x.setEncoding('utf8'); x.on('data', d => { if (body.length < 400) body += d; });
        x.on('end', () => {
          const ok = x.statusCode >= 200 && x.statusCode < 300 && !/"success"\s*:\s*false/.test(body);
          if (!ok) log(`voice monkey ${x.statusCode}: ${body.replace(/\s+/g, ' ').slice(0, 200).split(token).join('***')}`);
          res({ ok, status: x.statusCode, why: ok ? undefined : body.slice(0, 120).split(token).join('***') || undefined });
        });
      });
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.on('error', e => res({ ok: false, why: e.message }));
    });
  }
  async function say(text) {
    text = require('./spoken').spoken(text);
    const u = await audioUrl(text, AUDIO_WAIT, 'vm');
    if (u) { const r = await vmSend({ audio: u }); if (r.ok) return { ...r, text, audio: true }; log('audio send failed, text instead'); }
    return { ...(await vmSend({ text })), text, audio: false };
  }

  // kind: waiting / permission / finished / stuck. Resolves with what happened (tests read it).
  async function announce(kind, sessionId, title) {
    const s = S(), ev = s.echoEvents || {};
    if (!s.echoOn) return { skip: 'off' };
    if (!LINES[kind] || !ev[kind]) return { skip: 'not ticked' };
    if (s.echoNightQuiet && o.night && o.night()) return { skip: 'night' };
    const now = Date.now();
    if (now - (last.get(sessionId) || 0) < DEBOUNCE) return { skip: 'debounced' };
    last.set(sessionId, now);
    for (const [id, t] of last) if (now - t > DEBOUNCE) last.delete(id);
    const r = await say(LINES[kind](title));
    log(`${kind} ${title}: ${r.ok ? (r.audio ? 'audio' : 'text') : 'failed ' + (r.why || r.status)}`);
    return r;
  }
  const test = () => say(`This is ${o.name ? o.name() : 'Theseus'} on your Echo.`);

  // ----- the skill -----
  async function answer(body) {
    const req = body.request || {}, t = req.type, intent = req.intent || {};
    if (t === 'SessionEndedRequest') return { version: '1.0', response: {} };
    let text, end = true;
    if (t === 'LaunchRequest' || (t === 'IntentRequest' && intent.name === 'StatusIntent')) text = o.whoNeeds();
    else if (t === 'IntentRequest' && intent.name === 'SessionIntent') {
      const n = ((intent.slots || {}).session || {}).value || '';
      text = (n && o.whatIs(n)) || (n ? `I can't find a session called ${n}.` : 'Which session?');
    } else if (t === 'IntentRequest' && ['AMAZON.StopIntent', 'AMAZON.CancelIntent'].includes(intent.name)) text = 'Okay.';
    else if (t === 'IntentRequest' && intent.name === 'AMAZON.HelpIntent') { text = 'Ask me who needs you, or what a session is doing.'; end = false; }
    else text = 'Sorry, I can only say who needs you, or what a session is doing.';
    const u = await audioUrl(text, SKILL_WAIT);
    return reply(u ? ssmlAudio(u) : plain(text), end);
  }
  function chainOf(url) {
    if (process.env.SPHERE_ECHO_TEST_CERT) return Promise.resolve(fs.readFileSync(process.env.SPHERE_ECHO_TEST_CERT, 'utf8'));
    const c = certCache.get(url); if (c && Date.now() - c.at < 864e5) return Promise.resolve(c.pem);   // a day: a renewed chain is fetched again
    return new Promise((res, rej) => {
      const r = https.get(url, { timeout: 10000 }, x => {
        if (x.statusCode !== 200) { x.resume(); return rej(new Error('cert fetch ' + x.statusCode)); }
        let b = ''; x.setEncoding('utf8'); x.on('data', d => { b += d; if (b.length > 65536) r.destroy(new Error('cert too big')); });
        x.on('end', () => { certCache.delete(url); certCache.set(url, { pem: b, at: Date.now() }); if (certCache.size > 8) certCache.delete(certCache.keys().next().value); res(b); });
      });
      r.on('timeout', () => r.destroy(new Error('cert fetch timeout')));
      r.on('error', rej);
    });
  }
  function testRoots() {
    const f = process.env.SPHERE_ECHO_TEST_CERT; if (!f) return null;
    const l = pemBlocks(fs.readFileSync(f, 'utf8')); return [new crypto.X509Certificate(l[l.length - 1])];
  }
  const send = (res, code, type, data) => { res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(data) }); res.end(data); };
  function onRequest(req, res) {
    const p = (req.url || '').split('?')[0];
    let m;
    // HEAD too: Voice Monkey checks an audio link with HEAD before it plays it (a 404 there and it never fetches); Range for players
    if ((req.method === 'GET' || req.method === 'HEAD') && (m = p.match(/^\/alexa\/a\/([0-9a-f]{24})\.mp3$/))) {
      const x = served.get(m[1]);
      log(`audio ${req.method}${req.headers.range ? ' ' + req.headers.range : ''}: ${m[1].slice(0, 6)} ${!x ? 'unknown' : Date.now() > x.until ? 'expired' : 'ok'} (${String(req.headers['user-agent'] || '?').slice(0, 60)})`);
      if (!x || Date.now() > x.until) return send(res, 404, 'text/plain', 'not found');
      return fs.readFile(x.file, (e, d) => {
        if (e) return send(res, 404, 'text/plain', 'not found');
        const h = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=600' };
        const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        let a = 0, b = d.length - 1, code = 200;
        if (r && (r[1] || r[2])) {
          if (r[1]) { a = +r[1]; if (r[2]) b = Math.min(+r[2], b); } else a = Math.max(0, d.length - +r[2]);
          if (a > b) { res.writeHead(416, { 'Content-Range': `bytes */${d.length}` }); return res.end(); }
          code = 206; h['Content-Range'] = `bytes ${a}-${b}/${d.length}`;
        }
        h['Content-Length'] = b - a + 1; res.writeHead(code, h);
        res.end(req.method === 'HEAD' ? undefined : d.subarray(a, b + 1));
      });
    }
    if (req.method !== 'POST' || !/^\/alexa\/?$/.test(p)) { log(`not served: ${req.method} ${p.slice(0, 80)}`); return send(res, 404, 'text/plain', 'not found'); }
    const parts = []; let n = 0;
    req.on('data', d => { n += d.length; if (n > 65536) req.destroy(); else parts.push(d); });
    req.on('end', async () => {
      const raw = Buffer.concat(parts);
      try {
        const body = JSON.parse(raw.toString('utf8'));
        await verify(req.headers, raw, body, { skillId: S().echoSkillId, chain: chainOf, roots: testRoots() || undefined });
        const rq = body.request || {};
        log(`asked: ${rq.type || '?'}${rq.intent ? ' ' + rq.intent.name : ''}`);
        send(res, 200, 'application/json;charset=UTF-8', JSON.stringify(await answer(body)));
      } catch (e) { log('refused: ' + (e && e.message)); send(res, 400, 'application/json', JSON.stringify({ error: String(e && e.message || e) })); }
    });
  }
  function start() {
    if (server) return;
    server = http.createServer(onRequest); serverWhy = '';
    server.on('error', e => {
      serverWhy = e.code === 'EADDRINUSE' ? `port ${PORT} is in use (the old skill_server.py?)` : e.message;
      log('server: ' + serverWhy); server = null;
    });
    server.listen(o.port || PORT, '127.0.0.1');
    if (!sweep) { sweep = setInterval(sweepServed, 60000); sweep.unref(); }
  }
  function stop() {
    if (server) { server.close(); server = null; }
    if (sweep) { clearInterval(sweep); sweep = null; }
    for (const x of served.values()) fs.unlink(x.file, () => {});
    served.clear();
  }

  // ----- Tailscale Funnel: the public https name, and /alexa routed to this server (an existing 8787 funnel is kept) -----
  async function funnel() {
    const ts = 'tailscale';
    const st = await sh(ts, ['status', '--json'], 10000);
    if (!st.ok) return { ok: false, why: 'Tailscale is not installed or not running' };
    let j; try { j = JSON.parse(st.out); } catch { return { ok: false, why: 'Tailscale status unreadable' }; }
    if (j.BackendState !== 'Running') return { ok: false, why: 'Tailscale is signed out' };
    host = String((j.Self && j.Self.DNSName) || '').replace(/\.$/, '');
    if (!host) return { ok: false, why: 'Tailscale has no MagicDNS name' };
    const cur = await sh(ts, ['funnel', 'status', '--json'], 10000);
    if (cur.ok && new RegExp(`127\\.0\\.0\\.1:${PORT}|localhost:${PORT}`).test(cur.out) && /AllowFunnel/.test(cur.out)) return { ok: true, host, kept: true };
    const r = await sh(ts, ['funnel', '--bg', '--set-path', '/alexa', `http://127.0.0.1:${PORT}/alexa`], 20000);
    return r.ok ? { ok: true, host } : { ok: false, host, why: r.err.trim().slice(0, 200) || 'funnel failed' };
  }

  return {
    announce, test, start, stop, funnel,
    status: () => ({ listening: !!server, why: serverWhy, host, skillUrl: host ? `https://${host}/alexa` : '' }),
    setHost: h => { host = h || ''; },
    _answer: answer, _mp3Of: mp3Of, _served: served, _onRequest: onRequest,
  };
}

module.exports = { create, verify, certUrlOk, LINES };
