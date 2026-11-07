/**
 * Network: Snip as hardware. In the middle, the Worker: a two-tier server with
 * a dial on its lid, a grille and vents. Behind it, a row of storage modules:
 * D1 with a drum on its lid, R2 with drive bays, KV with key lights. In front,
 * your desk: a plate holding the capture agent and the laptop it runs on.
 * Routed connectors run on the ground with joints at every bend. The pointer
 * picks a part; the route from the laptop to it lights hop by hop and a packet
 * rides it. Leader lines run out to the right for the page's labels. At rest
 * the Worker's dial is the bright mark. The slider is the time per hop, in ms.
 *
 * The pattern: one of many, picked at each part's own mid-height, so the
 * packet and the lit edges never change the choice.
 */
import { HL } from "./kernel.js";

const {
  Cam, bezier, circ, facing, fillet, fit, lerp, open, poly, proj, prism, rad, rings, ringAt, run, seg, unproj,
  disposer, mk, place, pointer, put, register, solid,
} = HL;

// [read-out, parent, x, y, half x, half y, height, route in from the parent as ground points]
const PARTS = [
  ["laptop", -1, 74, 10, 11, 8, 3, null],
  ["capture agent", 0, 74, -24, 7, 7, 11, [[74, 2], [74, -17]]],
  ["Worker", 1, 0, 0, 26, 26, 21, [[67, -24], [46, -24], [46, 0], [26, 0]]],
  ["D1 · records", 2, -76, -40, 8, 8, 13, [[-26, -12], [-42, -12], [-42, -40], [-68, -40]]],
  ["R2 · files", 2, -76, -14, 8, 8, 13, [[-26, 2], [-52, 2], [-52, -14], [-68, -14]]],
  ["KV · tokens", 2, -76, 12, 8, 8, 13, [[-26, 12], [-68, 12]]],
];
// [part, y]: where each leader line ends, in the viewBox; the page sets its labels there
export const LEADS = [[3, 70], [2, 112], [0, 236]];
const LIDH = 13, LEAN = 16, EASE = bezier(0.32, 0.72, 0, 1);

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let step = value;
  const C = Cam(45, 0.5, 1.4);
  fit(C, [[-88, -52, 0], [92, 32, 0], [92, -52, 0], [-88, 32, 0], [0, 0, 22], [74, 2, LIDH + 4]], 184, 170);
  const P = proj(C), front = facing(C);
  const g = mk("g", {}, svg);
  const face = (pts, cls, r = 0.8) => mk("path", { d: poly(fillet(pts, pts.map(() => r), 3)), class: cls }, g);
  const dot = (pt, cls, r = 1.1) => place(mk("circle", { r, class: cls }, g), pt);

  // a faint grid on the ground, under everything
  const grid = [];
  for (let v = -60; v <= 40; v += 20) grid.push(seg(P(-100, v, 0), P(100, v, 0)));
  for (let u = -100; u <= 100; u += 20) grid.push(seg(P(u, -60, 0), P(u, 40, 0)));
  mk("path", { d: grid.join(""), class: "nf lo dash" }, g);

  // the routes: polylines on the ground, a joint at every bend
  const links = PARTS.map(([, , , , , , , pts]) => {
    if (!pts) return null;
    const el = mk("path", { d: open(pts.map(([x, y]) => P(x, y, 0))), class: "nf" }, g);
    pts.slice(1, -1).forEach(([x, y]) => dot(P(x, y, 0), "dot m", 1.2));
    return el;
  });
  const hop = PARTS.map(function depth(q) { return q[1] < 0 ? 0 : 1 + depth(PARTS[q[1]]); });
  const sils = PARTS.map(() => []);
  const box = (i, x0, y0, x1, y1, z0, z1, r = 2.4) => {
    const [ring, inner] = rings(x0, y0, x1, y1, r, 0.9), el = solid(g);
    put(el, prism(P, front, ring, inner, z0, z1));
    if (i >= 0) sils[i].push(el.sil);
  };

  // the storage row, back to front
  for (const i of [3, 4, 5]) {
    const [, , x, y, hx, hy, h] = PARTS[i], x1 = x + hx, y1 = y + hy;
    box(i, x - hx, y - hy, x1, y1, 0, h);
    dot(P(x1, y - 4, h - 3), "dot off"); dot(P(x1, y + 4, h - 3), "dot off");
    if (i === 3) {
      // D1: a drum on the lid
      const at = (R) => circ(R, 20).map((q) => ({ ...q, u: q.u + x, v: q.v + y }));
      const el = solid(g), ring = at(4.5);
      put(el, prism(P, front, ring, at(3.6), h, h + 4));
      mk("path", { d: open(ringAt(P, run(ring, front), h + 2)), class: "nf lo" }, g);
    }
    if (i === 4) for (let b = 0; b < 3; b++) face([P(x1, y - 5 + b * 3.6, 2), P(x1, y - 3 + b * 3.6, 2), P(x1, y - 3 + b * 3.6, h - 6), P(x1, y - 5 + b * 3.6, h - 6)], "nf lo", 0.5);
    if (i === 5) face([P(x1, y - 3, 3), P(x1, y + 3, 3), P(x1, y + 3, 6), P(x1, y - 3, 6)], "nf lo", 0.6);
  }

  // the Worker: a slab, a body, a dial on the lid, a grille and vents
  box(2, -26, -26, 26, 26, 0, 5, 6);
  box(2, -21, -21, 21, 21, 6, 21, 5);
  [-14, 14].forEach((v) => { dot(P(26, v, 2.5), "dot off"); dot(P(v, 26, 2.5), "dot off"); });
  const lidRing = (R) => poly(ringAt(P, circ(R, 32), 21));
  mk("path", { d: lidRing(14), class: "nf" }, g);
  const dial = mk("path", { d: lidRing(9.5), class: "nf hi" }, g);
  mk("path", { d: lidRing(3), class: "nf" }, g);
  face([P(-14, 21, 9), P(-2, 21, 9), P(-2, 21, 17), P(-14, 21, 17)], "nf");
  mk("path", { d: [-12, -10, -8, -6, -4].map((x) => seg(P(x, 21, 10.5), P(x, 21, 15.5))).join(""), class: "nf lo" }, g);
  dot(P(8, 21, 13), "dot m", 1.4);
  face([P(21, -12, 10), P(21, 10, 10), P(21, 10, 16), P(21, -12, 16)], "nf");
  mk("path", { d: [-8, -4, 0, 4].map((y) => seg(P(21, y, 11.5), P(21, y + 2, 14.5))).join(""), class: "nf lo" }, g);

  // your desk: a plate, the capture agent and the laptop
  box(-1, 60, -38, 88, 26, 0, 3, 5);
  const [, , ax, ay, ah, , aH] = PARTS[1];
  box(1, ax - ah, ay - ah, ax + ah, ay + ah, 3, 3 + aH);
  for (let k = 0; k < 6; k++) dot(P(ax - 3 + (k % 3) * 3, ay - 1.5 + Math.floor(k / 3) * 3, 3 + aH), "dot m", 0.8);
  const [, , lx, ly, lhx, lhy, lh] = PARTS[0], lz = 3 + lh, s = Math.sin(rad(LEAN)), c = Math.cos(rad(LEAN));
  box(0, lx - lhx, ly - lhy, lx + lhx, ly + lhy, 3, lz);
  mk("path", { d: [-3, 0, 3].map((d) => seg(P(lx - lhx + 3, ly + d, lz), P(lx + lhx - 3, ly + d, lz))).join(""), class: "nf lo" }, g);
  const w = (u, v) => P(u, ly - lhy + 1 - v * s, lz + v * c);
  sils[0].push(face([w(lx - lhx + 1, 0), w(lx + lhx - 1, 0), w(lx + lhx - 1, LIDH), w(lx - lhx + 1, LIDH)], "sil", 1.4));
  face([w(lx - lhx + 3, 2), w(lx + lhx - 3, 2), w(lx + lhx - 3, LIDH - 2), w(lx - lhx + 3, LIDH - 2)], "nf lo");

  // leader lines out to the labels: up or down from the part, then across
  const anchor = (i) => { const [, , x, y, hx, hy, h] = PARTS[i]; return P(x + hx * 0.4, y - hy * 0.4, h + (i === 0 ? LIDH : 0)); };
  mk("path", { d: LEADS.map(([i, y]) => { const a = anchor(i); return open([a, [a[0], y], [344, y]]); }).join(""), class: "nf lo" }, g);
  LEADS.forEach(([i]) => dot(anchor(i), "dot m", 1.2));

  // the packet rides the lit route, laptop first
  const packet = mk("circle", { r: 1.8, class: "dot" }, g);
  const show = (on) => { if (!on) packet.remove(); else if (!packet.isConnected) g.append(packet); };
  show(false);
  const along = (pts, t) => {
    const len = pts.slice(1).map((p, k) => Math.hypot(p[0] - pts[k][0], p[1] - pts[k][1]));
    let d = t * len.reduce((a, b) => a + b, 0), k = 0;
    while (k < len.length - 1 && d > len[k]) d -= len[k++];
    const f = len[k] ? d / len[k] : 0;
    return [lerp(pts[k][0], pts[k + 1][0], f), lerp(pts[k][1], pts[k + 1][1], f)];
  };

  let act = -1, t0 = 0, route = [];
  const B = register(stage, (_dt, now) => {
    const lit = (i) => route.includes(i) && now >= t0 + hop[i] * step;
    PARTS.forEach((_, i) => {
      sils[i].forEach((el) => el.classList.toggle("hi", lit(i)));
      if (links[i]) links[i].classList.toggle("hi", lit(i));
    });
    if (route.length < 2) { show(false); return false; }
    // one lap: a hop per link, then a pause as long as one hop
    const hops = route.length - 1, t = ((now - t0) % ((hops + 1) * step)) / step;
    show(t < hops);
    if (t >= hops) return true;
    const k = Math.floor(t), [x, y] = along(PARTS[route[k + 1]][7], EASE(t - k));
    place(packet, P(x, y, 0));
    return true;
  });
  bag.add(B.unregister);

  // the hit test: the pointer at each part's own mid-height, against its resting footprint
  function pick([sx, sy]) {
    let best = -1, bd = 1.3;
    PARTS.forEach(([, , x, y, hx, hy, h], i) => {
      const [wx, wy] = unproj(C, sx, sy, h / 2 + (i < 2 ? 3 : 0)), d = Math.max(Math.abs(wx - x) / hx, Math.abs(wy - y) / hy);
      if (d < bd) { best = i; bd = d; }
    });
    return best;
  }

  function setActive(a) {
    if (a === act) return;
    act = a; t0 = performance.now(); route = [];
    for (let i = a; i >= 0; i = PARTS[i][1]) route.unshift(i);
    dial.classList.toggle("hi", a < 0);
    read.textContent = a < 0 ? "rest" : PARTS[a][0];
    B.wake();
  }
  setActive(-2);
  setActive(-1);

  bag.add(pointer(stage, { move: (p) => setActive(pick(p)), leave: () => setActive(-1) }));
  bag.add(() => svg.replaceChildren());

  return { set: (v) => { step = v; B.wake(); }, destroy: bag.dispose };
}

/** The figure, as the hairline-create skill declares it; guide-page.tsx mounts it. */
export const network = {
  name: "network",
  means: "Your Mac and the Worker it runs, with its stores: the route to the part under the pointer lights, and a packet rides it.",
  rules: [1, 4, 5, 6],
  range: [160, 280, 440],
  tour: [[235, 210], [85, 134], [135, 109], null],
  mount,
};
