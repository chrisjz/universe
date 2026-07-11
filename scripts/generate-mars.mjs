// Bakes the Jezero crater terrain from the MOLA global elevation model.
//
// Source: MGS MOLA MEGDR 16 px/deg topography grid (PDS Geosciences,
// https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/):
// megt90n000eb.img — 5760x2880 signed 16-bit big-endian, elevation in
// meters relative to the areoid, planetary radius 3396.0 km reference.
//
// Same drill as the Moon (scripts/generate-moon.mjs): the site is fixed at
// Octavia E. Butler Landing (Perseverance, Jezero crater), so each imagery
// ring's gnomonic vertex net is sampled here once and baked. Heights are
// relative to the site's own elevation (the site is the datum).
//
// Usage: node scripts/generate-mars.mjs path/to/megt90n000eb.img
// Writes: public/mars/jezero.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SITE_LAT = 18.4447; // Octavia E. Butler Landing (Perseverance)
const SITE_LON = 77.4508;
const R_REF = 3.3895e6; // Mars mean radius (m); MOLA datum radius 3396.0 km is equatorial-ish
const RING_SIZES = [1024e3, 256e3, 64e3, 16e3];
const GRID = 48;

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/generate-mars.mjs path/to/megt90n000eb.img');
  process.exit(1);
}

const buf = readFileSync(src);
const W = 5760,
  H = 2880;
if (buf.length !== W * H * 2) throw new Error(`expected ${W * H * 2} bytes, got ${buf.length}`);

// MEGDR is areocentric, longitude 0..360 east, row 0 at +90.
function elev(latDeg, lonDeg) {
  const x = (((((lonDeg + 360) / 360) % 1) + 1) % 1) * W - 0.5;
  const y = ((90 - latDeg) / 180) * H - 0.5;
  const x0 = Math.floor(x),
    y0 = Math.min(H - 2, Math.max(0, Math.floor(y)));
  const fx = x - x0,
    fy = y - y0;
  const at = (xx, yy) => buf.readInt16BE((yy * W + (((xx % W) + W) % W)) * 2);
  const t0 = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const t1 = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return t0 * (1 - fy) + t1 * fy;
}

const DEG = Math.PI / 180;
const dir = (lat, lon) => [Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)];
const up = dir(SITE_LAT * DEG, SITE_LON * DEG);
const eh = Math.hypot(up[0], up[2]);
const east = [up[2] / eh, 0, -up[0] / eh];
const north = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];

const siteElev = elev(SITE_LAT, SITE_LON);
const R_SITE = R_REF + siteElev;

const rings = RING_SIZES.map((S) => {
  const heights = [];
  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      const e = (i / GRID - 0.5) * S;
      const n = (j / GRID - 0.5) * S;
      const p = [
        east[0] * e + up[0] * R_SITE + north[0] * n,
        east[1] * e + up[1] * R_SITE + north[1] * n,
        east[2] * e + up[2] * R_SITE + north[2] * n,
      ];
      const l = Math.hypot(p[0], p[1], p[2]);
      const lat = Math.asin(p[1] / l) / DEG;
      const lon = Math.atan2(-p[2], p[0]) / DEG;
      heights.push(Math.round(elev(lat, lon) - siteElev));
    }
  }
  return { S, heights };
});

mkdirSync('public/mars', { recursive: true });
writeFileSync(
  'public/mars/jezero.json',
  JSON.stringify({
    lat: SITE_LAT,
    lon: SITE_LON,
    siteElev: Math.round(siteElev),
    R: Math.round(R_SITE),
    grid: GRID,
    rings,
  }),
);
const all = rings.flatMap((r) => r.heights);
console.log(`site elevation ${siteElev.toFixed(0)} m (MOLA areoid) · datum radius ${R_SITE.toFixed(0)} m`);
console.log(
  `rings ${RING_SIZES.map((s) => s / 1e3 + ' km').join(', ')} · height range ${Math.min(...all)}..${Math.max(...all)} m`,
);
