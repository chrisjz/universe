// Packs the ATHYG catalog (Tycho-2 + Gaia DR3 merge) into binary star tiles
// streamed by the app. 16 bytes per star, brightest-first chunks.
//
//   curl -sL https://raw.githubusercontent.com/astronexus/ATHYG-Database/main/data/subsets/athyg_32_reduced_m11.csv.gz -o /tmp/athyg.csv.gz
//   gunzip /tmp/athyg.csv.gz
//   node scripts/generate-star-tiles.mjs /tmp/athyg.csv
//
// Star record (little-endian):
//   f32 x, y, z   position in scene meters (sun frame, galactic orientation)
//   u8  r, g, b   color from B-V via blackbody temperature
//   u8  s         absolute magnitude, encoded s = (absmag + 15) * 8
// Apparent magnitude (for intensity) and luminosity (for physical sprite
// size) are both reconstructed at load time from absmag + distance.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const CHUNK = 120000;
const PC = 3.0857e16;

const M = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [+0.4941094279, -0.44482963, +0.7469822445],
  [-0.867666149, -0.1980763734, +0.4559837762],
];

function bvToRgb(bv) {
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const x = Math.min(Math.max(t, 2000), 30000) / 100;
  let r, g, b;
  if (x <= 66) {
    r = 255;
    g = 99.47 * Math.log(x) - 161.12;
    b = x <= 19 ? 0 : 138.52 * Math.log(x - 10) - 305.04;
  } else {
    r = 329.7 * Math.pow(x - 60, -0.1332);
    g = 288.12 * Math.pow(x - 60, -0.0755);
    b = 255;
  }
  const c = [r, g, b].map((v) => Math.min(Math.max(v / 255, 0), 1));
  const mean = (c[0] + c[1] + c[2]) / 3;
  return c.map((v) => Math.min(Math.max(mean + (v - mean) * 1.45, 0), 1));
}

const csv = readFileSync(process.argv[2], 'utf8').split('\n');
const header = csv[0].replace(/"/g, '').split(',');
const col = Object.fromEntries(header.map((h, i) => [h, i]));

const stars = [];
for (let i = 1; i < csv.length; i++) {
  const f = csv[i].split(',');
  if (f.length < header.length) continue;
  if (f[col.proper] === 'Sol') continue;
  const dist = parseFloat(f[col.dist]);
  const mag = parseFloat(f[col.mag]);
  const absmag = parseFloat(f[col.absmag]);
  if (!Number.isFinite(dist) || dist <= 0 || dist >= 90000) continue;
  if (!Number.isFinite(mag) || !Number.isFinite(absmag)) continue;
  const eq = [parseFloat(f[col.x0]), parseFloat(f[col.y0]), parseFloat(f[col.z0])];
  if (eq.some((v) => !Number.isFinite(v))) continue;
  const g = M.map((row) => row[0] * eq[0] + row[1] * eq[1] + row[2] * eq[2]);
  const ci = parseFloat(f[col.ci]);
  stars.push({
    pos: [-g[0] * PC, g[2] * PC, g[1] * PC],
    mag,
    s: Math.min(Math.max(Math.round((absmag + 15) * 8), 0), 255),
    rgb: bvToRgb(Number.isFinite(ci) ? ci : 0.6),
  });
}

stars.sort((a, b) => a.mag - b.mag);

mkdirSync('public/stars', { recursive: true });
const chunks = [];
for (let c = 0; c * CHUNK < stars.length; c++) {
  const slice = stars.slice(c * CHUNK, (c + 1) * CHUNK);
  const buf = new ArrayBuffer(slice.length * 16);
  const view = new DataView(buf);
  slice.forEach((st, i) => {
    const o = i * 16;
    view.setFloat32(o, st.pos[0], true);
    view.setFloat32(o + 4, st.pos[1], true);
    view.setFloat32(o + 8, st.pos[2], true);
    view.setUint8(o + 12, Math.round(st.rgb[0] * 255));
    view.setUint8(o + 13, Math.round(st.rgb[1] * 255));
    view.setUint8(o + 14, Math.round(st.rgb[2] * 255));
    view.setUint8(o + 15, st.s);
  });
  const file = `chunk-${c}.bin`;
  writeFileSync(`public/stars/${file}`, Buffer.from(buf));
  chunks.push({ file, count: slice.length });
}

writeFileSync(
  'public/stars/manifest.json',
  JSON.stringify(
    {
      source: 'ATHYG v3.2 (Tycho-2 + Gaia DR3), https://github.com/astronexus/ATHYG-Database, CC BY-SA 4.0',
      total: stars.length,
      chunks,
    },
    null,
    2,
  ),
);
console.log(`wrote ${stars.length} stars in ${chunks.length} chunks`);
