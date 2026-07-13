// Tiles the Magellanic Clouds from Gaia DR3 — the only other galaxies
// whose structure the atlas can draw from MEASURED stars.
//
// Input: two CSVs from ESA's Gaia TAP (columns ra,dec,phot_g_mean_mag,
// bp_rp,pmra,pmdec), selected by sky region + proper motion + parallax:
//   LMC: CIRCLE(81.28,-69.78,9),  |plx|<0.25, |pm − (1.871,0.391)| < 1.2
//   SMC: CIRCLE(13.19,-72.83,5.5), |plx|<0.25, |pm − (0.686,-1.237)| < 0.8
// (the Clouds move together on the sky — the standard membership cut).
//
// Output: <universe-data>/magellanic/{lmc,smc}.bin + manifest.json.
// 12-byte records: f32 ra°, f32 dec°, u8 G ((G−10)·16), u8 BP−RP
// ((c+1)·64, clamped), u16 pad. Distances are NOT per-star (Gaia cannot
// measure 50 kpc parallaxes): the app places every star at its Cloud's
// eclipsing-binary distance — LMC 49.59 kpc (Pietrzyński et al. 2019,
// 1%), SMC 62.44 kpc (Graczyk et al. 2020) — with a stylized depth.
//
// The proper motions are fetched ONLY to verify the selection: the mean
// pm of each sample must land on the published Cloud value, or the tiles
// are not written.
//
// Usage: node scripts/generate-magellanic.mjs <lmc.csv> <smc.csv> <universe-data-dir>

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [LMC_CSV, SMC_CSV, DATA_REPO] = process.argv.slice(2);
if (!LMC_CSV || !SMC_CSV || !DATA_REPO) {
  console.error('usage: node scripts/generate-magellanic.mjs <lmc.csv> <smc.csv> <universe-data-dir>');
  process.exit(1);
}

let failures = 0;
const check = (label, v, lo, hi) => {
  const ok = v >= lo && v <= hi;
  if (!ok) failures++;
  console.log(`${ok ? '  ok ' : 'FAIL '} ${label}: ${v.toPrecision(5)} (expect ${lo}..${hi})`);
};

const load = (path) => {
  const rows = readFileSync(path, 'utf8').trim().split('\n');
  const header = rows.shift().split(',');
  const iRa = header.indexOf('ra');
  const iDec = header.indexOf('dec');
  const iG = header.indexOf('phot_g_mean_mag');
  const iC = header.indexOf('bp_rp');
  const iPmra = header.indexOf('pmra');
  const iPmdec = header.indexOf('pmdec');
  const out = [];
  for (const line of rows) {
    const f = line.split(',');
    const ra = parseFloat(f[iRa]);
    const dec = parseFloat(f[iDec]);
    const g = parseFloat(f[iG]);
    if (!Number.isFinite(ra) || !Number.isFinite(g)) continue;
    out.push([ra, dec, g, parseFloat(f[iC]) || 0.8, parseFloat(f[iPmra]), parseFloat(f[iPmdec])]);
  }
  return out;
};

const clouds = [
  { name: 'lmc', csv: LMC_CSV, pm: [1.871, 0.391], countLo: 4e5, countHi: 4e6, center: [81.28, -69.78] },
  { name: 'smc', csv: SMC_CSV, pm: [0.686, -1.237], countLo: 1e5, countHi: 1.5e6, center: [13.19, -72.83] },
];

// Deterministic shuffle: any prefix of a tile is an unbiased subsample,
// enabling fractional draws when the Cloud is a sub-pixel smudge.
const shuffle = (list, seed) => {
  let t = seed;
  const rnd = () => {
    t |= 0;
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
};

const packs = [];
for (const c of clouds) {
  const stars = load(c.csv);
  shuffle(stars, 20260715);
  check(`${c.name.toUpperCase()} star count`, stars.length, c.countLo, c.countHi);
  // The selection's mean proper motion must be the published Cloud value —
  // a foreground-contaminated or mis-centered cut lands elsewhere.
  let mra = 0;
  let mdec = 0;
  for (const s of stars) {
    mra += s[4];
    mdec += s[5];
  }
  mra /= stars.length;
  mdec /= stars.length;
  check(`${c.name.toUpperCase()} mean pmra (published ${c.pm[0]})`, mra, c.pm[0] - 0.12, c.pm[0] + 0.12);
  check(`${c.name.toUpperCase()} mean pmdec (published ${c.pm[1]})`, mdec, c.pm[1] - 0.12, c.pm[1] + 0.12);
  // Density must peak toward the Cloud's center, not the field.
  let inner = 0;
  for (const s of stars) {
    const dra = (s[0] - c.center[0]) * Math.cos((c.center[1] * Math.PI) / 180);
    const ddec = s[1] - c.center[1];
    if (dra * dra + ddec * ddec < 4) inner++;
  }
  check(`${c.name.toUpperCase()} fraction within 2° of center`, inner / stars.length, 0.3, 1.0);

  const buf = Buffer.alloc(stars.length * 12);
  stars.forEach((s, i) => {
    const o = i * 12;
    buf.writeFloatLE(s[0], o);
    buf.writeFloatLE(s[1], o + 4);
    buf.writeUInt8(Math.min(Math.max(Math.round((s[2] - 10) * 16), 0), 255), o + 8);
    buf.writeUInt8(Math.min(Math.max(Math.round((s[3] + 1) * 64), 0), 255), o + 9);
  });
  packs.push({ name: c.name, buf, count: stars.length });
}

if (failures) {
  console.error(`\n${failures} FAILURES — not writing`);
  process.exit(1);
}

const outDir = join(DATA_REPO, 'magellanic');
mkdirSync(outDir, { recursive: true });
const manifest = {
  source:
    'Gaia DR3 (ESA/DPAC), proper-motion-selected members; distances: Pietrzyński et al. 2019 (LMC), Graczyk et al. 2020 (SMC)',
  clouds: [],
};
for (const p of packs) {
  writeFileSync(join(outDir, `${p.name}.bin`), p.buf);
  manifest.clouds.push({ file: `${p.name}.bin`, count: p.count });
  console.log(`  ${p.name}.bin: ${p.count} stars (${(p.buf.length / 1048576).toFixed(1)} MB)`);
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('\nall checks pass');
