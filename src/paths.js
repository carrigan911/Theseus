// Where things are (Docs/Specs/PublicVersion_Spec.md): every path is a setting; main hands the settings over at start and on
// each change (set). Env overrides win, for tests. An empty setting means "not set up": the add-on that needs it stays off.
const fs = require('fs');
const os = require('os');
const path = require('path');

let get = () => ({});   // the live settings (main passes a getter, so a change is seen at once)
const found = new Map();
// an exe on PATH's absolute folders (never the current folder), cached
function onPath(name) {
  if (found.has(name)) return found.get(name);
  let hit = '';
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d || !path.isAbsolute(d)) continue;
    const f = path.join(d, name);
    try { if (fs.statSync(f).isFile()) { hit = f; break; } } catch { try { if (fs.lstatSync(f).isSymbolicLink()) { hit = f; break; } } catch {} }   // an app alias (wt.exe in WindowsApps) only lstats
  }
  found.set(name, hit); return hit;
}
// an add-on switched off (settings.addons[k] === false) reads as not set up
const on = k => !(get().addons && get().addons[k] === false);
const P = {
  set(g) { get = typeof g === 'function' ? g : () => g || {}; },
  feed: () => process.env.SPHERE_FEED || (on('feed') && get().feedFile) || '',
  modeDir: () => (on('modes') && get().modeDir) || '',
  status: () => process.env.SPHERE_STATUS_FILE || (on('readout') && get().statusFile) || '',
  echo: () => (on('voice') && get().echoDir) || '',
  // the External voice's talking state, else the built-in voice's own folder
  voiceState: () => process.env.SPHERE_VOICE_DIR || (P.voiceExt() ? path.join(get().echoDir, 'state') : P.builtinVoice()),
  voiceExt: () => { const e = P.echo(); try { return !!e && fs.statSync(path.join(e, 'speak.ps1')).isFile(); } catch { return false; } },
  builtinVoice: () => path.join(os.tmpdir(), 'SessionSphere', 'voice'),
  whisperPy: () => process.env.SPHERE_WHISPER_PY || (on('whisper') && get().whisperPy) || '',
  // add-ons: each is on when not switched off and its file is there -> { k: { on, found } }
  addons() {
    const f = { modes: P.modeDir() && path.join(P.modeDir(), 'editor_limits.json'), readout: P.status(), feed: P.feed(),
      voice: P.echo() && path.join(P.echo(), 'speak.ps1'), whisper: P.whisperPy() };
    const raw = { modes: get().modeDir && path.join(get().modeDir, 'editor_limits.json'), readout: process.env.SPHERE_STATUS_FILE || get().statusFile,
      feed: process.env.SPHERE_FEED || get().feedFile, voice: get().echoDir && path.join(get().echoDir, 'speak.ps1'), whisper: process.env.SPHERE_WHISPER_PY || get().whisperPy };
    const is = x => { try { return !!x && fs.statSync(x).isFile(); } catch { return false; } };
    return Object.fromEntries(Object.keys(f).map(k => [k, { on: is(f[k]), found: is(raw[k]) }]));
  },
  ffmpeg: () => get().ffmpeg || onPath('ffmpeg.exe'),
  readerDays: () => Math.max(1, Math.min(60, Number(get().readerDays) || 7)),
  transcripts: () => get().transcriptsRoot || path.join(os.homedir(), '.claude', 'projects'),
  recDir: () => get().recDir || path.join(os.homedir(), 'Videos'),
  onPath,
};
module.exports = P;
