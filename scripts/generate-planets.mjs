// Bakes the real planet faces and Saturn's rings.
//
// Sources (all NASA, public domain):
//   Mars    — Viking MDIM 2.1 colorized global mosaic, via NASA Mars Trek
//             WMTS (Mars_Viking_MDIM21_ClrMosaic_global_232m), stitched at
//             zoom 3 (4096x2048) and downsampled.
//   Mercury — MESSENGER MDIS basemap (BDR mosaic), via NASA Mercury Trek.
//   Jupiter — Cassini's cylindrical map (PIA07782, Dec 2000 flyby), from
//             the NASA Image Library.
//   Rings   — Cassini's natural-color radial scan "Expanse of Ice"
//             (PIA08389): radius increases left to right at ~6 km/px. The
//             absolute radii are calibrated on the A ring's sharp outer
//             edge (136,780 km), then the scan is resampled into a fixed
//             [74,500 .. 140,500] km strip. Color is measured; the alpha
//             channel (transparency) is derived from brightness — real
//             radial structure, stylized opacity (prov 0.5).
//
// Image decoding/compositing runs in headless Chrome via puppeteer-core
// (no native image libs in the repo); network stays in Node.
//
// Usage: node scripts/generate-planets.mjs
// Writes: public/planets/{mars,mercury,jupiter}.jpg, public/planets/rings.png

import { writeFileSync, mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const Z = 3; // Trek zoom: 16x8 tiles of 256px = 4096x2048
const OUT_W = 2048,
  OUT_H = 1024;
const RING_TEX_W = 1024;
export const RING_R_IN = 74500e3; // meters — keep in sync with scene.ts
export const RING_R_OUT = 140500e3;

const TREK = (body, layer, z, row, col) =>
  `https://trek.nasa.gov/tiles/${body}/EQ/${layer}/1.0.0/default/default028mm/${z}/${row}/${col}.jpg`;

async function fetchB64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

async function trekTiles(body, layer) {
  const rows = 2 ** Z,
    cols = 2 ** (Z + 1);
  const tiles = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) tiles.push({ r, c, p: fetchB64(TREK(body, layer, Z, r, c)) });
  for (const t of tiles) t.b64 = await t.p;
  console.log(`${body}: ${tiles.length} tiles`);
  return tiles;
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const page = await browser.newPage();
mkdirSync('public/planets', { recursive: true });

// ---- Mars & Mercury: stitch Trek tiles, downsample, save ----
for (const [name, body, layer] of [
  ['mars', 'Mars', 'Mars_Viking_MDIM21_ClrMosaic_global_232m'],
  ['mercury', 'Mercury', 'Mercury_MESSENGER_MDIS_Basemap_BDR_Mosaic_Global_166m'],
]) {
  const tiles = await trekTiles(body, layer);
  const dataUrl = await page.evaluate(
    async (tiles, OUT_W, OUT_H) => {
      const canvas = new OffscreenCanvas(OUT_W, OUT_H);
      const ctx = canvas.getContext('2d');
      const sc = OUT_W / (256 * 16);
      for (const t of tiles) {
        const blob = await (await fetch(`data:image/jpeg;base64,${t.b64}`)).blob();
        const img = await createImageBitmap(blob);
        ctx.drawImage(img, t.c * 256 * sc, t.r * 256 * sc, 256 * sc, 256 * sc);
        img.close();
      }
      const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      return new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(out);
      });
    },
    tiles.map(({ r, c, b64 }) => ({ r, c, b64 })),
    OUT_W,
    OUT_H,
  );
  writeFileSync(`public/planets/${name}.jpg`, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`wrote public/planets/${name}.jpg`);
}

// ---- Jupiter: PIA07782 resampled to 2048x1024 ----
{
  const b64 = await fetchB64('https://images-assets.nasa.gov/image/PIA07782/PIA07782~orig.jpg');
  const dataUrl = await page.evaluate(
    async (b64, OUT_W, OUT_H) => {
      const blob = await (await fetch(`data:image/jpeg;base64,${b64}`)).blob();
      const img = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(OUT_W, OUT_H);
      canvas.getContext('2d').drawImage(img, 0, 0, OUT_W, OUT_H);
      const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      return new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(out);
      });
    },
    b64,
    OUT_W,
    OUT_H,
  );
  writeFileSync('public/planets/jupiter.jpg', Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote public/planets/jupiter.jpg');
}

// ---- Saturn's rings: calibrate the radial scan, bake color+alpha strip ----
{
  const b64 = await fetchB64('https://images-assets.nasa.gov/image/PIA08389/PIA08389~orig.jpg');
  const result = await page.evaluate(
    async (b64, RING_TEX_W, R_IN_KM, R_OUT_KM) => {
      const blob = await (await fetch(`data:image/jpeg;base64,${b64}`)).blob();
      const img = await createImageBitmap(blob);
      const W = img.width,
        H = img.height;
      const canvas = new OffscreenCanvas(W, H);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      // Average the middle half of the rows into one radial RGB profile.
      const px = ctx.getImageData(0, Math.floor(H / 4), W, Math.floor(H / 2)).data;
      const rows = Math.floor(H / 2);
      const prof = new Float64Array(W * 3);
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < W; x++) {
          const o = (y * W + x) * 4;
          prof[x * 3] += px[o];
          prof[x * 3 + 1] += px[o + 1];
          prof[x * 3 + 2] += px[o + 2];
        }
      for (let i = 0; i < prof.length; i++) prof[i] /= rows;
      const lum = (x) => (prof[x * 3] + prof[x * 3 + 1] + prof[x * 3 + 2]) / 3;
      // A ring outer edge = 136,780 km: rightmost x where a >=40px run to
      // the LEFT stays bright (skips the thin F ring line further right).
      let aOut = -1;
      for (let x = W - 1; x > 60; x--) {
        let ok = lum(x) > 40;
        for (let k = 1; ok && k <= 40; k++) if (lum(x - k) <= 40) ok = false;
        if (ok) {
          aOut = x;
          break;
        }
      }
      const kmPerPx = 6; // from the PIA08389 caption
      const rAtX = (x) => 136780 + (x - aOut) * kmPerPx;
      // Resample into the fixed [R_IN..R_OUT] strip; alpha from brightness.
      const strip = new OffscreenCanvas(RING_TEX_W, 1);
      const sctx = strip.getContext('2d');
      const od = sctx.createImageData(RING_TEX_W, 1);
      for (let i = 0; i < RING_TEX_W; i++) {
        const rKm = R_IN_KM + ((i + 0.5) / RING_TEX_W) * (R_OUT_KM - R_IN_KM);
        const x = Math.round(aOut + (rKm - 136780) / kmPerPx);
        if (x < 0 || x >= W) continue; // outside the scan: transparent
        const l = lum(x);
        const a = Math.min(1, Math.pow(l / 150, 0.85)); // brightness -> opacity
        od.data[i * 4] = prof[x * 3];
        od.data[i * 4 + 1] = prof[x * 3 + 1];
        od.data[i * 4 + 2] = prof[x * 3 + 2];
        od.data[i * 4 + 3] = Math.round(a * 255);
      }
      sctx.putImageData(od, 0, 0);
      const out = await strip.convertToBlob({ type: 'image/png' });
      const dataUrl = await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(out);
      });
      return { dataUrl, aOut, rLeft: rAtX(0), rRight: rAtX(W - 1) };
    },
    b64,
    RING_TEX_W,
    RING_R_IN / 1e3,
    RING_R_OUT / 1e3,
  );
  writeFileSync('public/planets/rings.png', Buffer.from(result.dataUrl.split(',')[1], 'base64'));
  console.log(
    `wrote public/planets/rings.png — scan covers ${Math.round(result.rLeft)}..${Math.round(result.rRight)} km (A-ring edge at px ${result.aOut})`,
  );
}

await browser.close();
