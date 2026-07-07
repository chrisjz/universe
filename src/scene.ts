// Placeholder universe. Structure is procedural (deterministic seed) but all
// solar-system dimensions are real: actual semi-major axes, actual radii,
// actual Sun-galactic-center distance. This is the content that later gets
// replaced by Gaia / SDSS / NASA catalogs — the frame tree stays the same.

import { V3, mulberry32, gaussian } from './math';
import { Frame } from './frames';
import { MeshKind } from './renderer';
import { BRIGHT_STARS } from './data/brightstars';

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
}

export interface PointGroup {
  frame: Frame;
  pos: V3;
  data: Float32Array<ArrayBuffer>;
  // Star fields fade out as the camera pulls beyond this extent, so a million
  // additive sprites collapsing into a few pixels don't bloom to white (the
  // procedural galaxy provides the from-a-distance glow instead).
  fadeExtent?: number;
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
  radius?: number; // physical bound radius in meters; presence makes it clickable
  sunlit?: boolean; // flights/jumps arrive facing the sunlit side (yaw computed live)
  basis?: [V3, V3, V3]; // camera orbit basis (east, up, north) for tilted surface sites
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
}

const AU = 1.496e11;
const KPC = 3.086e19;
const R_SUN = 6.957e8;

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
  const sunFrame = new Frame('sun', galaxy, [8.3 * KPC, 0, 9e17]); // real galactocentric distance

  // Placeholder epoch position; updateBodies() overwrites it (in place) from
  // the mean-longitude ephemeris before the first frame renders.
  const earthPos: V3 = [AU, 0, 0];
  const earthFrame = new Frame('earth', sunFrame, earthPos);
  const R_EARTH = 6.371e6;

  // The landing site: the Chicago lakefront where the Eames' "Powers of Ten"
  // (1977) opens on a picnic blanket. Earth is static this era (no diurnal
  // rotation yet), so lat/long anchors the site to the Blue Marble texture:
  // dir(lat, lon) is the exact inverse of the shader's equirectangular UV.
  const DEG = Math.PI / 180;
  const SITE_LAT = 41.8781 * DEG;
  const SITE_LON = -87.6298 * DEG;
  const up: V3 = [
    Math.cos(SITE_LAT) * Math.cos(SITE_LON),
    Math.sin(SITE_LAT),
    -Math.cos(SITE_LAT) * Math.sin(SITE_LON),
  ];
  const east: V3 = ((): V3 => {
    const e: V3 = [up[2], 0, -up[0]];
    const l = Math.hypot(e[0], e[2]);
    return [e[0] / l, 0, e[2] / l];
  })();
  const north: V3 = [
    up[1] * east[2] - up[2] * east[1],
    up[2] * east[0] - up[0] * east[2],
    up[0] * east[1] - up[1] * east[0],
  ];
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

  // ---- Sun & planets (real radii and orbits) ----
  const sphere = (
    frame: Frame,
    pos: V3,
    r: number,
    color: [number, number, number],
    matId: number,
    rim = 0,
    emissive = 0,
  ): MeshObj => ({ frame, pos, mesh: 'sphere', size: [r, r, r], bound: r, color, emissive, matId, rim, gridScale: 0 });

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
  planets.forEach(([name, a, r, color, matId, L0, periodDays]) => {
    orbits.push({ frame: sunFrame, center: [0, 0, 0], radius: a, color: [0.4, 0.62, 1.0], alpha: 0.2 });
    const spriteFloatBase = planetSprites.length * 8;
    if (name === 'earth') {
      meshes.push(sphere(earthFrame, [0, 0, 0], r, color, matId, 1.0));
      planetSprites.push([...earthPos, r * 4, 0.5, 0.7, 1.0, 0.3]);
      bodies.push({ a, periodDays, L0, positions: [], frameOffset: earthPos, spriteFloatBase });
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
      parent: 'system',
      exit: Math.max(3 * a, 1e12),
      radius: r,
      hidden: true,
    });
  });

  // Moon: real semi-major axis, radius, and mean longitude.
  const moonPos: V3 = [3.844e8, 0, 0];
  meshes.push(sphere(earthFrame, moonPos, 1.737e6, [0.72, 0.7, 0.68], 4));
  orbits.push({ frame: earthFrame, center: [0, 0, 0], radius: 3.844e8, color: [0.7, 0.72, 0.8], alpha: 0.16 });
  bodies.push({ a: 3.844e8, periodDays: 27.3217, L0: 218.32, positions: [moonPos] });

  // Sun glare + planet locator sprites (so the system reads at 1e13 m).
  planetSprites.push([0, 0, 0, 2.2e9, 1.0, 0.85, 0.6, 2.2]);
  const planetSpriteGroup = groups.length;
  groups.push({ frame: sunFrame, pos: [0, 0, 0], data: new Float32Array(planetSprites.flat()) });

  // ---- The picnic (Powers of Ten, 1977): a one-meter blanket in the park
  // ---- by the lake, Lake Michigan glinting to the east ----
  meshes.push({
    frame: surface,
    pos: sitePos(0, -0.02, 0),
    mesh: 'disk',
    size: [60000, 1, 60000],
    bound: 60000,
    color: [0.2, 0.31, 0.13], // park grass; the shader paints the lake east of ~40 m
    emissive: 0,
    matId: 5,
    rim: 0,
    gridScale: 60000,
    rot: siteBasis,
  });
  const prop = (e: number, u: number, n: number, size: V3, color: [number, number, number], matId = 6): MeshObj => ({
    frame: surface,
    pos: sitePos(e, u, n),
    mesh: 'box',
    size,
    bound: Math.max(...size) * 1.8,
    color,
    emissive: 0,
    matId,
    rim: 0,
    gridScale: 0,
    rot: siteBasis,
  });
  meshes.push(prop(0, 0.012, 0, [0.5, 0.012, 0.5], [0.9, 0.9, 0.9], 7)); // THE one-meter blanket
  meshes.push(prop(0.22, 0.045, 0.28, [0.1, 0.015, 0.15], [0.35, 0.12, 0.08])); // the book
  meshes.push(prop(-0.28, 0.11, -0.12, [0.17, 0.11, 0.12], [0.5, 0.34, 0.16])); // the basket

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
    BRIGHT_STARS.forEach(([x, y, z, mag, ci, lum, name], i) => {
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
        });
      }
    });
    groups.push({ frame: sunFrame, pos: [0, 0, 0], data: d, fadeExtent: 8e18 });
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
    const put = (x: number, y: number, z: number, size: number, c: [number, number, number], inten: number) => {
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
    groups.push({ frame: galaxy, pos: [0, 0, 0], data: d });
  }

  // ---- Cosmic web: nodes + filaments, each point one "galaxy" ----
  let webNodePos: V3 = [0, 0, 0];
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
    const putGal = (x: number, y: number, z: number) => {
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
    groups.push({ frame: root, pos: [0, 0, 0], data: new Float32Array(pts) });
  }

  // The main zoom chain is universe → galaxy → system → earth → surface;
  // sun / moon / web are leaves you visit explicitly and scroll back out of.
  const targets: Target[] = [
    {
      name: 'OBSERVABLE UNIVERSE',
      slug: 'universe',
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
      frame: root,
      pos: webNodePos,
      dist: 1.2e26,
      pitch: 0.2,
      parent: 'universe',
      exit: 3.5e26,
    },
    {
      name: 'MILKY WAY',
      slug: 'galaxy',
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
      frame: surface,
      pos: sitePos(0, 0.3, 0),
      dist: 6,
      pitch: 0.25,
      parent: 'earth',
      exit: 5.5e7,
      basis: siteBasis,
    },
    // Hidden targets stay after the visible eight so keys 1-8 remain stable.
    ...planetTargets,
    ...starTargets,
  ];

  return { root, sunFrame, meshes, groups, orbits, targets, bodies, planetSpriteGroup };
}
