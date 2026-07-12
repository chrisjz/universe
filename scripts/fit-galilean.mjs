// Fits Standish-layout Keplerian elements for the Galilean moons from JPL
// Horizons state vectors: jovicentric ecliptic-J2000 osculating elements
// sampled across decades, then a/e/i as means and L, ϖ, Ω as linear fits
// (Jupiter's J2 precesses Io's node at ~0.13°/day — a fixed ellipse would
// drift off within weeks; linear precession captures it to a few 1000 km).
// The residual Laplace-plane wobble (≤0.5° for Europa) is accepted: it is
// well under a Jupiter radius, so even shadow geometry stays honest.
//
// Usage: node scripts/fit-galilean.mjs
// Prints GALILEAN_ELEMENTS rows for src/ephemeris.ts plus held-out
// verification errors (fit uses every other sample; verify uses the rest).

import { execFileSync } from 'node:child_process';

const GM_JUP = 1.26686534e8; // km³/s², Jupiter system
const AU_KM = 1.495978707e8;
const DEG = 180 / Math.PI;
const MOONS = [
  ['io', '501'],
  ['europa', '502'],
  ['ganymede', '503'],
  ['callisto', '504'],
];

const curl = (url) => execFileSync('curl', ['-s', '--max-time', '120', url], { encoding: 'utf8' });

// State vector -> osculating elements (ecliptic J2000, angles in degrees).
function rvToElements(r, v) {
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => Math.hypot(...a);
  const h = cross(r, v);
  const nvec = [-h[1], h[0], 0]; // ẑ × h
  const rl = norm(r);
  const vl2 = dot(v, v);
  const evec = [0, 1, 2].map((k) => (vl2 / GM_JUP - 1 / rl) * r[k] - (dot(r, v) / GM_JUP) * v[k]);
  const e = norm(evec);
  const a = 1 / (2 / rl - vl2 / GM_JUP);
  const i = Math.acos(h[2] / norm(h));
  let node = Math.acos(nvec[0] / norm(nvec));
  if (nvec[1] < 0) node = 2 * Math.PI - node;
  let argp = Math.acos(dot(nvec, evec) / (norm(nvec) * e));
  if (evec[2] < 0) argp = 2 * Math.PI - argp;
  let nu = Math.acos(dot(evec, r) / (e * rl));
  if (dot(r, v) < 0) nu = 2 * Math.PI - nu;
  const E = 2 * Math.atan(Math.tan(nu / 2) * Math.sqrt((1 - e) / (1 + e)));
  const M = E - e * Math.sin(E);
  return { a, e, i: i * DEG, node: node * DEG, peri: (node + argp) * DEG, L: (node + argp) * DEG + M * DEG };
}

// Unwrapped linear fit y = y0 + rate·T (T in centuries from J2000).
function linfit(T, Y) {
  const n = T.length;
  let st = 0,
    sy = 0,
    stt = 0,
    sty = 0;
  for (let k = 0; k < n; k++) {
    st += T[k];
    sy += Y[k];
    stt += T[k] * T[k];
    sty += T[k] * Y[k];
  }
  const rate = (n * sty - st * sy) / (n * stt - st * st);
  return [(sy - rate * st) / n, rate];
}
const unwrap = (Y, rateGuess, T) => {
  // Angles circulate fast (Io's L: ~200°/day). Unwrap SEQUENTIALLY — each
  // sample predicted from the previous one — so a small rate-guess error
  // only has one step to grow in, not the whole 60-year span.
  const out = [Y[0]];
  for (let k = 1; k < Y.length; k++) {
    const pred = out[k - 1] + rateGuess * (T[k] - T[k - 1]);
    out.push(Y[k] + 360 * Math.round((pred - Y[k]) / 360));
  }
  return out;
};

const J2000_JD = 2451545.0;
const rows = {};
for (const [name, id] of MOONS) {
  const url =
    `https://ssd.jpl.nasa.gov/api/horizons.api?format=text&COMMAND='${id}'` +
    `&OBJ_DATA=NO&MAKE_EPHEM=YES&EPHEM_TYPE=VECTORS&CENTER='500@599'&REF_PLANE=ECLIPTIC` +
    `&OUT_UNITS='KM-S'&VEC_TABLE=2&CSV_FORMAT=YES&START_TIME='1990-01-01'&STOP_TIME='2050-01-01'&STEP_SIZE='400'`;
  const text = curl(url);
  const body = text.split('$$SOE')[1]?.split('$$EOE')[0];
  if (!body) {
    console.error(`${name}: bad Horizons response\n${text.slice(0, 300)}`);
    process.exit(1);
  }
  const samples = body
    .trim()
    .split('\n')
    .map((line) => {
      const c = line.split(',').map((s) => parseFloat(s));
      // CSV: JDTDB, date, x, y, z, vx, vy, vz
      return { T: (c[0] - J2000_JD - 69.184 / 86400) / 36525, r: [c[2], c[3], c[4]], v: [c[5], c[6], c[7]] };
    })
    .filter((s) => Number.isFinite(s.r[0]));
  const fit = samples.filter((_, k) => k % 2 === 0);
  const hold = samples.filter((_, k) => k % 2 === 1);

  const els = fit.map((s) => ({ T: s.T, ...rvToElements(s.r, s.v) }));
  const mean = (f) => els.reduce((acc, x) => acc + f(x), 0) / els.length;
  const a = mean((x) => x.a) / AU_KM;
  const e = mean((x) => x.e);
  const inc = mean((x) => x.i);
  const Ts = els.map((x) => x.T);
  // Rate guesses: n from two-body a; node/apse start at 0.
  const nGuess =
    ((Math.sqrt(
      GM_JUP /
        Math.pow(
          mean((x) => x.a),
          3,
        ),
    ) *
      86400 *
      DEG) /
      1) *
    36525;
  const [L0, Ldot] = linfit(
    Ts,
    unwrap(
      els.map((x) => x.L),
      nGuess,
      Ts,
    ),
  );
  const [p0, pdot] = linfit(
    Ts,
    unwrap(
      els.map((x) => x.peri),
      0,
      Ts,
    ),
  );
  const [n0, ndot] = linfit(
    Ts,
    unwrap(
      els.map((x) => x.node),
      0,
      Ts,
    ),
  );
  rows[name] = [a, 0, e, 0, inc, 0, L0, Ldot, p0, pdot, n0, ndot];

  // Held-out verification with the exact solver ephemeris.ts uses.
  let worstKm = 0;
  for (const s of hold) {
    const el = rows[name];
    const T = s.T;
    const i2 = (el[4] / DEG) * 1;
    const L = el[6] + el[7] * T;
    const peri = el[8] + el[9] * T;
    const node = (el[10] + el[11] * T) / DEG;
    const w = (peri - (el[10] + el[11] * T)) / DEG;
    let M = ((L - peri) % 360) / DEG;
    let E = M + el[2] * Math.sin(M);
    for (let k = 0; k < 12; k++) E += (M - (E - el[2] * Math.sin(E))) / (1 - el[2] * Math.cos(E));
    const xp = el[0] * AU_KM * (Math.cos(E) - el[2]);
    const yp = el[0] * AU_KM * Math.sqrt(1 - el[2] * el[2]) * Math.sin(E);
    const cw = Math.cos(w),
      sw = Math.sin(w),
      cn = Math.cos(node),
      sn = Math.sin(node),
      ci = Math.cos(i2),
      si = Math.sin(i2);
    const x = (cw * cn - sw * sn * ci) * xp + (-sw * cn - cw * sn * ci) * yp;
    const y = (cw * sn + sw * cn * ci) * xp + (-sw * sn + cw * cn * ci) * yp;
    const z = sw * si * xp + cw * si * yp;
    const err = Math.hypot(x - s.r[0], y - s.r[1], z - s.r[2]);
    worstKm = Math.max(worstKm, err);
  }
  console.log(
    `${name.padEnd(9)} a ${(a * AU_KM).toFixed(0)} km  e ${e.toFixed(4)}  i ${inc.toFixed(2)}°  ` +
      `node rate ${(ndot / 36525).toFixed(4)}°/d  worst held-out error ${worstKm.toFixed(0)} km`,
  );
}

console.log('\n// GALILEAN_ELEMENTS for src/ephemeris.ts (Standish layout, jovicentric ecliptic J2000):');
for (const [name] of MOONS) {
  console.log(`  ${name}: [${rows[name].map((v) => Number(v.toPrecision(12))).join(', ')}],`);
}
