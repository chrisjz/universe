// Streams the binary star tiles produced by scripts/generate-star-tiles.mjs.
// Chunks are brightest-first; each is decoded into point-sprite instance data
// (pos, size, color, intensity — 8 floats/star) and handed over as it lands,
// so the sky fills in progressively without blocking startup.

import { orientSky } from './sky';
import { BRIGHT_STARS } from './data/brightstars';

const R_SUN = 6.957e8;
const PC = 3.0857e16;

// Catalog dedupe: every one of the named HYG stars also exists in the ATHYG
// tiles, at slightly different measured coordinates. The two copies can sit
// 1e13 m apart even when the catalogs agree well (an 0.001° angular epsilon
// is huge at 500 ly), and light-years apart when they don't (Xamidimura's
// distances disagree 3.5x) — so near a named-star destination its ATHYG
// twin hung as a separate, f32-jittering glow. Tile stars within 0.03° of a
// named star's direction are dropped: the named sprite already renders
// there, and at magnitude ≤ 11 that cone loses ~a dozen genuine stars out
// of 854k. Both catalogs share the pre-orientation convention, so the
// directions compare raw. Named stars are bright, so only the first
// (brightest) chunk needs the check.
const NAMED_DIRS: number[] = [];
for (const [x, y, z, , , , name] of BRIGHT_STARS) {
  if (!name) continue;
  const l = Math.hypot(x, y, z);
  NAMED_DIRS.push(x / l, y / l, z / l);
}
const COS_DEDUPE = Math.cos((0.03 * Math.PI) / 180);

function isNamedDuplicate(x: number, y: number, z: number): boolean {
  const l = Math.hypot(x, y, z);
  const ux = x / l,
    uy = y / l,
    uz = z / l;
  for (let k = 0; k < NAMED_DIRS.length; k += 3) {
    if (ux * NAMED_DIRS[k] + uy * NAMED_DIRS[k + 1] + uz * NAMED_DIRS[k + 2] > COS_DEDUPE) return true;
  }
  return false;
}

interface ManifestChunk {
  file: string;
  count: number;
  dir?: number[]; // tile bounding-cone axis (pre-orientation convention)
  ang?: number; // cone half-angle, radians
  fade?: number; // far-fade extent override (faint bands fade sooner)
}

interface Manifest {
  total: number;
  stride?: number; // 16 = v1 (static), 22 = v2 (+ int16 Gm/yr 3D velocity)
  chunks: ManifestChunk[];
}

export interface StarChunkMeta {
  cone: { dir: [number, number, number]; ang: number } | null;
  fade: number;
}

function decodeChunk(view: DataView, dedupe: boolean, stride: number): Float32Array<ArrayBuffer> {
  const n = Math.floor(view.byteLength / stride);
  const out = new Float32Array(n * 11);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    const rx = view.getFloat32(o, true);
    const ry = view.getFloat32(o + 4, true);
    const rz = view.getFloat32(o + 8, true);
    if (dedupe && isNamedDuplicate(rx, ry, rz)) continue;
    // Tiles store the pre-orientation convention; rotate into the true sky.
    const [x, y, z] = orientSky(rx, ry, rz);
    const absMag = view.getUint8(o + 15) / 8 - 15;
    const distPc = Math.max(Math.hypot(x, y, z) / PC, 0.1);
    const appMag = absMag + 5 * (Math.log10(distPc) - 1);
    const lum = Math.pow(10, (4.83 - absMag) / 2.5);
    out[j] = x;
    out[j + 1] = y;
    out[j + 2] = z;
    out[j + 3] = Math.min(Math.max(R_SUN * Math.sqrt(lum), 4e8), 2e11);
    out[j + 4] = view.getUint8(o + 12) / 255;
    out[j + 5] = view.getUint8(o + 13) / 255;
    out[j + 6] = view.getUint8(o + 14) / 255;
    // Sprites are floored at ~3 px, so intensity is the only brightness
    // control left for faint stars. The 0.02 floor tuned for the 854k
    // bright set would wash the sky times-eight under the 5.9M-star Gaia
    // band — below mag 11 the floor decays flux-like instead, so the
    // faint millions read as the Milky Way's grain, not a gray veil.
    const floor = appMag <= 11 ? 0.02 : 0.02 * Math.pow(10, -0.32 * (appMag - 11));
    out[j + 7] = Math.min(Math.max(1.35 - 0.3 * appMag, floor), 2.0);
    // v2 tiles carry the star's real 3D space velocity (int16 Gm/yr),
    // rotated into the true sky with the position; v1 tiles are at rest.
    if (stride >= 22) {
      const [vx, vy, vz] = orientSky(
        view.getInt16(o + 16, true) * 1e9,
        view.getInt16(o + 18, true) * 1e9,
        view.getInt16(o + 20, true) * 1e9,
      );
      out[j + 8] = vx;
      out[j + 9] = vy;
      out[j + 10] = vz;
    }
    j += 11;
  }
  return out.subarray(0, j);
}

function chunkMeta(chunk: ManifestChunk): StarChunkMeta {
  let cone: StarChunkMeta['cone'] = null;
  if (chunk.dir && chunk.ang !== undefined) {
    const [x, y, z] = orientSky(chunk.dir[0], chunk.dir[1], chunk.dir[2]);
    cone = { dir: [x, y, z], ang: chunk.ang };
  }
  return { cone, fade: chunk.fade ?? 6e18 };
}

export async function streamStars(
  baseUrl: string,
  onChunk: (instances: Float32Array<ArrayBuffer>, meta: StarChunkMeta) => void,
): Promise<number> {
  let manifest: Manifest;
  try {
    const res = await fetch(`${baseUrl}manifest.json`);
    if (!res.ok) return 0;
    manifest = (await res.json()) as Manifest;
  } catch {
    return 0; // no tiles available (e.g. not generated yet) — not fatal
  }

  let loaded = 0;
  const stride = manifest.stride ?? 16;
  // First chunk alone (it runs the named-star dedupe and anchors the bright
  // sky immediately); the rest stream through a small fetch pool.
  const [head, ...rest] = manifest.chunks;
  if (!head) return 0;
  try {
    const res = await fetch(`${baseUrl}${head.file}`);
    if (!res.ok) return 0;
    const inst = decodeChunk(new DataView(await res.arrayBuffer()), true, stride);
    onChunk(inst, chunkMeta(head));
    loaded += inst.length / 11;
  } catch {
    return 0;
  }
  const POOL = 6;
  let next = 0;
  await Promise.all(
    Array.from({ length: POOL }, async () => {
      for (;;) {
        const mine = next++;
        if (mine >= rest.length) return;
        const chunk = rest[mine];
        try {
          const res = await fetch(`${baseUrl}${chunk.file}`);
          if (!res.ok) continue;
          const inst = decodeChunk(new DataView(await res.arrayBuffer()), false, stride);
          onChunk(inst, chunkMeta(chunk));
          loaded += inst.length / 11;
        } catch {
          // one lost tile shouldn't sink the sky
        }
      }
    }),
  );
  return loaded;
}
