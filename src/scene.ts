// Placeholder universe. Structure is procedural (deterministic seed) but all
// solar-system dimensions are real: actual semi-major axes, actual radii,
// actual Sun-galactic-center distance. This is the content that later gets
// replaced by Gaia / SDSS / NASA catalogs — the frame tree stays the same.

import { V3, mulberry32, gaussian } from './math';
import { Frame } from './frames';
import { MeshKind } from './renderer';
import { BRIGHT_STARS } from './data/brightstars';
import { orientSky, raDecToScene, sceneDirToRaDec, eqVecToScene } from './sky';
import { GALAXY_BODIES } from './data/galaxybodies';
import { SDSS_MASK, SDSS_MASK_W, SDSS_MASK_H, SDSS_MASK_DEPTH_UNIT } from './data/sdssmask';
import { PLANET_ELEMENTS, GALILEAN_ELEMENTS, keplerEllipse, keplerScenePos, PlanetElements } from './ephemeris';
import { VISITORS, conicScenePos, updateTail, TAIL_SPRITES } from './comet';
import {
  EXO_SYSTEMS,
  ExoPlanet,
  exoBasis,
  exoStarRadius,
  exoPlanetRadius,
  exoOrbitRadius,
  exoPlanetOffset,
} from './exoplanets';
import { CLOUDS } from './magellanic';
import { LOCAL_GROUP } from './data/localgroup';
import { MESSIER } from './data/messier';
import { S_STARS, sStarPos, sStarAxes, SGRA_SHADOW } from './blackhole';

export interface MeshObj {
  frame: Frame;
  pos: V3;
  mesh: MeshKind;
  size: V3; // per-axis scale in meters (sphere: radius in all)
  bound: number; // bounding radius, for sub-pixel culling
  color: [number, number, number];
  emissive: number;
  matId: number; // 0 plain, 1 earth, 2 star, 3 banded, 4 rocky, 5 park ground, 6 prop, 7 picnic blanket
  rim: number; // atmosphere rim strength
  gridScale: number; // local units -> meters (ground grid)
  rot?: [V3, V3, V3]; // local axis basis (columns: X, Y, Z -> world), e.g. surface tangent frame
  // The inward journey dives *through* solid objects; each scale layer hides
  // once the camera's focus distance drops below this (the film's cross-fade).
  hideBelow?: number;
  // Light this mesh from a live position instead of the sun — an exoplanet
  // orbits a star that isn't ours (references the host star's pos array).
  litFrom?: V3;
  // Honest-seam provenance: 0 = measured, 0.5 = real dimensions but stylized
  // look, 1 = illustrative. Drives the seam view's recoloring.
  prov?: number;
  tex?: string; // texture key: 'earth' = day/night pair; others via addTexture
}

export interface PointGroup {
  frame: Frame;
  pos: V3;
  data: Float32Array<ArrayBuffer>;
  disabled?: boolean; // perf attribution (?skip=): never drawn
  gcYield?: boolean; // illustrative galaxy glow: dims near the galactic center
  // Positions stored at a = 1: the shader multiplies by the live ΛCDM scale
  // factor (SDSS galaxies ride the expansion at zero CPU cost).
  comoving?: boolean;
  // Star fields fade out as the camera pulls beyond this extent, so a million
  // additive sprites collapsing into a few pixels don't bloom to white (the
  // procedural galaxy provides the from-a-distance glow instead).
  fadeExtent?: number;
  hideBelow?: number; // skip entirely below this focus distance (see MeshObj)
  nearFade?: boolean; // fade sprites near the camera (see the Grp.misc shader note)
  prov?: number; // honest-seam provenance (see MeshObj)
  // Bounding cone of the group's star directions from the sun (world axes).
  // The frame loop culls whole tile groups outside the view frustum — the
  // deep sky is vertex-bound, and most tiles are behind you or underfoot.
  cone?: { dir: V3; ang: number };
  maxDrift?: number; // fastest star in the group, m/yr (cull margin input)
  stellar?: boolean; // fades out in deep time (stars freeze at the ±1 Myr clamp)
  farBand?: boolean; // faint band eligible for the far-field bake
  // Instance layout / pipeline: 'moving' stars carry a 3D velocity (11
  // floats), 'orbital' small bodies carry Kepler elements (10 floats) and
  // a per-group tint; default is the static 8-float layout.
  mode?: 'static' | 'moving' | 'orbital';
  tint?: [number, number, number, number]; // orbital: rgb + base intensity
}
export interface OrbitLine {
  // True Kepler ellipse: pos(θ) = center + centerOff + axisA·cosθ + axisB·sinθ.
  // Absent axes mean a circle of `radius` (the Moon's stylized ring).
  axisA?: V3;
  axisB?: V3;
  centerOff?: V3;
  frame: Frame;
  center: V3;
  radius: number;
  color: [number, number, number];
  alpha: number;
  // Rings fade once the camera is within this fraction of `radius` of the
  // center (default 0.02 — the sun-view declutter). The S-star ellipses set
  // it far lower: bending around the shadow IS their show, and the shadow
  // is 2e-4 of S2's orbit.
  nearRatio?: number;
  secondImage?: boolean; // near Sgr A*: also draw the lens's counter-image
}
export interface Target {
  name: string;
  slug: string;
  frame: Frame;
  pos: V3;
  dist: number;
  pitch: number;
  // Seamless-zoom chain: scrolling in past `enter` retargets focus to
  // `child`; scrolling out past `exit` retargets to `parent`. Thresholds
  // carry hysteresis (exit ≳ 2 × enter + separation) so a retarget can
  // never immediately bounce back.
  child?: string;
  enter?: number;
  parent?: string;
  exit?: number;
  hidden?: boolean; // reachable via URL / flights only, no HUD button
  button?: boolean; // hidden, but still gets a HUD button (the inward-journey stages)
  radius?: number; // physical bound radius in meters; presence makes it clickable
  sunlit?: boolean; // flights/jumps arrive facing the sunlit side (yaw computed live)
  lightPos?: V3; // the sunlit side faces THIS live position (exoplanet hosts)
  basis?: [V3, V3, V3]; // camera orbit basis (east, up, north) for tilted surface sites
  // Catalog stars get a color so the renderer can substitute a real star mesh
  // for their sprite up close (sprites jitter at 1e16 m f32 magnitudes).
  starColor?: [number, number, number];
  source?: string; // provenance caption shown in the HUD while focused
}

// A body on its real orbit (full Keplerian elements when `el` is set,
// circular mean-longitude fallback otherwise). Every
// V3 in `positions` is written in place each tick (mesh/target arrays share
// references); `frameOffset` moves a whole child frame (Earth carries the
// Moon, the surface site, and any camera standing on it automatically).
export interface OrbitalBody {
  a: number; // orbit radius (nominal, meters) — sprite/fade scale
  periodDays: number;
  L0: number; // mean longitude at J2000, degrees (circular fallback)
  positions: V3[];
  frameOffset?: V3;
  spriteFloatBase?: number; // float offset of its locator sprite in the planet sprite group
  el?: PlanetElements; // full Keplerian elements (planets ride these)
  center?: V3; // el is relative to this live position (moons of a planet)
  moon?: boolean; // use the full inclined, perturbed lunar ephemeris (ephemeris.ts)
}

export interface Universe {
  root: Frame;
  sunFrame: Frame;
  meshes: MeshObj[];
  groups: PointGroup[];
  orbits: OrbitLine[];
  targets: Target[];
  bodies: OrbitalBody[];
  planetSpriteGroup: number; // index into groups; its buffer is re-uploaded as bodies move
  webGroup: number; // index into groups; re-uploaded when the scale factor moves
  moonMesh: MeshObj; // eclipse shading mutates its color as it crosses Earth's shadow
  galileans: { mesh: MeshObj; pos: V3; base: [number, number, number]; r: number; spriteFloatBase: number }[];
  jupiterPos: V3; // heliocentric, live (eclipse geometry needs the sun line)
  earthRot: [V3, V3, V3]; // live earth-fixed → world basis (solar-eclipse frame)
  // Sagittarius A*: the galaxy frame (the black hole sits at its origin),
  // the S-star point group's index in `groups`, and the per-frame Kepler
  // update for the 40 published orbits (main.ts calls it near the center).
  sgrA: { frame: Frame; group: number; update: (ms: number) => void };
  // Interstellar visitors + comet tails: the per-frame update returns the
  // indices of groups whose instance data changed (main re-uploads those).
  comets: { update: (ms: number) => number[] };
  // Exoplanet destinations (Proxima, TRAPPIST-1): circular-orbit update.
  exo: { update: (ms: number) => void };
  moonFrame: Frame; // origin rides moonPos; Tranquility Base hangs off it
  // Textured planets spin about their real poles; main.ts drives the phase.
  planetSpins: { basis: [V3, V3, V3]; e0: V3; up: V3; n0: V3; periodDays: number }[];
  postSpin: (() => void)[]; // run after each spin update (sites riding a planet)
  marsFrame: Frame; // origin rides Mars's ephemeris; Jezero hangs off it
  driftStars: (years: number) => void; // named-star targets/meshes ride their proper motions
  orientEarth: (theta: number, phi?: number) => void; // diurnal spin θ + axial precession φ
  orientMoon: (psi: number) => void; // synchronous spin around the orbit normal
  orientGalaxy: (beta: number) => void; // the sun's orbit angle around the galactic center
  scaleWeb: (a: number) => Float32Array<ArrayBuffer>; // comoving web × ΛCDM scale factor
  patchGeoms: { name: string; verts: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> }[];
  site: { lat: number; lon: number; ringSizes: number[]; waterLevel: number };
  // Free Earth navigation: the roam point + the movable imagery stack.
  nav: {
    home: [number, number]; // the picnic (lat°, lon°)
    roamLatLon: () => [number, number];
    setRoam: (latDeg: number, lonDeg: number) => void;
    setRoamFromWorld: (w: V3) => void; // w: world position relative Earth's center
    roamMove: (delta: V3) => void; // world-space meters, great-circle step
    imagerySite: () => [number, number];
    setImagerySite: (latDeg: number, lonDeg: number) => string[]; // returns new texture keys
    imageryKeys: () => string[];
    dimpleEarth: (depth: number) => void; // sink the render sphere below carved terrain
    gnomonicEUN: (p: V3) => [number, number] | null; // imagery-local east/north meters
    // Tranquility Base (fixed site — baked terrain, streamed WAC imagery).
    moon: {
      site: [number, number]; // (lat°, lon°)
      ringSizes: number[];
      R: number; // the site's datum radius (LOLA reference + site elevation)
      dimpleMoon: (depth: number) => void;
      gnomonicEUN: (p: V3) => [number, number] | null; // p relative the Moon's center
    };
    // Jezero crater (fixed site — baked MOLA terrain, streamed Viking imagery).
    mars: {
      site: [number, number];
      ringSizes: number[];
      R: number;
      dimpleMars: (depth: number) => void;
      gnomonicEUN: (p: V3) => [number, number] | null; // p relative Mars's center
    };
  };
}

const AU = 1.496e11;
const KPC = 3.086e19;
const R_SUN = 6.957e8;
const R_EARTH = 6.371e6;

// ---- Street-level imagery rings: the shared vertex net ----
// Six concentric annular patches (each S/4 the size of the last) curved to
// the exact sphere in site-local coordinates (x east, z north, meters).
// main.ts rebuilds a ring with real heights once elevation streams in.
export const RING_SIZES = [2048e3, 512e3, 128e3, 32e3, 8e3, 2e3];
export const RING_GRID = 48; // cells per side; the central quarter (the S/8 hole) is skipped

export function ringGeometry(
  S: number,
  heights?: Float32Array | null,
  R = R_EARTH, // datum radius: the sphere the ring curves onto (Moon rings pass their own)
  hole = true, // the innermost ring of a stack can close its center (no lawn beneath)
): { verts: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  const G = RING_GRID;
  const lift = S * 4e-5;
  const cell = S / G;
  const hAt = (i: number, j: number) =>
    heights ? heights[Math.min(G, Math.max(0, j)) * (G + 1) + Math.min(G, Math.max(0, i))] : 0;
  const verts: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= G; j++) {
    for (let i = 0; i <= G; i++) {
      const nx = ((i / G - 0.5) * S) / R;
      const nz = ((j / G - 0.5) * S) / R;
      const len = Math.hypot(nx, 1, nz);
      const rr = R + lift + hAt(i, j);
      // Normal: the sphere normal tilted by the terrain slope (small-angle).
      const dhdx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * cell);
      const dhdz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * cell);
      const nl = Math.hypot(nx / len - dhdx, 1 / len, nz / len - dhdz);
      verts.push(
        (rr * nx) / len,
        rr / len - R,
        (rr * nz) / len,
        (nx / len - dhdx) / nl,
        1 / len / nl,
        (nz / len - dhdz) / nl,
      );
    }
  }
  // The hole is one cell SMALLER per side than the next ring's S/8 extent,
  // so adjacent LODs overlap by S/48: with real terrain the boundary
  // vertices sample the DEM at different resolutions, and without overlap
  // the T-junction opens visible cracks in steep country (Grand Canyon).
  const hole0 = G / 2 - G / 8 + 1,
    hole1 = G / 2 + G / 8 - 1;
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      if (hole && i >= hole0 && i < hole1 && j >= hole0 && j < hole1) continue; // the hole (next ring / the lawn)
      const a0 = j * (G + 1) + i,
        b0 = a0 + G + 1;
      idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
    }
  }
  // Skirts: neighboring LODs sample the DEM at different resolutions, so in
  // steep country their sheets can disagree by ~a cell of height and a
  // grazing sight line slips BETWEEN them (a lavender wedge of sky in the
  // Grand Canyon). A one-cell-deep curtain hangs from both perimeters and
  // closes the gap; its stretched texels are barely visible edge-on.
  const skirt = (2 * S) / G;
  const emitSkirt = (loop: [number, number][]): void => {
    const base = verts.length / 6;
    for (const [i, j] of loop) {
      const top = (j * (G + 1) + i) * 6;
      const nx = ((i / G - 0.5) * S) / R;
      const nz = ((j / G - 0.5) * S) / R;
      const len = Math.hypot(nx, 1, nz);
      const rr = R + lift + hAt(i, j) - skirt;
      verts.push((rr * nx) / len, rr / len - R, (rr * nz) / len, verts[top + 3], verts[top + 4], verts[top + 5]);
    }
    const n = loop.length;
    for (let k = 0; k < n; k++) {
      const [i0, j0] = loop[k];
      const [i1, j1] = loop[(k + 1) % n];
      const t0 = j0 * (G + 1) + i0,
        t1 = j1 * (G + 1) + i1;
      idx.push(t0, base + k, t1, t1, base + k, base + ((k + 1) % n));
    }
  };
  const outer: [number, number][] = [];
  for (let i = 0; i < G; i++) outer.push([i, 0]);
  for (let j = 0; j < G; j++) outer.push([G, j]);
  for (let i = G; i > 0; i--) outer.push([i, G]);
  for (let j = G; j > 0; j--) outer.push([0, j]);
  emitSkirt(outer);
  if (hole) {
    const holeLoop: [number, number][] = [];
    for (let i = hole0; i < hole1; i++) holeLoop.push([i, hole0]);
    for (let j = hole0; j < hole1; j++) holeLoop.push([hole1, j]);
    for (let i = hole1; i > hole0; i--) holeLoop.push([i, hole1]);
    for (let j = hole1; j > hole0; j--) holeLoop.push([hole0, j]);
    emitSkirt(holeLoop);
  }
  return { verts: new Float32Array(verts), indices: new Uint32Array(idx) };
}

const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

// B-V color index -> approximate RGB via blackbody temperature.
function bvToRgb(bv: number): [number, number, number] {
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const x = Math.min(Math.max(t, 2000), 30000) / 100;
  let r: number, g: number, b: number;
  if (x <= 66) {
    r = 255;
    g = 99.47 * Math.log(x) - 161.12;
    b = x <= 19 ? 0 : 138.52 * Math.log(x - 10) - 305.04;
  } else {
    r = 329.7 * Math.pow(x - 60, -0.1332);
    g = 288.12 * Math.pow(x - 60, -0.0755);
    b = 255;
  }
  const clamp01 = (v: number) => Math.min(Math.max(v / 255, 0), 1);
  // Blackbody RGB is washed out for cool stars; boost saturation so M-types
  // actually read as orange-red.
  const c = [clamp01(r), clamp01(g), clamp01(b)];
  const mean = (c[0] + c[1] + c[2]) / 3;
  return [
    Math.min(Math.max(mean + (c[0] - mean) * 1.45, 0), 1),
    Math.min(Math.max(mean + (c[1] - mean) * 1.45, 0), 1),
    Math.min(Math.max(mean + (c[2] - mean) * 1.45, 0), 1),
  ];
}

export function buildUniverse(): Universe {
  const rand = mulberry32(20260707);
  const meshes: MeshObj[] = [];
  const groups: PointGroup[] = [];
  const orbits: OrbitLine[] = [];

  // ---- Frame tree ----
  const root = new Frame('universe', null, [0, 0, 0]);
  const galaxy = new Frame('milky-way', root, [0, 0, 0]);
  // Real galactocentric distance, oriented so the galactic center sits in
  // its true scene direction (Sagittarius) and the disk in the true plane.
  const sunFrame = new Frame('sun', galaxy, orientSky(8.3 * KPC, 0, 9e17));
  // The galactic year: the sun orbits the galactic center every ~225 Myr,
  // moving toward l = 90° (Cygnus). β is the accumulated orbit angle; the
  // offset is recomputed in the pre-orientation convention (disk plane =
  // local XZ, pole = +y) and re-oriented, so the whole solar neighborhood —
  // planets, picnic, 854k stars — rides around the disk together.
  const orientGalaxy = (beta: number): void => {
    const cb = Math.cos(beta),
      sb = Math.sin(beta);
    const x = 8.3 * KPC * cb + 9e17 * sb;
    const z = -8.3 * KPC * sb + 9e17 * cb;
    const p = orientSky(x, 0, z);
    sunFrame.offset[0] = p[0];
    sunFrame.offset[1] = p[1];
    sunFrame.offset[2] = p[2];
  };

  // Placeholder epoch position; updateBodies() overwrites it (in place) from
  // the Keplerian ephemeris before the first frame renders.
  const earthPos: V3 = [AU, 0, 0];
  const earthFrame = new Frame('earth', sunFrame, earthPos);

  // The landing site: the Chicago lakefront where the Eames' "Powers of Ten"
  // (1977) opens on a picnic blanket. dir(lat, lon) is the exact inverse of
  // the shader's equirectangular UV in EARTH-FIXED coordinates; the diurnal
  // rotation orientEarth(θ) spins that whole earth-fixed system — mesh
  // texture, site frame, site basis, and every anchored object — in lockstep.
  const DEG = Math.PI / 180;
  // Hutchinson Field, Grant Park — open lakefront lawn, real grass in the
  // real imagery (the first pick landed on the Field Museum's roof).
  const SITE_LAT_DEG = 41.86934;
  const SITE_LON_DEG = -87.61842;
  const SITE_LAT = SITE_LAT_DEG * DEG;
  const SITE_LON = SITE_LON_DEG * DEG;
  // Earth-fixed (θ = 0) basis; the live basis below is rotated in place.
  const up0: V3 = [
    Math.cos(SITE_LAT) * Math.cos(SITE_LON),
    Math.sin(SITE_LAT),
    -Math.cos(SITE_LAT) * Math.sin(SITE_LON),
  ];
  const east0: V3 = ((): V3 => {
    const e: V3 = [up0[2], 0, -up0[0]];
    const l = Math.hypot(e[0], e[2]);
    return [e[0] / l, 0, e[2] / l];
  })();
  const north0: V3 = [
    up0[1] * east0[2] - up0[2] * east0[1],
    up0[2] * east0[0] - up0[0] * east0[2],
    up0[0] * east0[1] - up0[1] * east0[0],
  ];
  // Live (world-oriented) basis — mutated in place by orientEarth, so every
  // reference (targets, mesh rot fields, the camera's orbit basis) follows.
  const east: V3 = [...east0];
  const up: V3 = [...up0];
  const north: V3 = [...north0];
  const siteBasis: [V3, V3, V3] = [east, up, north];
  // Frame origin 1.5 m above the sphere so the ground plane never z-fights
  // the coarse planet mesh.
  const surface = new Frame('surface', earthFrame, [
    up[0] * (R_EARTH + 1.5),
    up[1] * (R_EARTH + 1.5),
    up[2] * (R_EARTH + 1.5),
  ]);
  // Position in the surface frame from site-local (east, up, north) meters.
  const sitePos = (e: number, u: number, n: number): V3 => [
    east[0] * e + up[0] * u + north[0] * n,
    east[1] * e + up[1] * u + north[1] * n,
    east[2] * e + up[2] * u + north[2] * n,
  ];
  // Everything placed at the site registers its (east, up, north) coords so
  // orientEarth can recompute its world-frame vector as the planet turns.
  const anchored: { vec: V3; eun: V3 }[] = [];
  anchored.push({ vec: surface.offset, eun: [0, R_EARTH + 1.5, 0] });
  const anchor = (eun: V3): V3 => {
    const vec = sitePos(eun[0], eun[1], eun[2]);
    anchored.push({ vec, eun });
    return vec;
  };
  // Tilted variants of the site basis (fibril jitter) re-derived on rotation.
  const tiltedBases: { basis: [V3, V3, V3]; a: number; b: number }[] = [];
  let orientTilts = (): void => {};
  // Earth's mesh orientation (identity at θ = 0), mutated by orientEarth.
  const earthRot: [V3, V3, V3] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  // Diurnal rotation: spin the earth-fixed system by θ around the planet's
  // axis (+Y — no axial tilt yet). One call re-orients the globe texture, the
  // site frame offset, the live site basis, every anchored object, and the
  // fibril bases, so the camera and the picnic ride the turning planet.
  // Axial tilt: the spin axis is inclined 23.44° from the orbit normal,
  // tipped toward orbital longitude 90° — so the north pole leans sunward at
  // the June solstice (Earth's heliocentric longitude 270°). Seasons follow:
  // high summer sun in Chicago, low winter sun, varying day length. The axis
  // (0, cos ε, −sin ε) is the scene's north celestial pole; sky.ts rotates
  // the star catalog and the galaxy so Polaris really stands over it.
  const OBLIQUITY = (23.44 * Math.PI) / 180;
  const CE = Math.cos(OBLIQUITY),
    SE = -Math.sin(OBLIQUITY); // lean toward -Z: sunward at the June solstice under clockwise orbits
  // Axial precession: the spin axis sweeps a 23.44° cone around the ecliptic
  // pole once per 25,772 years (φ, negative with time — the equinoxes move
  // westward). Scrub +12,000 years and Vega takes over as the pole star; it
  // also means the seasons drift through this sidereal calendar, which is
  // real (our dates are Julian days from J2000, not tropical years).
  // Movable earth-fixed vectors (the roam point, the imagery-stack basis)
  // re-rotated by every orientEarth call, plus hooks run after each pass.
  const fixedVecs: { fixed: V3; out: V3 }[] = [];
  const postOrient: (() => void)[] = [];
  const registerFixed = (fixed: V3): V3 => {
    const out: V3 = [...fixed];
    fixedVecs.push({ fixed, out });
    return out;
  };
  let lastTheta = 0;
  let lastPhi = 0;
  const orientEarth = (theta: number, phi = 0): void => {
    lastTheta = theta;
    lastPhi = phi;
    const c = Math.cos(theta),
      s = Math.sin(theta);
    const cp = Math.cos(phi),
      sp = Math.sin(phi);
    // world = R_y(φ) · Tilt · R_y(θ) · earthFixed
    const rot = (v0: V3, out: V3): void => {
      const x = v0[0] * c + v0[2] * s;
      const y = v0[1];
      const z = -v0[0] * s + v0[2] * c;
      const ty = y * CE - z * SE;
      const tz = y * SE + z * CE;
      out[0] = x * cp + tz * sp;
      out[1] = ty;
      out[2] = -x * sp + tz * cp;
    };
    rot(east0, east);
    rot(up0, up);
    rot(north0, north);
    rot([1, 0, 0], earthRot[0]);
    rot([0, 1, 0], earthRot[1]);
    rot([0, 0, 1], earthRot[2]);
    orientTilts();
    for (const a of anchored) {
      a.vec[0] = east[0] * a.eun[0] + up[0] * a.eun[1] + north[0] * a.eun[2];
      a.vec[1] = east[1] * a.eun[0] + up[1] * a.eun[1] + north[1] * a.eun[2];
      a.vec[2] = east[2] * a.eun[0] + up[2] * a.eun[1] + north[2] * a.eun[2];
    }
    for (const f of fixedVecs) rot(f.fixed, f.out);
    for (const h of postOrient) h();
  };
  const refreshOrient = (): void => orientEarth(lastTheta, lastPhi);

  // Earth-fixed frame of a lat/lon (same convention as the site's up0):
  const fixedDir = (lat: number, lon: number): V3 => [
    Math.cos(lat) * Math.cos(lon),
    Math.sin(lat),
    -Math.cos(lat) * Math.sin(lon),
  ];
  const fixedBasis = (lat: number, lon: number, e: V3, uu: V3, n: V3): void => {
    const d = fixedDir(lat, lon);
    const h = Math.hypot(d[0], d[2]);
    e[0] = d[2] / h;
    e[1] = 0;
    e[2] = -d[0] / h;
    uu[0] = d[0];
    uu[1] = d[1];
    uu[2] = d[2];
    n[0] = uu[1] * e[2] - uu[2] * e[1];
    n[1] = uu[2] * e[0] - uu[0] * e[2];
    n[2] = uu[0] * e[1] - uu[1] * e[0];
  };

  // ---- Free Earth navigation: the roam point ----
  // A movable focus on the planet's surface. Its earth-fixed position and
  // tangent basis are mutated by nav calls and ride the diurnal rotation
  // like everything else on the planet.
  const roam = { lat: SITE_LAT, lon: SITE_LON };
  const roamFixedE: V3 = [0, 0, 0],
    roamFixedU: V3 = [0, 0, 0],
    roamFixedN: V3 = [0, 0, 0],
    roamFixedPos: V3 = [0, 0, 0];
  fixedBasis(roam.lat, roam.lon, roamFixedE, roamFixedU, roamFixedN);
  const roamEast = registerFixed(roamFixedE);
  const roamUp = registerFixed(roamFixedU);
  const roamNorth = registerFixed(roamFixedN);
  const roamPos = registerFixed(roamFixedPos);
  const roamBasis: [V3, V3, V3] = [roamEast, roamUp, roamNorth];
  const setRoam = (latDeg: number, lonDeg: number): void => {
    roam.lat = Math.max(-89.9, Math.min(89.9, latDeg)) * DEG;
    roam.lon = ((((lonDeg + 180) % 360) + 360) % 360) * DEG - Math.PI;
    fixedBasis(roam.lat, roam.lon, roamFixedE, roamFixedU, roamFixedN);
    roamFixedPos[0] = roamFixedU[0] * (R_EARTH + 1.5);
    roamFixedPos[1] = roamFixedU[1] * (R_EARTH + 1.5);
    roamFixedPos[2] = roamFixedU[2] * (R_EARTH + 1.5);
    refreshOrient();
  };
  setRoam(SITE_LAT_DEG, SITE_LON_DEG);
  const d3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // Slide the roam point along the sphere by a world-space delta (meters);
  // the delta is re-expressed earth-fixed and applied as a great-circle step.
  const roamMove = (delta: V3): void => {
    const f: V3 = [d3(delta, earthRot[0]), d3(delta, earthRot[1]), d3(delta, earthRot[2])];
    const p = fixedDir(roam.lat, roam.lon);
    const along = d3(f, p);
    const t: V3 = [f[0] - p[0] * along, f[1] - p[1] * along, f[2] - p[2] * along];
    const m = Math.hypot(t[0], t[1], t[2]);
    if (m < 1e-9) return;
    const ang = m / R_EARTH;
    const ca = Math.cos(ang),
      sa = Math.sin(ang) / m;
    const p2: V3 = [p[0] * ca + t[0] * sa, p[1] * ca + t[1] * sa, p[2] * ca + t[2] * sa];
    setRoam(Math.asin(Math.max(-1, Math.min(1, p2[1]))) / DEG, Math.atan2(-p2[2], p2[0]) / DEG);
  };
  // Set the roam point from a world-space position relative to Earth's center
  // (used to seed roaming at the point under the view).
  const setRoamFromWorld = (w: V3): void => {
    const f: V3 = [d3(w, earthRot[0]), d3(w, earthRot[1]), d3(w, earthRot[2])];
    const l = Math.max(Math.hypot(f[0], f[1], f[2]), 1e-9);
    setRoam(Math.asin(Math.max(-1, Math.min(1, f[1] / l))) / DEG, Math.atan2(-f[2], f[0]) / DEG);
  };

  // ---- Sun & planets (real radii and orbits) ----
  const sphere = (
    frame: Frame,
    pos: V3,
    r: number,
    color: [number, number, number],
    matId: number,
    rim = 0,
    emissive = 0,
    // Real radius, orbit, and albedo — procedural surface detail: 0.5.
  ): MeshObj => ({
    frame,
    pos,
    mesh: 'sphere',
    size: [r, r, r],
    bound: r,
    color,
    emissive,
    matId,
    rim,
    gridScale: 0,
    prov: 0.5,
  });

  meshes.push(sphere(sunFrame, [0, 0, 0], 6.957e8, [1.0, 0.72, 0.35], 2));

  // ---- Real planet faces ----
  // NASA global mosaics (baked by scripts/generate-planets.mjs) on spinning,
  // correctly tilted globes. Poles are ecliptic (λ°, β°) from the IAU RA/Dec;
  // spin PHASE is arbitrary (no sub-planet longitude calibration — honesty:
  // the face is measured, the moment of its rotation is not). Venus, Uranus,
  // and Neptune stay stylized: Venus's visible face is featureless cloud (a
  // radar map would misrepresent what you'd SEE), the ice giants are nearly
  // featureless in visible light.
  const PLANET_FACES: Record<string, { tex: string; periodDays: number; pole: [number, number] }> = {
    mercury: { tex: 'mercury', periodDays: 58.6462, pole: [0, 90] }, // tilt 0.03°: upright
    mars: { tex: 'mars', periodDays: 1.02595675, pole: [352.9, 63.3] },
    jupiter: { tex: 'jupiter', periodDays: 0.41354, pole: [247.8, 87.7] },
  };
  const SATURN_POLE: [number, number] = [79.5, 61.9]; // ring plane follows it
  const basisFromPole = (lonDeg: number, latDeg: number): [V3, V3, V3] => {
    const u0 = fixedDir(latDeg * DEG, lonDeg * DEG);
    const h = Math.max(Math.hypot(u0[0], u0[2]), 1e-9);
    const e0: V3 = h < 1e-8 ? [1, 0, 0] : [u0[2] / h, 0, -u0[0] / h];
    const n0: V3 = [u0[1] * e0[2] - u0[2] * e0[1], u0[2] * e0[0] - u0[0] * e0[2], u0[0] * e0[1] - u0[1] * e0[0]];
    return [e0, u0, n0];
  };
  // Live bases mutated by main.ts each frame (uniform prograde spin).
  const planetSpins: { basis: [V3, V3, V3]; e0: V3; up: V3; n0: V3; periodDays: number }[] = [];
  // Hooks run after each spin update (surface sites riding a spinning planet).
  const postSpin: (() => void)[] = [];
  let marsPos!: V3;
  let jupiterPos!: V3;
  let marsMesh!: MeshObj;
  let marsSpinBasis!: [V3, V3, V3];
  const registerSpin = (pole: [number, number], periodDays: number): [V3, V3, V3] => {
    const [e0, up, n0] = basisFromPole(pole[0], pole[1]);
    const basis: [V3, V3, V3] = [[...e0], [...up], [...n0]];
    planetSpins.push({ basis, e0, up, n0, periodDays });
    return basis;
  };

  // name, a, radius, color, matId, mean longitude at J2000 (deg), period (days)
  const planets: [string, number, number, [number, number, number], number, number, number][] = [
    ['mercury', 0.387 * AU, 2.44e6, [0.62, 0.58, 0.54], 4, 252.25, 87.969],
    ['venus', 0.723 * AU, 6.05e6, [0.86, 0.76, 0.55], 3, 181.98, 224.701],
    ['earth', AU, R_EARTH, [0.2, 0.4, 0.7], 1, 100.46, 365.256],
    ['mars', 1.524 * AU, 3.39e6, [0.76, 0.42, 0.25], 4, 355.43, 686.98],
    ['jupiter', 5.203 * AU, 6.99e7, [0.78, 0.63, 0.44], 3, 34.4, 4332.59],
    ['saturn', 9.537 * AU, 5.82e7, [0.86, 0.76, 0.55], 3, 49.94, 10759.22],
    ['uranus', 19.19 * AU, 2.54e7, [0.62, 0.85, 0.89], 3, 313.23, 30688.5],
    ['neptune', 30.07 * AU, 2.46e7, [0.31, 0.48, 0.85], 3, 304.88, 60182],
    // Pluto earns its place BECAUSE of Kepler: e = 0.249, i = 17° — the
    // orbit that made circular approximations embarrassing.
    ['pluto', 39.48 * AU, 1.188e6, [0.68, 0.62, 0.53], 4, 238.93, 90560],
  ];
  const bodies: OrbitalBody[] = [];
  // Named geometries registered with the renderer (Earth + Moon ring nets).
  const patchGeoms: { name: string; verts: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> }[] = [];
  const planetSprites: number[][] = [];
  const planetTargets: Target[] = [];
  let dimpleEarth: (depth: number) => void = () => {};
  planets.forEach(([name, a, r, color, matId, L0, periodDays]) => {
    const ell = keplerEllipse(PLANET_ELEMENTS[name]);
    orbits.push({
      frame: sunFrame,
      center: [0, 0, 0],
      radius: a,
      color: [0.4, 0.62, 1.0],
      alpha: 0.2,
      axisA: ell.A,
      axisB: ell.B,
      centerOff: ell.center,
    });
    const spriteFloatBase = planetSprites.length * 8;
    if (name === 'earth') {
      const earthMesh = sphere(earthFrame, [0, 0, 0], r, color, matId, 1.0);
      // Below the weave, even Earth steps aside: the micro stages float in
      // black space (its surface 1.5 m away would otherwise wash them out).
      earthMesh.hideBelow = 2e-3;
      // Diurnal rotation spins this basis (and with it the Blue Marble UVs).
      earthMesh.rot = earthRot;
      earthMesh.prov = 0; // NASA imagery: measured
      earthMesh.tex = 'earth';
      meshes.push(earthMesh);
      // Terrain dips below the imagery site's datum (a canyon under a rim
      // site) would poke the smooth sphere through the carved rings; the
      // caller shrinks the render sphere by the region's deepest depression
      // (≤ ~0.1% of R — imperceptible at planet scale).
      dimpleEarth = (depth: number): void => {
        const rr = R_EARTH - Math.max(0, depth);
        earthMesh.size[0] = rr;
        earthMesh.size[1] = rr;
        earthMesh.size[2] = rr;
      };
      planetSprites.push([...earthPos, r * 4, 0.5, 0.7, 1.0, 0.3]);
      bodies.push({
        a,
        periodDays,
        L0,
        positions: [],
        frameOffset: earthPos,
        spriteFloatBase,
        el: PLANET_ELEMENTS.earth,
      });
      return;
    }
    const pos: V3 = [a, 0, 0]; // ephemeris fills this in before first render
    const face = PLANET_FACES[name];
    const m = face
      ? sphere(sunFrame, pos, r, [1, 1, 1], 10) // real mosaic (matId 10 multiplies color)
      : sphere(sunFrame, pos, r, color, matId, matId === 3 ? 0.4 : 0);
    if (face) {
      m.tex = face.tex;
      m.rot = registerSpin(face.pole, face.periodDays);
      m.prov = 0; // measured imagery
      if (name === 'jupiter') jupiterPos = pos;
      if (name === 'mars') {
        marsPos = pos;
        marsMesh = m;
        marsSpinBasis = m.rot;
      }
    } else if (name === 'saturn') {
      // The globe stays stylized (its bands are subtle in visible light),
      // but it tilts and spins with the real pole — the rings ride it.
      m.rot = registerSpin(SATURN_POLE, 0.444);
      // Saturn's rings: a unit annulus scaled to the outer radius, wearing
      // Cassini's radial scan (see generate-planets.mjs). Real radii —
      // 74,500 km to 140,500 km — and in 2026 they hang nearly edge-on to
      // the sun (the March 2025 ring-plane crossing just passed): honest.
      meshes.push({
        frame: sunFrame,
        pos, // shared ref: the rings ride the ephemeris with the planet
        mesh: 'saturnrings',
        size: [1.405e8, 1.405e8, 1.405e8],
        bound: 1.5e8,
        color: [1, 1, 1],
        emissive: 0,
        matId: 12,
        rim: 0,
        gridScale: 0,
        rot: m.rot,
        prov: 0.5, // measured radial structure, brightness-derived opacity
        tex: 'rings',
      });
    }
    meshes.push(m);
    planetSprites.push([...pos, r * 4, color[0], color[1], color[2], 0.28]);
    bodies.push({ a, periodDays, L0, positions: [pos], spriteFloatBase, el: PLANET_ELEMENTS[name] });
    planetTargets.push({
      name: name.toUpperCase(),
      slug: name,
      frame: sunFrame,
      pos, // shared reference — the target rides the ephemeris
      dist: 28 * r,
      pitch: 0.15,
      sunlit: true,
      source: face
        ? {
            mercury: 'measured — MESSENGER MDIS global mosaic',
            mars: 'measured — Viking MDIM 2.1 color mosaic',
            jupiter: 'measured — Cassini global map, Dec 2000',
          }[name]!
        : name === 'saturn'
          ? 'measured orbit, size & rings (Cassini) — stylized globe'
          : 'measured orbit & size — stylized surface',
      parent: 'system',
      exit: Math.max(3 * a, 1e12),
      radius: r,
      hidden: true,
      ...(name === 'mars' ? { child: 'jezero', enter: 6e6 } : {}),
    });
  });

  // ---- Small-body destinations: Ceres and Halley ----
  // Both ride the same Kepler path as the planets, with elements derived
  // from the MPC catalogs (Ceres: MPCORB epoch 2026-06-09 rebased to J2000;
  // Halley: CometEls, 2061 return — its mean anomaly self-checks to 0.07°
  // at the real 1986 perihelion). The 40k-body belt around them is GPU-side.
  const mpEl = (
    a: number,
    e: number,
    i: number,
    L: number,
    peri: number,
    node: number,
    LDot: number,
  ): PlanetElements => ({
    a,
    aDot: 0,
    e,
    eDot: 0,
    i,
    iDot: 0,
    L,
    LDot,
    peri,
    periDot: 0,
    node,
    nodeDot: 0,
  });
  const CERES_EL = mpEl(2.7655526, 0.0796923, 10.58803, 158.74556, 153.54283, 80.24863, 7827.47);
  const HALLEY_EL = mpEl(17.85848, 0.968018, 162.1825, 237.76256, 171.5633, 59.3317, 477.019);
  for (const sb of [
    {
      name: 'CERES',
      slug: 'ceres',
      el: CERES_EL,
      r: 4.7e5,
      color: [0.62, 0.6, 0.56] as [number, number, number],
      orbitColor: [0.4, 0.62, 1.0] as [number, number, number],
      alpha: 0.14,
      source: 'measured orbit (MPC) & size — stylized surface',
    },
    {
      name: "HALLEY'S COMET",
      slug: 'halley',
      el: HALLEY_EL,
      r: 5.5e3,
      color: [0.34, 0.33, 0.36] as [number, number, number],
      orbitColor: [0.55, 0.72, 0.88] as [number, number, number],
      alpha: 0.22,
      source: 'measured orbit (MPC, 1P/Halley) & size — stylized nucleus',
    },
  ]) {
    const pos: V3 = [sb.el.a * AU, 0, 0];
    meshes.push(sphere(sunFrame, pos, sb.r, sb.color, 4));
    const ell = keplerEllipse(sb.el);
    orbits.push({
      frame: sunFrame,
      center: [0, 0, 0],
      radius: sb.el.a * AU,
      color: sb.orbitColor,
      alpha: sb.alpha,
      axisA: ell.A,
      axisB: ell.B,
      centerOff: ell.center,
    });
    bodies.push({ a: sb.el.a * AU, periodDays: 36525 / (sb.el.LDot / 360), L0: 0, positions: [pos], el: sb.el });
    planetTargets.push({
      name: sb.name,
      slug: sb.slug,
      frame: sunFrame,
      pos,
      dist: 40 * sb.r,
      pitch: 0.15,
      sunlit: true,
      source: sb.source,
      parent: 'system',
      exit: Math.max(3 * sb.el.a * AU, 1e12),
      radius: sb.r,
      hidden: true,
    });
  }

  // ---- the interstellar visitors, and tails that are dust dynamics ----
  // 1I/ʻOumuamua, 2I/Borisov, and 3I/ATLAS on their real hyperbolae (JPL
  // SBDB elements, verified against Horizons state vectors to < 0.03 AU by
  // scripts/verify-interstellar.mjs). Halley and 3I — the two comets with
  // element-driven positions — grow Finson–Probstein tails: each dust
  // syndyne is grains of one radiation-pressure β flying Kepler orbits
  // under μ(1−β), so the tail curves, points anti-sunward, and exists only
  // where sublimation does (scrub to 2061 and watch Halley grow one).
  const J2000_MS = Date.UTC(2000, 0, 1, 12);
  const halleyState = (ms: number, out: V3): void => {
    keplerScenePos(HALLEY_EL, (ms - J2000_MS) / 86400000 / 36525, out);
  };
  const cometUpdate = ((): ((ms: number) => number[]) => {
    const visitors = VISITORS.map((v) => {
      const pos: V3 = [0, 0, 0];
      const inst = new Float32Array(8);
      inst[3] = 200; // locator dot: the objects themselves are ~0.1–1 km
      inst[4] = 0.85;
      inst[5] = 0.92;
      inst[6] = 1.0;
      inst[7] = 0.75;
      groups.push({ frame: sunFrame, pos, data: inst, prov: 0 });
      planetTargets.push({
        name: v.name,
        slug: v.slug,
        frame: sunFrame,
        pos,
        dist: 3e5,
        pitch: 0.2,
        hidden: true,
        parent: 'system',
        exit: 1e13,
        source: 'measured hyperbola — JPL SBDB elements, verified against Horizons',
      });
      return { v, pos };
    });
    const tails = [
      { state: halleyState, data: new Float32Array(TAIL_SPRITES * 8) },
      {
        state: (ms: number, out: V3) => conicScenePos(VISITORS[2].el, ms, out),
        data: new Float32Array(TAIL_SPRITES * 8),
      },
    ].map((t) => {
      const group = groups.length;
      // The syndyne positions are physics; the sprite rendering of them is
      // a sketch — stylized-on-real, amber under the honest seam.
      groups.push({ frame: sunFrame, pos: [0, 0, 0], data: t.data, prov: 0.5, fadeExtent: 8e18 });
      return { ...t, group, wasActive: true };
    });
    return (ms: number): number[] => {
      const dirty: number[] = [];
      // The visitors ride their whole hyperbolae, inbound leg included:
      // unlike a thrusting spacecraft, a gravity-only orbit retrodicts as
      // solidly as it predicts (Horizons serves 3I positions for 1990),
      // and a dot that pops out mid-scrub reads as a bug, not honesty.
      for (const vi of visitors) conicScenePos(vi.v.el, ms, vi.pos);
      for (const t of tails) {
        const active = updateTail(t, ms);
        if (active || t.wasActive) dirty.push(t.group); // one extra pass zeroes it
        t.wasActive = active;
      }
      return dirty;
    };
  })();

  // The ring annulus net: unit outer radius in the local xz plane; the
  // shader recovers the radial fraction from |lp.xz| (74,500 km = 0.53025).
  {
    const SEG = 128;
    const RIN = 74500 / 140500;
    const verts: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * 2 * Math.PI;
      const c = Math.cos(a),
        s = Math.sin(a);
      verts.push(c * RIN, 0, s * RIN, 0, 1, 0, c, 0, s, 0, 1, 0);
      if (i < SEG) {
        const b = i * 2;
        idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
      }
    }
    patchGeoms.push({ name: 'saturnrings', verts: new Float32Array(verts), indices: new Uint32Array(idx) });
  }

  // ---- Jezero crater: the third surface site (Mars) ----
  // Octavia E. Butler Landing — where Perseverance touched down in 2021.
  // Fixed site, so its MOLA ring heightfields are baked at build time
  // (scripts/generate-mars.mjs); Viking imagery streams from NASA Mars Trek.
  // Unlike the Moon (which has its own orient call), the site rides Mars's
  // planetSpins basis via a postSpin hook — one rotation system per world.
  const JZ_LAT_DEG = 18.4447;
  const JZ_LON_DEG = 77.4508;
  const JZ_ELEV = -2563; // MOLA site elevation vs the areoid (crater floors are low)
  const R_MARS_REF = 3.3895e6;
  const R_JZ = R_MARS_REF + JZ_ELEV;
  const MARS_RINGS = [1024e3, 256e3, 64e3, 16e3];
  const jzFixedE: V3 = [0, 0, 0],
    jzFixedU: V3 = [0, 0, 0],
    jzFixedN: V3 = [0, 0, 0];
  fixedBasis(JZ_LAT_DEG * DEG, JZ_LON_DEG * DEG, jzFixedE, jzFixedU, jzFixedN);
  const jzEast: V3 = [...jzFixedE],
    jzUp: V3 = [...jzFixedU],
    jzNorth: V3 = [...jzFixedN];
  const jzBasis: [V3, V3, V3] = [jzEast, jzUp, jzNorth];
  const marsFrame = new Frame('mars', sunFrame, marsPos);
  const jezero = new Frame('jezero', marsFrame, [0, 0, 0]);
  const jzAnchored: { vec: V3; eun: V3 }[] = [{ vec: jezero.offset, eun: [0, R_JZ + 1, 0] }];
  const jzAnchor = (eun: V3): V3 => {
    const vec: V3 = [0, 0, 0];
    jzAnchored.push({ vec, eun });
    return vec;
  };
  postSpin.push(() => {
    const B = marsSpinBasis;
    const rot = (v: V3, out: V3): void => {
      for (let k = 0; k < 3; k++) out[k] = B[0][k] * v[0] + B[1][k] * v[1] + B[2][k] * v[2];
    };
    rot(jzFixedE, jzEast);
    rot(jzFixedU, jzUp);
    rot(jzFixedN, jzNorth);
    for (const a of jzAnchored) {
      for (let k = 0; k < 3; k++) a.vec[k] = jzEast[k] * a.eun[0] + jzUp[k] * a.eun[1] + jzNorth[k] * a.eun[2];
    }
  });
  MARS_RINGS.forEach((S, k) => {
    const g = ringGeometry(S, null, R_JZ, k < MARS_RINGS.length - 1);
    patchGeoms.push({ name: `marsring${k}`, verts: g.verts, indices: g.indices });
    meshes.push({
      frame: jezero,
      pos: jzAnchor([0, -1, 0]),
      mesh: `marsring${k}`,
      size: [1, 1, 1],
      bound: S * 0.71,
      color: [1, 1, 1],
      emissive: 0,
      matId: 11,
      rim: 1.0, // exposure gain: Viking color already matches its globe map
      gridScale: S,
      rot: jzBasis,
      prov: 0.5, // real Viking photography, procedural close-up detail
      tex: `marsring${k}`,
    });
  });
  // Perseverance stays at the site: car-sized (3.0 × 2.2 m), drawn as a
  // simple white box — illustrative, prov 1.
  meshes.push({
    frame: jezero,
    pos: jzAnchor([0, -1 + 1.1, 0]),
    mesh: 'box',
    size: [1.5, 1.1, 1.35],
    bound: 4,
    color: [0.86, 0.86, 0.9],
    emissive: 0,
    matId: 6,
    rim: 0,
    gridScale: 0,
    rot: jzBasis,
    prov: 1,
  });
  const dimpleMars = (depth: number): void => {
    const rr = 3.39e6 - Math.max(0, depth); // the render sphere's radius (planets table)
    marsMesh.size[0] = rr;
    marsMesh.size[1] = rr;
    marsMesh.size[2] = rr;
  };
  // The crater floor sits ~3.1 km below the render sphere; sink it now,
  // deeper once the baked heights load.
  dimpleMars(3.39e6 - R_JZ + 30);

  // Moon: real radius, the full inclined, perturbed orbit (5.1°, regressing
  // node, varying distance — see ephemeris.ts), and the real surface: the
  // LROC WAC global color mosaic on a tidally locked globe. The spin is
  // UNIFORM (one sidereal month), not "always face Earth": the difference
  // between uniform rotation and the varying orbital rate is the real
  // optical libration in longitude (±7.9°) — you see it by scrubbing time.
  // During a lunar eclipse, updateMoonShadow writes a dim/red multiplier
  // into color as the Moon crosses Earth's shadow (rings share the tint).
  const R_MOON = 1.7374e6; // LOLA reference radius
  const moonPos: V3 = [3.844e8, 0, 0];
  const moonFrame = new Frame('moon', earthFrame, moonPos);
  const moonRot: [V3, V3, V3] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const moonMesh = sphere(earthFrame, moonPos, R_MOON, [1, 1, 1], 10);
  moonMesh.rot = moonRot;
  moonMesh.tex = 'moon';
  moonMesh.prov = 0; // LROC imagery: measured
  meshes.push(moonMesh);
  // The drawn orbit ring stays in the ecliptic; the real moon rides up to
  // 5.1° off it — visibly honest at moon zoom.
  orbits.push({ frame: earthFrame, center: [0, 0, 0], radius: 3.844e8, color: [0.7, 0.72, 0.8], alpha: 0.16 });
  bodies.push({ a: 3.844e8, periodDays: 27.3217, L0: 218.32, positions: [moonPos], moon: true });

  // ---- the Galilean moons: real orbits, watchable speed ----
  // Io laps Jupiter in 1.77 days — 42 minutes of clock time at 1 min/s, a
  // clockwork you can actually watch. Elements fitted from JPL Horizons
  // (scripts/fit-galilean.mjs, held-out residuals under 6,500 km), solved
  // by the same Kepler machinery as the planets, centered on the live
  // Jupiter. Surfaces are honest tints (measured radii, stylized faces).
  const galileans: { mesh: MeshObj; pos: V3; base: [number, number, number]; r: number; spriteFloatBase: number }[] =
    [];
  for (const [slug, display, r, color] of [
    ['io', 'IO', 1.8216e6, [0.84, 0.74, 0.38]],
    ['europa', 'EUROPA', 1.5608e6, [0.86, 0.82, 0.73]],
    ['ganymede', 'GANYMEDE', 2.6341e6, [0.6, 0.56, 0.5]],
    ['callisto', 'CALLISTO', 2.4103e6, [0.42, 0.39, 0.36]],
  ] as [string, string, number, [number, number, number]][]) {
    const el = GALILEAN_ELEMENTS[slug];
    const pos: V3 = [el.a * AU, 0, 0];
    const m = sphere(sunFrame, pos, r, color, 4);
    m.prov = 0.5; // measured radius & orbit, stylized surface
    meshes.push(m);
    const ell = keplerEllipse(el);
    orbits.push({
      frame: sunFrame,
      center: jupiterPos, // live reference: the ellipses ride Jupiter
      radius: el.a * AU,
      color: [0.45, 0.6, 0.85],
      alpha: 0.16,
      axisA: ell.A,
      axisB: ell.B,
      centerOff: ell.center,
    });
    const spriteFloatBase = planetSprites.length * 8;
    planetSprites.push([...pos, r * 4, color[0], color[1], color[2], 0.2]);
    bodies.push({
      a: el.a * AU,
      periodDays: 36525 / (el.LDot / 360),
      L0: 0,
      positions: [pos],
      el,
      center: jupiterPos,
      spriteFloatBase,
    });
    // base must be a COPY: the eclipse dimmer writes mesh.color from it
    // every frame, and sphere() stores the color array by reference.
    galileans.push({ mesh: m, pos, base: [color[0], color[1], color[2]], r, spriteFloatBase });
    planetTargets.push({
      name: display,
      slug,
      frame: sunFrame,
      pos,
      dist: 8 * r,
      pitch: 0.2,
      sunlit: true,
      source: 'orbit fit to JPL Horizons (residuals < 6,500 km); measured size, stylized surface',
      parent: 'jupiter',
      exit: 5e9,
      radius: r,
      hidden: true,
    });
  }

  // ---- Tranquility Base: the second surface site ----
  // Apollo 11's landing site on Mare Tranquillitatis. Fixed (no lunar roam),
  // so its LOLA ring heightfields are baked at build time
  // (scripts/generate-moon.mjs); the WAC imagery streams from NASA Moon Trek.
  const TQ_LAT_DEG = 0.6741;
  const TQ_LON_DEG = 23.473;
  const TQ_ELEV = -1922; // LOLA site elevation vs the reference radius
  const R_TQ = R_MOON + TQ_ELEV; // the site is the rings' datum, like the picnic
  const MOON_RINGS = [1024e3, 256e3, 64e3, 16e3];
  // Moon-fixed site basis (same lat/lon convention as Earth's fixedDir).
  const tqFixedE: V3 = [0, 0, 0],
    tqFixedU: V3 = [0, 0, 0],
    tqFixedN: V3 = [0, 0, 0];
  fixedBasis(TQ_LAT_DEG * DEG, TQ_LON_DEG * DEG, tqFixedE, tqFixedU, tqFixedN);
  const tqEast: V3 = [...tqFixedE],
    tqUp: V3 = [...tqFixedU],
    tqNorth: V3 = [...tqFixedN];
  const tqBasis: [V3, V3, V3] = [tqEast, tqUp, tqNorth];
  // Site frame origin 1 m above the datum (same z-fight margin trick as the
  // picnic); parented to the moon frame, whose offset IS the live moonPos.
  const tranquility = new Frame('tranquility', moonFrame, [0, 0, 0]);
  const tqAnchored: { vec: V3; eun: V3 }[] = [{ vec: tranquility.offset, eun: [0, R_TQ + 1, 0] }];
  const tqAnchor = (eun: V3): V3 => {
    const vec: V3 = [0, 0, 0];
    tqAnchored.push({ vec, eun });
    return vec;
  };
  // Synchronous rotation: spin the moon-fixed system by ψ around the orbit
  // normal (+Y — the real axis is just 1.5° off it). main.ts drives ψ from
  // the Moon's MEAN longitude, so the near side faces Earth on average and
  // the ecliptic-longitude residuals appear as true longitude libration.
  const orientMoon = (psi: number): void => {
    const c = Math.cos(psi),
      s = Math.sin(psi);
    const rot = (v0: V3, out: V3): void => {
      out[0] = v0[0] * c + v0[2] * s;
      out[1] = v0[1];
      out[2] = -v0[0] * s + v0[2] * c;
    };
    rot([1, 0, 0], moonRot[0]);
    rot([0, 1, 0], moonRot[1]);
    rot([0, 0, 1], moonRot[2]);
    rot(tqFixedE, tqEast);
    rot(tqFixedU, tqUp);
    rot(tqFixedN, tqNorth);
    for (const a of tqAnchored) {
      a.vec[0] = tqEast[0] * a.eun[0] + tqUp[0] * a.eun[1] + tqNorth[0] * a.eun[2];
      a.vec[1] = tqEast[1] * a.eun[0] + tqUp[1] * a.eun[1] + tqNorth[1] * a.eun[2];
      a.vec[2] = tqEast[2] * a.eun[0] + tqUp[2] * a.eun[1] + tqNorth[2] * a.eun[2];
    }
  };
  // Street-level Moon: WAC imagery rings curved to the site's datum sphere,
  // sharing the moon mesh's color (the eclipse tint dims the ground too).
  // The innermost ring closes its hole — no lawn on the Moon; the center of
  // the stack is the same imagery, just past the source's native resolution.
  MOON_RINGS.forEach((S, k) => {
    const g = ringGeometry(S, null, R_TQ, k < MOON_RINGS.length - 1);
    patchGeoms.push({ name: `moonring${k}`, verts: g.verts, indices: g.indices });
    const m: MeshObj = {
      frame: tranquility,
      pos: tqAnchor([0, -1, 0]), // back down to the datum from the 1 m frame origin
      mesh: `moonring${k}`,
      size: [1, 1, 1],
      bound: S * 0.71,
      color: moonMesh.color, // SHARED: the lunar-eclipse multiplier
      emissive: 0,
      matId: 11,
      rim: 1.6, // exposure gain: raw WAC vs the albedo-normalized globe map
      gridScale: S,
      rot: tqBasis,
      prov: 0.5, // real WAC photography, procedural close-up regolith detail
      tex: `moonring${k}`,
    };
    meshes.push(m);
  });
  // The Eagle's descent stage stays at Tranquility Base (4.2 m across —
  // sized right, drawn as a simple gold-foil box: illustrative, prov 1).
  meshes.push({
    frame: tranquility,
    pos: tqAnchor([0, -1 + 1.5, 0]),
    mesh: 'box',
    size: [2.1, 1.5, 2.1],
    bound: 5,
    color: [0.82, 0.62, 0.25],
    emissive: 0,
    matId: 6,
    rim: 0,
    gridScale: 0,
    rot: tqBasis,
    prov: 1,
  });
  const dimpleMoon = (depth: number): void => {
    const rr = R_MOON - Math.max(0, depth);
    moonMesh.size[0] = rr;
    moonMesh.size[1] = rr;
    moonMesh.size[2] = rr;
  };
  // The site sits 1.9 km BELOW the reference sphere (mare plains are low):
  // sink the globe under the flat rings now; deeper once real heights load.
  dimpleMoon(-TQ_ELEV + 30);
  orientMoon(0);

  // Sun glare + planet locator sprites (so the system reads at 1e13 m).
  planetSprites.push([0, 0, 0, 2.2e9, 1.0, 0.85, 0.6, 2.2]);
  const planetSpriteGroup = groups.length;
  groups.push({ frame: sunFrame, pos: [0, 0, 0], data: new Float32Array(planetSprites.flat()), prov: 0 });

  // ---- The picnic (Powers of Ten, 1977): a one-meter blanket in the park
  // ---- by the lake, Lake Michigan glinting to the east ----
  // Affine linearization of the equirectangular map around a site, used by
  // the imagery materials to sample the global Black Marble at night:
  // uv(site) plus du per east-meter / dv per north-meter.
  const nightUV = (lat: number, lon: number): [number, number, number, number] => [
    0.5 + lon / (2 * Math.PI),
    0.5 - lat / Math.PI,
    1 / (2 * Math.PI * R_EARTH * Math.cos(lat)),
    -1 / (Math.PI * R_EARTH),
  ];

  // ---- The movable street-level imagery stack ----
  // The lawn disk and the six imagery rings anchor to their OWN earth-fixed
  // basis, initialized at the picnic but re-plantable anywhere on Earth by
  // setImagerySite (free roaming) — the picnic props stay in Chicago.
  const img = { lat: SITE_LAT_DEG, lon: SITE_LON_DEG, gen: 0 };
  const imgFixedE: V3 = [0, 0, 0],
    imgFixedU: V3 = [0, 0, 0],
    imgFixedN: V3 = [0, 0, 0];
  fixedBasis(SITE_LAT, SITE_LON, imgFixedE, imgFixedU, imgFixedN);
  const imgEast = registerFixed(imgFixedE);
  const imgUp = registerFixed(imgFixedU);
  const imgNorth = registerFixed(imgFixedN);
  const imgBasis: [V3, V3, V3] = [imgEast, imgUp, imgNorth];
  // Ring/lawn anchor: world offset from the surface frame's origin (the
  // picnic) to the imagery anchor point — recomputed as the planet turns.
  const ringPos: V3 = [0, 0, 0];
  const lawnPos: V3 = [0, 0, 0];
  postOrient.push(() => {
    for (let i = 0; i < 3; i++) {
      ringPos[i] = (imgUp[i] - up[i]) * (R_EARTH + 1.5);
      lawnPos[i] = ringPos[i] - imgUp[i] * 0.02;
    }
  });
  const imageryMeshes: MeshObj[] = [];

  // The lawn: a 380 m disk that plugs the innermost imagery ring's hole and
  // samples THAT RING'S OWN texture (matId 9), so the ground under your feet
  // IS the surrounding photograph — no seam, same lighting — with procedural
  // close-up detail and the faint 1 m grid on top.
  const nuv0 = nightUV(SITE_LAT, SITE_LON);
  const lawnMesh: MeshObj = {
    frame: surface,
    pos: lawnPos,
    mesh: 'disk',
    size: [380, 1, 380],
    bound: 380,
    color: [nuv0[0], nuv0[1], nuv0[2]],
    emissive: 0,
    matId: 9,
    rim: nuv0[3],
    gridScale: 2000 / 380, // shader: uv = lp/misc.y + 0.5 with lp in unit-disk coords
    rot: imgBasis,
    hideBelow: 2e-3, // the macro world fades once the dive passes the weave
    prov: 0.5, // real imagery, stylized close-up detail
    tex: 'ring5@0',
  };
  meshes.push(lawnMesh);
  imageryMeshes.push(lawnMesh);

  // ---- Street-level Earth: six concentric imagery rings on the sphere ----
  // Annular (no overlap, no z-fighting), curved to the exact sphere, lifted
  // slightly with size so boundaries nest cleanly, textured with stitched
  // Esri World Imagery at matching zoom. The innermost ring resolves ~2 m/px.
  // Built flat here; once real elevation streams in (terrain.ts), main.ts
  // rebuilds each ring via ringGeometry(S, heights) — same net, vertices
  // displaced radially by true relative elevation.
  RING_SIZES.forEach((S, k) => {
    const g = ringGeometry(S);
    patchGeoms.push({ name: `ring${k}`, verts: g.verts, indices: g.indices });
    const m: MeshObj = {
      frame: surface,
      pos: ringPos,
      mesh: `ring${k}`,
      size: [1, 1, 1], // geometry is already in meters
      bound: S * 0.71,
      color: [nuv0[0], nuv0[1], nuv0[2]], // affine Black Marble uv (see shader)
      emissive: 0,
      matId: 8,
      rim: nuv0[3],
      gridScale: S, // misc.y: the shader derives UVs from local pos / S
      rot: imgBasis,
      hideBelow: 2e-3,
      prov: 0, // measured: it is literally aerial photography
      tex: `ring${k}@0`,
    };
    meshes.push(m);
    imageryMeshes.push(m);
  });

  // Re-plant the imagery stack (lawn + rings) at a new site. Returns the
  // generation-stamped texture keys for the caller to stream imagery into
  // (stale keys should be dropped from the renderer).
  const setImagerySite = (latDeg: number, lonDeg: number): string[] => {
    img.lat = latDeg;
    img.lon = lonDeg;
    img.gen++;
    fixedBasis(latDeg * DEG, lonDeg * DEG, imgFixedE, imgFixedU, imgFixedN);
    const nuv = nightUV(latDeg * DEG, lonDeg * DEG);
    imageryMeshes.forEach((m, i) => {
      m.color[0] = nuv[0];
      m.color[1] = nuv[1];
      m.color[2] = nuv[2];
      m.rim = nuv[3];
      m.tex = i === 0 ? `ring5@${img.gen}` : `ring${i - 1}@${img.gen}`;
    });
    refreshOrient();
    return RING_SIZES.map((_, k) => `ring${k}@${img.gen}`);
  };
  const prop = (e: number, u: number, n: number, size: V3, color: [number, number, number], matId = 6): MeshObj => ({
    frame: surface,
    pos: anchor([e, u, n]),
    mesh: 'box',
    size,
    bound: Math.max(...size) * 1.8,
    color,
    emissive: 0,
    matId,
    rim: 0,
    gridScale: 0,
    rot: siteBasis,
    hideBelow: 2e-3,
    prov: 1,
  });
  meshes.push(prop(0, 0.012, 0, [0.5, 0.012, 0.5], [0.9, 0.9, 0.9], 7)); // THE one-meter blanket
  meshes.push(prop(0.22, 0.045, 0.28, [0.1, 0.015, 0.15], [0.35, 0.12, 0.08])); // the book
  meshes.push(prop(-0.28, 0.11, -0.12, [0.17, 0.11, 0.12], [0.5, 0.34, 0.16])); // the basket

  // ---- The inward journey (Powers of Ten, second act): one continuous
  // ---- straight dive through a single point on the blanket, 1 m -> 1e-16 m.
  // Every stage is centered on the micro frame's origin — a spot on a red
  // thread — so the descent is a pure zoom. All of it is illustrative, not
  // measured: sizes are right, arrangements are stylized.
  const micro = new Frame('micro', surface, anchor([0.12, 0.0245, 0.08]));
  const microTargets: Target[] = [];
  {
    // Optionally tilted site bases (fibril jitter); registered so rotation
    // re-derives them from the live basis.
    const computeTilt = (a: number, b: number, out: [V3, V3, V3]): void => {
      const [E, U, N] = siteBasis;
      const ca = Math.cos(a),
        sa = Math.sin(a);
      const e1: V3 = [E[0] * ca + N[0] * sa, E[1] * ca + N[1] * sa, E[2] * ca + N[2] * sa];
      const n1: V3 = [N[0] * ca - E[0] * sa, N[1] * ca - E[1] * sa, N[2] * ca - E[2] * sa];
      const cb = Math.cos(b),
        sb = Math.sin(b);
      for (let k = 0; k < 3; k++) {
        out[0][k] = e1[k];
        out[1][k] = U[k] * cb + n1[k] * sb;
        out[2][k] = n1[k] * cb - U[k] * sb;
      }
    };
    const tilt = (a: number, b: number): [V3, V3, V3] => {
      const basis: [V3, V3, V3] = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      computeTilt(a, b, basis);
      tiltedBases.push({ basis, a, b });
      return basis;
    };
    orientTilts = () => {
      for (const t of tiltedBases) computeTilt(t.a, t.b, t.basis);
    };
    // Point-group content (electron cloud, gluon haze) is rotationally
    // symmetric, so its buffers stay baked in the build-time (θ=0) basis.
    const staticPos = (e: number, u: number, n: number): V3 => [
      east0[0] * e + up0[0] * u + north0[0] * n,
      east0[1] * e + up0[1] * u + north0[1] * n,
      east0[2] * e + up0[2] * u + north0[2] * n,
    ];
    const mprop = (
      e: number,
      u: number,
      n: number,
      size: V3,
      color: [number, number, number],
      hideBelow: number,
      rot: [V3, V3, V3] = siteBasis,
    ): MeshObj => ({
      frame: micro,
      pos: anchor([e, u, n]),
      mesh: 'box',
      size,
      bound: Math.max(...size) * 1.8,
      color,
      emissive: 0,
      matId: 6,
      rim: 0,
      gridScale: 0,
      rot,
      hideBelow,
      prov: 1,
    });
    const msphere = (eun: V3, r: number, color: [number, number, number], hideBelow?: number): MeshObj => ({
      frame: micro,
      pos: anchor(eun),
      mesh: 'sphere',
      size: [r, r, r],
      bound: r,
      color,
      emissive: 0,
      matId: 6,
      rim: 0,
      gridScale: 0,
      hideBelow,
      prov: 1,
    });

    // 1e-2: the weave — warp and weft threads of the red cell.
    for (let i = -3; i <= 3; i++) {
      const shade = 0.62 + 0.14 * rand();
      meshes.push(mprop(0, -0.0003, i * 0.00068, [0.0225, 0.00028, 0.00032], [shade, 0.09, 0.07], 2e-3));
      meshes.push(
        mprop(i * 0.00068 + 0.00034, 0.00015, 0, [0.00032, 0.00028, 0.0225], [shade + 0.08, 0.13, 0.1], 2e-3),
      );
    }

    // 1e-4: the fiber — a loose bundle of cotton fibrils.
    for (let i = 0; i < 12; i++) {
      const th = i === 0 ? 8e-6 : 4e-6 + rand() * 6e-6;
      const off: [number, number] = i === 0 ? [0, 0] : [gaussian(rand) * 2.5e-5, gaussian(rand) * 2.5e-5];
      meshes.push(
        mprop(
          0,
          off[0],
          off[1],
          [2e-4, th, th],
          [0.88, 0.5 + rand() * 0.12, 0.45],
          6e-8,
          tilt((rand() - 0.5) * 0.3, (rand() - 0.5) * 0.2),
        ),
      );
    }

    // 1e-9: cellulose — a stylized chain of glucose rings (CPK colors). The
    // atom nearest the origin is removed and becomes the anchor carbon.
    {
      const atoms: { eun: V3; r: number; c: [number, number, number] }[] = [];
      for (let k = -5; k < 5; k++) {
        const cx = (k + 0.5) * 5.2e-10;
        const tiltU = k % 2 === 0 ? 3e-11 : -3e-11;
        for (let j = 0; j < 6; j++) {
          const a = (j / 6) * Math.PI * 2 + (k % 2 === 0 ? 0 : 0.5);
          const e = cx + Math.cos(a) * 1.45e-10;
          const n = Math.sin(a) * 1.45e-10;
          const isO = j === 0;
          atoms.push({
            eun: [e, tiltU * Math.sin(a), n],
            r: isO ? 1.4e-10 : 1.6e-10,
            c: isO ? [0.8, 0.25, 0.2] : [0.35, 0.37, 0.42],
          });
        }
        atoms.push({ eun: [cx + 2.6e-10, 0, 1.6e-10], r: 1.35e-10, c: [0.8, 0.25, 0.2] }); // bridge O
        atoms.push({ eun: [cx - 0.7e-10, 1.6e-10, -1.2e-10], r: 1.1e-10, c: [0.92, 0.92, 0.95] });
        atoms.push({ eun: [cx + 0.9e-10, -1.6e-10, 0.9e-10], r: 1.1e-10, c: [0.92, 0.92, 0.95] });
      }
      // Shift the chain so the nearest carbon sits exactly on the dive axis.
      let anchorIdx = 0;
      atoms.forEach((a, i) => {
        if (Math.hypot(...a.eun) < Math.hypot(...atoms[anchorIdx].eun)) anchorIdx = i;
      });
      const shift = atoms[anchorIdx].eun;
      // Neighbors vanish below the atom hand-off so the electron cloud stands
      // alone — the film isolates each subject the same way.
      atoms.forEach((a, i) => {
        if (i === anchorIdx) return;
        meshes.push(msphere([a.eun[0] - shift[0], a.eun[1] - shift[1], a.eun[2] - shift[2]], a.r, a.c, 2.5e-9));
      });
    }

    // 1e-10: the carbon atom — a two-shell electron cloud of point sprites
    // around a nucleus marker. Fades out above molecular scales.
    {
      const n1 = 600,
        n2 = 2200;
      const d = new Float32Array((n1 + n2 + 1) * 8);
      let o = 0;
      const puff = (rr: number, spread: number, inten: number) => {
        const rad = rr + gaussian(rand) * spread;
        const w = rand() * 2 - 1,
          ph = rand() * Math.PI * 2;
        const s = Math.sqrt(Math.max(1 - w * w, 0));
        const p = staticPos(rad * s * Math.cos(ph), rad * w, rad * s * Math.sin(ph));
        d[o] = p[0];
        d[o + 1] = p[1];
        d[o + 2] = p[2];
        d[o + 3] = 1.6e-12;
        d[o + 4] = 0.5;
        d[o + 5] = 0.72;
        d[o + 6] = 1.0;
        d[o + 7] = inten;
        o += 8;
      };
      for (let i = 0; i < n1; i++) puff(2.6e-11, 6e-12, 0.34);
      for (let i = 0; i < n2; i++) puff(6.4e-11, 1.4e-11, 0.16);
      // nucleus marker: a bright point revealing where the next stage lives
      d[o] = 0;
      d[o + 1] = 0;
      d[o + 2] = 0;
      d[o + 3] = 4e-14;
      d[o + 4] = 1.0;
      d[o + 5] = 0.95;
      d[o + 6] = 0.85;
      d[o + 7] = 1.6;
      groups.push({ frame: micro, pos: [0, 0, 0], data: d, fadeExtent: 8e-10, hideBelow: 5e-13, prov: 1 });
    }

    // 1e-14: the carbon nucleus — 6 protons + 6 neutrons; the one at the
    // origin is the dive target and is rendered as quarks, not a shell.
    for (let i = 1; i < 12; i++) {
      const a = i * 2.39996,
        w = -1 + (2 * i) / 11;
      const s = Math.sqrt(Math.max(1 - w * w, 0)) * 1.8e-15;
      meshes.push(
        msphere(
          [s * Math.cos(a), w * 1.8e-15, s * Math.sin(a)],
          8.8e-16,
          i % 2 === 0 ? [0.85, 0.42, 0.38] : [0.58, 0.58, 0.62],
          8e-15,
        ),
      );
    }

    // 1e-15: inside the proton — three quarks and a gluon haze. The edge of
    // the known.
    {
      const d = new Float32Array((3 + 70) * 8);
      let o = 0;
      const q = (e: number, n: number, c: [number, number, number]) => {
        const p = staticPos(e, 0, n);
        d[o] = p[0];
        d[o + 1] = p[1];
        d[o + 2] = p[2];
        d[o + 3] = 1.4e-16;
        d[o + 4] = c[0];
        d[o + 5] = c[1];
        d[o + 6] = c[2];
        d[o + 7] = 1.3;
        o += 8;
      };
      q(4e-16, 0, [1.0, 0.62, 0.3]);
      q(-2e-16, 3.5e-16, [1.0, 0.62, 0.3]);
      q(-2e-16, -3.5e-16, [0.45, 0.62, 1.0]);
      for (let i = 0; i < 70; i++) {
        const p = staticPos(gaussian(rand) * 3.5e-16, gaussian(rand) * 3.5e-16, gaussian(rand) * 3.5e-16);
        d[o] = p[0];
        d[o + 1] = p[1];
        d[o + 2] = p[2];
        d[o + 3] = 8e-17;
        d[o + 4] = 1.0;
        d[o + 5] = 0.8;
        d[o + 6] = 0.55;
        d[o + 7] = 0.12;
        o += 8;
      }
      groups.push({ frame: micro, pos: [0, 0, 0], data: d, fadeExtent: 2.5e-14, prov: 1 });
    }

    // The zoom chain, downward. All stages share the dive axis and the site
    // basis; enter/exit thresholds carry the usual hysteresis.
    const stage = (slug: string, name: string, dist: number, parent: string, exit: number): Target => ({
      name,
      slug,
      frame: micro,
      pos: [0, 0, 0],
      dist,
      pitch: 0.25,
      basis: siteBasis,
      parent,
      exit,
      hidden: true,
      button: true, // the inward journey earns a place on the HUD bar
      source: 'illustrative — true sizes, stylized arrangement',
    });
    microTargets.push(
      { ...stage('weave', 'THE WEAVE', 0.02, 'surface', 0.55), child: 'fiber', enter: 2.2e-3 },
      { ...stage('fiber', 'THE FIBER', 4.5e-4, 'weave', 3.5e-3), child: 'molecule', enter: 5e-8 },
      { ...stage('molecule', 'CELLULOSE', 4.5e-9, 'fiber', 8e-8), child: 'atom', enter: 3.5e-9 },
      { ...stage('atom', 'CARBON', 4.5e-10, 'molecule', 6e-9), child: 'nucleus', enter: 4.5e-13 },
      { ...stage('nucleus', 'THE NUCLEUS', 2.8e-14, 'atom', 7e-13), child: 'proton', enter: 9e-15 },
      stage('proton', 'THE PROTON', 3.5e-15, 'nucleus', 1.4e-14),
    );
  }

  // ---- The Messier catalog: 110 deep-sky destinations ----
  // Real positions, distances (Wikidata medians), and physical sizes;
  // rendered as type-tinted glows (an extended object is not a point, but
  // a soft sprite at its true size is the honest quick sketch — prov 0.5).
  const messierTargets: Target[] = [];
  {
    const TYPE_COLOR: Record<string, [number, number, number]> = {
      gc: [1.0, 0.85, 0.6], // globular cluster: old golden stars
      oc: [0.7, 0.8, 1.0], // open cluster: young blue-white
      pn: [0.5, 1.0, 0.9], // planetary nebula
      snr: [1.0, 0.7, 0.5], // supernova remnant
      sfr: [1.0, 0.6, 0.7], // star-forming nebula (M42 and kin)
    };
    const md = new Float32Array(MESSIER.length * 8);
    MESSIER.forEach(([n, name, ra, dec, distLy, sizeM, type, mag], i) => {
      const dir = raDecToScene(ra, dec);
      const dist = distLy * 9.4607e15;
      const pos: V3 = [dir[0] * dist, dir[1] * dist, dir[2] * dist];
      const c = TYPE_COLOR[type] ?? [0.92, 0.9, 0.82]; // galaxies & the rest: pale
      const o = i * 8;
      md[o] = pos[0];
      md[o + 1] = pos[1];
      md[o + 2] = pos[2];
      md[o + 3] = sizeM / 2;
      md[o + 4] = c[0];
      md[o + 5] = c[1];
      md[o + 6] = c[2];
      md[o + 7] = Math.min(Math.max(0.9 - 0.08 * mag, 0.08), 0.8);
      messierTargets.push({
        name: `M${n}${name ? ' · ' + name.toUpperCase() : ''}`,
        slug: `m${n}`,
        frame: sunFrame,
        pos,
        dist: Math.max(3 * sizeM, 1e15),
        pitch: 0.1,
        parent: 'galaxy',
        exit: Math.max(6e17, 3 * dist),
        radius: sizeM / 2,
        hidden: true,
        source: 'measured position, size & distance (Wikidata) — stylized glow',
      });
    });
    groups.push({ frame: sunFrame, pos: [0, 0, 0], data: md, fadeExtent: 5e24, prov: 0.5 });

    // ---- the neighborhood, in body ----
    // Every Messier galaxy gets a particle impression on its MEASURED
    // dimensions and orientation (RC3: position angle, axis ratio, Hubble
    // stage — src/data/galaxybodies.ts). The same honesty class as the
    // atlas's own Milky Way: real size, real tilt, illustrative arm
    // pattern. M31 leans in the sky exactly the way the real one does.
    const bodyPts: number[] = [];
    const DEG2 = Math.PI / 180;
    for (const [m, paDeg, ratio, t] of GALAXY_BODIES) {
      const entry = MESSIER.find((e) => e[0] === m);
      if (!entry) continue;
      const [, , ra, dec, distLy, sizeM] = entry;
      const dist = distLy * 9.4607e15;
      const dir = raDecToScene(ra, dec);
      const center: V3 = [dir[0] * dist, dir[1] * dist, dir[2] * dist];
      const raR = ((((ra % 360) + 360) % 360) * Math.PI) / 180;
      const decR = dec * DEG2;
      const east = eqVecToScene(-Math.sin(raR), Math.cos(raR), 0);
      const north = eqVecToScene(-Math.sin(decR) * Math.cos(raR), -Math.sin(decR) * Math.sin(raR), Math.cos(decR));
      const cpa = Math.cos(paDeg * DEG2);
      const spa = Math.sin(paDeg * DEG2);
      // Line of nodes (the major axis on the sky, N→E) and its sky-plane
      // perpendicular; the disk tilts the latter out of the sky by the
      // inclination recovered from the axis ratio (q0 = 0.2 intrinsic
      // thickness — the standard Hubble formula). Near vs far side is
      // unmeasured; the sign choice is part of the stylization.
      const U: V3 = [0, 1, 2].map((k) => north[k] * cpa + east[k] * spa) as V3;
      const Vsky: V3 = [0, 1, 2].map((k) => east[k] * cpa - north[k] * spa) as V3;
      const q = Math.min(1 / ratio, 1);
      const elliptical = t <= -3.5;
      const R = sizeM / 2;
      const n = m === 31 || m === 33 ? 4200 : 1600;
      if (elliptical) {
        // Oblate spheroid at the projected flattening; depth stylized.
        for (let i = 0; i < n; i++) {
          const g = Math.abs(gaussian(rand));
          const rr = Math.min((g * R) / 2.2, R);
          const u1 = rand() * 2 - 1;
          const ph = rand() * Math.PI * 2;
          const sxy = Math.sqrt(1 - u1 * u1);
          const x = rr * sxy * Math.cos(ph);
          const y = rr * sxy * Math.sin(ph) * q;
          const z = rr * u1 * q;
          bodyPts.push(
            center[0] + U[0] * x + Vsky[0] * y + dir[0] * z,
            center[1] + U[1] * x + Vsky[1] * y + dir[1] * z,
            center[2] + U[2] * x + Vsky[2] * y + dir[2] * z,
            R * 0.012 * (0.5 + rand()),
            1.0,
            0.87,
            0.68,
            0.05 + rand() * 0.1,
          );
        }
      } else {
        const cosI = Math.sqrt(Math.max(q * q - 0.04, 0) / 0.96);
        const inc = Math.acos(Math.min(cosI, 1));
        // Disk plane: U stays in the sky; W is Vsky tilted by the
        // inclination; the disk normal completes the frame.
        const W: V3 = [0, 1, 2].map((k) => Vsky[k] * Math.cos(inc) + dir[k] * Math.sin(inc)) as V3;
        const N: V3 = [0, 1, 2].map((k) => -Vsky[k] * Math.sin(inc) + dir[k] * Math.cos(inc)) as V3;
        const pitch = Math.tan(13 * DEG2);
        const bulge = t < 2 ? 0.34 : t < 5 ? 0.22 : 0.12; // early types: big bulges
        for (let i = 0; i < n; i++) {
          const isBulge = rand() < bulge;
          let x: number;
          let y: number;
          let z: number;
          let warm: boolean;
          if (isBulge) {
            const rr = (Math.abs(gaussian(rand)) * R) / 7;
            const u1 = rand() * 2 - 1;
            const ph = rand() * Math.PI * 2;
            const sxy = Math.sqrt(1 - u1 * u1);
            x = rr * sxy * Math.cos(ph);
            y = rr * sxy * Math.sin(ph);
            z = rr * u1 * 0.6;
            warm = true;
          } else {
            let rr = -Math.log(1 - rand()) * (R / 3.2);
            if (rr > R) rr = rand() * R;
            let th = rand() * Math.PI * 2;
            // pull toward the nearest of two log-spiral arms (skip for
            // lenticulars, T < 0 — disks without arms)
            if (t >= 0) {
              const armTh = Math.log(Math.max(rr, R / 40) / (R / 9)) / pitch;
              const rel = ((((th - armTh) % Math.PI) + Math.PI * 1.5) % Math.PI) - Math.PI / 2;
              th -= rel * 0.62 * Math.min(1, (rr * 4) / R);
            }
            x = rr * Math.cos(th);
            y = rr * Math.sin(th);
            z = gaussian(rand) * (R / 16);
            warm = rand() < 0.3;
          }
          const pink = !isBulge && t >= 3 && rand() < 0.05;
          bodyPts.push(
            center[0] + U[0] * x + W[0] * y + N[0] * z,
            center[1] + U[1] * x + W[1] * y + N[1] * z,
            center[2] + U[2] * x + W[2] * y + N[2] * z,
            R * 0.012 * (0.5 + rand()),
            pink ? 1.0 : warm ? 1.0 : 0.66,
            pink ? 0.55 : warm ? 0.85 : 0.74,
            pink ? 0.66 : warm ? 0.62 : 1.0,
            0.05 + rand() * 0.1,
          );
        }
      }
      // The featureless glow steps back where a body now stands, and the
      // fly-to arrival moves close enough for the body to fill the view.
      const gi = MESSIER.indexOf(entry) * 8;
      md[gi + 7] *= 0.3;
      const tgt = messierTargets[MESSIER.indexOf(entry)];
      if (tgt) tgt.dist = Math.max(1.9 * sizeM, 1e15);
    }
    groups.push({
      frame: sunFrame,
      pos: [0, 0, 0],
      data: Float32Array.from(bodyPts),
      fadeExtent: 6e24,
      prov: 0.5,
    });
  }

  // ---- Sagittarius A*: the black hole at the galactic center ----
  // The galaxy frame's origin IS the galactic center (the sun frame hangs
  // 8.3 kpc off it in the true Sgr A* direction), so the black hole and the
  // S stars — the stars whose measured Kepler ellipses weigh it — drop in
  // at zero. Orbits: Gillessen et al. 2017; mass & distance: GRAVITY 2022;
  // the ephemeris includes the Schwarzschild pericenter advance GRAVITY
  // measured on S2 (12.1′ per orbit) — see src/blackhole.ts and
  // scripts/verify-sstars.mjs.
  const sgrAGroup = groups.length;
  const sgrATargets: Target[] = [];
  const sgrAUpdate = ((): ((ms: number) => void) => {
    const n = S_STARS.length;
    const sd = new Float32Array(n * 8);
    const starR = 8 * R_SUN; // S stars are young B mains — stylized radius
    const positions: V3[] = [];
    S_STARS.forEach((s, i) => {
      const o = i * 8;
      sd[o + 3] = starR;
      sd[o + 4] = 0.78;
      sd[o + 5] = 0.85;
      sd[o + 6] = 1.0;
      sd[o + 7] = s.name === 'S2' ? 0.95 : 0.7;
      const pos: V3 = [0, 0, 0];
      positions.push(pos);
      const { A, B } = sStarAxes(s);
      orbits.push({
        frame: galaxy,
        center: [0, 0, 0],
        centerOff: [-s.e * A[0], -s.e * A[1], -s.e * A[2]],
        axisA: A,
        axisB: B,
        radius: s.aM,
        color: [0.5, 0.62, 0.9],
        alpha: 0.2,
        nearRatio: 0.0004,
        secondImage: true,
      });
      sgrATargets.push({
        name: s.name,
        slug: s.name.toLowerCase(),
        frame: galaxy,
        pos,
        dist: 60 * starR,
        pitch: 0.1,
        parent: 'sgr-a',
        exit: Math.max(1e15, 4 * s.aM),
        radius: starR,
        hidden: true,
        starColor: [0.78, 0.85, 1.0],
        source: 'measured orbit — Gillessen et al. 2017; stylized surface',
      });
    });
    // The shadow: an opaque sphere of exactly the capture impact parameter
    // √27/2 · rs subtends the correct silhouette from every distance — the
    // event horizon's shadow drawn as geometry, black because it is.
    meshes.push({
      frame: galaxy,
      pos: [0, 0, 0],
      mesh: 'sphere',
      size: [SGRA_SHADOW, SGRA_SHADOW, SGRA_SHADOW],
      bound: SGRA_SHADOW,
      color: [0, 0, 0],
      emissive: 0,
      matId: 0,
      rim: 0,
      gridScale: 0,
      prov: 0,
    });
    sgrATargets.push({
      name: 'SAGITTARIUS A* · BLACK HOLE',
      slug: 'sgr-a',
      frame: galaxy,
      pos: [0, 0, 0],
      dist: 5e14, // ~3300 AU: S2's whole ellipse in view; scroll in for the shadow
      pitch: 0.15,
      parent: 'galaxy',
      exit: 6e19,
      radius: SGRA_SHADOW,
      hidden: true,
      source: 'measured — M•, R0: GRAVITY 2022; S-star orbits: Gillessen et al. 2017',
    });
    groups.push({
      frame: galaxy,
      pos: [0, 0, 0],
      data: sd,
      fadeExtent: 2.5e18,
      nearFade: true,
      prov: 0,
      stellar: true,
    });
    // Sgr A*'s own glow — the accretion flow really does shine (EHT's ring
    // is its picture), but ours is a stylized warm sprite: its OWN group,
    // marked stylized-on-real, so the honest seam turns it amber while the
    // S stars around it stay measured-natural.
    groups.push({
      frame: galaxy,
      pos: [0, 0, 0],
      data: Float32Array.from([0, 0, 0, 8e10, 1.0, 0.72, 0.42, 0.5]),
      fadeExtent: 2.5e18,
      prov: 0.5,
    });
    const tmp: V3 = [0, 0, 0];
    const update = (ms: number): void => {
      S_STARS.forEach((s, i) => {
        sStarPos(s, ms, tmp);
        const o = i * 8;
        sd[o] = tmp[0];
        sd[o + 1] = tmp[1];
        sd[o + 2] = tmp[2];
        const p = positions[i];
        p[0] = tmp[0];
        p[1] = tmp[1];
        p[2] = tmp[2];
      });
    };
    update(Date.UTC(2000, 0, 1, 12)); // deterministic build; main re-times it
    return update;
  })();

  // ---- the Local Group census: every known dwarf galaxy ----
  // McConnachie 2012 — measured positions, distances, half-light radii,
  // luminosities. The volume between the Milky Way and Andromeda is not
  // empty, and now it isn't drawn empty: 96 real neighbors as type-tinted
  // glows (real position & size, stylized look), each one a destination.
  const lgTargets: Target[] = [];
  {
    const d = new Float32Array(LOCAL_GROUP.length * 8);
    LOCAL_GROUP.forEach(([name, ra, dec, distKpc, rHalfKpc, vMag], i) => {
      const dir = raDecToScene(ra, dec);
      const dist = distKpc * KPC;
      const pos: V3 = [dir[0] * dist, dir[1] * dist, dir[2] * dist];
      const size = 3 * rHalfKpc * KPC; // the glow spans ~3 half-light radii
      const o = i * 8;
      d[o] = pos[0];
      d[o + 1] = pos[1];
      d[o + 2] = pos[2];
      d[o + 3] = size / 2;
      d[o + 4] = 0.93;
      d[o + 5] = 0.87;
      d[o + 6] = 0.78; // old, metal-poor starlight: uniformly warm-pale
      d[o + 7] = Math.min(Math.max(-0.028 * vMag - 0.02, 0.05), 0.4);
      lgTargets.push({
        name: name.toUpperCase(),
        slug: slugify(name),
        frame: sunFrame,
        pos,
        dist: Math.max(4 * size, 2e19),
        pitch: 0.1,
        parent: 'galaxy',
        exit: Math.max(6e20, 3 * dist),
        radius: size / 2,
        hidden: true,
        source: 'measured position, distance & size — McConnachie 2012 census; stylized glow',
      });
    });
    groups.push({ frame: sunFrame, pos: [0, 0, 0], data: d, fadeExtent: 1e24, prov: 0.5 });
  }

  // ---- the Magellanic Clouds: fly-to targets (the stars stream in
  // main.ts once the tiles land — Gaia DR3 members, see magellanic.ts) ----
  const cloudTargets: Target[] = CLOUDS.map((c) => {
    const dir = raDecToScene(c.ra, c.dec);
    return {
      name: c.name,
      slug: c.slug,
      frame: sunFrame,
      pos: [dir[0] * c.distM, dir[1] * c.distM, dir[2] * c.distM] as V3,
      dist: 4.5 * c.radiusM,
      pitch: 0.15,
      parent: 'galaxy',
      exit: 3 * c.distM,
      radius: c.radiusM,
      hidden: true,
      source: 'measured stars — Gaia DR3; distance: eclipsing binaries; depth stylized',
    };
  });

  // ---- exoplanet destinations: Proxima Centauri and TRAPPIST-1 ----
  // Real star radii and colors, planets with measured radii on their
  // measured orbits — the survey layer (4,708 systems) streams separately
  // in main.ts. Orbit orientation/phase are stylized (see exoplanets.ts).
  const exoTargets: Target[] = [];
  const exoUpdate = ((): ((ms: number) => void) => {
    const live: { p: ExoPlanet; u: V3; v: V3; star: V3; pos: V3 }[] = [];
    for (const s of EXO_SYSTEMS) {
      const { pos: starPos, u: lu, v: lv } = exoBasis(s);
      const starR = exoStarRadius(s);
      meshes.push({
        frame: sunFrame,
        pos: starPos,
        mesh: 'sphere',
        size: [starR, starR, starR],
        bound: starR,
        color: s.color,
        emissive: 0,
        matId: 2,
        rim: 0,
        gridScale: 0,
        prov: 0.5,
      });
      const span = exoOrbitRadius(s.planets[s.planets.length - 1]);
      exoTargets.push({
        name: s.name,
        slug: s.slug,
        frame: sunFrame,
        pos: starPos,
        dist: Math.max(40 * starR, 3.2 * span),
        pitch: 0.15,
        parent: 'galaxy',
        exit: Math.max(6e17, 3 * s.distPc * 3.0857e16),
        radius: starR,
        hidden: true,
        source: 'measured — NASA Exoplanet Archive; orbit orientation & phase stylized',
      });
      for (const p of s.planets) {
        const r = exoPlanetRadius(p);
        const pos: V3 = [starPos[0], starPos[1], starPos[2]];
        live.push({ p, u: lu, v: lv, star: starPos, pos });
        meshes.push({
          frame: sunFrame,
          pos,
          mesh: 'sphere',
          size: [r, r, r],
          bound: r,
          color: [0.62, 0.58, 0.54],
          emissive: 0,
          matId: 4,
          rim: 0,
          gridScale: 0,
          prov: 0.5,
          litFrom: starPos,
        });
        const a = exoOrbitRadius(p);
        orbits.push({
          frame: sunFrame,
          center: starPos,
          radius: a,
          axisA: [a * lu[0], a * lu[1], a * lu[2]],
          axisB: [a * lv[0], a * lv[1], a * lv[2]],
          color: [0.55, 0.8, 0.62],
          alpha: 0.22,
        });
        exoTargets.push({
          name: p.name,
          slug: p.slug,
          frame: sunFrame,
          pos,
          dist: 40 * r,
          pitch: 0.1,
          parent: s.slug,
          exit: Math.max(1e11, 4 * a),
          radius: r,
          hidden: true,
          sunlit: true,
          lightPos: starPos,
          source: 'measured radius, a & period (NASA Exoplanet Archive) — surface & orbit orientation stylized',
        });
      }
    }
    const off: V3 = [0, 0, 0];
    const update = (ms: number): void => {
      for (const l of live) {
        exoPlanetOffset(l.p, l.u, l.v, ms, off);
        l.pos[0] = l.star[0] + off[0];
        l.pos[1] = l.star[1] + off[1];
        l.pos[2] = l.star[2] + off[2];
      }
    };
    update(Date.UTC(2000, 0, 1, 12)); // deterministic build; main re-times it
    return update;
  })();

  // (The old procedural "local stars" sprinkle is gone: the streamed ATHYG
  // tiles — 850k+ real Tycho-2/Gaia stars — fill the solar neighborhood now.)

  // ---- The 300 brightest REAL stars (HYG catalog): true positions,
  // ---- colors from B-V, brightness from apparent magnitude ----
  const starMeshes: MeshObj[] = [];
  const starTargets: Target[] = [];
  // Named stars are destinations with CPU-side positions (targets, the
  // famous five's meshes) — they drift with the same real velocities the
  // GPU applies to their sprites, so a deep-time Sirius stays clickable
  // exactly where its light is.
  const starDrifts: { pos: V3; base: V3; vel: V3 }[] = [];
  const driftStars = (years: number): void => {
    for (const sd of starDrifts) {
      sd.pos[0] = sd.base[0] + sd.vel[0] * years;
      sd.pos[1] = sd.base[1] + sd.vel[1] * years;
      sd.pos[2] = sd.base[2] + sd.vel[2] * years;
    }
  };
  {
    const d = new Float32Array(BRIGHT_STARS.length * 11);
    // Famous destinations: real radii, rendered as star-surface spheres.
    const famous = new Map<string, { slug: string; radius: number }>([
      ['Sirius', { slug: 'sirius', radius: 1.71 * R_SUN }],
      ['Rigil Kentaurus', { slug: 'alpha-centauri', radius: 1.22 * R_SUN }],
      ['Vega', { slug: 'vega', radius: 2.36 * R_SUN }],
      ['Betelgeuse', { slug: 'betelgeuse', radius: 764 * R_SUN }],
      ['Polaris', { slug: 'polaris', radius: 37.5 * R_SUN }],
    ]);
    const usedSlugs = new Set<string>();
    BRIGHT_STARS.forEach(([x0, y0, z0, mag, ci, lum, name, vx0, vy0, vz0], i) => {
      const [x, y, z] = orientSky(x0, y0, z0); // into the true sky
      const vel = orientSky(vx0, vy0, vz0); // real 3D space velocity, m/yr
      const o = i * 11;
      const c = bvToRgb(ci);
      const estRadius = Math.min(Math.max(R_SUN * Math.sqrt(lum), 5e8), 2e11);
      d[o] = x;
      d[o + 1] = y;
      d[o + 2] = z;
      d[o + 3] = estRadius;
      d[o + 4] = c[0];
      d[o + 5] = c[1];
      d[o + 6] = c[2];
      d[o + 7] = Math.min(Math.max(1.4 - 0.3 * mag, 0.35), 2.0);
      d[o + 8] = vel[0];
      d[o + 9] = vel[1];
      d[o + 10] = vel[2];
      const f = famous.get(name);
      if (f) {
        const meshPos: V3 = [x, y, z];
        starDrifts.push({ pos: meshPos, base: [x, y, z], vel });
        starMeshes.push({
          frame: sunFrame,
          pos: meshPos,
          mesh: 'sphere',
          size: [f.radius, f.radius, f.radius],
          bound: f.radius,
          color: c,
          emissive: 0,
          matId: 2,
          rim: 0,
          gridScale: 0,
        });
      }
      // Every named star is a destination: clickable, and a ?goto= slug.
      if (name) {
        let slug = f?.slug ?? slugify(name);
        if (usedSlugs.has(slug)) slug = `${slug}-${i}`;
        usedSlugs.add(slug);
        const radius = f?.radius ?? estRadius;
        const targetPos: V3 = [x, y, z];
        starDrifts.push({ pos: targetPos, base: [x, y, z], vel });
        starTargets.push({
          name: name.toUpperCase(),
          slug,
          frame: sunFrame,
          pos: targetPos,
          dist: 40 * radius,
          pitch: 0.1,
          parent: 'galaxy',
          // Far stars need a proportionally far exit, or clicking one from
          // across the neighborhood would immediately hand focus back.
          exit: Math.max(6e17, 3 * Math.hypot(x, y, z)),
          radius,
          hidden: true,
          source: 'measured — ATHYG: Tycho-2 + Gaia DR3, stylized surface',
          // The famous five have real hand-built meshes; everyone else gets a
          // dynamic one from this color when focused.
          starColor: f ? undefined : c,
        });
      }
    });
    groups.push({
      frame: sunFrame,
      pos: [0, 0, 0],
      data: d,
      fadeExtent: 8e18,
      nearFade: true,
      prov: 0,
      stellar: true,
      mode: 'moving',
    });
  }
  meshes.push(...starMeshes);

  // ---- The galaxy: exponential disk + 2-arm log spiral + bulge + halo ----
  {
    const nDisk = 70000,
      nBulge = 16000,
      nHalo = 3000;
    const d = new Float32Array((nDisk + nBulge + nHalo) * 8);
    const Rd = 8e19,
      Rmax = 4.8e20; // real Milky Way: ~2.6 kpc scale length, ~50 kly radius
    const pitch = Math.tan((13 * Math.PI) / 180);
    let o = 0;
    // Generated in the old galactic-swizzle convention (disk in XZ), then
    // rotated into the true scene orientation with the same map as the stars.
    const put = (x0: number, y0: number, z0: number, size: number, c: [number, number, number], inten: number) => {
      const [x, y, z] = orientSky(x0, y0, z0);
      d[o] = x;
      d[o + 1] = y;
      d[o + 2] = z;
      d[o + 3] = size;
      d[o + 4] = c[0];
      d[o + 5] = c[1];
      d[o + 6] = c[2];
      d[o + 7] = inten;
      o += 8;
    };
    for (let i = 0; i < nDisk; i++) {
      let r = -Math.log(1 - rand()) * Rd;
      if (r > Rmax) r = rand() * Rmax;
      let th = rand() * Math.PI * 2;
      // Pull toward the nearest of two logarithmic spiral arms.
      const armTh = Math.log(Math.max(r, 1e18) / 2.4e19) / pitch;
      const rel = ((((th - armTh) % Math.PI) + Math.PI * 1.5) % Math.PI) - Math.PI / 2;
      th -= rel * 0.6 * Math.min(1, r / 3e19);
      const zScale = 3e18 * (0.5 + r / Rmax);
      const t = Math.min(1, r / (Rmax * 0.85));
      let c: [number, number, number] = [
        1.0 - 0.38 * t + (rand() - 0.5) * 0.1,
        0.86 - 0.12 * t + (rand() - 0.5) * 0.1,
        0.65 + 0.35 * t + (rand() - 0.5) * 0.1,
      ];
      if (rand() < 0.05 && r > 3e19) c = [1.0, 0.5, 0.62]; // HII regions in the arms
      put(r * Math.cos(th), gaussian(rand) * zScale, r * Math.sin(th), 3e17 * (0.4 + rand()), c, 0.05 + rand() * 0.12);
    }
    for (let i = 0; i < nBulge; i++) {
      put(
        gaussian(rand) * 4.6e19,
        gaussian(rand) * 2.8e19,
        gaussian(rand) * 4.6e19,
        3e17 * (0.4 + rand()),
        [1.0, 0.83, 0.58],
        0.06 + rand() * 0.12,
      );
    }
    for (let i = 0; i < nHalo; i++) {
      const rr = Math.pow(rand(), 0.5) * 8e20;
      const u = rand() * 2 - 1,
        ph = rand() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      put(rr * s * Math.cos(ph), rr * u, rr * s * Math.sin(ph), 3e17, [1.0, 0.92, 0.78], 0.02 + rand() * 0.03);
    }
    // gcYield: the procedural cloud is the galaxy seen from OUTSIDE; a
    // camera deep in the center sits inside the additive bulge sprites and
    // the sky washes to white — so near Sgr A* the illustrative glow steps
    // aside (never fully off) and the measured S-star cluster owns the view.
    groups.push({ frame: galaxy, pos: [0, 0, 0], data: d, prov: 1, gcYield: true });
  }

  // ---- Cosmic web: nodes + filaments, each point one "galaxy" ----
  let webNodePos: V3 = [0, 0, 0];
  let webGroup = 0;
  {
    const NODES = 64;
    const nodes: V3[] = [[0, 0, 0]]; // node 0 = our Local Group, so we sit inside the web
    for (let i = 1; i < NODES; i++) {
      const rr = Math.pow(rand(), 0.7) * 2.2e26;
      const u = rand() * 2 - 1,
        ph = rand() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      nodes.push([rr * s * Math.cos(ph), rr * u, rr * s * Math.sin(ph)]);
    }
    webNodePos = nodes[7];
    const pts: number[] = [];
    // The volume within ~260 Mpc is REAL now — the 2MASS Redshift Survey
    // (galaxies.ts) fills it with 43k measured galaxies — so the procedural
    // placeholder only populates the space beyond the survey's reach, with
    // a feathered boundary so the hand-off has no dark shell.
    const SURVEY_R = 6e24;
    const putGal = (x: number, y: number, z: number) => {
      const rr0 = Math.hypot(x, y, z);
      if (rr0 < SURVEY_R + (rand() - 0.15) * 5e24) return;
      // Where — and only as deep as — SDSS actually measured, the
      // procedural placeholder steps aside and the real wedges own the
      // volume (the 2°×2° mask ships with the app; the survey's own
      // maximum depth per direction is baked into each cell).
      {
        const [ra, dec] = sceneDirToRaDec([x, y, z]);
        const cell =
          Math.min(Math.floor((dec + 90) / 2), SDSS_MASK_H - 1) * SDSS_MASK_W +
          Math.min(Math.floor(ra / 2), SDSS_MASK_W - 1);
        const depth = SDSS_MASK[cell] * SDSS_MASK_DEPTH_UNIT;
        if (rr0 < depth - rand() * 3e24) return;
      }
      const warm = rand() < 0.3;
      pts.push(
        x,
        y,
        z,
        5e21 * (0.5 + rand()),
        warm ? 1.0 : 0.62,
        warm ? 0.85 : 0.55,
        warm ? 0.7 : 1.0,
        0.05 + rand() * 0.09,
      );
    };
    for (let i = 0; i < NODES; i++) {
      // connect to 2 nearest nodes
      const dists = nodes
        .map((p, j) => [Math.hypot(p[0] - nodes[i][0], p[1] - nodes[i][1], p[2] - nodes[i][2]), j])
        .sort((a, b) => a[0] - b[0]);
      for (let k = 1; k <= 2; k++) {
        const j = dists[k][1];
        if (j < i) continue; // dedupe
        for (let m = 0; m < 220; m++) {
          const t = rand();
          putGal(
            nodes[i][0] + (nodes[j][0] - nodes[i][0]) * t + gaussian(rand) * 5e24,
            nodes[i][1] + (nodes[j][1] - nodes[i][1]) * t + gaussian(rand) * 5e24,
            nodes[i][2] + (nodes[j][2] - nodes[i][2]) * t + gaussian(rand) * 5e24,
          );
        }
      }
      for (let m = 0; m < 130; m++) {
        putGal(
          nodes[i][0] + gaussian(rand) * 9e24,
          nodes[i][1] + gaussian(rand) * 9e24,
          nodes[i][2] + gaussian(rand) * 9e24,
        );
      }
    }
    webGroup = groups.length;
    groups.push({ frame: root, pos: [0, 0, 0], data: new Float32Array(pts), prov: 1 });
  }
  // The web bookmark lands on the real Coma cluster — the heart of the
  // Great Wall, ~100 Mpc away in the 2MRS data (RA 194.95°, Dec +27.98°).
  {
    const coma = raDecToScene(194.953, 27.981);
    const d = 3.05e24;
    webNodePos[0] = coma[0] * d;
    webNodePos[1] = coma[1] * d;
    webNodePos[2] = coma[2] * d;
  }
  // Cosmic expansion: the web is drawn in comoving coordinates (the arrays
  // above are the a = 1 snapshot); scaleWeb(a) multiplies the space between
  // galaxies by the ΛCDM scale factor. Node 0 is us, so we stay the origin —
  // the comoving observer's view. Galaxies themselves don't grow: positions
  // scale, sprite sizes don't.
  const webBase = Float32Array.from(groups[webGroup].data);
  const webNodeBase: V3 = [...webNodePos];
  const scaleWeb = (a: number): Float32Array<ArrayBuffer> => {
    const d = groups[webGroup].data;
    for (let i = 0; i < d.length; i += 8) {
      d[i] = webBase[i] * a;
      d[i + 1] = webBase[i + 1] * a;
      d[i + 2] = webBase[i + 2] * a;
    }
    // The web bookmark rides its node so the camera still arrives somewhere.
    webNodePos[0] = webNodeBase[0] * a;
    webNodePos[1] = webNodeBase[1] * a;
    webNodePos[2] = webNodeBase[2] * a;
    return d;
  };

  // The main zoom chain is universe → galaxy → system → earth → surface;
  // sun / moon / web are leaves you visit explicitly and scroll back out of.
  // Mars graduates from hidden planet target to a bar bookmark: the tour
  // stops in front of it (like the Moon and Earth) on its way to Jezero.
  const marsTarget = planetTargets.find((t) => t.slug === 'mars')!;
  marsTarget.hidden = false;
  const targets: Target[] = [
    {
      name: 'OBSERVABLE UNIVERSE',
      slug: 'universe',
      source: 'illustrative — procedural cosmic structure',
      frame: root,
      pos: [0, 0, 0],
      dist: 7e26,
      pitch: 0.35,
      child: 'galaxy',
      enter: 3e23,
    },
    {
      name: 'COSMIC WEB',
      slug: 'web',
      source: 'measured to ~260 Mpc — 2MASS Redshift Survey; procedural beyond',
      frame: root,
      pos: webNodePos,
      dist: 2.6e25,
      pitch: 0.2,
      parent: 'universe',
      exit: 3.5e26,
    },
    {
      name: 'MILKY WAY',
      slug: 'galaxy',
      source: 'illustrative — real dimensions, procedural structure',
      frame: galaxy,
      pos: [0, 0, 0],
      dist: 3.4e21,
      pitch: 0.55,
      parent: 'universe',
      exit: 8e23,
      child: 'system',
      enter: 7.5e20,
    },
    {
      name: 'SOLAR SYSTEM',
      slug: 'system',
      source: 'measured — full Keplerian orbits, verified against JPL Horizons',
      frame: sunFrame,
      pos: [0, 0, 0],
      dist: 1.15e13,
      pitch: 0.9,
      parent: 'galaxy',
      exit: 1.65e21,
      child: 'earth',
      enter: 4.5e11,
    },
    {
      name: 'THE SUN',
      slug: 'sun',
      source: 'measured size & color — stylized surface',
      frame: sunFrame,
      pos: [0, 0, 0],
      dist: 4.5e9,
      pitch: 0.1,
      parent: 'system',
      exit: 5e10,
      radius: 6.957e8,
    },
    // Bookmarks follow the grand tour's order exactly: sun → Mars → Jezero →
    // Moon → Tranquility → Earth → the picnic — each world, then its surface.
    marsTarget,
    {
      name: 'JEZERO CRATER',
      slug: 'jezero',
      source: 'Perseverance landing site, 18.445°N 77.451°E — Viking imagery, MOLA terrain',
      frame: jezero,
      pos: jzAnchor([0, 0.5, 0]),
      dist: 4e4,
      pitch: 0.35,
      sunlit: true,
      parent: 'mars',
      exit: 2e7,
      basis: jzBasis,
    },
    {
      name: 'THE MOON',
      slug: 'moon',
      source: 'measured — LROC WAC mosaic, true synchronous rotation',
      frame: earthFrame,
      pos: moonPos,
      dist: 8e6,
      pitch: 0.1,
      sunlit: true,
      parent: 'earth',
      exit: 1.2e8,
      child: 'tranquility',
      enter: 2.8e6,
      radius: R_MOON,
    },
    {
      name: 'TRANQUILITY BASE',
      slug: 'tranquility',
      source: 'Apollo 11 site, 0.674°N 23.473°E — LRO WAC imagery, LOLA terrain',
      frame: tranquility,
      pos: tqAnchor([0, 0.5, 0]),
      dist: 4e4,
      pitch: 0.35,
      sunlit: true,
      parent: 'moon',
      exit: 7e6,
      basis: tqBasis,
    },
    {
      name: 'EARTH',
      slug: 'earth',
      source: 'measured — NASA Blue Marble & Black Marble',
      frame: earthFrame,
      pos: [0, 0, 0],
      dist: 4.2e7,
      pitch: 0.15,
      sunlit: true,
      parent: 'system',
      exit: 9.9e11,
      child: 'surface',
      enter: 2.2e7,
      radius: R_EARTH,
    },
    {
      name: 'THE PICNIC · 1 METER',
      slug: 'surface',
      source: 'real place, 41.869°N 87.618°W — imagery © Esri/Maxar',
      frame: surface,
      pos: anchor([0, 0.3, 0]),
      dist: 6,
      pitch: 0.25,
      parent: 'earth',
      exit: 5.5e7,
      child: 'weave',
      enter: 0.35,
      basis: siteBasis,
    },
    // Hidden targets stay after the visible bookmarks.
    ...microTargets,
    ...planetTargets.filter((t) => t.slug !== 'mars'),
    ...starTargets,
    ...messierTargets,
    ...sgrATargets,
    ...exoTargets,
    ...cloudTargets,
    ...lgTargets,
    // Free Earth navigation: a movable surface focus. Panning near Earth
    // roams this point anywhere on the planet; the imagery stack follows.
    {
      name: 'EARTH · ROAMING',
      slug: 'roam',
      source: 'real place — imagery © Esri/Maxar',
      frame: earthFrame,
      pos: roamPos,
      dist: 2e5,
      pitch: 0.35,
      parent: 'earth',
      exit: 5.5e7,
      basis: roamBasis,
      hidden: true,
    },
  ];

  // No two destinations may share a slug — a duplicate silently hijacks
  // ?goto= for whichever registered first (96 dwarf names just joined).
  {
    const seen = new Set<string>();
    for (const t of targets) {
      while (seen.has(t.slug)) t.slug += '-b';
      seen.add(t.slug);
    }
  }

  return {
    root,
    sunFrame,
    meshes,
    groups,
    orbits,
    targets,
    bodies,
    planetSpriteGroup,
    webGroup,
    moonMesh,
    galileans,
    jupiterPos,
    earthRot,
    sgrA: { frame: galaxy, group: sgrAGroup, update: sgrAUpdate },
    comets: { update: cometUpdate },
    exo: { update: exoUpdate },
    moonFrame,
    driftStars,
    planetSpins,
    postSpin,
    marsFrame,
    orientEarth,
    orientMoon,
    orientGalaxy,
    scaleWeb,
    patchGeoms,
    // waterLevel: Lake Michigan's surface, ~176 m above sea level (IGLD85) —
    // the DEM floor, so lakebed bathymetry can't carve the water into a bowl.
    site: { lat: SITE_LAT_DEG, lon: SITE_LON_DEG, ringSizes: RING_SIZES, waterLevel: 176 },
    nav: {
      home: [SITE_LAT_DEG, SITE_LON_DEG],
      roamLatLon: () => [roam.lat / DEG, roam.lon / DEG],
      setRoam,
      setRoamFromWorld,
      roamMove,
      imagerySite: () => [img.lat, img.lon],
      setImagerySite,
      imageryKeys: () => RING_SIZES.map((_, k) => `ring${k}@${img.gen}`),
      dimpleEarth: (depth: number) => dimpleEarth(depth),
      // Gnomonic site-local coordinates (east/north meters on the imagery
      // tangent) of a world position relative Earth's center — the same
      // parameterization the terrain rings use, so the camera can ask how
      // high the ground is beneath it. Null on the planet's far side.
      gnomonicEUN: (p: V3): [number, number] | null => {
        const py = d3(p, imgUp);
        if (py <= 0) return null;
        return [(R_EARTH * d3(p, imgEast)) / py, (R_EARTH * d3(p, imgNorth)) / py];
      },
      moon: {
        site: [TQ_LAT_DEG, TQ_LON_DEG],
        ringSizes: MOON_RINGS,
        R: R_TQ,
        dimpleMoon,
        gnomonicEUN: (p: V3): [number, number] | null => {
          const py = d3(p, tqUp);
          if (py <= 0) return null;
          return [(R_TQ * d3(p, tqEast)) / py, (R_TQ * d3(p, tqNorth)) / py];
        },
      },
      mars: {
        site: [JZ_LAT_DEG, JZ_LON_DEG],
        ringSizes: MARS_RINGS,
        R: R_JZ,
        dimpleMars,
        gnomonicEUN: (p: V3): [number, number] | null => {
          const py = d3(p, jzUp);
          if (py <= 0) return null;
          return [(R_JZ * d3(p, jzEast)) / py, (R_JZ * d3(p, jzNorth)) / py];
        },
      },
    },
  };
}
