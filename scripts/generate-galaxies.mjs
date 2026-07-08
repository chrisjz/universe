// Packs the 2MASS Redshift Survey (Huchra et al. 2012, ApJS 199, 26) into a
// binary galaxy tile: the real local universe — Virgo, Coma, Perseus–Pisces,
// the Great Wall — replacing the procedural cosmic web out to ~400 Mpc.
//
//   curl -sL http://tdc-www.harvard.edu/2mrs/2mrs_v240.tgz | tar -xz
//   node scripts/generate-galaxies.mjs catalog/2mrs_1175_done.dat
//
// Galaxy record (little-endian, 16 bytes):
//   f32 ra, dec  J2000 degrees (the app rotates into the scene at load)
//   f32 dist     meters, from cz / H0 (H0 = 70 km/s/Mpc; pure Hubble flow,
//                floored at 0.7 Mpc — fine at cosmic-web zoom)
//   u8  mag      apparent K_s magnitude, encoded (mag + 3) * 16
//   u8  type     0 = early (E/S0, red), 1 = late (spiral/irregular, blue)
//   u16 pad

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const H0 = 70; // km/s/Mpc
const MPC = 3.0857e22; // meters

const lines = readFileSync(process.argv[2], 'utf8').split('\n');
const out = [];
let early = 0;
for (const line of lines) {
  if (!line || line.startsWith('#')) continue;
  const f = line.trim().split(/\s+/);
  if (f.length < 25) continue;
  const ra = parseFloat(f[1]);
  const dec = parseFloat(f[2]);
  const k = parseFloat(f[5]);
  const type = f[22]; // morphological code, e.g. "3A2s" or "-5X_s"
  const v = parseFloat(f[24]);
  if (![ra, dec, k, v].every(Number.isFinite)) continue;
  const distMpc = Math.max(v / H0, 0.7);
  const t = parseInt(type, 10); // leading Hubble stage; NaN -> late
  const isEarly = Number.isFinite(t) && t < 0;
  if (isEarly) early++;
  out.push({ ra, dec, dist: distMpc * MPC, k, early: isEarly });
}

const buf = new ArrayBuffer(out.length * 16);
const view = new DataView(buf);
out.forEach((g, i) => {
  const o = i * 16;
  view.setFloat32(o, g.ra, true);
  view.setFloat32(o + 4, g.dec, true);
  view.setFloat32(o + 8, g.dist, true);
  view.setUint8(o + 12, Math.min(Math.max(Math.round((g.k + 3) * 16), 0), 255));
  view.setUint8(o + 13, g.early ? 0 : 1);
});
mkdirSync('public/galaxies', { recursive: true });
writeFileSync('public/galaxies/2mrs.bin', Buffer.from(buf));
writeFileSync(
  'public/galaxies/meta.json',
  JSON.stringify(
    {
      source: '2MASS Redshift Survey v2.4 (Huchra et al. 2012, ApJS 199, 26), http://tdc-www.harvard.edu/2mrs/',
      count: out.length,
      h0: H0,
    },
    null,
    2,
  ),
);

// Sanity: the Virgo cluster should be a strong overdensity at ~17 Mpc
// toward RA 187.7°, Dec +12.4°.
const virgo = out.filter((g) => {
  const dRa = Math.abs(g.ra - 187.7) * Math.cos((12.4 * Math.PI) / 180);
  const dDec = Math.abs(g.dec - 12.4);
  return Math.hypot(dRa, dDec) < 6 && g.dist / MPC > 10 && g.dist / MPC < 30;
}).length;
console.log(`wrote ${out.length} galaxies (${early} early-type); Virgo cone 10-30 Mpc: ${virgo} galaxies`);
