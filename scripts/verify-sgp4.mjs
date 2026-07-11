// Verifies src/sgp4.ts against JPL Horizons' ISS ephemeris: fetch the
// current ISS TLE from CelesTrak, propagate around its epoch, and compare
// geocentric J2000 positions. ISS TLEs fit tracking to a few km at epoch
// and drift ~1-2 km/day, so the gates (50 km at epoch, 150 km at ±1 day)
// catch real math errors — a wrong frame rotation alone is ~90 km.
//
// Usage: node scripts/verify-sgp4.mjs

import { execFileSync, execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

// The propagator is TypeScript; esbuild (vite's own bundler) strips the
// types so plain node can import it. Type-only imports vanish with them.
execSync('npx esbuild src/sgp4.ts --outfile=.sgp4-verify.mjs --format=esm', { stdio: 'inherit' });
const { parseTle, sgp4Init, sgp4, temeToJ2000 } = await import('../.sgp4-verify.mjs');
rmSync('.sgp4-verify.mjs');

const curl = (url) => execFileSync('curl', ['-s', '--max-time', '60', url], { encoding: 'utf8' });

// ---- the TLE ----
const tleText = curl('https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=tle');
const lines = tleText.trim().split('\n');
if (lines.length < 3 || !lines[1].startsWith('1 ')) {
  console.error(`unexpected CelesTrak response:\n${tleText.slice(0, 200)}`);
  process.exit(1);
}
const tle = parseTle(lines[0], lines[1], lines[2]);
const sat = sgp4Init(tle);
console.log(`${tle.name} (${tle.satnum})  epoch ${new Date(tle.epochMs).toISOString()}`);

// ---- Horizons ground truth at epoch ± offsets ----
// Horizons reads TLIST as TDB; TLEs are UTC. TDB−UTC = 32.184 s + 37 leap
// seconds = 69.184 s — at 7.7 km/s of ISS that's 530 km of along-track
// error if forgotten (ask me how I know).
const TDB_MINUS_UTC_MS = 69184;
const jd = (ms) => (ms + TDB_MINUS_UTC_MS) / 86400000 + 2440587.5;
const OFFSETS_H = [0, -12, 12, 24];
let worst = 0;
let compared = 0;
for (const oh of OFFSETS_H) {
  const ms = tle.epochMs + oh * 3600000;
  const url =
    `https://ssd.jpl.nasa.gov/api/horizons.api?format=text&COMMAND='-125544'` +
    `&OBJ_DATA=NO&MAKE_EPHEM=YES&EPHEM_TYPE=VECTORS&CENTER='500@399'&REF_PLANE=FRAME` +
    `&OUT_UNITS='KM-S'&VEC_TABLE=1&TLIST='${jd(ms)}'`;
  const text = curl(url);
  const m = text.match(/X\s*=\s*([-\d.E+]+)\s*Y\s*=\s*([-\d.E+]+)\s*Z\s*=\s*([-\d.E+]+)/);
  if (!m) {
    console.error(`  ${oh}h: could not parse Horizons response`);
    continue;
  }
  const hz = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
  const teme = [0, 0, 0];
  if (!sgp4(sat, oh * 60, teme)) {
    console.error(`  ${oh}h: sgp4 reported decay`);
    continue;
  }
  const P = temeToJ2000(ms);
  const us = [0, 1, 2].map((i) => P[i][0] * teme[0] + P[i][1] * teme[1] + P[i][2] * teme[2]);
  const err = Math.hypot(us[0] - hz[0], us[1] - hz[1], us[2] - hz[2]);
  const limit = oh === 0 ? 50 : 150;
  console.log(
    `  epoch${oh >= 0 ? '+' : ''}${oh}h  |r| ${Math.hypot(...us).toFixed(0)} km  error ${err.toFixed(1)} km (limit ${limit})`,
  );
  compared++;
  worst = Math.max(worst, err / limit);
  await new Promise((r) => setTimeout(r, 300));
}
if (compared < OFFSETS_H.length) {
  console.error(`FAIL: only ${compared}/${OFFSETS_H.length} comparisons ran`);
  process.exit(1);
}
if (worst > 1) {
  console.error('FAIL: SGP4 disagrees with Horizons beyond TLE accuracy');
  process.exit(1);
}
console.log('PASS: SGP4 matches JPL Horizons within TLE accuracy');
