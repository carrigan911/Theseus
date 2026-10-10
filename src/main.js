// Theseus (Session Sphere) main process: transparent desktop-layer window on half a screen (or all of it), click-through outside the sphere.
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell, globalShortcut, dialog } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const feed = require('./feed');
const voice = require('./voice');
const claudeUi = require('./claudeui');
const thumbs = require('./thumbs');
const T = require('./theseus');
const P = require('./paths');
// App control (PublicVersion_Spec): the commands that act in the Claude app for you run only when it is on; reading
// (state, snap, peek, artifacts, routines) and showing the app as a card stay available
const APP_ACTS = new Set(['send', 'newsession', 'answer', 'permit', 'plan', 'set', 'manage', 'msgact', 'commands', 'attach', 'settings']);
{ const raw = claudeUi.send; claudeUi.send = (cmd, ms) => cmd && APP_ACTS.has(cmd.cmd) && !settings.appControl ? Promise.resolve({ ok: false, why: 'App control is off (General settings)' }) : raw(cmd, ms); }
let lastFeed = { sessions: [] };

if (process.env.SPHERE_USERDATA) app.setPath('userData', process.env.SPHERE_USERDATA);   // tests: own settings + lock, so a test instance runs beside the real one
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const defaults = {
  side: 'left', display: 'primary', glow: '#3da5ff',
  fps: 30, renderScale: 1.5, labelRes: 1024,                 // frame cap (0 = display rate), supersampling, label pixels
  closeDelay: 3, spinMinutes: 2, idleGlow: 0.3,             // fold-back delay (s), one turn every N min (0 = still), idle core
  autoFold: true, keepCardsOpen: true, tileActivity: true, contextRing: true, speechCaption: true, voiceAsk: true, askWeb: true, askSpeak: true, claudeTray: false, tileWear: 0, tileSwap: 6, tileWearPreview: false, tileSwapPreview: false,   // tile rows fold back after the delay; an open card or menu stays until closed; working / waiting / idle looks
  glowOnSpeech: true, voice: 'bm_lewis', voiceSpeed: 1.0, voiceCycle: false, voiceCycleList: [], voiceCycleMgr: '',   // talking glow; EchoStatus default voice (stateoice.json)
  autostart: false,
  sphereSize: 'medium', sphereGrowth: true, emptySpots: 'tiles', rowTileSize: 'large',   // small / medium / large / xlarge; growth: the sphere grows with the session count
  tileAlign: 'center', flatShape: 'regular',                // flat rows: tiles keep their corner count, or all hexagons                                      // flat rows: left / center / right
  coreFollowsMode: true,                                    // core takes the current Theseus mode's colour (normal = glow)
  modeColors: { worker: '#e67e22', night: '#3c60be', weekend: '#8c50b9', performance: '#dc3c3c', efficiency: '#2ecc71' },
  modeMotion: true, spikeStrength: 0.6,                    // the mode also sets the core's speed (x normal); Max perf adds spikes
  modeSpeed: { worker: 1.8, night: 0.45, weekend: 0.6, performance: 3, efficiency: 0.8 },
  modeBright: { worker: 1.3, night: 0.7, weekend: 0.8, performance: 1.7, efficiency: 1 },   // core brightness x normal
  tilesSphere: { mgr: true, active: true, parked: true, ungrouped: true, archived: false },   // which groups show on the sphere / in the spread rows
  tilesRows: { mgr: true, active: true, parked: true, ungrouped: true, archived: false },
  // Theseus tools: audio cycles (device ids), strip, system readout, voice commands, recording
  outCycle: [], micCycle: [], strip: true, stripPos: null, sysReadout: false, sysAlerts: false, sysSpeak: false, voiceCmd: 'off', hotkeys: true,
  bgStyle: 'none', bgOpacity: 85, bgAlways: false,           // background (Backgrounds_Spec): style, opacity %, live wallpaper
  // paths (PublicVersion_Spec): empty = not set up (an add-on stays off; recordings go to Videos, ffmpeg is looked up on PATH)
  addons: { modes: true, readout: true, feed: true, voice: true, whisper: true },   // add-on switches (each also needs its file)
  readerDays: 7,                                             // the built-in session reader: sessions changed within this many days
  feedFile: '', modeDir: '', statusFile: '', echoDir: '', whisperPy: '', ffmpeg: '', transcriptsRoot: '', pathsVersion: 0,
  name: 'Theseus', recPrefix: '', appControl: false, appNoticeSeen: false, setupDone: false,
  editor: 'system', editorCmd: '',                          // Files tab (Bridge_Spec): system default / vscode / custom command with {file} {line}
  recDir: '', replay: false, replaySec: 60, recSource: 'screen', recRegion: null, recMic: true, recSystem: true,
};
let settings = { ...defaults }, win, tray, settingsWin, frontOn = false, occluded = false;
// the assistant's name (PublicVersion_Spec): titles, tray, spoken lines, the wake word; its words at the start of a question
const NAME = () => settings.name || 'Theseus';
const wakeRe = () => {
  const n = NAME(), alt = n === 'Theseus' ? 'theseus|thesis|these us|theseas' : n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp('^\\s*(hey\\s+)?(' + alt + ')\\b[\\s,.!?:-]*', 'i');
};
const zorder = claudeUi.create({ lite: true });   // z-order + cover checks: no UI Automation, starts fast; claudeUi's own helper does the slow reads

// settings checks: a known key keeps only a valid value (numbers are clamped); other keys pass if they are plain scalars
const nm = (lo, hi) => v => typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;
const bl = v => typeof v === 'boolean' ? v : undefined;
const en = (...a) => v => a.includes(v) ? v : undefined;
const col = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined;
const IDS = v => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length > 0 && x.length <= 200).slice(0, 60) : undefined;
const PATH = v => typeof v === 'string' && /^([a-z]:[\\/]|\\\\)/i.test(v) && v.length <= 260 &&v.length <= 260 && !/[<>"|?*\x00-\x1f]/.test(v.replace(/^[a-z]:/i, '')) ? v : undefined;
const PATHE = v => v === '' ? '' : PATH(v);   // a path setting that may be empty (not set up)
const POS = v => v === null ? null : v && typeof v === 'object' && [v.x, v.y].every(n => typeof n === 'number' && isFinite(n)) ? { x: Math.round(Math.min(1e5, Math.max(-1e5, v.x))), y: Math.round(Math.min(1e5, Math.max(-1e5, v.y))) } : undefined;
const REGION = v => v === null ? null : v && typeof v === 'object' && ['x', 'y', 'w', 'h'].every(k => typeof v[k] === 'number' && isFinite(v[k]) && Math.abs(v[k]) < 1e5) && v.w >= 32 && v.h >= 32 ? { x: Math.round(v.x), y: Math.round(v.y), w: Math.round(v.w), h: Math.round(v.h) } : undefined;
const VOICE = v => typeof v === 'string' && /^[a-z]{2}_[a-z0-9_]{1,30}$/i.test(v) ? v : undefined;
const RULES = {
  side: en('left', 'right', 'full'), display: v => typeof v === 'string' && v.length <= 40 ? v : typeof v === 'number' && isFinite(v) ? String(v) : undefined,
  glow: col, fps: nm(0, 240), renderScale: nm(0.5, 4), labelRes: v => { v = nm(256, 4096)(v); return v === undefined ? v : Math.round(v); },
  closeDelay: nm(0, 60), spinMinutes: nm(0, 120), idleGlow: nm(0, 1), autoFold: bl, keepCardsOpen: bl, claudeTray: bl, tileActivity: bl, contextRing: bl, speechCaption: bl, voiceAsk: bl, askWeb: bl, askSpeak: bl, tileWear: v => { v = nm(0, 12)(v); return v === undefined ? v : Math.round(v); }, tileSwap: en(1, 2, 3, 4, 5, 6), tileWearPreview: bl, tileSwapPreview: bl, glowOnSpeech: bl,
  voice: VOICE, voiceSpeed: nm(0.5, 2), voiceCycle: bl, voiceCycleList: v => Array.isArray(v) ? v.filter(x => VOICE(x)).slice(0, 80) : undefined,
  voiceCycleMgr: v => typeof v === 'string' && v.length <= 100 ? v : undefined, autostart: bl,
  sphereSize: en('small', 'medium', 'large', 'xlarge'), sphereGrowth: bl, emptySpots: en('tiles', 'open'), rowTileSize: en('large', 'medium', 'small'), tileAlign: en('left', 'center', 'right'), flatShape: en('regular', 'hexagon'), coreFollowsMode: bl, modeMotion: bl, spikeStrength: nm(0, 2),
  bgStyle: en('none', 'black', 'space', 'moving', 'gradient', 'travel'), bgOpacity: nm(0, 100), bgAlways: bl,
  outCycle: IDS, micCycle: IDS, strip: bl, stripPos: POS, sysReadout: bl, sysAlerts: bl, sysSpeak: bl, voiceCmd: en('off', 'ptt', 'wake', 'always'), hotkeys: bl,
  readerDays: nm(1, 60), recDir: PATHE, feedFile: PATHE, modeDir: PATHE, statusFile: PATHE, echoDir: PATHE, whisperPy: PATHE, ffmpeg: PATHE, transcriptsRoot: PATHE,
  name: v => typeof v === 'string' && /^\p{L}[\p{L}' -]{0,30}$/u.test(v.trim()) ? v.trim() : undefined, recPrefix: v => typeof v === 'string' && /^[\w-]{0,30}$/.test(v) ? v : undefined,
  appControl: bl, appNoticeSeen: bl, setupDone: bl, pathsVersion: nm(0, 99), editor: en('system', 'vscode', 'custom'), editorCmd: v => typeof v === 'string' && v.length <= 400 ? v : undefined,
  replay: bl, replaySec: v => { v = nm(10, 600)(v); return v === undefined ? v : Math.round(v); }, recSource: en('screen', 'region', 'window'), recRegion: REGION, recMic: bl, recSystem: bl,
};
const NESTED = { modeColors: col, modeSpeed: nm(0, 10), modeBright: nm(0, 5), tilesSphere: bl, tilesRows: bl, addons: bl };
function clean(p) {
  const o = {};
  if (!p || typeof p !== 'object') return o;
  for (const k of Object.keys(p)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const v = p[k];
    if (NESTED[k]) {
      if (!v || typeof v !== 'object') continue;
      o[k] = {}; for (const m of Object.keys(defaults[k])) { const x = NESTED[k](v[m]); if (x !== undefined) o[k][m] = x; }
    } else if (RULES[k]) { const x = RULES[k](v); if (x !== undefined) o[k] = x; }
    else if (typeof v === 'boolean' || (typeof v === 'number' && isFinite(v)) || (typeof v === 'string' && v.length <= 200)) o[k] = v;
  }
  return o;
}
const merge = (base, p) => ({ ...base, ...p, modeColors: { ...base.modeColors, ...p.modeColors }, modeSpeed: { ...base.modeSpeed, ...p.modeSpeed }, modeBright: { ...base.modeBright, ...p.modeBright },
  tilesSphere: { ...base.tilesSphere, ...p.tilesSphere }, tilesRows: { ...base.tilesRows, ...p.tilesRows }, addons: { ...base.addons, ...p.addons } });
function loadSettings() {
  P.set(() => settings);
  settings = null;
  for (const f of [settingsPath, settingsPath + '.bak']) {            // a damaged file falls back to the last good copy
    try { settings = merge(defaults, clean(JSON.parse(fs.readFileSync(f, 'utf8')))); break; } catch {}
  }
  if (!settings) settings = { ...defaults };
  // paths as settings (PublicVersion_Spec): a profile from before (or a new one) takes this PC's own setup from
  // personal.settings.json beside the app once; without that file (the public package) it starts as a fresh install
  if (!settings.pathsVersion) {
    let own = null;
    if (!process.env.SPHERE_NO_PERSONAL) try { own = clean(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'personal.settings.json'), 'utf8'))); } catch {}
    if (own) for (const [k, v] of Object.entries(own)) if (k !== '//' && (k !== 'recDir' || !settings.recDir)) settings[k] = v;
    settings.pathsVersion = 1; saveSettings();
  }
}
// voice cycle: each time Theseus is replaced the next ticked voice takes over. A replacement = a Session Manager id not among the
// last 5 manager ids seen, while the old one has left the feed. The first read after start only records the id.
let mgrHist = [], mgrBase = false;
function cycleVoice(f) {
  const m = !process.env.SPHERE_FEED && f.sessions.find(s => s.group === 'Session Manager');
  if (!m) return;
  const old = settings.voiceCycleMgr, id = m.sessionId;
  const seen = x => { mgrHist = [x, ...mgrHist.filter(y => y !== x)].slice(0, 5); };
  if (!mgrBase) { mgrBase = true; if (old) seen(old); seen(id); if (id !== old) { settings.voiceCycleMgr = id; saveSettings(); } return; }
  if (id === old) { seen(id); return; }
  const known = mgrHist.includes(id), oldGone = !old || !f.sessions.some(s => s.sessionId === old);
  if (!oldGone) return;                       // both listed: an order flip or a swap under way, wait for the old one to go
  seen(id); settings.voiceCycleMgr = id;
  if (!known && settings.voiceCycle) nextVoice(); else saveSettings();   // a known id coming back is no new Theseus
}
function nextVoice() {
  const list = settings.voiceCycleList || [];
  if (!list.length) return false;
  settings.voice = list[(list.indexOf(settings.voice) + 1) % list.length]; writeVoice(); saveSettings();
  pushSettings();
  return true;
}
let builtin = null;   // the built-in Windows voice (src/speech.js), started on first use when the External voice add-on is off
function speak(line, done) {   // done: after the line has played (or failed)
  if (!P.voiceExt()) {
    if (!builtin) builtin = require('./speech').create({ state: P.builtinVoice() });
    builtin.say(line, { speed: settings.voiceSpeed }).then(() => { if (done) done(); });
    return;
  }
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(P.echo(), 'speak.ps1'), line, '-Voice', settings.voice, '-Speed', String(settings.voiceSpeed)], { windowsHide: true }, () => { if (done) done(); });
}
function writeVoice() { try { if (P.echo()) fs.writeFileSync(path.join(P.echo(), 'state', 'voice.json'), JSON.stringify({ voice: settings.voice, speed: settings.voiceSpeed })); } catch {} }
// rect (content DIPs of the sphere window) = show it as a rounded card over the panel, like the chat card; none = a normal window
function openSettings(section = '', rect = null) {
  const card = !!(rect && win && !win.isDestroyed());
  if (settingsWin && !settingsWin.isDestroyed() && settingsWin.card !== card) { const w = settingsWin; settingsWin = null; w.destroy(); }
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show(); settingsWin.focus();
    settingsWin.webContents.executeJavaScript(`location.hash = ''; location.hash = ${JSON.stringify(section)}`).catch(() => {});
  } else {
    settingsWin = new BrowserWindow(card
      ? { frame: false, transparent: true, hasShadow: false, skipTaskbar: true, resizable: false, movable: false, show: false, title: NAME() + ' settings',
          backgroundColor: '#00000000', webPreferences: { preload: path.join(__dirname, 'preload.js') } }
      : { width: 460, height: 720, title: NAME() + ' settings', icon: path.join(__dirname, '..', 'assets', 'icon.png'), backgroundColor: '#121211', autoHideMenuBar: true,
          webPreferences: { preload: path.join(__dirname, 'preload.js') } });
    settingsWin.card = card; watchConsole(settingsWin.webContents, 'settings');
    // however the card goes (closed, crashed), the sphere must drop its card state or the panel never folds
    const sw = settingsWin; sw.on('closed', () => { if (settingsWin === sw) { settingsWin = null; if (card && win && !win.isDestroyed()) win.webContents.send('overlay-closed'); } });
    sw.webContents.on('render-process-gone', (_e, d) => { if (d.reason !== 'clean-exit' && !sw.isDestroyed()) sw.destroy(); });
    const o = {}; if (section) o.hash = section; if (card) o.query = { card: '1' };
    settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'), o);
    const w = settingsWin; w.once('ready-to-show', () => { if (!w.isDestroyed()) { w.show(); w.focus(); } });
  }
  if (card) {
    const b = win.getContentBounds();
    settingsWin.setBounds({ x: Math.round(b.x + rect.x), y: Math.round(b.y + rect.y), width: Math.round(rect.w), height: Math.round(rect.h) });
    settingsWin.setAlwaysOnTop(true, 'screen-saver'); settingsWin.moveTop();   // the sphere is at screen-saver level: below it the card hides
  }
}
// the settings card goes when the chat card opens, on a click outside, Esc or when the panel folds
function closeSettingsCard(quiet) {
  if (!settingsWin || settingsWin.isDestroyed() || !settingsWin.card) return;
  const w = settingsWin; settingsWin = null; w.destroy();
  if (!quiet && win && !win.isDestroyed()) win.webContents.send('overlay-closed');
}
// The claude:// handler in the registry can point at a removed app version after an update; fall back to the
// Squirrel launcher (always starts the current version, which hands the link to the running app).
function openLink(link) {
  const stub = path.join(process.env.LOCALAPPDATA || '', 'AnthropicClaude', 'claude.exe');
  shell.openExternal(link).catch(() => execFile(stub, [link], { windowsHide: true }, () => {}));
}
// write to a temp file and rename over (a crash mid-write can no longer reset everything); the last good file is kept as .bak
function writeAtomic(file, data, bak) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', data);
  if (bak) try { JSON.parse(fs.readFileSync(file, 'utf8')); fs.copyFileSync(file, file + '.bak'); } catch {}
  fs.renameSync(file + '.tmp', file);
}
let saveT = null;
function saveSettings() { clearTimeout(saveT); saveT = setTimeout(flushSettings, 300); }     // debounced: a slider drag is one write
function flushSettings() { clearTimeout(saveT); saveT = null; try { writeAtomic(settingsPath, JSON.stringify(settings, null, 2), true); } catch {} }
// what the pages get: the settings plus the add-ons' live state (live: { k: { on, found } })
// a personal copy (personal.settings.json beside the app) shows its add-ons in settings; the public install does not
const PERSONAL = !process.env.SPHERE_NO_PERSONAL && fs.existsSync(path.join(__dirname, '..', 'personal.settings.json'));
const uiSettings = () => ({ ...settings, live: P.addons(), personal: PERSONAL });
const ADDON_KEYS = ['addons', 'feedFile', 'modeDir', 'statusFile', 'echoDir', 'whisperPy'];
function pushSettings() { const s = uiSettings(); for (const w of [settingsWin, stripWin, win]) if (w && !w.isDestroyed()) w.webContents.send('settings', s); }
// IPC calls count only from our own windows
const fromWin = e => !!win && !win.isDestroyed() && e.sender === win.webContents;
const fromSettings = e => !!settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents;
let stripWin = null, toastWin = null;        // the Theseus strip, and the small notice / readout toast
const alive = w => !!w && !w.isDestroyed();
const fromStrip = e => alive(stripWin) && e.sender === stripWin.webContents;
const fromToast = e => alive(toastWin) && e.sender === toastWin.webContents;
const fromUi = e => fromWin(e) || fromSettings(e) || fromStrip(e) || fromToast(e);
// console output of our own windows goes to stdout when testing (SPHERE_DEBUG, STRIP_SHOTS, THESEUS_CONSOLE)
function watchConsole(wc, tag) {
  if (!(process.env.SPHERE_DEBUG || process.env.STRIP_SHOTS || process.env.THESEUS_CONSOLE)) return;
  wc.on('console-message', (e, level, message, line, src) => { const d = e && e.message !== undefined ? e : { level, message, lineNumber: line, sourceId: src }; console.log(`[console ${tag}] ${d.level} ${d.message} (${d.sourceId}:${d.lineNumber})`); });
  wc.on('preload-error', (_e, p, err) => console.log(`[console ${tag}] preload error ${p}: ${err && err.message}`));
  wc.on('did-fail-load', (_e, code, desc) => console.log(`[console ${tag}] load failed ${code} ${desc}`));
}
const okRect = r => !!r && typeof r === 'object' && ['x', 'y', 'w', 'h'].every(k => typeof r[k] === 'number' && isFinite(r[k]) && Math.abs(r[k]) < 30000) && r.w > 0 && r.h > 0;
const LINK = /^claude:\/\/claude\.ai\/epitaxy\/[\w-]+$/;

function halfBounds() {
  const ds = screen.getAllDisplays();
  const d = settings.display === 'primary' ? screen.getPrimaryDisplay() : (ds.find(x => String(x.id) === String(settings.display)) || screen.getPrimaryDisplay());
  const w = d.workArea, half = Math.floor(w.width / 2);
  if (settings.side === 'full') return { x: w.x, y: w.y, width: w.width, height: w.height };   // the whole work area, sphere in the middle
  return { x: settings.side === 'left' ? w.x : w.x + w.width - half, y: w.y, width: half, height: w.height };
}

// Push the window to the bottom of the z-order (desktop layer: behind normal windows, above the wallpaper); through the z-order helper, no spawn.
function sendToBottom(retries = 2) {
  if (!win || win.isDestroyed() || frontOn) return;
  const hwnd = hwndOf(win);
  zorder.send({ cmd: 'bottom', hwnd }, 10000).then(r => { if (!r.ok && retries > 0) setTimeout(() => sendToBottom(retries - 1), 1000); else bgUnder(); });
}
const hwndOf = w => Number(w.getNativeWindowHandle().readBigUInt64LE(0));

// ---- background (Backgrounds_Spec): a click-through window over the sphere's screen. Spread: just behind the sphere, over
// other windows. Folded with Always visible: a live wallpaper at the bottom of the stack, just under the folded sphere ----
let bgWin = null, bgReady = false, bgHideT = 0, bgPaused = false;
const bgExtra = { tint: '#3da5ff', working: false };   // the mode colour and "a session is working" (set where they are known)
const bgOn = () => settings.bgStyle !== 'none' && alive(win) && win.isVisible() && (settings.bgAlways || frontOn);   // the sphere hidden (tray): no background
const bgBounds = () => screen.getDisplayMatching(win.getBounds()).bounds;
const differs = (a, b) => a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height;
function bgSend() {
  if (!alive(bgWin)) return;
  bgWin.webContents.send('bg', { style: settings.bgStyle, opacity: settings.bgOpacity / 100, visible: bgOn(), tint: bgExtra.tint, speed: bgExtra.working ? 1.3 : 1, paused: bgPaused && !frontOn });
}
function bgUnder() { if (alive(bgWin) && bgWin.isVisible() && !frontOn && alive(win)) zorder.send({ cmd: 'under', hwnd: hwndOf(bgWin), after: hwndOf(win) }, 10000).catch(() => {}); }
function syncBg() {
  if (!alive(win)) return;
  if (!bgOn()) {
    if (alive(bgWin)) {   // fades first, then goes (style None: the window is closed)
      bgSend(); clearTimeout(bgHideT);
      bgHideT = setTimeout(() => { if (alive(bgWin) && !bgOn()) { if (settings.bgStyle === 'none') { bgWin.destroy(); bgWin = null; } else bgWin.hide(); } }, 450);
    }
    return;
  }
  clearTimeout(bgHideT);
  if (!alive(bgWin)) {
    const w = bgWin = new BrowserWindow({ ...bgBounds(), transparent: true, frame: false, hasShadow: false, skipTaskbar: true, focusable: false, resizable: false, movable: false,
      show: false, backgroundColor: '#00000000', enableLargerThanScreen: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: true } });
    w.setIgnoreMouseEvents(true);
    w.on('closed', () => { if (bgWin === w) bgWin = null; });
    bgReady = false;
    w.webContents.on('did-finish-load', () => { if (bgWin === w) { bgReady = true; syncBg(); } });
    w.loadFile(path.join(__dirname, 'renderer', 'bg.html'));
    return;   // placed once loaded
  }
  if (!bgReady) return;
  if (differs(bgWin.getBounds(), bgBounds())) { bgWin.setBounds(bgBounds()); if (process.env.SPHERE_DEBUG) console.log('bg bounds', JSON.stringify(bgWin.getBounds())); }
  if (frontOn) { bgWin.setAlwaysOnTop(true, 'screen-saver'); if (!bgWin.isVisible()) bgWin.showInactive(); bgWin.moveTop(); win.moveTop(); }
  else { bgWin.setAlwaysOnTop(false); if (!bgWin.isVisible()) bgWin.showInactive(); bgUnder(); }
  bgSend();
}

function createWindow() {
  win = new BrowserWindow({
    ...halfBounds(), transparent: true, frame: false, hasShadow: false, skipTaskbar: true, focusable: false,
    resizable: false, movable: false, backgroundColor: '#00000000', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: true },
  });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  watchConsole(win.webContents, 'sphere');
  win.once('ready-to-show', () => { win.showInactive(); sendToBottom(); syncBg(); if (process.env.SPHERE_SHOTS) testShots(); });
  win.on('show', () => setTimeout(sendToBottom, 200));
  // a crashed or killed renderer: load the page again (not in a tight loop)
  let gone = [];
  win.webContents.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return;
    const now = Date.now(); gone = gone.filter(t => now - t < 60000); gone.push(now);
    if (process.env.SPHERE_DEBUG) console.log('render-process-gone', d.reason);
    if (gone.length <= 5) setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.reload(); }, 1000);
  });
  win.webContents.on('did-start-loading', () => { occluded = false; });   // a fresh page starts as visible
}

// Start with Windows: unpackaged, the login item must run electron.exe with this app's folder (and the feed path, if one is set)
function setAutostart() {
  if (process.env.SPHERE_USERDATA) return;   // a test instance never touches the real login item (it would drop it)
  const o = { openAtLogin: !!settings.autostart, name: app.isPackaged ? 'Session Sphere' : 'Theseus' };   // installed: the product's own Run entry
  if (!app.isPackaged) { o.path = process.execPath; o.args = [app.getAppPath()]; }
  app.setLoginItemSettings(o);
  if (app.isPackaged) return;
  // renamed from Session Sphere (user 10-9): drop the old Run entry so it does not start twice
  app.setLoginItemSettings({ ...o, openAtLogin: false, name: 'Session Sphere' });
}
// test pictures of the sphere window itself, even under other windows: SPHERE_SHOTS="<dir>;<count>;<ms apart>" (first after 8 s)
if (process.env.SPHERE_SHOTS) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
function testShots() {
  const [dir, count = 1, ms = 500] = process.env.SPHERE_SHOTS.split(';');
  win.webContents.setBackgroundThrottling(false);
  let i = 0;
  const take = async () => {
    if (win.isDestroyed() || i >= +count) return;
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `shot_${String(++i).padStart(2, '0')}.png`), img.toPNG());
    setTimeout(take, +ms);
  };
  setTimeout(take, 8000);
}
// one sphere at a time: a second start (autostart + a manual launch) quits at once and does nothing else (no settings, no voice)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
// the pages' titles say Theseus: every window shows the assistant's name instead
app.on('browser-window-created', (_e, w) => w.on('page-title-updated', (ev, t) => { ev.preventDefault(); w.setTitle(t.replace(/^Theseus\b/, NAME())); }));
if (gotLock) app.whenReady().then(() => {
  zorder.send({ cmd: 'ping' });                // warm the z-order helper before the window needs it
  loadSettings(); setAutostart();            // keeps the login item in step with the setting (and with this folder)
  createWindow();
  if (!settings.setupDone) setTimeout(() => openSettings('setup'), 2000);   // a fresh install: the setup card
  const trayIcon = require('./trayicon'); let trayHex = null;   // assets/tray_base + mode-coloured core + tray_top (tools/make_icon.js)
  const coreHex = m => (!settings.coreFollowsMode || !m || m === 'normal') ? settings.glow : (settings.modeColors[m] || settings.glow);
  const icon = trayIcon(trayHex = coreHex(null));
  tray = new Tray(icon);
  tray.setToolTip(NAME());
  const rebuild = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Settings…', click: () => openSettings() },
    { label: 'Show / hide', click: () => { if (!win || win.isDestroyed()) return; if (win.isVisible()) win.hide(); else { win.showInactive(); sendToBottom(); } syncBg(); } },
    { label: 'Left half', type: 'radio', checked: settings.side === 'left', click: () => { settings.side = 'left'; saveSettings(); win.setBounds(halfBounds()); pushSettings(); } },
    { label: 'Right half', type: 'radio', checked: settings.side === 'right', click: () => { settings.side = 'right'; saveSettings(); win.setBounds(halfBounds()); pushSettings(); } },
    { label: 'Full screen', type: 'radio', checked: settings.side === 'full', click: () => { settings.side = 'full'; saveSettings(); win.setBounds(halfBounds()); pushSettings(); } },
    ...trayExtra(),
    { type: 'separator' }, { label: 'Quit', click: () => app.quit() },
  ]));
  // monitors plugged or unplugged, resolution or scaling changed: the window follows its half again
  let dispT;
  const onDisplays = () => {
    clearTimeout(dispT);
    dispT = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const nb = halfBounds(), b = win.getBounds();
      if (nb.x !== b.x || nb.y !== b.y || nb.width !== b.width || nb.height !== b.height) { win.setBounds(nb); sendToBottom(); }
      syncBg();
    }, 500);
  };
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, onDisplays);
  if (process.env.SPHERE_OPEN_SETTINGS) openSettings();
  // test pictures of the settings window: SETTINGS_SHOT="<png>;<css selector to scroll to>" (taken <ms> after start, 7000 by default)
  if (process.env.SETTINGS_SHOT) { const [png, sel, ms] = process.env.SETTINGS_SHOT.split(";"); setTimeout(() => { if (!alive(settingsWin)) return; settingsWin.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(sel || "body")})?.scrollIntoView()`).catch(() => {}); setTimeout(() => alive(settingsWin) && settingsWin.webContents.capturePage().then(i => fs.writeFileSync(png, i.toPNG())), 3000); }, +ms || 7000); }
  // Renderer tells us whether the pointer is over the sphere: only then the window takes mouse input.
  ipcMain.on('hit', (e, over) => { if (!fromWin(e)) return; if (process.env.SPHERE_DEBUG) console.log('hit', over); win.setIgnoreMouseEvents(!over, { forward: true }); });
  ipcMain.handle('settings', e => fromUi(e) ? uiSettings() : null);
  // the setup card's tool check: on PATH (absolute folders only), ffmpeg as set or on PATH, the Claude app's claude:// handler
  ipcMain.handle('setup-info', e => {
    if (!(fromSettings(e) || fromWin(e))) return null;
    let claude = false; try { claude = !!app.getApplicationNameForProtocol('claude://'); } catch {}
    let ff = false; try { ff = !!P.ffmpeg() && fs.statSync(P.ffmpeg()).isFile(); } catch {}
    return { git: !!P.onPath('git.exe'), gh: !!P.onPath('gh.exe'), wt: !!P.onPath('wt.exe'), ffmpeg: ff, claude };
  });
  ipcMain.on('open-settings', async (e, section, rect) => {
    if (!fromWin(e) && !fromSettings(e)) return;
    if (rect && !okRect(rect)) rect = null;
    if (rect && overlay) { closeReq++; await overlayOff(true); }
    openSettings(typeof section === 'string' && section.length < 40 ? section : '', rect);
  });
  // Claude's own settings: in the wide card when the panel asks (rect), else just the link
  ipcMain.handle('claude-settings', (e, rect) => {
    if (!fromWin(e)) return;
    if (!rect) return openLink('claude://claude.ai/settings');
    if (!okRect(rect)) return;
    return serial(async () => {
      await overlayOnRaw(rect); openLink('claude://claude.ai/settings'); if (overlay) overlay.settings = true;
      setTimeout(() => overlay && overlay.place(), 600);
    });
  });
  // Theseus mode: current = editor_limits.json .mode; a change is a request the Session manager's watcher picks up
  const MODES = ['normal', 'worker', 'night', 'weekend', 'performance', 'efficiency'];
  const readMode = f => { if (!P.modeDir()) return null; try { return JSON.parse(fs.readFileSync(path.join(P.modeDir(), f), 'utf8').replace(/^\uFEFF/, '')).mode || null; } catch { return null; } };
  // SPHERE_MODE_FILE (tests): a scratch {"mode": ...} file stands in for the real mode, so the core can be checked per mode
  function getMode() {
    return process.env.SPHERE_MODE_FILE
      ? { mode: (() => { try { return JSON.parse(fs.readFileSync(process.env.SPHERE_MODE_FILE, 'utf8')).mode; } catch { return 'normal'; } })(), pending: null }
      : { mode: readMode('editor_limits.json'), pending: readMode('mode_request.json') };
  }
  ipcMain.handle('mode', e => fromUi(e) ? getMode() : null);
  ipcMain.handle('set-mode', (e, m) => fromUi(e) ? requestMode(m) : null);
  function requestMode(m) {
    // a test instance (own user folder or scratch mode file) never asks Theseus for a real mode change
    if (process.env.SPHERE_MODE_FILE || process.env.SPHERE_USERDATA) {
      if (MODES.includes(m) && process.env.SPHERE_MODE_FILE) try { fs.writeFileSync(process.env.SPHERE_MODE_FILE, JSON.stringify({ mode: m })); } catch {}
      log(`mode ${m} requested (test instance: not sent)`);
      return getMode();
    }
    if (MODES.includes(m) && !(m === readMode('editor_limits.json') && !readMode('mode_request.json'))) {
      const f = path.join(P.modeDir(), 'mode_request.json'), at = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19);
      // test runs (SPHERE_TEST=1 or SPHERE_DEBUG=1) mark the request so Theseus switches without messaging the sessions
      const req = { mode: m, at }; if (process.env.SPHERE_TEST || process.env.SPHERE_DEBUG) req.test = true;
      try { fs.writeFileSync(f + '.tmp', JSON.stringify(req)); fs.renameSync(f + '.tmp', f); } catch {}
    }
    return getMode();
  }
  ipcMain.handle('displays', e => (fromWin(e) || fromSettings(e)) ? screen.getAllDisplays().map((d, i) => ({ id: String(d.id), label: `Monitor ${i + 1} (${d.size.width}x${d.size.height})` })) : []);
  ipcMain.handle('set-settings', (e, patch) => {
    if (!(fromWin(e) || fromSettings(e))) return settings;
    patch = clean(patch);
    const moved = 'side' in patch || 'display' in patch;
    settings = merge(settings, patch); saveSettings();
    if (moved && win && !win.isDestroyed()) win.setBounds(halfBounds());
    if (moved || 'bgStyle' in patch || 'bgOpacity' in patch || 'bgAlways' in patch) syncBg();
    if ('voice' in patch || 'voiceSpeed' in patch) writeVoice();
    if ('autostart' in patch) setAutostart();
    if (patch.claudeTray === true) hideClaude();
    if ('name' in patch && tray) tray.setToolTip(NAME());
    if ('name' in patch) for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.setTitle(w.webContents.getTitle().replace(/^Theseus\b/, NAME()));
    pushSettings(); onSettingsChanged(patch);
    rebuild();
    return uiSettings();
  });
  ipcMain.on('test-voice', e => { if (fromSettings(e) || fromWin(e)) speak(NAME() + ' voice test.'); });
  // test the cycle: move on as if Theseus had just been replaced; only this test speaks (a real replacement changes the voice silently)
  ipcMain.handle('test-cycle', e => { if (!(fromSettings(e) || fromWin(e)) || !nextVoice()) return false; speak(`${NAME()} replaced. I've always been ${settings.voice.slice(3).replace(/^./, c => c.toUpperCase())}.`); return settings.voice; });
  // spread-out view shows over all windows; folded back it returns to the desktop layer
  ipcMain.on('front', (e, on) => {
    if (!fromWin(e)) return;
    frontOn = !!on;
    if (frontOn) { setOccluded(false); win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop(); } else { win.setAlwaysOnTop(false); sendToBottom(); }
    syncBg();
  });
  // keyboard mode (Win+Alt+Space): the window takes focus while spread so arrows / Enter / Esc reach it; it is unfocusable otherwise
  ipcMain.on('key-focus', (e, on) => {
    if (!fromWin(e)) return;
    if (on) { win.setFocusable(true); win.focus(); } else if (win.isFocusable()) { win.blur(); win.setFocusable(false); }
  });
  // the sphere sits under other windows: it opens only where nothing covers it
  ipcMain.handle('covered', async e => {
    if (!fromWin(e)) return false;
    const p = screen.dipToScreenPoint(screen.getCursorScreenPoint());
    const r = await zorder.send({ cmd: 'covered', x: p.x, y: p.y, pid: process.pid }, 10000);
    if (process.env.SPHERE_DEBUG) console.log('covered', JSON.stringify(r));
    return !!r.covered;
  });
  // occlusion: the renderer reports the folded sphere's circle (window DIPs); about every second, while folded, 5 points of it
  // (the centre and 4 at 0.7 r) are checked: all covered by other apps = occluded (the renderer then draws at about 2 fps)
  let circle = null, occBusy = false;
  ipcMain.on('sphere-area', (e, a) => {
    if (!fromWin(e) || !a || ![a.x, a.y, a.r].every(v => typeof v === 'number' && isFinite(v)) || a.r <= 0 || a.r > 20000) return;
    circle = { x: a.x, y: a.y, r: a.r };
  });
  function setOccluded(v) { if (v === occluded) return; occluded = v; if (process.env.SPHERE_DEBUG) console.log('occluded', v); if (win && !win.isDestroyed()) win.webContents.send('occluded', v); }
  setInterval(async () => {
    if (occBusy || !circle || frontOn || !win || win.isDestroyed() || !win.isVisible()) return;
    occBusy = true;
    try {
      const b = win.getContentBounds(), c = circle, d = 0.7 * c.r;
      const pts = [[0, 0], [d, 0], [-d, 0], [0, d], [0, -d]].map(([dx, dy]) => { const p = screen.dipToScreenPoint({ x: Math.round(b.x + c.x + dx), y: Math.round(b.y + c.y + dy) }); return { x: p.x, y: p.y }; });
      const r = await zorder.send({ cmd: 'coveredPts', pts, pid: process.pid }, 10000);
      if (r.ok && !frontOn) setOccluded(!!r.all);
    } catch {} finally { occBusy = false; }
  }, 1000);
  ipcMain.handle('cursor', e => { if (!fromWin(e)) return null; const p = screen.getCursorScreenPoint(), b = win.getContentBounds(); return { x: p.x - b.x, y: p.y - b.y }; });
  ipcMain.handle('feed', e => fromWin(e) ? lastFeed : null);
  // only Claude app session links are opened
  ipcMain.on('open', (e, link) => { if (!fromWin(e)) return; if (process.env.SPHERE_DEBUG) console.log('open', link); if (typeof link === 'string' && LINK.test(link)) openLink(link); });
  // ---- Claude window over the background: lists for the top groups, button presses, overlay placement ----
  let cstate = { title: '', project: '', mode: '', sidebar: false, nav: [], routines: [], pinned: [], artifacts: [] }, overlay = null, graceUntil = 0;
  // the lists can only be read while Claude's sidebar is shown: keep the last ones (also on disk); with none yet, peek once
  const listsPath = path.join(app.getPath('userData'), 'claude_lists.json');
  try { Object.assign(cstate, JSON.parse(fs.readFileSync(listsPath, 'utf8'))); } catch {}
  let peeked = 0;
  const saveLists = () => { try { writeAtomic(listsPath, JSON.stringify({ nav: cstate.nav, routines: cstate.routines, pinned: cstate.pinned, artifacts: cstate.artifacts })); } catch {} };
  // the Artifacts page lists the artifacts (only while it is open in the card): new names first, the rest kept
  async function readArtifacts() {
    if (!overlay) return;
    const r = await claudeUi.send({ cmd: 'artifacts' });
    if (!r.ok || !r.names || !r.names.length) return;
    cstate.artifacts = [...new Set([...r.names, ...cstate.artifacts])].slice(0, 200); saveLists();
  }
  ipcMain.handle('claude-snap', async e => {
    if (!fromWin(e)) return null;
    let s = await claudeUi.send({ cmd: 'snap' });
    if (s.ok && !s.sidebar && !overlay && !cstate.nav.length && Date.now() - peeked > 600000) { peeked = Date.now(); s = await claudeUi.send({ cmd: 'peek' }); }
    if (s.ok) for (const k of Object.keys(cstate)) if (s[k] != null) cstate[k] = s[k];
    if (s.ok && s.nav) saveLists();
    return { ...cstate, overlay: !!overlay };
  });
  // overlay open / close run one at a time (a queue), so quick clicks cannot interleave; closeReq counts close requests so a
  // button press in progress stops pressing once the card is folded; reopenT = the pending "show Claude's sidebar again"
  let ovQ = Promise.resolve(), closeReq = 0, reopenT = null, opening = 0;
  const serial = fn => { const p = ovQ.then(fn); ovQ = p.catch(() => {}); return p; };
  // rect = content-area DIPs of the sphere window -> physical screen pixels
  const screenRect = r => { const b = win.getContentBounds(); return screen.dipToScreenRect(win, { x: Math.round(b.x + r.x), y: Math.round(b.y + r.y), width: Math.round(r.w), height: Math.round(r.h) }); };
  // rect = the chat card; Claude's title bar and window corners are cut away (rounded, radius 14 DIPs)
  async function overlayOnRaw(rect, link) {
    closeSettingsCard(true);
    graceUntil = Date.now() + 2500;
    const carry = reopenT != null; clearTimeout(reopenT); reopenT = null;   // a sidebar reopen still pending from the last card is meant for this one
    const p = screenRect(rect), k = p.width / rect.w;
    const place = () => claudeUi.send({ cmd: 'place', x: p.x, y: p.y, w: p.width, h: p.height }).then(r => { if (r.ok && overlay && overlay.place === place) showMask(rect, (r.th || 36) / k); return r; });
    if (!overlay) {
      const st = await claudeUi.send({ cmd: 'state' });
      let s = await claudeUi.send({ cmd: 'snap' }), hidden = false;
      if (st.found === false) {                      // Claude closed to the tray / not running: wake it, hide it again later
        hidden = true; link ? openLink(link) : execFile(path.join(process.env.LOCALAPPDATA || '', 'AnthropicClaude', 'claude.exe'), [], { windowsHide: true }, () => {});
        for (let i = 0; i < 25 && !s.ok; i++) { await new Promise(r => setTimeout(r, 200)); s = await claudeUi.send({ cmd: 'snap' }); }
        graceUntil = Date.now() + 2500;
      }
      const wasOpen = !!(s.ok && s.sidebar);
      overlay = { sidebar: wasOpen || carry, place, hidden };
      await place();
      if (overlay && wasOpen) await claudeUi.send({ cmd: 'sidebar', open: false });
    } else {
      if (overlay.settings) { overlay.settings = false; await claudeUi.send({ cmd: 'invoke', name: 'Close' }); }   // another page replaces Claude's settings
      overlay.place = place; await place();
    }
  }
  async function overlayOffRaw(quiet) {
    if (!overlay) return;
    const o = overlay; overlay = null;
    if (o.thumbI) { clearTimeout(o.thumbT); clearInterval(o.thumbI); if (Date.now() - (o.thumbAt || 0) > 5000) await snapThumb(o, true); }
    hideMask();
    // Claude's settings dialog: close it and go back to the page that was open before
    if (process.env.SPHERE_DEBUG) console.log('overlay-off', !!o.settings);
    if (o.settings) { const c = await claudeUi.send({ cmd: 'invoke', name: 'Close' }); if (process.env.SPHERE_DEBUG) console.log('close', JSON.stringify(c)); await new Promise(r => setTimeout(r, 1000)); await claudeUi.send({ cmd: 'invoke', name: 'Back' }); }
    await claudeUi.send({ cmd: 'restore', hide: o.hidden || settings.claudeTray });
    // after the resize: a sidebar opened while the window is narrow is a drawer that closes again on resize
    // the page can still be loading (after Claude's settings), so try a few times; a new card cancels the retries
    const reopen = (n, ms) => { reopenT = setTimeout(async () => {
      reopenT = null; if (overlay) return;
      const r = await claudeUi.send({ cmd: 'sidebar', open: true });
      if (!r.ok && n > 0 && !overlay && reopenT == null) reopen(n - 1, 500);
    }, ms); };
    if (o.sidebar && !o.hidden) reopen(4, 400);
    if (!quiet && win && !win.isDestroyed()) win.webContents.send('overlay-closed');
  }
  const overlayOff = quiet => serial(() => overlayOffRaw(quiet));
  // a tile: open the session in the Claude window over the background (the link handler can raise it, so place again)
  ipcMain.handle('overlay-open', (e, rect, link) => {
    if (!fromWin(e)) return false;
    if (process.env.SPHERE_DEBUG) console.log('overlay-open', JSON.stringify(rect), link);
    if (!okRect(rect) || typeof link !== 'string' || !LINK.test(link)) return false;
    opening++;   // from the click on, console commands are refused (refuse): one run while the card opens could switch its page
    return serial(async () => {
      await overlayOnRaw(rect, link); openLink(link);
      if (process.env.SPHERE_DEBUG) console.log('placed', JSON.stringify(screenRect(rect)));
      setTimeout(() => overlay && overlay.place(), 600);
      return true;
    }).finally(() => { opening--; });
  });
  // a top-group item: press the same button in the Claude window, shown over the background
  ipcMain.handle('claude-press', (e, rect, name) => {
    if (!fromWin(e) || !okRect(rect) || typeof name !== 'string' || name.length > 200) return false;
    const req = closeReq; opening++;
    return serial(async () => {
      if (req !== closeReq) return false;          // folded before it got its turn
      await overlayOnRaw(rect);
      const o = overlay, alive = () => overlay === o && req === closeReq;
      let r = await claudeUi.send({ cmd: 'invoke', name });
      // an artifact that is not pinned: open the Artifacts page and press its row there
      if (!r.ok && cstate.artifacts.includes(name) && alive()) {
        await claudeUi.send({ cmd: 'invoke', name: 'Artifacts' });
        for (let i = 0; i < 15 && !r.ok && alive(); i++) { await new Promise(res => setTimeout(res, 200)); if (alive()) r = await claudeUi.send({ cmd: 'invoke', name }); }
      }
      if (name === 'Artifacts' && r.ok) setTimeout(readArtifacts, 2000);
      graceUntil = Date.now() + 1500;
      // a picture of the page once it has loaded, then every 20 s and on close
      if (alive() && r.ok) { clearTimeout(o.thumbT); clearInterval(o.thumbI);
        o.rect = rect; o.thumbT = setTimeout(() => snapThumb(o), 2500); o.thumbI = setInterval(() => snapThumb(o), 20000); }
      return !!r.ok;
    }).finally(() => { opening--; });
  });
  async function snapThumb(o, closing) {
    if (!closing && overlay !== o) return;
    const s = await claudeUi.send({ cmd: 'snap' });
    const title = s.ok && s.title ? s.title.replace(/ - Claude$/, '') : '';
    if (!title || /^(New session|Claude)$/.test(title) || !win || win.isDestroyed()) return;
    const b = win.getContentBounds();
    try { if (await thumbs.capture(title, { x: Math.round(b.x + o.rect.x), y: Math.round(b.y + o.rect.y), width: Math.round(o.rect.w), height: Math.round(o.rect.h) })) o.thumbAt = Date.now(); }
    catch (e) { if (process.env.SPHERE_DEBUG) console.log('thumb', e.message); }
    if (process.env.SPHERE_DEBUG) console.log('thumb', title);
  }
  ipcMain.handle('thumb', (e, title) => fromWin(e) && typeof title === 'string' && title.length < 300 ? thumbs.get(title) : null);
  ipcMain.handle('overlay-close', e => { if (!fromWin(e) && !fromSettings(e)) return; closeReq++; closeSettingsCard(true); return overlayOff(); });
  // Session Console (Docs/Specs/SessionConsole_Plan.md): a session's conversation in the wide card. One transcript reader at a time;
  // its batches go to the window as 'console-msg' { sessionId, msgs, init }. SPHERE_CONSOLE=<sessionId> (tests) opens a session at start.
  let conRd = null, conId = null, sendQ = Promise.resolve();
  // setting 'Keep the Claude app in the tray': hidden at start and when turned on (never by a test instance, never under an open Claude card)
  function hideClaude() { if (!process.env.SPHERE_USERDATA && !overlay) claudeUi.send({ cmd: 'hide' }).then(r => log('claude to tray: ' + (r.ok ? 'ok' : r.why))); }
  if (settings.claudeTray) setTimeout(hideClaude, 8000);
  // the built feed leaves out the transcript path: read it from the feed file
  // sessions started from the console (console-new) before the feed lists them: 'new:<uuid>' -> { file, title }
  const newOnes = new Map();
  // sessionId -> { sessionId, title, link } from the feed, or a new: session
  function sessFor(sessionId) {
    const s = (lastFeed.sessions || []).find(x => x.sessionId === sessionId); if (s) return s;
    const n = newOnes.get(sessionId); if (!n) return null;
    // the app had not named it yet when it started: the feed's entry with the same transcript has the name
    if (!n.title) {
      const f = feedSessions().find(x => typeof x.transcript === 'string' && path.basename(x.transcript) === path.basename(n.file));
      if (f && f.title) n.title = String(f.title);
    }
    return { sessionId, title: n.title, link: null };
  }
  // after a rewind the app writes the session on in a new transcript (the kept history copied, then the new message):
  // sessionId -> that file, used until the feed names a file at least as new
  const moved = new Map();
  const born = f => { try { return fs.statSync(f).birthtimeMs; } catch { return -1; } };
  // the feed file's sessions, parsed again only when the file changes (a search asks once per session)
  let feedRead = { at: -1, sessions: [] };
  function feedSessions() {
    const rd = feed.readerSessions(); if (rd) return rd;   // the built-in reader stands in for the feed
    try {
      const m = fs.statSync(P.feed()).mtimeMs;
      if (m !== feedRead.at) { const r = JSON.parse(fs.readFileSync(P.feed(), 'utf8').replace(/^﻿/, '')); feedRead = { at: m, sessions: (r.sessions || []).filter(x => x && typeof x === 'object') }; }
    } catch {}
    return feedRead.sessions;
  }
  // tests only (new ideas 5): SPHERE_STRESS=<sessionId> makes that session's transcript a made-up file that grows by one
  // message a second (short and long replies, code, tool calls, now and then a background command), read by the real reader
  let stressAt = null;
  function stressFile() {
    if (stressAt) return stressAt;
    const d = path.join(app.getPath('temp'), 'SessionSphere'); fs.mkdirSync(d, { recursive: true });
    stressAt = path.join(d, 'stress_' + process.pid + '.jsonl'); fs.writeFileSync(stressAt, '');
    let n = 0;
    const line = o => fs.appendFileSync(stressAt, JSON.stringify({ ...o, uuid: 'st' + n, timestamp: new Date().toISOString() }) + '\n');
    const words = k => Array.from({ length: k }, (_, i) => ['sphere', 'tile', 'console', 'render', 'feed', 'draft', 'search', 'strip'][(n + i) % 8]).join(' ');
    setInterval(() => {
      n++;
      const k = n % 7;
      if (k === 0) line({ type: 'user', message: { role: 'user', content: `Message ${n}: ${words(8 + n % 30)}` } });
      else if (k === 3) line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu' + n, name: n % 21 === 3 ? 'Bash' : 'Read', input: n % 21 === 3 ? { command: 'sleep 30', description: 'Stress wait ' + n, run_in_background: true } : { file_path: 'stress\\file' + n + '.js' } }] } });
      else if (k === 4) line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu' + (n - 1), content: (n - 1) % 21 === 3 ? 'Command running in background with ID: bs' + n : 'line\n'.repeat(1 + n % 40) }] } });
      else line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `## Reply ${n}\n\n${words(20 + (n * 13) % 400)}\n\n` + (n % 5 === 0 ? '```js\n' + 'const x = ' + n + ';\n'.repeat(1 + n % 25) + '```\n' : '- one\n- two\n') }] } });
    }, 1000);
    log('stress transcript: ' + stressAt);
    return stressAt;
  }
  function transcriptOf(sessionId) {
    if (process.env.SPHERE_STRESS && sessionId === process.env.SPHERE_STRESS) return stressFile();
    if (newOnes.has(sessionId)) { const f = newOnes.get(sessionId).file; return fs.existsSync(f) ? f : null; }
    const file = (feedSessions().find(x => String(x.sessionId) === sessionId) || {}).transcript;
    const mv = moved.get(sessionId);
    if (mv) { if (born(mv) < 0) moved.delete(sessionId); else if (!(typeof file === 'string' && born(file) >= born(mv))) return mv; else moved.delete(sessionId); }
    return typeof file === 'string' && /\.jsonl$/i.test(file) && fs.existsSync(file) ? file : null;
  }
  // has a user line starting like `text` been written to the transcript since byte `from`? (polls up to 6 s)
  async function landed(file, from, text) {
    const key = text.replace(/\s+/g, ' ').trim().slice(0, 40);
    // a slash command is written as "<command-name>/name</command-name>…<command-args>…" rather than as typed
    const slash = /^\/([\w:.-]+)/.exec(text.trim()), cmdKey = slash && `<command-name>/${slash[1]}</command-name>`;
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const size = fs.statSync(file).size; if (size <= from) continue;
        const fd = fs.openSync(file, 'r'), b = Buffer.alloc(Math.min(size - from, 4 << 20)); fs.readSync(fd, b, 0, b.length, from); fs.closeSync(fd);
        for (const l of b.toString('utf8').split('\n')) {
          if (!l.includes('"user"') && !l.includes('"queue-operation"')) continue;
          let j; try { j = JSON.parse(l); } catch { continue; }
          const c = j.message && j.message.content, t = typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x && x.text || '').join(' ') : '';
          if (j.type === 'user' && (t.replace(/\s+/g, ' ').includes(key) || (cmdKey && t.includes(cmdKey)))) return true;
          // sent while the session works: it is queued first ("queue-operation" enqueue) and taken in later
          if (j.type === 'queue-operation' && j.operation === 'enqueue' && String(j.content || '').replace(/\s+/g, ' ').includes(key)) return true;
        }
      } catch {}
    }
    return false;
  }
  // type `text` into the session in the Claude app and press Send (text null = press Stop); one at a time. -> { ok, why }
  function sessionSend(sessionId, text) {
    const run = async () => {
      const s = sessFor(sessionId), no = refuse(s); if (no) return no;
      const file = transcriptOf(sessionId), from = file ? fs.statSync(file).size : 0;
      const cmd = { cmd: 'send', title: s.title, link: linkOf(s) };
      if (text === null) cmd.stop = true; else cmd.text = text;
      const r = await claudeUi.send(cmd, 30000);
      log(`console ${text === null ? 'stop' : 'send'} "${s.title}": ${r.ok ? 'ok' : r.why}`);
      if (!r.ok || text === null) return { ok: !!r.ok, why: r.why };
      if (rewound.has(sessionId) && Date.now() - rewound.get(sessionId).at > 15 * 60000) rewound.delete(sessionId);   // stale (undone in the app, or never continued)
      if (rewound.has(sessionId)) return followRewind(sessionId, text);
      if (file && !(await landed(file, from, text))) return { ok: false, why: 'sent, but it has not shown up in the session yet' };
      return { ok: true };
    };
    return (sendQ = sendQ.then(run, run));
  }
  // stage 5 step 5: a message's Fork from here / Rewind to here / the app's Undo rewind -> { ok, why, draft, title }
  // A rewind is kept in `rewound` until the next message; that send then finds the new transcript (followRewind)
  const rewound = new Map();   // sessionId -> { at, dir }
  function sessionMsgAct(sessionId, act, text, back) {
    const run = async () => {
      const s = sessFor(sessionId), no = refuse(s); if (no) return no;
      const file = transcriptOf(sessionId);
      const r = await claudeUi.send({ cmd: 'msgact', title: s.title, link: linkOf(s), act, text, back }, 30000);
      log(`console ${act} "${s.title}" at "${String(text || '').slice(0, 40)}": ${r.ok ? 'ok' + (act === 'fork' ? ` -> "${r.page}"` : '') : r.why}`);
      if (!r.ok) return { ok: false, why: r.why };
      if (act === 'rewind' && file) rewound.set(sessionId, { at: Date.now(), dir: path.dirname(file) });
      if (act === 'undo') rewound.delete(sessionId);
      return { ok: true, draft: String(r.draft || '').trim(), title: act === 'fork' ? String(r.page || '') : '' };
    };
    return (sendQ = sendQ.then(run, run));
  }
  // the first message after a rewind: the app's new transcript in the same folder, born after the rewind, holding the text
  // near its end; the console's reader moves to it
  // the start of a message as it is written in a transcript line (JSON-escaped): up to 40 characters before the first line
  // break or double space, so a multi-line message is found too
  const rawKey = text => JSON.stringify((text.trim().split(/\r?\n|\t| {2}/).find(x => x.trim()) || '').trim().slice(0, 40)).slice(1, -1);
  async function followRewind(sessionId, text) {
    const rw = rewound.get(sessionId), key = rawKey(text);
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      let names = []; try { names = fs.readdirSync(rw.dir).filter(f => f.endsWith('.jsonl')); } catch {}
      for (const f of names) {
        const p = path.join(rw.dir, f); let st; try { st = fs.statSync(p); } catch { continue; }
        if (st.birthtimeMs < rw.at - 2000) continue;
        try { const len = Math.min(st.size, 1 << 20), fd = fs.openSync(p, 'r'), b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd); if (!b.toString('utf8').includes(key)) continue; } catch { continue; }
        rewound.delete(sessionId); moved.set(sessionId, p);
        log(`console rewind: "${(sessFor(sessionId) || {}).title}" continues in ${f}`);
        if (conId === sessionId && win && !win.isDestroyed()) {   // the open console reads the new file from the start
          if (conRd) conRd.close();
          conRd = require('./transcript').open(p, (msgs, init, pending) => { if (conId === sessionId && win && !win.isDestroyed()) win.webContents.send('console-msg', { sessionId, msgs, init, pending }); });
        }
        return { ok: true };
      }
    }
    return { ok: false, why: 'sent, but the rewound conversation was not found' };
  }
  const linkOf = s => s.link || (/^new:/.test(s.sessionId) ? null : 'claude://claude.ai/epitaxy/' + s.sessionId);
  function refuse(s) {
    if (!s) return { ok: false, why: 'unknown session' };
    if (!s.title) return { ok: false, why: 'the new session has no name in the Claude app yet: try again in a moment' };
    if (overlay || opening) return { ok: false, why: 'close the Claude card first' };
    // the app's sessions are found by name: with two of the same name the action could land in the other one
    if ((lastFeed.sessions || []).filter(x => x && x.title === s.title).length > 1) return { ok: false, why: 'another session has the same name: rename one in the Claude app first' };
    if (process.env.SPHERE_USERDATA && !process.env.SPHERE_SEND_OK) return { ok: false, why: 'test instance: sending is off' };   // tests never type into real sessions
    return null;
  }
  // the last ~1 MB of a transcript -> what the session waits on (transcript.pendingOf)
  function pendingNow(file) {
    try {
      const size = fs.statSync(file).size, len = Math.min(size, 1 << 20), fd = fs.openSync(file, 'r'), b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, size - len); fs.closeSync(fd);
      return require('./transcript').pending(b.toString('utf8'));
    } catch { return null; }
  }
  // has the tool call `id` got its result since byte `from`? (polls up to 6 s)
  async function answered(file, from, id) {
    const key = `"tool_use_id":"${id}"`;
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const size = fs.statSync(file).size; if (size <= from) continue;
        const fd = fs.openSync(file, 'r'), b = Buffer.alloc(Math.min(size - from, 4 << 20)); fs.readSync(fd, b, 0, b.length, from); fs.closeSync(fd);
        if (b.toString('utf8').includes(key)) return true;
      } catch {}
    }
    return false;
  }
  // answer the session's pop-up question: answers = [{ picks: [label], other }] in question order -> { ok, why }
  function sessionAnswer(sessionId, answers) {
    const run = async () => {
      const s = sessFor(sessionId), no = refuse(s); if (no) return no;
      const file = transcriptOf(sessionId); if (!file) return { ok: false, why: 'no transcript for this session' };
      const p = pendingNow(file);
      if (!p || p.kind !== 'ask') return { ok: false, why: 'it is not asking anything now' };
      if (answers.length !== p.questions.length) return { ok: false, why: 'answer every question' };
      const out = [];
      for (let i = 0; i < answers.length; i++) {
        const a = answers[i], q = p.questions[i], other = String(a.other || '').trim();
        const picks = (other ? [] : a.picks).map(l => q.options.find(o => o.label === l));
        if (!other && (!picks.length || picks.some(x => !x) || (!q.multiSelect && picks.length > 1))) return { ok: false, why: `pick an option for "${q.header || q.question}"` };
        out.push({ picks, other, multi: q.multiSelect });
      }
      const from = fs.statSync(file).size;
      const r = await claudeUi.send({ cmd: 'answer', title: s.title, link: linkOf(s), answers: out }, 40000);
      log(`console answer "${s.title}": ${r.ok ? 'ok' : r.why}`);
      if (!r.ok) return { ok: false, why: r.why };
      if (!(await answered(file, from, p.id))) return { ok: false, why: 'answered, but the session has not taken it yet' };
      return { ok: true };
    };
    return (sendQ = sendQ.then(run, run));
  }
  function sessionPermit(sessionId, choice, id) {
    const run = async () => {
      const s = sessFor(sessionId), no = refuse(s); if (no) return no;
      // only the request the console showed (it may have been answered in the app meanwhile, and a newer one would get this choice)
      if (id) { const f = transcriptOf(sessionId), p = f && pendingNow(f); if (!p || p.kind !== 'tool' || p.id !== id) return { ok: false, why: 'that request is no longer waiting' }; }
      const r = await claudeUi.send({ cmd: 'permit', title: s.title, link: linkOf(s), choice }, 30000);
      log(`console permit "${s.title}" ${choice}: ${r.ok ? 'ok ' + (r.what || '') : r.why}`);
      return { ok: !!r.ok, why: r.why };
    };
    return (sendQ = sendQ.then(run, run));
  }
  // plan approval: choice accept | auto | revise (text) | reject; confirmed by the transcript, as answers are -> { ok, why }
  function sessionPlan(sessionId, choice, text) {
    const run = async () => {
      const s = sessFor(sessionId), no = refuse(s); if (no) return no;
      const file = transcriptOf(sessionId); if (!file) return { ok: false, why: 'no transcript for this session' };
      const p = pendingNow(file);
      if (!p || p.kind !== 'plan') return { ok: false, why: 'it is not waiting on a plan now' };
      if (choice === 'revise' && !String(text || '').trim()) return { ok: false, why: 'say what to change' };
      const from = fs.statSync(file).size;
      const r = await claudeUi.send({ cmd: 'plan', title: s.title, link: linkOf(s), choice, text: String(text || '') }, 30000);
      log(`console plan "${s.title}" ${choice}: ${r.ok ? 'ok' : r.why}`);
      if (!r.ok) return { ok: false, why: r.why };
      if (!(await answered(file, from, p.id))) return { ok: false, why: 'pressed, but the session has not taken it yet' };
      return { ok: true };
    };
    return (sendQ = sendQ.then(run, run));
  }
  // the newest transcript written since t0 whose user lines hold `text` (polls up to 10 s)
  async function findNewTranscript(t0, text) {
    const root = P.transcripts(), key = rawKey(text);
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      const c = [];
      try { for (const d of fs.readdirSync(root)) { let fs2; try { fs2 = fs.readdirSync(path.join(root, d)); } catch { continue; }
        for (const f of fs2) if (f.endsWith('.jsonl')) { const p = path.join(root, d, f); try { const st = fs.statSync(p); if (st.mtimeMs >= t0 - 2000 && st.birthtimeMs >= t0 - 60000) c.push([st.mtimeMs, p]); } catch {} } } } catch {}
      for (const [, p] of c.sort((a, b) => b[0] - a[0])) { try { if (fs.readFileSync(p, 'utf8').slice(0, 1 << 20).includes(key)) return p; } catch {} }
    }
    return null;
  }
  const MODELS = ['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 5.5'];
  // ---- stage 4 (SessionConsole_Stage4): session settings, housekeeping, attachments ----
  const PERM_MODES = ['Auto', 'Manual', 'Accept edits', 'Plan', 'Bypass permissions'];
  const EFFORTS = ['Low', 'Medium', 'High', 'Extra', 'Max', 'Ultracode'];
  const MODE_OF = { auto: 'Auto', default: 'Manual', acceptEdits: 'Accept edits', plan: 'Plan', bypassPermissions: 'Bypass permissions' };
  // what a change set in the app says until the feed / transcript shows it: sessionId -> { model, effort, mode, fast, at }
  const setOver = new Map();
  // the mode on the last message sent (transcript "permissionMode") and when -> { mode, at } or null
  function modeOf(file) {
    try {
      const size = fs.statSync(file).size, len = Math.min(size, 1 << 20), fd = fs.openSync(file, 'r'), b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, size - len); fs.closeSync(fd);
      const t = b.toString('utf8'), i = t.lastIndexOf('"permissionMode":"'); if (i < 0) return null;
      const m = /^"permissionMode":"(\w+)"/.exec(t.slice(i)), ln = t.slice(t.lastIndexOf('\n', i) + 1, t.indexOf('\n', i) < 0 ? t.length : t.indexOf('\n', i));
      const ts = /"timestamp":"([^"]+)"/.exec(ln);
      return m && MODE_OF[m[1]] ? { mode: MODE_OF[m[1]], at: ts ? Date.parse(ts[1]) || 0 : 0 } : null;
    } catch { return null; }
  }
  // { model, effort, mode, fast } of a session without opening it: the feed (model, effort), the transcript (mode), then what we set
  function settingsOf(sessionId) {
    const s = sessFor(sessionId); if (!s) return { ok: false, why: 'unknown session' };
    const e = String(s.effort || ''), file = transcriptOf(sessionId), md = file && modeOf(file);
    const o = { ok: true, model: s.model || '', effort: e ? e[0].toUpperCase() + e.slice(1).toLowerCase() : '', mode: md ? md.mode : '', fast: null };
    const v = setOver.get(sessionId);
    if (v) {   // model / effort / fast for 15 min (the feed catches up); the mode until a later message carries one
      if (Date.now() - v.at < 15 * 60000) for (const k of ['model', 'effort', 'fast']) if (v[k] != null && v[k] !== '') o[k] = v[k];
      if (v.mode && !(md && md.at > v.at)) o.mode = v.mode;
    }
    return o;
  }
  // {what: mode | model | effort | fast, value} in the Claude app -> settingsOf after it
  function sessionSet(sessionId, what, value) {
    const run = async () => {
      const s = sessFor(sessionId), no = refuse(s); if (no) return no;
      const r = await claudeUi.send({ cmd: 'set', title: s.title, link: linkOf(s), what, value }, 30000);
      log(`console set "${s.title}" ${what}=${value}: ${r.ok ? `ok (${r.model} / ${r.effort} / ${r.mode})` : r.why}`);
      if (!r.ok) return { ok: false, why: r.why };
      const v = { at: Date.now() };
      for (const k of ['model', 'effort', 'mode']) if (r[k]) v[k] = r[k];
      if (typeof r.fast === 'boolean') v.fast = r.fast;
      setOver.set(sessionId, v);
      return settingsOf(sessionId);
    };
    return (sendQ = sendQ.then(run, run));
  }
  // housekeeping: act rename (name) | fork | archive | delete -> { ok, why, title }
  function sessionManage(sessionId, act, name) {
    const run = async () => {
      const s = sessFor(sessionId), no = refuse(s); if (no) return no;
      const r = await claudeUi.send({ cmd: 'manage', title: s.title, link: linkOf(s), act, name }, 30000);
      log(`console ${act} "${s.title}"${act === 'rename' ? ` -> "${name}"` : ''}: ${r.ok ? 'ok' : r.why}`);
      if (r.ok && act === 'rename') { s.title = r.title || name; const n = newOnes.get(sessionId); if (n) n.title = s.title; }   // until the feed has it (a new: session's entry is the one sessFor reads)
      return { ok: !!r.ok, why: r.why || '', title: r.title || '' };
    };
    return (sendQ = sendQ.then(run, run));
  }
  // a reply with files: paths (dropped files) + pasted images (PNG bytes, saved to temp files deleted a minute after) -> { ok, why }
  function sessionAttach(sessionId, paths, pngs, text) {
    const run = async () => {
      const s = sessFor(sessionId), no = refuse(s); if (no) return no;
      const dir = path.join(app.getPath('temp'), 'SessionSphere'), tmp = [];
      try { fs.mkdirSync(dir, { recursive: true }); pngs.forEach((b, i) => { const f = path.join(dir, `paste_${Date.now()}_${i}.png`); fs.writeFileSync(f, b); tmp.push(f); }); } catch (e) { return { ok: false, why: 'cannot save the pasted image' }; }
      const file = transcriptOf(sessionId), from = file ? fs.statSync(file).size : 0;
      const r = await claudeUi.send({ cmd: 'attach', title: s.title, link: linkOf(s), files: [...paths, ...tmp], text }, 60000);
      log(`console attach "${s.title}" (${paths.length + tmp.length} file(s)): ${r.ok ? 'ok' : r.why}`);
      setTimeout(() => tmp.forEach(f => fs.unlink(f, () => {})), 60000);
      if (!r.ok) return { ok: false, why: r.why };
      if (rewound.has(sessionId)) return followRewind(sessionId, text || path.basename(paths[0] || ''));
      if (text && file && !(await landed(file, from, text))) return { ok: false, why: 'sent, but it has not shown up in the session yet' };
      return { ok: true };
    };
    return (sendQ = sendQ.then(run, run));
  }
  // start a session in the Claude app: folder from the app's recent list, model (null = the app's choice), first message -> { ok, why, sessionId, title }
  function sessionNew(folder, model, text, worktree) {
    const run = async () => {
      if (overlay || opening) return { ok: false, why: 'close the Claude card first' };
      if (process.env.SPHERE_USERDATA && !process.env.SPHERE_SEND_OK) return { ok: false, why: 'test instance: sending is off' };
      const t0 = Date.now(), r = await claudeUi.send({ cmd: 'newsession', folder, model, text, worktree: worktree == null ? undefined : !!worktree }, 40000);
      log(`console new session in ${folder}${worktree ? ' (worktree)' : ''} (${model || 'default'}): ${r.ok ? 'ok "' + r.title + '"' : r.why}`);
      if (!r.ok) return { ok: false, why: r.why };
      const file = await findNewTranscript(t0, text);
      log('console new session transcript: ' + (file || 'not found'));
      if (!file) return { ok: false, why: 'started, but its transcript was not found' };
      const sessionId = 'new:' + path.basename(file, '.jsonl');
      // not named within 9 s: no title (the folder path is no session's name, actions could never find it); sessFor finds it later
      const title = r.title && r.title !== 'New session' ? r.title : '';
      newOnes.set(sessionId, { file, title });
      return { ok: true, sessionId, title: title || path.basename(folder) };
    };
    return (sendQ = sendQ.then(run, run));
  }
  // project folders the app knows, most sessions first
  function folders() {
    const n = new Map(); for (const s of lastFeed.sessions || []) if (s.folder) n.set(s.folder, (n.get(s.folder) || 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  }
  // permission requests (SessionConsole_Stage3 step 4): while some session has a tool call open for over 2 s, read the Claude app's
  // sidebar every 2 s. "Awaiting input" = it asks (true), "Running" = a slow tool (false); anything else or unreadable = unknown
  const awaiting = new Map();   // sessionId -> true / false
  const awaitOf = id => (awaiting.has(id) ? awaiting.get(id) : null);
  let awBusy = false, awAt = 0, trayNoted = null;
  async function awaitPoll() {
    if (awBusy) return; awBusy = true;
    try {
      const files = feed.transcriptFiles(), want = [], tw = require('./transcripts').toolWait;
      for (const [id, n] of newOnes) files.set(id, n.file);
      for (const [id, f] of files) if (tw(f)) want.push(id);
      // each read costs ~0.04 cores at 2 s: every 2 s for the open conversation, every 6 s for the tiles
      if (want.length && !want.includes(conId) && Date.now() - awAt < 5900) return;
      const next = new Map();
      if (want.length) {
        awAt = Date.now();
        const r = await claudeUi.send({ cmd: 'status' }, 5000).catch(() => null);
        // the Claude app in the tray: its sidebar statuses freeze, so say once per opened conversation that requests show as Running
        if (r && r.why === 'hidden' && conId && want.includes(conId) && trayNoted !== conId && win && !win.isDestroyed()) {
          trayNoted = conId; win.webContents.send('console-note', { sessionId: conId, text: 'The Claude app is in the tray: permission requests show as Running until it is opened.' });
        }
        if (r && r.ok && Array.isArray(r.rows)) {
          const by = new Map(r.rows.map(x => [x.t, x.s]));
          for (const id of want) { const s = sessFor(id), st = s && by.get(s.title); if (st === 'Awaiting input') next.set(id, true); else if (st === 'Running') next.set(id, false); }
        }
      }
      const changed = [...new Set([...awaiting.keys(), ...next.keys()])].filter(id => awaiting.get(id) !== next.get(id));
      if (!changed.length) return;
      awaiting.clear(); for (const [k, v] of next) awaiting.set(k, v);
      log('awaiting: ' + (next.size ? [...next].map(([k, v]) => `${(sessFor(k) || {}).title || k}=${v}`).join(', ') : 'none'));
      if (changed.some(id => awaiting.get(id) === true || lastFeed.sessions.some(x => x.sessionId === id))) feedOut();
      if (conId && changed.includes(conId) && win && !win.isDestroyed()) win.webContents.send('console-await', { sessionId: conId, awaiting: awaitOf(conId) });
    } finally { awBusy = false; }
  }
  if (!process.env.SPHERE_NO_AWAIT) setInterval(awaitPoll, 2000);   // SPHERE_NO_AWAIT=1: off (CPU comparisons)
  // the feed to the window: a session asking for permission (sidebar "Awaiting input") shows as waiting on the tiles
  // running background tasks per session (new ideas 4): every 5 s the transcripts changed in the last 6 h are read again when
  // they changed (repo.tasks); the feed carries bg: n (running commands and agents) for the Tasks tab and the tile's marker
  const bgOf = new Map(), bgSeen = new Map(); let bgBusy = false;
  // drafts (see draft-get below): read here, since feedOut marks them
  const draftsPath = path.join(app.getPath('userData'), 'drafts.json'), draftDir = path.join(app.getPath('userData'), 'drafts');
  let drafts = {}; try { drafts = JSON.parse(fs.readFileSync(draftsPath, 'utf8')) || {}; } catch {}
  async function bgScan() {
    if (bgBusy || !lastFeed || !Array.isArray(lastFeed.sessions)) return;
    bgBusy = true; let changed = false;
    try {
      const now = Date.now(), live = new Set();
      for (const s of lastFeed.sessions) {
        const id = s && String(s.sessionId); if (!id || !SID.test(id)) continue;
        const file = transcriptOf(id); if (!file) continue;
        let st; try { st = fs.statSync(file); } catch { continue; }
        if (now - st.mtimeMs > 6 * 3600e3) continue;
        live.add(id); const k = st.mtimeMs + ':' + st.size;
        if (bgSeen.get(id) === k) continue;
        bgSeen.set(id, k);
        let n = 0; try { const r = await require('./repo').tasks(file); n = r && r.ok ? r.tasks.filter(t => t.state === 'running').length : 0; } catch {}
        if ((bgOf.get(id) || 0) !== n) { changed = true; if (n) bgOf.set(id, n); else bgOf.delete(id); }
      }
      for (const id of [...bgOf.keys()]) if (!live.has(id)) { bgOf.delete(id); changed = true; }
    } finally { bgBusy = false; }
    if (changed) feedOut();
  }
  setInterval(bgScan, 5000);
  function feedOut() {
    if (!win || win.isDestroyed()) return;
    const f = lastFeed; if (!f || !Array.isArray(f.sessions)) return;
    const more = s => {
      let o = s; if (awaiting.get(s.sessionId) === true && s.activity !== 'waiting') o = { ...o, activity: 'waiting' };
      const b = bgOf.get(String(s.sessionId)); if (b) o = { ...o, bg: b };
      if (drafts[String(s.sessionId)]) o = { ...o, draft: true };
      return o;
    };
    win.webContents.send('feed', awaiting.size || bgOf.size || Object.keys(drafts).length ? { ...f, sessions: f.sessions.map(more) } : f);
  }
  const conStop = () => { if (conRd) conRd.close(); conRd = conId = null; };
  const SID = /^(new:)?[\w-]{1,80}$/;
  ipcMain.handle('console-open', (e, sessionId) => {
    if (!fromWin(e) || typeof sessionId !== 'string' || !SID.test(sessionId)) return { ok: false, why: 'bad session' };
    conStop(); trayNoted = null;
    const s = sessFor(sessionId);
    if (!s) return { ok: false, why: 'unknown session' };
    const file = transcriptOf(sessionId);
    if (!file) return { ok: false, why: 'no transcript for this session' };
    conId = sessionId;
    conRd = require('./transcript').open(file, (msgs, init, pending) => { if (conId === sessionId && win && !win.isDestroyed()) win.webContents.send('console-msg', { sessionId, msgs, init, pending }); });
    return { ok: true, title: s.title, link: linkOf(s), awaiting: awaitOf(sessionId) };
  });
  ipcMain.handle('console-answer', (e, sessionId, answers) => {
    if (!fromWin(e) || typeof sessionId !== 'string' || !SID.test(sessionId) || !Array.isArray(answers) || !answers.length || answers.length > 8) return { ok: false, why: 'bad request' };
    const a = answers.map(x => ({ picks: Array.isArray(x && x.picks) ? x.picks.filter(l => typeof l === 'string').slice(0, 12) : [], other: typeof (x && x.other) === 'string' ? x.other.slice(0, 2000) : '' }));
    return sessionAnswer(sessionId, a);
  });
  ipcMain.handle('console-permit', (e, sessionId, choice, id) => {
    if (!fromWin(e) || typeof sessionId !== 'string' || !SID.test(sessionId) || !['Allow once', 'Always allow', 'Deny'].includes(choice) || (id !== undefined && (typeof id !== 'string' || id.length > 200))) return { ok: false, why: 'bad request' };
    return sessionPermit(sessionId, choice, id);
  });
  ipcMain.handle('console-plan', (e, sessionId, choice, text) => {
    if (!fromWin(e) || typeof sessionId !== 'string' || !SID.test(sessionId) || !['accept', 'auto', 'edits', 'bypass', 'revise', 'reject'].includes(choice)) return { ok: false, why: 'bad request' };
    return sessionPlan(sessionId, choice, String(text || '').slice(0, 4000));
  });
  // stage 5: one block of the open session's transcript, read when the console opens it (detail.js)
  // kind: 'output' (a = tool_use id, b = all) | 'thinking' (a = [{ line, k }]) | 'agent' (a = tool_use id) | 'image' (a = line uuid, b = block index)
  const ID = /^[\w-]{1,100}$/;
  ipcMain.handle('console-detail', async (e, sessionId, kind, a, b) => {
    if (!fromWin(e) || typeof sessionId !== 'string' || !SID.test(sessionId)) return { ok: false, why: 'bad request' };
    const file = transcriptOf(sessionId); if (!file) return { ok: false, why: 'no transcript for this session' };
    const d = require('./detail');
    try {
      if (kind === 'output' && typeof a === 'string' && ID.test(a)) return await d.output(file, a, b === true);
      if (kind === 'agent' && typeof a === 'string' && ID.test(a)) return await d.agent(file, a);
      if (kind === 'image' && typeof a === 'string' && ID.test(a) && Number.isInteger(b) && b >= 0 && b < 500) return await d.image(file, a, b);
      if (kind === 'thinking' && Array.isArray(a) && a.length <= 20 && a.every(r => r && typeof r.line === 'string' && ID.test(r.line) && Number.isInteger(r.k) && r.k >= 0 && r.k < 500)) return await d.thinking(file, a);
    } catch (err) { return { ok: false, why: err.message }; }
    return { ok: false, why: 'bad request' };
  });
  // stage 5 composer: the app's "/" commands, read from its composer (claudeui commands) at most once a day and kept in
  // userData; a failed read is retried after 10 min. -> { ok, names, at }
  const cmdsPath = path.join(app.getPath('userData'), 'claude_commands.json');
  let cmdsBusy = null, cmdsFail = 0;
  function commandsOf(sessionId) {
    let c = null; try { c = JSON.parse(fs.readFileSync(cmdsPath, 'utf8')); } catch {}
    const have = c && Array.isArray(c.names) ? { ok: true, names: c.names, at: c.at || 0 } : { ok: false, names: [], at: 0, why: 'not read yet' };
    if (have.ok && Date.now() - have.at < 864e5) return have;
    if (cmdsBusy) return cmdsBusy;
    const s = sessFor(sessionId);
    if (refuse(s) || Date.now() - cmdsFail < 600000) return have;
    const run = async () => {
      const r = await claudeUi.send({ cmd: 'commands', title: s.title, link: linkOf(s) }, 20000);
      log(`console / commands from "${s.title}": ${r.ok ? r.names.length + ' names' : r.why}`);
      if (!r.ok || !Array.isArray(r.names) || !r.names.length) { cmdsFail = Date.now(); return have; }
      const o = { ok: true, names: r.names.filter(n => typeof n === 'string' && /^[\w:.-]{1,60}$/.test(n)).slice(0, 200), at: Date.now() };
      try { fs.writeFileSync(cmdsPath, JSON.stringify(o)); } catch {}
      return o;
    };
    return (cmdsBusy = (sendQ = sendQ.then(run, run)).finally(() => { cmdsBusy = null; }));
  }
  ipcMain.handle('console-commands', (e, sessionId) => {
    if (!fromWin(e) || typeof sessionId !== 'string' || !SID.test(sessionId)) return { ok: false, why: 'bad request' };
    return commandsOf(sessionId);
  });
  // the "@" list: the session's folder from disk (compose.js) -> { ok, root, entries: [{ p, d }] }
  ipcMain.handle('console-files', async (e, sessionId) => {
    if (!fromWin(e) || typeof sessionId !== 'string' || !SID.test(sessionId)) return { ok: false, why: 'bad request' };
    const file = transcriptOf(sessionId); if (!file) return { ok: false, why: 'no transcript for this session' };
    const c = require('./compose'), root = c.cwdOf(file);
    if (!root) return { ok: false, why: 'the session folder was not found' };
    try { return { ok: true, root, entries: await c.list(root) }; } catch (err) { return { ok: false, why: err.message }; }
  });
  ipcMain.handle('console-msgact', (e, sessionId, act, text, back) => {
    if (!fromWin(e) || typeof sessionId !== 'string' || !SID.test(sessionId) || !['fork', 'rewind', 'undo'].includes(act)) return { ok: false, why: 'bad request' };
    if (act !== 'undo' && (typeof text !== 'string' || !text.trim() || text.length > 20000 || !Number.isInteger(back) || back < 0 || back > 1000)) return { ok: false, why: 'bad request' };
    return sessionMsgAct(sessionId, act, act === 'undo' ? '' : text, act === 'undo' ? 0 : back);
  });
  // stage 5 tabs (repo.js): kind 'changes' | 'diff' (a = a file from the changes) | 'pr' | 'tasks' | 'artifacts'; read when a tab opens
  // Bridge_Spec: the native actions on a session's folder (git, gh, terminal, preview, editor, MCP) and the app places.
  // The folder is always the session's own (from its transcript), never one sent by the page.
  const ACTS = ['pushinfo', 'commit', 'push', 'prdraft', 'prcreate', 'worktrees', 'wtremove', 'terminal', 'previews', 'preview', 'files', 'open', 'reveal', 'mcp', 'mcpset', 'app'];
  ipcMain.handle('console-act', async (e, sessionId, act, a) => {
    if (!fromWin(e) || typeof sessionId !== 'string' || !SID.test(sessionId) || !ACTS.includes(act)) return { ok: false, why: 'bad request' };
    a = a && typeof a === 'object' ? a : {};
    const file = transcriptOf(sessionId); if (!file) return { ok: false, why: 'no transcript for this session' };
    const dir = require('./compose').cwdOf(file); if (!dir && act !== 'app') return { ok: false, why: 'the session folder was not found' };
    const r = require('./repo'), b = require('./bridge'), str = (v, n) => typeof v === 'string' && v.length <= n ? v : '';
    try {
      switch (act) {
        case 'pushinfo': return await r.pushInfo(dir);
        case 'commit': return await r.commit(dir, Array.isArray(a.files) ? a.files.filter(f => typeof f === 'string' && f.length <= 1000).slice(0, 2000) : [], str(a.msg, 5000));
        case 'push': return await r.push(dir);
        case 'prdraft': return await r.prDraft(dir);
        case 'prcreate': return await r.prCreate(dir, { title: str(a.title, 300), body: str(a.body, 20000), base: str(a.base, 100) });
        case 'worktrees': return await r.worktrees(dir);
        case 'wtremove': return await r.worktreeRemove(dir, str(a.path, 1000));
        case 'terminal': return await b.terminal(dir);
        case 'previews': return await b.previews(file, dir);
        case 'preview': { const u = str(a.url, 2000); if (!b.isLocal(u)) return { ok: false, why: 'only local addresses open from here' }; await shell.openExternal(u); return { ok: true }; }
        case 'files': {
          const c = require('./compose'), [entries, ch] = await Promise.all([c.list(dir), r.changes(dir)]);
          const rootRel = ch.ok ? path.relative(dir, ch.root).replace(/\\/g, '/') : '';   // changes are from the repository root; the tree is from the session folder
          const changed = ch.ok ? ch.files.map(f => ({ p: path.relative(dir, path.join(ch.root, f.file)).replace(/\\/g, '/'), add: f.add, del: f.del, untracked: !!f.untracked })).filter(f => !f.p.startsWith('..')) : [];
          return { ok: true, root: dir, entries, changed, branch: ch.ok ? ch.branch : '', repoRoot: rootRel, worktree: ch.ok && await r.isWorktree(dir) };
        }
        case 'open': return await b.openFile(dir, str(a.file, 1000), a.line, settings.editor, settings.editorCmd, shell);
        case 'reveal': { const f = b.inside(dir, str(a.file, 1000)); if (!f) return { ok: false, why: 'bad path' }; shell.showItemInFolder(f); return { ok: true }; }
        case 'mcp': return b.mcpList(dir);
        case 'mcpset': return b.mcpSet(dir, str(a.name, 200), a.on === true);
        case 'app': {   // Remote Control, Move to cloud, Connectors: the Claude app at this session, where you click the option
          const s = sessFor(sessionId), link = s && linkOf(s); if (!link) return { ok: false, why: 'this session has no link in the Claude app yet' };
          openLink(link); return { ok: true };
        }
      }
    } catch (err) { return { ok: false, why: err.message }; }
    return { ok: false, why: 'bad request' };
  });
  // local routine prompts (~/.claude/scheduled-tasks): list, read, save
  ipcMain.handle('routine-prompts', (e, act, id, text) => {
    if (!(fromWin(e) || fromSettings(e))) return { ok: false, why: 'bad request' };
    const b = require('./bridge');
    if (act === 'list') return b.routines();
    if (act === 'read') return b.routineRead(id);
    if (act === 'save') return b.routineSave(id, text);
    return { ok: false, why: 'bad request' };
  });
  ipcMain.handle('console-pane', async (e, sessionId, kind, a) => {
    if (!fromWin(e) || typeof sessionId !== 'string' || !SID.test(sessionId) || !['changes', 'diff', 'pr', 'tasks', 'artifacts'].includes(kind)) return { ok: false, why: 'bad request' };
    const file = transcriptOf(sessionId); if (!file) return { ok: false, why: 'no transcript for this session' };
    const r = require('./repo');
    try {
      if (kind === 'tasks') return await r.tasks(file);
      if (kind === 'artifacts') return await r.artifacts(file);
      const dir = require('./compose').cwdOf(file); if (!dir) return { ok: false, why: 'the session folder was not found' };
      if (kind === 'changes') { const c = await r.changes(dir); return { ...c, dir, worktree: c.ok && await r.isWorktree(dir) }; }
      if (kind === 'pr') return r.pr(dir);
      if (typeof a !== 'string' || !a || a.length > 1000 || /^[\\/]|\.\.(\/|\\|$)|^[a-z]:/i.test(a)) return { ok: false, why: 'bad request' };
      return r.fileDiff(dir, a);
    } catch (err) { return { ok: false, why: err.message }; }
  });
  // stage 5 step 6: the search box over the session rows (search.js); a newer search cancels the one before
  // o (new ideas 3, the chips under the box): { who: 'user' | 'assistant', folder: a session folder name, since: ms }
  ipcMain.handle('search', async (e, text, o) => {
    if (!fromWin(e) || typeof text !== 'string' || text.length > 200) return { ok: false, why: 'bad request' };
    o = o && typeof o === 'object' ? o : {};
    const opts = { who: ['user', 'assistant'].includes(o.who) ? o.who : null, since: Number.isFinite(o.since) && o.since > 0 ? o.since : 0 };
    const folder = typeof o.folder === 'string' && o.folder.length <= 300 ? o.folder : null;
    const list = [];
    for (const s of lastFeed.sessions || []) { const id = s && String(s.sessionId); if (!id || !SID.test(id) || (folder && (s.folder || 'Other') !== folder)) continue; const file = transcriptOf(id); if (file) list.push({ sessionId: id, title: s.title || '', file }); }
    try { return await require('./search').search(list, text, opts); } catch (err) { return { ok: false, why: err.message }; }
  });
  // a hit older than what the console holds: the messages around it (off = the byte where its transcript line starts)
  ipcMain.handle('console-around', (e, sessionId, off) => {
    if (!fromWin(e) || typeof sessionId !== 'string' || !SID.test(sessionId) || !Number.isFinite(off) || off < 0) return { ok: false, why: 'bad request' };
    const file = transcriptOf(sessionId); if (!file) return { ok: false, why: 'no transcript for this session' };
    try { return { ok: true, msgs: require('./search').around(file, off) }; } catch (err) { return { ok: false, why: err.message }; }
  });
  // a link in a reply: opened in the browser (http / https only)
  ipcMain.on('open-url', (e, u) => {
    if (!fromWin(e) || typeof u !== 'string' || u.length > 2000) return;
    let x; try { x = new URL(u); } catch { return; }
    if (x.protocol === 'https:' || x.protocol === 'http:') shell.openExternal(x.href).catch(() => {});
  });
  ipcMain.handle('console-settings', (e, sessionId) => {
    if (!fromWin(e) || typeof sessionId !== 'string' || !SID.test(sessionId)) return { ok: false, why: 'bad request' };
    return settingsOf(sessionId);
  });
  ipcMain.handle('console-set', (e, sessionId, what, value) => {
    const okv = what === 'mode' ? PERM_MODES.includes(value) : what === 'model' ? MODELS.includes(value) : what === 'effort' ? EFFORTS.includes(value) : what === 'fast' ? typeof value === 'boolean' : false;
    if (!fromWin(e) || typeof sessionId !== 'string' || !SID.test(sessionId) || !okv) return { ok: false, why: 'bad request' };
    return sessionSet(sessionId, what, value);
  });
  ipcMain.handle('console-manage', (e, sessionId, act, name) => {
    const nm = typeof name === 'string' ? name.replace(/[\r\n]+/g, ' ').trim().slice(0, 200) : '';
    if (!fromWin(e) || typeof sessionId !== 'string' || !SID.test(sessionId) || !['rename', 'fork', 'archive', 'delete'].includes(act) || (act === 'rename' && !nm)) return { ok: false, why: 'bad request' };
    return sessionManage(sessionId, act, nm);
  });
  // files: paths of dropped files; pngs: pasted images as PNG bytes (at most 8 files, 20 MB each)
  // a network (UNC) path is refused before it is touched: a stat of \\host\share would make Windows sign in to that host
  ipcMain.handle('console-attach', (e, sessionId, files, pngs, text) => {
    if (!fromWin(e)) return { ok: false, why: 'bad request' };
    const local = f => typeof f === 'string' && /^[a-z]:[\\/]/i.test(f);
    if (Array.isArray(files) && files.some(f => typeof f === 'string' && /^[\\/]{2}/.test(f))) return { ok: false, why: 'network paths cannot be attached' };
    const ps = Array.isArray(files) ? files.filter(f => local(f) && (() => { try { return fs.statSync(f).isFile(); } catch { return false; } })()) : [];
    const bs = Array.isArray(pngs) ? pngs.filter(b => b instanceof Uint8Array && b.length > 8 && b.length < 20 << 20 && b[0] === 0x89 && b[1] === 0x50).map(b => Buffer.from(b)) : [];
    if (!fromWin(e) || typeof sessionId !== 'string' || !SID.test(sessionId) || !(ps.length + bs.length) || ps.length + bs.length > 8 || typeof text !== 'string' || text.length > 20000) return { ok: false, why: 'bad request' };
    if (ps.length !== (files || []).length) return { ok: false, why: 'a dropped item is not a file' };
    return sessionAttach(sessionId, ps, bs, text.trim());
  });
  // ---- drafts (new ideas 1): each session's unsent reply and its attachments, kept until sent or emptied; on disk in
  // userData/drafts.json, a pasted picture as userData/drafts/<session>/<name>.png. The feed marks those sessions draft: true ----
  const dirOf = id => path.join(draftDir, id.replace(/[^\w-]/g, '_'));
  const saveDrafts = () => { try { fs.writeFileSync(draftsPath, JSON.stringify(drafts)); } catch (err) { log('drafts not saved: ' + err.message); } };
  // files no longer in the draft go a minute later (a reply just sent may still be reading them)
  const sweep = id => setTimeout(() => {
    const d = dirOf(id), keep = new Set(((drafts[id] || {}).atts || []).map(a => a.path));
    let names = []; try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) if (!keep.has(path.join(d, n))) try { fs.unlinkSync(path.join(d, n)); } catch {}
    try { if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch {}
  }, 60000);
  setTimeout(() => {   // at start: pictures left by drafts that went while the app was closing
    const keep = new Set(Object.values(drafts).flatMap(d => (d.atts || []).map(a => a.path)));
    let dirs = []; try { dirs = fs.readdirSync(draftDir); } catch { return; }
    for (const n of dirs) {
      const d = path.join(draftDir, n); let fl = []; try { fl = fs.readdirSync(d); } catch { continue; }
      for (const f of fl) if (!keep.has(path.join(d, f))) try { fs.unlinkSync(path.join(d, f)); } catch {}
      try { if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch {}
    }
  }, 5000);
  ipcMain.handle('draft-get', (e, id) => {
    if (!fromWin(e) || typeof id !== 'string' || !SID.test(id)) return null;
    const d = drafts[id]; if (!d) return null;
    const png = f => { try { return new Uint8Array(fs.readFileSync(f)); } catch { return null; } };   // a picture's bytes for its chip
    return { text: d.text, atts: d.atts.map(a => ({ ...a, gone: !fs.existsSync(a.path), png: a.img ? png(a.path) : null })) };
  });
  // files: [{ name, path, img }] already on disk; pngs: [{ name, png }] pasted pictures to keep -> { ok, atts } (the draft's files)
  ipcMain.handle('draft-set', (e, id, text, files, pngs) => {
    if (!fromWin(e) || typeof id !== 'string' || !SID.test(id) || typeof text !== 'string' || text.length > 20000 || !Array.isArray(files) || !Array.isArray(pngs) || files.length + pngs.length > 8) return { ok: false, why: 'bad request' };
    const atts = [];
    for (const f of files) if (f && typeof f.path === 'string' && /^[a-z]:[\\/]/i.test(f.path) && f.path.length < 1000) atts.push({ name: String(f.name || path.basename(f.path)).slice(0, 200), path: f.path, img: !!f.img });
    for (const p of pngs) {
      const b = p && p.png; if (!(b instanceof Uint8Array) || b.length < 9 || b.length >= 20 << 20 || b[0] !== 0x89 || b[1] !== 0x50) continue;
      const d = dirOf(id); let nm = String(p.name || 'image').replace(/[^\w .()-]/g, '_').replace(/\.png$/i, '').slice(0, 80) || 'image', f = path.join(d, nm + '.png');
      for (let i = 2; fs.existsSync(f) || atts.some(a => a.path === f); i++) f = path.join(d, `${nm} (${i}).png`);
      try { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(f, Buffer.from(b)); atts.push({ name: path.basename(f), path: f, img: true }); } catch (err) { log('draft picture not saved: ' + err.message); }
    }
    const had = !!drafts[id];
    if (text.trim() || atts.length) drafts[id] = { text, atts, at: Date.now() }; else delete drafts[id];
    saveDrafts(); sweep(id);
    if (had !== !!drafts[id]) feedOut();
    return { ok: true, atts };
  });
  ipcMain.handle('console-folders', e => fromWin(e) ? { folders: folders(), models: MODELS } : null);
  ipcMain.handle('console-new', (e, folder, model, text, worktree) => {
    if (!fromWin(e) || typeof folder !== 'string' || !folders().includes(folder) || (model != null && !MODELS.includes(model)) || typeof text !== 'string' || !text.trim() || text.length > 20000) return { ok: false, why: 'bad request' };
    return sessionNew(folder, model || null, text.trim(), !!worktree);
  });
  ipcMain.handle('console-close', e => { if (fromWin(e)) conStop(); });
  ipcMain.handle('console-send', (e, sessionId, text) => {
    if (!fromWin(e) || typeof sessionId !== 'string' || !SID.test(sessionId) || typeof text !== 'string' || !text.trim() || text.length > 20000) return { ok: false, why: 'bad request' };
    if (/^new:/.test(sessionId) && !sessFor(sessionId)) return { ok: false, why: 'unknown session' };
    return sessionSend(sessionId, text);
  });
  ipcMain.handle('console-stop', (e, sessionId) => {
    if (!fromWin(e) || typeof sessionId !== 'string' || !SID.test(sessionId)) return { ok: false, why: 'bad request' };
    return sessionSend(sessionId, null);
  });
  ipcMain.handle('console-auto', e => fromWin(e) ? process.env.SPHERE_CONSOLE || null : null);   // test hook: the renderer opens this session's view once the feed is in
  // mask: a transparent window over the chat card that hides Claude's title bar and rounds the corners; it takes the
  // pointer only outside the rounded card, and a click there counts as a click outside
  let mask = null, maskRaise = null;
  const fromMask = e => !!mask && !mask.isDestroyed() && e.sender === mask.webContents;
  function showMask(rect, th) {
    if (!win || win.isDestroyed()) return;
    if (!mask || mask.isDestroyed()) {
      mask = new BrowserWindow({ transparent: true, frame: false, hasShadow: false, skipTaskbar: true, focusable: false, resizable: false, movable: false,
        show: false, backgroundColor: '#00000000', webPreferences: { preload: path.join(__dirname, 'preload.js') } });
      mask.setIgnoreMouseEvents(true, { forward: true });
      mask.webContents.on('render-process-gone', () => { const m = mask; if (m && !m.isDestroyed()) m.destroy(); mask = null; });
      mask.loadFile(path.join(__dirname, 'renderer', 'mask.html'));
    }
    const m = mask, b = win.getContentBounds(), pad = 2;
    m.setBounds({ x: Math.round(b.x + rect.x - pad), y: Math.round(b.y + rect.y - th - pad), width: Math.round(rect.w + 2 * pad), height: Math.round(rect.h + th + 2 * pad) });
    const send = () => { if (!m.isDestroyed()) m.webContents.send('mask', { pad, th, r: 14 }); };
    if (m.webContents.isLoading()) m.webContents.once('did-finish-load', send); else send();
    m.setAlwaysOnTop(true, 'screen-saver'); m.showInactive(); m.moveTop();
    // clicking into the chat raises Claude above the mask: lift the mask back on top
    clearInterval(maskRaise); maskRaise = setInterval(() => { if (mask && !mask.isDestroyed() && mask.isVisible()) mask.moveTop(); }, 150);
  }
  function hideMask() { clearInterval(maskRaise); if (mask && !mask.isDestroyed()) mask.hide(); }
  ipcMain.on('mask-hit', (e, over) => { if (fromMask(e)) mask.setIgnoreMouseEvents(!over, { forward: true }); });
  ipcMain.on('mask-click', e => { if (!fromMask(e)) return; closeReq++; overlayOff(); });
  // clicking any other window counts as clicking outside: put the Claude window back and fold
  let fgBusy = false;
  setInterval(async () => {
    if (!overlay || fgBusy || Date.now() < graceUntil) return;
    fgBusy = true;                                 // one check at a time: a slow helper never piles them up
    try {
      const f = await claudeUi.send({ cmd: 'fg' }, 5000);
      if (overlay && Date.now() >= graceUntil && f.claude === false && !settings.keepCardsOpen && !(settingsWin && !settingsWin.isDestroyed() && settingsWin.isFocused())) { closeReq++; overlayOff(); }
    } finally { fgBusy = false; }
  }, 700);
  // quit: put the Claude window back first (waits for it, up to 3 s), save the settings, stop the helpers
  let quitting = false;
  app.on('before-quit', e => {
    if (quitting) return;
    quitting = true; flushSettings();
    const stop = () => { theseusStop(); claudeUi.stop(); zorder.stop(); if (builtin) builtin.dispose(); };
    const recBusy = !!(rec && rState && (rState.recording || rState.replay));
    if (!overlay && !recBusy) return stop();
    e.preventDefault();
    const cap = ms => new Promise(r => setTimeout(r, ms));
    const back = overlay ? Promise.race([claudeUi.send({ cmd: 'restore', hide: overlay.hidden || settings.claudeTray }, 3000), cap(3000)]) : null;
    // a recording is ended cleanly and saved as .mp4, the replay ring stopped and cleared (up to 20 s; else the .mkv is kept)
    const recDone = recBusy ? Promise.race([Promise.allSettled([rState.recording && rec.stop(), rState.replay && rec.setReplay(false)]), cap(20000)]) : null;
    Promise.allSettled([back, recDone]).finally(() => { stop(); app.quit(); });
  });
  // ================= Theseus tools: audio, recorder, strip, hotkeys, readout, voice commands (src/audio.js and src/recorder.js are optional) =================
  const logFile = path.join(app.getPath('userData'), 'theseus.log');
  try { if (fs.statSync(logFile).size > 200000) fs.writeFileSync(logFile, ''); } catch {}
  const log = m => { console.log('[theseus] ' + m); try { fs.appendFileSync(logFile, `${new Date().toISOString().slice(0, 19)} ${m}\n`); } catch {} };
  // Claude page changes (claudeui.js watch) also go to a file of their own, which survives restarts (trimmed at 500 KB)
  const pageLog = path.join(app.getPath('userData'), 'page_changes.log');
  try { if (fs.statSync(pageLog).size > 500000) fs.writeFileSync(pageLog, ''); } catch {}
  claudeUi.setLog(m => { log(m); try { fs.appendFileSync(pageLog, `${new Date().toLocaleString()} ${m}\n`); } catch {} });
  const modPath = n => process.env.THESEUS_MODS ? path.join(process.env.THESEUS_MODS, n) : './' + n;      // THESEUS_MODS (tests): a folder with stand-in audio.js / recorder.js
  let audio = null, rec = null, hk = null;
  try { audio = require(modPath('audio')).create({ wake: NAME() }); } catch (e) { log('audio module not available: ' + (e && e.message)); }
  try {
    const tmpDir = app.isPackaged ? path.join(app.getPath('userData'), 'rec') : path.join(__dirname, '..', 'data', 'rec'); fs.mkdirSync(tmpDir, { recursive: true });   // installed: never beside the app
    rec = require(modPath('recorder')).create({ ffmpeg: P.ffmpeg(), tmpDir, prefix: () => settings.recPrefix || NAME() });
  } catch (e) { log('recorder module not available: ' + (e && e.message)); }
  let aState = null, rState = null, sysSum = null, listening = false, curMode = { mode: null, pending: null };
  const snapshot = () => ({
    audio: aState, rec: rState || (rec ? { recording: false, since: null, file: null, replay: false, replaySec: settings.replaySec } : null), sys: settings.sysReadout ? sysSum : null,
    mode: curMode, listening, avail: { audio: !!audio, rec: !!rec }, keys: { failed: hk ? hk.failed() : [] },
  });
  let pushT = null;
  function pushTools() {
    if (pushT) return;
    pushT = setTimeout(() => {
      pushT = null; const s = snapshot();
      for (const w of [settingsWin, stripWin]) if (alive(w)) w.webContents.send('tools', s);
      trayDirty();
      const hx = coreHex(curMode.mode); if (hx !== trayHex && tray && !tray.isDestroyed()) { trayHex = hx; tray.setImage(trayIcon(hx)); }
    }, 30);
  }
  ipcMain.handle('tools-state', e => fromUi(e) ? snapshot() : null);

  // ---- notices: flash on the strip for 3 s; with the strip off, a small toast at the top centre ----
  let lastNote = { t: '', at: 0 };
  const stripVisible = () => !!settings.strip && alive(stripWin) && stripWin.isVisible();
  function notify(text, ms = 3000) {
    if (!text) return;
    const now = Date.now(); if (lastNote.t === text && now - lastNote.at < 1500) return;      // an action and the device event it causes say it once
    lastNote = { t: text, at: now }; log('notice: ' + text);
    if (stripVisible()) stripWin.webContents.send('notice', text, ms); else showToast({ notice: text }, ms);
  }
  let toastT = null;
  function showToast(p, ms) {
    if (!alive(toastWin)) {
      toastWin = new BrowserWindow({ width: 260, height: 40, frame: false, transparent: true, hasShadow: false, skipTaskbar: true, focusable: false, resizable: false, show: false,
        backgroundColor: '#00000000', webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false } });
      const tw = toastWin; tw.setIgnoreMouseEvents(true); tw.setAlwaysOnTop(true, 'screen-saver');
      tw.on('closed', () => { if (toastWin === tw) toastWin = null; });
      watchConsole(tw.webContents, 'toast');
      tw.loadFile(path.join(__dirname, 'renderer', 'strip.html'), { query: { toast: '1' } });
    }
    const wc = toastWin.webContents, send = () => { if (alive(toastWin)) wc.send('toast', p); };
    wc.isLoading() ? wc.once('did-finish-load', send) : send();
    clearTimeout(toastT); toastT = setTimeout(() => {
      if (alive(toastWin)) toastWin.hide();
      toastT = setTimeout(() => { if (alive(toastWin)) toastWin.destroy(); }, 60000);   // its renderer is not kept around between notices
    }, ms);
  }

  // ---- the strip ----
  const STRIP_H = 39; let stripW = 320, drag = null, stripTry = [];
  const primaryIdx = ds => Math.max(0, ds.findIndex(d => d.id === screen.getPrimaryDisplay().id));
  function stripXY(w) { const ds = screen.getAllDisplays(); return T.clampPos(settings.stripPos, { w, h: STRIP_H }, ds.map(d => d.bounds), primaryIdx(ds)); }
  function placeStrip() { if (alive(stripWin)) { const p = stripXY(stripW); stripWin.setBounds({ x: p.x, y: p.y, width: stripW, height: STRIP_H }); } }
  function createStrip() {
    if (alive(stripWin)) return;
    const p = stripXY(stripW);
    const w = stripWin = new BrowserWindow({ x: p.x, y: p.y, width: stripW, height: STRIP_H, minWidth: 40, minHeight: STRIP_H, frame: false, transparent: true, hasShadow: false,
      skipTaskbar: true, focusable: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false, thickFrame: false, show: false, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'preload.js') } });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.on('closed', () => { if (stripWin === w) stripWin = null; });
    w.webContents.on('render-process-gone', (_e, d) => {
      if (d.reason === 'clean-exit' || w.isDestroyed()) return;
      const now = Date.now(); stripTry = stripTry.filter(t => now - t < 60000); stripTry.push(now);
      w.destroy(); if (stripTry.length <= 5) setTimeout(syncStrip, 1000);
    });
    watchConsole(w.webContents, 'strip');
    w.loadFile(path.join(__dirname, 'renderer', 'strip.html'));    // shown when the page reports its size
  }
  function syncStrip() {
    if (settings.strip) createStrip(); else if (alive(stripWin)) { const w = stripWin; stripWin = null; w.destroy(); }
  }
  ipcMain.on('strip-size', (e, w, h) => {
    w = Math.round(w); h = Math.round(h);
    if (![w, h].every(n => isFinite(n)) || w < 20 || w > 1600 || h < 10 || h > 600) return;
    if (fromStrip(e)) {
      stripW = w;
      if (!drag) placeStrip();
      if (!stripWin.isVisible()) stripWin.showInactive();
    } else if (fromToast(e)) {
      const b = screen.getPrimaryDisplay().bounds, top = b.y + (stripVisible() ? 34 : 6);
      toastWin.setBounds({ x: b.x + Math.round((b.width - w) / 2), y: top, width: w, height: h });
      if (!toastWin.isVisible()) toastWin.showInactive();
    }
  });
  ipcMain.on('strip-hit', (e, over) => { if (!fromStrip(e)) return; if (process.env.SPHERE_DEBUG) console.log('strip-hit', over); stripWin.setIgnoreMouseEvents(!over, { forward: true }); });   // the transparent part below the pill passes clicks through
  // drag: from 'start' main moves the strip with the cursor every 15 ms (not only on the strip's own pointer events, which
  // stop once the pointer is past the 39 px window); 'end' saves a real move (clamped onto a display). Ends by itself after 2 min.
  const dragStop = () => { if (drag) { clearInterval(drag.timer); clearTimeout(drag.cap); } };
  ipcMain.on('strip-drag', (e, phase, d) => {
    if (!fromStrip(e)) return;
    if (process.env.SPHERE_DEBUG) console.log('strip-drag', phase, JSON.stringify(d || null));
    if (phase === 'start') {
      dragStop();
      const c = screen.getCursorScreenPoint(), b = stripWin.getBounds(), dx = d && Number.isFinite(d.dx) ? d.dx : 0, dy = d && Number.isFinite(d.dy) ? d.dy : 0;
      drag = { cx: c.x - dx, cy: c.y - dy, x: b.x, y: b.y, w: b.width };
      stripWin.setIgnoreMouseEvents(false);
      const follow = () => { if (!drag || !alive(stripWin)) return; const p = screen.getCursorScreenPoint(); stripWin.setBounds({ x: drag.x + p.x - drag.cx, y: drag.y + p.y - drag.cy, width: drag.w, height: STRIP_H }); };
      follow(); drag.timer = setInterval(follow, 15); drag.cap = setTimeout(() => { dragStop(); drag = null; placeStrip(); }, 120000);
    } else if (phase === 'end' && drag) {
      dragStop(); drag = null;
      const b = stripWin.getBounds(), ds = screen.getAllDisplays();
      settings.stripPos = T.clampPos({ x: b.x, y: b.y }, { w: b.width, h: STRIP_H }, ds.map(x => x.bounds), primaryIdx(ds)); saveSettings(); pushSettings();
      placeStrip();
    }
  });
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, () => setTimeout(() => { placeStrip(); }, 600));

  // ---- Theseus mode (the strip shows it; a change is a request, like the Theseus card) ----
  curMode = getMode();
  setInterval(() => { const m = getMode(); if (m.mode !== curMode.mode || m.pending !== curMode.pending) { curMode = m; pushTools(); } }, 2000);
  // the background's tint (the mode colour) and speed (a session working); the live wallpaper is put back at the bottom (Windows
  // can raise a click-through window when the stack changes), and stops drawing while other apps cover it fully
  let bgCov = false;
  setInterval(async () => {
    const tint = !curMode.mode || curMode.mode === 'normal' ? settings.glow : (settings.modeColors[curMode.mode] || settings.glow);
    const working = ((lastFeed && lastFeed.sessions) || []).some(s => s.activity === 'working');
    if (tint !== bgExtra.tint || working !== bgExtra.working) { bgExtra.tint = tint; bgExtra.working = working; bgSend(); }
    if (!alive(bgWin) || !bgWin.isVisible() || frontOn || bgCov) return;
    bgUnder();
    if (!['moving', 'gradient', 'travel'].includes(settings.bgStyle)) return;
    bgCov = true;
    try {
      const b = bgWin.getBounds(); let all = true;
      for (const [fx, fy] of [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]) {
        const p = screen.dipToScreenPoint({ x: Math.round(b.x + b.width * fx), y: Math.round(b.y + b.height * fy) });
        const r = await zorder.send({ cmd: 'covered', x: p.x, y: p.y, pid: process.pid }, 10000);
        if (!r.covered) { all = false; break; }
      }
      if (all !== bgPaused) { bgPaused = all; bgSend(); if (process.env.SPHERE_DEBUG) console.log('bg paused', all); }
    } catch {} finally { bgCov = false; }
  }, 3000);

  // ---- system readout: the statusFile setting (fs.watch + 15 s poll); read only when the strip shows it, alerts are on, or the card is asked for ----
  const STATUS = () => P.status();
  let lastStatusTime = null, redKeys = null;
  const needSys = () => !!P.status() && (settings.sysReadout || settings.sysAlerts);
  async function readStatus() {
    for (let i = 0; i < 2; i++) {           // the writer is not atomic: a half-written file parses badly, so try once more
      try { const st = T.parseStatus(await fs.promises.readFile(STATUS(), 'utf8')); if (st) return st; } catch {}
      await new Promise(r => setTimeout(r, 300));
    }
    return null;
  }
  async function refreshSys(force) {
    if (!force && !needSys()) return null;
    const st = await readStatus(); if (!st) return null;
    if (!force && st.time && st.time === lastStatusTime) return st;
    lastStatusTime = st.time || null; sysSum = T.summary(st);
    const { reds, fresh } = T.newReds(redKeys, st); redKeys = new Set(reds.map(r => r.key));
    if (fresh.length && settings.sysAlerts) {
      notify('Red: ' + fresh.map(r => r.text).join(', '), 5000);
      if (settings.sysSpeak) speak(`Alert. ${fresh.map(r => r.label).join(' and ')} ${fresh.length > 1 ? 'are' : 'is'} red.`);
    }
    pushTools();
    return st;
  }
  async function showReadout() {
    const st = await refreshSys(true), sm = st ? T.summary(st) : null;
    showToast({ card: sm || { none: true } }, 8000);
    return sm;
  }
  try {
    if (!STATUS()) throw new Error('no status file set');
    let wt = null; const base = path.basename(STATUS()).toLowerCase();
    const w = fs.watch(path.dirname(STATUS()), (_ev, name) => { if (name && name.toLowerCase() === base) { clearTimeout(wt); wt = setTimeout(() => refreshSys(), 250); } });
    w.on('error', () => {});
  } catch (e) { log('status watch failed (poll only): ' + e.message); }
  setInterval(() => refreshSys(), 15000);

  // ---- menus (native popups; the strip and the tray share them) ----
  const popup = (tpl, pos) => { const m = Menu.buildFromTemplate(tpl); m.popup(alive(stripWin) && pos && stripVisible() ? { window: stripWin, x: Math.round(pos.x), y: Math.round(pos.y) } : {}); };
  const modeItems = () => MODES.map(m => ({ label: T.MODE_NAMES[m], type: 'radio', checked: (curMode.pending || curMode.mode) === m, click: () => setModeNotice(m) }));
  function setModeNotice(m) { curMode = requestMode(m); pushTools(); notify('Mode: ' + T.MODE_NAMES[m] + ' requested'); }
  const devItems = kind => {
    const list = aState ? (kind === 'mic' ? aState.mics : aState.outs) || [] : [], cur = aState && aState[kind] ? aState[kind].id : null;
    return list.length ? list.map(d => ({ label: d.name, type: 'radio', checked: d.id === cur, click: () => act('setDefault', { dev: kind, id: d.id }) })) : [{ label: audio ? 'No devices' : 'Audio helper not available', enabled: false }];
  };

  // ---- recording ----
  let recHwnd = null;
  function pickWindow() {
    return Promise.resolve(rec.listWindows()).then(list => new Promise(res => {
      const items = (list || []).slice(0, 40).map(w => ({ label: `${(w.title || w.exe || '?').slice(0, 60)}${w.exe ? ' (' + w.exe + ')' : ''}`, click: () => res(w) }));
      if (!items.length) return res(null);
      items.push({ type: 'separator' }, { label: 'Cancel', click: () => res(null) });
      Menu.buildFromTemplate(items).popup({ callback: () => setTimeout(() => res(null), 400) });
    }));
  }
  // what to record: the setting; an interactive call may open the region picker / the window menu, else falls back to the screen. null = cancelled
  async function recSource(interactive) {
    const o = { source: 'screen', display: screen.getPrimaryDisplay().id };
    if (settings.recSource === 'region') {
      let r = settings.recRegion;
      if (!r && interactive) { r = await rec.pickRegion(); if (!r) return null; settings.recRegion = r; saveSettings(); pushSettings(); }
      if (r) return { source: 'region', region: r };
    } else if (settings.recSource === 'window') {
      if (!recHwnd && interactive) { const w = await pickWindow(); if (!w) return null; recHwnd = w.hwnd; }
      if (recHwnd) return { source: 'window', hwnd: recHwnd };
    }
    return o;
  }
  const replayOpts = async () => ({ ...(await recSource(false)), mic: settings.recMic, system: settings.recSystem, outDir: P.recDir() });   // outDir: the disk check only
  function applyReplay() {
    if (!rec) return;
    replayOpts().then(o => rec.setReplay(!!settings.replay, settings.replaySec, o)).catch(e => log('replay: ' + (e && e.message)));
  }
  const base = f => path.basename(String(f || ''));

  // ---- actions (hotkeys, strip, settings, tray and voice all come through here) ----
  const needA = () => { if (!audio) throw new Error('audio helper not available'); };
  const needR = () => { if (!rec) throw new Error('recorder not available'); };
  const dev = d => d === 'mic' ? 'mic' : 'out';
  const ok = async p => { const r = await p; if (!r) throw new Error((audio && audio.lastError) || 'audio call failed'); return r; };   // audio calls resolve to the state, or null on failure
  const acts = {
    async nextOut() { needA(); onAudio(await ok(audio.next('out', settings.outCycle))); notify('Output: ' + (aState.out ? aState.out.name : 'none')); },
    async nextMic() { needA(); onAudio(await ok(audio.next('mic', settings.micCycle))); notify('Microphone: ' + (aState.mic ? aState.mic.name : 'none')); },
    async muteMic(a) { needA(); onAudio(await ok(audio.setMute('mic', a == null ? 'toggle' : !!a))); notify(aState.mic && aState.mic.mute ? 'Microphone muted' : 'Microphone on'); },
    async setVolume(a) { needA(); const v = a && Number(a.v); if (!(v >= 0 && v <= 1)) return; await ok(audio.setVolume(dev(a.dev), v)); },
    async setMute(a) { needA(); if (a) await ok(audio.setMute(dev(a.dev), !!a.on)); },
    async setDefault(a) {
      needA(); if (!a || typeof a.id !== 'string') return;
      const list = aState ? (a.dev === 'mic' ? aState.mics : aState.outs) || [] : []; if (!list.some(d => d.id === a.id)) return;
      onAudio(await ok(audio.setDefault(a.id, dev(a.dev))));
    },
    async recStart() {
      needR(); if (rState && rState.recording) return;
      const s = await recSource(true); if (!s) return;
      fs.mkdirSync(P.recDir(), { recursive: true });
      try { await rec.start({ ...s, outDir: P.recDir(), mic: settings.recMic, system: settings.recSystem }); } catch (e) { if (s.source === 'window') recHwnd = null; throw e; }
      notify('Recording started');
    },
    async recStop() { needR(); if (!(rState && rState.recording)) return; const r = await rec.stop(); notify(r && r.file ? 'Saved: ' + base(r.file) : 'Recording stopped', 4000); },
    async recToggle() { return rState && rState.recording ? acts.recStop() : acts.recStart(); },
    async replayToggle() { needR(); return acts.setReplay(!settings.replay); },
    async setReplay(on) { needR(); settings.replay = !!on; saveSettings(); pushSettings(); applyReplay(); notify(`Replay ${on ? 'on (' + settings.replaySec + ' s)' : 'off'}`); },
    async saveReplay() {
      needR(); if (!settings.replay) return notify('Replay is off');
      fs.mkdirSync(P.recDir(), { recursive: true });
      const r = await rec.saveReplay(P.recDir()); notify(`Replay saved (${(r && r.sec) || settings.replaySec} s)`, 4000);
    },
    async screenshot() {
      needR(); fs.mkdirSync(P.recDir(), { recursive: true });
      const r = await rec.screenshot({ ...(await recSource(false)), outDir: P.recDir() }); notify('Screenshot: ' + base(r && r.file), 4000);
    },
    async pickRegion() { needR(); const r = await rec.pickRegion(); if (r) { settings.recRegion = r; saveSettings(); pushSettings(); notify(`Region ${r.w}x${r.h}`); } },
    async pickWindow() { needR(); const w = await pickWindow(); if (w) { recHwnd = w.hwnd; pushTools(); notify('Window: ' + (w.title || w.exe || '').slice(0, 40)); return { hwnd: w.hwnd, title: w.title }; } return null; },
    async readout() { await showReadout(); },
    'menu-mode'(pos) { popup(modeItems(), pos); },
    'menu-out'(pos) { popup(devItems('out'), pos); },
    'menu-mic'(pos) { popup(devItems('mic'), pos); },
    'menu-rec'(pos) { popup([{ label: 'Source: ' + settings.recSource, enabled: false }, { label: 'Pick region...', enabled: !!rec, click: () => act('pickRegion') }, { label: 'Pick window...', enabled: !!rec, click: () => act('pickWindow') },
      { label: 'Screenshot', enabled: !!rec, click: () => act('screenshot') }, { label: 'Save replay', enabled: !!(rState && rState.replay), click: () => act('saveReplay') }], pos); },
  };
  async function act(name, arg) {
    const f = acts[name]; if (!f) return;
    try { return await f(arg); } catch (e) { log(`${name} failed: ${e && e.message}`); notify(`${name.replace(/^menu-/, '')} failed: ${String((e && e.message) || e).slice(0, 70)}`, 4000); }
  }
  ipcMain.handle('tools-act', (e, name, arg) => { if (!fromUi(e) || typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(acts, name)) return null; return act(name, arg); });
  ipcMain.handle('pick-folder', async e => {
    if (!fromSettings(e)) return null;
    const r = await dialog.showOpenDialog(settingsWin, { properties: ['openDirectory', 'createDirectory'], defaultPath: P.recDir() });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });

  // ---- audio events ----
  function onAudio(s) {
    if (!s) return;
    const p = aState; aState = s;
    if (p) {
      if (p.out && s.out && p.out.id !== s.out.id) notify('Output: ' + s.out.name);
      if (p.mic && s.mic && p.mic.id !== s.mic.id) notify('Microphone: ' + s.mic.name);
      else if (p.mic && s.mic && !!p.mic.mute !== !!s.mic.mute) notify(s.mic.mute ? 'Microphone muted' : 'Microphone on');
    }
    pushTools();
  }
  function listenNow() {
    if (!audio) return;
    try { Promise.resolve(audio.listen(settings.voiceCmd)).then(r => { if (r === false) log('listen refused: ' + audio.lastError); }).catch(e => log('listen failed: ' + (e && e.message))); } catch (e) { log('listen failed: ' + (e && e.message)); }
  }
  if (audio) {
    audio.on('error', e => log('audio error: ' + JSON.stringify(e)));
    audio.on('state', onAudio);
    audio.on('listening', b => { listening = !!b; pushTools(); });
    audio.on('command', c => runCommand(c));
    audio.get().then(s => s ? onAudio(s) : log('audio.get: ' + audio.lastError)).catch(e => log('audio.get failed: ' + (e && e.message)));
    listenNow();
  }
  if (rec) {
    rec.on('error', e => {
      log('recorder error: ' + (e && e.message || e));
      if (e && e.where === 'replay' && settings.replay) { settings.replay = false; saveSettings(); pushSettings(); notify('Replay stopped (ffmpeg ended)', 5000); }   // one click turns it back on
    });
    rec.on('saved', r => notify(r && r.file ? `Recording stopped: ${base(r.file)}${r.error ? ' (' + String(r.error).slice(0, 40) + ')' : ''}` : 'Recording failed: ' + String(r && r.error || '').slice(0, 60), 6000));   // ffmpeg ended by itself
    rec.on('state', s => { rState = s; pushTools(); });
    rec.on('lowdisk', e => notify(`Low disk space: ${e.freeGB} GB free on ${String(e.dir || '').slice(0, 3)}`, 6000));   // warn only; nothing is refused or stopped
    rec.on('recovered', e => notify('Recovered: ' + base(e.file), 5000));
    // strip meters: the recorder reports about 10 times a second; forwarded only while the strip is visible and recording, at most every 80 ms
    let lvAt = 0;
    rec.on('levels', l => {
      const now = Date.now(); if (now - lvAt < 80 || !(rState && rState.recording) || !stripVisible()) return;
      lvAt = now; stripWin.webContents.send('levels', l);
    });
    if (typeof rec.cleanReplay === 'function') { try { rec.cleanReplay(); } catch (e) { log('replay clean: ' + (e && e.message)); } }   // old pieces from a run that died (replay not running yet)
    if (settings.replay) applyReplay();
    if (typeof rec.recover === 'function') setTimeout(() => { Promise.resolve(rec.recover(P.recDir())).catch(e => log('recover: ' + (e && e.message))); }, 10000);   // crash-left .mkv -> .mp4 in the background
  }

  // ---- voice commands (the helper recognises; we act and answer through speak.ps1 plus a strip notice) ----
  async function runCommand(c) {
    if (!c || typeof c.cmd !== 'string') return;
    log(`voice: ${c.cmd}${c.arg ? ' ' + c.arg : ''} "${c.text || ''}" (${c.confidence})`);
    const short = n => String(n || '').replace(/\s*\(.*\)\s*$/, '');
    // always mode hears everything: ending a recording or saving the replay needs the wake word, so nearby speech cannot do it
    if ((c.cmd === 'recStop' || c.cmd === 'saveReplay') && settings.voiceCmd === 'always' && !c.wake) { log(`voice: ${c.cmd} ignored (always mode, no wake word)`); return; }
    try {
      switch (c.cmd) {
        case 'status': { const sm = await showReadout(); notify('Status'); speak(sm ? sm.say : 'The system readout is not available.'); break; }
        case 'muteMic': await acts.muteMic(true); speak('Microphone muted.'); break;
        case 'unmuteMic': await acts.muteMic(false); speak('Microphone on.'); break;
        case 'nextOut': await acts.nextOut(); speak(`Output ${short(aState && aState.out && aState.out.name)}.`); break;
        case 'nextMic': await acts.nextMic(); speak(`Microphone ${short(aState && aState.mic && aState.mic.name)}.`); break;
        case 'recStart': { const was = !!(rState && rState.recording); await acts.recStart(); if (!was && rState && rState.recording) speak('Recording.'); break; }
        case 'recStop': { if (!(rState && rState.recording)) { speak('Not recording.'); break; } await acts.recStop(); speak('Recording saved.'); break; }
        case 'saveReplay': await acts.saveReplay(); speak(settings.replay ? 'Replay saved.' : 'The replay is off.'); break;
        case 'screenshot': await acts.screenshot(); speak('Screenshot saved.'); break;
        case 'mode': if (MODES.includes(c.arg)) { setModeNotice(c.arg); speak(`${T.MODE_NAMES[c.arg]} mode requested.`); } break;
        default: log('voice: unknown command ' + c.cmd);
      }
    } catch (e) { log(`voice ${c.cmd} failed: ${e && e.message}`); notify(`${c.cmd} failed`, 3000); speak('That did not work.'); }
  }

  // ---- Voice Ask (Docs/Specs/VoiceAsk_Spec.md): "Theseus" + a question -> Whisper -> Claude (Haiku, Sonnet if hard) -> voice + caption ----
  const opt = n => { try { return require(modPath(n)); } catch (e) { log(`${n} module not available: ${e && e.message}`); return null; } };
  const whisper = opt('whisper'), asker = opt('ask');
  const tokenFile = path.join(app.getPath('userData'), 'claude_token.txt'), OPS = path.join(__dirname, '..', 'data', 'ops', 'ops.json');
  const askToken = () => { try { return fs.readFileSync(tokenFile, 'utf8').trim() || null; } catch { return null; } };
  const askOn = () => !!(audio && whisper && asker && P.whisperPy() && settings.voiceAsk && settings.voiceCmd !== 'off');
  const toWin = (ch, v) => { if (win && !win.isDestroyed()) win.webContents.send(ch, v); };
  const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  function near(a, b) {   // edit distance within about 15 % (at least 1)
    if (Math.abs(a.length - b.length) > 2) return false;
    let p = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) { const c = [i]; for (let j = 1; j <= b.length; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; }
    return p[b.length] <= Math.max(1, Math.floor(a.length * 0.15));
  }
  let phrases = null, asking = false, askHist = [], askDay = '', askCount = 0, sayP = Promise.resolve();
  const say = line => (sayP = sayP.then(() => new Promise(r => speak(line, r))));   // "One moment." and the answer never overlap
  function askMode() { if (!audio) return; audio.ask(askOn()).catch(() => {}); if (!askOn() && whisper) whisper.stop(); }
  async function askSnapshot() {
    await refreshSys(true).catch(() => null);
    return {
      sessions: (lastFeed.sessions || []).map(s => ({ ...s, waitingOnUser: s.activity === 'waiting' || undefined })), feedUpdated: lastFeed.updated,
      system: sysSum, mode: curMode && (curMode.pending || curMode.mode), voiceCommands: settings.voiceCmd,
      audio: aState && { output: aState.out && aState.out.name, outputVolume: aState.out && aState.out.vol, mic: aState.mic && aState.mic.name, micMuted: !!(aState.mic && aState.mic.mute) },
      recording: rState && { recording: !!rState.recording, since: rState.since, replay: !!rState.replay },
    };
  }
  // ---- Session Console by voice (SessionConsole_Spec item 4): "tell / ask / message <title> <text>" is read back and sent after
  // 3 s unless "cancel"; "stop <title>" needs a "yes" within 5 s; "what did <title> say" speaks the last reply ----
  function sim(a, b) {   // 1 = same, by edit distance
    if (!a || !b) return 0;
    let p = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) { const c = [i]; for (let j = 1; j <= b.length; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; }
    return 1 - p[b.length] / Math.max(a.length, b.length);
  }
  // words -> { s: session, k: words used by the title } for the best title at the start of `words` (whole: all of them),
  // clear of the runner-up; titles without their "(old - archive)" part, a live session wins over an archived twin
  function findSession(words, whole) {
    const ws = words[0] === 'the' ? words.slice(1) : words, skip = ws.length < words.length ? 1 : 0, by = new Map();
    for (const s of lastFeed.sessions || []) {
      const t = norm(String(s.title || '').replace(/\([^)]*\)/g, '')); if (!t) continue;
      const tw = t.split(' ').length, old = /\(old\b|archive/i.test(s.title || '');
      for (let k = Math.max(1, tw - 1); k <= Math.min(ws.length, tw + 1); k++) {
        if (whole && k !== ws.length) continue;
        let used = k; if (ws[k] === 'session') used++;   // "tell the Geoscape session to …"
        const sc = sim(ws.slice(0, k).join(' '), t) - (old ? 0.001 : 0);
        const cur = by.get(t); if (!cur || sc > cur.sc) by.set(t, { s, k: used + skip, sc });
      }
    }
    const r = [...by.values()].sort((a, b) => b.sc - a.sc);
    return r[0] && r[0].sc >= 0.75 && (!r[1] || r[0].sc - r[1].sc >= 0.08) ? r[0] : null;
  }
  let vPend = null;   // { kind: 'send' | 'stop', s, text, timer }
  const vCap = (q, t) => toWin('ask', { state: 'answer', q, text: t, spoken: settings.askSpeak });
  const vSay = t => { if (settings.askSpeak) say(t); };
  function voicePending(n) {
    if (!vPend) return false;
    const p = vPend;
    if (/^(cancel|no|nope|don t|do not|stop|never mind)\b/.test(n)) { clearTimeout(p.timer); vPend = null; vCap(n, 'Cancelled.'); vSay('Cancelled.'); log('console voice: cancelled'); return true; }
    if (p.kind === 'quiz') { quizHear(p, n); return true; }
    if (p.kind === 'stop' && /^(yes|yeah|yep|do it|go ahead|confirm)\b/.test(n)) { clearTimeout(p.timer); vPend = null; voiceSend(p.s, null); return true; }
    return false;
  }
  function voiceSend(s, text) {
    sessionSend(s.sessionId, text).then(r => {
      const what = text === null ? `Stopped ${s.title}.` : `Sent to ${s.title}.`;
      vCap('', r.ok ? what : `Not ${text === null ? 'stopped' : 'sent'}: ${r.why}`); vSay(r.ok ? what : `I couldn't ${text === null ? 'stop' : 'send'} that.`);
    });
  }
  // read back `what`, then run `act` after 3 s unless "cancel" (stage 2: answer / new session)
  function voiceLater(q, what, spoken, act) {
    if (vPend) clearTimeout(vPend.timer);
    const p = vPend = { kind: 'later', timer: null };
    vCap(q, what);
    const go = () => { if (vPend !== p) return; p.timer = setTimeout(() => { if (vPend === p) { vPend = null; act(); } }, 3000); if (askOn()) audio.follow(3500).catch(() => {}); };
    if (settings.askSpeak) say(spoken).then(go); else go();
  }
  const ORD = { one: 1, first: 1, two: 2, second: 2, to: 2, too: 2, three: 3, third: 3, four: 4, fourth: 4, for: 4, five: 5, fifth: 5 };
  // the option(s) `said` names in question q: "two" / "option 2" / a label; several with "and" when q is multi-choice -> [option] or null
  function optsOf(q, said) {
    const one = x => {
      x = x.split(' ').filter(y => y !== 'option' && y !== 'the' && y !== 'number').join(' ');
      const k = /^\d$/.test(x) ? +x : ORD[x]; if (k && q.options[k - 1]) return q.options[k - 1];
      const r = q.options.map(o => ({ o, sc: sim(x, norm(o.label)) })).sort((a, b) => b.sc - a.sc); return r[0] && r[0].sc >= 0.75 ? r[0].o : null;
    };
    const whole = one(said); if (whole) return [whole];
    if (!q.multiSelect) return null;
    const parts = said.split(/ (?:and|plus|also) /).map(x => x.trim()).filter(Boolean), out = parts.map(one);
    return parts.length > 1 && out.every(Boolean) ? [...new Set(out)] : null;
  }
  const optList = q => q.options.map((o, i) => `${i + 1}, ${o.label}`).join('; ');
  // "answer <title> [with] [option] two" / "... <label>": one question at once; "answer <title>" alone (or several questions):
  // Theseus reads each question and its options in turn and listens for each answer, then reads them back (SessionConsole_Stage3 Q3)
  function voiceAnswer(text, w) {
    const f = findSession(w.slice(1)); if (!f) return false;
    let rest = w.slice(1 + f.k); if (/^(with|by|to)$/.test(rest[0])) rest = rest.slice(1);
    const file = transcriptOf(f.s.sessionId), p = file && pendingNow(file);
    if (!p || p.kind !== 'ask') { log('console voice: answer, ' + f.s.title + ' asks nothing (' + (file ? 'transcript ok' : 'no transcript') + ')'); vCap(text, `${f.s.title} is not asking anything.`); vSay('It is not asking anything.'); return true; }
    if (p.questions.length > 1 || !rest.length) { quizStart(text, f.s, p, file); return true; }
    const q = p.questions[0], said = rest.join(' '), o = optsOf(q, said);
    if (!o) { vCap(text, `No option "${said}" in: ${q.options.map(x => x.label).join(', ')}.`); vSay("I didn't catch which option."); return true; }
    const labels = o.map(x => x.label);
    log(`console voice: answer "${f.s.title}" <- "${labels.join(', ')}"`);
    voiceLater(text, `Answer ${f.s.title}: ${labels.join(', ')}`, `Answer ${f.s.title}: ${labels.join(', ')}.`, () => sessionAnswer(f.s.sessionId, [{ picks: labels, other: '' }]).then(r => {
      vCap('', r.ok ? `Answered ${f.s.title}.` : `Not answered: ${r.why}`); vSay(r.ok ? 'Answered.' : "I couldn't answer that.");
    }));
    return true;
  }
  // question by question: vPend = { kind: 'quiz', s, p, file, i, picks, timer }; 30 s of silence drops it
  const quizDrop = z => { clearTimeout(z.timer); z.timer = setTimeout(() => { if (vPend === z) { vPend = null; vCap('', `Answer for ${z.s.title} dropped.`); log('console voice: quiz dropped (silence)'); } }, 30000); if (askOn()) audio.follow(30000).catch(() => {}); };
  function quizStart(text, s, p, file) {
    if (vPend) clearTimeout(vPend.timer);
    vPend = { kind: 'quiz', s, p, file, i: 0, picks: [], timer: null };
    log(`console voice: answering "${s.title}" question by question (${p.questions.length})`);
    quizAsk(vPend, p.questions.length > 1 ? `${s.title} asks ${p.questions.length} questions. ` : '', text);
  }
  function quizAsk(z, pre, q0) {
    const q = z.p.questions[z.i], n = z.p.questions.length;
    const head = `${n > 1 ? `Question ${z.i + 1}: ` : ''}${q.question}${q.multiSelect ? ' (one or more: say "and" between them)' : ''}`;
    vCap(q0 || '', `${pre}${head}\n${optList(q)}`);
    const go = () => { if (vPend === z) quizDrop(z); };
    if (settings.askSpeak) say(`${pre}${head}. ${optList(q)}.`).then(go); else go();
  }
  function quizHear(z, n) {
    const q = z.p.questions[z.i];
    const said = n.replace(/^(answer|option|pick|choose|it s|its|i pick|i choose) /, '');
    let pick;
    if (/^other /.test(said)) pick = { picks: [], other: said.slice(6) };
    else { const o = optsOf(q, said); if (o) pick = { picks: o.map(x => x.label), other: '' }; }
    if (!pick) { vCap(n, `No option "${said}". ${optList(q)}`); vSay("I didn't catch that. Say the number."); quizDrop(z); return; }
    z.picks.push(pick); z.i++;
    if (z.i < z.p.questions.length) return quizAsk(z, '', n);
    clearTimeout(z.timer); vPend = null;
    const sum = z.picks.map(x => x.other || x.picks.join(' and ')).join('; then ');
    log(`console voice: answer "${z.s.title}" <- ${JSON.stringify(z.picks)}`);
    voiceLater(n, `Answer ${z.s.title}: ${sum}`, `Answer ${z.s.title}: ${sum}.`, () => {
      const now = pendingNow(z.file);
      if (!now || now.id !== z.p.id) { vCap('', `${z.s.title} is not asking that any more.`); vSay('The question changed.'); return; }
      sessionAnswer(z.s.sessionId, z.picks).then(r => { vCap('', r.ok ? `Answered ${z.s.title}.` : `Not answered: ${r.why}`); vSay(r.ok ? 'Answered.' : "I couldn't answer that."); });
    });
  }
  // "allow / always allow / deny <title>" (a permission request), "approve / accept / reject <title>" (a plan); read back, 3 s to cancel
  function voiceWait(text, n) {
    const m = n.match(/^(always allow|allow|deny|approve|accept|reject)( the)? (.+?)(?: (?:plan|session|request))?$/); if (!m) return false;
    const f = findSession(m[3].split(' '), true); if (!f) return false;
    const verb = m[1], s = f.s, file = transcriptOf(s.sessionId), p = file && pendingNow(file);
    const plan = p && p.kind === 'plan', perm = p && p.kind === 'tool';
    if (perm && awaitOf(s.sessionId) === false) { vCap(text, `${s.title} is running ${p.name}, not asking for permission.`); vSay('It is not asking for permission.'); return true; }
    let what, act;
    if (plan && verb !== 'deny' && !/allow/.test(verb)) {
      const c = verb === 'reject' ? 'reject' : 'accept';
      what = `${c === 'reject' ? 'Reject' : 'Accept'} the plan of ${s.title}`; act = () => sessionPlan(s.sessionId, c, '');
    } else if (perm) {
      const c = verb === 'always allow' ? 'Always allow' : verb === 'deny' || verb === 'reject' ? 'Deny' : 'Allow once';
      what = `${c === 'Allow once' ? 'Allow' : c} ${s.title}: ${p.name}${p.summary ? ' ' + String(p.summary).replace(/^Ran: /, '').slice(0, 80) : ''}`;
      act = () => sessionPermit(s.sessionId, c);
    } else {
      vCap(text, plan ? `${s.title} has a plan waiting: say approve or reject.` : `${s.title} is not waiting on ${/allow|deny/.test(verb) ? 'permission' : 'a plan'}.`);
      vSay(plan ? 'That one has a plan. Say approve or reject.' : 'It is not waiting on that.'); return true;
    }
    log(`console voice: ${what}`);
    voiceLater(text, what, what + '.', () => act().then(r => { vCap('', r.ok ? 'Done.' : `Not done: ${r.why}`); vSay(r.ok ? 'Done.' : "I couldn't do that."); }));
    return true;
  }
  // "new session in <project> [to|that|:] <text>"; the project by its folder name ("my project" = My_Project)
  function voiceNew(text, n) {
    const m = n.match(/^(start )?(a )?new session (in|for|on) (.+)$/); if (!m) return false;
    const ws = m[4].split(' '), fl = folders();
    let best = null;
    for (const fo of fl) { const t = norm(fo.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')), tw = t.split(' ').length;
      for (let k = Math.max(1, tw - 1); k <= Math.min(ws.length - 1, tw + 1); k++) { const sc = sim(ws.slice(0, k).join(' '), t); if (!best || sc > best.sc) best = { fo, k, sc }; } }
    if (!best || best.sc < 0.75) { vCap(text, `Which project? ${fl.slice(0, 8).join(', ')}.`); vSay('Which project?'); return true; }
    // the message keeps the spoken words' case and punctuation: drop as many words from the raw text as the project used
    const raw = text.split(/\s+/).filter(x => norm(x)), at = raw.findIndex(x => /^(in|for|on)$/i.test(norm(x)));
    let rest = raw.slice(at + 1 + best.k); if (rest.length && /^(to|that)$/i.test(norm(rest[0]))) rest = rest.slice(1);
    const msg = rest.join(' ').replace(/^[,.:;\s-]+/, '').trim(); if (!msg) return false;
    const out = msg.charAt(0).toUpperCase() + msg.slice(1);
    log(`console voice: new session in ${best.fo} <- "${out}"`);
    voiceLater(text, `New session in ${best.fo}: ${out}`, `New session in ${best.fo}.`, () => sessionNew(best.fo, null, out).then(r => {
      vCap('', r.ok ? `Started ${r.title} in ${best.fo}.` : `Not started: ${r.why}`); vSay(r.ok ? 'Started.' : "I couldn't start it.");
    }));
    return true;
  }
  async function voiceSession(text, n) {
    const w = n.split(' '), raw = text.split(/\s+/).filter(x => norm(x));
    let m;
    if (w[0] === 'answer' && w.length >= 2 && voiceAnswer(text, w)) return true;
    if (/^(always allow|allow|deny|approve|accept|reject) /.test(n) && voiceWait(text, n)) return true;
    if (/new session/.test(n) && voiceNew(text, n)) return true;
    if ((m = n.match(/^what (did|has|does) (.+?) (say|said|says|replied|reply)$/))) {
      const f = findSession(m[2].split(' '), true); if (!f) return false;
      const file = transcriptOf(f.s.sessionId); let last = null;
      if (file) try {
        const size = fs.statSync(file).size, len = Math.min(size, 1 << 20), fd = fs.openSync(file, 'r'), b = Buffer.alloc(len);
        fs.readSync(fd, b, 0, len, size - len); fs.closeSync(fd);
        last = require('./transcript').parse(b.toString('utf8')).filter(x => x.role === 'assistant').pop();
      } catch {}
      const t = last ? last.text.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>|]/g, '') : '';
      vCap(text, last ? `${f.s.title}: ${t.slice(0, 600)}` : `${f.s.title} has no reply yet.`);
      if (settings.askSpeak && asker) say(last ? asker.spoken(t) : 'No reply yet.');
      log(`console voice: read last reply of "${f.s.title}"`);
      return true;
    }
    if (w[0] === 'stop' && w.length >= 2) {
      const f = findSession(w.slice(1), true); if (!f) return false;
      if (vPend) clearTimeout(vPend.timer);
      const p = vPend = { kind: 'stop', s: f.s, timer: null };
      vCap(text, `Stop ${f.s.title}? Say yes.`);
      const go = () => { if (vPend !== p) return; p.timer = setTimeout(() => { if (vPend === p) { vPend = null; vCap('', 'Not stopped.'); } }, 5000); if (askOn()) audio.follow(5000).catch(() => {}); };
      if (settings.askSpeak) say(`Stop ${f.s.title}?`).then(go); else go();
      return true;
    }
    if (/^(tell|ask|message|send)$/.test(w[0]) && w.length >= 3) {
      const f = findSession(w.slice(1)); if (!f) return false;
      let rest = raw.slice(1 + f.k);
      if (rest.length && /^(to|that)$/i.test(norm(rest[0]))) rest = rest.slice(1);
      const msg = rest.join(' ').replace(/^[,.:;\s-]+/, '').trim(); if (!msg) return false;
      const out = msg.charAt(0).toUpperCase() + msg.slice(1);
      if (vPend) clearTimeout(vPend.timer);
      const p = vPend = { kind: 'send', s: f.s, text: out, timer: null };
      vCap(text, `To ${f.s.title}: ${out}`);
      // the 3 s to cancel start once the read-back has been spoken (the mic never hears our own voice as a "cancel")
      const go = () => { if (vPend !== p) return; p.timer = setTimeout(() => { if (vPend === p) { vPend = null; voiceSend(p.s, p.text); } }, 3000); if (askOn()) audio.follow(3500).catch(() => {}); };
      if (settings.askSpeak) say(`To ${f.s.title}.`).then(go); else go();
      log(`console voice: "${f.s.title}" <- "${out}"`);
      return true;
    }
    return false;
  }
  async function onQuestion(q) {
    const rm = () => fs.unlink(q.wav, () => {});
    if (asking || !askOn()) { rm(); return; }
    asking = true; const t0 = Date.now();
    try {
      let text; try { text = (await whisper.transcribe(q.wav)).text; } finally { rm(); }
      text = String(text || '').replace(wakeRe(), '').trim();
      const n = norm(text);
      if (voicePending(n)) return;                                               // "cancel" / "yes" for a voice reply or stop
      if (n.split(' ').length < 2) { log(`ask: dropped "${text}"`); return; }   // "Theseus" in passing
      if (!phrases) phrases = await audio.phrases().catch(() => null);
      const hit = (phrases || []).find(p => near(norm(p[0]), n));   // Whisper spellings: "mode knight", "mute mike"
      if (hit) { log(`ask: "${text}" is a command`); runCommand({ cmd: hit[1], arg: hit[2], text, confidence: 1, wake: true }); return; }
      if (await voiceSession(text, n)) return;                                   // "tell X …", "what did X say", "stop X"
      toWin('ask', { state: 'thinking', q: text });
      let r;
      try { r = await asker.ask(text, { name: NAME(), snapshot: await askSnapshot(), opsFile: OPS, history: askHist, web: settings.askWeb, token: askToken(), onSlow: () => { if (settings.askSpeak) say('One moment.'); } }); }
      catch (e) {
        log(`ask failed: "${text}" ${e.message} (${Date.now() - t0} ms)`);
        toWin('ask', { state: 'error', q: text, text: `I couldn't get an answer just now (${e.message}).` });
        if (settings.askSpeak) say("I couldn't get an answer just now.");
        return;
      }
      const d = new Date().toDateString(); if (d !== askDay) { askDay = d; askCount = 0; }
      log(`ask #${++askCount} today: "${text}" -> ${r.model}${r.escalated ? ' (escalated)' : ''}${r.web ? ' +web' : ''}, claude ${r.ms} ms, total ${Date.now() - t0} ms`);
      askHist = [...askHist, { q: text, a: r.text }].slice(-2);
      toWin('ask', { state: 'answer', q: text, text: r.text, spoken: settings.askSpeak });
      const follow = () => { if (askOn()) audio.follow(8000).catch(() => {}); };   // a follow-up needs no wake word for 8 s
      if (settings.askSpeak) say(asker.spoken(r.text)).then(follow); else follow();
    } catch (e) { log('ask: ' + (e && e.message)); toWin('ask', { state: 'error', q: '', text: "I couldn't hear the question." }); }
    finally { asking = false; }
  }
  if (audio) {
    audio.on('question', q => { if (q && typeof q.wav === 'string') onQuestion(q); });
    audio.on('wake', () => { if (askOn()) whisper.warm(); });                                         // load the model while the question is spoken
    audio.on('listening', b => { if (b && askOn() && settings.voiceCmd === 'ptt') whisper.warm(); });
    askMode();
  }
  // sign-in for the answers: a token from `claude setup-token`, kept in the user folder (never in settings.json or the log)
  ipcMain.handle('ask-token', (e, t) => {
    if (!fromSettings(e)) return null;
    if (typeof t === 'string') { t = t.trim(); try { if (t) fs.writeFileSync(tokenFile, t); else fs.unlinkSync(tokenFile); } catch {} }
    return !!askToken();
  });
  ipcMain.handle('ask-test', async e => {
    if (!fromSettings(e) || !asker) return { ok: false, why: 'not available' };
    try { const r = await asker.ask('Reply with the single word: ready.', { token: askToken() }); return { ok: true, ms: r.ms, text: r.text }; }
    catch (x) { return { ok: false, why: x.message }; }
  });

  // ---- hotkeys: Electron globalShortcut (no hook). Mode Buttons may still hold some: failures are logged and retried every 30 s ----
  hk = T.hotkeys(globalShortcut, [
    { acc: 'Control+Alt+F11', name: 'next output', fn: () => act('nextOut') },
    { acc: 'Control+Alt+F7', name: 'next microphone', fn: () => act('nextMic') },
    { acc: 'Control+Alt+F8', name: 'mute microphone', fn: () => act('muteMic') },
    { acc: 'Control+Alt+S', name: 'readout card', fn: () => act('readout') },
    { acc: 'Control+Alt+R', name: 'record / stop', fn: () => act('recToggle') },
    { acc: 'Control+Alt+P', name: 'screenshot', fn: () => act('screenshot') },
    { acc: 'Control+Alt+F12', name: 'save replay', fn: () => act('saveReplay') },
    { acc: 'Super+Alt+Space', name: 'sphere keys', fn: () => { if (win && !win.isDestroyed()) win.webContents.send('keys'); } },   // spread + arrows / Enter / Esc; again: fold (Ctrl+Alt+Space is Claude's quick entry)
  ], log);
  if (settings.hotkeys) hk.register();

  // ---- tray ----
  let trayT = null;
  function trayDirty() { clearTimeout(trayT); trayT = setTimeout(() => { if (tray && !tray.isDestroyed()) rebuild(); }, 200); }
  function trayExtra() {
    const recOn = !!(rState && rState.recording);
    return [
      { type: 'separator' },
      { label: 'Mode', submenu: modeItems() },
      { label: 'Output', submenu: devItems('out') },
      { label: 'Microphone', submenu: devItems('mic') },
      { label: recOn ? 'Stop recording' : 'Record', enabled: !!rec, click: () => act('recToggle') },
      { label: 'Save replay', enabled: !!(rec && settings.replay), click: () => act('saveReplay') },
      { label: 'Screenshot', enabled: !!rec, click: () => act('screenshot') },
      { label: 'Readout card', click: () => act('readout') },
      { label: 'Show strip', type: 'checkbox', checked: !!settings.strip, click: it => applySettings({ strip: it.checked }) },
      { label: 'Reset strip position', enabled: !!settings.stripPos, click: () => applySettings({ stripPos: null }) },
    ];
  }
  function onSettingsChanged(p) {
    if ('strip' in p) syncStrip();
    if ('stripPos' in p) placeStrip();
    if ('sysReadout' in p || 'sysAlerts' in p) { if (needSys()) refreshSys(true); }
    if ('voiceCmd' in p) listenNow();
    if ('name' in p && audio) audio.wake(NAME()).catch(() => {});
    if ('voiceCmd' in p || 'voiceAsk' in p || ADDON_KEYS.some(k => k in p)) askMode();
    if (ADDON_KEYS.some(k => k in p) && needSys()) refreshSys(true);
    if (['replay', 'replaySec', 'recSource', 'recMic', 'recSystem', 'recRegion'].some(k => k in p)) applyReplay();
    if ('hotkeys' in p) { if (settings.hotkeys) hk.register(); else hk.unregister(); }
    pushTools();
  }
  // a settings change made inside the main process (tray, strip): same path as the settings window
  function applySettings(patch) {
    patch = clean(patch); settings = merge(settings, patch); saveSettings();
    pushSettings(); onSettingsChanged(patch);
  }
  function theseusStop() {
    try { if (hk) hk.unregister(); globalShortcut.unregisterAll(); } catch {}
    try { if (audio) audio.dispose(); } catch {}
    try { if (rec) rec.dispose(); } catch {}
    try { if (whisper) whisper.stop(); } catch {}
  }
  rebuild();
  syncStrip();
  refreshSys();
  // an add-on's file can appear or go while running: look every 20 s and tell the pages
  let addonKey = JSON.stringify(P.addons());
  setInterval(() => { const k = JSON.stringify(P.addons()); if (k !== addonKey) { addonKey = k; pushSettings(); onSettingsChanged({ addons: true }); } }, 20000);

  // ---- test hooks: STRIP_SHOTS="<dir>;<count>;<ms apart>" pictures of the strip / toast / settings windows (first after 6 s);
  // STRIP_SCRIPT="3000:muteMic,5000:voice:status,6000:voice:mode:worker,9000:ask:q1.wav" runs actions at those times (ask: a wave in %TEMP%SessionSphere; send:<sessionId>:<text> types into that session, SPHERE_SEND_OK=1 needed)
  if (process.env.STRIP_SCRIPT) for (const it of process.env.STRIP_SCRIPT.split(',')) {
    const [ms, kind, a, b] = it.split(':');
    setTimeout(() => { if (kind === 'ask') { const s = path.join(app.getPath('temp'), 'SessionSphere', a), d = s + '.' + Date.now() + '.wav'; fs.copyFileSync(s, d); onQuestion({ wav: d }); } else if (kind === 'say') { const t = a, n = norm(t); log('say test: ' + t); if (!voicePending(n)) voiceSession(t, n).then(r => log('say test handled: ' + r)); } else if (kind === 'send') sessionSend(a, b || null).then(r => log('send test: ' + JSON.stringify(r))); else if (kind === 'js' && process.env.SPHERE_USERDATA) win.webContents.executeJavaScript(fs.readFileSync(path.join(process.env.SPHERE_USERDATA, a), 'utf8')).then(r => log('js test: ' + JSON.stringify(r)), e => log('js test failed: ' + e.message)); else if (kind === 'voice') runCommand({ cmd: a, arg: b, text: 'test', confidence: 1, wake: true }); else act(kind, a ? (isNaN(+a) ? a : +a) : undefined); }, +ms);
  }
  if (process.env.STRIP_SHOTS) {
    const [dir, count = 1, ms = 1000] = process.env.STRIP_SHOTS.split(';'); let i = 0;
    const shot = async () => {
      i++;
      if (i === 1) log('settings check ' + JSON.stringify({ voiceCmd: settings.voiceCmd, replaySec: settings.replaySec, recSource: settings.recSource, stripPos: settings.stripPos }));
      if (alive(stripWin)) log('strip bounds ' + JSON.stringify(stripWin.getBounds()) + ' displays ' + JSON.stringify(screen.getAllDisplays().map(d => d.bounds)));
      for (const [w, n] of [[stripWin, 'strip'], [toastWin, 'toast'], [settingsWin, 'settings'], [bgWin, 'bg']]) {
        if (!alive(w) || !w.isVisible()) continue;
        if (n === 'settings') await w.webContents.executeJavaScript(`(s => s[${(i - 1) % 20}] && s[${(i - 1) % 20}].scrollIntoView())(document.querySelectorAll('section'))`).catch(() => {}), await new Promise(r => setTimeout(r, 250));   // one section per picture
        try { fs.writeFileSync(path.join(dir, `${n}_${String(i).padStart(2, '0')}.png`), (await w.webContents.capturePage()).toPNG()); } catch (e) { log('shot failed: ' + e.message); }
      }
      if (i < +count) setTimeout(shot, +ms);
    };
    setTimeout(shot, 6000);
  }

  feed.watch(f => { lastFeed = f; cycleVoice(f); feedOut(); });
  // the renderer may still be loading when the first state comes (a line already playing at start): it gets the last one once loaded
  let lastTalk = null;
  voice.watch(on => { lastTalk = on; if (win && !win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send('talking', on); });
  if (win) win.webContents.on('did-finish-load', () => { if (lastTalk && lastTalk.on) win.webContents.send('talking', lastTalk); });
});
app.on('window-all-closed', () => app.quit());
