// True ecliptic–galactic sky orientation.
//
// The scene's solar-system conventions are fixed (and verified by the
// seasons/solar-day tests): the ecliptic is the sun frame's XZ plane, the
// vernal equinox ♈ is +x, orbits run clockwise seen from +y, and Earth's
// spin axis is (0, cos ε, −sin ε) — the scene image of the north celestial
// pole. This module rotates the measured sky INTO that frame, so that
// Polaris stands over the pole, the ecliptic is inclined 23.44° to the
// celestial equator at the right equinox, and the Milky Way crosses the
// sky where it really does.
//
// Basis derivation (scene is a proper rotation of ecliptic coordinates:
// scene = (X_ecl, Z_ecl, −Y_ecl), det +1 — the sky is not mirrored):
//   X_eq (RA 0h,  Dec 0) = ♈           → scene (1, 0, 0)
//   Y_eq (RA 6h,  Dec 0) = ecl (0,  cos ε, −sin ε) → scene (0, −sin ε, −cos ε)
//   Z_eq (north celestial pole) = ecl (0, sin ε, cos ε) → scene (0, cos ε, −sin ε)

import { V3 } from './math';

export const OBLIQUITY = (23.44 * Math.PI) / 180;
const CE = Math.cos(OBLIQUITY);
const SE = Math.sin(OBLIQUITY);

// J2000 equatorial → galactic rotation (rows: galactic center, l = 90°, NGP).
const EQ_TO_GAL = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [+0.4941094279, -0.44482963, +0.7469822445],
  [-0.867666149, -0.1980763734, +0.4559837762],
];

// Equatorial → scene (columns are X_eq, Y_eq, Z_eq in scene coordinates).
const EQ_TO_SCENE = [
  [1, 0, 0],
  [0, -SE, CE],
  [0, -CE, -SE],
];

// The star tiles and brightstars.ts store positions in the PRE-orientation
// scene convention: galactic axes swizzled as (−g_center, g_NGP, g_l90).
// old → galactic is therefore g = (−x, z, y); composing old → galactic →
// equatorial (transpose) → scene gives one fixed matrix, built here once.
const SKY: number[][] = (() => {
  const G = [
    [-1, 0, 0],
    [0, 0, 1],
    [0, 1, 0],
  ];
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++)
        for (let l = 0; l < 3; l++) out[i][j] += EQ_TO_SCENE[i][k] * EQ_TO_GAL[l][k] * G[l][j];
  return out;
})();

// Re-orients a position from the star-data convention into the true scene.
export function orientSky(x: number, y: number, z: number): V3 {
  return [
    SKY[0][0] * x + SKY[0][1] * y + SKY[0][2] * z,
    SKY[1][0] * x + SKY[1][1] * y + SKY[1][2] * z,
    SKY[2][0] * x + SKY[2][1] * y + SKY[2][2] * z,
  ];
}

// Scene image of a J2000 equatorial VECTOR (satellite states, catalog
// positions with distance).
export function eqVecToScene(x: number, y: number, z: number): V3 {
  return [x, -SE * y + CE * z, -CE * y - SE * z];
}

// Scene direction of a J2000 equatorial position (for verification and
// future real-catalog placements).
export function raDecToScene(raDeg: number, decDeg: number): V3 {
  const ra = (raDeg * Math.PI) / 180;
  const dec = (decDeg * Math.PI) / 180;
  const v = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  return [
    EQ_TO_SCENE[0][0] * v[0] + EQ_TO_SCENE[0][1] * v[1] + EQ_TO_SCENE[0][2] * v[2],
    EQ_TO_SCENE[1][0] * v[0] + EQ_TO_SCENE[1][1] * v[1] + EQ_TO_SCENE[1][2] * v[2],
    EQ_TO_SCENE[2][0] * v[0] + EQ_TO_SCENE[2][1] * v[1] + EQ_TO_SCENE[2][2] * v[2],
  ];
}
