// The tray icon with its core in a given colour: assets/tray_base*.png (glass body) + a radial core glow + tray_top*.png (tiles, rim, highlight).
// The core uses the same stops as tools/make_icon.js, with the whites tinted towards the colour. Bitmaps are premultiplied BGRA.
const { nativeImage } = require('electron');
const fs = require('fs'), path = require('path');
const DIR = path.join(__dirname, '..', 'assets');
const SCALES = [[1, ''], [1.5, '@1.5x'], [2, '@2x'], [3, '@3x'], [4, '@4x']];
const layers = {};

function rgb(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); const n = m ? parseInt(m[1], 16) : 0x3da5ff; return [n >> 16, (n >> 8) & 255, n & 255]; }
const mix = (c, k) => c.map(v => v + (255 - v) * k);

function coreAt(stops, t) {                                    // colour + alpha of the gradient at t (0 centre .. 1 edge)
  if (t >= 1) return [0, 0, 0, 0];
  let i = 0; while (t > stops[i + 1][0]) i++;
  const [t0, c0, a0] = stops[i], [t1, c1, a1] = stops[i + 1], k = (t - t0) / (t1 - t0);
  return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k, a0 + (a1 - a0) * k];
}

function build(hex) {
  const c = rgb(hex), stops = [[0, mix(c, 0.9), 1], [0.18, mix(c, 0.5), 0.95], [0.5, c, 0.45], [1, c, 0]];
  const img = nativeImage.createEmpty();
  for (const [scale, sfx] of SCALES) {
    // read each file as a plain 1x image (a name with @2x would make Electron treat it as a scaled copy)
    const L = layers[sfx] || (layers[sfx] = { base: nativeImage.createFromBuffer(fs.readFileSync(path.join(DIR, `tray_base${sfx}.png`))), top: nativeImage.createFromBuffer(fs.readFileSync(path.join(DIR, `tray_top${sfx}.png`))) });
    if (L.base.isEmpty() || L.top.isEmpty()) continue;
    const { width: W, height: H } = L.base.getSize(), out = Buffer.from(L.base.toBitmap()), top = L.top.toBitmap();
    if (out.length !== W * H * 4 || top.length !== out.length) continue;
    const R = W / 2, cr = R * 0.94 * 0.62, N = 3;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let b = 0, g = 0, r = 0, a = 0;                             // the core, supersampled N x N, premultiplied
      for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
        const p = coreAt(stops, Math.hypot(x + (sx + 0.5) / N - R, y + (sy + 0.5) / N - R) / cr);
        r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
      }
      const n = N * N, i = (y * W + x) * 4; a /= n;
      for (const [o, v] of [[0, b / n], [1, g / n], [2, r / n], [3, a * 255]]) out[i + o] = Math.round(v + out[i + o] * (1 - a));
      const ta = top[i + 3] / 255;
      for (let o = 0; o < 4; o++) out[i + o] = Math.min(255, Math.round(top[i + o] + out[i + o] * (1 - ta)));
    }
    img.addRepresentation({ scaleFactor: scale, buffer: nativeImage.createFromBitmap(out, { width: W, height: H }).toPNG() });
  }
  return img.isEmpty() ? nativeImage.createFromPath(path.join(DIR, 'tray.png')) : img;
}

const cache = new Map();
module.exports = hex => {
  if (!cache.has(hex)) {
    if (cache.size >= 16) cache.delete(cache.keys().next().value);   // dragging a colour makes many: keep the last 16
    let img; try { img = build(hex); } catch { img = nativeImage.createFromPath(path.join(DIR, 'tray.png')); } cache.set(hex, img); }
  return cache.get(hex);
};
