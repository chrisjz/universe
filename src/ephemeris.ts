// The Moon, for real: a truncated Meeus/ELP series — inclined (5.1°),
// perturbed, with a regressing node (18.6-year cycle) and a varying
// distance. This is what makes eclipses happen on their true dates: with
// mean longitudes alone the Moon can sit 6° from its real place, and no
// syzygy would line up. The dozen largest terms keep it within ~0.05°,
// good to tens of minutes on eclipse timing.
//
// Earth gets its equation of center too (±1.9°), which upgrades the
// picnic's solar time from mean to apparent — the sundial kind.

const DEG = Math.PI / 180;

// Fundamental arguments (degrees; d = days since J2000, linear rates —
// the quadratic terms matter only over many centuries).
const arg = (a0: number, rate: number, d: number): number => ((a0 + rate * d) % 360) * DEG;

export interface MoonState {
  lonDeg: number; // geocentric ecliptic longitude, degrees
  latDeg: number; // geocentric ecliptic latitude, degrees
  distM: number; // geocentric distance, meters
}

export function moonEcliptic(d: number): MoonState {
  const Lp = 218.3164477 + 13.17639648 * d; // mean longitude
  const D = arg(297.8501921, 12.19074912, d); // mean elongation
  const M = arg(357.5291092, 0.98560028, d); // sun's mean anomaly
  const Mp = arg(134.9633964, 13.06499295, d); // moon's mean anomaly
  const F = arg(93.272095, 13.22935024, d); // argument of latitude
  const lon =
    Lp +
    6.288774 * Math.sin(Mp) +
    1.274027 * Math.sin(2 * D - Mp) +
    0.658314 * Math.sin(2 * D) +
    0.213618 * Math.sin(2 * Mp) -
    0.185116 * Math.sin(M) -
    0.114332 * Math.sin(2 * F) +
    0.058793 * Math.sin(2 * D - 2 * Mp) +
    0.057066 * Math.sin(2 * D - M - Mp) +
    0.053322 * Math.sin(2 * D + Mp) +
    0.045758 * Math.sin(2 * D - M);
  const lat =
    5.128122 * Math.sin(F) +
    0.280602 * Math.sin(Mp + F) +
    0.277693 * Math.sin(Mp - F) +
    0.173237 * Math.sin(2 * D - F) +
    0.055413 * Math.sin(2 * D + F - Mp) +
    0.046271 * Math.sin(2 * D - F - Mp);
  const distKm =
    385000.56 -
    20905.355 * Math.cos(Mp) -
    3699.111 * Math.cos(2 * D - Mp) -
    2955.968 * Math.cos(2 * D) -
    569.925 * Math.cos(2 * Mp);
  return { lonDeg: lon, latDeg: lat, distM: distKm * 1000 };
}

// Earth's equation of center (e = 0.0167): true minus mean heliocentric
// longitude, in degrees.
export function earthEqCenterDeg(d: number): number {
  const M = arg(357.5291092, 0.98560028, d);
  return 1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M);
}

// ---- The planets, for real: full Keplerian elements ----
// JPL's "Keplerian Elements for Approximate Positions of the Major Planets"
// (Standish & Williams), the 1800 AD – 2050 AD table: semi-major axis a
// (AU), eccentricity e, inclination I, mean longitude L, longitude of
// perihelion ϖ, longitude of ascending node Ω (degrees), each with its
// per-Julian-century rate. Good to arcminutes across the valid range —
// Mercury's 0.206 eccentricity and 7° inclination are finally honest.
// Values verified against JPL Horizons by scripts/verify-ephemeris.mjs.
export interface PlanetElements {
  a: number;
  aDot: number;
  e: number;
  eDot: number;
  i: number;
  iDot: number;
  L: number;
  LDot: number;
  peri: number; // ϖ
  periDot: number;
  node: number; // Ω
  nodeDot: number;
}

const EL = (
  a: number,
  aDot: number,
  e: number,
  eDot: number,
  i: number,
  iDot: number,
  L: number,
  LDot: number,
  peri: number,
  periDot: number,
  node: number,
  nodeDot: number,
): PlanetElements => ({ a, aDot, e, eDot, i, iDot, L, LDot, peri, periDot, node, nodeDot });

export const PLANET_ELEMENTS: Record<string, PlanetElements> = {
  // prettier-ignore
  mercury: EL(0.38709927, 0.00000037, 0.20563593, 0.00001906, 7.00497902, -0.00594749, 252.25032350, 149472.67411175, 77.45779628, 0.16047689, 48.33076593, -0.12534081),
  // prettier-ignore
  venus: EL(0.72333566, 0.00000390, 0.00677672, -0.00004107, 3.39467605, -0.00078890, 181.97909950, 58517.81538729, 131.60246718, 0.00268329, 76.67984255, -0.27769418),
  // prettier-ignore
  earth: EL(1.00000261, 0.00000562, 0.01671123, -0.00004392, -0.00001531, -0.01294668, 100.46457166, 35999.37244981, 102.93768193, 0.32327364, 0.0, 0.0),
  // prettier-ignore
  mars: EL(1.52371034, 0.00001847, 0.09339410, 0.00007882, 1.84969142, -0.00813131, -4.55343205, 19140.30268499, -23.94362959, 0.44441088, 49.55953891, -0.29257343),
  // prettier-ignore
  jupiter: EL(5.20288700, -0.00011607, 0.04838624, -0.00013253, 1.30439695, -0.00183714, 34.39644051, 3034.74612775, 14.72847983, 0.21252668, 100.47390909, 0.20469106),
  // prettier-ignore
  saturn: EL(9.53667594, -0.00125060, 0.05386179, -0.00050991, 2.48599187, 0.00193609, 49.95424423, 1222.49362201, 92.59887831, -0.41897216, 113.66242448, -0.28867794),
  // prettier-ignore
  uranus: EL(19.18916464, -0.00196176, 0.04725744, -0.00004397, 0.77263783, -0.00242939, 313.23810451, 428.48202785, 170.95427630, 0.40805281, 74.01692503, 0.04240589),
  // prettier-ignore
  neptune: EL(30.06992276, 0.00026291, 0.00859048, 0.00005105, 1.77004347, 0.00035372, -55.12002969, 218.45945325, 44.96476227, -0.32241464, 131.78422574, -0.00508664),
  // prettier-ignore
  pluto: EL(39.48211675, -0.00031596, 0.24882730, 0.00005170, 17.14001206, 0.00004818, 238.92903833, 145.20780515, 224.06891629, -0.04062942, 110.30393684, -0.01183482),
};

const AU_M = 1.496e11; // matches the scene's AU

// Solve Kepler's equation E − e·sin E = M by Newton's method. For planets
// (e < 0.3) the M-based seed converges in a few steps; for comets like
// Halley (e = 0.968) Newton from that seed can overshoot near perihelion,
// so high-e orbits seed at π, where the iteration is globally stable.
function solveKepler(M: number, e: number): number {
  let E = e < 0.8 ? M + e * Math.sin(M) : Math.PI * Math.sign(M || 1);
  for (let k = 0; k < 24; k++) {
    const dE = (M - (E - e * Math.sin(E))) / (1 - e * Math.cos(E));
    E += dE;
    if (Math.abs(dE) < 1e-9) break;
  }
  return E;
}

// Heliocentric position at T Julian centuries from J2000, in SCENE meters
// (ecliptic (x♈, y_λ90, z_north) maps to scene (x, −z, y): orbits run
// clockwise seen from scene +y, matching the rest of the engine).
export function keplerScenePos(el: PlanetElements, T: number, out: [number, number, number]): void {
  const a = (el.a + el.aDot * T) * AU_M;
  const e = el.e + el.eDot * T;
  const i = (el.i + el.iDot * T) * DEG;
  const L = el.L + el.LDot * T;
  const peri = el.peri + el.periDot * T;
  const node = (el.node + el.nodeDot * T) * DEG;
  const w = (peri - (el.node + el.nodeDot * T)) * DEG; // argument of perihelion
  let M = ((L - peri) % 360) * DEG;
  if (M > Math.PI) M -= 2 * Math.PI;
  if (M < -Math.PI) M += 2 * Math.PI;
  const E = solveKepler(M, e);
  const xp = a * (Math.cos(E) - e); // orbital-plane coords, perihelion +x
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w),
    sw = Math.sin(w),
    cn = Math.cos(node),
    sn = Math.sin(node),
    ci = Math.cos(i),
    si = Math.sin(i);
  const xe = (cw * cn - sw * sn * ci) * xp + (-sw * cn - cw * sn * ci) * yp;
  const ye = (cw * sn + sw * cn * ci) * xp + (-sw * sn + cw * cn * ci) * yp;
  const ze = sw * si * xp + cw * si * yp;
  out[0] = xe;
  out[1] = ze;
  out[2] = -ye;
}

// The orbit as a drawable ellipse: center offset from the focus (the sun)
// plus semi-axis vectors, all in scene meters. pos(θ) = center + A·cosθ +
// B·sinθ traces the true inclined ellipse.
export function keplerEllipse(el: PlanetElements): {
  center: [number, number, number];
  A: [number, number, number];
  B: [number, number, number];
} {
  const a = el.a * AU_M;
  const e = el.e;
  const b = a * Math.sqrt(1 - e * e);
  const i = el.i * DEG;
  const node = el.node * DEG;
  const w = (el.peri - el.node) * DEG;
  const cw = Math.cos(w),
    sw = Math.sin(w),
    cn = Math.cos(node),
    sn = Math.sin(node),
    ci = Math.cos(i),
    si = Math.sin(i);
  const toScene = (xp: number, yp: number): [number, number, number] => {
    const xe = (cw * cn - sw * sn * ci) * xp + (-sw * cn - cw * sn * ci) * yp;
    const ye = (cw * sn + sw * cn * ci) * xp + (-sw * sn + cw * cn * ci) * yp;
    const ze = sw * si * xp + cw * si * yp;
    return [xe, ze, -ye];
  };
  const A = toScene(a, 0);
  const B = toScene(0, b);
  const center = toScene(-a * e, 0);
  return { center, A, B };
}
