// Comets: hyperbolic visitors and physically derived tails.
//
// The interstellar objects fly two-body hyperbolae from their JPL SBDB
// osculating elements (q, e, i, Ω, ω, tP — heliocentric ecliptic J2000),
// solved per frame like everything else and verified against JPL Horizons
// state vectors by scripts/verify-interstellar.mjs.
//
// The tails are Finson–Probstein dust dynamics, not sprites painted on:
// a grain released from the nucleus with radiation-pressure parameter β
// (the ratio of radiation pressure to solar gravity) simply flies a
// Kepler orbit under the reduced μ(1−β) — so each dust syndyne is the
// locus of grains of one β over emission age, propagated with a
// universal-variable Kepler solver (grains near perihelion ride
// hyperbolae even when the comet is bound). The ion tail is the
// anti-sunward direction aberrated by the comet's motion against the
// ~450 km/s solar wind. Everything is computed in scene coordinates —
// a fixed rotation of the ecliptic, under which gravity is invariant.

import { V3 } from './math';

const GM = 1.32712440018e20; // heliocentric μ, m³/s²
const AU = 1.496e11;
const DAY_MS = 86400000;
// tP arrives as a Julian Date; scene time is Unix ms.
const jdToMs = (jd: number): number => (jd - 2440587.5) * DAY_MS;

export interface ConicEl {
  q: number; // perihelion distance, AU
  e: number; // eccentricity (> 1 for the visitors)
  i: number; // deg, ecliptic J2000
  om: number; // Ω, deg
  w: number; // ω, deg
  tpJd: number; // perihelion passage, JD (TDB — 69 s from UTC is sub-km here)
}

export interface Visitor {
  name: string;
  slug: string;
  el: ConicEl;
}

// JPL SBDB osculating elements (full precision), 2026 check vectors in
// scripts/verify-interstellar.mjs. 1I's tiny non-gravitational
// acceleration (the famous anomaly) is ignored — it is ~1e-5 of gravity.
export const VISITORS: Visitor[] = [
  {
    name: "1I/'OUMUAMUA",
    slug: 'oumuamua',
    el: {
      q: 0.2559115812959116,
      e: 1.201133796102373,
      i: 122.7417062847286,
      om: 24.59690955523242,
      w: 241.8105360304898,
      tpJd: 2458006.007321375,
    },
  },
  {
    name: '2I/BORISOV',
    slug: 'borisov',
    el: {
      q: 2.006520878500843,
      e: 3.356475782676596,
      i: 44.05264247909138,
      om: 308.1477292269942,
      w: 209.1236864378081,
      tpJd: 2458826.052845906,
    },
  },
  {
    name: '3I/ATLAS',
    slug: '3i-atlas',
    el: {
      q: 1.356481057231181,
      e: 6.141351449317625,
      i: 175.1164570850441,
      om: 322.1696089290778,
      w: 128.0228697185194,
      tpJd: 2460977.995262848,
    },
  },
];

const DEG = Math.PI / 180;

// Heliocentric position of a conic orbit at `ms`, in SCENE meters
// (ecliptic x,y,z → scene x,z,−y — the atlas's fixed convention).
// Handles e > 1 (hyperbolic anomaly H, M = e·sinh H − H) and e < 1.
export function conicScenePos(el: ConicEl, ms: number, out: V3): void {
  const a = (el.q / (1 - el.e)) * AU; // negative for hyperbolae
  const dt = (ms - jdToMs(el.tpJd)) / 1000; // seconds from perihelion
  let x: number; // perifocal, meters
  let y: number;
  if (el.e > 1) {
    const n = Math.sqrt(GM / Math.pow(-a, 3)); // rad/s
    const M = n * dt;
    // Newton on M = e·sinh H − H; the log start tracks sinh's growth.
    let H = Math.sign(M || 1) * Math.log((2 * Math.abs(M)) / el.e + 1.8);
    for (let k = 0; k < 30; k++) {
      const f = el.e * Math.sinh(H) - H - M;
      H -= f / (el.e * Math.cosh(H) - 1);
    }
    x = a * (Math.cosh(H) - el.e);
    y = -a * Math.sqrt(el.e * el.e - 1) * Math.sinh(H);
  } else {
    const n = Math.sqrt(GM / Math.pow(a, 3));
    const M = (n * dt) % (2 * Math.PI);
    let E = el.e > 0.8 ? Math.PI * Math.sign(M || 1) : M;
    for (let k = 0; k < 24; k++) E -= (E - el.e * Math.sin(E) - M) / (1 - el.e * Math.cos(E));
    x = a * (Math.cos(E) - el.e);
    y = a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
  }
  // Perifocal → ecliptic: Rz(Ω)·Rx(i)·Rz(ω).
  const cw = Math.cos(el.w * DEG);
  const sw = Math.sin(el.w * DEG);
  const co = Math.cos(el.om * DEG);
  const so = Math.sin(el.om * DEG);
  const ci = Math.cos(el.i * DEG);
  const si = Math.sin(el.i * DEG);
  const xw = x * cw - y * sw;
  const yw = x * sw + y * cw;
  const ex = xw * co - yw * ci * so;
  const ey = xw * so + yw * ci * co;
  const ez = yw * si;
  out[0] = ex;
  out[1] = ez;
  out[2] = -ey;
}

// Universal-variable Kepler propagation (Vallado): state (r0, v0) advanced
// by dt seconds under gravitational parameter mu — one solver for every
// conic, which dust demands: grains shed near perihelion with β near 1
// escape on hyperbolae while their parent comet stays bound.
function stumpff(psi: number): [number, number] {
  if (psi > 1e-6) {
    const s = Math.sqrt(psi);
    return [(1 - Math.cos(s)) / psi, (s - Math.sin(s)) / (s * psi)];
  }
  if (psi < -1e-6) {
    const s = Math.sqrt(-psi);
    return [(1 - Math.cosh(s)) / psi, (Math.sinh(s) - s) / (s * -psi)];
  }
  return [0.5 - psi / 24, 1 / 6 - psi / 120];
}

export function kepUniversal(r0: V3, v0: V3, dt: number, mu: number, out: V3): void {
  const r0n = Math.hypot(r0[0], r0[1], r0[2]);
  const v02 = v0[0] * v0[0] + v0[1] * v0[1] + v0[2] * v0[2];
  const rv = r0[0] * v0[0] + r0[1] * v0[1] + r0[2] * v0[2];
  const sqmu = Math.sqrt(mu);
  const alpha = 2 / r0n - v02 / mu; // 1/a
  let chi = alpha > 1e-30 ? sqmu * dt * alpha : (Math.sign(dt) * sqmu) / r0n; // ellipse start; ~parabolic fallback
  let c2 = 0.5;
  let c3 = 1 / 6;
  let rr = r0n;
  for (let k = 0; k < 60; k++) {
    const psi = chi * chi * alpha;
    [c2, c3] = stumpff(psi);
    const tn = (chi * chi * chi * c3 + (rv / sqmu) * chi * chi * c2 + r0n * chi * (1 - psi * c3)) / sqmu;
    rr = chi * chi * c2 + (rv / sqmu) * chi * (1 - psi * c3) + r0n * (1 - psi * c2);
    const d = ((dt - tn) * sqmu) / Math.max(rr, 1);
    chi += d;
    if (Math.abs(d) < 1e-8 * Math.abs(chi) + 1e-10) break;
  }
  const psi = chi * chi * alpha;
  [c2, c3] = stumpff(psi);
  const f = 1 - (chi * chi * c2) / r0n;
  const g = dt - (chi * chi * chi * c3) / sqmu;
  out[0] = f * r0[0] + g * v0[0];
  out[1] = f * r0[1] + g * v0[1];
  out[2] = f * r0[2] + g * v0[2];
}

// ---- the tail ----
// Syndynes: for each β, grains released over the last AGES days, each
// propagated from its release state under μ(1−β) with zero ejection
// velocity (the classical Finson–Probstein construction). Sample counts
// are small — the whole tail is a few hundred two-body solves per frame.
const BETAS = [0.03, 0.1, 0.25, 0.5];
const AGES = 34; // samples per syndyne, ages spread quadratically to 60 d
const MAX_AGE_D = 60;
const ION = 30; // ion-tail samples
export const TAIL_SPRITES = BETAS.length * AGES + ION;

export interface CometTail {
  // nucleus position in scene meters at any epoch (the comet's own solver)
  state: (ms: number, out: V3) => void;
  data: Float32Array<ArrayBuffer>; // TAIL_SPRITES × 8 static sprite floats
}

// Water sublimation switches on inside ~3.5 AU and the coma brightens
// steeply sunward-in; one smooth activity factor scales every sprite.
function activity(rAu: number): number {
  if (rAu >= 3.5) return 0;
  return Math.min(1, Math.pow(3.5 / Math.max(rAu, 0.5), 2) * ((3.5 - rAu) / 2.5)) * Math.min(1, (3.5 - rAu) / 0.4);
}

const nuc: V3 = [0, 0, 0];
const nucB: V3 = [0, 0, 0];
const rel: V3 = [0, 0, 0];
const vel: V3 = [0, 0, 0];
const grain: V3 = [0, 0, 0];

// Rebuilds the tail sprite buffer for epoch `ms`. Returns true when the
// tail is active (the caller uploads only then, plus once to clear).
export function updateTail(t: CometTail, ms: number): boolean {
  t.state(ms, nuc);
  const rAu = Math.hypot(nuc[0], nuc[1], nuc[2]) / AU;
  const act = activity(rAu);
  const d = t.data;
  if (act <= 0) {
    for (let i = 0; i < d.length; i += 8) d[i + 7] = 0;
    return false;
  }
  let o = 0;
  for (const beta of BETAS) {
    for (let k = 0; k < AGES; k++) {
      const frac = (k + 1) / AGES;
      const ageS = frac * frac * MAX_AGE_D * 86400; // dense young, sparse old
      // Release state: nucleus position and finite-difference velocity.
      const h = 3600_000;
      t.state(ms - ageS * 1000 - h, nucB);
      t.state(ms - ageS * 1000 + h, rel);
      vel[0] = ((rel[0] - nucB[0]) / (2 * h)) * 1000;
      vel[1] = ((rel[1] - nucB[1]) / (2 * h)) * 1000;
      vel[2] = ((rel[2] - nucB[2]) / (2 * h)) * 1000;
      t.state(ms - ageS * 1000, rel);
      kepUniversal(rel, vel, ageS, GM * (1 - beta), grain);
      d[o] = grain[0];
      d[o + 1] = grain[1];
      d[o + 2] = grain[2];
      // Grains disperse with age, and high-β grains race apart fastest —
      // their sprites broaden to match, which keeps the syndyne a ribbon.
      d[o + 3] = 2e8 * (0.4 + 7 * frac * frac) * (1 + 2.5 * beta);
      d[o + 4] = 1.0;
      d[o + 5] = 0.93;
      d[o + 6] = 0.82; // warm sunlit dust
      d[o + 7] = act * 0.5 * (1 - 0.8 * frac);
      o += 8;
    }
  }
  // Ion tail: anti-sunward, aberrated by the comet's velocity against the
  // ~450 km/s solar wind — the direction comets' plasma tails really take.
  {
    const h = 3600_000;
    t.state(ms - h, nucB);
    t.state(ms + h, rel);
    const rn = Math.hypot(nuc[0], nuc[1], nuc[2]);
    const wind = 450e3;
    const dir: V3 = [
      (nuc[0] / rn) * wind - ((rel[0] - nucB[0]) / (2 * h)) * 1000,
      (nuc[1] / rn) * wind - ((rel[1] - nucB[1]) / (2 * h)) * 1000,
      (nuc[2] / rn) * wind - ((rel[2] - nucB[2]) / (2 * h)) * 1000,
    ];
    const dn = Math.hypot(dir[0], dir[1], dir[2]);
    const lenM = 0.45 * AU * act;
    for (let k = 0; k < ION; k++) {
      const frac = (k + 1) / ION;
      d[o] = nuc[0] + (dir[0] / dn) * lenM * frac;
      d[o + 1] = nuc[1] + (dir[1] / dn) * lenM * frac;
      d[o + 2] = nuc[2] + (dir[2] / dn) * lenM * frac;
      d[o + 3] = 1.2e8 * (0.5 + 2 * frac);
      d[o + 4] = 0.55;
      d[o + 5] = 0.75;
      d[o + 6] = 1.0; // CO⁺ blue
      d[o + 7] = act * 0.45 * (1 - 0.75 * frac);
      o += 8;
    }
  }
  return true;
}
