/**
 * Network: Snip as hardware. On one platform, your Cloudflare account: the
 * Worker as a three-unit rack server, D1 as a database drum, R2 as a storage
 * chassis with drive bays and KV as a small key unit. On the other, your
 * machine: a laptop running the capture agent. Dashed guides join them. The
 * pointer picks a part; the route from the laptop through the Worker to it
 * lights hop by hop, and a packet runs along it while the pointer stays. At
 * rest the Worker's top light is the bright mark. The slider is the time per
 * hop, in ms.
 *
 * The pattern: one of many, picked at each part's own rest height, so the
 * packet and the lit edges never change the choice.
 */
import { HL } from "./kernel.js";

const {
  Cam, bezier, circ, facing, fillet, fit, lerp, open, poly, proj, prism, rad, rings, ringAt, run, seg, unproj,
  disposer, mk, place, pointer, put, register, solid,
} = HL;

// [read-out, parent, x, y, half-width x, half-width y, height, kind]; the laptop is the root of every route
const PARTS = [
  ["laptop", -1, 70, 58, 13, 9, 3, "laptop"],
  ["Worker", 0, 0, 0, 14, 10, 21, "rack"],
  ["D1 · records", 1, -50, 2, 9, 9, 18, "drum"],
  ["R2 · files", 1, 0, -50, 12, 8, 14, "bays"],
  ["KV · tokens", 1, -48, -48, 6, 6, 9, "key"],
];
const UNIT = 7, LIDH = 15, LEAN = 16, EASE = bezier(0.32, 0.72, 0, 1);

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let step = value;
  const C = Cam(45, 0.5, 1.9);
  fit(C, [[-72, -72, -3], [96, 84, -3], [96, -72, -3], [-72, 84, -3], [0, 0, 24], [70, 49, LIDH + 4]], 200, 166);
  const P = proj(C), front = facing(C);
  const g = mk("g", {}, svg);
  const plate = (x0, y0, x1, y1) => { const [r, i] = rings(x0, y0, x1, y1, 7, 1.8); put(solid(g), prism(P, front, r, i, -3, 0)); };
  plate(-72, -72, 24, 24); // your Cloudflare account
  plate(42, 32, 96, 84); // your desk

  // the links, as guides on the ground under everything that stands
  const links = PARTS.map(([, p, x, y]) => (p < 0 ? null : mk("path", { d: seg(P(PARTS[p][2], PARTS[p][3], 0), P(x, y, 0)), class: "nf dash" }, g)));
  const hop = PARTS.map(function depth(q) { return q[1] < 0 ? 0 : 1 + depth(PARTS[q[1]]); });

  const parts = PARTS.map(([name, , x, y, hx, hy, h, kind], i) => ({ i, name, x, y, hx, hy, h, kind, sils: [] }))
    .sort((a, b) => a.x + a.y - (b.x + b.y));
  let topLed = null;
  for (const n of parts) {
    const { x, y, hx, hy, h } = n, x0 = x - hx, x1 = x + hx, y0 = y - hy, y1 = y + hy;
    const face = (pts, cls) => mk("path", { d: poly(fillet(pts, pts.map(() => 0.8), 3)), class: cls }, g);
    if (n.kind === "rack") {
      // three units stacked, each with a light and a vent on its front
      const [r, i] = rings(x0, y0, x1, y1, 2.4, 0.9);
      for (let u = 0; u < 3; u++) {
        const el = solid(g), z = u * UNIT, zc = z + UNIT / 2;
        put(el, prism(P, front, r, i, z + 0.6, z + UNIT));
        n.sils.push(el.sil);
        const led = mk("circle", { r: 1.1, class: u === 2 ? "dot" : "dot off" }, g);
        place(led, P(x0 + 4, y1, zc));
        if (u === 2) topLed = led;
        mk("path", { d: [-1, 1].map((d) => seg(P(x0 + 9, y1, zc + d), P(x1 - 4, y1, zc + d))).join(""), class: "nf lo" }, g);
      }
      continue;
    }
    if (n.kind === "drum") {
      // a database drum: a cylinder with two seams round its front
      const at = (R) => circ(R, 24).map((q) => ({ ...q, u: q.u + x, v: q.v + y }));
      const ring = at(hx), el = solid(g);
      put(el, prism(P, front, ring, at(hx - 1.2), 0, h));
      n.sils.push(el.sil);
      mk("path", { d: [h / 3, (2 * h) / 3].map((z) => open(ringAt(P, run(ring, front), z))).join(""), class: "nf lo" }, g);
      continue;
    }
    const [r, i] = rings(x0, y0, x1, y1, n.kind === "key" ? 2 : 2.4, 0.9), el = solid(g);
    put(el, prism(P, front, r, i, 0, h));
    n.sils.push(el.sil);
    if (n.kind === "bays") for (let b = 0; b < 4; b++) {
      // four drive bays across the front
      const wb = (2 * hx - 6) / 4, u0 = x0 + 3 + b * wb + 0.6, u1 = u0 + wb - 1.2;
      face([P(u0, y1, 2.5), P(u1, y1, 2.5), P(u1, y1, h - 2.5), P(u0, y1, h - 2.5)], "nf lo");
    }
    if (n.kind === "key") place(mk("circle", { r: 1.1, class: "dot off" }, g), P(x, y1, h / 2));
    if (n.kind === "laptop") {
      // keys on the base, and a lid leaning back from its far edge
      mk("path", { d: [-3, 0, 3].map((d) => seg(P(x0 + 4, y + d, h), P(x1 - 4, y + d, h))).join(""), class: "nf lo" }, g);
      const s = Math.sin(rad(LEAN)), c = Math.cos(rad(LEAN)), w = (u, v) => P(u, y0 + 1 - v * s, h + v * c);
      n.sils.push(face([w(x0 + 1, 0), w(x1 - 1, 0), w(x1 - 1, LIDH), w(x0 + 1, LIDH)], "sil"));
      face([w(x0 + 3, 2), w(x1 - 3, 2), w(x1 - 3, LIDH - 2), w(x0 + 3, LIDH - 2)], "nf lo");
    }
  }
  const byIndex = [];
  parts.forEach((n) => { byIndex[n.i] = n; });

  // the packet: a dot that runs the lit route, laptop first
  const packet = mk("circle", { r: 1.6, class: "dot" }, g);
  const show = (on) => { if (!on) packet.remove(); else if (!packet.isConnected) g.append(packet); };
  show(false);

  let act = -1, t0 = 0, route = [];
  const B = register(stage, (_dt, now) => {
    const lit = (i) => route.includes(i) && now >= t0 + hop[i] * step;
    for (const n of parts) {
      n.sils.forEach((el) => el.classList.toggle("hi", lit(n.i)));
      const l = links[n.i];
      if (l) { l.classList.toggle("dash", !lit(n.i)); l.classList.toggle("hi", lit(n.i)); }
    }
    if (route.length < 2) { show(false); return false; }
    // one lap: a hop per link, then a pause as long as one hop
    const hops = route.length - 1, lap = (hops + 1) * step, t = ((now - t0) % lap) / step;
    show(t < hops);
    if (t >= hops) return true;
    const k = Math.floor(t), a = byIndex[route[k]], b = byIndex[route[k + 1]], e = EASE(t - k);
    place(packet, P(lerp(a.x, b.x, e), lerp(a.y, b.y, e), 0));
    return true;
  });
  bag.add(B.unregister);

  // the hit test: the pointer at each part's own mid-height, against its resting footprint
  function pick([sx, sy]) {
    let best = -1, bd = 1.45;
    for (const n of parts) {
      const [wx, wy] = unproj(C, sx, sy, n.h / 2), d = Math.max(Math.abs(wx - n.x) / n.hx, Math.abs(wy - n.y) / n.hy);
      if (d < bd) { best = n.i; bd = d; }
    }
    return best;
  }

  function setActive(a) {
    if (a === act) return;
    act = a; t0 = performance.now(); route = [];
    for (let i = a; i >= 0; i = PARTS[i][1]) route.unshift(i);
    topLed.classList.toggle("off", a >= 0);
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
  means: "Your laptop and your Cloudflare servers: the route to the part under the pointer lights, and a packet runs it.",
  rules: [1, 4, 5, 6],
  range: [160, 280, 440],
  tour: [[208, 232], [122, 102], [260, 104], null],
  mount,
};
