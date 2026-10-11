// The background shader (Backgrounds_Spec), shared by the background window (bg.js) and the style pictures in Settings.
// makeBgShader(canvas) -> { gl, draw(style, time, tint, speed, alpha) } on that canvas's own WebGL context.
'use strict';
const BG_STYLE = { black: 0, space: 1, moving: 2, gradient: 3, travel: 4 }, BG_MOVING = new Set(['moving', 'gradient', 'travel']);
function makeBgShader(cv) {
const gl = cv.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true });
const VS = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
const FS = `precision highp float;
uniform vec2 uRes; uniform float uTime, uStyle, uAlpha, uTravel; uniform vec3 uTint;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
// one star per cell (about 1 in 3 lit), its own place, size, colour and twinkle
vec3 stars(vec2 uv, float t) {
  vec2 id = floor(uv), f = fract(uv) - 0.5;
  float r = h21(id), lit = step(0.66, r);
  vec2 o = vec2(h21(id + 3.7), h21(id + 9.1)) - 0.5;
  float d = length(f - o * 0.7), sz = 0.03 + 0.07 * h21(id + 5.3);
  float b = lit * smoothstep(sz, 0.0, d) * (0.75 + 0.25 * sin(t * (1.0 + 3.0 * r) + r * 40.0));
  return b * mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.86, 0.7), h21(id + 7.7));
}
vec3 nebula(vec2 p, float t) {
  float n = fbm(p * 1.6 + vec2(t * 0.01, -t * 0.006)), m = fbm(p * 2.4 - vec2(t * 0.008, 0.0) + 8.0);
  vec3 c = mix(vec3(0.10, 0.03, 0.18), vec3(0.05, 0.16, 0.32), m);
  return c * smoothstep(0.38, 0.85, n) * 1.4;
}
vec3 space(vec2 p, float t, float drift) {
  vec3 c = vec3(0.004, 0.006, 0.014) + nebula(p + drift * vec2(0.02, 0.01) * t, drift * t);
  c += stars((p + drift * vec2(0.010, 0.004) * t) * 60.0, t) * 0.8;
  c += stars((p + drift * vec2(0.020, 0.008) * t) * 30.0 + 11.0, t);
  c += stars((p + drift * vec2(0.040, 0.016) * t) * 14.0 + 23.0, t) * 1.2;
  return c;
}
vec3 gradient(vec2 p, float t) {
  vec2 q = vec2(fbm(p * 1.4 + t * 0.03), fbm(p * 1.4 + 5.2 - t * 0.025));
  float n = fbm(p * 1.1 + 2.2 * q + vec2(0.0, t * 0.02));
  vec3 a = uTint, b = uTint.zxy * 0.8 + 0.1;   // the mode colour and a shifted partner
  vec3 c = mix(a * 0.12 + 0.01, mix(a, b, smoothstep(0.3, 0.7, q.x)), smoothstep(0.25, 0.75, n));
  return c * 0.8;
}
// stars streaming from the centre: layers at depths cycling toward the camera, each sampled along its streak
vec3 travel(vec2 p, float t) {
  vec3 c = vec3(0.003, 0.004, 0.01);
  // a nebula that keeps zooming in: two copies half a cycle apart, faded across their loop
  for (int k = 0; k < 2; k++) {
    float ph = fract(t * 0.025 + float(k) * 0.5), z = exp2(ph * 1.5);
    c += nebula(p / z + float(k) * 3.1, 0.0) * sin(3.14159 * ph) * 0.9;
  }
  for (int i = 0; i < 7; i++) {
    float fi = float(i), depth = fract(fi / 7.0 + t * 0.06), sc = mix(26.0, 0.9, depth);
    float fade = smoothstep(0.0, 0.25, depth) * smoothstep(1.0, 0.85, depth);
    vec3 s = vec3(0.0);
    for (int k = 0; k < 8; k++) s += stars(p * sc * (1.0 - float(k) * 0.008 * depth * uTravel) + fi * 37.3, t) * 0.5;
    c += s * 0.35 * fade * (0.6 + depth);
  }
  // a planet now and then: every 45 s, seen in about half the cycles, flying out from near the centre
  float cyc = floor(t / 45.0), ph = fract(t / 45.0), seed = h21(vec2(cyc, 4.2));
  if (seed > 0.45) {
    float an = seed * 40.0, e = ph * ph;
    vec2 ctr = vec2(cos(an), sin(an)) * (0.08 + e * 1.4);
    float rad = 0.01 + e * 0.32, d = length(p - ctr);
    vec3 col = mix(vec3(0.75, 0.45, 0.30), vec3(0.35, 0.55, 0.85), h21(vec2(cyc, 1.0)));
    float bands = fbm(vec2((p.y - ctr.y) / rad * 3.0, cyc));
    vec2 n2 = (p - ctr) / rad; float lit = clamp(dot(normalize(vec3(n2, sqrt(max(0.0, 1.0 - dot(n2, n2))))), normalize(vec3(-0.6, 0.5, 0.6))), 0.0, 1.0);
    float body = smoothstep(rad, rad - 0.003, d), vis = smoothstep(0.0, 0.1, ph) * smoothstep(1.0, 0.8, ph);
    c = mix(c, col * (0.35 + 0.65 * bands) * (0.08 + 0.92 * lit), body * vis);
    if (seed > 0.75) {   // a ring
      vec2 rq = (p - ctr) / rad; rq.y *= 3.2; float rr = length(rq);
      float ring = smoothstep(0.06, 0.0, abs(rr - 1.7)) * (1.0 - body * step(0.0, rq.y));
      c += vec3(0.8, 0.75, 0.6) * ring * 0.5 * vis;
    }
  }
  return c;
}
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec3 c = vec3(0.0);
  if (uStyle < 0.5) c = vec3(0.0);
  else if (uStyle < 1.5) c = space(p, 0.0, 0.0);
  else if (uStyle < 2.5) c = space(p, uTime, 1.0);
  else if (uStyle < 3.5) c = gradient(p, uTime);
  else c = travel(p, uTime);
  gl_FragColor = vec4(c, uAlpha);
}`;
function sh(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; }
const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog); gl.useProgram(prog);
const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
const U = n => gl.getUniformLocation(prog, n), uRes = U('uRes'), uTime = U('uTime'), uStyle = U('uStyle'), uAlpha = U('uAlpha'), uTint = U('uTint'), uTravel = U('uTravel');

const rgb = h => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); const n = m ? parseInt(m[1], 16) : 0x3da5ff; return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
return { gl, draw(style, time, tint, speed, alpha) {
  gl.viewport(0, 0, cv.width, cv.height);
  gl.uniform2f(uRes, cv.width, cv.height); gl.uniform1f(uTime, time); gl.uniform1f(uStyle, BG_STYLE[style] ?? 0);
  gl.uniform1f(uAlpha, alpha); gl.uniform3fv(uTint, rgb(tint)); gl.uniform1f(uTravel, speed);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
} };
}
