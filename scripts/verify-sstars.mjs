// Verifies src/blackhole.ts against the published S2 measurements:
//   - pericenter passage 2018.33 (table epoch 2002.33 + P 16.00) at ~120 AU
//   - pericenter speed ~7650 km/s (GRAVITY 2018: 2.55% of c)
//   - the radial-velocity swing through 2018: redshifted (receding) before
//     pericenter, blueshifted after — GRAVITY 2018's +4000 → −2000 km/s
//   - Ω is the position angle (east of north) of the ASCENDING node — the
//     sky crossing where the star recedes — which pins the whole
//     Thiele–Innes composition
//   - the GR pericenter advance reproduces GRAVITY 2020's 12.1′ per orbit,
//     prograde
//   - the shadow diameter from Earth matches EHT's ~52 μas
//
// Usage: node scripts/verify-sstars.mjs   (run from the project root)

import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

execSync('npx esbuild src/blackhole.ts --bundle --outfile=.sstars-verify.mjs --format=esm', { stdio: 'inherit' });
const bh = await import('../.sstars-verify.mjs');
rmSync('.sstars-verify.mjs');

const { S_STARS, sStarPos, sStarAxes, SGRA_RS, SGRA_SHADOW, SGRA_R0_PC } = bh;
const AU = 1.496e11;
const YEAR_MS = 31557600000;
const J2000_MS = Date.UTC(2000, 0, 1, 12);
const yrToMs = (yr) => J2000_MS + (yr - 2000) * YEAR_MS;

// Sky basis, reconstructed exactly as blackhole.ts builds it (it is not
// exported): line of sight toward Sgr A*, east, north.
const RA = ((17 + 45 / 60 + 40.04 / 3600) * 15 * Math.PI) / 180;
const DEC = (-(29 + 0 / 60 + 28.1 / 3600) * Math.PI) / 180;
const OBL = (23.44 * Math.PI) / 180;
const eqToScene = (x, y, z) => [x, -Math.sin(OBL) * y + Math.cos(OBL) * z, -Math.cos(OBL) * y - Math.sin(OBL) * z];
const LOS = eqToScene(Math.cos(DEC) * Math.cos(RA), Math.cos(DEC) * Math.sin(RA), Math.sin(DEC));
const EAST = eqToScene(-Math.sin(RA), Math.cos(RA), 0);
const NORTH = eqToScene(-Math.sin(DEC) * Math.cos(RA), -Math.sin(DEC) * Math.sin(RA), Math.cos(DEC));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

let failures = 0;
const check = (label, value, lo, hi, unit = '') => {
  const ok = value >= lo && value <= hi;
  if (!ok) failures++;
  console.log(`${ok ? '  ok ' : 'FAIL '} ${label}: ${value.toPrecision(5)} ${unit} (expect ${lo}..${hi})`);
};

const s2 = S_STARS.find((s) => s.name === 'S2');
const pos = (ms) => {
  const p = [0, 0, 0];
  sStarPos(s2, ms, p);
  return p;
};
const vel = (ms) => {
  const h = 3600e3; // 1 hour
  const a = pos(ms - h);
  const b = pos(ms + h);
  return [(b[0] - a[0]) / (2 * h), (b[1] - a[1]) / (2 * h), (b[2] - a[2]) / (2 * h)]; // m/ms = km/s
};

// ---- pericenter search across 2018 ----
let bestMs = 0;
let bestR = Infinity;
for (let yr = 2018.0; yr <= 2018.7; yr += 0.0005) {
  const r = Math.hypot(...pos(yrToMs(yr)));
  if (r < bestR) {
    bestR = r;
    bestMs = yrToMs(yr);
  }
}
const periYr = 2000 + (bestMs - J2000_MS) / YEAR_MS;
check('S2 pericenter epoch', periYr, 2018.28, 2018.4, 'yr');
check('S2 pericenter distance', bestR / AU, 118, 124, 'AU');
check('S2 pericenter distance', bestR / SGRA_RS, 1350, 1500, 'rs');
const vPeri = Math.hypot(...vel(bestMs));
check('S2 pericenter speed', vPeri, 7400, 7900, 'km/s (GRAVITY: ~7650)');

// ---- the 2018 radial-velocity swing (GRAVITY 2018, Fig. 2) ----
const rvAt = (yr) => dot(vel(yrToMs(yr)), LOS); // + receding (redshift)
check('S2 RV before pericenter (2018.2)', rvAt(2018.2), 1000, 4500, 'km/s (receding)');
check('S2 RV after pericenter (2018.55)', rvAt(2018.55), -3000, -500, 'km/s (approaching)');
let rvMax = 0;
for (let yr = 2017.5; yr < 2019; yr += 0.002) rvMax = Math.max(rvMax, rvAt(yr));
check('S2 peak RV', rvMax, 3500, 4300, 'km/s (GRAVITY: ~4000)');

// ---- Ω = position angle of the ascending (receding) node ----
{
  let prevLos = dot(pos(yrToMs(2003)), LOS);
  let nodePA = NaN;
  for (let yr = 2003; yr < 2019; yr += 0.001) {
    const p = pos(yrToMs(yr));
    const losOff = dot(p, LOS);
    if (prevLos < 0 && losOff >= 0) {
      // crossing the sky plane moving away — the ascending node
      const pa = (Math.atan2(dot(p, EAST), dot(p, NORTH)) * 180) / Math.PI;
      nodePA = (pa + 360) % 360;
      break;
    }
    prevLos = losOff;
  }
  check('S2 ascending-node PA (Ω)', nodePA, 226.0, 228.0, '° (table: 226.94)');
}

// ---- GR pericenter advance: 12.1′ per orbit, prograde ----
{
  // At t = tP and t = tP + P the anomaly is exactly zero — the positions
  // ARE the pericenter directions; the angle between them is Δω per orbit.
  const p1 = pos(s2.tpMs);
  const peri2 = pos(s2.tpMs + s2.periodMs);
  const n1 = p1.map((v) => v / Math.hypot(...p1));
  const n2 = peri2.map((v) => v / Math.hypot(...peri2));
  const angArcmin = (Math.acos(Math.min(1, dot(n1, n2))) * 180 * 60) / Math.PI;
  check('S2 pericenter advance per orbit', angArcmin, 11, 13.5, '′ (GRAVITY 2020: 12.1)');
  // prograde: the advance rotates with the orbital angular momentum
  const v1 = vel(s2.tpMs);
  const L = [p1[1] * v1[2] - p1[2] * v1[1], p1[2] * v1[0] - p1[0] * v1[2], p1[0] * v1[1] - p1[1] * v1[0]];
  const cross = [n1[1] * n2[2] - n1[2] * n2[1], n1[2] * n2[0] - n1[0] * n2[2], n1[0] * n2[1] - n1[1] * n2[0]];
  check('advance is prograde (sign)', Math.sign(dot(cross, L)), 1, 1);
}

// ---- the shadow, seen from Earth ----
const R0_M = SGRA_R0_PC * 3.0857e16;
const shadowMuas = ((2 * SGRA_SHADOW) / R0_M) * (180 / Math.PI) * 3600e6;
check('shadow diameter from Earth', shadowMuas, 50, 55, 'μas (EHT ring: 51.8 ± 2.3)');

// ---- every orbit line closes on its star ----
for (const s of S_STARS) {
  const { A, B } = sStarAxes(s);
  // At pericenter the star sits at focus + A·(1−e): verify the line formula
  // −e·A + A·cosE + B·sinE reproduces sStarPos at E = 0 (t = tP, ω = ω0).
  const p = [0, 0, 0];
  sStarPos(s, s.tpMs, p);
  const line = [A[0] * (1 - s.e), A[1] * (1 - s.e), A[2] * (1 - s.e)];
  const err = Math.hypot(p[0] - line[0], p[1] - line[1], p[2] - line[2]);
  if (err > 1e-4 * s.aM) {
    failures++;
    console.log(`FAIL  orbit line vs ephemeris for ${s.name}: ${(err / s.aM).toExponential(2)} of a`);
  }
}
console.log(`  ok  orbit lines close on their stars (${S_STARS.length} stars)`);

console.log(failures ? `\n${failures} FAILURES` : '\nall checks pass');
process.exit(failures ? 1 : 0);
