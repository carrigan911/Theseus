// The sphere's MCP server (stdio, JSON-RPC lines). It only forwards: each tool call goes to the running app over 127.0.0.1, which
// owns the actions and their confirmations (main.js, "The sphere's tools"). Two ways it is started:
//   by Voice Ask's Claude Code call: SPHERE_ACT = the app's address, SPHERE_ACT_TOKEN = that question's token (the Ask tools)
//   by the user's own sessions (registered with Claude Code): SPHERE_BRIDGE_FILE = the app's bridge.json { url, token }, read
//   at each call (the app may start or restart later); the session tools, listed even while the app is not running.
// The calling session is told by CLAUDE_CODE_SESSION_ID / CLAUDE_CODE_HOST_SESSION_ID, which Claude Code sets for its servers.
// Run as: electron.exe (ELECTRON_RUN_AS_NODE=1) mcp_sphere.js
const fs = require('fs'), http = require('http');
const defs = require('./tooldefs');

const ASK = !!process.env.SPHERE_ACT;
function bridge() {
  if (ASK) return { url: process.env.SPHERE_ACT, token: process.env.SPHERE_ACT_TOKEN || '' };
  try { const b = JSON.parse(fs.readFileSync(process.env.SPHERE_BRIDGE_FILE || '', 'utf8')); if (b && b.url && b.token) return b; } catch {}
  return null;
}

function call(route, body) {
  return new Promise((res, rej) => {
    const b = bridge(); if (!b) return rej(new Error('Theseus is not running'));
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'x-sphere-token': b.token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
      'x-sphere-session': process.env.CLAUDE_CODE_SESSION_ID || '', 'x-sphere-host': process.env.CLAUDE_CODE_HOST_SESSION_ID || '',
      'x-sphere-cwd': encodeURIComponent(process.cwd()) };
    const rq = http.request(new URL(route, b.url), { method: body ? 'POST' : 'GET', headers, timeout: 30000 }, r => {
      let s = ''; r.setEncoding('utf8'); r.on('data', d => { s += d; });
      r.on('end', () => { try { const j = JSON.parse(s); r.statusCode === 200 ? res(j) : rej(new Error(j.error || 'HTTP ' + r.statusCode)); } catch { rej(new Error('bad reply from Theseus')); } });
    });
    rq.on('timeout', () => rq.destroy(new Error('Theseus did not answer')));
    rq.on('error', e => rej(e && e.code === 'ECONNREFUSED' ? new Error('Theseus is not running') : e));
    rq.end(data);
  });
}

const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(m) {
  const { id, method, params } = m;
  if (id === undefined || id === null) return;   // notifications (initialized, cancelled): nothing to say
  try {
    if (method === 'initialize') return reply(id, { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'theseus', version: '1.1.0' } });
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: ASK ? defs.ask : defs.session });
    if (method === 'tools/call') {
      try {
        const r = await call('/call', { name: params && params.name, arguments: (params && params.arguments) || {} });
        return reply(id, { content: [{ type: 'text', text: String(r.text || '') }], isError: !!r.isError });
      } catch (e) { return reply(id, { content: [{ type: 'text', text: e.message }], isError: true }); }
    }
    return fail(id, -32601, 'no such method: ' + method);
  } catch (e) { return fail(id, -32603, e.message); }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0;) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    handle(m);
  }
});
process.stdin.on('end', () => process.exit(0));
