// Deep-space probe trajectories: Chebyshev segments fitted from JPL
// Horizons by scripts/generate-probes.mjs (heliocentric ecliptic J2000,
// worst fit residual < 20,000 km — the same representation JPL's SPK
// kernels use). Beyond their data span the escaping probes coast on a
// linear extension of the end state (they are ballistic and nearly
// straight out there); JWST instead disappears — its future
// station-keeping burns are not predictable.

import type { V3 } from './math';

export interface ProbeSeg {
  t0: number;
  t1: number;
  c: [number[], number[], number[]];
}

export interface Probe {
  slug: string;
  name: string;
  startMs: number;
  endMs: number;
  extend: { r: [number, number, number]; v: [number, number, number] } | null;
  segs: ProbeSeg[];
}

function clenshaw(c: number[], x: number): number {
  let b1 = 0;
  let b2 = 0;
  for (let k = c.length - 1; k >= 1; k--) {
    const t = 2 * x * b1 - b2 + c[k];
    b2 = b1;
    b1 = t;
  }
  return x * b1 - b2 + c[0];
}

// Heliocentric ecliptic position in KILOMETERS at `ms`; false while the
// probe does not exist at that time (pre-launch, or JWST past its span).
export function probeEclipticKm(p: Probe, ms: number, out: V3): boolean {
  if (ms < p.startMs) return false;
  if (ms > p.endMs) {
    if (!p.extend) return false;
    const dt = ms - p.endMs;
    out[0] = p.extend.r[0] + p.extend.v[0] * dt;
    out[1] = p.extend.r[1] + p.extend.v[1] * dt;
    out[2] = p.extend.r[2] + p.extend.v[2] * dt;
    return true;
  }
  // Segments are time-ordered; binary search for the covering one.
  let lo = 0;
  let hi = p.segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p.segs[mid].t1 < ms) lo = mid + 1;
    else hi = mid;
  }
  const s = p.segs[lo];
  const x = Math.min(1, Math.max(-1, (2 * (ms - s.t0)) / (s.t1 - s.t0) - 1));
  out[0] = clenshaw(s.c[0], x);
  out[1] = clenshaw(s.c[1], x);
  out[2] = clenshaw(s.c[2], x);
  return true;
}
