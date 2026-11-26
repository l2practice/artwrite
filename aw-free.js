/* aw-free.js: the free layer of the Interactive Board (text boxes anywhere, pen, highlighter, eraser, shapes, symbols).
   The shape geometry and the symbol set are taken from the teacher's own Notes app (l2practice/notes). */
(function(){
'use strict';
const r1 = v => Math.round(v * 10) / 10;
/* ═══════════ shape geometry (from Notes) ═══════════ */
/* ---------- geometry ---------- */
function distSeg(px, py, ax, ay, bx, by){
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function bez(p0, p1, p2, p3, n){
  const out = [];
  for (let i = 1; i <= n; i++){ const t = i / n, u = 1 - t;
    out.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]); }
  return out;
}
function braceLocal(w, h){   // squared "{": short arms, straight spine, angular notch in the middle
  const s = 0.55, d = Math.min(h * 0.08, w * 0.5), m = h / 2;
  return [[w, 0], [w * s, 0], [w * s, m - d], [0, m], [w * s, m + d], [w * s, h], [w, h]];
}
const bracketLocal = (w, h) => [[w, 0], [0, 0], [0, h], [w, h]];
/* returns polylines (arrays of [x,y]) in page units */
function shapePaths0(st){
  const k = st.k, x = st.x, y = st.y, w = st.bw || 0, h = st.bh || 0;
  if (k === 'sym' || k === 'img') return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x + w / 2, y + h / 2]]];
  if (k === 'line') return lineWithEnds(st);
  if (k === 'loop') return loopPath(st);
  if (k === 'caret') return [[[x, y], [st.x2, st.y2], [st.x3, st.y3]]];
  if (k === 'arrow'){
    const a = Math.atan2(st.y2 - y, st.x2 - x), L = Math.max(9, (st.sw || 2) * 4.5), s = .45;
    const hd = an => [st.x2 - L * Math.cos(an), st.y2 - L * Math.sin(an)];
    return [[[x, y], [st.x2, st.y2]], [hd(a - s), [st.x2, st.y2], hd(a + s)]];
  }
  if (k === 'ellipse'){ const cx = x + w / 2, cy = y + h / 2, a = [];
    for (let i = 0; i <= 72; i++){ const t = i / 72 * Math.PI * 2; a.push([cx + w / 2 * Math.cos(t), cy + h / 2 * Math.sin(t)]); } return [a]; }
  if (k === 'rect') return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]];
  if (k === 'tri') return [[[x + w / 2, y], [x + w, y + h], [x, y + h], [x + w / 2, y]]];
  if (k === 'star'){ const cx = x + w / 2, cy = y + h / 2, a = [];
    for (let i = 0; i <= 10; i++){ const t = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 === 0 ? 1 : 0.382; a.push([cx + w / 2 * r * Math.cos(t), cy + h / 2 * r * Math.sin(t)]); } return [a]; }
  if (k === 'brkt' || k === 'brace'){
    const o = st.o || 0, vert = (o & 1) === 0, lw = vert ? w : h, lh = vert ? h : w;
    const loc = (k === 'brkt' ? bracketLocal : braceLocal)(lw, lh);
    return [loc.map(([lx, ly]) => o === 0 ? [x + lx, y + ly] : o === 2 ? [x + w - lx, y + ly] : o === 1 ? [x + ly, y + lx] : [x + ly, y + h - lx])];
  }
  const M = mathShape(st); if (M) return M;
  return [];
}
/* curved arrow ending in an open arrow head; the bend comes from the control point */
function loopPath(st){
  const P0 = [st.x, st.y], P2 = [st.x2, st.y2], C = [st.x3, st.y3], chord = Math.hypot(P2[0] - P0[0], P2[1] - P0[1]);
  if (chord < 2) return [[P0, P2]];
  const q = t => { const u = 1 - t; return [u * u * P0[0] + 2 * u * t * C[0] + t * t * P2[0], u * u * P0[1] + 2 * u * t * C[1] + t * t * P2[1]]; };
  const dq = t => { const u = 1 - t; return [2 * u * (C[0] - P0[0]) + 2 * t * (P2[0] - C[0]), 2 * u * (C[1] - P0[1]) + 2 * t * (P2[1] - C[1])]; };
  const pts = []; for (let i = 0; i <= 48; i++) pts.push(q(i / 48));
  const de = dq(1), a = Math.atan2(de[1], de[0]), L = Math.max(12, (st.sw || 2) * 5.5), hd = an => [P2[0] - L * Math.cos(an), P2[1] - L * Math.sin(an)];
  return [pts, [hd(a - .5), P2, hd(a + .5)]];
}
/* a straight line that can carry a dot, square, arrow head or dimension bar at either end */
const LINE_ENDS = [['dot', 'arrow', 'Dot to arrow'], ['sq', 'arrow', 'Square to arrow'], ['arrow', 'arrow', 'Double arrow'], ['arrow', '', 'Arrow pointing back'], ['arrow', 'dot', 'Arrow, dot at the end'], ['arrow', 'sq', 'Arrow, square at the end'], ['dim', 'dim', 'Dimension line']];
function lineWithEnds(st){
  const out = [[[st.x, st.y], [st.x2, st.y2]]]; if (!st.e0 && !st.e1) return out;
  const sw = st.sw || 2, ang = Math.atan2(st.y2 - st.y, st.x2 - st.x), L = Math.max(9, sw * 4.5), r = Math.max(4, sw * 1.8);
  const end = (px, py, a, kind) => {
    const c = Math.cos(a), sn = Math.sin(a);
    if (kind === 'arrow' || kind === 'dim'){ const h = an => [px - L * Math.cos(an), py - L * Math.sin(an)]; out.push([h(a - .45), [px, py], h(a + .45)]); }
    if (kind === 'dim') out.push([[px - sn * L * .8, py + c * L * .8], [px + sn * L * .8, py - c * L * .8]]);
    if (kind === 'dot') out.push(arcPts(px, py, r, r, 0, 2 * Math.PI, 16));
    if (kind === 'sq') out.push([[-r, -r], [r, -r], [r, r], [-r, r], [-r, -r]].map(([u, v]) => [px + u * c - v * sn, py + u * sn + v * c]));
  };
  if (st.e1) end(st.x2, st.y2, ang, st.e1);
  if (st.e0) end(st.x, st.y, ang + Math.PI, st.e0);
  return out;
}
/* a shape can be turned (st.rot, degrees, clockwise) about the middle of its box */
const rotatable = st => st.t === 'shape' && st.bw !== undefined && st.k !== 'sym' && st.k !== 'img';
function shapePaths(st){
  const a = shapePaths0(st); if (!(st.rot || st.fx || st.fy) || !rotatable(st)) return a;
  const th = (st.rot || 0) * Math.PI / 180, c = Math.cos(th), sn = Math.sin(th), cx = st.x + st.bw / 2, cy = st.y + st.bh / 2, fx = st.fx ? -1 : 1, fy = st.fy ? -1 : 1;
  return a.map(poly => poly.map(q => { const dx = (q[0] - cx) * fx, dy = (q[1] - cy) * fy; return [cx + dx * c - dy * sn, cy + dx * sn + dy * c]; }));
}
/* ---------- maths shapes: plane figures, graphs, solids (hidden edges dashed) ---------- */
function dashLine(a, b, sw){
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), d = Math.max(3, (sw || 2) * 2.2), g = Math.max(2.5, (sw || 2) * 1.7), out = [];
  for (let p = 0; p < L; p += d + g){ const q = Math.min(L, p + d); out.push([[a[0] + dx * p / L, a[1] + dy * p / L], [a[0] + dx * q / L, a[1] + dy * q / L]]); }
  return out;
}
function dashPoly(pts, sw){ const out = []; for (let i = 1; i < pts.length; i++) out.push(...dashLine(pts[i - 1], pts[i], sw)); return out; }
function arcPts(cx, cy, rx, ry, t0, t1, n){ const a = []; for (let i = 0; i <= n; i++){ const t = t0 + (t1 - t0) * i / n; a.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]); } return a; }
const _fx = a => a.map(q => [1 - q[0], q[1]]), _fy = a => a.map(q => [q[0], 1 - q[1]]), _tr = a => a.map(q => [q[1], q[0]]);
const _RA = [[0, .25], [.6, .25], [.6, 0], [1, .5], [.6, 1], [.6, .75], [0, .75]], _LR = [[0, .5], [.22, 0], [.22, .25], [.78, .25], [.78, 0], [1, .5], [.78, 1], [.78, .75], [.22, .75], [.22, 1]];
const _RC = [[0, 0], [.5, 0], [.5, .3], [.75, .3], [.75, .1], [1, .5], [.75, .9], [.75, .7], [.5, .7], [.5, 1], [0, 1]];
const BLOCK = {
  rarrow: _RA, larrow: _fx(_RA), darrow: _tr(_RA), uarrow: _fy(_tr(_RA)), lrarrow: _LR, udarrow: _tr(_LR),
  chevron: [[0, 0], [.7, 0], [1, .5], [.7, 1], [0, 1], [.3, .5]], homeplate: [[0, 0], [.7, 0], [1, .5], [.7, 1], [0, 1]],
  notched: [[0, .25], [.6, .25], [.6, 0], [1, .5], [.6, 1], [.6, .75], [0, .75], [.15, .5]],
  barrow: [[0, 1], [0, .25], [.62, .25], [.62, 0], [1, .36], [.62, .72], [.62, .47], [.28, .47], [.28, 1]],
  bentup: [[0, .7], [.64, .7], [.64, .3], [.5, .3], [.75, 0], [1, .3], [.86, .3], [.86, 1], [0, 1]],
  cornerarrow: [[.08, .92], [.08, .3], [0, .3], [.2, 0], [.4, .3], [.32, .3], [.32, .68], [.7, .68], [.7, .6], [1, .8], [.7, 1], [.7, .92]],
  quad: [[.5, 0], [.65, .18], [.57, .18], [.57, .43], [.82, .43], [.82, .35], [1, .5], [.82, .65], [.82, .57], [.57, .57], [.57, .82], [.65, .82], [.5, 1], [.35, .82], [.43, .82], [.43, .57], [.18, .57], [.18, .65], [0, .5], [.18, .35], [.18, .43], [.43, .43], [.43, .18], [.35, .18]],
  lrup: [[0, .7], [.18, .52], [.18, .62], [.43, .62], [.43, .2], [.35, .2], [.5, 0], [.65, .2], [.57, .2], [.57, .62], [.82, .62], [.82, .52], [1, .7], [.82, .88], [.82, .78], [.18, .78], [.18, .88]],
  tfork: [[.5, 0], [.64, .2], [.57, .2], [.57, .52], [.79, .52], [.79, .3], [.72, .3], [.86, .08], [1, .3], [.93, .3], [.93, .66], [.57, .66], [.57, 1], [.43, 1], [.43, .66], [.07, .66], [.07, .3], [0, .3], [.14, .08], [.28, .3], [.21, .3], [.21, .52], [.43, .52], [.43, .2], [.36, .2]],
  yfork: [[.42, 1], [.42, .583], [.163, .327], [.121, .369], [.079, .129], [.319, .171], [.277, .213], [.5, .437], [.723, .213], [.681, .171], [.921, .129], [.879, .369], [.837, .327], [.58, .583], [.58, 1]],
  rcall: _RC, lcall: _fx(_RC), dcall: _tr(_RC), ucall: _fy(_tr(_RC)),
  lrcall: [[0, .5], [.17, .25], [.17, .36], [.3, .36], [.3, 0], [.7, 0], [.7, .36], [.83, .36], [.83, .25], [1, .5], [.83, .75], [.83, .64], [.7, .64], [.7, 1], [.3, 1], [.3, .64], [.17, .64], [.17, .75]],
  quadcall: [[.5, 0], [.63, .16], [.56, .16], [.56, .3], [.7, .3], [.7, .44], [.84, .44], [.84, .37], [1, .5], [.84, .63], [.84, .56], [.7, .56], [.7, .7], [.56, .7], [.56, .84], [.63, .84], [.5, 1], [.37, .84], [.44, .84], [.44, .7], [.3, .7], [.3, .56], [.16, .56], [.16, .63], [0, .5], [.16, .37], [.16, .44], [.3, .44], [.3, .3], [.44, .3], [.44, .16], [.37, .16]]
};
/* an arrow that follows a curve: body of constant width, then a head */
function ribbon(cl, m){
  const bw = m * .16, hw = m * .3, hl = m * .36, n = cl.length, cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(cl[i][0] - cl[i - 1][0], cl[i][1] - cl[i - 1][1]));
  const total = cum[n - 1], cut = Math.max(0, total - hl), body = [cl[0]];
  for (let i = 1; i < n; i++){ if (cum[i] <= cut) body.push(cl[i]); else { const f = (cut - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1); body.push([cl[i - 1][0] + (cl[i][0] - cl[i - 1][0]) * f, cl[i - 1][1] + (cl[i][1] - cl[i - 1][1]) * f]); break; } }
  const tip = cl[n - 1], e = body[body.length - 1], dx = tip[0] - e[0], dy = tip[1] - e[1], dl = Math.hypot(dx, dy) || 1, ux = dx / dl, uy = dy / dl;
  const left = [], right = [];
  body.forEach((q, i) => { const a = body[Math.max(0, i - 1)], b = body[Math.min(body.length - 1, i + 1)]; let tx = b[0] - a[0], ty = b[1] - a[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl; left.push([q[0] - ty * bw / 2, q[1] + tx * bw / 2]); right.push([q[0] + ty * bw / 2, q[1] - tx * bw / 2]); });
  const poly = left.concat([[e[0] - uy * hw, e[1] + ux * hw], tip, [e[0] + uy * hw, e[1] - ux * hw]], right.reverse()); poly.push(poly[0]); return poly;
}
function mathShape(st){
  const k = st.k, x = st.x, y = st.y, w = st.bw || 0, h = st.bh || 0, sw = st.sw || 2, o = st.o || 0, PI = Math.PI;
  const U = (fx, fy) => [x + fx * w, y + fy * h];
  const P = (pts, close) => { const a = pts.map(q => U(q[0], q[1])); if (close) a.push(a[0]); return a; };
  const cx = x + w / 2, cy = y + h / 2;
  const curve = (f, n) => { const a = []; for (let i = 0; i <= n; i++){ const q = f(i / n); a.push(U(q[0], q[1])); } return a; };
  switch (k){
    case 'rarrow': case 'larrow': case 'darrow': case 'uarrow': case 'lrarrow': case 'udarrow': case 'chevron': case 'homeplate': case 'notched': case 'lrup': case 'quad': case 'cornerarrow': case 'bentup': case 'barrow': case 'rcall': case 'lcall': case 'dcall': case 'ucall': case 'lrcall': case 'quadcall': case 'yfork': case 'tfork':
      return [P(BLOCK[k], 1)];
    case 'striped': return [P([[0, .25], [.06, .25], [.06, .75], [0, .75]], 1), P([[.11, .25], [.19, .25], [.19, .75], [.11, .75]], 1), P([[.25, .25], [.6, .25], [.6, 0], [1, .5], [.6, 1], [.6, .75], [.25, .75]], 1)];
    case 'uturn': { const cx0 = .47, ro = .47, ri = .31, ry = .45, riy = .29, yc = .45;
      const outer = arcPts(0, 0, 1, 1, Math.PI, 2 * Math.PI, 28).map(q => [cx0 + ro * q[0], yc + ry * q[1]]), inner = arcPts(0, 0, 1, 1, Math.PI, 2 * Math.PI, 28).map(q => [cx0 + ri * q[0], yc + riy * q[1]]).reverse();
      return [P([[0, 1], [0, yc]].concat(outer, [[.94, .62], [1, .62], [.86, .9], [.72, .62], [.78, .62]], inner, [[.16, 1]]), 1)]; }
    case 'scurve': { const cl = []; for (let i = 0; i <= 40; i++){ const t = i / 40; cl.push(U(t, .5 + .34 * Math.cos(Math.PI * t))); } return [ribbon(cl, Math.min(w, h))]; }
    case 'trap': return [P([[.22, 0], [.78, 0], [1, 1], [0, 1]], 1)];
    case 'rtrap': return [P([[0, 0], [.66, 0], [1, 1], [0, 1]], 1)];
    case 'para': return [P([[.26, 0], [1, 0], [.74, 1], [0, 1]], 1)];
    case 'rhomb': return [P([[.5, 0], [1, .5], [.5, 1], [0, .5]], 1)];
    case 'rtri': { const m = Math.min(w, h) * .14; return [[[x, y], [x, y + h], [x + w, y + h], [x, y]], [[x, y + h - m], [x + m, y + h - m], [x + m, y + h]]]; }
    case 'pent': return [arcPts(cx, cy, w / 2, h / 2, -PI / 2, -PI / 2 + 2 * PI, 5)];
    case 'hex': return [arcPts(cx, cy, w / 2, h / 2, 0, 2 * PI, 6)];
    case 'semi': return [arcPts(cx, y + h, w / 2, h, PI, 2 * PI, 40).concat([[x, y + h]])];
    case 'angle': { const a = Math.atan2(-h, w * .7), r = Math.min(w, h) * .32;
      return [[[x + w, y + h], [x, y + h], [x + w * .7, y]], arcPts(x, y + h, r, r, 0, a, 20)]; }
    case 'axes': { const L = Math.max(7, Math.min(12, Math.min(w, h) * .14)), ax = (px, py, dx, dy) => [[px - L * (dx * .87 - dy * .5), py - L * (dy * .87 + dx * .5)], [px, py], [px - L * (dx * .87 + dy * .5), py - L * (dy * .87 - dx * .5)]];
      return [[[x, cy], [x + w, cy]], ax(x + w, cy, 1, 0), [[cx, y + h], [cx, y]], ax(cx, y, 0, -1)]; }
    case 'parab': { const f = o === 0 ? t => [.5 + .5 * t, 1 - t * t] : o === 2 ? t => [.5 + .5 * t, t * t] : o === 1 ? t => [t * t, .5 + .5 * t] : t => [1 - t * t, .5 + .5 * t];
      return [curve(u => f(u * 2 - 1), 48)]; }
    case 'cubic': return [curve(u => { const t = u * 2 - 1; return [.5 + .5 * t, .5 - .5 * t * t * t]; }, 48)];
    case 'sine': return [curve(u => [u, .5 - .5 * Math.sin(u * 4 * PI)], 80)];
    case 'hyp': return [curve(u => { const v = .12 + .88 * u; return [.5 + .5 * v, .5 - .06 / v]; }, 40), curve(u => { const v = .12 + .88 * u; return [.5 - .5 * v, .5 + .06 / v]; }, 40)];
    case 'expo': return [curve(u => [u, 1 - (Math.exp(3 * u) - 1) / (Math.exp(3) - 1)], 40)];
    case 'cube': case 'cuboid': { const d = Math.min(w, h) * .3;
      const F = [[x, y + d], [x + w - d, y + d], [x + w - d, y + h], [x, y + h]], B = [[x + d, y], [x + w, y], [x + w, y + h - d], [x + d, y + h - d]];
      return [F.concat([F[0]]), [F[0], B[0], B[1], B[2], F[2]], [F[1], B[1]], ...dashLine(F[3], B[3], sw), ...dashLine(B[3], B[2], sw), ...dashLine(B[3], B[0], sw)]; }
    case 'cyl': { const ry = Math.min(h * .14, w * .25), rx = w / 2;
      return [arcPts(cx, y + ry, rx, ry, 0, 2 * PI, 36), [[x, y + ry], [x, y + h - ry]], [[x + w, y + ry], [x + w, y + h - ry]], arcPts(cx, y + h - ry, rx, ry, 0, PI, 18), ...dashPoly(arcPts(cx, y + h - ry, rx, ry, PI, 2 * PI, 18), sw)]; }
    case 'cone': { const ry = Math.min(h * .14, w * .25), rx = w / 2;
      return [[[x, y + h - ry], [cx, y], [x + w, y + h - ry]], arcPts(cx, y + h - ry, rx, ry, 0, PI, 18), ...dashPoly(arcPts(cx, y + h - ry, rx, ry, PI, 2 * PI, 18), sw)]; }
    case 'sphere': { const ry = Math.min(h * .2, w * .3);
      return [arcPts(cx, cy, w / 2, h / 2, 0, 2 * PI, 48), arcPts(cx, cy, w / 2, ry, 0, PI, 18), ...dashPoly(arcPts(cx, cy, w / 2, ry, PI, 2 * PI, 18), sw)]; }
    case 'pyr': { const A = U(0, 1), B = U(.7, 1), C = U(1, .68), D = U(.3, .68), S = U(.5, 0);
      return [[A, B, C], [S, A], [S, B], [S, C], ...dashLine(A, D, sw), ...dashLine(D, C, sw), ...dashLine(S, D, sw)]; }
    case 'prism': { const F = [U(0, 1), U(.7, 1), U(.35, .3)], B = F.map(q => [q[0] + w * .3, q[1] - h * .28]);
      return [[F[0], F[1], F[2], F[0]], [F[1], B[1], B[2], F[2]], [B[1], B[2]], ...dashLine(F[0], B[0], sw), ...dashLine(B[0], B[1], sw), ...dashLine(B[0], B[2], sw)]; }
  }
  return null;
}
function shapeIconSVG(k, o){
  let ends = null; if (k === 'lnx'){ ends = LINE_ENDS[o] || ['', '']; k = 'line'; o = 0; }
  const vert = (o & 1) === 0, bk = k === 'brkt' || k === 'brace';
  const st = k === 'loop' ? { x: 24, y: 5, x2: 5, y2: 23, x3: 5, y3: 5 } : k === 'caret' ? { x: 3, y: 24, x2: 14, y2: 4, x3: 25, y3: 24 } : bk ? (vert ? { x: 9, y: 3, bw: 10, bh: 22 } : { x: 3, y: 9, bw: 22, bh: 10 }) : (k === 'line' || k === 'arrow') ? { x: 4, y: 24, x2: 24, y2: 4 } : { x: 4, y: 4, bw: 20, bh: 20 };
  Object.assign(st, { k, o, sw: 2 }); if (ends){ if (ends[0]) st.e0 = ends[0]; if (ends[1]) st.e1 = ends[1]; }
  const d = shapePaths(st).map(poly => poly.map((q, i) => (i ? 'L' : 'M') + r1(q[0]) + ' ' + r1(q[1])).join('')).join('');
  return '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>';
}
const SHAPES = [['line', 0, 'Line'], ['arrow', 0, 'Arrow'], ['caret', 0, 'Inverted V — draw up to the top, pause, then pull down; every corner can be dragged'], ['ellipse', 0, 'Circle / oval'], ['rect', 0, 'Rectangle'], ['tri', 0, 'Triangle'], ['star', 0, 'Star'],
  ['brkt', 0, 'Bracket ['], ['brkt', 2, 'Bracket ]'], ['brkt', 1, 'Bracket, lying, open down'], ['brkt', 3, 'Bracket, lying, open up'],
  ['brace', 0, 'Brace {'], ['brace', 2, 'Brace }'], ['brace', 3, 'Brace, lying, tip down'], ['brace', 1, 'Brace, lying, tip up'], ['loop', 0, 'Curved arrow — draw from where it starts to where it ends; drag the middle dot to change the bend'],
  null, ['trap', 0, 'Trapezoid'], ['rtrap', 0, 'Right trapezoid'], ['para', 0, 'Parallelogram'], ['rhomb', 0, 'Rhombus'], ['rtri', 0, 'Right triangle'], ['pent', 0, 'Pentagon'], ['hex', 0, 'Hexagon'], ['semi', 0, 'Semicircle'], ['angle', 0, 'Angle'],
  null, ['axes', 0, 'Coordinate axes (Oxy)'], ['parab', 0, 'Parabola, opens up'], ['parab', 2, 'Parabola, opens down'], ['parab', 1, 'Parabola, opens right'], ['parab', 3, 'Parabola, opens left'], ['cubic', 0, 'Cubic curve y = x³'], ['sine', 0, 'Sine wave'], ['hyp', 0, 'Hyperbola y = k/x'], ['expo', 0, 'Exponential curve'],
  null, ['cube', 0, 'Cube'], ['cuboid', 0, 'Cuboid (rectangular box)'], ['cyl', 0, 'Cylinder'], ['cone', 0, 'Cone'], ['sphere', 0, 'Sphere'], ['pyr', 0, 'Pyramid'], ['prism', 0, 'Triangular prism'],
  null, ['rarrow', 0, 'Right arrow'], ['larrow', 0, 'Left arrow'], ['darrow', 0, 'Down arrow'], ['uarrow', 0, 'Up arrow'], ['lrarrow', 0, 'Left-right arrow'], ['udarrow', 0, 'Up-down arrow'],
  ['uturn', 0, 'U-turn arrow'], ['scurve', 0, 'Curved arrow'], ['yfork', 0, 'Forked arrow (Y)'], ['tfork', 0, 'Triple up arrow'], ['quad', 0, 'Four-way arrow'], ['barrow', 0, 'Bent arrow'],
  ['chevron', 0, 'Chevron'], ['homeplate', 0, 'Pentagon arrow'], ['striped', 0, 'Striped arrow'], ['lrup', 0, 'Left-right-up arrow'], ['notched', 0, 'Notched arrow'], ['bentup', 0, 'Bent-up arrow'], ['cornerarrow', 0, 'Up-right arrow'],
  ['rcall', 0, 'Right arrow callout'], ['lcall', 0, 'Left arrow callout'], ['dcall', 0, 'Down arrow callout'], ['ucall', 0, 'Up arrow callout'], ['lrcall', 0, 'Left-right callout'], ['quadcall', 0, 'Four-way callout'],
  null, ['lnx', 0, 'Dot to arrow'], ['lnx', 1, 'Square to arrow'], ['lnx', 2, 'Double arrow'], ['lnx', 3, 'Arrow pointing back'], ['lnx', 4, 'Arrow, dot at the end'], ['lnx', 5, 'Arrow, square at the end'], ['lnx', 6, 'Dimension line']];

/* ═══════════ line styles and shape recognition (from Notes) ═══════════ */
const LINE_STYLES = [['solid', 'Solid line', ''], ['dash', 'Dashed', '7 5'], ['long', 'Long dashes', '13 6'], ['dot', 'Dotted', '0.5 5.5'], ['dashdot', 'Dash-dot', '10 4 1 4']];
function dashFor(ls, w, k){
  const w1 = Math.max(w, 1.4) * k;
  switch (ls){
    case 'dash': return [4 * w1, 3 * w1];
    case 'long': return [8 * w1, 3.5 * w1];
    case 'dot': return [0.01, 2.2 * w1];
    case 'dashdot': return [6 * w1, 2.5 * w1, 0.01, 2.5 * w1];
  }
  return [];
}
const SOLID_PARTS = { loop: [1], arrow: [1], axes: [1, 3], rtri: [1], angle: [1] };
const isSolidPart = (st, pi) => st.k === 'line' ? pi >= 1 : (SOLID_PARTS[st.k] || []).indexOf(pi) >= 0;   // arrow heads and the right-angle mark stay solid
function rdp(pts, eps){
  if (pts.length < 3) return pts;
  let dm = 0, idx = 0; const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++){ const d = distSeg(pts[i][0], pts[i][1], a[0], a[1], b[0], b[1]); if (d > dm){ dm = d; idx = i; } }
  if (dm > eps){ const l = rdp(pts.slice(0, idx + 1), eps), r = rdp(pts.slice(idx), eps); return l.slice(0, -1).concat(r); }
  return [a, b];
}
function turnAngle(a, b, c){ // 0 = straight on, 180 = full reversal
  const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const l = Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]); if (!l) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / l))) * 180 / Math.PI;
}
/* Is P an upright bracket? 0 = "[" (spine on the left), 2 = "]" (spine on the right), -1 = no */
function brktOrient(P, minx, miny, w, h){
  if (h < 1.25 * w || w < 4) return -1;
  const a = P[0], b = P[P.length - 1], maxy = miny + h;
  const topBottom = (Math.abs(a[1] - miny) < 0.18 * h && Math.abs(b[1] - maxy) < 0.18 * h) || (Math.abs(b[1] - miny) < 0.18 * h && Math.abs(a[1] - maxy) < 0.18 * h);
  if (!topBottom) return -1;
  for (const o of [0, 2]){
    const sd = q => o === 0 ? q[0] - minx : minx + w - q[0];   // distance from the spine side
    if (sd(a) < 0.6 * w || sd(b) < 0.6 * w) continue;          // both ends must be on the open side
    let lo = 1e9, hi = -1e9, ok = true;
    for (const q of P){
      if (sd(q) < 0.25 * w){ lo = Math.min(lo, q[1]); hi = Math.max(hi, q[1]); }
      else if (!(q[1] - miny < 0.16 * h || maxy - q[1] < 0.16 * h)) ok = false;
    }
    if (ok && hi - lo > 0.7 * h) return o;
  }
  return -1;
}
function recognize(P){
  if (P.length < 4) return null;
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9, L = 0;
  P.forEach((q, i) => { minx = Math.min(minx, q[0]); maxx = Math.max(maxx, q[0]); miny = Math.min(miny, q[1]); maxy = Math.max(maxy, q[1]); if (i) L += Math.hypot(q[0] - P[i - 1][0], q[1] - P[i - 1][1]); });
  const w = maxx - minx, h = maxy - miny, diag = Math.hypot(w, h);
  if (L < 14 || diag < 10) return null;
  const a = P[0], b = P[P.length - 1], chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const box = k => ({ t: 'shape', k, x: minx, y: miny, bw: w, bh: h });
  if (chord >= 0.22 * L){
    let dev = 0; P.forEach(q => { dev = Math.max(dev, distSeg(q[0], q[1], a[0], a[1], b[0], b[1])); });
    if (dev < Math.max(4, 0.13 * chord) && L < 1.4 * chord) return { t: 'shape', k: 'line', x: a[0], y: a[1], x2: b[0], y2: b[1] };
    // a "[" or "]" drawn in one stroke (arm, spine, arm), upright or lying down
    const tp = P.map(q => [q[1], q[0]]);
    let o = brktOrient(P, minx, miny, w, h); if (o >= 0) return { t: 'shape', k: 'brkt', o, x: minx, y: miny, bw: w, bh: h };
    o = brktOrient(tp, miny, minx, h, w); if (o >= 0) return { t: 'shape', k: 'brkt', o: o === 0 ? 1 : 3, x: minx, y: miny, bw: w, bh: h };
    return null;
  }
  // closed outline
  const cx = minx + w / 2, cy = miny + h / 2, rx = Math.max(w / 2, 1), ry = Math.max(h / 2, 1);
  const rs = P.map(q => Math.hypot((q[0] - cx) / rx, (q[1] - cy) / ry)), mean = rs.reduce((s, v) => s + v, 0) / rs.length;
  const sd = Math.sqrt(rs.reduce((s, v) => s + (v - mean) * (v - mean), 0) / rs.length);
  if (sd < 0.075 && mean > 0.85 && mean < 1.15){
    const sq = Math.abs(w - h) < 0.15 * Math.max(w, h), m = (w + h) / 2;
    return sq ? { t: 'shape', k: 'ellipse', x: cx - m / 2, y: cy - m / 2, bw: m, bh: m } : box('ellipse');
  }
  const star = rdp(P, 0.05 * diag);
  if (star.length >= 5 && star.length <= 7 && L > 2.2 * diag){
    let sharp = 0, n = 0; for (let i = 1; i < star.length - 1; i++){ sharp += turnAngle(star[i - 1], star[i], star[i + 1]); n++; }
    if (n && sharp / n > 110) return box('star');
  }
  const poly = rdp(P.concat([P[0]]), 0.07 * diag), n = poly.length - 1;
  const angs = []; for (let i = 0; i < n; i++) angs.push(turnAngle(poly[(i + n - 1) % n], poly[i], poly[(i + 1) % n]));
  if (n === 3) return box('tri');
  if (n === 4 && angs.every(an => Math.abs(an - 90) < 30)) return box('rect');
  if (n >= 9 && n <= 11 && L < 4 * diag) return box('star');
  let edge = 0; P.forEach(q => { edge += Math.min(Math.abs(q[0] - minx), Math.abs(q[0] - maxx), Math.abs(q[1] - miny), Math.abs(q[1] - maxy)); });
  if (edge / P.length < 0.05 * diag) return box('rect');
  return null;
}

/* ═══════════ free layer engine ═══════════
   The layer sits over the board text: <div class="aw-fl"><svg>…strokes / shapes / symbols…</svg><div class="aw-fb">text box</div>…</div>
   It is plain HTML + SVG inside the board's content, so it is saved with the board and students see exactly the same. */
const NS = 'http://www.w3.org/2000/svg';
const SYM_GROUPS = [
  ['phr', 'Phrases & clauses', ['S', "S'", 'NP', 'VP', 'Vgrp', 'PP', 'AP', 'AdvP', 'NOM'], 'syn'],
  ['fun', 'Functions', ['[sC]', '[dO]', '[iO]', '[oC]', 'Comp.', 'obA', 'opA', 'M'], 'syn'],
  ['cla', 'Clause types', ['[ACl]', '[NCl as S]'], 'syn'],
  ['det', 'Determiners', ['DET', 'ART', 'POSS', 'QUA', 'DEM', 'PRE-DET', '∅'], 'syn'],
  ['wc', 'Word classes', ['N', 'V', 'A', 'ADV', 'P', 'PRO', 'AUX', 'Pron', 'Conj'], 'both']
];
const SYM_VERB = ['intrans', 'intens', 'monotrans', 'ditrans', 'complex'];
const SYM_AFFIX = ['pref', 'suff', 'root'];
const OPEN_SHAPES = ['line', 'arrow', 'lnx', 'loop', 'caret', 'axes', 'parab', 'cubic', 'sine', 'hyp', 'expo', 'angle', 'brkt', 'brace'];
const COLOURS = ['#111111', '#D45060', '#2D7495', '#2F9E44', '#F08C00', '#7048E8', '#FFFFFF'];
const FILLS = ['none', '#FFF3A3', '#B6F0C2', '#BFE0FF', '#FFC9D6', '#E0C9FF', '#E5E7EB'];
const HL_COLOURS = ['#FFD43B', '#7ED957', '#FF8FB1', '#74C0FC', '#B197FC'];

const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const toast = m => { try { AW.toast(m, 'info', 2600); } catch (e) {} };
const clone = o => JSON.parse(JSON.stringify(o));
let canvas = null, S = { tool: 'type', stroke: '#111111', hl: '#FFD43B', fill: 'none', w: 3, ls: '', shape: { k: 'rect', o: 0 }, sym: null, sel: [], undo: [], redo: [], symTab: 'syn', circ: {}, loopBend: 0.5, angles: false, smooth: 1, finger: false, dims: {}, symDims: {}, ruler: { on: false, cx: 420, cy: 360, ang: 0, len: 560 } };
S.circ = lsGet('aw_sym_circ', {}) || {}; S.ls = lsGet('aw_ls', '') || ''; S.angles = !!lsGet('aw_angles', false); S.smooth = lsGet('aw_smooth', 1); S.finger = !!lsGet('aw_finger', false);
S.dims = lsGet('aw_shape_dims', {}) || {}; S.symDims = lsGet('aw_sym_dims', {}) || {}; S.loopBend = lsGet('aw_loop_bend', 0.5); S.ruler = Object.assign(S.ruler, lsGet('aw_ruler', {}) || {}, { on: false });
const SMOOTH_EPS = [0.3, 0.7, 1.6];
let G = null, ui = null, band = null, lassoEl = null, panels = {}, badgeEls = [], rl = null;
const zoomF = () => (typeof zoom === 'number' && zoom > 0) ? zoom : 1;
const uid = () => 'f' + Math.random().toString(36).slice(2, 9);
const polysToD = polys => polys.map(poly => poly.map((q, i) => (i ? 'L' : 'M') + r1(q[0]) + ' ' + r1(q[1])).join('')).join('');

function layer(create){
  if (!canvas) return null;
  let l = canvas.querySelector(':scope > .aw-fl');
  if (!l && create){
    l = document.createElement('div'); l.className = 'aw-fl'; l.setAttribute('contenteditable', 'false');
    l.innerHTML = '<svg class="aw-fl-svg" xmlns="' + NS + '"></svg>';
    canvas.insertBefore(l, canvas.firstChild);
  }
  return l;
}
const svgEl = () => { const l = layer(true); return l.querySelector('.aw-fl-svg') || l.appendChild(document.createElementNS(NS, 'svg')); };
function sync(){
  const l = layer(false); if (!l) return;
  l.className = 'aw-fl' + (S.tool !== 'type' ? ' t-' + S.tool : '');
  if (S.tool === 'shape') l.classList.add('t-shape');
}
function pt(e){
  const l = layer(true), r = l.getBoundingClientRect(), z = zoomF();
  return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z };
}
function changed(){ fit(); if (typeof scheduleSave === 'function') scheduleSave(); paintSel(); }
/* run fn and put the page back where it was: layout that shrinks for a moment must not scroll the board to the top */
function keepScroll(fn){
  const se = document.scrollingElement || document.documentElement, y = se.scrollTop, x = se.scrollLeft;
  fn();
  if (se.scrollTop !== y) se.scrollTop = y;
  if (se.scrollLeft !== x) se.scrollLeft = x;
}
/* the board gets as tall as the lowest object */
function fit(){ keepScroll(fit0); }
function fit0(){
  const l = layer(false); if (!l) return;
  let pad = canvas.querySelector(':scope > .aw-fl-pad');
  const objs = [].slice.call(l.querySelectorAll('.fo,.aw-fb')).concat([].slice.call(canvas.querySelectorAll('.aw-tfree')));
  if (!objs.length){ if (pad) pad.remove(); return; }
  if (!pad){ pad = document.createElement('div'); pad.className = 'aw-fl-pad'; pad.setAttribute('contenteditable', 'false'); pad.style.height = '0px'; canvas.appendChild(pad); }
  const cr = canvas.getBoundingClientRect(), z = zoomF();
  let low = 0; objs.forEach(o => { low = Math.max(low, (o.getBoundingClientRect().bottom - cr.top) / z); });
  const top = (pad.getBoundingClientRect().top - cr.top) / z;   // the pad is the last thing in the board: its top does not depend on its own height
  pad.style.height = Math.max(0, Math.round(low + 60 - top)) + 'px';
}

/* ── undo / redo of the layer ── */
function snap(){ const l = layer(true); S.undo.push(l.innerHTML); if (S.undo.length > 60) S.undo.shift(); S.redo.length = 0; }
function restore(html){ const l = layer(true); l.innerHTML = html; normalise(); S.sel = []; changed(); }
function undo(){ if (!S.undo.length) return; const l = layer(true); S.redo.push(l.innerHTML); restore(S.undo.pop()); }
function redo(){ if (!S.redo.length) return; const l = layer(true); S.undo.push(l.innerHTML); restore(S.redo.pop()); }
function normalise(){
  const l = layer(false); if (!l) return;
  [].forEach.call(l.querySelectorAll('.aw-fb'), b => { b.setAttribute('contenteditable', 'false'); });
}

/* ── objects ── */
function T(o){ return { x: +o.dataset.tx || 0, y: +o.dataset.ty || 0, sx: o.dataset.sx ? +o.dataset.sx : 1, sy: o.dataset.sy ? +o.dataset.sy : 1 }; }
function setT(o, t){
  o.dataset.tx = r1(t.x); o.dataset.ty = r1(t.y); o.dataset.sx = Math.round(t.sx * 1000) / 1000; o.dataset.sy = Math.round(t.sy * 1000) / 1000;
  o.setAttribute('transform', 'translate(' + o.dataset.tx + ' ' + o.dataset.ty + ') scale(' + o.dataset.sx + ' ' + o.dataset.sy + ')');
}
function mkPath(d, o){
  const p = document.createElementNS(NS, 'path'); p.setAttribute('class', 'fo');
  p.setAttribute('d', d); if (o.k !== 'pen' && o.k !== 'hl') p.setAttribute('fill', o.fill || 'none');   // pen / highlighter: fill is none in the style sheet
  p.setAttribute('stroke', o.stroke); p.setAttribute('stroke-width', o.w); p.dataset.k = o.k;
  return p;
}
/* Strokes are saved as one short text: first point, then the steps between points, all in quarter-pixels, base 36.
   The long SVG path is rebuilt from it when the board opens, so the saved board stays small. */
function encPts(pts){
  const q = pts.map(a => [Math.round(a[0] * 4), Math.round(a[1] * 4)]), out = [q[0][0].toString(36), q[0][1].toString(36)];
  for (let i = 1; i < q.length; i++){ out.push((q[i][0] - q[i - 1][0]).toString(36), (q[i][1] - q[i - 1][1]).toString(36)); }
  return out.join(' ');
}
function decPts(str){
  const v = String(str || '').split(' ').map(t => parseInt(t, 36) / 4), pts = [];
  for (let i = 0; i + 1 < v.length; i += 2){ const l = pts[pts.length - 1]; pts.push(l ? [l[0] + v[i], l[1] + v[i + 1]] : [v[i], v[i + 1]]); }
  return pts;
}
/* Douglas–Peucker: drop points that lie on the line between their neighbours */
function simplify(pts, eps){
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1; const stack = [[0, pts.length - 1]];
  while (stack.length){
    const [a, b] = stack.pop(); let dm = 0, im = -1;
    for (let i = a + 1; i < b; i++){ const d = distSeg(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]); if (d > dm){ dm = d; im = i; } }
    if (dm > eps && im > 0){ keep[im] = 1; stack.push([a, im], [im, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function serialize(cv){
  const l = cv.querySelector(':scope > .aw-fl'); if (!l) return cv.innerHTML;
  const c = cv.cloneNode(true), cl = c.querySelector(':scope > .aw-fl');
  cl.className = 'aw-fl';
  [].forEach.call(cl.querySelectorAll('path[data-p]'), p => p.removeAttribute('d'));       // strokes: rebuilt from data-p
  [].forEach.call(cl.querySelectorAll('g[data-st] path'), p => p.removeAttribute('d'));     // shapes: rebuilt from data-st
  [].forEach.call(cl.querySelectorAll('.aw-fb'), b => b.setAttribute('contenteditable', 'false'));
  return c.innerHTML;
}
function hydrate(cv){
  const l = cv.querySelector(':scope > .aw-fl'); if (!l) return;
  l.className = 'aw-fl';
  [].forEach.call(l.querySelectorAll('path[data-p]'), p => { if (!p.getAttribute('d')) p.setAttribute('d', smoothD(decPts(p.dataset.p))); });
  [].forEach.call(l.querySelectorAll('g[data-st]'), g => renderShape(g));
  [].forEach.call(l.querySelectorAll('.aw-fb'), b => b.setAttribute('contenteditable', 'false'));
}
function smoothD(pts){
  if (pts.length === 1) return 'M' + r1(pts[0][0]) + ' ' + r1(pts[0][1]) + 'L' + r1(pts[0][0] + .01) + ' ' + r1(pts[0][1]);
  if (pts.length === 2) return 'M' + r1(pts[0][0]) + ' ' + r1(pts[0][1]) + 'L' + r1(pts[1][0]) + ' ' + r1(pts[1][1]);
  let d = 'M' + r1(pts[0][0]) + ' ' + r1(pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++){ const m = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]; d += 'Q' + r1(pts[i][0]) + ' ' + r1(pts[i][1]) + ' ' + r1(m[0]) + ' ' + r1(m[1]); }
  const e = pts[pts.length - 1]; return d + 'L' + r1(e[0]) + ' ' + r1(e[1]);
}
const symKey2 = sy => sy.ring ? (sy.txt2 ? 'ring2' : 'ring') : sy.txt2 ? 'two' : 'label';
const shapeKey = st => st.k + ((st.k === 'brkt' || st.k === 'brace') ? (st.o || 0) : '');
const isLine = st => st.k === 'line' || st.k === 'arrow', isCaret = st => st.k === 'caret', isLoop = st => st.k === 'loop';
const isPoly = st => isLine(st) || isCaret(st) || isLoop(st);
const polyPts = st => (isCaret(st) || isLoop(st)) ? [[st.x, st.y], [st.x2, st.y2], [st.x3, st.y3]] : [[st.x, st.y], [st.x2, st.y2]];
const isSt = o => !!(o.dataset && o.dataset.st);
function getSt(g){ try { return JSON.parse(g.dataset.st); } catch (e) { return null; } }
function setSt(g, st){
  g.dataset.st = JSON.stringify(st, (k, v) => typeof v === 'number' ? Math.round(v * 10) / 10 : v);
  renderShape(g, st);
}
/* a shape is saved as its few numbers (data-st); the path is rebuilt from them, with the Notes geometry */
function renderShape(g, st){
  st = st || getSt(g); if (!st) return;
  const polys = shapePaths(st), main = [], solid = [];
  polys.forEach((pl, i) => ((st.ls && isSolidPart(st, i)) ? solid : main).push(pl));   // arrow heads stay solid on dashed lines
  let m = g.querySelector(':scope > path.m'), s = g.querySelector(':scope > path.s');
  if (!m){ m = document.createElementNS(NS, 'path'); m.setAttribute('class', 'm'); g.appendChild(m); }
  if (!s){ s = document.createElementNS(NS, 'path'); s.setAttribute('class', 's'); s.setAttribute('fill', 'none'); g.appendChild(s); }
  m.setAttribute('d', polysToD(main)); s.setAttribute('d', polysToD(solid));
  const w = parseFloat(g.getAttribute('stroke-width')) || st.sw || 2;
  if (st.ls) m.setAttribute('stroke-dasharray', dashFor(st.ls, w, 1).map(r1).join(' ')); else m.removeAttribute('stroke-dasharray');
}
function makeShape(x0, y0, x1, y1, shift){
  const sh = S.shape, s = { t: 'shape', k: sh.k, o: sh.o, sw: S.w }; if (S.ls && sh.k !== 'sym') s.ls = S.ls;
  if (s.k === 'loop'){ s.x = x0; s.y = y0; s.x2 = x1; s.y2 = y1; const dx = x1 - x0, dy = y1 - y0; s.x3 = (x0 + x1) / 2 - dy * S.loopBend; s.y3 = (y0 + y1) / 2 + dx * S.loopBend; return s; }
  if (s.k === 'lnx'){ const E = LINE_ENDS[s.o] || ['', '']; s.k = 'line'; s.o = 0; if (E[0]) s.e0 = E[0]; if (E[1]) s.e1 = E[1]; }
  if (s.k === 'line' || s.k === 'arrow'){
    let dx = x1 - x0, dy = y1 - y0; const len = Math.hypot(dx, dy);
    if (len > 0){
      const ang = Math.atan2(dy, dx), step = Math.PI / 12, sn = Math.round(ang / step) * step;
      if (shift || Math.abs(ang - sn) < 0.06){ dx = len * Math.cos(sn); dy = len * Math.sin(sn); }   // dead level / 15-degree steps
      const d = S.dims.line; if (d && Math.abs(len - d[0]) < 4){ const f = d[0] / len; dx *= f; dy *= f; }   // same length as last time
    }
    s.x = x0; s.y = y0; s.x2 = x0 + dx; s.y2 = y0 + dy; return s;
  }
  let w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  const dm = S.dims[shapeKey(s)]; if (dm){ if (Math.abs(w - dm[0]) < 4) w = dm[0]; if (Math.abs(h - dm[1]) < 4) h = dm[1]; }   // sticks to the size you used last
  if (shift || ((s.k === 'ellipse' || s.k === 'rect' || s.k === 'star' || s.k === 'cube' || s.k === 'sphere') && Math.abs(w - h) < 5)){ const m = Math.max(w, h); w = h = m; }
  s.bw = w; s.bh = h; s.x = x1 >= x0 ? x0 : x0 - w; s.y = y1 >= y0 ? y0 : y0 - h;
  if (s.k === 'caret'){ s.x2 = s.x + w / 2; s.y2 = s.y; s.x3 = s.x + w; s.y3 = s.y + h; s.y = s.y + h; }
  return s;
}
function rememberDims(st){
  if (isLine(st)){ S.dims.line = [Math.round(Math.hypot(st.x2 - st.x, st.y2 - st.y))]; }
  else if (st.bw !== undefined && !isPoly(st)) S.dims[shapeKey(st)] = [Math.round(st.bw), Math.round(st.bh)];
  lsSet('aw_shape_dims', S.dims);
}
function shapeEl(st, existing){
  let g = existing;
  if (!g){
    const open = OPEN_SHAPES.indexOf(st.k) >= 0;
    g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'fo'); g.dataset.k = 'shape';
    g.setAttribute('stroke', S.stroke); g.setAttribute('stroke-width', S.w); g.setAttribute('fill', open ? 'none' : S.fill);
  }
  setSt(g, st); return g;
}
/* geometry of a shape object under a map x' = ax*x + bx, y' = ay*y + by */
function mapSt(st, ax, bx, ay, by){
  ['x', 'x2', 'x3'].forEach(k => { if (st[k] !== undefined) st[k] = ax * st[k] + bx; });
  ['y', 'y2', 'y3'].forEach(k => { if (st[k] !== undefined) st[k] = ay * st[k] + by; });
  if (st.bw !== undefined){ st.bw = Math.max(1, st.bw * Math.abs(ax)); st.bh = Math.max(1, st.bh * Math.abs(ay)); }
}
/* word-class / syntax symbols: text, optionally in a circle; two-tier = V over [type] */
function symSize(txt, ring, t2){
  const len = Math.max(txt.length, t2 ? t2.length : 0);
  if (ring && t2) return [Math.max(60, len * 8.5 + 30), 56];
  if (ring){ const z = 30 + Math.max(0, len - 2) * 5; return [z, z]; }
  if (t2) return [Math.max(46, len * 8.5 + 16), 42];
  return [Math.max(24, txt.length * 13 + 10), 24];
}
function symEl(sy, cx, cy, w, h){
  const g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'fo'); g.dataset.k = 'sym';
  const x = cx - w / 2, y = cy - h / 2;
  const add = (tag, at, txt) => { const e = document.createElementNS(NS, tag); for (const k in at) e.setAttribute(k, at[k]); if (txt != null) e.textContent = txt; g.appendChild(e); return e; };
  if (sy.ring) add('ellipse', { cx: r1(cx), cy: r1(cy), rx: r1(w / 2), ry: r1(h / 2), fill: 'none', stroke: S.stroke, 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke' });
  const face = { fill: S.stroke, 'font-family': 'Inter,system-ui,sans-serif', 'font-weight': sy.it ? 600 : 700, 'font-style': sy.it ? 'italic' : 'normal', 'text-anchor': 'middle', 'dominant-baseline': 'central' };
  const fit1 = (t, f, mw) => { const tw = t.length * f * .62; return tw > mw ? f * mw / tw : f; };
  if (sy.txt2){
    add('text', Object.assign({ x: r1(cx), y: r1(y + h * .27), 'font-size': r1(fit1(sy.txt, h * .46, w * (sy.ring ? .7 : .96))) }, face), sy.txt);
    add('text', Object.assign({ x: r1(cx), y: r1(y + h * .74), 'font-size': r1(fit1(sy.txt2, h * .3, w * (sy.ring ? .8 : .98))) }, face), sy.txt2);
  } else add('text', Object.assign({ x: r1(cx), y: r1(cy), 'font-size': r1(fit1(sy.txt, h * (sy.ring ? .54 : .74), w * (sy.ring ? .74 : .98))) }, face), sy.txt);
  return g;
}
function textBox(x, y, w){
  const l = layer(true), b = document.createElement('div');
  b.className = 'aw-fb'; b.dataset.id = uid();
  b.style.cssText = 'left:' + r1(x) + 'px;top:' + r1(y) + 'px;width:' + r1(Math.max(120, w)) + 'px;font-size:18px;color:' + (S.stroke === '#FFFFFF' ? '#111111' : S.stroke) + ';';
  l.appendChild(b); edit(b); return b;
}
function edit(b){
  b.setAttribute('contenteditable', 'true'); b.focus();
  const r = document.createRange(); r.selectNodeContents(b); r.collapse(false); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
}
function endEdit(b){
  b.setAttribute('contenteditable', 'false');
  if (!b.textContent.trim() && !b.querySelector('img')){ b.remove(); S.sel = S.sel.filter(x => x !== b); }
  changed();
}

/* ── selection ── */
const isTbl = o => o.tagName === 'TABLE';
const isImg = o => o.tagName === 'IMG';
const isFreeable = o => isTbl(o) || isImg(o);
const isBox = o => o.classList && (o.classList.contains('aw-fb') || o.tagName === 'TABLE' || o.tagName === 'IMG');   // text boxes and free tables: left / top / scale
/* a table lifts out of the text and floats: it can then be dragged anywhere, like a text box */
function freeTable(t){
  if (t.classList.contains('aw-tfree')) return;
  keepScroll(() => {
    const l = t.offsetLeft, tp = t.offsetTop;
    if (canvas) canvas.style.minHeight = Math.max(canvas.offsetHeight, parseFloat(canvas.style.minHeight) || 0) + 'px';   // taking it out of the text must not shorten the board
    t.classList.add('aw-tfree'); t.style.position = 'absolute'; t.style.left = l + 'px'; t.style.top = tp + 'px'; t.style.zIndex = '1'; t.style.margin = '0';
  });
}
const imgRot = o => parseFloat(o.dataset.rot) || 0;
function setImgRot(o, a){ a = ((a % 360) + 540) % 360 - 180; a = Math.round(a * 10) / 10; if (a){ o.dataset.rot = a; o.style.transformOrigin = '50% 50%'; o.style.transform = 'rotate(' + a + 'deg)'; } else { delete o.dataset.rot; o.style.transform = ''; } }
function unfreeTable(t){
  keepScroll(() => {
    t.classList.remove('aw-tfree'); t.style.position = ''; t.style.left = ''; t.style.top = ''; t.style.zIndex = ''; t.style.margin = '';
    if (!t.getAttribute('class')) t.removeAttribute('class');
  });
}
const boxScale = b => parseFloat(b.dataset.s) || 1;
function setBoxScale(b, k){ k = Math.max(.2, Math.min(8, k)); b.style.transformOrigin = '0 0'; if (Math.abs(k - 1) < 0.002){ delete b.dataset.s; b.style.transform = ''; } else { b.dataset.s = Math.round(k * 1000) / 1000; b.style.transform = 'scale(' + b.dataset.s + ')'; } }
function boxOf(list){
  const l = layer(false) || canvas; if (!l || !list.length) return null;   // a table can be selected before any drawing exists
  const lr = l.getBoundingClientRect(), z = zoomF(); let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  list.forEach(o => { const r = o.getBoundingClientRect(); x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); });
  return { vx: x0, vy: y0, vw: x1 - x0, vh: y1 - y0, x: (x0 - lr.left) / z, y: (y0 - lr.top) / z, w: (x1 - x0) / z, h: (y1 - y0) / z };
}
/* the original numbers of an object, taken when a move / resize starts */
function snapObj(o){
  if (isFreeable(o)) freeTable(o);
  if (isBox(o)) return { l: parseFloat(o.style.left) || 0, t: parseFloat(o.style.top) || 0, w: o.offsetWidth, s: boxScale(o) };
  if (isSt(o)) return { st: getSt(o) };
  return T(o);
}
function moveObj(o, g, dx, dy){
  if (isBox(o)){ o.style.left = r1(g.l + dx) + 'px'; o.style.top = r1(g.t + dy) + 'px'; }
  else if (isSt(o)){ const st = clone(g.st); mapSt(st, 1, dx, 1, dy); setSt(o, st); }
  else setT(o, { x: g.x + dx, y: g.y + dy, sx: g.sx, sy: g.sy });
}
const V = (x, y) => { const lr = (layer(false) || canvas).getBoundingClientRect(), z = zoomF(); return [lr.left + x * z, lr.top + y * z]; };
/* ── measuring badges: length / size while you draw, the angle at every corner when ∠ Angles is on ── */
function badge(vx, vy, text, kind){
  const d = document.createElement('div'); d.className = 'aw-flbadge' + (kind ? ' ' + kind : ''); d.textContent = text;
  d.style.left = vx + 'px'; d.style.top = vy + 'px'; document.body.appendChild(d); badgeEls.push(d);
}
function clearBadges(){ badgeEls.forEach(b => b.remove()); badgeEls = []; }
const degOf = (dx, dy) => { let d = Math.round(Math.atan2(-dy, dx) * 180 / Math.PI); if (d < 0) d += 360; return d % 360; };
function showBadges(st, transient){
  clearBadges(); if (!st || !layer(false)) return;
  if (transient){
    if (isLine(st)){ const m = V((st.x + st.x2) / 2, Math.min(st.y, st.y2)); badge(m[0], m[1] - 26, Math.round(Math.hypot(st.x2 - st.x, st.y2 - st.y)) + ' px · ' + degOf(st.x2 - st.x, st.y2 - st.y) + '°', 'sz'); }
    else if (st.bw !== undefined && !isPoly(st)){ const m = V(st.x + st.bw / 2, st.y); badge(m[0], m[1] - 26, Math.round(st.bw) + ' × ' + Math.round(st.bh) + ' px', 'sz'); }
  }
  if (S.angles) angleBadges(st);
}
const ANGLE_SHAPES = ['tri', 'rtri', 'rect', 'trap', 'rtrap', 'para', 'rhomb', 'pent', 'hex'];
function angleBadges(st){
  const polys = shapePaths(st), angAt = (a, b, c) => { const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]], l = Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]); return l ? Math.round(Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / l))) * 180 / Math.PI) : 0; };
  if (ANGLE_SHAPES.indexOf(st.k) >= 0 && polys[0]){
    const P = polys[0].slice(); if (P.length > 2 && Math.hypot(P[0][0] - P[P.length - 1][0], P[0][1] - P[P.length - 1][1]) < .5) P.pop();
    const n = P.length, cx = P.reduce((s, q) => s + q[0], 0) / n, cy = P.reduce((s, q) => s + q[1], 0) / n;
    P.forEach((b, i) => { const a = P[(i + n - 1) % n], c = P[(i + 1) % n], dx = cx - b[0], dy = cy - b[1], dl = Math.hypot(dx, dy) || 1, p = V(b[0] + dx / dl * 22, b[1] + dy / dl * 22); badge(p[0], p[1], angAt(a, b, c) + '°'); });
  } else if (isCaret(st)){
    const p = V(st.x2, st.y2 + 22); badge(p[0], p[1], angAt([st.x, st.y], [st.x2, st.y2], [st.x3, st.y3]) + '°');
  } else if (isLine(st)){
    const m = V((st.x + st.x2) / 2, (st.y + st.y2) / 2); badge(m[0], m[1] - 16, degOf(st.x2 - st.x, st.y2 - st.y) + '°');
  } else if (st.k === 'angle' && st.bw){
    const a = Math.round(Math.atan(st.bh / (st.bw * .7)) * 180 / Math.PI), p = V(st.x + 34, st.y + st.bh - 14); badge(p[0], p[1], a + '°');
  }
}
function paintSel(){
  if (!ui) return;
  S.sel = S.sel.filter(o => o.isConnected);
  const showBox = S.sel.length > 0 && (S.tool === 'select' || S.tool === 'shape' || (S.tool === 'type' && S.sel.length === 1 && isBox(S.sel[0])));
  const pic = S.sel.length === 1 && isImg(S.sel[0]) ? S.sel[0] : null;
  const b = showBox ? boxOf(S.sel) : null;
  const one = S.sel.length === 1 && isSt(S.sel[0]) ? getSt(S.sel[0]) : null;
  if (!G){ if (S.angles && one && showBox) showBadges(one, false); else clearBadges(); }
  if (!b){ ui.style.display = 'none'; syncStyleUI(); return; }
  const poly = !!(one && isPoly(one)), rot = !!((one && rotatable(one)) || pic);
  ui.style.display = 'block';
  if (pic){   // a picture: its own box, turned with it
    const r = pic.getBoundingClientRect(), z = zoomF(), fw = pic.offsetWidth * z + 12, fh = pic.offsetHeight * z + 12, cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    ui.style.left = cx - fw / 2 + 'px'; ui.style.top = cy - fh / 2 + 'px'; ui.style.width = fw + 'px'; ui.style.height = fh + 'px';
    ui.style.transform = 'rotate(' + imgRot(pic) + 'deg)'; ui.style.setProperty('--rot', imgRot(pic) + 'deg');
  } else if (rot){   // a shape: the frame is its own box, turned with it (as in Notes)
    const c = V(one.x + one.bw / 2, one.y + one.bh / 2), z = zoomF(), fw = one.bw * z + 12, fh = one.bh * z + 12;
    ui.style.left = c[0] - fw / 2 + 'px'; ui.style.top = c[1] - fh / 2 + 'px'; ui.style.width = fw + 'px'; ui.style.height = fh + 'px';
    ui.style.transform = 'rotate(' + (one.rot || 0) + 'deg)'; ui.style.setProperty('--rot', (one.rot || 0) + 'deg');
  } else {
    ui.style.left = b.vx - 4 + 'px'; ui.style.top = b.vy - 4 + 'px'; ui.style.width = b.vw + 8 + 'px'; ui.style.height = b.vh + 8 + 'px';
    ui.style.transform = ''; ui.style.setProperty('--rot', '0deg');
  }
  ui.classList.toggle('poly', poly); ui.classList.toggle('rotok', rot); ui.classList.toggle('pic', !!pic);
  const allTbl = S.sel.length > 0 && S.sel.every(isTbl);
  ui.classList.toggle('tbl', allTbl); ui.classList.toggle('free', S.sel.length > 0 && S.sel.every(isFreeable) && S.sel.every(t => t.classList.contains('aw-tfree')));
  if (poly){   // a line / caret / curved arrow: its end points are the handles
    const pts = polyPts(one);
    [].forEach.call(ui.querySelectorAll('.vp'), (el, i) => { const q = pts[i]; if (!q){ el.style.display = 'none'; return; } const v = V(q[0], q[1]); el.style.display = 'block'; el.style.left = (v[0] - (b.vx - 4) - 6) + 'px'; el.style.top = (v[1] - (b.vy - 4) - 6) + 'px'; });
  }
  syncStyleUI();
}
const ICO = {
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
  dup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  rot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/></svg>',
  move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>',
  col: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3C8 8 5 11 5 15a7 7 0 0 0 14 0c0-4-3-7-7-12z"/></svg>'
};
let colPop = null;
function openColourPop(anchor){
  if (colPop){ colPop.remove(); colPop = null; return; }
  colPop = document.createElement('div'); colPop.className = 'aw-pal aw-colpop';
  colPop.innerHTML = '<div class="aw-pal-grid">' + COLOURS.concat(['#FFD43B', '#7ED957', '#FF8FB1', '#74C0FC', '#B197FC', '#FF922B', '#868E96']).map(c => '<button type="button" data-c="' + c + '" style="background:' + c + '"></button>').join('') + '</div><label class="aw-pal-row">More colors… <input type="color" value="#3366cc"></label>';
  const r = anchor.getBoundingClientRect();
  colPop.style.left = Math.max(8, Math.min(r.left - 60, window.innerWidth - 200)) + 'px'; colPop.style.top = Math.min(r.bottom + 6, window.innerHeight - 190) + 'px';
  document.body.appendChild(colPop);
  const pick = c => { if (colPop){ colPop.remove(); colPop = null; } if (S.sel.length){ snap(); applyColour(c); } };
  colPop.addEventListener('mousedown', e => { if (e.target.tagName !== 'INPUT') e.preventDefault(); });
  colPop.addEventListener('click', e => { const c = e.target.dataset && e.target.dataset.c; if (c) pick(c); });
  colPop.querySelector('input').onchange = function(){ pick(this.value); };
}
/* colour of the selected shapes, symbols, text boxes (their lines or letters) */
function applyColour(c){
  S.sel.forEach(o => {
    if (isBox(o)) o.style.color = c;
    else if (o.dataset.k === 'sym') [].forEach.call(o.children, ch => { if (ch.tagName === 'text') ch.setAttribute('fill', c); else ch.setAttribute('stroke', c); });
    else o.setAttribute('stroke', c);
  });
  S.stroke = c; changed();
}
document.addEventListener('mousedown', e => { if (colPop && !colPop.contains(e.target) && !(e.target.closest && e.target.closest('.aw-flsel'))){ colPop.remove(); colPop = null; } }, true);
function buildUI(){
  if (ui) return;
  ui = document.createElement('div'); ui.className = 'aw-flsel'; ui.style.display = 'none';
  ui.innerHTML = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(h => '<i class="h" data-h="' + h + '"></i>').join('') + '<i class="vp" data-v="0"></i><i class="vp" data-v="1"></i><i class="vp mid" data-v="2"></i><i class="mv" title="Move (drag)">' + ICO.move + '</i>' +
    '<i class="rt" title="Turn (drag; snaps every 15°)">' + ICO.rot + '</i>' +
    '<i class="ic dl" title="Delete">' + ICO.del + '</i><i class="ic dp" title="Duplicate">' + ICO.dup + '</i><i class="ic co" title="Colour">' + ICO.col + '</i><i class="fl" title="Put the table back in the text">⇩ In text</i>';
  document.body.appendChild(ui);
  ui.addEventListener('pointerdown', e => {
    const cl = e.target.classList; if (!cl) return;
    if (cl.contains('dl') || (e.target.closest && e.target.closest('.ic.dl'))){ e.preventDefault(); e.stopPropagation(); del(); return; }
    if (e.target.closest && e.target.closest('.ic.dp')){ e.preventDefault(); e.stopPropagation(); dup(); return; }
    if (e.target.closest && e.target.closest('.ic.co')){ e.preventDefault(); e.stopPropagation(); openColourPop(e.target.closest('.ic.co')); return; }
    if (cl.contains('fl')){ e.preventDefault(); e.stopPropagation(); S.sel.filter(isFreeable).forEach(unfreeTable); changed(); return; }
    if (e.target.closest && e.target.closest('.rt')){   // the turn handle: the shape turns with the handle, from where it is now
      e.preventDefault(); e.stopPropagation(); ui.setPointerCapture(e.pointerId); snap();
      const o0 = S.sel[0];
      let c, r0;
      if (isImg(o0)){ const r = o0.getBoundingClientRect(); c = [r.left + r.width / 2, r.top + r.height / 2]; r0 = imgRot(o0); }
      else { const st = getSt(o0); c = V(st.x + st.bw / 2, st.y + st.bh / 2); r0 = st.rot || 0; }
      G = { kind: 'rot', o: o0, cx: c[0], cy: c[1], a0: Math.atan2(e.clientY - c[1], e.clientX - c[0]) * 180 / Math.PI, r0, fromUi: true }; return;
    }
    if (e.target.closest && e.target.closest('.mv')){   // the grip: drag the selection (works while a text box is being edited too)
      e.preventDefault(); e.stopPropagation(); ui.setPointerCapture(e.pointerId); snap();
      G = { kind: 'move', x0: e.clientX, y0: e.clientY, did: true, fromUi: true, origs: S.sel.map(snapObj) };
      return;
    }
    if (cl.contains('vp')){   // an end point / corner of a line, caret or curved arrow
      e.preventDefault(); e.stopPropagation(); ui.setPointerCapture(e.pointerId); snap();
      G = { kind: 'vtx', i: +e.target.dataset.v, o: S.sel[0], fromUi: true }; return;
    }
    const h = e.target.dataset && e.target.dataset.h; if (!h) return;
    e.preventDefault(); e.stopPropagation(); ui.setPointerCapture(e.pointerId);
    const one = S.sel.length === 1 && isSt(S.sel[0]) ? getSt(S.sel[0]) : null;
    const img0 = S.sel.length === 1 && isImg(S.sel[0]) ? S.sel[0] : null;
    if (img0 && isFreeable(img0)) freeTable(img0);
    snap(); G = { kind: 'resize', h, ob: boxOf(S.sel), x0: e.clientX, y0: e.clientY, origs: S.sel.map(snapObj), turned: one && rotatable(one) ? one : null,
      img: img0 ? { o: img0, w: img0.offsetWidth, h: img0.offsetHeight, l: parseFloat(img0.style.left) || 0, t: parseFloat(img0.style.top) || 0, rot: imgRot(img0) } : null };
  });
  ui.addEventListener('pointermove', e => { if (!G) return; if (G.kind === 'resize') resizeMove(e); else if (G.fromUi) onMove(e); });
  ui.addEventListener('pointerup', e => { if (!G) return; if (G.kind === 'resize'){ G = null; clearBadges(); changed(); } else if (G.fromUi) onUp(e); });
  band = document.createElement('div'); band.className = 'aw-flband'; band.style.display = 'none'; document.body.appendChild(band);
  lassoEl = document.createElementNS(NS, 'svg'); lassoEl.setAttribute('class', 'aw-fllasso'); lassoEl.innerHTML = '<path d="" fill="rgba(86,97,224,.12)" stroke="#5661E0" stroke-width="1.5" stroke-dasharray="5 4"/>'; lassoEl.style.display = 'none'; document.body.appendChild(lassoEl);
  window.addEventListener('scroll', paintSel, true); window.addEventListener('resize', paintSel);
}
function resizeMove(e){
  const z = zoomF(), dx = (e.clientX - G.x0) / z, dy = (e.clientY - G.y0) / z, o = G.ob, h = G.h;
  if (G.img){   // a picture: corners keep its proportions, sides stretch it; the opposite edge stays put (turned or not)
    const q = G.img, th = q.rot * Math.PI / 180, c = Math.cos(th), sn = Math.sin(th), dxl = dx * c + dy * sn, dyl = -dx * sn + dy * c;
    let ew = h.indexOf('e') >= 0 ? dxl : h.indexOf('w') >= 0 ? -dxl : 0, ns = h.indexOf('s') >= 0 ? dyl : h.indexOf('n') >= 0 ? -dyl : 0;
    let nw = Math.max(24, q.w + ew), nh = Math.max(24, q.h + ns);
    if (h.length === 2){ const k = Math.max(nw / q.w, nh / q.h); nw = q.w * k; nh = q.h * k; }
    ew = nw - q.w; ns = nh - q.h;
    const csx = h.indexOf('e') >= 0 ? ew / 2 : h.indexOf('w') >= 0 ? -ew / 2 : 0, csy = h.indexOf('s') >= 0 ? ns / 2 : h.indexOf('n') >= 0 ? -ns / 2 : 0;
    const cx = q.l + q.w / 2 + csx * c - csy * sn, cy = q.t + q.h / 2 + csx * sn + csy * c;
    q.o.style.maxWidth = 'none'; q.o.style.width = r1(nw) + 'px'; q.o.style.height = r1(nh) + 'px'; q.o.style.left = r1(cx - nw / 2) + 'px'; q.o.style.top = r1(cy - nh / 2) + 'px';
    paintSel(); return;
  }
  if (G.turned){   // a single shape, possibly turned: resize in its own (turned) frame, the opposite edge stays where it is
    const st0 = G.turned, th = (st0.rot || 0) * Math.PI / 180, c = Math.cos(th), sn = Math.sin(th);
    const dxl = dx * c + dy * sn, dyl = -dx * sn + dy * c;
    let ew = h.indexOf('e') >= 0 ? dxl : h.indexOf('w') >= 0 ? -dxl : 0, ns = h.indexOf('s') >= 0 ? dyl : h.indexOf('n') >= 0 ? -dyl : 0;
    let nw = Math.max(8, st0.bw + ew), nh = Math.max(8, st0.bh + ns);
    if (e.shiftKey && h.length === 2){ const k = Math.max(nw / st0.bw, nh / st0.bh); nw = st0.bw * k; nh = st0.bh * k; }
    ew = nw - st0.bw; ns = nh - st0.bh;
    const csx = h.indexOf('e') >= 0 ? ew / 2 : h.indexOf('w') >= 0 ? -ew / 2 : 0, csy = h.indexOf('s') >= 0 ? ns / 2 : h.indexOf('n') >= 0 ? -ns / 2 : 0;
    const cx = st0.x + st0.bw / 2 + csx * c - csy * sn, cy = st0.y + st0.bh / 2 + csx * sn + csy * c;
    const st = clone(st0); st.bw = nw; st.bh = nh; st.x = cx - nw / 2; st.y = cy - nh / 2;
    setSt(S.sel[0], st); paintSel(); showBadges(st, true); return;
  }
  let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
  if (h.indexOf('w') >= 0) x0 = Math.min(x1 - 8, o.x + dx); if (h.indexOf('e') >= 0) x1 = Math.max(x0 + 8, o.x + o.w + dx);
  if (h.indexOf('n') >= 0) y0 = Math.min(y1 - 8, o.y + dy); if (h.indexOf('s') >= 0) y1 = Math.max(y0 + 8, o.y + o.h + dy);
  let ax = (x1 - x0) / (o.w || 1), ay = (y1 - y0) / (o.h || 1);
  if (e.shiftKey && h.length === 2){ const k = Math.max(ax, ay); ax = ay = k; x1 = x0 + o.w * k; if (h.indexOf('n') >= 0) y0 = y1 - o.h * k; else y1 = y0 + o.h * k; if (h.indexOf('w') >= 0) x0 = x1 - o.w * k; }
  let lastSt = null;
  S.sel.forEach((s, i) => {
    const g = G.origs[i];
    if (isBox(s)){
      const corner = h.length === 2;
      s.style.left = r1(x0 + (g.l - o.x) * ax) + 'px'; s.style.top = r1(y0 + (g.t - o.y) * (corner ? ax : ay)) + 'px';
      if (corner) setBoxScale(s, g.s * ax);                 // corner: the whole box grows or shrinks, text included
      else s.style.width = r1(Math.max(40, g.w * ax)) + 'px'; // side: wider or narrower, the text re-wraps
    } else if (isSt(s)){ const st = clone(g.st); mapSt(st, ax, x0 - ax * o.x, ay, y0 - ay * o.y); setSt(s, st); lastSt = st; }
    else setT(s, { x: ax * g.x + x0 - ax * o.x, y: ay * g.y + y0 - ay * o.y, sx: g.sx * ax, sy: g.sy * ay });
  });
  paintSel();
  if (lastSt && S.sel.length === 1) showBadges(lastSt, true);
}
function objAt(cx, cy){
  const l = layer(false); if (!l) return null;
  const ring = [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5], [4, 4], [-4, -4]];
  for (const p of ring){
    for (const el of document.elementsFromPoint(cx + p[0], cy + p[1])){
      const o = el.closest && el.closest('.fo,.aw-fb');
      if (o && l.contains(o)) return o;
    }
  }
  return null;
}

/* ── ruler: lay it on the board, draw along its edge for a straight line (drag the middle to move, an end to turn) ── */
const R_deg = a => { let d = ((a * 180 / Math.PI + 90) % 180 + 180) % 180 - 90; return Math.round(d * 10) / 10; };
function renderRuler(){
  if (!rl) return; const r = S.ruler;
  rl.style.display = r.on ? 'block' : 'none'; rl.style.width = r.len + 'px';
  rl.style.transform = 'translate(' + (r.cx - r.len / 2) + 'px,' + (r.cy - 23) + 'px) rotate(' + r.ang + 'rad)';
  rl.querySelector('.rl-deg').textContent = R_deg(r.ang) + '°';
}
function buildRuler(){
  if (rl) return;
  rl = document.createElement('div'); rl.className = 'aw-ruler';
  rl.innerHTML = '<i class="rl-end l" data-end="-1" title="Drag to turn the ruler"></i><i class="rl-mid" title="Drag to move the ruler"></i><i class="rl-end r" data-end="1" title="Drag to turn the ruler"></i><b class="rl-deg"></b>';
  document.body.appendChild(rl);
  rl.addEventListener('pointerdown', e => {
    const t = e.target; if (!t.classList) return;
    if (t.classList.contains('rl-mid')){ e.preventDefault(); t.setPointerCapture(e.pointerId); G = { kind: 'rlmove', x0: e.clientX, y0: e.clientY, cx: S.ruler.cx, cy: S.ruler.cy, fromRl: true }; }
    else if (t.classList.contains('rl-end')){ e.preventDefault(); t.setPointerCapture(e.pointerId); G = { kind: 'rlturn', end: +t.dataset.end, fromRl: true }; }
  });
  rl.addEventListener('pointermove', e => {
    if (!G || !G.fromRl) return; const r = S.ruler;
    if (G.kind === 'rlmove'){ r.cx = G.cx + e.clientX - G.x0; r.cy = G.cy + e.clientY - G.y0; }
    else { let a = Math.atan2(e.clientY - r.cy, e.clientX - r.cx); if (G.end < 0) a += Math.PI; const step = Math.PI / 12, sn = Math.round(a / step) * step; if (Math.abs(a - sn) < 0.05) a = sn; r.ang = a; }
    renderRuler();
  });
  rl.addEventListener('pointerup', () => { if (G && G.fromRl){ G = null; lsSet('aw_ruler', S.ruler); } });
  renderRuler();
}
function toggleRuler(){ buildRuler(); S.ruler.on = !S.ruler.on; renderRuler(); syncStyleUI(); }
function rulerLock(cx, cy){
  const r = S.ruler; if (!r.on) return null;
  const d = [Math.cos(r.ang), Math.sin(r.ang)], n = [-Math.sin(r.ang), Math.cos(r.ang)]; let best = null;
  [-1, 1].forEach(sg => {
    const e0 = [r.cx + n[0] * 23 * sg, r.cy + n[1] * 23 * sg], dist = Math.abs((cx - e0[0]) * n[0] + (cy - e0[1]) * n[1]), t = (cx - e0[0]) * d[0] + (cy - e0[1]) * d[1];
    if (dist <= 18 && Math.abs(t) <= r.len / 2 + 30 && (!best || dist < best.dist)) best = { e0, d, dist };
  });
  return best;
}
const rulerProject = (lk, x, y) => { const t = (x - lk.e0[0]) * lk.d[0] + (y - lk.e0[1]) * lk.d[1]; return [lk.e0[0] + lk.d[0] * t, lk.e0[1] + lk.d[1] * t]; };
/* the pointer position in layer units, kept on the ruler edge when the stroke started on it */
function P(e){
  if (G && G.lock){ const q = rulerProject(G.lock, e.clientX, e.clientY); return pt({ clientX: q[0], clientY: q[1] }); }
  return pt(e);
}

/* ── pointer gestures ── */
function onDown(e){
  if (S.tool === 'type') return;
  if (!e.target.closest || !e.target.closest('.aw-fl')) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  if (e.pointerType === 'touch' && !S.finger){ G = { kind: 'scroll', y0: e.clientY, x0: e.clientX }; return; }   // a finger scrolls the page, a pencil or mouse draws
  const l = layer(true); try { l.setPointerCapture(e.pointerId); } catch (er) {}
  const lk = (S.tool === 'pen' || S.tool === 'hl' || S.tool === 'shape') ? rulerLock(e.clientX, e.clientY) : null;
  const p = lk ? pt({ clientX: rulerProject(lk, e.clientX, e.clientY)[0], clientY: rulerProject(lk, e.clientX, e.clientY)[1] }) : pt(e);
  if (S.tool === 'pen' || S.tool === 'hl'){
    snap(); const hl = S.tool === 'hl';
    const path = mkPath(smoothD([[p.x, p.y]]), { k: S.tool, stroke: hl ? S.hl : S.stroke, w: hl ? Math.max(10, S.w * 5) : S.w });
    svgEl().appendChild(path); G = { kind: 'draw', path, pts: [[p.x, p.y]], lock: lk, hl, timer: 0 };
  } else if (S.tool === 'eraser'){
    G = { kind: 'erase', did: false }; eraseAt(e);
  } else if (S.tool === 'shape'){
    S.sel = []; paintSel(); snap();
    if (S.shape.k === 'sym'){
      const sy = S.sym; if (!sy){ S.undo.pop(); return; }
      const key = symKey2(sy), sz = S.symDims[key] || symSize(sy.txt, sy.ring, sy.txt2);
      const el = svgEl().appendChild(symEl(sy, p.x, p.y, sz[0], sz[1]));   // the symbol is there from the first moment, so you see how big it is
      G = { kind: 'sym', x0: p.x, y0: p.y, el, w: sz[0], h: sz[1], dragged: false, key }; return;
    }
    const st = makeShape(p.x, p.y, p.x, p.y); const el = shapeEl(st); svgEl().appendChild(el); G = { kind: 'shape', x0: p.x, y0: p.y, el, st, lock: lk };
  } else if (S.tool === 'text'){
    G = { kind: 'text', x0: p.x, y0: p.y, vx: e.clientX, vy: e.clientY };
  } else if (S.tool === 'select'){
    const hit = objAt(e.clientX, e.clientY);
    if (hit){
      if (e.shiftKey){ S.sel = S.sel.indexOf(hit) >= 0 ? S.sel.filter(x => x !== hit) : S.sel.concat(hit); }
      else if (S.sel.indexOf(hit) < 0) S.sel = [hit];
      G = { kind: 'move', x0: e.clientX, y0: e.clientY, did: false, origs: S.sel.map(snapObj) };
    } else {
      if (!e.shiftKey) S.sel = [];
      G = { kind: 'lasso', pts: [[e.clientX, e.clientY]], base: S.sel.slice() };
    }
    paintSel();
  }
}
/* hold the pen still: a rough line, circle, rectangle, triangle, star or bracket turns into the real shape (a highlighter stroke becomes a straight line) */
function holdSnap(g){
  if (G !== g || g.kind !== 'draw' || g.snapped || g.pts.length < 4) return;
  if (g.hl){
    g.snapped = true; g.hlLine = true; const a = g.pts[0], b = g.pts[g.pts.length - 1];
    g.pts = [a, b]; g.path.setAttribute('d', smoothD(g.pts)); return;
  }
  const sh = recognize(g.pts); if (!sh) return;
  const st = Object.assign({ o: 0, sw: S.w }, sh); if (S.ls && st.k !== 'sym') st.ls = S.ls;
  g.path.remove();   // the snapshot taken at pen-down already covers this
  const el = shapeEl(st); svgEl().appendChild(el);
  G = { kind: 'shape', snapped: true, lineFollow: st.k === 'line', el, st, x0: st.x, y0: st.y, lock: g.lock };
  showBadges(st, true);
}
function onMove(e){
  if (!G || G.kind === 'resize') return;
  const z = zoomF();
  if (G.kind === 'scroll'){ const dy = e.clientY - G.y0, dx = e.clientX - G.x0; G.y0 = e.clientY; G.x0 = e.clientX; const wrap = canvas.closest('.aw-canvas-wrap'); window.scrollBy(-dx, -dy); if (wrap){ wrap.scrollTop -= dy; wrap.scrollLeft -= dx; } return; }
  if (G.kind === 'draw'){
    const p = P(e), last = G.pts[G.pts.length - 1];
    if (G.hlLine){ G.pts = [G.pts[0], [p.x, p.y]]; G.path.setAttribute('d', smoothD(G.pts)); return; }
    if (Math.hypot(p.x - last[0], p.y - last[1]) >= 1.6){ G.pts.push([p.x, p.y]); G.path.setAttribute('d', smoothD(G.pts)); }
    clearTimeout(G.timer); const g0 = G; G.timer = setTimeout(() => holdSnap(g0), 480);
  } else if (G.kind === 'erase'){ eraseAt(e); }
  else if (G.kind === 'shape'){
    const p = P(e);
    if (G.snapped){ if (G.lineFollow){ const st = G.st; let dx = p.x - st.x, dy = p.y - st.y; const len = Math.hypot(dx, dy), ang = Math.atan2(dy, dx), sn = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12); if (Math.abs(ang - sn) < 0.06){ dx = len * Math.cos(sn); dy = len * Math.sin(sn); } st.x2 = st.x + dx; st.y2 = st.y + dy; setSt(G.el, st); showBadges(st, true); } return; }
    G.st = makeShape(G.x0, G.y0, p.x, p.y, e.shiftKey); shapeEl(G.st, G.el); showBadges(G.st, true);
  }
  else if (G.kind === 'sym'){
    const p = pt(e), sy = S.sym, sd = S.symDims[G.key];
    if (!G.dragged && Math.hypot(p.x - G.x0, p.y - G.y0) < 8) return;
    G.dragged = true;
    let w = Math.max(10, Math.abs(p.x - G.x0)), h = Math.max(10, Math.abs(p.y - G.y0));
    if (sd){ if (Math.abs(w - sd[0]) < 4) w = sd[0]; if (Math.abs(h - sd[1]) < 4) h = sd[1]; }
    if (sy.ring && !sy.txt2 && Math.abs(w - h) < 6) h = w;
    const cx = G.x0 + (p.x >= G.x0 ? w / 2 : -w / 2), cy = G.y0 + (p.y >= G.y0 ? h / 2 : -h / 2);
    const n = symEl(sy, cx, cy, w, h); G.el.replaceWith(n); G.el = n; G.w = w; G.h = h;
    const m = V(cx, cy - h / 2); clearBadges(); badge(m[0], m[1] - 22, Math.round(w) + ' × ' + Math.round(h) + ' px', 'sz');
    const a = V(cx - w / 2, cy - h / 2), z = zoomF(); band.style.display = 'block'; band.style.left = a[0] + 'px'; band.style.top = a[1] + 'px'; band.style.width = w * z + 'px'; band.style.height = h * z + 'px';
  }
  else if (G.kind === 'text'){ band.style.display = 'block'; band.style.left = Math.min(G.vx, e.clientX) + 'px'; band.style.top = Math.min(G.vy, e.clientY) + 'px'; band.style.width = Math.abs(e.clientX - G.vx) + 'px'; band.style.height = Math.abs(e.clientY - G.vy) + 'px'; }
  else if (G.kind === 'move'){
    const dx = (e.clientX - G.x0) / z, dy = (e.clientY - G.y0) / z;
    if (!G.did){ if (Math.hypot(dx, dy) < 2) return; G.did = true; snap(); }
    S.sel.forEach((o, i) => moveObj(o, G.origs[i], dx, dy));
    paintSel();
  } else if (G.kind === 'vtx'){
    const st = getSt(G.o), p = pt(e), i = G.i, names = [['x', 'y'], ['x2', 'y2'], ['x3', 'y3']][i];
    let x = p.x, y = p.y;
    if (isLine(st) && !e.altKey){ const ox = i === 0 ? st.x2 : st.x, oy = i === 0 ? st.y2 : st.y, dx = x - ox, dy = y - oy, len = Math.hypot(dx, dy), ang = Math.atan2(dy, dx), sn = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12); if (len && Math.abs(ang - sn) < 0.06){ x = ox + len * Math.cos(sn); y = oy + len * Math.sin(sn); } }
    st[names[0]] = x; st[names[1]] = y;
    if (isLoop(st) && i === 2){ const dx = st.x2 - st.x, dy = st.y2 - st.y, c2 = dx * dx + dy * dy || 1; S.loopBend = Math.round(((st.x3 - (st.x + st.x2) / 2) * -dy + (st.y3 - (st.y + st.y2) / 2) * dx) / c2 * 100) / 100; lsSet('aw_loop_bend', S.loopBend); }
    setSt(G.o, st); showBadges(st, true); paintSel();
  } else if (G.kind === 'rot'){
    let a = G.r0 + (Math.atan2(e.clientY - G.cy, e.clientX - G.cx) * 180 / Math.PI - G.a0);
    if (!e.shiftKey){ const sn = Math.round(a / 15) * 15; if (Math.abs(a - sn) < 5) a = sn; }
    a = ((a % 360) + 540) % 360 - 180;
    if (isImg(G.o)) setImgRot(G.o, a); else { const st = getSt(G.o); st.rot = Math.round(a * 10) / 10; if (!st.rot) delete st.rot; setSt(G.o, st); }
    paintSel(); clearBadges(); badge(e.clientX + 24, e.clientY - 18, Math.round(a) + '°', 'sz');
  } else if (G.kind === 'lasso'){
    G.pts.push([e.clientX, e.clientY]);
    lassoEl.style.display = 'block'; lassoEl.firstChild.setAttribute('d', 'M' + G.pts.map(q => q[0] + ' ' + q[1]).join('L') + 'Z');
  }
}
function inPoly(x, y, P){
  let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++){ if ((P[i][1] > y) !== (P[j][1] > y) && x < (P[j][0] - P[i][0]) * (y - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) c = !c; }
  return c;
}
function onUp(e){
  if (!G || G.kind === 'resize' || G.fromRl) return;
  const g = G; G = null; band.style.display = 'none'; if (lassoEl) lassoEl.style.display = 'none'; clearTimeout(g.timer);
  if (g.kind === 'scroll') return;
  if (g.kind === 'draw'){
    const out = simplify(g.pts, g.hlLine ? 0 : SMOOTH_EPS[S.smooth] != null ? SMOOTH_EPS[S.smooth] : 0.7);   // the board has to stay small
    g.path.setAttribute('d', smoothD(out)); g.path.dataset.p = encPts(out);
    changed();
  } else if (g.kind === 'erase'){ if (g.did) changed(); }
  else if (g.kind === 'shape'){
    const st = g.st, tiny = g.snapped ? false : (isPoly(st) ? Math.hypot(st.x2 - st.x, st.y2 - st.y) < 6 : (st.bw < 6 && st.bh < 6));
    if (tiny){ g.el.remove(); S.undo.pop(); S.sel = []; clearBadges(); paintSel(); return; }   // a plain click draws nothing (and never copies the last shape)
    rememberDims(st);
    S.sel = [g.el]; clearBadges(); changed();
  } else if (g.kind === 'sym'){
    clearBadges();
    if (!g.dragged){ g.el.remove(); S.undo.pop(); paintSel(); return; }   // a plain click draws nothing
    S.symDims[g.key] = [Math.round(g.w), Math.round(g.h)]; lsSet('aw_sym_dims', S.symDims);   // the next symbols of this kind come out the same size
    S.sel = [g.el]; changed();
  } else if (g.kind === 'text'){
    const dx = Math.abs(e.clientX - g.vx) / zoomF();
    const x = Math.min(g.x0, pt(e).x), y = Math.min(g.y0, pt(e).y);
    snap(); const b = textBox(dx > 30 ? x : g.x0, dx > 30 ? y : g.y0, dx > 30 ? dx : 220);
    setTool('type'); S.sel = [b]; edit(b); changed();
  } else if (g.kind === 'move'){ if (g.did) changed(); else paintSel(); }
  else if (g.kind === 'vtx' || g.kind === 'rot'){ clearBadges(); changed(); }
  else if (g.kind === 'lasso'){
    const l = layer(false);
    if (g.pts.length > 6){
      const hits = [].filter.call(l.querySelectorAll('.fo,.aw-fb'), o => {
        const r = o.getBoundingClientRect();
        return [[r.left + r.width / 2, r.top + r.height / 2], [r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]].some(q => inPoly(q[0], q[1], g.pts));
      });
      S.sel = g.base.concat(hits.filter(o => g.base.indexOf(o) < 0));
    }
    paintSel();
  }
}
function eraseAt(e){
  const o = objAt(e.clientX, e.clientY);
  if (o && !isBox(o)){ if (!G.did){ snap(); G.did = true; } o.remove(); }
}
/* ── things you can do to the selected shapes ── */
function rotateSel(d){
  const arr = S.sel.filter(o => isSt(o) && rotatable(getSt(o))); if (!arr.length){ toast('Select a shape to turn it.'); return; }
  snap(); arr.forEach(o => { const st = getSt(o); let a = d === 0 ? 0 : ((st.rot || 0) + d); a = ((a % 360) + 540) % 360 - 180; st.rot = Math.round(a * 10) / 10; if (!st.rot) delete st.rot; setSt(o, st); }); changed();
}
function flipSel(axis){
  const arr = S.sel.filter(o => isSt(o)); if (!arr.length){ toast('Select a shape to flip it.'); return; }
  snap();
  arr.forEach(o => {
    const st = getSt(o);
    if (rotatable(st)){ const key = axis === 'x' ? 'fx' : 'fy'; if (st[key]) delete st[key]; else st[key] = 1; }
    else if (isPoly(st)){ const pts = polyPts(st), i = axis === 'x' ? 0 : 1, lo = Math.min.apply(null, pts.map(q => q[i])), hi = Math.max.apply(null, pts.map(q => q[i])), m = lo + hi; (i ? ['y', 'y2', 'y3'] : ['x', 'x2', 'x3']).forEach(k => { if (st[k] !== undefined) st[k] = m - st[k]; }); }
    setSt(o, st);
  });
  changed();
}
function setLS(id){
  S.ls = id === 'solid' ? '' : id; lsSet('aw_ls', S.ls);
  const arr = S.sel.filter(o => isSt(o) && getSt(o).k !== 'sym');
  if (arr.length){ snap(); arr.forEach(o => { const st = getSt(o); if (S.ls) st.ls = S.ls; else delete st.ls; setSt(o, st); }); changed(); }
  syncStyleUI();
}
function setSize(w, h){
  if (S.sel.length !== 1) return; const o = S.sel[0];
  if (isSt(o)){
    const st = getSt(o); snap();
    if (isLine(st)){ const len = Math.hypot(st.x2 - st.x, st.y2 - st.y) || 1, f = w / len; st.x2 = st.x + (st.x2 - st.x) * f; st.y2 = st.y + (st.y2 - st.y) * f; }
    else if (st.bw !== undefined && !isPoly(st)){ const cx = st.x + st.bw / 2, cy = st.y + st.bh / 2; if (w > 0) st.bw = w; if (h > 0) st.bh = h; st.x = cx - st.bw / 2; st.y = cy - st.bh / 2; }
    else return;
    setSt(o, st); rememberDims(st); changed();
  } else if (isBox(o) && w > 0){ snap(); o.style.width = w + 'px'; changed(); }
}
function alignBase(){
  const pens = S.sel.filter(o => o.dataset && (o.dataset.k === 'pen')); if (pens.length < 2){ toast('Select two or more handwriting strokes to level them.'); return; }
  snap(); const lr = layer(false).getBoundingClientRect(), z = zoomF();
  const bots = pens.map(o => (o.getBoundingClientRect().bottom - lr.top) / z).sort((a, b) => a - b), base = bots[Math.floor(bots.length / 2)];
  pens.forEach(o => { const t = T(o), b = (o.getBoundingClientRect().bottom - lr.top) / z; t.y += base - b; setT(o, t); }); changed();
}
function cycleSmooth(){ S.smooth = (S.smooth + 1) % 3; lsSet('aw_smooth', S.smooth); toast(['Handwriting: raw (keeps every wobble)', 'Handwriting: smooth', 'Handwriting: very smooth'][S.smooth]); syncStyleUI(); }
function toggleAngles(){ S.angles = !S.angles; lsSet('aw_angles', S.angles); paintSel(); syncStyleUI(); }
function toggleFinger(){ S.finger = !S.finger; lsSet('aw_finger', S.finger); toast(S.finger ? 'A finger draws too.' : 'A finger scrolls; only a pencil or mouse draws.'); syncStyleUI(); }

/* ── keyboard ── */
function onKey(e){
  if (!canvas || !canvas.isConnected) return;
  const ae = document.activeElement;
  // typing text (a text box, a field with letters in it) keeps the key; sliders, colour pickers and buttons do not
  const typing = ae && ((ae.isContentEditable && ae !== canvas) || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || (ae.tagName === 'INPUT' && !/^(range|color|checkbox|radio|button)$/.test(ae.type)));
  if (typing){ if (e.key === 'Escape' && ae.classList && ae.classList.contains('aw-fb')){ ae.blur(); } return; }
  if (ae === canvas && S.tool === 'type'){   // a picture clicked in the text: Delete removes it
    const sl = window.getSelection(), inCell = sl.anchorNode && sl.anchorNode.parentElement && sl.anchorNode.parentElement.closest && sl.anchorNode.parentElement.closest('td,th,.aw-fb');
    if (e.key === 'Delete' && S.sel.length === 1 && isImg(S.sel[0]) && !inCell){ e.preventDefault(); del(); }
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape'){ if (S.sel.length){ S.sel = []; paintSel(); } else setTool('type'); return; }
  if (S.tool === 'type') return;
  if (mod && e.key.toLowerCase() === 'z'){ e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y'){ e.preventDefault(); redo(); return; }
  if (!S.sel.length) return;
  if (e.key === 'Delete' || e.key === 'Backspace'){ e.preventDefault(); del(); }
  else if (mod && e.key.toLowerCase() === 'd'){ e.preventDefault(); dup(); }
  else if (/^Arrow/.test(e.key)){
    e.preventDefault(); const n = e.shiftKey ? 10 : 1, dx = e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0, dy = e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0;
    snap(); S.sel.forEach(o => moveObj(o, snapObj(o), dx, dy)); changed();
  }
}
function del(){ if (!S.sel.length) return; if (S.sel.some(isTbl) && !confirm('Xoá cả bảng này?')) return; snap(); S.sel.forEach(o => o.remove()); S.sel = []; clearBadges(); changed(); }
function dup(){
  if (!S.sel.length) return; snap(); const out = [];
  S.sel.forEach(o => { const c = o.cloneNode(true); c.dataset.id = uid(); c.setAttribute('contenteditable', 'false'); o.parentNode.appendChild(c); moveObj(c, snapObj(c), 14, 14); out.push(c); });
  S.sel = out; changed();
}
function order(front){
  if (!S.sel.length) return; snap();
  S.sel.forEach(o => { const p = o.parentNode; if (front) p.appendChild(o); else p.insertBefore(o, p.firstChild); }); changed();
}

/* ── style: colours, fill, thickness (for the next object and the selection) ── */
function applyStyle(kind, v){
  const tgt = S.sel.length > 0 && S.tool !== 'type';
  if (kind === 'stroke'){ if (S.tool === 'hl') S.hl = v; else S.stroke = v; }
  if (kind === 'fill') S.fill = v;
  if (kind === 'w') S.w = v;
  if (tgt){
    snap();
    S.sel.forEach(o => {
      if (isBox(o)){
        if (kind === 'stroke'){ o.style.color = v; }
        if (kind === 'fill'){ o.style.background = v === 'none' ? '' : v; }
        if (kind === 'w'){ o.style.borderWidth = v + 'px'; if (!o.style.borderStyle) { o.style.borderStyle = 'solid'; o.style.borderColor = S.stroke; } }
      } else if (o.dataset.k === 'sym'){
        if (kind === 'stroke'){ [].forEach.call(o.children, c => { if (c.tagName === 'text') c.setAttribute('fill', v); else c.setAttribute('stroke', v); }); }
      } else if (isSt(o)){
        const st = getSt(o);
        if (kind === 'stroke') o.setAttribute('stroke', v);
        if (kind === 'fill' && OPEN_SHAPES.indexOf(st.k) < 0) o.setAttribute('fill', v);
        if (kind === 'w'){ o.setAttribute('stroke-width', v); st.sw = v; setSt(o, st); }
      } else {
        if (kind === 'stroke') o.setAttribute('stroke', v);
        if (kind === 'fill' && o.dataset.k === 'shape'){ o.setAttribute('fill', v); }
        if (kind === 'w') o.setAttribute('stroke-width', o.dataset.k === 'hl' ? Math.max(10, v * 5) : v);
      }
    });
    changed();
  }
  syncStyleUI();
}
function syncStyleUI(){
  const bar = document.getElementById('flStyle'); if (!bar) return;
  [].forEach.call(bar.querySelectorAll('[data-fs]'), b => b.classList.toggle('on', b.dataset.fs === (S.tool === 'hl' ? S.hl : S.stroke)));
  [].forEach.call(bar.querySelectorAll('[data-ff]'), b => b.classList.toggle('on', b.dataset.ff === S.fill));
  const w = document.getElementById('flW'); if (w && document.activeElement !== w) w.value = S.w;
  const wv = document.getElementById('flWv'); if (wv) wv.textContent = S.w;
  [].forEach.call(document.querySelectorAll('#tb [data-fl-tool]'), b => b.classList.toggle('on', b.dataset.flTool === S.tool));
  [].forEach.call(document.querySelectorAll('#tb [data-ls]'), b => b.classList.toggle('on', b.dataset.ls === (S.ls || 'solid')));
  const tg = (id, on) => { const b = document.getElementById(id); if (b) b.classList.toggle('on', !!on); };
  tg('flAngles', S.angles); tg('flFinger', S.finger); tg('flRuler', S.ruler.on);
  const sm = document.getElementById('flSmooth'); if (sm) sm.textContent = 'Smooth ' + ['●○○', '●●○', '●●●'][S.smooth];
  const hasUndo = document.getElementById('flUndo'); if (hasUndo) hasUndo.disabled = !S.undo.length;
  const hasRedo = document.getElementById('flRedo'); if (hasRedo) hasRedo.disabled = !S.redo.length;
  // the size of the selected shape
  const fw = document.getElementById('flSW'), fh = document.getElementById('flSH');
  if (fw && fh && document.activeElement !== fw && document.activeElement !== fh){
    const o = S.sel.length === 1 ? S.sel[0] : null, st = o && isSt(o) ? getSt(o) : null;
    fw.value = st ? (isLine(st) ? Math.round(Math.hypot(st.x2 - st.x, st.y2 - st.y)) : (st.bw !== undefined && !isPoly(st) ? Math.round(st.bw) : '')) : (o && isBox(o) ? Math.round(o.offsetWidth) : '');
    fh.value = st && st.bw !== undefined && !isPoly(st) ? Math.round(st.bh) : '';
  }
}
function setTool(t){
  if (S.tool === 'type' && t !== 'type'){ const a = document.activeElement; if (a && a.classList && a.classList.contains('aw-fb')) a.blur(); }
  S.tool = t; if (t !== 'select' && t !== 'shape' && !(t === 'type' && S.sel.length === 1 && isBox(S.sel[0]))) S.sel = [];
  layer(t !== 'type'); sync(); paintSel();
  if (canvas) canvas.classList.toggle('free-on', t !== 'type');
  if (t === 'shape' || t === 'pen' || t === 'hl'){ /* keep panels as they are */ }
  syncStyleUI();
  [].forEach.call(document.querySelectorAll('.aw-fpanel-btn'), b => b.classList.toggle('on', !!panels[b.dataset.panel] && panels[b.dataset.panel].isConnected));
}

/* ═══════════ Draw tab and the floating Shapes / Symbols panels ═══════════ */
const IC = d => '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
const TOOL_ICONS = {
  type: IC('<path d="M9 4h6M12 4v16M9 20h6"/>'),
  select: IC('<path d="m5 3 14 8-6 2-2 6z"/>'),
  text: IC('<rect x="3" y="4" width="18" height="16" rx="2" stroke-dasharray="3 2"/><path d="M8 9h8M12 9v7"/>'),
  pen: IC('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  hl: IC('<path d="m9 11 4 4 6.5-6.5-4-4z"/><path d="m9 11-4 4v3h4l2-2"/><path d="M3 21h8"/>'),
  eraser: IC('<path d="m7 21-4-4a2 2 0 0 1 0-3L14 3a2 2 0 0 1 3 0l4 4a2 2 0 0 1 0 3L11 21z"/><path d="M8 11l6 6"/>'),
  shapes: IC('<rect x="3" y="3" width="9" height="9" rx="1"/><circle cx="16.5" cy="16.5" r="4.5"/>'),
  syms: IC('<circle cx="12" cy="12" r="8"/><path d="M9 15V9l6 6V9"/>'),
  undo: IC('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  redo: IC('<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
  dup: IC('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
  del: IC('<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>'),
  front: IC('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10" />'),
  back: IC('<rect x="4" y="4" width="12" height="12" rx="2"/><path d="M20 8v10a2 2 0 0 1-2 2H8"/>')
};
function panelHtml(){
  const b = (cls, attrs, inner, title) => '<button type="button" class="aw-rb-b ' + cls + '" ' + attrs + ' title="' + title + '" aria-label="' + title + '">' + inner + '</button>';
  const grp = (rows, label) => '<div class="aw-rb-grp">' + rows.map(r => '<div class="aw-rb-row">' + r + '</div>').join('') + '<div class="aw-rb-lbl">' + label + '</div></div>';
  const tools = [['type', 'Type — click the board and write (Esc)'], ['select', 'Select, move and resize'], ['text', 'Text box — drag a box anywhere and type'], ['pen', 'Pen'], ['hl', 'Highlighter'], ['eraser', 'Eraser — removes a whole stroke']];
  const sw = COLOURS.map(c => '<button type="button" class="aw-tcolor-sw" data-fs="' + c + '" style="background:' + c + '" title="Colour"></button>').join('') + '<label class="aw-tcolor-sw aw-cust" title="Other colour"><input type="color" id="flCust" value="#3366cc">+</label>';
  const fl = FILLS.map(c => c === 'none' ? '<button type="button" class="aw-tcolor-sw" data-ff="none" style="background:#fff;color:#888;font-size:.7rem;font-weight:700" title="No fill">✕</button>' : '<button type="button" class="aw-tcolor-sw" data-ff="' + c + '" style="background:' + c + '" title="Fill"></button>').join('');
  return grp([tools.map(t => b('', 'data-fl-tool="' + t[0] + '"', TOOL_ICONS[t[0]], t[1])).join('')], 'Tools') +
    grp([b('aw-rb-big aw-fpanel-btn', 'data-panel="shapes"', TOOL_ICONS.shapes + '<span>Shapes</span>', 'Shapes, brackets, arrows, maths figures') + b('aw-rb-big aw-fpanel-btn', 'data-panel="syms"', TOOL_ICONS.syms + '<span>Symbols</span>', 'Word classes and syntax labels (N, V, NP, AdvP …)')], 'Insert') +
    '<div class="aw-rb-grp" id="flStyle"><div class="aw-rb-row"><span class="aw-rb-hint">Colour</span>' + sw + '</div><div class="aw-rb-row"><span class="aw-rb-hint">Fill</span>' + fl + '</div><div class="aw-rb-lbl">Colour &amp; fill</div></div>' +
    grp(['<label class="aw-tl-f">Thickness <input type="range" id="flW" min="1" max="20" step="1" value="3" style="width:90px"> <b id="flWv">3</b></label>',
         LINE_STYLES.map(ls => '<button type="button" class="aw-rb-b aw-ls" data-ls="' + ls[0] + '" title="' + ls[1] + '"><svg width="30" height="10" viewBox="0 0 30 10"><path d="M2 5H28" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"' + (ls[2] ? ' stroke-dasharray="' + ls[2] + '"' : '') + '/></svg></button>').join('')], 'Line') +
    grp([b('aw-txt', 'data-rot="-15"', '↺ 15°', 'Turn the selected shape 15° left') + b('aw-txt', 'data-rot="15"', '↻ 15°', 'Turn 15° right') + b('aw-txt', 'data-rot="90"', '↻ 90°', 'Turn 90°') + b('aw-txt', 'data-rot="0"', 'Reset', 'Turn back to upright'),
         b('aw-txt', 'data-flip="x"', '⇋ Flip', 'Flip left-right') + b('aw-txt', 'data-flip="y"', '⇵ Flip', 'Flip upside-down') + b('aw-txt', 'id="flAngles"', '∠ Angles', 'Show the angle at every corner') +
         '<label class="aw-tl-f">W <input type="number" id="flSW" min="4" style="width:54px"></label><label class="aw-tl-f">H <input type="number" id="flSH" min="4" style="width:54px"></label>'], 'Shape') +
    grp([b('aw-txt', 'id="flRuler"', '📏 Ruler', 'Ruler: draw along its edge for a straight line (drag the middle to move, an end to turn)') + b('aw-txt', 'id="flSmooth"', 'Smooth ●○○', 'Handwriting smoothing') + b('aw-txt', 'id="flFinger"', '☝ Finger', 'Let a finger draw too (off: a finger scrolls, only a pencil or mouse draws)')], 'Pen') +
    grp([b('', 'id="flUndo"', TOOL_ICONS.undo, 'Undo drawing (Ctrl+Z)') + b('', 'id="flRedo"', TOOL_ICONS.redo, 'Redo drawing') + b('', 'data-fl-act="dup"', TOOL_ICONS.dup, 'Duplicate (Ctrl+D)') + b('', 'data-fl-act="del"', TOOL_ICONS.del, 'Delete (Del)') + b('', 'data-fl-act="front"', TOOL_ICONS.front, 'Bring to front') + b('', 'data-fl-act="back"', TOOL_ICONS.back, 'Send to back'),
         b('aw-txt', 'data-fl-act="align"', '≡ Level', 'Level the selected handwriting onto one baseline')], 'Arrange');
}

function makePanel(id, title, w){
  let p = panels[id]; if (p && p.isConnected){ p.remove(); panels[id] = null; syncStyleUI(); return null; }
  p = document.createElement('div'); p.className = 'aw-fpanel'; p.dataset.id = id;
  p.innerHTML = '<div class="aw-fp-head"><b>' + title + '</b><button type="button" class="aw-fp-x" aria-label="Close">×</button></div><div class="aw-fp-body"></div>';
  p.style.width = w + 'px'; p.style.right = '24px'; p.style.top = '190px';
  document.body.appendChild(p); panels[id] = p;
  p.querySelector('.aw-fp-x').onclick = () => { p.remove(); panels[id] = null; syncStyleUI(); };
  p.addEventListener('mousedown', e => { if (!/^(INPUT|SELECT)$/.test(e.target.tagName)) e.preventDefault(); });
  // drag by the header
  const head = p.querySelector('.aw-fp-head');
  head.addEventListener('pointerdown', e => {
    if (e.target.tagName === 'BUTTON') return;
    const r = p.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top; head.setPointerCapture(e.pointerId);
    const mv = ev => { p.style.left = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - dx)) + 'px'; p.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy)) + 'px'; p.style.right = 'auto'; };
    const up = () => { head.removeEventListener('pointermove', mv); head.removeEventListener('pointerup', up); };
    head.addEventListener('pointermove', mv); head.addEventListener('pointerup', up);
  });
  return p;
}
function openShapes(){
  const p = makePanel('shapes', 'Shapes', 340); if (!p) return;
  p.querySelector('.aw-fp-body').innerHTML = '<div class="aw-shgrid">' + SHAPES.map(it => {
    if (!it) return '<div class="aw-shsep"></div>';
    return '<button type="button" class="aw-shbtn" data-k="' + it[0] + '" data-o="' + it[1] + '" title="' + it[2].replace(/"/g, '&quot;') + '">' + shapeIconSVG(it[0], it[1]) + '</button>';
  }).join('') + '</div><div class="aw-fp-tip">Drag on the board to draw (Shift keeps it square / level). A click places a standard size.</div>';
  p.querySelector('.aw-shgrid').addEventListener('click', e => {
    const b = e.target.closest('.aw-shbtn'); if (!b) return;
    S.shape = { k: b.dataset.k, o: +b.dataset.o }; setTool('shape');
    [].forEach.call(p.querySelectorAll('.aw-shbtn'), x => x.classList.toggle('cur', x === b));
  });
  syncStyleUI();
}
function symOwn(){ try { const a = JSON.parse(localStorage.getItem('aw_sym_own') || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function openSyms(){
  const p = makePanel('syms', 'Symbols', 320); if (!p) return;
  const body = p.querySelector('.aw-fp-body');
  const chip = (t, ring, it, t2, g) => '<button type="button" class="sym-chip' + (ring ? ' ring' : '') + (it ? ' it' : '') + (t2 ? ' two' : '') + '" data-t="' + t.replace(/"/g, '&quot;') + '"' + (t2 ? ' data-t2="' + t2 + '"' : '') + (g ? ' data-g="' + g + '"' : '') + (ring ? ' data-ring="1"' : '') + (it ? ' data-it="1"' : '') + '>' + (t2 ? '<span>' + t + '</span><small>' + t2 + '</small>' : t) + '</button>';
  const head = (g, title) => '<div class="aw-symhd"><span>' + title + '</span><label title="Put a circle around every symbol of this group"><input type="checkbox" data-circ="' + g + '"' + (S.circ[g] ? ' checked' : '') + '> Circle</label></div>';
  const grp = g => head(g[0], g[1]) + '<div class="aw-symgrid">' + g[2].map(t => chip(t, false, false, '', g[0])).join('') + '</div>';
  function build(){
    let h = '<div class="aw-symseg"><button type="button" data-tab="syn" class="' + (S.symTab === 'syn' ? 'cur' : '') + '">Syntax</button><button type="button" data-tab="mor" class="' + (S.symTab === 'mor' ? 'cur' : '') + '">Morphology</button></div>';
    if (S.symTab === 'syn') h += SYM_GROUPS.filter(g => g[3] !== 'mor').map(grp).join('') + head('verb', 'Verb types (two-tier)') + '<div class="aw-symgrid">' + SYM_VERB.map(t => chip('V', false, false, '[' + t + ']', 'verb')).join('') + '</div>';
    else h += '<div class="aw-symhd"><span>Affixes</span></div><div class="aw-symgrid">' + SYM_AFFIX.map(t => chip(t, false, true)).join('') + '</div>' + grp(SYM_GROUPS.find(g => g[0] === 'wc'));
    const own = symOwn();
    h += '<div class="aw-symhd"><span>Your own</span></div>' + (own.length ? '<div class="aw-symgrid">' + own.map((c, i) => '<span class="sym-own">' + chip(c.t, c.ring) + '<button type="button" class="sym-del" data-del="' + i + '" title="Remove">×</button></span>').join('') + '</div>' : '') +
      '<div class="aw-symadd"><input id="symTxt" maxlength="14" placeholder="e.g. Adj"><label><input type="checkbox" id="symRing"> circle</label><button type="button" id="symAdd">Add</button></div>' +
      '<div class="aw-fp-tip">Click the board to place a symbol, or drag to size it. It takes the current colour.</div>';
    body.innerHTML = h;
  }
  build();
  body.addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]'); if (tab){ S.symTab = tab.dataset.tab; build(); return; }
    const del = e.target.closest('.sym-del'); if (del){ const a = symOwn(); a.splice(+del.dataset.del, 1); try { localStorage.setItem('aw_sym_own', JSON.stringify(a)); } catch (er) {} build(); return; }
    if (e.target.id === 'symAdd'){
      const t = (document.getElementById('symTxt').value || '').trim(), ring = document.getElementById('symRing').checked; if (!t) return;
      const a = symOwn().filter(c => !(c.t === t && !!c.ring === ring)); a.push({ t, ring }); try { localStorage.setItem('aw_sym_own', JSON.stringify(a.slice(-60))); } catch (er) {} build(); return;
    }
    const c = e.target.closest('.sym-chip'); if (!c) return;
    const own = !!c.closest('.sym-own'), g = c.dataset.g;
    const ring = c.dataset.ring ? true : (c.dataset.it || own) ? false : !!S.circ[g];
    S.sym = { txt: c.dataset.t, ring: own ? c.classList.contains('ring') : ring, it: !!c.dataset.it, txt2: c.dataset.t2 || '' };
    S.shape = { k: 'sym', o: 0 }; setTool('shape');
    [].forEach.call(body.querySelectorAll('.sym-chip'), x => x.classList.toggle('cur', x === c));
  });
  body.addEventListener('change', e => { const g = e.target.dataset && e.target.dataset.circ; if (g){ S.circ[g] = e.target.checked; try { localStorage.setItem('aw_sym_circ', JSON.stringify(S.circ)); } catch (er) {} } });
}

/* ═══════════ wiring ═══════════ */
function wire(cv){
  canvas = cv; if (!cv) return;
  buildUI(); hydrate(cv); sync();
  S.sel = []; S.undo = []; S.redo = []; S.tool = 'type'; cv.classList.remove('free-on');
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointercancel', onUp);
  cv.addEventListener('touchmove', e => { if (S.tool !== 'type' && e.cancelable) e.preventDefault(); }, { passive: false });
  // text boxes: click to write, leave to finish
  cv.addEventListener('mousedown', e => {
    const b = e.target.closest && e.target.closest('.aw-fb');
    if (b && S.tool === 'type' && b.getAttribute('contenteditable') !== 'true'){ b.setAttribute('contenteditable', 'true'); }
  }, true);
  cv.addEventListener('focusout', e => { const b = e.target.closest && e.target.closest('.aw-fb'); if (b) endEdit(b); });
  cv.addEventListener('focusin', e => { const b = e.target.closest && e.target.closest('.aw-fb'); if (b && S.tool === 'type'){ S.sel = [b]; paintSel(); } });
  cv.addEventListener('input', () => { if (S.sel.length) paintSel(); });
  document.addEventListener('mousedown', e => {   // click away: the frame goes
    if (S.tool !== 'type' || !S.sel.length) return;
    const t = e.target; if (t.closest && (t.closest('.aw-fb') || t.closest('table') || t.tagName === 'IMG' || t.closest('.aw-flsel') || t.closest('#tb') || t.closest('.aw-fpanel') || t.closest('.aw-colpop'))) return;
    S.sel = []; paintSel();
  }, true);
  cv.addEventListener('dblclick', e => { const b = e.target.closest && e.target.closest('.aw-fb'); if (b && S.tool === 'select'){ setTool('type'); edit(b); } });
  cv.addEventListener('keydown', e => {   // Ctrl+A inside a text box selects that box's text only
    const b = e.target.closest && e.target.closest('.aw-fb');
    if (b && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a'){ e.preventDefault(); const r = document.createRange(); r.selectNodeContents(b); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
  });
  document.addEventListener('keydown', onKey);
  // ribbon controls (built by panelHtml)
  const tb = document.getElementById('tb'); if (!tb) return;
  [].forEach.call(tb.querySelectorAll('[data-fl-tool]'), b => { b.onclick = () => setTool(b.dataset.flTool); });
  [].forEach.call(tb.querySelectorAll('[data-fl-act]'), b => { b.onclick = () => ({ dup, del, front: () => order(true), back: () => order(false), align: alignBase })[b.dataset.flAct](); });
  [].forEach.call(tb.querySelectorAll('[data-rot]'), b => { b.onclick = () => rotateSel(+b.dataset.rot); });
  [].forEach.call(tb.querySelectorAll('[data-flip]'), b => { b.onclick = () => flipSel(b.dataset.flip); });
  [].forEach.call(tb.querySelectorAll('[data-ls]'), b => { b.onclick = () => setLS(b.dataset.ls); });
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  bind('flAngles', toggleAngles); bind('flRuler', toggleRuler); bind('flSmooth', cycleSmooth); bind('flFinger', toggleFinger);
  const sw = document.getElementById('flSW'), sh = document.getElementById('flSH');
  const sz = () => setSize(parseFloat(sw.value) || 0, parseFloat(sh.value) || 0); if (sw) sw.onchange = sz; if (sh) sh.onchange = sz;
  [].forEach.call(tb.querySelectorAll('[data-fs]'), b => { b.onclick = () => applyStyle('stroke', b.dataset.fs); });
  [].forEach.call(tb.querySelectorAll('[data-ff]'), b => { b.onclick = () => applyStyle('fill', b.dataset.ff); });
  const cust = document.getElementById('flCust'); if (cust) cust.onchange = () => applyStyle('stroke', cust.value);
  const w = document.getElementById('flW'); if (w) w.oninput = () => applyStyle('w', +w.value);
  document.getElementById('flUndo').onclick = undo; document.getElementById('flRedo').onclick = redo;
  [].forEach.call(tb.querySelectorAll('.aw-fpanel-btn'), b => { b.onclick = () => { b.dataset.panel === 'shapes' ? openShapes() : openSyms(); setTimeout(() => [].forEach.call(tb.querySelectorAll('.aw-fpanel-btn'), x => x.classList.toggle('on', !!panels[x.dataset.panel] && panels[x.dataset.panel].isConnected)), 0); }; });
  syncStyleUI();
  setTimeout(fit, 50);
}
function selectEl(el){   // a table or a picture clicked in the text
  if (!canvas || S.tool !== 'type') return;
  if (el){ if (S.sel.length !== 1 || S.sel[0] !== el) S.sel = [el]; paintSel(); }
  else if (S.sel.length === 1 && isFreeable(S.sel[0])){ S.sel = []; paintSel(); }
}
function selectTable(t){
  if (!canvas || S.tool !== 'type') return;
  if (t){ if (S.sel.length !== 1 || S.sel[0] !== t){ S.sel = [t]; } paintSel(); }
  else if (S.sel.length === 1 && isTbl(S.sel[0])){ S.sel = []; paintSel(); }
}
window.AWFree = { panelHtml, wire, tool: () => S.tool, setTool, fit, serialize, hydrate, selectTable, selectEl };
})();
