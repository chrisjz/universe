// Streams the binary star tiles produced by scripts/generate-star-tiles.mjs.
// Chunks are brightest-first; each is decoded into point-sprite instance data
// (pos, size, color, intensity — 8 floats/star) and handed over as it lands,
// so the sky fills in progressively without blocking startup.

const R_SUN = 6.957e8;
const PC = 3.0857e16;

interface Manifest {
  total: number;
  chunks: { file: string; count: number }[];
}

export async function streamStars(
  baseUrl: string,
  onChunk: (instances: Float32Array<ArrayBuffer>) => void,
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
  for (const chunk of manifest.chunks) {
    const res = await fetch(`${baseUrl}${chunk.file}`);
    if (!res.ok) break;
    const view = new DataView(await res.arrayBuffer());
    const n = Math.floor(view.byteLength / 16);
    const out = new Float32Array(n * 8);
    for (let i = 0; i < n; i++) {
      const o = i * 16;
      const x = view.getFloat32(o, true);
      const y = view.getFloat32(o + 4, true);
      const z = view.getFloat32(o + 8, true);
      const absMag = view.getUint8(o + 15) / 8 - 15;
      const distPc = Math.max(Math.hypot(x, y, z) / PC, 0.1);
      const appMag = absMag + 5 * (Math.log10(distPc) - 1);
      const lum = Math.pow(10, (4.83 - absMag) / 2.5);
      const j = i * 8;
      out[j] = x;
      out[j + 1] = y;
      out[j + 2] = z;
      out[j + 3] = Math.min(Math.max(R_SUN * Math.sqrt(lum), 4e8), 2e11);
      out[j + 4] = view.getUint8(o + 12) / 255;
      out[j + 5] = view.getUint8(o + 13) / 255;
      out[j + 6] = view.getUint8(o + 14) / 255;
      out[j + 7] = Math.min(Math.max(1.35 - 0.3 * appMag, 0.02), 2.0);
    }
    onChunk(out);
    loaded += n;
  }
  return loaded;
}
