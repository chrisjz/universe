// Street-level Earth: stitches Esri World Imagery web-mercator tiles into
// one square texture per imagery ring. Each ring is sized in ground meters
// and centered on the picnic site; the right tile zoom is chosen so the
// stitched 1024² texture lands near the ring's native resolution.
//
// Imagery © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS
// User Community. Used with attribution per Esri's terms.

const TILE_URL = (z: number, y: number, x: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

const R_EARTH = 6.371e6;
const TEX = 1024;

function loadImage(url: string): Promise<ImageBitmap | null> {
  return fetch(url)
    .then((r) => (r.ok ? r.blob() : null))
    .then((b) => (b ? createImageBitmap(b) : null))
    .catch(() => null);
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
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(
        loadImage(TILE_URL(z, ty, tx)).then((img) => {
          if (!img) return;
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

// Streams ring textures largest-first (context first, detail as it lands).
export async function streamImageryRings(
  lat: number,
  lon: number,
  sizes: number[],
  onReady: (key: string, bmp: ImageBitmap) => Promise<void>,
): Promise<void> {
  for (let k = 0; k < sizes.length; k++) {
    const bmp = await buildPatchTexture(lat, lon, sizes[k]);
    if (bmp) await onReady(`ring${k}`, bmp);
  }
}
