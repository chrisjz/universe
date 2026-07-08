// Placeholder universe. Structure is procedural (deterministic seed) but all
// solar-system dimensions are real: actual semi-major axes, actual radii,
// actual Sun-galactic-center distance. This is the content that later gets
// replaced by Gaia / SDSS / NASA catalogs — the frame tree stays the same.

import { V3, mulberry32, gaussian } from './math';
import { Frame } from './frames';
import { MeshKind } from './renderer';
import { BRIGHT_STARS } from './data/brightstars';
import { orientSky, raDecToScene } from './sky';

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
  // Honest-seam provenance: 0 = measured, 0.5 = real dimensions but stylized
  // look, 1 = illustrative. Drives the seam view's recoloring.
  prov?: number;
  tex?: string; // texture key: 'earth' = day/night pair; others via addTexture
}

export interface PointGroup {
  frame: Frame;
  pos: V3;
  data: Float32Array<ArrayBuffer>;
  // Star fields fade out as the camera pulls beyond this extent, so a million
  // additive sprites collapsing into a few pixels don't bloom to white (the
  // procedural galaxy provides the from-a-distance glow instead).
  fadeExtent?: number;
  hideBelow?: number; // skip entirely below this focus distance (see MeshObj)
  nearFade?: boolean; // fade sprites near the camera (see the Grp.misc shader note)
  prov?: number; // honest-seam provenance (see MeshObj)
}
export interface OrbitLine {
  frame: Frame;
  center: V3;
  radius: number;
  color: [number, number, number];
  alpha: number;
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
  basis?: [V3, V3, V3]; // camera orbit basis (east, up, north) for tilted surface sites
  // Catalog stars get a color so the renderer can substitute a real star mesh
  // for their sprite up close (sprites jitter at 1e16 m f32 magnitudes).
  starColor?: [number, number, number];
  source?: string; // provenance caption shown in the HUD while focused
}

// A body on a circular mean-longitude orbit in its frame's XZ plane. Every
// V3 in `positions` is written in place each tick (mesh/target arrays share
// references); `frameOffset` moves a whole child frame (Earth carries the
// Moon, the surface site, and any camera standing on it automatically).
export interface OrbitalBody {
  a: number; // orbit radius, meters
  periodDays: number;
  L0: number; // mean longitude at J2000, degrees
  positions: V3[];
  frameOffset?: V3;
  spriteFloatBase?: number; // float offset of its locator sprite in the planet sprite group
  eqCenter?: boolean; // apply Earth's equation of center (true vs mean longitude)
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
  orientEarth: (theta: number, phi?: number) => void; // diurnal spin θ + axial precession φ
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
      const nx = ((i / G - 0.5) * S) / R_EARTH;
      const nz = ((j / G - 0.5) * S) / R_EARTH;
      const len = Math.hypot(nx, 1, nz);
      const rr = R_EARTH + lift + hAt(i, j);
      // Normal: the sphere normal tilted by the terrain slope (small-angle).
      const dhdx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * cell);
      const dhdz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * cell);
      const nl = Math.hypot(nx / len - dhdx, 1 / len, nz / len - dhdz);
      verts.push(
        (rr * nx) / len,
        rr / len - R_EARTH,
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
      if (i >= hole0 && i < hole1 && j >= hole0 && j < hole1) continue; // the hole (next ring / the lawn)
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
      const nx = ((i / G - 0.5) * S) / R_EARTH;
      const nz = ((j / G - 0.5) * S) / R_EARTH;
      const len = Math.hypot(nx, 1, nz);
      const rr = R_EARTH + lift + hAt(i, j) - skirt;
      verts.push((rr * nx) / len, rr / len - R_EARTH, (rr * nz) / len, verts[top + 3], verts[top + 4], verts[top + 5]);
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
  const hole: [number, number][] = [];
  for (let i = hole0; i < hole1; i++) hole.push([i, hole0]);
  for (let j = hole0; j < hole1; j++) hole.push([hole1, j]);
  for (let i = hole1; i > hole0; i--) hole.push([i, hole1]);
  for (let j = hole1; j > hole0; j--) hole.push([hole0, j]);
  emitSkirt(hole);
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
  // the mean-longitude ephemeris before the first frame renders.
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
  ];
  const bodies: OrbitalBody[] = [];
  const planetSprites: number[][] = [];
  const planetTargets: Target[] = [];
  let dimpleEarth: (depth: number) => void = () => {};
  planets.forEach(([name, a, r, color, matId, L0, periodDays]) => {
    orbits.push({ frame: sunFrame, center: [0, 0, 0], radius: a, color: [0.4, 0.62, 1.0], alpha: 0.2 });
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
      bodies.push({ a, periodDays, L0, positions: [], frameOffset: earthPos, spriteFloatBase, eqCenter: true });
      return;
    }
    const pos: V3 = [a, 0, 0]; // ephemeris fills this in before first render
    meshes.push(sphere(sunFrame, pos, r, color, matId, matId === 3 ? 0.4 : 0));
    planetSprites.push([...pos, r * 4, color[0], color[1], color[2], 0.28]);
    bodies.push({ a, periodDays, L0, positions: [pos], spriteFloatBase });
    planetTargets.push({
      name: name.toUpperCase(),
      slug: name,
      frame: sunFrame,
      pos, // shared reference — the target rides the ephemeris
      dist: 28 * r,
      pitch: 0.15,
      sunlit: true,
      source: 'measured orbit & size — stylized surface',
      parent: 'system',
      exit: Math.max(3 * a, 1e12),
      radius: r,
      hidden: true,
    });
  });

  // Moon: real radius, and the full inclined, perturbed orbit (5.1°,
  // regressing node, varying distance — see ephemeris.ts). This is what
  // makes eclipses land on their true dates. During a lunar eclipse,
  // updateBodies dims and reddens this mesh as it crosses Earth's shadow.
  const moonPos: V3 = [3.844e8, 0, 0];
  const moonMesh = sphere(earthFrame, moonPos, 1.737e6, [0.72, 0.7, 0.68], 4);
  meshes.push(moonMesh);
  // The drawn orbit ring stays in the ecliptic; the real moon rides up to
  // 5.1° off it — visibly honest at moon zoom.
  orbits.push({ frame: earthFrame, center: [0, 0, 0], radius: 3.844e8, color: [0.7, 0.72, 0.8], alpha: 0.16 });
  bodies.push({ a: 3.844e8, periodDays: 27.3217, L0: 218.32, positions: [moonPos], moon: true });

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
  const patchGeoms: { name: string; verts: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> }[] = [];
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

  // (The old procedural "local stars" sprinkle is gone: the streamed ATHYG
  // tiles — 850k+ real Tycho-2/Gaia stars — fill the solar neighborhood now.)

  // ---- The 300 brightest REAL stars (HYG catalog): true positions,
  // ---- colors from B-V, brightness from apparent magnitude ----
  const starMeshes: MeshObj[] = [];
  const starTargets: Target[] = [];
  {
    const d = new Float32Array(BRIGHT_STARS.length * 8);
    // Famous destinations: real radii, rendered as star-surface spheres.
    const famous = new Map<string, { slug: string; radius: number }>([
      ['Sirius', { slug: 'sirius', radius: 1.71 * R_SUN }],
      ['Rigil Kentaurus', { slug: 'alpha-centauri', radius: 1.22 * R_SUN }],
      ['Vega', { slug: 'vega', radius: 2.36 * R_SUN }],
      ['Betelgeuse', { slug: 'betelgeuse', radius: 764 * R_SUN }],
      ['Polaris', { slug: 'polaris', radius: 37.5 * R_SUN }],
    ]);
    const usedSlugs = new Set<string>();
    BRIGHT_STARS.forEach(([x0, y0, z0, mag, ci, lum, name], i) => {
      const [x, y, z] = orientSky(x0, y0, z0); // into the true sky
      const o = i * 8;
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
      const f = famous.get(name);
      if (f) {
        starMeshes.push({
          frame: sunFrame,
          pos: [x, y, z],
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
        starTargets.push({
          name: name.toUpperCase(),
          slug,
          frame: sunFrame,
          pos: [x, y, z],
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
    groups.push({ frame: sunFrame, pos: [0, 0, 0], data: d, fadeExtent: 8e18, nearFade: true, prov: 0 });
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
    groups.push({ frame: galaxy, pos: [0, 0, 0], data: d, prov: 1 });
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
      source: 'measured — real orbits & sizes, mean-longitude ephemeris',
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
      name: 'THE MOON',
      slug: 'moon',
      source: 'measured orbit & size — stylized surface',
      frame: earthFrame,
      pos: moonPos,
      dist: 8e6,
      pitch: 0.1,
      sunlit: true,
      parent: 'earth',
      exit: 1.2e8,
      radius: 1.737e6,
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
    // Hidden targets stay after the visible eight so keys 1-8 remain stable.
    ...microTargets,
    ...planetTargets,
    ...starTargets,
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
    orientEarth,
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
    },
  };
}
