// Street-level Earth: stitches Esri World Imagery web-mercator tiles into
// one square texture per imagery ring, and samples real elevation for the
// ring vertices from the Terrain Tiles open dataset on AWS (Mapzen
// "terrarium" encoding: SRTM, GMTED2010, ETOPO1 et al.). Each ring is sized
// in ground meters and centered on the picnic site; the right tile zoom is
// chosen so the stitched texture lands near the ring's native resolution.
//
// Imagery © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS
// User Community. Used with attribution per Esri's terms.

const TILE_URL = (z: number, y: number, x: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const DEM_URL = (z: number, y: number, x: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const R_EARTH = 6.371e6;
const TEX = 1024;

function loadImage(url: string, retried = false): Promise<ImageBitmap | null> {
  return fetch(url)
    .then((r) => (r.ok ? r.blob() : null))
    .then((b) => (b ? createImageBitmap(b) : null))
    .catch(() => (retried ? null : loadImage(url, true))); // one retry: transient drops, not 404s
}

// Esri has no deep-zoom imagery over open ocean, but instead of a 404 it
// serves an HTTP 200 placeholder: a uniform ~rgb(204) grey stamped "Map
// data not yet available" (user-reported as grey squares mid-Pacific).
// Only the pixels can tell — an 8x8 downsample of real imagery is never
// a flat neutral grey, so a tight uniformity test is safe.
const sniff = new OffscreenCanvas(16, 16);
const sniffCtx = sniff.getContext('2d', { willReadFrequently: true })!;
function isPlaceholder(img: ImageBitmap): boolean {
  sniffCtx.clearRect(0, 0, 16, 16);
  sniffCtx.drawImage(img, 0, 0, 16, 16);
  const d = sniffCtx.getImageData(0, 0, 16, 16).data;
  let near = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    // Any decidedly colorful or dark pixel means real imagery. Measured
    // in-browser: the placeholder decodes at chroma <= 17 (JPEG
    // subsampling), field 202-213, text to 252; real open ocean is
    // chroma ~35 at brightness ~10.
    if (Math.abs(g - r) > 24 || Math.abs(b - r) > 24 || r < 185) return false;
    if (Math.abs(r - 204) <= 8) near++;
  }
  // Mostly the flat 204 field (snow and cloud tiles are bright, not 204).
  return near >= 154; // 60% of 256
}

// Builds the stitched texture for a ring of `sizeMeters` centered at lat/lon.
async function buildPatchTexture(lat: number, lon: number, sizeMeters: number): Promise<ImageBitmap | null> {
  const phi = (lat * Math.PI) / 180;
  // Normalized web-mercator coords of the center.
  const mx0 = (lon + 180) / 360;
  const my0 = (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
  // Ground meters per mercator unit at this latitude (conformal: same x/y).
  const metersPerMerc = 2 * Math.PI * R_EARTH * Math.cos(phi);
  const dm = sizeMeters / metersPerMerc; // patch extent in mercator units
  // Zoom so the patch spans ~TEX pixels of tile imagery.
  const z = Math.min(19, Math.max(3, Math.round(Math.log2(TEX / 256 / dm))));
  const worldPx = 256 * Math.pow(2, z);
  const left = (mx0 - dm / 2) * worldPx;
  const top = (my0 - dm / 2) * worldPx;
  const patchPx = dm * worldPx;

  const canvas = new OffscreenCanvas(TEX, TEX);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(TEX / patchPx, TEX / patchPx);
  const tx0 = Math.floor(left / 256),
    tx1 = Math.floor((left + patchPx) / 256);
  const ty0 = Math.floor(top / 256),
    ty1 = Math.floor((top + patchPx) / 256);
  const jobs: Promise<void>[] = [];
  let loaded = 0;
  // Web mercator's world: x wraps at the antimeridian, y simply ends at
  // +-85.05 deg — rows outside [0, 2^z) do not exist (a polar bookmark
  // once fired 52 requests for tiles like /1/0/-2.png).
  const nTiles = Math.pow(2, z);
  for (let ty = Math.max(0, ty0); ty <= Math.min(nTiles - 1, ty1); ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const col = ((tx % nTiles) + nTiles) % nTiles;
      jobs.push(
        loadImage(TILE_URL(z, ty, col)).then((img) => {
          if (!img) return;
          if (isPlaceholder(img)) {
            img.close();
            return; // leave the hole transparent: the ring below shows through
          }
          ctx.drawImage(img, tx * 256 - left, ty * 256 - top);
          img.close();
          loaded++;
        }),
      );
    }
  }
  await Promise.all(jobs);
  if (loaded === 0) return null; // offline / blocked: keep procedural ground
  return createImageBitmap(canvas);
}

// Samples real elevation for a ring's vertex grid. The ring geometry is a
// gnomonic (GRID+1)² net around the site (local x = east meters, z = north
// meters on the tangent plane, projected to the sphere); each vertex is
// converted to its exact lat/lon, then sampled bilinearly from terrarium
// tiles stitched at a zoom matching the ring's cell size. Heights are
// returned RELATIVE to the site's own elevation (the picnic stays the
// engine's datum) and floored at `waterLevel` (meters above sea level) so
// lake/ocean bathymetry doesn't carve the water surface into a bowl.
// Returns null offline so callers keep the smooth sphere.
export async function fetchRingHeights(
  lat: number,
  lon: number,
  sizeMeters: number,
  grid: number,
  waterLevel: number,
): Promise<Float32Array | null> {
  if (Math.abs(lat) > 84) return null; // beyond the mercator DEM's world
  const phi = (lat * Math.PI) / 180;
  const lam = (lon * Math.PI) / 180;
  // Site tangent basis in geocentric coordinates.
  const up = [Math.cos(phi) * Math.cos(lam), Math.sin(phi), Math.cos(phi) * Math.sin(lam)];
  const east = [-Math.sin(lam), 0, Math.cos(lam)];
  const north = [-Math.sin(phi) * Math.cos(lam), Math.cos(phi), -Math.sin(phi) * Math.sin(lam)];

  // Mercator coords (normalized [0,1]) of every vertex, plus the site.
  const n1 = grid + 1;
  const mx = new Float64Array(n1 * n1);
  const my = new Float64Array(n1 * n1);
  const toMerc = (gx: number, gz: number, out: { x: number; y: number }) => {
    const nx = gx / R_EARTH;
    const nz = gz / R_EARTH;
    const dl = Math.hypot(nx, 1, nz);
    const dx = (east[0] * nx + up[0] + north[0] * nz) / dl;
    const dy = (east[1] * nx + up[1] + north[1] * nz) / dl;
    const dz = (east[2] * nx + up[2] + north[2] * nz) / dl;
    const vlat = Math.asin(Math.max(-1, Math.min(1, dy)));
    const vlon = Math.atan2(dz, dx);
    out.x = (vlon / Math.PI + 1) / 2;
    out.y = (1 - Math.log(Math.tan(vlat) + 1 / Math.cos(vlat)) / Math.PI) / 2;
  };
  const pt = { x: 0, y: 0 };
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (let j = 0; j < n1; j++) {
    for (let i = 0; i < n1; i++) {
      toMerc((i / grid - 0.5) * sizeMeters, (j / grid - 0.5) * sizeMeters, pt);
      mx[j * n1 + i] = pt.x;
      my[j * n1 + i] = pt.y;
      x0 = Math.min(x0, pt.x);
      x1 = Math.max(x1, pt.x);
      y0 = Math.min(y0, pt.y);
      y1 = Math.max(y1, pt.y);
    }
  }
  toMerc(0, 0, pt);
  const cx = pt.x,
    cy = pt.y;

  // Zoom so the patch spans ~512 tile pixels (terrarium tops out near z15;
  // z13 already beats the big rings' vertex spacing).
  const dm = Math.max(x1 - x0, y1 - y0);
  const z = Math.min(13, Math.max(0, Math.round(Math.log2(512 / 256 / dm))));
  const worldPx = 256 * Math.pow(2, z);
  const left = Math.floor(x0 * worldPx) - 1;
  const top = Math.floor(y0 * worldPx) - 1;
  const w = Math.min(2048, Math.ceil(x1 * worldPx) - left + 2);
  const h = Math.min(2048, Math.ceil(y1 * worldPx) - top + 2);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false; // exact pixels — heights, not colors
  const jobs: Promise<void>[] = [];
  let loaded = 0;
  const nDem = Math.pow(2, z); // same mercator world: clamp rows, wrap columns
  for (let ty = Math.max(0, Math.floor(top / 256)); ty * 256 < top + h && ty < nDem; ty++) {
    for (let tx = Math.floor(left / 256); tx * 256 < left + w; tx++) {
      const col = ((tx % nDem) + nDem) % nDem;
      jobs.push(
        loadImage(DEM_URL(z, ty, col)).then((img) => {
          if (!img) return;
          ctx.drawImage(img, tx * 256 - left, ty * 256 - top);
          img.close();
          loaded++;
        }),
      );
    }
  }
  await Promise.all(jobs);
  if (loaded === 0) return null;
  const px = ctx.getImageData(0, 0, w, h).data;

  // Bilinear sample of the terrarium encoding: (R·256 + G + B/256) − 32768.
  const sample = (u: number, v: number): number => {
    const fx = Math.min(w - 1.001, Math.max(0, u * worldPx - left - 0.5));
    const fy = Math.min(h - 1.001, Math.max(0, v * worldPx - top - 0.5));
    const ix = Math.floor(fx),
      iy = Math.floor(fy);
    const ax = fx - ix,
      ay = fy - iy;
    const at = (xx: number, yy: number) => {
      const o = (yy * w + xx) * 4;
      return px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768;
    };
    const t0 = at(ix, iy) * (1 - ax) + at(ix + 1, iy) * ax;
    const t1 = at(ix, iy + 1) * (1 - ax) + at(ix + 1, iy + 1) * ax;
    return t0 * (1 - ay) + t1 * ay;
  };

  const h0 = Math.max(sample(cx, cy), waterLevel);
  const out = new Float32Array(n1 * n1);
  for (let k = 0; k < n1 * n1; k++) out[k] = Math.max(sample(mx[k], my[k]), waterLevel) - h0;
  return out;
}

// Streams ring textures largest-first (context first, detail as it lands).
// `keys` names each ring's texture (free roaming stamps them per site
// generation so stale streams can be dropped); defaults to ring0..N.
export async function streamImageryRings(
  lat: number,
  lon: number,
  sizes: number[],
  onReady: (key: string, bmp: ImageBitmap) => Promise<void>,
  keys?: string[],
): Promise<void> {
  // Past ~84 deg the mercator patch math degenerates (85.05 is the map's
  // edge) and Esri has no polar imagery anyway: keep the honest globe.
  if (Math.abs(lat) > 84) return;
  for (let k = 0; k < sizes.length; k++) {
    const bmp = await buildPatchTexture(lat, lon, sizes[k]);
    if (bmp) await onReady(keys?.[k] ?? `ring${k}`, bmp);
  }
}

// ---- Street-level Moon & Mars: global mosaics via NASA Trek ----
// Trek serves plain equirectangular WMTS (EPSG:104903): zoom z is a
// 2·2^z × 2^z grid of 256 px tiles from (-180°, 90°).
// Moon: LRO WAC mosaic, max z = 8 (~83 m/px) — NASA/GSFC/ASU.
// Mars: Viking MDIM 2.1 color mosaic, max z = 7 (~326 m/px) — NASA/JPL/USGS.
interface TrekBody {
  url: (z: number, row: number, col: number) => string;
  radius: number; // equatorial, meters
  maxZ: number;
  key: string; // texture key prefix (`${key}${ringIndex}`)
}
const TREK_MOON: TrekBody = {
  url: (z, row, col) =>
    `https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/${z}/${row}/${col}.jpg`,
  radius: 1.7374e6,
  maxZ: 8,
  key: 'moonring',
};
const TREK_MARS: TrekBody = {
  url: (z, row, col) =>
    `https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/${z}/${row}/${col}.jpg`,
  radius: 3.3895e6,
  maxZ: 7,
  key: 'marsring',
};

// Builds one stitched square texture of `sizeMeters` around lat/lon.
// Equirectangular is not conformal, but at low site latitudes the x-stretch
// is cos(lat) — corrected here — and a gnomonic-to-plate-carrée mapping is
// accurate to well under a tile pixel across even the 1024 km ring.
async function buildTrekPatch(
  body: TrekBody,
  lat: number,
  lon: number,
  sizeMeters: number,
): Promise<ImageBitmap | null> {
  const degPerMeter = 180 / (Math.PI * body.radius);
  const dLon = (sizeMeters * degPerMeter) / Math.cos((lat * Math.PI) / 180);
  const dLat = sizeMeters * degPerMeter;
  // Zoom so the patch spans ~TEX pixels of source tiles.
  const z = Math.min(body.maxZ, Math.max(0, Math.round(Math.log2((TEX * 180) / 256 / dLat))));
  const rows = Math.pow(2, z); // tiles per 180° of latitude
  const pxPerDeg = (rows * 256) / 180;
  const left = (lon - dLon / 2 + 180) * pxPerDeg;
  const top = (90 - lat - dLat / 2) * pxPerDeg;
  const wPx = dLon * pxPerDeg,
    hPx = dLat * pxPerDeg;
  const canvas = new OffscreenCanvas(TEX, TEX);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(TEX / wPx, TEX / hPx);
  const tx0 = Math.floor(left / 256),
    tx1 = Math.floor((left + wPx) / 256);
  const ty0 = Math.max(0, Math.floor(top / 256)),
    ty1 = Math.min(rows - 1, Math.floor((top + hPx) / 256));
  const jobs: Promise<void>[] = [];
  let loaded = 0;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const col = ((tx % (2 * rows)) + 2 * rows) % (2 * rows); // wrap the antimeridian
      jobs.push(
        loadImage(body.url(z, ty, col)).then((img) => {
          if (!img) return;
          ctx.drawImage(img, tx * 256 - left, ty * 256 - top);
          img.close();
          loaded++;
        }),
      );
    }
  }
  await Promise.all(jobs);
  if (loaded === 0) return null;
  return createImageBitmap(canvas);
}

async function streamTrekRings(
  body: TrekBody,
  lat: number,
  lon: number,
  sizes: number[],
  onReady: (key: string, bmp: ImageBitmap) => Promise<void>,
  keys?: string[], // roam re-anchors stamp generation keys; default ring0..N
): Promise<void> {
  for (let k = 0; k < sizes.length; k++) {
    const bmp = await buildTrekPatch(body, lat, lon, sizes[k]);
    if (bmp) await onReady(keys?.[k] ?? `${body.key}${k}`, bmp);
  }
}

export const streamMoonRings = (
  lat: number,
  lon: number,
  sizes: number[],
  onReady: (key: string, bmp: ImageBitmap) => Promise<void>,
  keys?: string[],
): Promise<void> => streamTrekRings(TREK_MOON, lat, lon, sizes, onReady, keys);

export const streamMarsRings = (
  lat: number,
  lon: number,
  sizes: number[],
  onReady: (key: string, bmp: ImageBitmap) => Promise<void>,
  keys?: string[],
): Promise<void> => streamTrekRings(TREK_MARS, lat, lon, sizes, onReady, keys);
