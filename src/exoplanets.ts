// Exoplanets: the NASA Exoplanet Archive, placed at its real host stars.
//
// Two layers. The SURVEY layer (public/exoplanets.bin, one dot per
// planetary system — 4,708 of them) marks every star we know has worlds:
// its shape is honest twice over, clustering along the Kepler field's
// stare and thinning with distance, because that is where and how far
// humanity has actually looked. The DESTINATION layer builds the two
// systems the roadmap promised — Proxima Centauri and TRAPPIST-1 — as
// real places: measured stellar radii and temperatures, planets with
// measured radii on their measured semi-major axes and periods.
//
// Honesty note: for these systems a, P, and planet radius are measured;
// the orbit's orientation on the sky mostly is not. The planes here
// contain the line of sight (these are transiting/RV systems — edge-on
// to Earth is the measured part of the geometry) but the rotation about
// it is a choice, and the orbital phases are arbitrary. The meshes and
// rings carry prov 0.5 — amber under the honest seam.

import { V3 } from './math';
import { raDecToScene } from './sky';

const PC = 3.0857e16;
const AU = 1.496e11;
const R_SUN = 6.957e8;
const R_EARTH = 6.371e6;

export interface ExoPlanet {
  name: string;
  slug: string;
  aAu: number; // semi-major axis, AU (archive pl_orbsmax)
  periodDays: number; // archive pl_orbper
  rEarth: number; // archive pl_rade
}

export interface ExoSystem {
  name: string;
  slug: string;
  ra: number;
  dec: number;
  distPc: number;
  stRSun: number; // archive st_rad
  color: [number, number, number]; // from st_teff (both are late M dwarfs)
  planets: ExoPlanet[];
}

// Values verbatim from the archive's composite table (pscomppars) —
// the same rows scripts/generate-exoplanets.mjs compacts for the survey.
export const EXO_SYSTEMS: ExoSystem[] = [
  {
    name: 'PROXIMA CENTAURI',
    slug: 'proxima',
    ra: 217.3934657,
    dec: -62.6761821,
    distPc: 1.30119,
    stRSun: 0.141,
    color: [1.0, 0.55, 0.32], // Teff 2900 K
    planets: [
      { name: 'PROXIMA b', slug: 'proxima-b', aAu: 0.04848, periodDays: 11.18465, rEarth: 1.02 },
      { name: 'PROXIMA d', slug: 'proxima-d', aAu: 0.02881, periodDays: 5.12338, rEarth: 0.692 },
    ],
  },
  {
    name: 'TRAPPIST-1',
    slug: 'trappist-1',
    ra: 346.6263919,
    dec: -5.0434618,
    distPc: 12.42988881,
    stRSun: 0.1192,
    color: [1.0, 0.48, 0.26], // Teff 2566 K
    planets: [
      { name: 'TRAPPIST-1 b', slug: 'trappist-1-b', aAu: 0.01154, periodDays: 1.510826, rEarth: 1.116 },
      { name: 'TRAPPIST-1 c', slug: 'trappist-1-c', aAu: 0.0158, periodDays: 2.421937, rEarth: 1.097 },
      { name: 'TRAPPIST-1 d', slug: 'trappist-1-d', aAu: 0.02227, periodDays: 4.049219, rEarth: 0.788 },
      { name: 'TRAPPIST-1 e', slug: 'trappist-1-e', aAu: 0.02925, periodDays: 6.101013, rEarth: 0.92 },
      { name: 'TRAPPIST-1 f', slug: 'trappist-1-f', aAu: 0.03849, periodDays: 9.20754, rEarth: 1.045 },
      { name: 'TRAPPIST-1 g', slug: 'trappist-1-g', aAu: 0.04683, periodDays: 12.352446, rEarth: 1.129 },
      { name: 'TRAPPIST-1 h', slug: 'trappist-1-h', aAu: 0.06189, periodDays: 18.772866, rEarth: 0.755 },
    ],
  },
];

// Star position (scene meters, sun frame) and the two in-plane basis
// vectors for its planets' orbits: û along the line of sight (edge-on to
// Earth — the measured half of a transiting geometry), v̂ across it.
export function exoBasis(s: ExoSystem): { pos: V3; u: V3; v: V3 } {
  const dir = raDecToScene(s.ra, s.dec);
  const d = s.distPc * PC;
  const pos: V3 = [dir[0] * d, dir[1] * d, dir[2] * d];
  // Any unit vector ⊥ dir serves as the sky-plane axis; derive it stably.
  const ref: V3 = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const v: V3 = [
    dir[1] * ref[2] - dir[2] * ref[1],
    dir[2] * ref[0] - dir[0] * ref[2],
    dir[0] * ref[1] - dir[1] * ref[0],
  ];
  const vn = Math.hypot(v[0], v[1], v[2]);
  v[0] /= vn;
  v[1] /= vn;
  v[2] /= vn;
  return { pos, u: dir, v };
}

export const exoStarRadius = (s: ExoSystem): number => s.stRSun * R_SUN;
export const exoPlanetRadius = (p: ExoPlanet): number => p.rEarth * R_EARTH;
export const exoOrbitRadius = (p: ExoPlanet): number => p.aAu * AU;

// Planet offset from its star at `ms` (circular orbit, real a and P;
// the phase epoch is arbitrary — see the honesty note above).
export function exoPlanetOffset(p: ExoPlanet, u: V3, v: V3, ms: number, out: V3): void {
  const th = ((ms / 86400000 / p.periodDays) % 1) * 2 * Math.PI;
  const a = p.aAu * AU;
  const c = Math.cos(th);
  const s = Math.sin(th);
  out[0] = a * (u[0] * c + v[0] * s);
  out[1] = a * (u[1] * c + v[1] * s);
  out[2] = a * (u[2] * c + v[2] * s);
}

// The survey layer: one sprite per system. Color leans on the star's
// temperature band; size and intensity are a legend, not a measurement.
export async function loadExoplanets(url: string): Promise<Float32Array<ArrayBuffer> | null> {
  let view: DataView;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    view = new DataView(await res.arrayBuffer());
  } catch {
    return null; // offline: the two built systems still stand
  }
  const n = Math.floor(view.byteLength / 12);
  const out = new Float32Array(n * 8);
  for (let i = 0; i < n; i++) {
    const o = i * 12;
    const ra = view.getFloat32(o, true);
    const dec = view.getFloat32(o + 4, true);
    const dist = (view.getUint16(o + 8, true) / 10) * PC;
    const count = view.getUint8(o + 10);
    const teff = view.getUint8(o + 11) * 100;
    const dir = raDecToScene(ra, dec);
    const j = i * 8;
    out[j] = dir[0] * dist;
    out[j + 1] = dir[1] * dist;
    out[j + 2] = dir[2] * dist;
    out[j + 3] = 2e9; // sub-stellar dot; the 3 px floor carries it
    // Cool hosts amber, sun-like pale, hot ones blue-white — with a green
    // cast that marks the layer as an overlay, not another star.
    const t = Math.min(Math.max((teff - 2500) / 4000, 0), 1);
    out[j + 4] = 0.55 + 0.35 * (1 - t);
    out[j + 5] = 0.95;
    out[j + 6] = 0.55 + 0.4 * t;
    // Quiet up close, legible from afar: at solar zoom these dots share
    // the sky with real stars and the Kepler field's CCD honeycomb reads
    // as an artifact (a user reported a "weirdly grid-like cluster" — it
    // is the telescope's detector footprint, drawn by the data itself).
    // At galactic zoom the layer still shows where humanity has looked.
    out[j + 7] = Math.min(0.09 + 0.02 * count, 0.18);
  }
  return out;
}
