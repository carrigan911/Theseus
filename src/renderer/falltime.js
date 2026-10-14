// Lightfall's timeline (Docs/Specs/Lightfall_Spec.md), shared by the sphere window (introfx.js imports it for its side
// effect) and the background window (a plain script), so both play the same moment from the same message.
// FALL.pose(dir, p) -> { lineY (the beam's tip, preview units: it covers y > lineY), A (beam strength), W (beam width),
//   F (flash), s (the sphere: 0 or 1, no growing), warp (space squeezed into the beam: 0..1, below 0 = springing past),
//   rumble (0..1), kick (seconds since the hit, or -1) }; FALL.shake(t, P) -> [dx, dy] in screen pixels.
// FALL.IN / FALL.OUT: the lengths (s), the same as the other animations.
(function () {
  const clamp = x => Math.max(0, Math.min(1, x));
  const sstep = (a, b, x) => { x = clamp((x - a) / (b - a)); return x * x * (3 - 2 * x); };
  const ease = x => 1 - Math.pow(1 - clamp(x), 3);
  const gauss = (x, w) => Math.exp(-(x / w) * (x / w));
  const IN = 2.5, OUT = 1.5;
  const spring = q => q <= 0 ? 1 : q >= 1 ? 0 : Math.exp(-5 * q) * Math.cos(q * 7.5) * (1 - sstep(.75, 1, q));   // 1 -> 0, past it once
  function pose(dir, p) {
    const P = { lineY: 9, A: 0, W: .02, F: 0, s: 0, warp: 0, rumble: 0, kick: -1 };
    P.lineY = 9 - 18 * ease(sstep(0, .12, p));                 // the beam falls from the top to the bottom
    if (dir === 'in') {
      const hit = .42, pull = sstep(.12, hit, p);
      P.warp = p < hit ? pull * pull : spring((p - hit) / .2);
      P.rumble = p < hit ? pull : 0;
      P.F = 1.8 * gauss(p - hit, .025);
      P.s = p >= hit ? 1 : 0;
      P.kick = p >= hit ? (p - hit) * IN : -1;
      P.A = sstep(0, .03, p) * (1 - sstep(.45, .8, p));
      P.W = .02 + .05 * clamp(P.warp) + .04 * P.F;
    } else {
      // (user 10-11) the beam falls, space collapses into it with a growing rumble, then the sphere goes in a flash,
      // then the beam winks out and space springs back
      const hit = .78, wink = .9, pull = sstep(.12, .7, p);
      P.s = p < hit ? 1 : 0;
      P.F = 1.8 * gauss(p - hit, .03) + .7 * gauss(p - wink, .018);
      P.kick = p >= hit ? (p - hit) * OUT : -1;
      P.warp = p < wink ? pull * pull : spring((p - wink) / .1);
      P.rumble = p < hit ? pull : 0;
      P.A = sstep(0, .03, p) * (1 - sstep(wink - .02, wink + .02, p));
      P.W = (.02 + .05 * clamp(P.warp) + .04 * P.F) * (1 - .8 * sstep(wink - .06, wink, p));
    }
    return P;
  }
  // rumble: a few px of smooth jitter; kick: one jolt, mostly downward (the light lands), gone in about 0.3 s
  function shake(t, P) {
    let x = 0, y = 0;
    if (P.rumble > 0) {
      const a = 3 * P.rumble * P.rumble;
      x += a * (Math.sin(t * 61) * .6 + Math.sin(t * 97 + 1.3) * .4);
      y += a * (Math.sin(t * 73 + .7) * .6 + Math.sin(t * 89 + 2.1) * .4);
    }
    if (P.kick >= 0 && P.kick < .4) {
      const e = Math.exp(-P.kick * 14) * 9;
      y += e * Math.cos(P.kick * 52); x += e * .35 * Math.sin(P.kick * 67);
    }
    return [x, y];
  }
  globalThis.FALL = { pose, shake, IN, OUT };
})();
