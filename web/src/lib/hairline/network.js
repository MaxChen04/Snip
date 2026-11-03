/**
 * Network: Snip's systems as a hub and its branches. The Worker sits in the
 * middle; D1, R2 and KV each hold their records on a branch, and the last
 * branch runs to the capture agent and the laptop it runs on. Links are
 * dashed guides on the ground. The pointer picks a tile; the route from the
 * Worker out to it lights hop by hop, each tile rising as its hop arrives.
 * At rest the Worker's inner rim is the bright mark. The slider is the wait
 * per hop, in ms.
 *
 * The pattern: one of many, picked on the ground plane at each tile's rest
 * footprint, so a tile rising never changes the choice.
 */
import { HL } from "./kernel.js";

const {
  Cam, fillet, fit, poly, proj, prism, rad, rings, seg, unproj, facing,
  tween, tset, tval, tdone, disposer, mk, place, pointer, put, register, solid,
} = HL;

// [name, parent, x, y, kind]: kind is "hub", "store" (numbered with dots), "leaf" or "laptop"
const NODES = [
  ["Worker", -1, 0, 0, "hub"],
  ["D1", 0, -44, 4, "store"], ["D1 · refs", 1, -70, -6, "leaf"], ["D1 · pages", 1, -70, 20, "leaf"], ["D1 · collections", 3, -96, 12, "leaf"],
  ["R2", 0, 4, -44, "store"], ["R2 · shots", 5, -8, -70, "leaf"], ["R2 · gifs", 5, 20, -72, "leaf"], ["R2 · snapshots", 7, 12, -98, "leaf"],
  ["KV", 0, -2, 44, "store"], ["KV · tokens", 9, 6, 70, "leaf"],
  ["capture agent", 0, 46, 2, "leaf"], ["machine", 11, 74, 12, "laptop"],
];
const T = 8, HUB = 16, TH = 3, HH = 6, LIFT = 7, LIDH = 12, LEAN = 16;

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let step = value;

  const C = Cam(45, 0.5, 1.72);
  fit(C, [[-106, -108, 0], [86, 80, 0], [86, -108, 0], [-106, 80, 0], [-96, 12, TH + LIFT], [74, 4, LIFT + LIDH + 4]], 200, 166);
  const P = proj(C), front = facing(C);
  const g = mk("g", {}, svg);

  // the links: dashed guides on the ground, painted before every plate
  const links = NODES.map(([, p, x, y]) => (p < 0 ? null : mk("path", { d: seg(P(NODES[p][2], NODES[p][3], 0), P(x, y, 0)), class: "nf dash" }, g)));

  // the hop count of each node from the Worker
  const hop = NODES.map(function depth(n, i) { return n[1] < 0 ? 0 : 1 + depth(NODES[n[1]], n[1]); });

  // the plates, nearest last
  const nodes = NODES.map(([name, , x, y, kind], i) => {
    const h = kind === "hub" ? HUB : T;
    const [ring, inner] = rings(x - h, y - h, x + h, y + h, kind === "hub" ? 6 : 3.2, kind === "hub" ? 1.6 : 1);
    return { i, name, x, y, kind, ring, inner, z: tween(0), drawn: NaN };
  }).sort((a, b) => a.x + a.y - (b.x + b.y));
  for (const n of nodes) {
    n.el = solid(g);
    if (n.kind === "hub") n.rim = mk("path", { class: "nf hi" }, g);
    if (n.kind === "store") n.dots = Array.from({ length: NODES.slice(0, n.i + 1).filter((m) => m[4] === "store").length }, () => mk("circle", { r: 1.1, class: "dot m" }, g));
    if (n.kind === "laptop") { n.keys = mk("path", { class: "nf lo" }, g); n.lid = mk("path", { class: "sil" }, g); n.screen = mk("path", { class: "nf lo" }, g); }
  }
  const byIndex = [];
  nodes.forEach((n) => { byIndex[n.i] = n; });

  const s = Math.sin(rad(LEAN)), c = Math.cos(rad(LEAN));
  function drawNode(n, z) {
    if (z === n.drawn) return;
    n.drawn = z;
    const top = z + (n.kind === "hub" ? HH : TH);
    put(n.el, prism(P, front, n.ring, n.inner, z, top));
    if (n.rim) n.rim.setAttribute("d", poly(n.inner.map((q) => P(q.u, q.v, top))));
    if (n.dots) n.dots.forEach((el, k) => place(el, P(n.x + (k - (n.dots.length - 1) / 2) * 4, n.y, top)));
    if (n.keys) {
      const { x, y } = n, w = (u, v) => P(u, y - T + 1 - v * s, top + v * c);
      n.keys.setAttribute("d", [-2, 2, 5].map((dy) => seg(P(x - 5, y + dy, top), P(x + 5, y + dy, top))).join(""));
      n.lid.setAttribute("d", poly(fillet([w(x - 7, 0), w(x + 7, 0), w(x + 7, LIDH), w(x - 7, LIDH)], [0.6, 0.6, 1.6, 1.6], 3)));
      n.screen.setAttribute("d", poly(fillet([w(x - 5.2, 1.6), w(x + 5.2, 1.6), w(x + 5.2, LIDH - 1.6), w(x - 5.2, LIDH - 1.6)], [0.6, 0.6, 0.8, 0.8], 3)));
    }
  }

  let act = -1, t0 = 0, path = new Set();
  /** Lights every node on the route whose hop has arrived; returns whether one is still waiting. */
  function light(now) {
    let waiting = false;
    for (const n of nodes) {
      const on = path.has(n.i) && now >= t0 + hop[n.i] * step;
      if (path.has(n.i) && !on) waiting = true;
      n.el.sil.classList.toggle("hi", on);
      if (n.lid) n.lid.classList.toggle("hi", on);
      const l = links[n.i];
      if (l) { l.classList.toggle("dash", !on); l.classList.toggle("hi", on); }
    }
    return waiting;
  }

  const B = register(stage, (_dt, now) => {
    let moving = light(now);
    for (const n of nodes) { drawNode(n, tval(n.z, now)); if (!tdone(n.z, now)) moving = true; }
    return moving;
  });
  bag.add(B.unregister);

  // the hit test: the pointer on the ground, against each tile's resting footprint
  function pick([sx, sy]) {
    const [wx, wy] = unproj(C, sx, sy, 0);
    let best = -1, bd = Infinity;
    for (const n of nodes) {
      const r = n.kind === "hub" ? HUB + 2 : T + 3, d = Math.max(Math.abs(wx - n.x), Math.abs(wy - n.y));
      if (d <= r && d < bd) { best = n.i; bd = d; }
    }
    return best;
  }

  function setActive(a) {
    if (a === act) return;
    act = a; t0 = performance.now(); path = new Set();
    for (let i = a; i >= 0; i = NODES[i][1]) path.add(i);
    for (const n of nodes) tset(n.z, path.has(n.i) ? LIFT : 0, t0, path.has(n.i) ? hop[n.i] * step : 0);
    byIndex[0].rim.classList.toggle("hi", a < 0);
    read.textContent = a < 0 ? "rest" : NODES[a][0];
    B.wake();
  }
  setActive(-2);
  setActive(-1);

  bag.add(pointer(stage, { move: (p) => setActive(pick(p)), leave: () => setActive(-1) }));
  bag.add(() => svg.replaceChildren());

  return { set: (v) => { step = v; }, destroy: bag.dispose };
}

/** The figure, as the hairline-create skill declares it; guide-page.tsx mounts it. */
export const network = {
  name: "network",
  means: "Snip's systems around the Worker: the route to the part under the pointer lights hop by hop.",
  rules: [1, 2, 4, 6],
  range: [40, 90, 160],
  tour: [[110, 130], [258, 236], [290, 150], null],
  mount,
};
