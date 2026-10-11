// Pictures of pages shown in the card (artifacts, boards): saved while open, reused by the gallery plates and the
// Pinned hover previews. userData\thumbs\<slug>-<hash>.png + index.json { title: { file, t } }.
const { app, desktopCapturer, screen } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dir = () => path.join(app.getPath('userData'), 'thumbs');
let index = null;
function load() {
  if (!index) {
    try { index = JSON.parse(fs.readFileSync(path.join(dir(), 'index.json'), 'utf8')); } catch { index = {}; }
    if (!index || typeof index !== 'object' || Array.isArray(index)) index = {};
  }
  return index;
}
// the hash keeps titles that slug alike ("A/B" and "A B") apart
const slug = t => (t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'page') + '-' + crypto.createHash('sha1').update(t).digest('hex').slice(0, 6);

// rect = the card in screen DIPs; 2 px inside so the mask's border stays out
async function capture(title, rect) {
  const d = screen.getDisplayMatching(rect), sf = d.scaleFactor;
  const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) } });
  const s = srcs.find(x => x.display_id === String(d.id)) || srcs[0]; if (!s) return false;
  const img = s.thumbnail, k = img.getSize().width / d.size.width;
  if (!(k > 0)) return false;
  const crop = img.crop({ x: Math.round((rect.x - d.bounds.x + 2) * k), y: Math.round((rect.y - d.bounds.y + 2) * k),
    width: Math.round((rect.width - 4) * k), height: Math.round((rect.height - 4) * k) });
  fs.mkdirSync(dir(), { recursive: true });
  const f = slug(title) + '.png', idx = load(), old = idx[title] && idx[title].file;
  fs.writeFileSync(path.join(dir(), f), crop.resize({ width: 640, quality: 'good' }).toPNG());
  idx[title] = { file: f, t: Date.now() };
  // the 150 most recent pictures are kept (each page title ever opened would otherwise stay forever)
  const all = Object.keys(idx).sort((x, y) => ((idx[y] && idx[y].t) || 0) - ((idx[x] && idx[x].t) || 0));
  for (const k of all.slice(150)) { const e = idx[k]; delete idx[k]; if (e && typeof e.file === 'string' && !/[\\/]/.test(e.file) && e.file !== f) try { fs.unlinkSync(path.join(dir(), e.file)); } catch {} }
  const tmp = path.join(dir(), 'index.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(idx)); fs.renameSync(tmp, path.join(dir(), 'index.json'));
  // an old-style file (slug only) goes once no title uses it
  if (old && old !== f && !Object.values(idx).some(e => e && e.file === old)) try { fs.unlinkSync(path.join(dir(), old)); } catch {}
  return true;
}
// a data: URL (the renderer's CSP allows data: images, not file:)
function get(title) {
  const e = load()[title]; if (!e || typeof e.file !== 'string' || /[\\/]/.test(e.file)) return null;
  try { return 'data:image/png;base64,' + fs.readFileSync(path.join(dir(), e.file)).toString('base64'); } catch { return null; }
}
const titles = () => Object.keys(load());
module.exports = { capture, get, titles };
