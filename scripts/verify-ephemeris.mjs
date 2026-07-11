// Verifies the Keplerian planet ephemeris (src/ephemeris.ts elements)
// against JPL Horizons heliocentric ecliptic state vectors.
//
// Usage: node scripts/verify-ephemeris.mjs
// Queries Horizons (VECTORS, center = sun, ecliptic J2000) at three epochs
// and reports the angular + radial error of our Kepler solution. The
// Standish 1800–2050 table is good to arcminutes; we assert < 0.2°.

import { execFileSync } from 'node:child_process';

const DEG = Math.PI / 180;
const AU_KM = 1.495978707e8;

// Keep in sync with src/ephemeris.ts (duplicated: scripts are plain node).
// prettier-ignore
const ELEMENTS = {
  mercury: [0.38709927, 0.00000037, 0.20563593, 0.00001906, 7.00497902, -0.00594749, 252.25032350, 149472.67411175, 77.45779628, 0.16047689, 48.33076593, -0.12534081],
  venus: [0.72333566, 0.00000390, 0.00677672, -0.00004107, 3.39467605, -0.00078890, 181.97909950, 58517.81538729, 131.60246718, 0.00268329, 76.67984255, -0.27769418],
  earth: [1.00000261, 0.00000562, 0.01671123, -0.00004392, -0.00001531, -0.01294668, 100.46457166, 35999.37244981, 102.93768193, 0.32327364, 0.0, 0.0],
  mars: [1.52371034, 0.00001847, 0.09339410, 0.00007882, 1.84969142, -0.00813131, -4.55343205, 19140.30268499, -23.94362959, 0.44441088, 49.55953891, -0.29257343],
  jupiter: [5.20288700, -0.00011607, 0.04838624, -0.00013253, 1.30439695, -0.00183714, 34.39644051, 3034.74612775, 14.72847983, 0.21252668, 100.47390909, 0.20469106],
  saturn: [9.53667594, -0.00125060, 0.05386179, -0.00050991, 2.48599187, 0.00193609, 49.95424423, 1222.49362201, 92.59887831, -0.41897216, 113.66242448, -0.28867794],
  uranus: [19.18916464, -0.00196176, 0.04725744, -0.00004397, 0.77263783, -0.00242939, 313.23810451, 428.48202785, 170.95427630, 0.40805281, 74.01692503, 0.04240589],
  neptune: [30.06992276, 0.00026291, 0.00859048, 0.00005105, 1.77004347, 0.00035372, -55.12002969, 218.45945325, 44.96476227, -0.32241464, 131.78422574, -0.00508664],
  pluto: [39.48211675, -0.00031596, 0.24882730, 0.00005170, 17.14001206, 0.00004818, 238.92903833, 145.20780515, 224.06891629, -0.04062942, 110.30393684, -0.01183482],
};
const HORIZONS_ID = {
  mercury: '199',
  venus: '299',
  earth: '3',
  mars: '499',
  jupiter: '599',
  saturn: '699',
  uranus: '799',
  neptune: '899',
  pluto: '999',
};

function keplerEcliptic(el, T) {
  const [a0, aDot, e0, eDot, i0, iDot, L0, LDot, p0, pDot, n0, nDot] = el;
  const a = a0 + aDot * T;
  const e = e0 + eDot * T;
  const i = (i0 + iDot * T) * DEG;
  const L = L0 + LDot * T;
  const peri = p0 + pDot * T;
  const node = (n0 + nDot * T) * DEG;
  const w = (peri - (n0 + nDot * T)) * DEG;
  let M = ((L - peri) % 360) * DEG;
  if (M > Math.PI) M -= 2 * Math.PI;
  if (M < -Math.PI) M += 2 * Math.PI;
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 10; k++) E += (M - (E - e * Math.sin(E))) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w),
    sw = Math.sin(w),
    cn = Math.cos(node),
    sn = Math.sin(node),
    ci = Math.cos(i),
    si = Math.sin(i);
  return [
    (cw * cn - sw * sn * ci) * xp + (-sw * cn - cw * sn * ci) * yp,
    (cw * sn + sw * cn * ci) * xp + (-sw * sn + cw * cn * ci) * yp,
    sw * si * xp + cw * si * yp,
  ];
}

const jd = (iso) => new Date(iso).getTime() / 86400000 + 2440587.5;
const EPOCHS = ['2000-01-01T12:00:00Z', '2026-07-11T00:00:00Z', '2049-01-01T00:00:00Z'];

let worst = { planet: '', epoch: '', angDeg: 0 };
let compared = 0;
const expected = Object.keys(ELEMENTS).length * EPOCHS.length;
for (const [name, el] of Object.entries(ELEMENTS)) {
  for (const iso of EPOCHS) {
    const J = jd(iso);
    const url =
      `https://ssd.jpl.nasa.gov/api/horizons.api?format=text&COMMAND='${HORIZONS_ID[name]}'` +
      `&OBJ_DATA=NO&MAKE_EPHEM=YES&EPHEM_TYPE=VECTORS&CENTER='500@10'&REF_PLANE=ECLIPTIC` +
      `&OUT_UNITS='AU-D'&VEC_TABLE=1&TLIST='${J}'`;
    // node 18's CA bundle rejects ssd.jpl.nasa.gov's chain; curl accepts it.
    const text = execFileSync('curl', ['-s', '--max-time', '60', url], { encoding: 'utf8' });
    const m = text.match(/X\s*=\s*([-\d.E+]+)\s*Y\s*=\s*([-\d.E+]+)\s*Z\s*=\s*([-\d.E+]+)/);
    if (!m) {
      console.error(`${name} ${iso}: could not parse Horizons response`);
      continue;
    }
    compared++;
    const hz = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
    const T = (J - 2451545.0) / 36525;
    const us = keplerEcliptic(el, T);
    const dot = hz[0] * us[0] + hz[1] * us[1] + hz[2] * us[2];
    const lh = Math.hypot(...hz),
      lu = Math.hypot(...us);
    const ang = Math.acos(Math.min(1, Math.max(-1, dot / (lh * lu)))) / DEG;
    const dr = Math.abs(lu - lh) / lh;
    console.log(`${name.padEnd(8)} ${iso.slice(0, 10)}  ang ${ang.toFixed(4)}°  |r| ${(dr * 100).toFixed(3)}%`);
    if (ang > worst.angDeg) worst = { planet: name, epoch: iso, angDeg: ang };
    await new Promise((r) => setTimeout(r, 300)); // be polite to Horizons
  }
}
console.log(`\nworst: ${worst.planet} at ${worst.epoch}: ${worst.angDeg.toFixed(4)}°`);
if (compared < expected) {
  // A quiet Horizons outage must not read as a green check.
  console.error(`FAIL: only ${compared}/${expected} comparisons ran`);
  process.exit(1);
}
if (worst.angDeg > 0.2) {
  console.error('FAIL: exceeds 0.2° tolerance');
  process.exit(1);
}
console.log(`PASS: all ${compared} planet/epoch checks within 0.2° of JPL Horizons`);
