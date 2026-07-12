// Tiles the SDSS DR18 spectroscopic galaxy catalog for the atlas.
//
// Input: a CSV of `ra,dec,z` rows (no header) — SkyServer's SpecObj table
// with class='GALAXY', zWarning=0, 0.01 ≤ z ≤ 1.0, paged out in RA strips:
//   SELECT ra,dec,z FROM SpecObj WHERE class='GALAXY' AND zWarning=0
//     AND z BETWEEN 0.01 AND 1.0 AND ra>=<a> AND ra<<b>
//   via https://skyserver.sdss.org/dr18/SkyServerWS/SearchTools/SqlSearch
//
// Outputs:
//   <universe-data>/sdss/band-<k>.bin   redshift-banded 12-byte records
//                                       (f32 ra°, f32 dec°, f32 z)
//   <universe-data>/sdss/manifest.json  band index + attribution
//   public/sdss-fallback.bin            1-in-17 subsample, same records —
//                                       the offline/CI stand-in, like the
//                                       bundled ATHYG star tiles
//   src/data/sdssmask.ts                2°×2° footprint mask: per-cell max
//                                       comoving depth, so the procedural
//                                       web can step aside exactly where
//                                       (and as deep as) SDSS measured
//
// Redshift → comoving distance uses the atlas's own ΛCDM parameters
// (src/cosmo.ts: H₀ = 67.4, Ωm = 0.315, ΩΛ = 0.685), verified below
// against standard values before anything is written.
//
// Usage: node scripts/generate-sdss.mjs <sdss-galaxies.csv> <universe-data-dir>

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CSV = process.argv[2];
const DATA_REPO = process.argv[3];
if (!CSV || !DATA_REPO) {
  console.error('usage: node scripts/generate-sdss.mjs <csv> <universe-data-dir>');
  process.exit(1);
}

// ---- comoving distance (flat ΛCDM, the cosmo.ts parameters) ----
const H0 = 67.4; // km/s/Mpc
const OM = 0.315;
const OL = 0.685;
const C_KMS = 299792.458;
const MPC = 3.0857e22; // meters
const DH = C_KMS / H0; // Hubble distance, Mpc
// Cumulative trapezoid on a fine grid; interpolate for lookups.
const NZ = 20000;
const ZMAX = 1.05;
const dcTable = new Float64Array(NZ + 1);
{
  let acc = 0;
  let prev = 1; // 1/E(0)
  for (let i = 1; i <= NZ; i++) {
    const z = (i / NZ) * ZMAX;
    const invE = 1 / Math.sqrt(OM * Math.pow(1 + z, 3) + OL);
    acc += ((prev + invE) / 2) * (ZMAX / NZ);
    dcTable[i] = acc * DH; // Mpc
    prev = invE;
  }
}
const dcMpc = (z) => {
  const x = (z / ZMAX) * NZ;
  const i = Math.min(Math.floor(x), NZ - 1);
  return dcTable[i] + (dcTable[i + 1] - dcTable[i]) * (x - i);
};

let failures = 0;
const check = (label, v, lo, hi) => {
  const ok = v >= lo && v <= hi;
  if (!ok) failures++;
  console.log(
    `${ok ? '  ok ' : 'FAIL '} ${label}: ${typeof v === 'number' ? v.toPrecision(5) : v} (expect ${lo}..${hi})`,
  );
};
// Standard flat-ΛCDM values for these parameters.
check('D_C(0.1) Mpc', dcMpc(0.1), 425, 437);
check('D_C(0.5) Mpc', dcMpc(0.5), 1900, 2000);
check('D_C(1.0) Mpc', dcMpc(1.0), 3330, 3460);

// ---- read the catalog ----
const rows = readFileSync(CSV, 'utf8').split('\n');
const gals = [];
for (const line of rows) {
  if (!line) continue;
  const c = line.split(',');
  const ra = parseFloat(c[0]);
  const dec = parseFloat(c[1]);
  const z = parseFloat(c[2]);
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(z)) continue;
  gals.push([ra, dec, z]);
}
check('catalog size', gals.length, 2.5e6, 3e6);

// ---- redshift bands (streamed nearest-first by the app) ----
const BANDS = [
  [0.01, 0.08],
  [0.08, 0.15],
  [0.15, 0.3],
  [0.3, 0.5],
  [0.5, 1.0],
];
const banded = BANDS.map(() => []);
for (const g of gals) {
  const k = BANDS.findIndex(([a, b]) => g[2] >= a && g[2] < b);
  if (k >= 0) banded[k].push(g);
}

// ---- footprint mask: 2°×2° cells, per-cell max comoving depth ----
// Quantized to 2e24 m (65 Mpc) steps in a u8; 0 = SDSS never looked here.
// The procedural web consults this to step aside only where (and as deep
// as) the survey actually measured.
const MW = 180; // ra cells
const MH = 90; // dec cells
const mask = new Uint8Array(MW * MH);
for (const [ra, dec, z] of gals) {
  const cx = Math.min(Math.floor(ra / 2), MW - 1);
  const cy = Math.min(Math.floor((dec + 90) / 2), MH - 1);
  const depth = Math.min(Math.ceil((dcMpc(z) * MPC) / 2e24), 255);
  const i = cy * MW + cx;
  if (depth > mask[i]) mask[i] = depth;
}
// A single stray fiber shouldn't blank a whole procedural cell: require a
// handful of galaxies before a cell counts as surveyed.
const counts = new Uint16Array(MW * MH);
for (const [ra, dec] of gals) {
  const cx = Math.min(Math.floor(ra / 2), MW - 1);
  const cy = Math.min(Math.floor((dec + 90) / 2), MH - 1);
  counts[cy * MW + cx]++;
}
let covered = 0;
for (let i = 0; i < mask.length; i++) {
  if (counts[i] < 8) mask[i] = 0;
  if (mask[i]) covered++;
}
// SDSS covers roughly a third of the sky (the cells are equirectangular,
// so this fraction is of cell count, not solid angle — a loose gate).
check('footprint cells covered', covered / mask.length, 0.15, 0.5);

// The Sloan Great Wall neighborhood should be among the densest cells.
{
  const sgw = counts[Math.floor((25 + 90) / 2) * MW + Math.floor(190 / 2)];
  check('galaxies in the Sloan Great Wall cell (ra 190°, dec 25°)', sgw, 500, 1e9);
}

if (failures) {
  console.error(`\n${failures} FAILURES — not writing`);
  process.exit(1);
}

// ---- write ----
const outDir = join(DATA_REPO, 'sdss');
mkdirSync(outDir, { recursive: true });
const pack = (list) => {
  const buf = Buffer.alloc(list.length * 12);
  list.forEach(([ra, dec, z], i) => {
    buf.writeFloatLE(ra, i * 12);
    buf.writeFloatLE(dec, i * 12 + 4);
    buf.writeFloatLE(z, i * 12 + 8);
  });
  return buf;
};
const manifest = { source: 'SDSS DR18 SpecObj (class=GALAXY, zWarning=0), skyserver.sdss.org', bands: [] };
banded.forEach((list, k) => {
  const file = `band-${k}.bin`;
  writeFileSync(join(outDir, file), pack(list));
  manifest.bands.push({ file, count: list.length, zMin: BANDS[k][0], zMax: BANDS[k][1] });
  console.log(`  ${file}: ${list.length} galaxies (z ${BANDS[k][0]}–${BANDS[k][1]})`);
});
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// Offline/CI fallback: a 1-in-17 density subsample keeps the wedges'
// shape at ~6% of the payload (structure survives subsampling; a magnitude
// cut would erase the far bands instead).
const fallback = gals.filter((_, i) => i % 17 === 0);
writeFileSync('public/sdss-fallback.bin', pack(fallback));
console.log(`  public/sdss-fallback.bin: ${fallback.length} galaxies`);

// The mask, bundled into the app (the procedural web builds synchronously).
const b64 = Buffer.from(mask).toString('base64');
writeFileSync(
  'src/data/sdssmask.ts',
  `// GENERATED by scripts/generate-sdss.mjs — do not edit.
// 2°×2° SDSS footprint mask (180×90, row = dec from −90°), u8 per cell:
// max comoving survey depth in that direction, units of 2e24 m; 0 = the
// survey never looked there.
export const SDSS_MASK_W = ${MW};
export const SDSS_MASK_H = ${MH};
export const SDSS_MASK_DEPTH_UNIT = 2e24; // meters
export const SDSS_MASK: Uint8Array = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0));
`,
);
console.log(`  src/data/sdssmask.ts: ${covered} covered cells`);
console.log('\nall checks pass');
