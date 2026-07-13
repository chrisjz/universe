// The Magellanic Clouds, star by measured star: Gaia DR3 resolves the
// LMC and SMC into individual members (proper-motion-selected — see
// scripts/generate-magellanic.mjs), so unlike the procedural Milky Way
// disk, these two galaxies are drawn from data. The bar of the LMC and
// the Wing of the SMC are simply where the stars are.
//
// Honesty: sky positions, brightnesses, and colors are measured. Gaia
// cannot measure individual distances at 50 kpc, so every star sits at
// its Cloud's eclipsing-binary distance — LMC 49.59 kpc (Pietrzyński
// et al. 2019, a 1% measurement), SMC 62.44 kpc (Graczyk et al. 2020) —
// with a stylized line-of-sight depth of roughly the real body's
// thickness. The layer is amber under the honest seam for exactly that
// dimension.

import { raDecToScene } from './sky';
import { V3 } from './math';

const KPC = 3.0857e19;

export interface Cloud {
  name: string;
  slug: string;
  file: string;
  ra: number;
  dec: number;
  distM: number;
  radiusM: number; // for the fly-to target
  depthM: number; // stylized 1σ line-of-sight thickness
  posM: V3; // the Cloud's center, scene meters (group origin + LOD anchor)
}

export const CLOUDS: Cloud[] = [
  {
    name: 'LARGE MAGELLANIC CLOUD',
    slug: 'lmc',
    file: 'lmc.bin',
    ra: 81.28,
    dec: -69.78,
    distM: 49.59 * KPC,
    radiusM: 1.6e20, // ~5.2 kpc — the visible disk
    depthM: 1.4 * KPC,
    posM: [0, 0, 0],
  },
  {
    name: 'SMALL MAGELLANIC CLOUD',
    slug: 'smc',
    file: 'smc.bin',
    ra: 13.19,
    dec: -72.83,
    distM: 62.44 * KPC,
    radiusM: 8e19,
    depthM: 1.8 * KPC, // the SMC is genuinely deep along the sight line
    posM: [0, 0, 0],
  },
];
for (const c of CLOUDS) {
  const d = raDecToScene(c.ra, c.dec);
  c.posM = [d[0] * c.distM, d[1] * c.distM, d[2] * c.distM];
}

// BP−RP → a warm-to-blue ramp (blackbody-ish; the tiles carry the real
// measured color index).
function tint(c: number): [number, number, number] {
  const t = Math.min(Math.max((c - 0.2) / 2.0, 0), 1); // 0 blue … 1 red
  return [0.62 + 0.38 * t, 0.72 + 0.1 * (1 - Math.abs(t - 0.5) * 2), 1.0 - 0.55 * t];
}

export async function loadCloud(dataRoot: string, cloud: Cloud): Promise<Float32Array<ArrayBuffer> | null> {
  let view: DataView;
  try {
    const res = await fetch(`${dataRoot}magellanic/${cloud.file}`);
    if (!res.ok) return null;
    view = new DataView(await res.arrayBuffer());
  } catch {
    return null; // offline / not yet deployed: the Clouds sit this one out
  }
  const n = Math.floor(view.byteLength / 12);
  const out = new Float32Array(n * 8);
  const dir = raDecToScene(cloud.ra, cloud.dec);
  for (let i = 0; i < n; i++) {
    const o = i * 12;
    const ra = view.getFloat32(o, true);
    const dec = view.getFloat32(o + 4, true);
    const g = view.getUint8(o + 8) / 16 + 10;
    const c = view.getUint8(o + 9) / 64 - 1;
    const sdir = raDecToScene(ra, dec);
    // Stylized depth: a deterministic gaussian-ish jitter along the line
    // of sight, at the real body's approximate thickness.
    const h1 = ((i * 2654435761) % 8191) / 8191;
    const h2 = ((i * 1597334677) % 8191) / 8191;
    const depth = (h1 + h2 - 1) * cloud.depthM * 1.6;
    const d = cloud.distM + depth;
    const j = i * 8;
    // Relative to the Cloud's center: the group origin (posM) carries the
    // 50 kpc; instance floats stay ~1e20, kinder to f32 and to the
    // per-sprite near-fade when the camera is inside the Cloud.
    out[j] = sdir[0] * d - cloud.posM[0];
    out[j + 1] = sdir[1] * d - cloud.posM[1];
    out[j + 2] = sdir[2] * d - cloud.posM[2];
    // Physical sprite scale from absolute magnitude (all at ~the Cloud's
    // distance): M = G − 5·log10(d/10 pc); L-ish sizing like the catalog.
    const absMag = g - 5 * Math.log10(cloud.distM / (10 * 3.0857e16));
    const lum = Math.pow(10, -0.4 * (absMag - 4.83));
    out[j + 3] = Math.min(Math.max(6.957e8 * Math.sqrt(lum), 5e8), 4e10);
    const [r, gg, b] = tint(c);
    out[j + 4] = r;
    out[j + 5] = gg;
    out[j + 6] = b;
    // Faint on purpose: a million members overlap hundreds deep in the
    // bar, and the structure IS the density — per-star intensity above
    // ~0.1 washes the Cloud to a white blob.
    out[j + 7] = Math.min(Math.max(0.1 - 0.005 * g, 0.008), 0.05);
    void dir;
  }
  return out;
}
