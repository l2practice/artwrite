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

let canvas = null, S = { tool: 'type', stroke: '#111111', hl: '#FFD43B', fill: 'none', w: 3, shape: { k: 'rect', o: 0 }, sym: null, sel: [], undo: [], redo: [], symTab: 'syn', circ: {}, loopBend: 0.5 };
try { S.circ = JSON.parse(localStorage.getItem('aw_sym_circ') || '{}') || {}; } catch (e) {}
let G = null, ui = null, band = null, panels = {};
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
/* the board gets as tall as the lowest object */
function fit(){
  const l = layer(false); if (!l) return;
  let pad = canvas.querySelector(':scope > .aw-fl-pad');
  const objs = [].slice.call(l.querySelectorAll('.fo,.aw-fb'));
  if (!objs.length){ if (pad) pad.remove(); return; }
  if (!pad){ pad = document.createElement('div'); pad.className = 'aw-fl-pad'; pad.setAttribute('contenteditable', 'false'); pad.style.height = '0px'; canvas.appendChild(pad); }
  const cr = canvas.getBoundingClientRect(), z = zoomF();
  let low = 0; objs.forEach(o => { low = Math.max(low, (o.getBoundingClientRect().bottom - cr.top) / z); });
  pad.style.height = '0px';
  const top = (pad.getBoundingClientRect().top - cr.top) / z;
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
  [].forEach.call(cl.querySelectorAll('path[data-p]'), p => p.removeAttribute('d'));
  [].forEach.call(cl.querySelectorAll('.aw-fb'), b => b.setAttribute('contenteditable', 'false'));
  return c.innerHTML;
}
function hydrate(cv){
  const l = cv.querySelector(':scope > .aw-fl'); if (!l) return;
  l.className = 'aw-fl';
  [].forEach.call(l.querySelectorAll('path[data-p]'), p => { if (!p.getAttribute('d')) p.setAttribute('d', smoothD(decPts(p.dataset.p))); });
  [].forEach.call(l.querySelectorAll('.aw-fb'), b => b.setAttribute('contenteditable', 'false'));
}
function smoothD(pts){
  if (pts.length === 1) return 'M' + r1(pts[0][0]) + ' ' + r1(pts[0][1]) + 'L' + r1(pts[0][0] + .01) + ' ' + r1(pts[0][1]);
  if (pts.length === 2) return 'M' + r1(pts[0][0]) + ' ' + r1(pts[0][1]) + 'L' + r1(pts[1][0]) + ' ' + r1(pts[1][1]);
  let d = 'M' + r1(pts[0][0]) + ' ' + r1(pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++){ const m = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]; d += 'Q' + r1(pts[i][0]) + ' ' + r1(pts[i][1]) + ' ' + r1(m[0]) + ' ' + r1(m[1]); }
  const e = pts[pts.length - 1]; return d + 'L' + r1(e[0]) + ' ' + r1(e[1]);
}
function makeShape(x0, y0, x1, y1, shift){
  const sh = S.shape, s = { k: sh.k, o: sh.o, sw: S.w };
  if (s.k === 'loop'){ s.x = x0; s.y = y0; s.x2 = x1; s.y2 = y1; const dx = x1 - x0, dy = y1 - y0; s.x3 = (x0 + x1) / 2 - dy * S.loopBend; s.y3 = (y0 + y1) / 2 + dx * S.loopBend; return s; }
  if (s.k === 'lnx'){ const E = LINE_ENDS[s.o] || ['', '']; s.k = 'line'; s.o = 0; if (E[0]) s.e0 = E[0]; if (E[1]) s.e1 = E[1]; }
  if (s.k === 'line' || s.k === 'arrow'){
    let dx = x1 - x0, dy = y1 - y0; const len = Math.hypot(dx, dy);
    if (len > 0){ const ang = Math.atan2(dy, dx), step = Math.PI / 12, sn = Math.round(ang / step) * step; if (shift || Math.abs(ang - sn) < 0.06){ dx = len * Math.cos(sn); dy = len * Math.sin(sn); } }
    s.x = x0; s.y = y0; s.x2 = x0 + dx; s.y2 = y0 + dy; return s;
  }
  let w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  if (shift || ((s.k === 'ellipse' || s.k === 'rect' || s.k === 'star' || s.k === 'cube' || s.k === 'sphere') && Math.abs(w - h) < 5)){ const m = Math.max(w, h); w = h = m; }
  s.bw = w; s.bh = h; s.x = x1 >= x0 ? x0 : x0 - w; s.y = y1 >= y0 ? y0 : y0 - h;
  if (s.k === 'caret'){ s.x2 = s.x + w / 2; s.y2 = s.y; s.x3 = s.x + w; s.y3 = s.y + h; s.y = s.y + h; }
  return s;
}
function shapeEl(st, existing){
  const d = polysToD(shapePaths(st));
  if (existing){ existing.setAttribute('d', d); return existing; }
  const open = OPEN_SHAPES.indexOf(st.k) >= 0;
  const p = mkPath(d, { k: 'shape', stroke: S.stroke, w: S.w, fill: open ? 'none' : S.fill });
  return p;
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
const isBox = o => o.classList && o.classList.contains('aw-fb');
const boxScale = b => parseFloat(b.dataset.s) || 1;
function setBoxScale(b, k){ k = Math.max(.2, Math.min(8, k)); b.style.transformOrigin = '0 0'; if (Math.abs(k - 1) < 0.002){ delete b.dataset.s; b.style.transform = ''; } else { b.dataset.s = Math.round(k * 1000) / 1000; b.style.transform = 'scale(' + b.dataset.s + ')'; } }
function boxOf(list){
  const l = layer(false); if (!l || !list.length) return null;
  const lr = l.getBoundingClientRect(), z = zoomF(); let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  list.forEach(o => { const r = o.getBoundingClientRect(); x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); });
  return { vx: x0, vy: y0, vw: x1 - x0, vh: y1 - y0, x: (x0 - lr.left) / z, y: (y0 - lr.top) / z, w: (x1 - x0) / z, h: (y1 - y0) / z };
}
function paintSel(){
  if (!ui) return;
  S.sel = S.sel.filter(o => o.isConnected);
  const showBox = S.tool === 'select' || (S.tool === 'type' && S.sel.length === 1 && isBox(S.sel[0]));
  const b = showBox ? boxOf(S.sel) : null;
  if (!b){ ui.style.display = 'none'; syncStyleUI(); return; }
  ui.style.display = 'block'; ui.style.left = b.vx - 4 + 'px'; ui.style.top = b.vy - 4 + 'px'; ui.style.width = b.vw + 8 + 'px'; ui.style.height = b.vh + 8 + 'px';
  syncStyleUI();
}
function buildUI(){
  if (ui) return;
  ui = document.createElement('div'); ui.className = 'aw-flsel'; ui.style.display = 'none';
  ui.innerHTML = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(h => '<i class="h" data-h="' + h + '"></i>').join('') + '<i class="mv" title="Drag to move">✥ Move</i><i class="dl" title="Delete">✕</i>';
  document.body.appendChild(ui);
  ui.addEventListener('pointerdown', e => {
    const cl = e.target.classList; if (!cl) return;
    if (cl.contains('dl')){ e.preventDefault(); e.stopPropagation(); del(); return; }
    if (cl.contains('mv')){   // the grip: drag the selection (works while a text box is being edited too)
      e.preventDefault(); e.stopPropagation(); ui.setPointerCapture(e.pointerId); snap();
      G = { kind: 'move', x0: e.clientX, y0: e.clientY, did: true, fromUi: true, origs: S.sel.map(o => isBox(o) ? { l: parseFloat(o.style.left) || 0, t: parseFloat(o.style.top) || 0 } : T(o)) };
      return;
    }
    const h = e.target.dataset && e.target.dataset.h; if (!h) return;
    e.preventDefault(); e.stopPropagation(); ui.setPointerCapture(e.pointerId);
    snap(); G = { kind: 'resize', h, ob: boxOf(S.sel), x0: e.clientX, y0: e.clientY, origs: S.sel.map(o => isBox(o) ? { l: parseFloat(o.style.left) || 0, t: parseFloat(o.style.top) || 0, w: o.offsetWidth, s: boxScale(o) } : T(o)) };
  });
  ui.addEventListener('pointermove', e => { if (!G) return; if (G.kind === 'resize') resizeMove(e); else if (G.fromUi) onMove(e); });
  ui.addEventListener('pointerup', e => { if (!G) return; if (G.kind === 'resize'){ G = null; changed(); } else if (G.fromUi) onUp(e); });
  band = document.createElement('div'); band.className = 'aw-flband'; band.style.display = 'none'; document.body.appendChild(band);
  window.addEventListener('scroll', paintSel, true); window.addEventListener('resize', paintSel);
}
function resizeMove(e){
  const z = zoomF(), dx = (e.clientX - G.x0) / z, dy = (e.clientY - G.y0) / z, o = G.ob, h = G.h;
  let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
  if (h.indexOf('w') >= 0) x0 = Math.min(x1 - 8, o.x + dx); if (h.indexOf('e') >= 0) x1 = Math.max(x0 + 8, o.x + o.w + dx);
  if (h.indexOf('n') >= 0) y0 = Math.min(y1 - 8, o.y + dy); if (h.indexOf('s') >= 0) y1 = Math.max(y0 + 8, o.y + o.h + dy);
  const ax = (x1 - x0) / (o.w || 1), ay = (y1 - y0) / (o.h || 1);
  S.sel.forEach((s, i) => {
    const g = G.origs[i];
    if (isBox(s)){
      const corner = h.length === 2;
      s.style.left = r1(x0 + (g.l - o.x) * ax) + 'px'; s.style.top = r1(y0 + (g.t - o.y) * (corner ? ax : ay)) + 'px';
      if (corner) setBoxScale(s, g.s * ax);                 // corner: the whole box grows or shrinks, text included
      else s.style.width = r1(Math.max(40, g.w * ax)) + 'px'; // side: wider or narrower, the text re-wraps
    }
    else setT(s, { x: ax * g.x + x0 - ax * o.x, y: ay * g.y + y0 - ay * o.y, sx: g.sx * ax, sy: g.sy * ay });
  });
  paintSel();
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

/* ── pointer gestures ── */
function onDown(e){
  if (S.tool === 'type') return;
  if (!e.target.closest || !e.target.closest('.aw-fl')) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  const l = layer(true); try { l.setPointerCapture(e.pointerId); } catch (er) {}
  const p = pt(e);
  if (S.tool === 'pen' || S.tool === 'hl'){
    snap(); const hl = S.tool === 'hl';
    const path = mkPath(smoothD([[p.x, p.y]]), { k: S.tool, stroke: hl ? S.hl : S.stroke, w: hl ? Math.max(10, S.w * 5) : S.w });
    svgEl().appendChild(path); G = { kind: 'draw', path, pts: [[p.x, p.y]] };
  } else if (S.tool === 'eraser'){
    G = { kind: 'erase', did: false }; eraseAt(e);
  } else if (S.tool === 'shape'){
    snap();
    if (S.shape.k === 'sym'){ G = { kind: 'sym', x0: p.x, y0: p.y, el: null }; return; }
    const st = makeShape(p.x, p.y, p.x, p.y); const el = shapeEl(st); svgEl().appendChild(el); G = { kind: 'shape', x0: p.x, y0: p.y, el, st };
  } else if (S.tool === 'text'){
    G = { kind: 'text', x0: p.x, y0: p.y, vx: e.clientX, vy: e.clientY };
  } else if (S.tool === 'select'){
    const hit = objAt(e.clientX, e.clientY);
    if (hit){
      if (e.shiftKey){ S.sel = S.sel.indexOf(hit) >= 0 ? S.sel.filter(x => x !== hit) : S.sel.concat(hit); }
      else if (S.sel.indexOf(hit) < 0) S.sel = [hit];
      G = { kind: 'move', x0: e.clientX, y0: e.clientY, did: false, origs: S.sel.map(o => isBox(o) ? { l: parseFloat(o.style.left) || 0, t: parseFloat(o.style.top) || 0 } : T(o)) };
    } else {
      if (!e.shiftKey) S.sel = [];
      G = { kind: 'band', x0: e.clientX, y0: e.clientY, base: S.sel.slice() };
    }
    paintSel();
  }
}
function onMove(e){
  if (!G || G.kind === 'resize') return;
  const z = zoomF();
  if (G.kind === 'draw'){
    const p = pt(e), last = G.pts[G.pts.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1]) >= 1.6){ G.pts.push([p.x, p.y]); G.path.setAttribute('d', smoothD(G.pts)); }
  } else if (G.kind === 'erase'){ eraseAt(e); }
  else if (G.kind === 'shape'){ const p = pt(e); G.st = makeShape(G.x0, G.y0, p.x, p.y, e.shiftKey); shapeEl(G.st, G.el); }
  else if (G.kind === 'sym'){ const p = pt(e); G.cur = p; }
  else if (G.kind === 'text'){ band.style.display = 'block'; band.style.left = Math.min(G.vx, e.clientX) + 'px'; band.style.top = Math.min(G.vy, e.clientY) + 'px'; band.style.width = Math.abs(e.clientX - G.vx) + 'px'; band.style.height = Math.abs(e.clientY - G.vy) + 'px'; }
  else if (G.kind === 'move'){
    const dx = (e.clientX - G.x0) / z, dy = (e.clientY - G.y0) / z;
    if (!G.did){ if (Math.hypot(dx, dy) < 2) return; G.did = true; snap(); }
    S.sel.forEach((o, i) => { const g = G.origs[i]; if (isBox(o)){ o.style.left = r1(g.l + dx) + 'px'; o.style.top = r1(g.t + dy) + 'px'; } else setT(o, { x: g.x + dx, y: g.y + dy, sx: g.sx, sy: g.sy }); });
    paintSel();
  } else if (G.kind === 'band'){
    band.style.display = 'block'; band.style.left = Math.min(G.x0, e.clientX) + 'px'; band.style.top = Math.min(G.y0, e.clientY) + 'px'; band.style.width = Math.abs(e.clientX - G.x0) + 'px'; band.style.height = Math.abs(e.clientY - G.y0) + 'px';
  }
}
function onUp(e){
  if (!G || G.kind === 'resize') return;
  const g = G; G = null; band.style.display = 'none';
  if (g.kind === 'draw'){
    const out = simplify(g.pts, 0.7);   // the board has to stay small
    g.path.setAttribute('d', smoothD(out)); g.path.dataset.p = encPts(out);
    changed();
  } else if (g.kind === 'erase'){ if (g.did) changed(); }
  else if (g.kind === 'shape'){
    const st = g.st, tiny = (st.k === 'line' || st.k === 'arrow' || st.k === 'loop') ? Math.hypot(st.x2 - st.x, st.y2 - st.y) < 6 : (st.bw < 6 && st.bh < 6);
    if (tiny){   // a plain click puts a standard-size shape
      const p = { x: g.x0, y: g.y0 }, big = 70;
      const s2 = makeShape(p.x, p.y, p.x + (S.shape.k === 'line' || S.shape.k === 'arrow' || S.shape.k === 'lnx' || S.shape.k === 'loop' ? 110 : big), p.y + (S.shape.k === 'line' || S.shape.k === 'arrow' || S.shape.k === 'lnx' ? 0 : (S.shape.k === 'loop' ? -40 : big * .8)));
      shapeEl(s2, g.el);
    }
    changed();
  } else if (g.kind === 'sym'){
    const sy = S.sym; if (!sy){ return; }
    const sz = symSize(sy.txt, sy.ring, sy.txt2), p = g.cur;
    let w = sz[0], h = sz[1], cx = g.x0, cy = g.y0;
    if (p && Math.hypot(p.x - g.x0, p.y - g.y0) > 12){ w = Math.abs(p.x - g.x0); h = Math.abs(p.y - g.y0); cx = (p.x + g.x0) / 2; cy = (p.y + g.y0) / 2; if (sy.ring && !sy.txt2 && Math.abs(w - h) < 6) h = w; }
    svgEl().appendChild(symEl(sy, cx, cy, w, h)); changed();
  } else if (g.kind === 'text'){
    const dx = Math.abs(e.clientX - g.vx) / zoomF();
    const x = Math.min(g.x0, pt(e).x), y = Math.min(g.y0, pt(e).y);
    snap(); const b = textBox(dx > 30 ? x : g.x0, dx > 30 ? y : g.y0, dx > 30 ? dx : 220);
    setTool('type'); S.sel = [b]; edit(b); changed();
  } else if (g.kind === 'move'){ if (g.did) changed(); else paintSel(); }
  else if (g.kind === 'band'){
    const l = layer(false), x0 = Math.min(g.x0, e.clientX), y0 = Math.min(g.y0, e.clientY), x1 = Math.max(g.x0, e.clientX), y1 = Math.max(g.y0, e.clientY);
    if (x1 - x0 > 4 || y1 - y0 > 4){
      const hits = [].filter.call(l.querySelectorAll('.fo,.aw-fb'), o => { const r = o.getBoundingClientRect(); return r.right >= x0 && r.left <= x1 && r.bottom >= y0 && r.top <= y1; });
      S.sel = g.base.concat(hits.filter(o => g.base.indexOf(o) < 0));
    }
    paintSel();
  }
}
function eraseAt(e){
  const o = objAt(e.clientX, e.clientY);
  if (o && !isBox(o)){ if (!G.did){ snap(); G.did = true; } o.remove(); }
}

/* ── keyboard ── */
function onKey(e){
  if (!canvas || !canvas.isConnected) return;
  const ae = document.activeElement;
  if (ae && (ae.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) && !(ae === canvas && S.tool !== 'type')) { if (e.key === 'Escape' && ae.classList && ae.classList.contains('aw-fb')){ ae.blur(); } return; }
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
    snap(); S.sel.forEach(o => { if (isBox(o)){ o.style.left = (parseFloat(o.style.left) || 0) + dx + 'px'; o.style.top = (parseFloat(o.style.top) || 0) + dy + 'px'; } else { const t = T(o); t.x += dx; t.y += dy; setT(o, t); } }); changed();
  }
}
function del(){ if (!S.sel.length) return; snap(); S.sel.forEach(o => o.remove()); S.sel = []; changed(); }
function dup(){
  if (!S.sel.length) return; snap(); const out = [];
  S.sel.forEach(o => { const c = o.cloneNode(true); c.dataset.id = uid(); c.setAttribute('contenteditable', 'false'); if (isBox(o)){ c.style.left = (parseFloat(o.style.left) || 0) + 14 + 'px'; c.style.top = (parseFloat(o.style.top) || 0) + 14 + 'px'; o.parentNode.appendChild(c); } else { const t = T(o); t.x += 14; t.y += 14; o.parentNode.appendChild(c); setT(c, t); } out.push(c); });
  S.sel = out; changed();
}
function order(front){
  if (!S.sel.length) return; snap();
  S.sel.forEach(o => { const p = o.parentNode; if (front) p.appendChild(o); else p.insertBefore(o, p.firstChild); }); changed();
}

/* ── style: colours, fill, thickness (for the next object and the selection) ── */
function applyStyle(kind, v){
  const tgt = S.sel.length && S.tool === 'select';
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
      } else {
        if (kind === 'stroke') o.setAttribute('stroke', v);
        if (kind === 'fill' && o.dataset.k === 'shape' && o.getAttribute('fill') !== undefined){ o.setAttribute('fill', v); }
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
  const hasUndo = document.getElementById('flUndo'); if (hasUndo) hasUndo.disabled = !S.undo.length;
  const hasRedo = document.getElementById('flRedo'); if (hasRedo) hasRedo.disabled = !S.redo.length;
}
function setTool(t){
  if (S.tool === 'type' && t !== 'type'){ const a = document.activeElement; if (a && a.classList && a.classList.contains('aw-fb')) a.blur(); }
  S.tool = t; if (t !== 'select' && !(t === 'type' && S.sel.length === 1 && isBox(S.sel[0]))) S.sel = [];
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
    grp(['<label class="aw-tl-f">Thickness <input type="range" id="flW" min="1" max="20" step="1" value="3" style="width:90px"> <b id="flWv">3</b></label>'], 'Line') +
    grp([b('', 'id="flUndo"', TOOL_ICONS.undo, 'Undo drawing (Ctrl+Z)') + b('', 'id="flRedo"', TOOL_ICONS.redo, 'Redo drawing') + b('', 'data-fl-act="dup"', TOOL_ICONS.dup, 'Duplicate (Ctrl+D)') + b('', 'data-fl-act="del"', TOOL_ICONS.del, 'Delete (Del)') + b('', 'data-fl-act="front"', TOOL_ICONS.front, 'Bring to front') + b('', 'data-fl-act="back"', TOOL_ICONS.back, 'Send to back')], 'Arrange');
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
    const t = e.target; if (t.closest && (t.closest('.aw-fb') || t.closest('.aw-flsel') || t.closest('#tb') || t.closest('.aw-fpanel'))) return;
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
  [].forEach.call(tb.querySelectorAll('[data-fl-act]'), b => { b.onclick = () => ({ dup, del, front: () => order(true), back: () => order(false) })[b.dataset.flAct](); });
  [].forEach.call(tb.querySelectorAll('[data-fs]'), b => { b.onclick = () => applyStyle('stroke', b.dataset.fs); });
  [].forEach.call(tb.querySelectorAll('[data-ff]'), b => { b.onclick = () => applyStyle('fill', b.dataset.ff); });
  const cust = document.getElementById('flCust'); if (cust) cust.onchange = () => applyStyle('stroke', cust.value);
  const w = document.getElementById('flW'); if (w) w.oninput = () => applyStyle('w', +w.value);
  document.getElementById('flUndo').onclick = undo; document.getElementById('flRedo').onclick = redo;
  [].forEach.call(tb.querySelectorAll('.aw-fpanel-btn'), b => { b.onclick = () => { b.dataset.panel === 'shapes' ? openShapes() : openSyms(); setTimeout(() => [].forEach.call(tb.querySelectorAll('.aw-fpanel-btn'), x => x.classList.toggle('on', !!panels[x.dataset.panel] && panels[x.dataset.panel].isConnected)), 0); }; });
  syncStyleUI();
  setTimeout(fit, 50);
}
window.AWFree = { panelHtml, wire, tool: () => S.tool, setTool, fit, serialize, hydrate };
})();
