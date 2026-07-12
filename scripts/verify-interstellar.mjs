// Verifies src/comet.ts against JPL Horizons:
//   - each interstellar visitor's two-body position at 2026-07-12 (TDB)
//     versus Horizons state vectors fetched 2026-07-12 (full n-body)
//   - the universal-variable propagator closes on the element solver
//     (a β = 0 "grain" released 60 days ago must land on the nucleus)
//
// Usage: node scripts/verify-interstellar.mjs   (run from the project root)

import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

execSync('npx esbuild src/comet.ts --bundle --outfile=.comet-verify.mjs --format=esm', { stdio: 'inherit' });
const cm = await import('../.comet-verify.mjs');
rmSync('.comet-verify.mjs');
const { VISITORS, conicScenePos, kepUniversal } = cm;

const AU = 1.496e11;
const jdToMs = (jd) => (jd - 2440587.5) * 86400000;
const CHECK_MS = jdToMs(2461233.5); // 2026-Jul-12 00:00 TDB — tp shares the scale

// Horizons heliocentric ecliptic J2000 vectors at that instant (AU).
const HORIZONS = {
  oumuamua: [48.65771590545017, 7.747839946885361, 20.58424007046325],
  borisov: [0.4710098243449144, -40.58836054031868, -23.88273562604589],
  '3i-atlas': [-2.330327481074185, 8.762152399584981, -0.4661604500890825],
};

let failures = 0;
const scene = [0, 0, 0];
for (const v of VISITORS) {
  conicScenePos(v.el, CHECK_MS, scene);
  // scene (x, z, −y) → ecliptic (x, y, z)
  const ecl = [scene[0] / AU, -scene[2] / AU, scene[1] / AU];
  const h = HORIZONS[v.slug];
  const err = Math.hypot(ecl[0] - h[0], ecl[1] - h[1], ecl[2] - h[2]);
  const r = Math.hypot(...h);
  // Two-body vs full n-body: the visitors spend their span far from the
  // planets, so the drift stays small — 0.5% of r catches any frame or
  // anomaly error (a flipped node alone is tens of AU).
  const ok = err < Math.max(0.05, 0.005 * r);
  if (!ok) failures++;
  console.log(`${ok ? '  ok ' : 'FAIL '} ${v.name}: r=${r.toFixed(2)} AU, two-body vs Horizons ${err.toFixed(4)} AU`);
}

// β = 0 closure: the universal propagator under full μ must reproduce the
// element solver — release a grain from 3I sixty days before the check
// epoch and fly it forward.
{
  const el = VISITORS[2].el;
  const t0 = CHECK_MS - 60 * 86400000;
  const p0 = [0, 0, 0];
  const p1 = [0, 0, 0];
  const pv = [0, 0, 0];
  conicScenePos(el, t0, p0);
  const h = 3600000;
  const pa = [0, 0, 0];
  const pb = [0, 0, 0];
  conicScenePos(el, t0 - h, pa);
  conicScenePos(el, t0 + h, pb);
  const v0 = [
    ((pb[0] - pa[0]) / (2 * h)) * 1000,
    ((pb[1] - pa[1]) / (2 * h)) * 1000,
    ((pb[2] - pa[2]) / (2 * h)) * 1000,
  ];
  kepUniversal(p0, v0, 60 * 86400, 1.32712440018e20, pv);
  conicScenePos(el, CHECK_MS, p1);
  const err = Math.hypot(pv[0] - p1[0], pv[1] - p1[1], pv[2] - p1[2]);
  const ok = err < 2e7; // finite-difference velocity limits this, not the solver
  if (!ok) failures++;
  console.log(
    `${ok ? '  ok ' : 'FAIL '} universal propagator closes on the element solver: ${(err / 1e3).toFixed(0)} km over 60 d`,
  );
}

console.log(failures ? `\n${failures} FAILURES` : '\nall checks pass');
process.exit(failures ? 1 : 0);
