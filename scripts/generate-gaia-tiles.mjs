// Downloads the Gaia DR3 faint extension band (11 <= G < 13, parallax good
// to 5 sigma: ~6.3M stars) from ESA's TAP archive and packs it — together
// with the existing ATHYG bright chunks — into the star tileset served by
// the chrisjz/universe-data repo (GitHub Pages).
//
// Data: ESA/Gaia/DPAC, https://gea.esac.esa.int/archive/ — free use with
// attribution (https://www.cosmos.esa.int/web/gaia-users/credits).
//
// The download is chunked by HEALPix level-0 pixel (the top 4 bits of
// source_id encode it, so each chunk is an indexed range scan) and cached:
// re-running the script skips chunks already on disk, so an interrupted
// download resumes where it left off.
//
// Tile scheme ("hierarchical spatial LOD"):
//   - LOD 0: the ATHYG bright chunks (mag <= 11, brightest first) — copied
//     verbatim from public/stars; always streamed first.
//   - LOD 1+: Gaia bands (11-11.5, 11.5-12, 12-12.5, 12.5-13), each split
//     into 12 HEALPix level-0 sky tiles. Same 16-byte record as ATHYG.
//
// Usage: node scripts/generate-gaia-tiles.mjs [--build-only]
// Cache:  .gaia-cache/chunk-<i>.csv   (~350 MB total, gitignored)
// Output: ../universe-data/stars/*.bin + manifest.json

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const TAP = 'https://gea.esac.esa.int/tap-server/tap';
const CACHE = '.gaia-cache-v2'; // v2: adds pmra/pmdec/radial_velocity columns
const OUT = resolve('../universe-data/stars');
const G_MIN = 11;
const G_MAX = 13;
const BANDS = [11.5, 12, 12.5, 13]; // upper edges
const PC = 3.0857e16;
const DEG = Math.PI / 180;

// Equatorial -> galactic (same matrix as generate-star-tiles.mjs).
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

// ---- phase A: download (12 async TAP jobs, cached, resumable) ----
async function tapChunk(i) {
  const lo = BigInt(i) << 59n;
  const hi = (BigInt(i + 1) << 59n) - 1n;
  const query =
    `SELECT ra, dec, parallax, phot_g_mean_mag, bp_rp, pmra, pmdec, radial_velocity FROM gaiadr3.gaia_source ` +
    `WHERE phot_g_mean_mag >= ${G_MIN} AND phot_g_mean_mag < ${G_MAX} ` +
    `AND parallax_over_error > 5 AND source_id BETWEEN ${lo} AND ${hi}`;
  const body = new URLSearchParams({
    REQUEST: 'doQuery',
    LANG: 'ADQL',
    FORMAT: 'csv',
    PHASE: 'RUN',
    QUERY: query,
  });
  const res = await fetch(`${TAP}/async`, { method: 'POST', body });
  // The job URL comes back as a redirect location (fetch follows it).
  const jobUrl = res.url;
  if (!jobUrl.includes('/async/')) throw new Error(`unexpected job URL ${jobUrl}`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const phase = await (await fetch(`${jobUrl}/phase`)).text();
    if (phase === 'COMPLETED') break;
    if (phase === 'ERROR' || phase === 'ABORTED') throw new Error(`chunk ${i}: job ${phase}`);
  }
  const csv = await (await fetch(`${jobUrl}/results/result`)).text();
  writeFileSync(`${CACHE}/chunk-${i}.csv`, csv);
  return csv.split('\n').length - 2;
}

async function download() {
  mkdirSync(CACHE, { recursive: true });
  for (let i = 0; i < 12; i++) {
    if (existsSync(`${CACHE}/chunk-${i}.csv`)) {
      console.log(`chunk ${i}: cached`);
      continue;
    }
    const t0 = Date.now();
    const n = await tapChunk(i);
    console.log(`chunk ${i}: ${n} rows in ${Math.round((Date.now() - t0) / 1000)}s`);
  }
}

// ---- phase B: pack tiles ----
// Split a band's stars into 4^rounds spatial sub-tiles by recursive
// median splits (z, then azimuth around the local mean) — balanced by
// construction, and the frustum culler uses each tile's EXACT bounding
// cone from the manifest, so the partition only needs to be compact.
function subSplit(list, rounds) {
  if (rounds === 0 || list.length <= 1) return [list];
  const zs = list.map((s) => s.dir[2]).sort((a, b) => a - b);
  const zMed = zs[Math.floor(zs.length / 2)];
  const lo = list.filter((s) => s.dir[2] < zMed);
  const hi = list.filter((s) => s.dir[2] >= zMed);
  const out = [];
  for (const half of [lo, hi]) {
    if (!half.length) continue;
    const phis = half.map((s) => Math.atan2(s.dir[1], s.dir[0]));
    // Split azimuth about the circular mean so wrap-around pixels stay compact.
    const mx = half.reduce((a, s) => a + s.dir[0], 0);
    const my = half.reduce((a, s) => a + s.dir[1], 0);
    const mean = Math.atan2(my, mx);
    const rel = phis.map((p) => Math.atan2(Math.sin(p - mean), Math.cos(p - mean))).sort((a, b) => a - b);
    const pMed = rel[Math.floor(rel.length / 2)];
    const left = [];
    const right = [];
    half.forEach((s) => {
      const p = Math.atan2(s.dir[1], s.dir[0]);
      const r = Math.atan2(Math.sin(p - mean), Math.cos(p - mean));
      (r < pMed ? left : right).push(s);
    });
    for (const quad of [left, right]) if (quad.length) out.push(...subSplit(quad, rounds - 1));
  }
  return out;
}

// Bounding cone of a tile's star directions: mean direction + max angle.
function boundingCone(list) {
  let x = 0,
    y = 0,
    z = 0;
  for (const s of list) {
    x += s.dir[0];
    y += s.dir[1];
    z += s.dir[2];
  }
  const l = Math.max(Math.hypot(x, y, z), 1e-12);
  x /= l;
  y /= l;
  z /= l;
  let minDot = 1;
  for (const s of list) minDot = Math.min(minDot, x * s.dir[0] + y * s.dir[1] + z * s.dir[2]);
  return { dir: [x, y, z], ang: Math.acos(Math.max(-1, Math.min(1, minDot))) };
}

// Faint stars vanish below perception as the camera leaves the stellar
// neighborhood — each band's far-fade shrinks with depth, so at galactic
// scale only the bright ATHYG set still draws (and pays vertex cost).
const BAND_FADE = [3e18, 2e18, 1.2e18, 8e17];

function build() {
  const bands = BANDS.map(() => []);
  for (let i = 0; i < 12; i++) {
    const csv = readFileSync(`${CACHE}/chunk-${i}.csv`, 'utf8').split('\n');
    for (let r = 1; r < csv.length; r++) {
      const f = csv[r].split(',');
      if (f.length < 5) continue;
      const ra = parseFloat(f[0]) * DEG;
      const dec = parseFloat(f[1]) * DEG;
      const plx = parseFloat(f[2]); // mas
      const g = parseFloat(f[3]);
      const bpRp = parseFloat(f[4]);
      const pmra = parseFloat(f[5]); // mas/yr (already mu_alpha*)
      const pmdec = parseFloat(f[6]); // mas/yr
      const rv = parseFloat(f[7]); // km/s (missing for most faint stars)
      if (!Number.isFinite(ra) || !Number.isFinite(dec) || !(plx > 0) || !Number.isFinite(g)) continue;
      const distPc = 1000 / plx;
      if (distPc <= 0 || distPc >= 90000) continue;
      // Equatorial unit vector -> galactic (matches the ATHYG pipeline).
      const eq = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
      const gal = M.map((row) => row[0] * eq[0] + row[1] * eq[1] + row[2] * eq[2]);
      // 3D velocity from proper motion (+ radial velocity where Gaia has
      // it): v_t = 4.74047 km/s per (arcsec/yr · pc) along the equatorial
      // east/north tangent vectors. Missing rv -> transverse motion only.
      const east = [-Math.sin(ra), Math.cos(ra), 0];
      const north = [-Math.sin(dec) * Math.cos(ra), -Math.sin(dec) * Math.sin(ra), Math.cos(dec)];
      const kt = 4.74047e-3 * distPc; // km/s per mas/yr at this distance
      const vr = Number.isFinite(rv) ? rv : 0;
      const vEq = [0, 1, 2].map(
        (k) =>
          kt * ((Number.isFinite(pmra) ? pmra : 0) * east[k] + (Number.isFinite(pmdec) ? pmdec : 0) * north[k]) +
          vr * eq[k],
      );
      const vGal = M.map((row) => row[0] * vEq[0] + row[1] * vEq[1] + row[2] * vEq[2]);
      const KMS_TO_M_YR = 3.15576e10;
      const vel = [-vGal[0] * KMS_TO_M_YR, vGal[2] * KMS_TO_M_YR, vGal[1] * KMS_TO_M_YR];
      const absmag = g + 5 - 5 * Math.log10(distPc);
      // BP-RP -> approximate B-V, only for the blackbody color tint.
      const bv = Number.isFinite(bpRp) ? 0.78 * bpRp - 0.02 : 0.6;
      let band = BANDS.length - 1;
      for (let b = 0; b < BANDS.length; b++)
        if (g < BANDS[b]) {
          band = b;
          break;
        }
      const pos = [-gal[0] * distPc * PC, gal[2] * distPc * PC, gal[1] * distPc * PC];
      const pl = Math.hypot(pos[0], pos[1], pos[2]);
      bands[band].push({
        pos,
        vel,
        // Unit direction in the tile file's (pre-orientation) convention;
        // the runtime culler rotates it into the true sky with the stars.
        dir: [pos[0] / pl, pos[1] / pl, pos[2] / pl],
        mag: g,
        s: Math.min(Math.max(Math.round((absmag + 15) * 8), 0), 255),
        rgb: bvToRgb(bv),
      });
    }
  }
  console.log(`parsed ${bands.reduce((n, b) => n + b.length, 0)} Gaia stars`);

  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) if (f.startsWith('gaia-')) rmSync(`${OUT}/${f}`); // stale tilings
  const chunks = [];
  // LOD 0: the ATHYG bright chunks, verbatim (never culled, default fade).
  const athyg = JSON.parse(readFileSync('public/stars/manifest.json', 'utf8'));
  for (const c of athyg.chunks) {
    copyFileSync(`public/stars/${c.file}`, `${OUT}/${c.file}`);
    chunks.push(c);
  }
  // LOD 1+: Gaia bands, each split into 64 count-balanced spatial tiles.
  // Every tile carries its exact bounding cone so the renderer can skip
  // whole tiles outside the view frustum — the sky is vertex-bound at 6.8M
  // sprites, and from the ground only ~a fifth of it is on screen.
  for (let b = 0; b < BANDS.length; b++) {
    const tiles = subSplit(bands[b], 3);
    tiles.forEach((slice, t) => {
      slice.sort((a, z) => a.mag - z.mag);
      // v2 record: 22 bytes — v1's 16 plus a quantized 3D velocity
      // (int16 gigameters/yr: ±33e12 m/yr ≈ ±1040 km/s, 0.03 km/s steps).
      const buf = new ArrayBuffer(slice.length * 22);
      const view = new DataView(buf);
      const q = (v) => Math.max(-32767, Math.min(32767, Math.round(v / 1e9)));
      slice.forEach((st, i) => {
        const o = i * 22;
        view.setFloat32(o, st.pos[0], true);
        view.setFloat32(o + 4, st.pos[1], true);
        view.setFloat32(o + 8, st.pos[2], true);
        view.setUint8(o + 12, Math.round(st.rgb[0] * 255));
        view.setUint8(o + 13, Math.round(st.rgb[1] * 255));
        view.setUint8(o + 14, Math.round(st.rgb[2] * 255));
        view.setUint8(o + 15, st.s);
        view.setInt16(o + 16, q(st.vel[0]), true);
        view.setInt16(o + 18, q(st.vel[1]), true);
        view.setInt16(o + 20, q(st.vel[2]), true);
      });
      const file = `gaia-b${b}-t${t}.bin`;
      writeFileSync(`${OUT}/${file}`, Buffer.from(buf));
      const cone = boundingCone(slice);
      chunks.push({
        file,
        count: slice.length,
        dir: cone.dir.map((v) => Math.round(v * 1e5) / 1e5),
        ang: Math.round(cone.ang * 1e4) / 1e4,
        fade: BAND_FADE[b],
      });
    });
  }
  const total = chunks.reduce((n, c) => n + c.count, 0);
  writeFileSync(
    `${OUT}/manifest.json`,
    JSON.stringify(
      {
        source:
          'ATHYG v3.2 (CC BY-SA 4.0) mag<=11 + Gaia DR3 (ESA/Gaia/DPAC) 11<=G<13 with parallax_over_error>5; 3D space velocities from proper motions + radial velocities',
        format: 2,
        stride: 22,
        total,
        chunks,
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${total} stars in ${chunks.length} chunks to ${OUT}`);
}

if (!process.argv.includes('--build-only')) await download();
build();
