// Samples the Minor Planet Center's orbit catalogs into the atlas's
// small-body populations: the real asteroid belt, the Jupiter Trojans, the
// Hildas, and the Kuiper belt — plus Halley from the comet file.
//
// Source: MPCORB.DAT (https://www.minorplanetcenter.net/iau/MPCORB/) —
// 1.5M+ minor planets with full osculating elements. Sampling is by
// absolute magnitude H (brightest first), which is the honest proxy for
// size: the bodies you get are the largest real members of each family.
//
// Per body the output packs everything the GPU Kepler solver needs:
//   f32 ×3  A — semi-major axis vector (scene meters, perihelion dir × a)
//   f32 ×3  B — semi-minor axis vector (scene meters)
//   f32     e — eccentricity (ellipse center = −e·A from the focus)
//   f32     M0 — mean anomaly at J2000, radians
//   f32     n — mean motion, radians/day
//   f32     s — sprite scale hint from H (bigger rock, brighter point)
//   = 40 bytes. The vertex shader solves E − e·sinE = M per frame.
//
// Usage: node scripts/generate-smallbodies.mjs path/to/MPCORB.DAT
// Writes: public/smallbodies.bin + prints population counts.

import { readFileSync, writeFileSync } from 'node:fs';

const AU_M = 1.496e11;
const DEG = Math.PI / 180;
const J2000_JD = 2451545.0;

const POP = [
  { name: 'belt', take: 30000, match: (a, e, i) => a > 1.78 && a < 3.6 && e < 0.4 },
  { name: 'trojan', take: 4000, match: (a) => a > 4.8 && a < 5.4 },
  { name: 'hilda', take: 2000, match: (a) => a >= 3.7 && a <= 4.2 },
  // H < 0 excludes exactly one object: Pluto, already a planet target.
  { name: 'kuiper', take: 4000, match: (a, e, i, H) => a > 30 && a < 55 && H > 0 },
];

// Packed MPC epoch: century letter (I=18, J=19, K=20), 2-digit year, then
// month and day in 1–9 A–V.
const pk = (c) => (c >= '0' && c <= '9' ? +c : c.charCodeAt(0) - 55);
function epochJD(p) {
  const century = { I: 18, J: 19, K: 20 }[p[0]];
  const year = century * 100 + +p.slice(1, 3);
  const month = pk(p[3]);
  const day = pk(p[4]);
  // Meeus: JD at 0h UT.
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return (
    day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045 -
    0.5
  );
}

const lines = readFileSync(process.argv[2], 'utf8').split('\n');
let start = 0;
while (start < lines.length && !lines[start].startsWith('----------')) start++;
start++;

const pops = POP.map(() => []);
for (let li = start; li < lines.length; li++) {
  const L = lines[li];
  if (L.length < 104) continue;
  const H = parseFloat(L.slice(8, 13));
  const M0 = parseFloat(L.slice(26, 35));
  const w = parseFloat(L.slice(37, 46)); // argument of perihelion
  const node = parseFloat(L.slice(48, 57));
  const inc = parseFloat(L.slice(59, 68));
  const e = parseFloat(L.slice(70, 79));
  const n = parseFloat(L.slice(80, 91)); // deg/day
  const a = parseFloat(L.slice(92, 103));
  if (![H, M0, w, node, inc, e, n, a].every(Number.isFinite)) continue;
  if (e >= 0.95) continue; // the GPU solver's Newton iterations want e < ~0.9
  for (let p = 0; p < POP.length; p++) {
    if (!POP[p].match(a, e, inc, H)) continue;
    pops[p].push({ H, M0, w, node, inc, e, n, a, ep: L.slice(20, 25) });
    break;
  }
}

const out = [];
for (let p = 0; p < POP.length; p++) {
  pops[p].sort((x, y) => x.H - y.H); // brightest (largest) first
  const take = pops[p].slice(0, POP[p].take);
  console.log(`${POP[p].name}: ${take.length} of ${pops[p].length} (H ${take[0]?.H} .. ${take[take.length - 1]?.H})`);
  for (const b of take) {
    // Ellipse basis in scene coordinates (same math as keplerEllipse).
    const aM = b.a * AU_M;
    const bM = aM * Math.sqrt(1 - b.e * b.e);
    const i = b.inc * DEG,
      node = b.node * DEG,
      w = b.w * DEG;
    const cw = Math.cos(w),
      sw = Math.sin(w),
      cn = Math.cos(node),
      sn = Math.sin(node),
      ci = Math.cos(i),
      si = Math.sin(i);
    const toScene = (xp, yp) => {
      const xe = (cw * cn - sw * sn * ci) * xp + (-sw * cn - cw * sn * ci) * yp;
      const ye = (cw * sn + sw * cn * ci) * xp + (-sw * sn + cw * cn * ci) * yp;
      const ze = sw * si * xp + cw * si * yp;
      return [xe, ze, -ye];
    };
    const A = toScene(aM, 0);
    const B = toScene(0, bM);
    // Mean anomaly rebased to J2000 so the shader's clock is uniform.
    const M0J = (b.M0 - b.n * (epochJD(b.ep) - J2000_JD)) * DEG;
    out.push({ A, B, e: b.e, M0: ((M0J % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), n: b.n * DEG, H: b.H, pop: p });
  }
}

const buf = new ArrayBuffer(out.length * 40 + 4 * (1 + POP.length));
const view = new DataView(buf);
// Tiny header: body count, then per-population counts (draw groups).
view.setUint32(0, out.length, true);
POP.forEach((p, i) => view.setUint32(4 + i * 4, out.filter((b) => b.pop === i).length, true));
let o = 4 * (1 + POP.length);
for (const b of out) {
  view.setFloat32(o, b.A[0], true);
  view.setFloat32(o + 4, b.A[1], true);
  view.setFloat32(o + 8, b.A[2], true);
  view.setFloat32(o + 12, b.B[0], true);
  view.setFloat32(o + 16, b.B[1], true);
  view.setFloat32(o + 20, b.B[2], true);
  view.setFloat32(o + 24, b.e, true);
  view.setFloat32(o + 28, b.M0, true);
  view.setFloat32(o + 32, b.n, true);
  view.setFloat32(o + 36, b.H, true);
  o += 40;
}
writeFileSync('public/smallbodies.bin', Buffer.from(buf));
console.log(`wrote ${out.length} bodies (${(buf.byteLength / 1e6).toFixed(1)} MB)`);
