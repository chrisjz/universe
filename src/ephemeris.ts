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
