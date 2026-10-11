const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('sphere', {
  hit: over => ipcRenderer.send('hit', over),
  cursor: () => ipcRenderer.invoke('cursor'),
  covered: () => ipcRenderer.invoke('covered'),
  front: on => ipcRenderer.send('front', on),
  sphereArea: a => ipcRenderer.send('sphere-area', a),               // { x, y, r }: the folded sphere's circle in window DIPs
  onOccluded: cb => ipcRenderer.on('occluded', (_e, on) => cb(on)),  // true while apps cover the folded sphere
  settings: () => ipcRenderer.invoke('settings'),
  onSettings: cb => ipcRenderer.on('settings', (_e, s) => cb(s)),
  setSettings: patch => ipcRenderer.invoke('set-settings', patch),
  testVoice: () => ipcRenderer.send('test-voice'),
  testCycle: () => ipcRenderer.invoke('test-cycle'),
  openSettings: (section, rect) => ipcRenderer.send('open-settings', section, rect),
  setupInfo: () => ipcRenderer.invoke('setup-info'),   // -> { git, gh, wt, ffmpeg, claude } found or not
  claudeSettings: rect => ipcRenderer.invoke('claude-settings', rect),
  mode: () => ipcRenderer.invoke('mode'),
  setMode: m => ipcRenderer.invoke('set-mode', m),
  displays: () => ipcRenderer.invoke('displays'),
  feed: () => ipcRenderer.invoke('feed'),
  open: link => ipcRenderer.send('open', link),
  claudeSnap: () => ipcRenderer.invoke('claude-snap'),
  thumb: title => ipcRenderer.invoke('thumb', title),
  overlayOpen: (rect, link) => ipcRenderer.invoke('overlay-open', rect, link),
  claudePress: (rect, name) => ipcRenderer.invoke('claude-press', rect, name),
  overlayClose: () => ipcRenderer.invoke('overlay-close'),
  onOverlayClosed: cb => ipcRenderer.on('overlay-closed', () => cb()),
  // Session Console
  consoleOpen: sessionId => ipcRenderer.invoke('console-open', sessionId),        // -> { ok, title, link } or { ok: false, why }; messages follow as console-msg
  consoleClose: () => ipcRenderer.invoke('console-close'),
  onConsoleMsg: cb => ipcRenderer.on('console-msg', (_e, b) => cb(b)),            // { sessionId, msgs: [{ role, text, ts, uuid }], init, pending } pending: null | { kind: 'ask', id, questions } | { kind: 'plan', id, plan } | { kind: 'tool', id, name, summary, since }; undefined = unchanged
  onConsoleAwait: cb => ipcRenderer.on('console-await', (_e, b) => cb(b)),        // { sessionId, awaiting: true (the app shows 'Awaiting input') / false (a slow tool) / null (unknown) }
  consoleSend: (sessionId, text) => ipcRenderer.invoke('console-send', sessionId, text),   // -> { ok } or { ok: false, why }
  consoleStop: sessionId => ipcRenderer.invoke('console-stop', sessionId),
  consoleAnswer: (sessionId, answers) => ipcRenderer.invoke('console-answer', sessionId, answers),   // answers: [{ picks: [labels], other }] per question -> { ok, why }
  consolePermit: (sessionId, choice, id) => ipcRenderer.invoke('console-permit', sessionId, choice, id),    // 'Allow once' | 'Always allow' | 'Deny'; id = the waiting tool call shown -> { ok, why }
  consolePlan: (sessionId, choice, text) => ipcRenderer.invoke('console-plan', sessionId, choice, text),   // 'accept' | 'auto' | 'edits' | 'bypass' | 'revise' (text) | 'reject' -> { ok, why }
  consoleSettings: sessionId => ipcRenderer.invoke('console-settings', sessionId),   // -> { ok, model, effort, mode, fast } (feed + transcript, no app visit)
  consoleSet: (sessionId, what, value) => ipcRenderer.invoke('console-set', sessionId, what, value),   // what: mode | model | effort | fast -> settings after
  consoleManage: (sessionId, act, name) => ipcRenderer.invoke('console-manage', sessionId, act, name),   // act: rename (name) | fork | archive | delete -> { ok, why, title }
  draftGet: id => ipcRenderer.invoke('draft-get', id),                                // -> { text, atts: [{ name, path, img, gone }] } or null
  draftSet: (id, text, files, pngs) => ipcRenderer.invoke('draft-set', id, text, files, pngs),   // -> { ok, atts }
  consoleAttach: (sessionId, files, pngs, text) => ipcRenderer.invoke('console-attach', sessionId, files, pngs, text),   // files: paths, pngs: [Uint8Array] -> { ok, why }
  onConsoleNote: cb => ipcRenderer.on('console-note', (_e, b) => cb(b)),          // { sessionId, text }: a one-off note in the conversation (the tray)
  consoleDetail: (sessionId, kind, a, b) => ipcRenderer.invoke('console-detail', sessionId, kind, a, b),   // stage 5: a tool's output / thinking / subagent / image, read on demand
  consoleCommands: sessionId => ipcRenderer.invoke('console-commands', sessionId),     // -> { ok, names, at }: the app's / commands (read once a day)
  consoleFiles: sessionId => ipcRenderer.invoke('console-files', sessionId),           // -> { ok, root, entries: [{ p, d }] }: the session folder for @
  consoleMsgAct: (sessionId, act, text, back) => ipcRenderer.invoke('console-msgact', sessionId, act, text, back),   // fork | rewind | undo at one of your messages (back = identical newer ones to skip) -> { ok, why, draft, title }
  consolePane: (sessionId, kind, a) => ipcRenderer.invoke('console-pane', sessionId, kind, a),
  consoleAct: (sessionId, act, a) => ipcRenderer.invoke('console-act', sessionId, act, a),   // Bridge_Spec: commit | push | prcreate | worktrees | terminal | previews | files | open | mcp | app ...
  routinePrompts: (act, id, text) => ipcRenderer.invoke('routine-prompts', act, id, text),   // list | read | save the local routine prompts   // tabs: changes | diff (file) | pr | tasks | artifacts
  search: (text, o) => ipcRenderer.invoke('search', text, o),   // o: { who, folder, since } (the filter chips)                             // -> { ok, hits: [{ sessionId, title, uuid, role, ts, off, snippet: [before, match, after] }], done, ms }
  consoleAround: (sessionId, off) => ipcRenderer.invoke('console-around', sessionId, off),   // -> { ok, msgs }: the messages around an older search hit
  openUrl: u => ipcRenderer.send('open-url', u),                                  // a reply's link -> the browser (http / https only)
  pathOf: file => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },   // a dropped File -> its path
  consoleFolders: () => ipcRenderer.invoke('console-folders'),                    // -> { folders: [names], models: [labels] } for the New session form
  consoleNew: (folder, model, text, worktree) => ipcRenderer.invoke('console-new', folder, model, text, !!worktree),     // -> { ok, why, sessionId, title }; the id (maybe 'new:...') goes to consoleOpen
  consoleAuto: () => ipcRenderer.invoke('console-auto'),                          // SPHERE_CONSOLE (tests): a session to open at start, or null
  onMask: cb => ipcRenderer.on('mask', (_e, m) => cb(m)),
  maskHit: over => ipcRenderer.send('mask-hit', over),
  maskClick: () => ipcRenderer.send('mask-click'),
  onFeed: cb => ipcRenderer.on('feed', (_e, f) => cb(f)),
  onTalking: cb => ipcRenderer.on('talking', (_e, on) => cb(on)),
  onKeys: cb => ipcRenderer.on('keys', () => cb()),                              // Win+Alt+Space
  keyFocus: on => ipcRenderer.send('key-focus', !!on),
  // Theseus tools: audio, recorder, readout, strip
  tools: () => ipcRenderer.invoke('tools-state'),                                 // { audio, rec, sys, mode, listening, avail: { audio, rec }, keys: { failed } }
  onTools: cb => ipcRenderer.on('tools', (_e, t) => cb(t)),
  act: (name, arg) => ipcRenderer.invoke('tools-act', name, arg),                // nextOut, nextMic, muteMic, setVolume, recToggle, saveReplay, screenshot ...
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  mcpRegister: on => ipcRenderer.invoke('mcp-register', on),                    // the sphere's tools in Claude Code: true / false / undefined (ask) -> { ok, on, why }
  askToken: t => ipcRenderer.invoke('ask-token', t),                              // Voice Ask sign-in token: set (string, '' clears) / read (undefined) -> is one saved
  askTest: () => ipcRenderer.invoke('ask-test'),                                  // -> { ok, ms, text } or { ok: false, why }
  onVoiceOpen: cb => ipcRenderer.on('voice-open', (_e, a) => cb(a)),
  onVoiceCard: cb => ipcRenderer.on('voice-card', (_e, a) => cb(a)),           // { op: type / send / clear / close / next / prev / scroll / claude, text }           // { sessionId } (null: the New session form)
  onAsk: cb => ipcRenderer.on('ask', (_e, a) => cb(a)),                         // { state: thinking / answer / error, q, text }
  onNotice: cb => ipcRenderer.on('notice', (_e, text, ms) => cb(text, ms)),
  onLevels: cb => ipcRenderer.on('levels', (_e, l) => cb(l)),                    // strip meters: { mic, sys } 0..1 (null = not recorded), while recording
  onBg: cb => ipcRenderer.on('bg', (_e, s) => cb(s)),   // the background window: { style, opacity, visible, tint, speed, paused }
  onToast: cb => ipcRenderer.on('toast', (_e, p) => cb(p)),
  stripSize: (w, h) => ipcRenderer.send('strip-size', w, h),
  stripHit: over => ipcRenderer.send('strip-hit', over),
  stripDrag: (phase, d) => ipcRenderer.send('strip-drag', phase, d),   // d (start): how far the pointer had already moved
});
