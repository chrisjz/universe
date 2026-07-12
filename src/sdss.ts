// Streams the SDSS spectroscopic galaxy tiles (universe-data repo,
// scripts/generate-sdss.mjs): up to 2.6 million measured galaxies in
// redshift bands, placed at their true comoving depths through the
// atlas's own ΛCDM (cosmo.ts). The bundled 1-in-17 subsample stands in
// offline and in CI — the wedges keep their shape at 6% of the payload.
//
// The layer's geometry is honest the way the exoplanet layer is: SDSS
// mapped fans of sky from a point in it, so the data IS wedge-shaped,
// with the Sloan Great Wall crossing the northern one.

import { raDecToScene } from './sky';
import { comovingM } from './cosmo';

export interface SdssBand {
  instances: Float32Array<ArrayBuffer>;
  count: number;
}

function unpack(buf: ArrayBuffer): SdssBand {
  const view = new DataView(buf);
  const n = Math.floor(view.byteLength / 12);
  const out = new Float32Array(n * 8);
  for (let i = 0; i < n; i++) {
    const o = i * 12;
    const ra = view.getFloat32(o, true);
    const dec = view.getFloat32(o + 4, true);
    const z = view.getFloat32(o + 8, true);
    const dir = raDecToScene(ra, dec);
    const d = comovingM(z);
    const j = i * 8;
    out[j] = dir[0] * d;
    out[j + 1] = dir[1] * d;
    out[j + 2] = dir[2] * d;
    // No photometry in the tiles: size and tint are a legend. A mild
    // deterministic jitter keeps the field from reading as a stamp.
    const h = ((i * 2654435761) % 89) / 89;
    out[j + 3] = 4e20 * (0.5 + 0.7 * h);
    out[j + 4] = 0.72 + 0.14 * h;
    out[j + 5] = 0.78 + 0.1 * h;
    out[j + 6] = 1.0;
    // Deliberately faint: the layer's brightness is its DENSITY — the
    // main sample packs hundreds of galaxies per pixel at cosmic zoom,
    // and per-sprite intensity above ~0.015 washes the wedges to white.
    out[j + 7] = 0.012 + 0.014 * h;
  }
  return { instances: out, count: n };
}

// Streams bands nearest-first, invoking onBand as each lands. Falls back
// to the bundled subsample when the tile host is unreachable. Returns the
// total galaxy count.
export async function streamSdss(
  dataRoot: string,
  fallbackUrl: string,
  onBand: (band: SdssBand) => void,
): Promise<number> {
  let total = 0;
  // Phones get the bundled 1-in-17 subsample directly: 2.6M sprites at
  // cosmic zoom cost ~half the frame budget on a desktop GPU, and the
  // subsample preserves the wedges' structure at 6% of the cost.
  const phone = navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) < 900;
  try {
    if (phone) throw new Error('subsample tier');
    const res = await fetch(`${dataRoot}sdss/manifest.json`);
    if (!res.ok) throw new Error('no manifest');
    const manifest = (await res.json()) as { bands: { file: string; count: number }[] };
    for (const b of manifest.bands) {
      const t = await fetch(`${dataRoot}sdss/${b.file}`);
      if (!t.ok) continue;
      const band = unpack(await t.arrayBuffer());
      onBand(band);
      total += band.count;
    }
  } catch {
    /* fall through to the bundled subsample */
  }
  if (total > 0) return total;
  try {
    const res = await fetch(fallbackUrl);
    if (!res.ok) return 0;
    const band = unpack(await res.arrayBuffer());
    onBand(band);
    total = band.count;
  } catch {
    /* offline: the procedural web still stands where the mask is empty */
  }
  return total;
}
