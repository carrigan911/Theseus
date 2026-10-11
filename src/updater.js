// Update button (UpdateButton_Spec): an installed copy downloads a newer GitHub Release in the background (electron-updater);
// the dev copy (runs from the repo) watches master for commits that change the app. State goes to the sphere, tray and
// Settings only once an update is ready; apply() is the last step after main has played its outro.
const { execFileSync } = require('child_process');

const DEV_MS = 5 * 60000, REL_MS = 6 * 3600000, FIRST_MS = 30000;
const APP_PATHS = ['src', 'assets', 'package.json'];
const notesText = n => (Array.isArray(n) ? n.map(x => x && x.note || '').join('\n') : String(n || ''))
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, 2000);

function create(o) {
  const log = o.log || (() => {}), onState = o.onState || (() => {}), timers = o.timers || { setInterval, setTimeout, clearInterval };
  const git = o.git || ((...a) => execFileSync('git', ['-C', o.root, ...a], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  let state = { kind: 'none', version: o.version || '', notes: '', checkedAt: 0 }, startHead = null, au = null, ticks = [];
  const set = p => { const was = state.kind; state = { ...state, ...p }; if (was !== state.kind) log(`update: ${state.kind}${state.version ? ' ' + state.version : ''}`); onState({ ...state }); };

  // dev copy: an update is any commit since start that touches the app's own files (a Docs-only commit is not)
  function checkDev() {
    try {
      const head = git('rev-parse', 'HEAD');
      if (!startHead) { startHead = head; return; }
      let changed = false;
      if (head !== startHead) try { git('diff', '--quiet', startHead, head, '--', ...APP_PATHS); } catch (e) { changed = e.status === 1; }
      set({ checkedAt: Date.now(), ...(changed ? { kind: 'dev', notes: git('log', '--format=%s', `${startHead}..${head}`, '--', ...APP_PATHS).split('\n').slice(0, 8).join('\n') } : {}) });
    } catch (e) { log(`update: git check failed (${e.message.split('\n')[0]})`); }
  }

  // installed copy: electron-updater downloads and verifies (sha512 in latest.yml); the button shows once it is downloaded
  function releaseUpdater() {
    if (au) return au;
    au = o.autoUpdater || require('electron-updater').autoUpdater;
    au.autoDownload = true; au.autoInstallOnAppQuit = false; au.allowPrerelease = !!o.prerelease;
    au.logger = { info: () => {}, warn: m => log(`update: ${m}`), error: m => log(`update: ${m}`), debug: () => {} };
    au.on('update-available', i => set({ downloading: i.version }));   // Settings says so; the button waits for the download
    au.on('update-downloaded', i => set({ kind: 'release', version: i.version, notes: notesText(i.releaseNotes), downloading: '' }));
    au.on('error', e => log(`update: check failed (${String(e && e.message || e).split('\n')[0]})`));   // offline, private repo: quiet
    return au;
  }
  function checkRelease() {
    if (state.kind === 'release') return Promise.resolve();
    try { return Promise.resolve(releaseUpdater().checkForUpdates()).then(() => set({ checkedAt: Date.now() }), e => log(`update: check failed (${String(e && e.message || e).split('\n')[0]})`)); }
    catch (e) { log(`update: check failed (${e.message})`); return Promise.resolve(); }
  }

  const check = () => (o.dev ? (checkDev(), Promise.resolve()) : o.release === false ? Promise.resolve() : checkRelease());
  function start() {
    if (o.dev) { checkDev(); ticks.push(timers.setInterval(checkDev, DEV_MS)); return; }
    if (o.release === false) { log('update: release checks off (test channel)'); return; }
    timers.setTimeout(checkRelease, FIRST_MS); ticks.push(timers.setInterval(checkRelease, REL_MS));
  }
  // the last step: main has waited for swaps and played its outro. Dev: start again on the new code; release: silent install, then run
  function apply(app) {
    if (state.kind === 'dev') { app.relaunch(); app.quit(); return true; }
    if (state.kind === 'release' && au) { au.quitAndInstall(true, true); return true; }
    return false;
  }
  return { start, check, apply, state: () => ({ ...state }), stop: () => ticks.forEach(t => timers.clearInterval(t)) };
}

module.exports = { create, notesText, APP_PATHS };
