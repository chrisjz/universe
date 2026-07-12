// Sagittarius A*: the 4.3-million-solar-mass black hole at the galactic
// center, and the S stars that orbit it — the stars whose measured Kepler
// ellipses ARE the measurement of the black hole's mass.
//
// Orbital elements: Gillessen et al. 2017 (ApJ 837, 30), Table 3 — 40 stars
// with bound orbits, fitted to 25 years of astrometry. The elements are the
// visual-binary kind: a in arcseconds on the sky, the plane oriented by
// (i, Ω, ω) relative to the OBSERVER's sky plane, Ω a position angle east
// of north. This module solves them and rotates the result into the scene.
//
// Mass and distance: GRAVITY Collaboration 2022 (A&A 657, L12) —
// M = 4.297×10⁶ M☉, R0 = 8277 pc. The Schwarzschild precession GRAVITY
// measured on S2 (2020, A&A 636, L5: 12.1′ per orbit, f_SP = 1.10 ± 0.19)
// is applied to every orbit as the GR apsidal advance 6πGM/(c²a(1−e²)).

import { V3 } from './math';
import { eqVecToScene, raDecToScene } from './sky';

const AU = 1.496e11;

export const SGRA_M = 4.297e6 * 1.98892e30; // kg (GRAVITY 2022)
export const SGRA_R0_PC = 8277; // pc (GRAVITY 2022)
const GM = 6.674e-11 * SGRA_M;
const C2 = 8.98755179e16; // c²
export const SGRA_RS = (2 * GM) / C2; // Schwarzschild radius ≈ 1.27e10 m
// The capture silhouette: a ray with impact parameter under √27/2 · rs
// spirals in. An opaque sphere of exactly this radius subtends the correct
// shadow angle from every distance — the shadow is drawn as geometry.
export const SGRA_SHADOW = (Math.sqrt(27) / 2) * SGRA_RS;

// Sky-plane basis at Sgr A* (Reid & Brunthaler 2004: 17h45m40.04s,
// −29°00′28.1″): east and north on the sky, and the line of sight pointing
// AWAY from the observer — the axes the published elements live in.
const RA = ((17 + 45 / 60 + 40.04 / 3600) * 15 * Math.PI) / 180;
const DEC = (-(29 + 0 / 60 + 28.1 / 3600) * Math.PI) / 180;
const LOS: V3 = raDecToScene((RA * 180) / Math.PI, (DEC * 180) / Math.PI);
const EAST: V3 = eqVecToScene(-Math.sin(RA), Math.cos(RA), 0);
const NORTH: V3 = eqVecToScene(-Math.sin(DEC) * Math.cos(RA), -Math.sin(DEC) * Math.sin(RA), Math.cos(DEC));

// name, a ("), e, i (°), Ω (°), ω (°), tP (Julian yr), P (yr)
type Row = [string, number, number, number, number, number, number, number];
const TABLE: Row[] = [
  ['S1', 0.595, 0.556, 119.14, 342.04, 122.3, 2001.8, 166.0],
  ['S2', 0.1255, 0.8839, 134.18, 226.94, 65.51, 2002.33, 16.0],
  ['S4', 0.357, 0.3905, 80.33, 258.84, 290.8, 1957.4, 77.0],
  ['S6', 0.6574, 0.84, 87.24, 85.07, 116.23, 2108.61, 192.0],
  ['S8', 0.4047, 0.8031, 74.37, 315.43, 346.7, 1983.64, 92.9],
  ['S9', 0.2724, 0.644, 82.41, 156.6, 150.6, 1976.71, 51.3],
  ['S12', 0.2987, 0.8883, 33.56, 230.1, 317.9, 1995.59, 58.9],
  ['S13', 0.2641, 0.425, 24.7, 74.5, 245.2, 2004.86, 49.0],
  ['S14', 0.2863, 0.9761, 100.59, 226.38, 334.59, 2000.12, 55.3],
  ['S17', 0.3559, 0.397, 96.83, 191.62, 326.0, 1991.19, 76.6],
  ['S18', 0.2379, 0.471, 110.67, 49.11, 349.46, 1993.86, 41.9],
  ['S19', 0.52, 0.75, 71.96, 344.6, 155.2, 2005.39, 135.0],
  ['S21', 0.219, 0.764, 58.8, 259.64, 166.4, 2027.4, 37.0],
  ['S22', 1.31, 0.449, 105.76, 291.7, 95.0, 1996.9, 540.0],
  ['S23', 0.253, 0.56, 48.0, 249.0, 39.0, 2024.7, 45.8],
  ['S24', 0.944, 0.897, 103.67, 7.93, 290.0, 2024.5, 331.0],
  ['S29', 0.428, 0.728, 105.8, 161.96, 346.5, 2025.96, 101.0],
  ['S31', 0.449, 0.5497, 109.03, 137.16, 308.0, 2018.07, 108.0],
  ['S33', 0.657, 0.608, 60.5, 100.1, 303.7, 1928.0, 192.0],
  ['S38', 0.1416, 0.8201, 171.1, 101.06, 17.99, 2003.19, 19.2],
  ['S39', 0.37, 0.9236, 89.36, 159.03, 23.3, 2000.06, 81.1],
  ['S42', 0.95, 0.567, 67.16, 196.14, 35.8, 2008.24, 335.0],
  ['S54', 1.2, 0.893, 62.2, 288.35, 140.8, 2004.46, 477.0],
  ['S55', 0.1078, 0.7209, 150.1, 325.5, 331.5, 2009.34, 12.8],
  ['S60', 0.3877, 0.7179, 126.87, 170.54, 29.37, 2023.89, 87.1],
  ['S66', 1.502, 0.128, 128.5, 92.3, 134.0, 1771.0, 664.0],
  ['S67', 1.126, 0.293, 136.0, 96.5, 213.5, 1705.0, 431.0],
  ['S71', 0.973, 0.899, 74.0, 35.16, 337.8, 1695.0, 346.0],
  ['S83', 1.49, 0.365, 127.2, 87.7, 203.6, 2046.8, 656.0],
  ['S85', 4.6, 0.78, 84.78, 107.36, 156.3, 1930.2, 3580.0],
  ['S87', 2.74, 0.224, 119.54, 106.32, 336.1, 611.0, 1640.0],
  ['S89', 1.081, 0.639, 87.61, 238.99, 126.4, 1783.0, 406.0],
  ['S91', 1.917, 0.303, 114.49, 105.35, 356.4, 1108.0, 958.0],
  ['S96', 1.499, 0.174, 126.36, 115.66, 233.6, 1646.0, 662.0],
  ['S97', 2.32, 0.35, 113.0, 113.2, 28.0, 2132.0, 1270.0],
  ['S145', 1.12, 0.5, 83.7, 263.92, 185.0, 1808.0, 426.0],
  ['S175', 0.414, 0.9867, 88.53, 326.83, 68.52, 2009.51, 96.2],
  ['R34', 1.81, 0.641, 136.0, 330.0, 57.0, 1522.0, 877.0],
  ['R44', 3.9, 0.27, 131.0, 80.5, 217.0, 1963.0, 2730.0],
];

const DEG = Math.PI / 180;
const YEAR_MS = 31557600000; // Julian year
const J2000_MS = Date.UTC(2000, 0, 1, 12);

export interface SStar {
  name: string;
  aM: number; // semi-major axis, meters
  e: number;
  periodMs: number;
  tpMs: number; // pericenter epoch
  precession: number; // GR apsidal advance, rad per orbit
  // Sky-plane orientation, precomputed (ω is applied live — it precesses).
  cosI: number;
  sinI: number;
  cosOm: number;
  sinOm: number;
  w0: number; // ω at tP, radians
}

export const S_STARS: SStar[] = TABLE.map(([name, aAs, e, i, Om, w, tp, P]) => ({
  name,
  aM: aAs * SGRA_R0_PC * AU, // 1″ at 1 pc = 1 AU
  e,
  periodMs: P * YEAR_MS,
  tpMs: J2000_MS + (tp - 2000) * YEAR_MS,
  precession: (6 * Math.PI * GM) / (C2 * aAs * SGRA_R0_PC * AU * (1 - e * e)),
  cosI: Math.cos(i * DEG),
  sinI: Math.sin(i * DEG),
  cosOm: Math.cos(Om * DEG),
  sinOm: Math.sin(Om * DEG),
  w0: w * DEG,
}));

// Kepler's equation, robust to e = 0.9867 (S175): a high-e start at π keeps
// Newton away from the flat spot near M = 0.
function eccentricAnomaly(M: number, e: number): number {
  let m = M % (2 * Math.PI);
  if (m > Math.PI) m -= 2 * Math.PI;
  if (m < -Math.PI) m += 2 * Math.PI;
  let E = e > 0.8 ? Math.PI * Math.sign(m || 1) : m;
  for (let k = 0; k < 24; k++) {
    const f = E - e * Math.sin(E) - m;
    E -= f / (1 - e * Math.cos(E));
  }
  return E;
}

// Position at `ms` in GALAXY-FRAME scene meters (Sgr A* at the origin).
// The published angles orient the orbit against the sky plane, so the
// ellipse is composed in (east, north, line-of-sight) offsets — the
// Thiele–Innes construction — then mapped through the fixed sky basis.
export function sStarPos(s: SStar, ms: number, out: V3): void {
  const dt = ms - s.tpMs;
  const E = eccentricAnomaly((2 * Math.PI * dt) / s.periodMs, s.e);
  const X = Math.cos(E) - s.e; // pericenter-frame coordinates, units of a
  const Y = Math.sqrt(1 - s.e * s.e) * Math.sin(E);
  // GR pericenter advance, accumulated from tP (12.1′ per orbit for S2 —
  // the precession GRAVITY measured in 2020).
  const w = s.w0 + (s.precession * dt) / s.periodMs;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  // Thiele–Innes: north/east/los components of the pericenter (A,B,C) and
  // covertex (F,G,H) unit vectors, scaled by a.
  const A = s.cosOm * cw - s.sinOm * sw * s.cosI;
  const B = s.sinOm * cw + s.cosOm * sw * s.cosI;
  const C = sw * s.sinI;
  const F = -s.cosOm * sw - s.sinOm * cw * s.cosI;
  const G = -s.sinOm * sw + s.cosOm * cw * s.cosI;
  const H = cw * s.sinI;
  const north = s.aM * (A * X + F * Y);
  const east = s.aM * (B * X + G * Y);
  const los = s.aM * (C * X + H * Y); // positive away from the observer
  out[0] = EAST[0] * east + NORTH[0] * north + LOS[0] * los;
  out[1] = EAST[1] * east + NORTH[1] * north + LOS[1] * los;
  out[2] = EAST[2] * east + NORTH[2] * north + LOS[2] * los;
}

// Ellipse axes for the orbit line, at the J2000 ω (the precession is
// invisible at line width): pos = −e·Avec + Avec·cosE + Bvec·sinE.
export function sStarAxes(s: SStar): { A: V3; B: V3 } {
  const cw = Math.cos(s.w0);
  const sw = Math.sin(s.w0);
  const mk = (p: number, q: number): V3 => {
    // p along pericenter (A,B,C), q along covertex (F,G,H) — see sStarPos.
    const north = s.aM * (p * (s.cosOm * cw - s.sinOm * sw * s.cosI) + q * (-s.cosOm * sw - s.sinOm * cw * s.cosI));
    const east = s.aM * (p * (s.sinOm * cw + s.cosOm * sw * s.cosI) + q * (-s.sinOm * sw + s.cosOm * cw * s.cosI));
    const los = s.aM * (p * sw * s.sinI + q * cw * s.sinI);
    return [
      EAST[0] * east + NORTH[0] * north + LOS[0] * los,
      EAST[1] * east + NORTH[1] * north + LOS[1] * los,
      EAST[2] * east + NORTH[2] * north + LOS[2] * los,
    ];
  };
  return { A: mk(1, 0), B: mk(0, Math.sqrt(1 - s.e * s.e)) };
}
