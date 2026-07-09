// Bakes the Tranquility Base terrain from the LOLA global elevation model.
//
// Source: NASA SVS "CGI Moon Kit" (https://svs.gsfc.nasa.gov/4720), which
// repackages the LRO LOLA team's gridded DEM: ldem_16_uint.tif, a 5760x2880
// (16 px/deg, ~1.9 km/px) uncompressed 16-bit TIFF where
//   elevation_meters = (value - 20000) * 0.5   (relative to the 1737.4 km
// reference radius). The global LROC color map (public/moon/color.jpg) comes
// from the same kit: lroc_color_poles_4k.tif converted to JPEG.
//
// The moon's street-level rings are fixed at Tranquility Base, so unlike
// Earth (whose terrain streams at runtime for any roamed site) the ring
// heightfields are baked here once: for every ring vertex, project the
// site-local (east, north) meters gnomonically onto the sphere — the exact
// mapping ringGeometry() uses — and sample the DEM bilinearly. Heights are
// stored relative to the site's own elevation (the site is the datum).
//
// Usage: node scripts/generate-moon.mjs path/to/ldem_16_uint.tif
// Writes: public/moon/tranquility.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SITE_LAT = 0.6741; // Tranquility Base (Apollo 11), IAU Statio Tranquillitatis
const SITE_LON = 23.473;
const R_REF = 1.7374e6; // LOLA reference radius (m)
const RING_SIZES = [1024e3, 256e3, 64e3, 16e3];
const GRID = 48;

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/generate-moon.mjs path/to/ldem_16_uint.tif');
  process.exit(1);
}

// ---- minimal TIFF reader (uncompressed, one strip per row) ----
const buf = readFileSync(src);
const little = buf.readUInt16LE(0) === 0x4949;
const u16 = (o) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
const u32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
const ifd = u32(4);
const nTags = u16(ifd);
const tags = {};
for (let i = 0; i < nTags; i++) {
  const o = ifd + 2 + i * 12;
  tags[u16(o)] = { type: u16(o + 2), count: u32(o + 4), value: u32(o + 8) };
}
const W = tags[256].value;
const H = tags[257].value;
if (tags[259].value !== 1 || tags[258].value !== 16) throw new Error('expected uncompressed 16-bit TIFF');
const stripOff = tags[273];
const strip = (row) => (stripOff.count === 1 ? stripOff.value + row * W * 2 : u32(stripOff.value + row * 4));

// Elevation in meters relative to the reference radius, bilinear.
function elev(latDeg, lonDeg) {
  const x = (((((lonDeg + 180) / 360) % 1) + 1) % 1) * W - 0.5;
  const y = ((90 - latDeg) / 180) * H - 0.5;
  const x0 = Math.floor(x),
    y0 = Math.min(H - 2, Math.max(0, Math.floor(y)));
  const fx = x - x0,
    fy = y - y0;
  const at = (xx, yy) => (u16(strip(yy) + (((xx % W) + W) % W) * 2) - 20000) * 0.5;
  const t0 = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const t1 = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return t0 * (1 - fy) + t1 * fy;
}

// Site tangent basis (same convention as scene.ts fixedDir/fixedBasis).
const DEG = Math.PI / 180;
const dir = (lat, lon) => [Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)];
const up = dir(SITE_LAT * DEG, SITE_LON * DEG);
const eh = Math.hypot(up[0], up[2]);
const east = [up[2] / eh, 0, -up[0] / eh];
const north = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];

const siteElev = elev(SITE_LAT, SITE_LON);
const R_SITE = R_REF + siteElev; // the site IS the datum (like Earth's picnic)

const rings = RING_SIZES.map((S) => {
  const heights = [];
  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      const e = (i / GRID - 0.5) * S;
      const n = (j / GRID - 0.5) * S;
      // Gnomonic: the ring vertex sits where the ray through (e, R, n) in
      // site-local coordinates pierces the sphere — invert to lat/lon.
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

mkdirSync('public/moon', { recursive: true });
writeFileSync(
  'public/moon/tranquility.json',
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
console.log(`site elevation ${siteElev.toFixed(0)} m (LOLA, rel. 1737.4 km) · datum radius ${R_SITE.toFixed(0)} m`);
console.log(
  `rings ${RING_SIZES.map((s) => s / 1e3 + ' km').join(', ')} · height range ${Math.min(...all)}..${Math.max(...all)} m`,
);
