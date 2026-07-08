// Loads the 2MASS Redshift Survey tile produced by
// scripts/generate-galaxies.mjs: 43k real galaxies — Virgo, Coma,
// Perseus–Pisces, the Great Wall — as point-sprite instance data
// (pos, size, color, intensity — 8 floats per galaxy). Positions are
// heliocentric: RA/Dec rotated through the true-sky transform, distance
// from pure Hubble flow. The empty band along the Milky Way's plane is the
// survey's real zone of avoidance — dust, not absence.

import { raDecToScene } from './sky';

export async function loadGalaxies(url: string): Promise<Float32Array<ArrayBuffer> | null> {
  let view: DataView;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    view = new DataView(await res.arrayBuffer());
  } catch {
    return null; // offline / not generated — the procedural web stands in
  }
  const n = Math.floor(view.byteLength / 16);
  const out = new Float32Array(n * 8);
  for (let i = 0; i < n; i++) {
    const o = i * 16;
    const ra = view.getFloat32(o, true);
    const dec = view.getFloat32(o + 4, true);
    const dist = view.getFloat32(o + 8, true);
    const k = view.getUint8(o + 12) / 16 - 3; // apparent K_s magnitude
    const late = view.getUint8(o + 13) === 1;
    const dir = raDecToScene(ra, dec);
    // Absolute magnitude -> a physical-ish sprite scale: an L* galaxy
    // (M_K ~ -24.2) spans ~1.6e21 m. sqrt(L/L*) keeps dwarfs visible.
    const Mk = k - 5 * Math.log10(dist / (10 * 3.0857e16));
    const sqrtL = Math.pow(10, -0.2 * (Mk + 24.2));
    const size = Math.min(Math.max(1.6e21 * sqrtL, 2.5e20), 5e21);
    // Early types (cluster reds) warm, late types (field spirals) cool —
    // Virgo's core glows amber against the blue field, as it should.
    const h = ((i * 2654435761) % 97) / 97; // deterministic per-galaxy jitter
    const j = i * 8;
    out[j] = dir[0] * dist;
    out[j + 1] = dir[1] * dist;
    out[j + 2] = dir[2] * dist;
    out[j + 3] = size;
    out[j + 4] = late ? 0.7 + 0.1 * h : 1.0;
    out[j + 5] = late ? 0.76 + 0.08 * h : 0.8 + 0.06 * h;
    out[j + 6] = late ? 1.0 : 0.62 + 0.08 * h;
    out[j + 7] = Math.min(Math.max(0.04 + 0.06 * sqrtL, 0.03), 0.2);
  }
  return out;
}
