// Cosmic time: the ΛCDM scale factor for a flat matter+Λ universe.
// Planck-ish parameters: H₀ = 67.4 km/s/Mpc, Ωm = 0.315, ΩΛ = 0.685 — which
// give the analytic solution a(t) ∝ sinh^(2/3)(t / T) with
// T = 2 / (3 H₀ √ΩΛ) ≈ 11.7 Gyr, and an age of 13.8 Gyr at a = 1.
//
// The cosmic web is drawn in comoving coordinates and multiplied by
// a(t)/a(now), so scrubbing deep time expands (or rewinds) the space
// between galaxies while bound structure — galaxies, the solar system —
// stays its size, exactly as in the real universe.

export const YEAR_MS = 3.15576e10; // Julian year in milliseconds
export const AGE_GYR = 13.8; // age of the universe at the present epoch
export const BIG_BANG_MS = -AGE_GYR * 1e9 * YEAR_MS; // relative to ~now (J2000)

const H0 = 67.4 * (1e3 / 3.0857e22); // s⁻¹
const OMEGA_L = 0.685;
const T_LAMBDA_MS = (2 / (3 * H0 * Math.sqrt(OMEGA_L))) * 1000;
const A_NOW = Math.pow(Math.sinh((AGE_GYR * 1e9 * YEAR_MS) / T_LAMBDA_MS), 2 / 3);

// Scale factor normalized to 1 at the present epoch. `msFromNow` is
// simulation time relative to ~now (the J2000 offset is negligible at
// cosmic scales); clamped just above the singularity.
export function scaleFactor(msFromNow: number): number {
  const t = Math.max(msFromNow - BIG_BANG_MS, 1e6 * YEAR_MS); // ≥ 1 Myr after the bang
  return Math.pow(Math.sinh(t / T_LAMBDA_MS), 2 / 3) / A_NOW;
}
