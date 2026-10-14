// Where this PC keeps its manager files. Public installs have no personal.settings.json: everything lives under
// <home>/Theseus. A personal copy sets "paths" there ({ data, projects, mgr, ctSource, mgrRoots }); env vars still win in each module.
const fs = require('fs');
const os = require('os');
const path = require('path');
let own = {};
if (!process.env.SPHERE_NO_PERSONAL) try { own = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'personal.settings.json'), 'utf8')).paths) || {}; } catch {}
const root = path.join(os.homedir(), 'Theseus');
const fwd = p => String(p).split(String.fromCharCode(92)).join('/');
const data = fwd(own.data || process.env.SPHERE_DATA_DIR || fwd(root));
const projects = fwd(own.projects || path.join(root, 'projects'));
const mgr = fwd(own.mgr || data + '/SessionManager');
const ctSource = fwd(own.ctSource || data + '/.mcp.json');
const mgrRoots = own.mgrRoots || '';
module.exports = { data, projects, mgr, ctSource, mgrRoots };
