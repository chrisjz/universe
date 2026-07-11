// Orchestration: camera state in hierarchical frames, three-phase flights
// (zoom out → pan at altitude → zoom in, so double-precision error is only
// ever spent where it's invisible), the grand tour, and per-frame conversion
// of double-precision world state into camera-relative float GPU data.

import {
  V3,
  Basis,
  add,
  sub,
  scale,
  len,
  norm,
  dot,
  clamp,
  lerp3,
  smootherstep,
  mat4Perspective,
  mat4Mul,
  viewRotation,
  orbitDir,
} from './math';
import { Frame, relPos, reexpress } from './frames';
import { Renderer, FrameData } from './renderer';
import { buildUniverse, ringGeometry, RING_GRID, Target } from './scene';
import { streamStars, StarChunkMeta } from './stars';
import { loadGalaxies } from './galaxies';
import { fetchRingHeights, streamImageryRings, streamMoonRings, streamMarsRings } from './terrain';
import { scaleFactor, BIG_BANG_MS, YEAR_MS } from './cosmo';
import { moonEcliptic, keplerScenePos } from './ephemeris';
import { raDecToScene } from './sky';
import { CONSTELLATION_SEGMENTS, CONSTELLATION_LABELS } from './data/constellations';
import { Hud } from './hud';

const FOV = (60 * Math.PI) / 180;
const CAP = 1e7; // true-scale within 10,000 km, log-compressed beyond
const MAX_D = 1.5e27;
const FAR = CAP * (1 + Math.log(MAX_D / CAP));
const MIN_DIST = 1.2e-16, // the film's floor: 10^-16 m, inside a proton
  MAX_DIST = 2.5e27;

interface Flight {
  fromFrame: Frame;
  fromPos: V3;
  logD0: number;
  to: Target;
  logD1: number;
  logPeak: number;
  pitch0: number;
  yaw0: number;
  tilt0: number; // sky-look head-tilt at departure, eased out in flight
  yawDelta: number; // shortest-arc turn toward the target's arrival yaw (0 if none)
  t: number;
  dur: number;
  switched: boolean;
  fromInToFrame: V3 | null;
}

const fatal = (msg: string) => {
  const el = document.getElementById('fatal')!;
  el.style.display = 'flex';
  el.innerHTML = msg;
};

async function start(): Promise<void> {
  const canvas = document.getElementById('gpu') as HTMLCanvasElement;
  const renderer = new Renderer(canvas);
  try {
    await renderer.init();
  } catch (e) {
    fatal(`UNIVERSE needs WebGPU.<br><br>${(e as Error).message}<br><br>Try Chrome, Edge, or Safari 18+.`);
    return;
  }

  const u = buildUniverse();
  u.patchGeoms.forEach((g) => renderer.addGeometry(g.name, g.verts, g.indices));
  const groupIndex = u.groups.map((g) => renderer.addPointGroup(g.data, g.mode));

  // ---- simulation clock & mean-longitude ephemeris ----
  // Planet/Moon positions are real for the simulated date (circular, coplanar
  // approximation). The clock starts at the actual current time.
  const J2000 = Date.UTC(2000, 0, 1, 12);
  // The clock is a signed velocity ladder: ] accelerates toward the future,
  // [ decelerates through real time and on INTO reverse — all the way to
  // −1 Gyr/s (rewind to the Big Bang and watch the web draw together).
  const FWD_SPEEDS = [
    1, 60, 3600, 86400, 604800, 2629800, 31557600, 315576000, 3.15576e10, 3.15576e13, 3.15576e15, 3.15576e16,
  ];
  const FWD_LABELS = [
    'real time',
    '1 min/s',
    '1 hour/s',
    '1 day/s',
    '1 week/s',
    '1 month/s',
    '1 year/s',
    '10 years/s',
    '1,000 yr/s',
    '1 Myr/s',
    '100 Myr/s',
    '1 Gyr/s',
  ];
  const SPEEDS = [...FWD_SPEEDS.map((s) => -s).reverse(), ...FWD_SPEEDS];
  const SPEED_LABELS = [
    ...FWD_LABELS.map((l) => (l === 'real time' ? 'reverse time' : `−${l}`)).reverse(),
    ...FWD_LABELS,
  ];
  const REAL_TIME_INDEX = FWD_SPEEDS.length; // +1 s/s
  // Cosmic time: the clock runs from just after the Big Bang into the far
  // ΛCDM future. Everything bound stays honest at human timescales; at deep
  // time the ephemeris blurs (trig loses the orbital phase) — which is
  // truthful in spirit: nobody knows where Jupiter is in 4 Gyr either.
  const SIM_MIN_MS = J2000 + BIG_BANG_MS + 1e6 * YEAR_MS;
  const SIM_MAX_MS = J2000 + 50e9 * YEAR_MS;
  const PRECESSION_MS = 25772 * YEAR_MS; // the axial precession period
  const GALACTIC_YEAR_MS = 225e6 * YEAR_MS; // the sun's orbit around the galaxy
  let simMs = Date.now();
  let speedIndex = REAL_TIME_INDEX;
  let paused = false;
  let seam = false; // the honest seam: recolor by provenance (X)
  let starYears = 0; // clamped years from J2000 driving stellar proper motion
  let captureRequested = false; // photo: save a supersampled frame (S)
  let snapResolve: ((dataUrl: string) => void) | null = null; // test hook (window.__snap)
  let overlayHidden = false; // H: hide the overlay — HUD, labels, orbit lines
  let webA = 1; // last-applied cosmic scale factor

  const keplerOut: [number, number, number] = [0, 0, 0];
  function updateBodies(): void {
    const days = (simMs - J2000) / 86400000;
    for (const b of u.bodies) {
      // Negative sign: orbits run clockwise in scene coordinates so that the
      // spin (which must share the orbit's sense for a prograde planet) both
      // moves the sun westward through the day AND closes a 24 h solar day.
      // With the sign positive the solar day was 24 h 7.9 m - a subtle bug
      // that made local noon drift ~2 degrees/day around the year.
      // The Moon gets the full inclined, perturbed ephemeris; Earth gets its
      // equation of center (which also upgrades the picnic's solar time
      // from mean to apparent — the sundial kind).
      let x: number, y: number, z: number;
      if (b.moon) {
        const m = moonEcliptic(days);
        const lon = (m.lonDeg * Math.PI) / 180;
        const lat = (m.latDeg * Math.PI) / 180;
        x = m.distM * Math.cos(lat) * Math.cos(lon);
        y = m.distM * Math.sin(lat);
        z = -m.distM * Math.cos(lat) * Math.sin(lon);
      } else if (b.el) {
        // Full Keplerian elements (Standish 1800–2050): eccentric, inclined
        // orbits solved per frame — verified against JPL Horizons to <0.15°
        // (scripts/verify-ephemeris.mjs). Mercury finally swings its 0.206.
        keplerScenePos(b.el, days / 36525, keplerOut);
        x = keplerOut[0];
        y = keplerOut[1];
        z = keplerOut[2];
      } else {
        const theta = -2 * Math.PI * (b.L0 / 360 + days / b.periodDays);
        x = b.a * Math.cos(theta);
        y = 0;
        z = b.a * Math.sin(theta);
      }
      if (b.frameOffset) {
        b.frameOffset[0] = x;
        b.frameOffset[1] = y;
        b.frameOffset[2] = z;
      }
      for (const p of b.positions) {
        p[0] = x;
        p[1] = y;
        p[2] = z;
      }
      if (b.spriteFloatBase !== undefined) {
        const d = u.groups[u.planetSpriteGroup].data;
        d[b.spriteFloatBase] = x;
        d[b.spriteFloatBase + 1] = y;
        d[b.spriteFloatBase + 2] = z;
      }
    }
    updateMoonShadow();
    // Synchronous lunar rotation: UNIFORM spin at the sidereal-month rate,
    // phased by the mean longitude so the near side faces Earth on average.
    // The ecliptic-longitude residuals (equation of the center etc.) then
    // show up as the real ±7.9° optical libration in longitude.
    u.orientMoon(Math.PI + ((218.3164477 + 13.17639648 * days) * Math.PI) / 180);
    // Textured planets: uniform prograde spin about their real poles (the
    // phase is arbitrary — the face is measured, its rotational moment isn't).
    for (const s of u.planetSpins) {
      const psi = ((days / s.periodDays) % 1) * 2 * Math.PI;
      const c = Math.cos(psi),
        sn = Math.sin(psi);
      for (let k = 0; k < 3; k++) {
        s.basis[0][k] = s.e0[k] * c - s.n0[k] * sn;
        s.basis[2][k] = s.n0[k] * c + s.e0[k] * sn;
      }
    }
    for (const h of u.postSpin) h(); // surface sites ride their planet's spin
    // Stars ride their real space velocities. Proper motion is linear on
    // the ±1 Myr scale; beyond that the drift holds (the galactic-year
    // rotation carries deep time from there) — see the motion uniform.
    starYears = Math.max(-1e6, Math.min(1e6, (simMs - J2000) / 3.15576e10));
    u.driftStars(starYears);
    renderer.updatePointGroup(groupIndex[u.planetSpriteGroup], u.groups[u.planetSpriteGroup].data);
    // Diurnal rotation: sidereal rate, with the phase calibrated so the
    // sub-solar longitude is 0° at the J2000 epoch (noon at Greenwich) —
    // Chicago's picnic gets real local time. -78.63° is the longitude of
    // Tilt⁻¹·(direction to the sun at J2000) under the clockwise orbits.
    // The second argument is the axial precession angle (25,772 yr cycle).
    const SIDEREAL_DAY_MS = 86164090.5;
    const sinceJ2000 = simMs - J2000;
    u.orientEarth(
      (-78.63 * Math.PI) / 180 + (sinceJ2000 / SIDEREAL_DAY_MS) * 2 * Math.PI,
      (-2 * Math.PI * sinceJ2000) / PRECESSION_MS,
    );
    // The galactic year: β negative so the sun advances toward l = 90°
    // (Cygnus), the real direction of galactic rotation.
    u.orientGalaxy((-2 * Math.PI * sinceJ2000) / GALACTIC_YEAR_MS);
    // Cosmic expansion: rescale the comoving web when a(t) moves ≥ 0.3%.
    const a = scaleFactor(sinceJ2000);
    if (Math.abs(a - webA) > 0.003 * webA) {
      webA = a;
      renderer.updatePointGroup(groupIndex[u.webGroup], u.scaleWeb(a));
      rescaleGalaxies();
    }
  }
  // Lunar eclipses: as the Moon crosses Earth's shadow cone, dim its mesh
  // through the penumbra and redden it in the umbra (sunlight refracted
  // through Earth's atmosphere — the blood moon). Pure geometry: the cone
  // radii come from the real Sun/Earth sizes and the live positions.
  const earthBody = u.bodies.find((b) => b.frameOffset)!; // only Earth carries the frame
  function updateMoonShadow(): void {
    const e = earthBody.frameOffset!;
    const m = u.moonMesh.pos;
    const dSun = len(e);
    const anti: V3 = [e[0] / dSun, e[1] / dSun, e[2] / dSun]; // antisolar direction
    const along = dot(m, anti);
    let lit = 1;
    if (along > 0) {
      const off = len(sub(m, scale(anti, along)));
      const R_SUN = 6.957e8,
        R_E = 6.371e6,
        R_M = 1.737e6;
      const umbra = R_E - (along * (R_SUN - R_E)) / dSun;
      const penumbra = R_E + (along * (R_SUN + R_E)) / dSun;
      lit = clamp((off - (umbra - R_M)) / (penumbra + R_M - (umbra - R_M)), 0, 1);
    }
    const deep = 1 - lit;
    // A MULTIPLIER now (the mesh carries the real LROC texture): 1 in full
    // sun, dimming through the penumbra, red-shifted deep in the umbra.
    // The Tranquility ring meshes share this array, so during a lunar
    // eclipse the ground you stand on dims and reddens with the globe.
    const f = 0.05 + 0.95 * lit;
    u.moonMesh.color[0] = f + 0.46 * deep;
    u.moonMesh.color[1] = f + 0.14 * deep;
    u.moonMesh.color[2] = f + 0.07 * deep;
  }
  updateBodies(); // targets must sit at their real positions before any ?goto jump

  // ---- NASA Blue/Black Marble Earth textures (procedural fallback until loaded) ----
  void renderer.loadEarthTextures(
    `${import.meta.env.BASE_URL}earth/day.jpg`,
    `${import.meta.env.BASE_URL}earth/night.jpg`,
  );

  // ---- the real Moon: LROC WAC global color + baked LOLA site terrain ----
  void fetch(`${import.meta.env.BASE_URL}moon/color.jpg`)
    .then(async (r) => {
      if (!r.ok) return;
      await renderer.addTexture('moon', await createImageBitmap(await r.blob()));
    })
    .catch(() => {}); // offline: the procedural regolith stands in

  // ---- real planet faces + Saturn's rings (generate-planets.mjs) ----
  for (const key of ['mercury', 'mars', 'jupiter']) {
    void fetch(`${import.meta.env.BASE_URL}planets/${key}.jpg`)
      .then(async (r) => {
        if (!r.ok) return;
        await renderer.addTexture(key, await createImageBitmap(await r.blob()));
      })
      .catch(() => {}); // offline: procedural planets stand in
  }
  void fetch(`${import.meta.env.BASE_URL}planets/rings.png`)
    .then(async (r) => {
      if (!r.ok) return;
      await renderer.addTexture('rings', await createImageBitmap(await r.blob()));
    })
    .catch(() => {}); // offline: no rings (they have no procedural stand-in)
  // Tranquility Base terrain (baked by scripts/generate-moon.mjs): rebuild
  // each moon ring on its real LOLA heights and sink the smooth globe below
  // the deepest carved point (the site itself sits 1.9 km under the
  // reference sphere — Mare Tranquillitatis is a low plain).
  const moonTerrainFields: { S: number; h: Float32Array }[] = [];
  void fetch(`${import.meta.env.BASE_URL}moon/tranquility.json`)
    .then(async (r) => {
      if (!r.ok) return;
      const tq = (await r.json()) as { siteElev: number; rings: { S: number; heights: number[] }[] };
      let deepest = 0;
      tq.rings.forEach((ring, k) => {
        const h = new Float32Array(ring.heights);
        for (const v of h) deepest = Math.min(deepest, v);
        moonTerrainFields.push({ S: ring.S, h });
        const g = ringGeometry(ring.S, h, u.nav.moon.R, k < tq.rings.length - 1);
        renderer.addGeometry(`moonring${k}`, g.verts, g.indices);
      });
      u.nav.moon.dimpleMoon(-tq.siteElev - deepest + 30);
    })
    .catch(() => {});
  // The WAC imagery is ~60 tile fetches — stream it only once the Moon (or
  // its surface site) actually has focus, not on every page load.
  let moonImageryStarted = false;
  function maybeStreamMoonImagery(): void {
    const slug = u.targets[activeTarget].slug;
    if (moonImageryStarted || (slug !== 'moon' && slug !== 'tranquility')) return;
    moonImageryStarted = true;
    void streamMoonRings(u.nav.moon.site[0], u.nav.moon.site[1], u.nav.moon.ringSizes, async (key, bmp) => {
      await renderer.addTexture(key, bmp);
    });
  }

  // ---- Jezero crater: baked MOLA terrain + lazily streamed Viking rings ----
  const marsTerrainFields: { S: number; h: Float32Array }[] = [];
  void fetch(`${import.meta.env.BASE_URL}mars/jezero.json`)
    .then(async (r) => {
      if (!r.ok) return;
      const jz = (await r.json()) as { siteElev: number; rings: { S: number; heights: number[] }[] };
      let deepest = 0;
      jz.rings.forEach((ring, k) => {
        const h = new Float32Array(ring.heights);
        for (const v of h) deepest = Math.min(deepest, v);
        marsTerrainFields.push({ S: ring.S, h });
        const g = ringGeometry(ring.S, h, u.nav.mars.R, k < jz.rings.length - 1);
        renderer.addGeometry(`marsring${k}`, g.verts, g.indices);
      });
      // The render sphere is 3.39e6; the site datum and the deepest carved
      // point both sit below it.
      u.nav.mars.dimpleMars(3.39e6 - u.nav.mars.R - deepest + 30);
    })
    .catch(() => {});
  let marsImageryStarted = false;
  function maybeStreamMarsImagery(): void {
    const slug = u.targets[activeTarget].slug;
    if (marsImageryStarted || (slug !== 'mars' && slug !== 'jezero')) return;
    marsImageryStarted = true;
    void streamMarsRings(u.nav.mars.site[0], u.nav.mars.site[1], u.nav.mars.ringSizes, async (key, bmp) => {
      await renderer.addTexture(key, bmp);
    });
  }

  // ---- street-level Earth: the re-plantable imagery + terrain stack ----
  // Streams Esri imagery (largest ring first) and real DEM heights for the
  // current site — initially the picnic, then wherever the user roams.
  // ?exag=25 exaggerates the relief (a seeing aid: the Midwest is honestly
  // flat at true scale). Anything but 1 is off-datum, so it is URL-only.
  const exag = Math.max(1, parseFloat(new URLSearchParams(location.search).get('exag') ?? '') || 1);
  let imageryGen = 0;
  let imageryKeys = u.nav.imageryKeys();
  function anchorImagery(lat: number, lon: number): void {
    imageryGen++;
    const gen = imageryGen;
    const stale = imageryKeys;
    imageryKeys = u.nav.setImagerySite(lat, lon);
    stale.forEach((k) => renderer.dropTexture(k));
    // Fresh site: flat geometry immediately (don't wear another site's
    // terrain), then real heights as they land.
    u.site.ringSizes.forEach((S, k) => {
      const g = ringGeometry(S);
      renderer.addGeometry(`ring${k}`, g.verts, g.indices);
    });
    void streamImageryRings(
      lat,
      lon,
      u.site.ringSizes,
      async (key, bmp) => {
        if (gen === imageryGen) await renderer.addTexture(key, bmp);
      },
      imageryKeys,
    );
    const isHome = Math.abs(lat - u.nav.home[0]) < 1e-4 && Math.abs(lon - u.nav.home[1]) < 1e-4;
    const waterLevel = isHome ? u.site.waterLevel : 0; // 0 = sea level (inland lakes may bowl)
    u.nav.dimpleEarth(0);
    terrainFields = [];
    void (async () => {
      let deepest = 0; // meters below the site datum, across all rings
      for (let k = 0; k < u.site.ringSizes.length; k++) {
        const S = u.site.ringSizes[k];
        const heights = await fetchRingHeights(lat, lon, S, RING_GRID, waterLevel);
        if (gen !== imageryGen) return; // the user roamed on
        if (!heights) continue; // offline: the smooth sphere stands in
        for (const h of heights) deepest = Math.min(deepest, h);
        // Sink the render sphere below the deepest carved terrain, so a
        // canyon under a rim-top site doesn't fill with smooth Blue Marble.
        u.nav.dimpleEarth(-deepest * exag + 30);
        const eff = exag === 1 ? heights : heights.map((h) => h * exag);
        terrainFields.push({ S, h: eff }); // retained for camera ground collision
        const g = ringGeometry(S, eff);
        renderer.addGeometry(`ring${k}`, g.verts, g.indices);
      }
    })();
  }
  // The displaced terrain the camera must not dip below: same grids the
  // ring geometry uses, sampled bilinearly. Height comes from the smallest
  // ring containing the point (best resolution); the lift comes from the
  // ring whose ANNULUS actually renders there — inside a ring's hole the
  // ground belongs to a smaller ring (or the lawn at datum), so borrowing
  // the big ring's 80 m lift near the site would raise a phantom floor.
  let terrainFields: { S: number; h: Float32Array }[] = [];
  function terrainHeightAt(fields: { S: number; h: Float32Array }[], e: number, n: number): number {
    const G = RING_GRID;
    const m = Math.max(Math.abs(e), Math.abs(n));
    for (let k = fields.length - 1; k >= 0; k--) {
      const { S, h } = fields[k];
      if (m >= S * 0.5) continue; // outside this ring — try a larger one
      const fx = Math.min(G - 1e-4, Math.max(0, (e / S + 0.5) * G));
      const fz = Math.min(G - 1e-4, Math.max(0, (n / S + 0.5) * G));
      const i = Math.floor(fx),
        j = Math.floor(fz);
      const ax = fx - i,
        az = fz - j;
      const at = (ii: number, jj: number) => h[jj * (G + 1) + ii];
      const t0 = at(i, j) * (1 - ax) + at(i + 1, j) * ax;
      const t1 = at(i, j + 1) * (1 - ax) + at(i + 1, j + 1) * ax;
      const height = t0 * (1 - az) + t1 * az;
      const hole = (S * (G / 8 - 1)) / G; // this ring's hole half-width
      return height + (m >= hole ? S * 4e-5 : 0);
    }
    return 0;
  }
  anchorImagery(u.nav.home[0], u.nav.home[1]);

  // ---- the real small bodies: MPC orbits, Kepler solved on the GPU ----
  // 40k of the largest real minor planets (belt, Trojans, Hildas, Kuiper),
  // each instance carrying its ellipse basis + mean anomaly; the vertex
  // shader integrates them every frame. Colors tint by population.
  void fetch(`${import.meta.env.BASE_URL}smallbodies.bin`)
    .then(async (r) => {
      if (!r.ok) return;
      const buf = await r.arrayBuffer();
      const dv = new DataView(buf);
      const POPS: { tint: [number, number, number, number]; fade: number }[] = [
        { tint: [0.78, 0.74, 0.68, 0.55], fade: 6e13 }, // main belt: rocky gray
        { tint: [0.72, 0.7, 0.79, 0.55], fade: 8e13 }, // Trojans: slate
        { tint: [0.8, 0.72, 0.6, 0.55], fade: 8e13 }, // Hildas: warm
        { tint: [0.62, 0.72, 0.86, 0.7], fade: 4e14 }, // Kuiper: icy blue
      ];
      let off = 4 * (1 + POPS.length);
      POPS.forEach((p, i) => {
        const count = dv.getUint32(4 + i * 4, true);
        const inst = new Float32Array(buf, off, count * 10);
        off += count * 40;
        groupIndex.push(renderer.addPointGroup(inst, 'orbital'));
        u.groups.push({
          frame: u.sunFrame,
          pos: [0, 0, 0],
          data: inst,
          fadeExtent: p.fade,
          nearFade: true,
          prov: 0.5, // measured orbits, stylized points
          mode: 'orbital',
          tint: p.tint,
        });
      });
    })
    .catch(() => {}); // offline: no belt

  // ---- stream the star tiles (brightest chunks first) ----
  // The full tileset (854k ATHYG brights + 5.9M Gaia DR3 faint stars, 104 MB)
  // lives in the chrisjz/universe-data repo, served at data.universeatlas.org
  // by its own GitHub Pages site — hierarchical LOD tiles, so a session only
  // pulls what it renders. The small ATHYG set bundled with the app is the
  // offline/dev fallback (it also catches DNS/host failures).
  // ?data= overrides the tile host; ?stars=athyg skips the deep catalog.
  const starParams = new URLSearchParams(location.search);
  const DATA_URL = starParams.get('data') ?? 'https://data.universeatlas.org/stars/';
  let starCount = 0;
  const onStarChunk = (instances: Float32Array<ArrayBuffer>, meta: StarChunkMeta): void => {
    groupIndex.push(renderer.addPointGroup(instances, 'moving'));
    u.groups.push({
      frame: u.sunFrame,
      pos: [0, 0, 0],
      data: instances,
      fadeExtent: meta.fade,
      nearFade: true,
      prov: 0,
      cone: meta.cone ?? undefined,
      mode: 'moving',
    });
    starCount += instances.length / 11;
  };
  // Stars are invisible beyond their fade extents (~200 pc), so the stream
  // starts only once the camera actually enters the stellar neighborhood —
  // a visitor who stays at cosmic scale never downloads the deep catalog.
  let starsStarted = false;
  function maybeStreamStars(): void {
    if (starsStarted || cam.dist > 2e19) return;
    starsStarted = true;
    void (async () => {
      const deep = starParams.get('stars') !== 'athyg' ? await streamStars(DATA_URL, onStarChunk) : 0;
      if (deep === 0) await streamStars(`${import.meta.env.BASE_URL}stars/`, onStarChunk);
    })();
  }

  // ---- the real local universe: 43k 2MASS Redshift Survey galaxies ----
  // Virgo, Coma, Perseus–Pisces, the Great Wall — measured positions,
  // comoving like the web (they ride the same scale factor).
  let galaxyBase: Float32Array | null = null;
  let galaxyGroup = -1;
  void loadGalaxies(`${import.meta.env.BASE_URL}galaxies/2mrs.bin`).then((instances) => {
    if (!instances) return;
    galaxyBase = Float32Array.from(instances);
    galaxyGroup = u.groups.length;
    groupIndex.push(renderer.addPointGroup(instances));
    u.groups.push({ frame: u.sunFrame, pos: [0, 0, 0], data: instances, fadeExtent: 2.6e25, prov: 0 });
    if (webA !== 1) rescaleGalaxies();
  });
  function rescaleGalaxies(): void {
    if (!galaxyBase || galaxyGroup < 0) return;
    const d = u.groups[galaxyGroup].data;
    for (let i = 0; i < d.length; i += 8) {
      d[i] = galaxyBase[i] * webA;
      d[i + 1] = galaxyBase[i + 1] * webA;
      d[i + 2] = galaxyBase[i + 2] * webA;
    }
    renderer.updatePointGroup(groupIndex[galaxyGroup], d);
  }

  // ---- constellation figures (toggle: C) ----
  // The 88 IAU figures drawn on a dome around the sun, through the same
  // true-sky rotation as the stars — so the lines land on their stars.
  const SKY_DOME_R = 2.5e18;
  let constellations = false;
  {
    const n = CONSTELLATION_SEGMENTS.length / 4;
    const verts = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const a = raDecToScene(CONSTELLATION_SEGMENTS[i * 4], CONSTELLATION_SEGMENTS[i * 4 + 1]);
      const b = raDecToScene(CONSTELLATION_SEGMENTS[i * 4 + 2], CONSTELLATION_SEGMENTS[i * 4 + 3]);
      verts.set(a, i * 6);
      verts.set(b, i * 6 + 3);
    }
    renderer.setSkyLines(verts);
  }
  const labelLayer = document.createElement('div');
  labelLayer.id = 'sky-labels';
  document.body.appendChild(labelLayer);
  const skyLabels = CONSTELLATION_LABELS.map(([ra, dec, name]) => {
    const el = document.createElement('span');
    el.textContent = name;
    labelLayer.appendChild(el);
    return { dir: raDecToScene(ra, dec), el };
  });
  function updateSkyLabels(originRel: V3 | null, earthRel: V3): void {
    if (!originRel) {
      labelLayer.style.display = 'none';
      return;
    }
    labelLayer.style.display = 'block';
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    const tanF = Math.tan(FOV / 2);
    const aspect = w / h;
    const { right, up: upv, fwd } = viewRotation(cam.yaw, cam.pitch, activeBasis(), viewUp, cam.tilt);
    for (const l of skyLabels) {
      const p: V3 = [
        originRel[0] + l.dir[0] * SKY_DOME_R,
        originRel[1] + l.dir[1] * SKY_DOME_R,
        originRel[2] + l.dir[2] * SKY_DOME_R,
      ];
      const z = dot(p, fwd);
      if (z <= 0) {
        l.el.style.display = 'none';
        continue;
      }
      // Occlusion: the lines depth-test against the planet; labels must too
      // (a name shining through the ground gives the horizon away).
      const pl = len(p);
      const t = (dot(earthRel, p) / pl) * 1; // along-ray distance to Earth's center
      if (t > 0 && t < pl) {
        const cx = earthRel[0] - (p[0] / pl) * t;
        const cy = earthRel[1] - (p[1] / pl) * t;
        const cz = earthRel[2] - (p[2] / pl) * t;
        if (Math.hypot(cx, cy, cz) < 6.371e6 * 0.995) {
          l.el.style.display = 'none';
          continue;
        }
      }
      const sx = (dot(p, right) / (z * tanF * aspect)) * 0.5 + 0.5;
      const sy = 0.5 - (dot(p, upv) / (z * tanF)) * 0.5;
      if (sx < -0.05 || sx > 1.05 || sy < -0.05 || sy > 1.05) {
        l.el.style.display = 'none';
        continue;
      }
      l.el.style.display = 'block';
      l.el.style.transform = `translate(${(sx * w).toFixed(1)}px, ${(sy * h).toFixed(1)}px) translate(-50%, -50%)`;
    }
  }

  // ---- camera state ----
  const cam = {
    frame: u.targets[0].frame,
    focus: [...u.targets[0].pos] as V3,
    yaw: 0.6,
    pitch: u.targets[0].pitch,
    dist: u.targets[0].dist,
    // Sky-look head-tilt: when the terrain pitch floor stops the orbit, the
    // blocked rotation becomes a first-person gaze lift instead — the camera
    // stays on the ground and the view tilts up toward the zenith.
    tilt: 0,
  };
  let flight: Flight | null = null;
  let retarget: { to: number; from: V3; t: number } | null = null;
  let touring = false;
  let tourIndex = 0;
  let tourDwell = 0;
  let activeTarget = 0;
  let focusName = u.targets[0].name;

  const bySlug = new Map(u.targets.map((t, i) => [t.slug, i]));

  // Camera yaw/pitch live in the active target's orbit basis (tilted surface
  // sites orbit around their local zenith); no basis means world axes.
  const activeBasis = (): Basis | undefined => u.targets[activeTarget].basis;
  const camDir = (): V3 => orbitDir(cam.yaw, cam.pitch, activeBasis());

  // Re-express a world-space focus->camera direction as yaw/pitch in `basis`,
  // preserving the exact camera pose across a basis switch.
  function setYawPitchFromDir(dir: V3, basis?: Basis): void {
    const d: V3 = basis ? [dot(dir, basis[0]), dot(dir, basis[1]), dot(dir, basis[2])] : dir;
    const l = Math.max(len(d), 1e-12);
    cam.pitch = clamp(Math.asin(clamp(d[1] / l, -1, 1)), -1.53, 1.53);
    cam.yaw = Math.atan2(d[0], d[2]);
  }

  // The rendered horizon roll follows the active basis with smoothing, so
  // entering/leaving a tilted site rolls the view instead of snapping it.
  let viewUp: V3 = [0, 1, 0];

  // Arrival yaw for sunlit-side targets, computed live (bodies move now).
  function arrivalYaw(t: Target): number | undefined {
    if (!t.sunlit) return undefined;
    const s = relPos(u.sunFrame, [0, 0, 0], t.frame, t.pos);
    return Math.atan2(s[0], s[2]);
  }

  // ---- seamless zoom: focus retargeting ----
  // A retarget changes what scrolling converges on without moving the camera:
  // the camera pose is preserved exactly while the focus glides to the new
  // anchor, and dist/yaw/pitch are re-derived from the fixed camera position.
  // Exit hand-offs are disarmed until the camera has actually been closer
  // than the exit threshold; otherwise clicking a far-away object would
  // retarget and instantly bounce focus back up the chain.
  let exitArmed = false;

  function retargetTo(i: number): void {
    if (i === activeTarget) return;
    const t = u.targets[i];
    const camPos = add(cam.focus, scale(camDir(), cam.dist));
    const focusInNew = reexpress(cam.frame, cam.focus, t.frame);
    const camInNew = reexpress(cam.frame, camPos, t.frame);
    cam.frame = t.frame;
    cam.focus = focusInNew;
    const rel = sub(camInNew, focusInNew);
    cam.dist = clamp(len(rel), MIN_DIST, MAX_DIST);
    retarget = { to: i, from: focusInNew, t: 0 };
    activeTarget = i;
    setYawPitchFromDir(rel, t.basis); // same world pose, new basis semantics
    focusName = t.name;
    exitArmed = false;
  }

  function updateRetarget(dt: number): void {
    if (!retarget) return;
    const t = u.targets[retarget.to];
    const camPos = add(cam.focus, scale(camDir(), cam.dist));
    retarget.t += dt / 0.7;
    const k = smootherstep(retarget.t);
    cam.focus = lerp3(retarget.from, t.pos, k);
    const rel = sub(camPos, cam.focus);
    cam.dist = clamp(len(rel), MIN_DIST, MAX_DIST);
    setYawPitchFromDir(rel, t.basis);
    if (retarget.t >= 1) retarget = null;
  }

  // Walk the zoom chain declared on the targets: scrolling in past a child's
  // `enter` distance descends to it; scrolling out past `exit` ascends.
  function updateAutoTarget(): void {
    if (flight || touring || retarget) return;
    const t = u.targets[activeTarget];
    if (t.child !== undefined && t.enter !== undefined && cam.dist < t.enter) {
      retargetTo(bySlug.get(t.child)!);
    } else if (t.parent !== undefined && t.exit !== undefined) {
      if (!exitArmed) {
        if (cam.dist < t.exit * 0.7) exitArmed = true;
      } else if (cam.dist > t.exit) {
        retargetTo(bySlug.get(t.parent)!);
      }
    }
  }

  // ---- click-to-focus: pick the target whose direction best matches the
  // ---- ray through the clicked pixel (tolerance-padded angular hit test)
  function pickAt(px: number, py: number): number {
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    const tanF = Math.tan(FOV / 2);
    const { right, up, fwd } = viewRotation(cam.yaw, cam.pitch, activeBasis(), viewUp, cam.tilt);
    const ray = norm(
      add(add(scale(right, ((px / w) * 2 - 1) * tanF * (w / h)), scale(up, (1 - (py / h) * 2) * tanF)), fwd),
    );
    const camPos = add(cam.focus, scale(camDir(), cam.dist));
    const tolAngle = (12 * 2 * tanF) / h; // ~12 px of slack
    let best = -1;
    let bestScore = 1;
    u.targets.forEach((t, i) => {
      if (t.radius === undefined || i === activeTarget) return;
      const rel = relPos(t.frame, t.pos, cam.frame, camPos);
      const d = len(rel);
      if (d < t.radius * 1.5) return; // camera is inside/next to it
      const cosA = (rel[0] * ray[0] + rel[1] * ray[1] + rel[2] * ray[2]) / d;
      if (cosA <= 0) return;
      const angle = Math.acos(Math.min(cosA, 1));
      const lim = Math.max(Math.atan(t.radius / d) * 1.15, tolAngle);
      if (angle > lim) return;
      const score = angle / lim; // prefer the object you aimed at most precisely
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    return best;
  }

  function flyTo(i: number): void {
    const t = u.targets[i];
    const worldDir = camDir(); // capture before the basis may switch
    retarget = null;
    exitArmed = false;
    activeTarget = i;
    setYawPitchFromDir(worldDir, t.basis);
    focusName = t.name;
    const sep = len(relPos(t.frame, t.pos, cam.frame, cam.focus));
    const d0 = cam.dist,
      d1 = t.dist;
    const peak = Math.max(d0, d1, sep * 1.5);
    const decades = Math.abs(Math.log10(peak / Math.min(d0, d1)));
    flight = {
      fromFrame: cam.frame,
      fromPos: [...cam.focus] as V3,
      logD0: Math.log(d0),
      logD1: Math.log(d1),
      logPeak: Math.log(peak),
      to: t,
      pitch0: cam.pitch,
      yaw0: cam.yaw,
      tilt0: cam.tilt,
      yawDelta: (() => {
        const ay = arrivalYaw(t);
        return ay === undefined ? 0 : ((((ay - cam.yaw) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
      })(),
      t: 0,
      dur: clamp(1.5 + decades * 0.28, 2, 9),
      switched: false,
      fromInToFrame: null,
    };
  }

  function jumpTo(i: number): void {
    const t = u.targets[i];
    retarget = null;
    exitArmed = false;
    cam.frame = t.frame;
    cam.focus = [...t.pos] as V3;
    cam.dist = t.dist;
    cam.pitch = t.pitch;
    cam.tilt = 0;
    const ay = arrivalYaw(t);
    if (ay !== undefined) cam.yaw = ay;
    activeTarget = i;
    viewUp = t.basis ? ([...t.basis[1]] as V3) : [0, 1, 0]; // no roll animation on a hard jump
    focusName = t.name;
  }

  // The grand tour now runs the full 43 orders: cosmic web to the quarks.
  const TOUR_SLUGS = [
    'universe',
    'web',
    'galaxy',
    'system',
    'sun',
    'mars',
    'jezero',
    'moon',
    'tranquility',
    'earth',
    'surface',
    'weave',
    'fiber',
    'molecule',
    'atom',
    'nucleus',
    'proton',
  ];
  function toggleTour(): void {
    touring = !touring;
    if (touring) {
      tourIndex = 0;
      tourDwell = 0;
      flyTo(bySlug.get(TOUR_SLUGS[0])!);
    }
  }

  const hud = new Hud(
    u.targets,
    (i) => {
      touring = false;
      flyTo(i);
    },
    toggleTour,
    (action) => {
      if (action === 'slower') speedIndex = Math.max(0, speedIndex - 1);
      if (action === 'faster') speedIndex = Math.min(SPEEDS.length - 1, speedIndex + 1);
      if (action === 'pause') paused = !paused;
    },
    () => {
      seam = !seam;
      hud.setSeam(seam);
    },
    () => {
      constellations = !constellations;
      hud.setConstellations(constellations);
    },
  );

  // ---- free Earth navigation: pan to roam anywhere on the planet ----
  // Right-drag / shift-drag (mouse) or two-finger drag (touch) grabs the
  // ground and slides the focus across the surface; the zoom then converges
  // wherever you are, and the street-level imagery re-plants itself there.
  const R_E = 6.371e6;
  const roamIdx = bySlug.get('roam')!;
  const surfaceIdx = bySlug.get('surface')!;
  const earthFrameRef = u.targets[bySlug.get('earth')!].frame;
  let lastPanAt = -1e9;

  const roamable = (): boolean => {
    const slug = u.targets[activeTarget].slug;
    return (slug === 'earth' || slug === 'surface' || slug === 'roam') && cam.dist < 1.2e8;
  };
  const roamName = (): string => {
    const [la, lo] = u.nav.roamLatLon();
    const f = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(3)}°${v >= 0 ? pos : neg}`;
    return `EARTH · ${f(la, 'N', 'S')} ${f(lo, 'E', 'W')}`;
  };
  // The point on the sphere under the view center; null if the view misses.
  function surfacePointUnderView(): V3 | null {
    const { fwd } = viewRotation(cam.yaw, cam.pitch, activeBasis(), viewUp, cam.tilt);
    const camPos = add(cam.focus, scale(camDir(), cam.dist));
    const c = relPos(cam.frame, camPos, earthFrameRef, [0, 0, 0]);
    const b = dot(c, fwd);
    const disc = b * b - (dot(c, c) - R_E * R_E);
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t <= 0) return null;
    return add(c, scale(fwd, t));
  }
  // Enter roam mode (if not already there), seeded under the current view.
  function beginRoam(): boolean {
    const slug = u.targets[activeTarget].slug;
    if (slug === 'roam') return true;
    if (slug === 'surface') {
      u.nav.setRoam(u.nav.home[0], u.nav.home[1]);
    } else {
      const p = surfacePointUnderView();
      if (!p) return false;
      u.nav.setRoamFromWorld(p);
    }
    flight = null;
    touring = false;
    retargetTo(roamIdx);
    focusName = roamName();
    return true;
  }
  // Grab-the-ground pan: slide the roam point by a screen-space delta.
  function panBy(dx: number, dy: number): void {
    const mpp = (2 * cam.dist * Math.tan(FOV / 2)) / canvas.clientHeight;
    const { right, fwd } = viewRotation(cam.yaw, cam.pitch, activeBasis(), viewUp);
    u.nav.roamMove(add(scale(right, -dx * mpp), scale(fwd, dy * mpp)));
    lastPanAt = performance.now();
    focusName = roamName();
  }
  const roamHomeDistM = (): number => {
    const [la, lo] = u.nav.roamLatLon();
    const dLat = (((la - u.nav.home[0]) * Math.PI) / 180) * R_E;
    const dLon = (((lo - u.nav.home[1]) * Math.PI) / 180) * R_E * Math.cos((la * Math.PI) / 180);
    return Math.hypot(dLat, dLon);
  };

  // ---- input ----
  // A press that barely moves is a click (focus what's under the cursor);
  // anything longer or farther is an orbit drag. Double-click (or double-tap)
  // flies there. Two touch pointers pinch-zoom (and pan, near a planet).
  let dragging = false;
  let panning = false;
  let pressed: { x: number; y: number; at: number } | null = null;
  let dragDist = 0;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { startSep: number; startDist: number; cx: number; cy: number } | null = null;
  let lastTap = { x: 0, y: 0, at: -1e9 };

  function clickFocus(px: number, py: number): void {
    const i = pickAt(px, py);
    if (i < 0) return;
    flight = null;
    touring = false;
    retargetTo(i);
  }

  const pinchSep = (): number => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      // second finger down: stop orbiting, start pinching
      const [a, b] = [...pointers.values()];
      pinch = { startSep: Math.max(pinchSep(), 1), startDist: cam.dist, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      dragging = false;
      panning = false;
      pressed = null;
      flight = null;
      touring = false;
      return;
    }
    // Right button or shift-drag pans across the planet (free roam).
    if ((e.button === 2 || e.shiftKey) && roamable()) {
      panning = beginRoam();
      if (panning) {
        dragging = false;
        pressed = null;
        canvas.classList.add('dragging');
        return;
      }
    }
    dragging = true;
    dragDist = 0;
    pressed = { x: e.offsetX, y: e.offsetY, at: performance.now() };
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointerup', (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    dragging = false;
    if (panning) {
      panning = false;
      // Roamed back to the picnic? Hand the dive chain back.
      if (roamHomeDistM() < 300 && u.targets[activeTarget].slug === 'roam') retargetTo(surfaceIdx);
    }
    canvas.classList.remove('dragging');
    if (pressed && dragDist < 5 && performance.now() - pressed.at < 500) {
      const now = performance.now();
      const isDoubleTap =
        e.pointerType === 'touch' &&
        now - lastTap.at < 350 &&
        Math.hypot(e.offsetX - lastTap.x, e.offsetY - lastTap.y) < 40;
      if (isDoubleTap) {
        const i = pickAt(e.offsetX, e.offsetY);
        if (i >= 0) {
          touring = false;
          flyTo(i);
        }
      } else {
        clickFocus(e.offsetX, e.offsetY);
      }
      lastTap = { x: e.offsetX, y: e.offsetY, at: now };
    }
    pressed = null;
  });
  canvas.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    dragging = false;
    panning = false;
    pressed = null;
    canvas.classList.remove('dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pinch && pointers.size === 2) {
      const sep = Math.max(pinchSep(), 1);
      const minD = u.targets[activeTarget].slug === 'roam' ? 2 : MIN_DIST;
      cam.dist = clamp((pinch.startDist * pinch.startSep) / sep, minD, MAX_DIST);
      // Two-finger drag pans across the planet (the touch face of free roam).
      const [a, b] = [...pointers.values()];
      const cx = (a.x + b.x) / 2,
        cy = (a.y + b.y) / 2;
      const dx = cx - pinch.cx,
        dy = cy - pinch.cy;
      pinch.cx = cx;
      pinch.cy = cy;
      if ((Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) && roamable() && beginRoam()) panBy(dx, dy);
      return;
    }
    if (panning) {
      panBy(e.movementX, e.movementY);
      return;
    }
    if (!dragging) return;
    dragDist += Math.abs(e.movementX) + Math.abs(e.movementY);
    if (dragDist < 5) return; // still within click slop — don't jitter the orbit
    cam.yaw -= e.movementX * 0.004;
    // Dragging down while gazing at the sky first brings the gaze back to
    // the horizon (consume the head-tilt), then resumes the normal orbit.
    let dp = e.movementY * 0.004;
    if (dp > 0 && cam.tilt > 0) {
      const used = Math.min(cam.tilt, dp);
      cam.tilt -= used;
      dp -= used;
    }
    cam.pitch = clamp(cam.pitch + dp, -1.53, 1.53);
  });
  canvas.addEventListener('dblclick', (e) => {
    const i = pickAt(e.offsetX, e.offsetY);
    if (i < 0) return;
    touring = false;
    flyTo(i);
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      flight = null;
      touring = false;
      // Roamed ground has no dive below it (the picnic is the only door
      // down), so zooming floors at human scale there.
      const minD = u.targets[activeTarget].slug === 'roam' ? 2 : MIN_DIST;
      cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0014), minD, MAX_DIST);
    },
    { passive: false },
  );
  // Arrow keys drive smooth navigation from the frame loop (held-state, not
  // key auto-repeat): up/down zoom like scroll, left/right orbit like drag.
  const heldArrows = new Set<string>();
  window.addEventListener('keyup', (e) => heldArrows.delete(e.key));
  window.addEventListener('blur', () => heldArrows.clear());
  window.addEventListener('keydown', (e) => {
    if (hud.isSearchOpen()) return; // the search input owns the keyboard
    if (e.key.startsWith('Arrow')) {
      heldArrows.add(e.key);
      e.preventDefault();
      return;
    }
    // Enter flies to whatever holds focus — the keyboard's double-click
    // (single-click focuses; Enter goes there).
    if (e.key === 'Enter') {
      touring = false;
      flyTo(activeTarget);
      return;
    }
    if (e.key === '/') {
      e.preventDefault();
      hud.openSearch();
      return;
    }
    if (e.key === 't' || e.key === 'T') toggleTour();
    // H toggles the overlay (HUD, labels, orbit lines); S saves a photo.
    // The two are independent: the canvas capture never includes the DOM
    // overlay, so S is clean regardless — H is for what YOU see.
    if (e.key === 'h' || e.key === 'H') {
      overlayHidden = !overlayHidden;
      document.body.classList.toggle('photo', overlayHidden);
    }
    if (e.key === 's' || e.key === 'S') captureRequested = true;
    if (e.key === '[') speedIndex = Math.max(0, speedIndex - 1);
    if (e.key === ']') speedIndex = Math.min(SPEEDS.length - 1, speedIndex + 1);
    if (e.key === 'p' || e.key === 'P') paused = !paused;
    if (e.key === 'x' || e.key === 'X') {
      seam = !seam;
      hud.setSeam(seam);
    }
    if (e.key === 'c' || e.key === 'C') {
      constellations = !constellations;
      hud.setConstellations(constellations);
    }
    if (e.key === 'Escape') {
      flight = null;
      retarget = null;
      touring = false;
    }
  });

  // ?goto=<slug>&dist=<meters>&search=<query> — every place is a URL.
  const params = new URLSearchParams(location.search);
  const searchParam = params.get('search');
  if (searchParam !== null) hud.openSearch(searchParam);
  if (params.get('seam') !== null) {
    seam = true;
    hud.setSeam(true);
  }
  // ?constellations=1 — the 88 figures over the true sky.
  if (params.get('constellations') !== null) {
    constellations = true;
    hud.setConstellations(true);
  }
  // ?tour=1 — start the grand tour after a beat (lets textures/stars land).
  if (params.get('tour') !== null) {
    setTimeout(() => {
      if (!touring) toggleTour();
    }, 1200);
  }
  const goto = params.get('goto');
  if (goto) {
    const i = u.targets.findIndex((t) => t.slug === goto);
    if (i >= 0) jumpTo(i);
  }
  // ?lat=&lon= — free-roam deep link: land anywhere on Earth, street-level
  // imagery included (e.g. ?lat=48.8584&lon=2.2945&dist=3000 for Paris).
  const latParam = parseFloat(params.get('lat') ?? '');
  const lonParam = parseFloat(params.get('lon') ?? '');
  if (Number.isFinite(latParam) && Number.isFinite(lonParam)) {
    u.nav.setRoam(latParam, lonParam);
    jumpTo(roamIdx);
    cam.dist = 2e4;
    anchorImagery(...u.nav.roamLatLon());
    focusName = roamName();
  }
  const distParam = parseFloat(params.get('dist') ?? '');
  if (Number.isFinite(distParam)) cam.dist = clamp(distParam, MIN_DIST, MAX_DIST);
  // ?yaw=&pitch= (degrees) — aim the camera; with them a URL can frame a
  // sunset, Polaris, or a solar eclipse exactly.
  const yawParam = parseFloat(params.get('yaw') ?? '');
  if (Number.isFinite(yawParam)) cam.yaw = (yawParam * Math.PI) / 180;
  const pitchParam = parseFloat(params.get('pitch') ?? '');
  if (Number.isFinite(pitchParam)) cam.pitch = clamp((pitchParam * Math.PI) / 180, -1.53, 1.53);
  // ?at=<ISO date/time> — start the simulation clock at a chosen moment.
  const atParam = Date.parse(params.get('at') ?? '');
  if (Number.isFinite(atParam)) {
    simMs = atParam;
    updateBodies();
  }
  // ?years=<offset from now> — deep-time deep link (e.g. ?years=-13e9 for
  // just after the Big Bang, ?years=12000 for Vega as the pole star).
  const yearsParam = parseFloat(params.get('years') ?? '');
  if (Number.isFinite(yearsParam)) {
    simMs = clamp(Date.now() + yearsParam * YEAR_MS, SIM_MIN_MS, SIM_MAX_MS);
    updateBodies();
  }
  // ?paused=1 — start with the clock stopped. With ?at= this pins the whole
  // scene to one instant, which is what a reproducible screenshot needs.
  if (params.get('paused') !== null) paused = true;
  // ?speed=<sim seconds per real second> — snaps to the nearest preset;
  // negative values run the clock backwards (?speed=-3.15576e16 rewinds
  // at a billion years per second).
  const speedParam = parseFloat(params.get('speed') ?? '');
  if (Number.isFinite(speedParam) && speedParam !== 0) {
    const score = (s: number): number =>
      Math.sign(s) === Math.sign(speedParam) ? Math.abs(Math.log(Math.abs(s / speedParam))) : Infinity;
    speedIndex = SPEEDS.reduce((best, s, i) => (score(s) < score(SPEEDS[best]) ? i : best), REAL_TIME_INDEX);
  }
  // ?click=fx,fy — synthetic click at fractional screen coords, fired once
  // after a few frames. Exists so headless tests can exercise picking.
  let pendingClick: number[] | null = (params.get('click') ?? '').split(',').map(parseFloat);
  if (pendingClick.length !== 2 || pendingClick.some((v) => !Number.isFinite(v))) pendingClick = null;
  let frameCount = 0;

  // ---- resize ----
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const doResize = () =>
    renderer.resize(
      Math.max(1, Math.floor(canvas.clientWidth * dpr)),
      Math.max(1, Math.floor(canvas.clientHeight * dpr)),
    );
  doResize();
  window.addEventListener('resize', doResize);

  // ---- flight update ----
  function updateFlight(dt: number): void {
    if (!flight) {
      if (touring) {
        tourDwell += dt;
        if (tourDwell > 1.6) {
          tourDwell = 0;
          tourIndex++;
          if (tourIndex >= TOUR_SLUGS.length) {
            touring = false;
            return;
          }
          flyTo(bySlug.get(TOUR_SLUGS[tourIndex])!);
        }
      }
      return;
    }
    const f = flight;
    f.t += dt / f.dur;
    const t = clamp(f.t, 0, 1);
    const pT = smootherstep(t);
    cam.pitch = f.pitch0 + (f.to.pitch - f.pitch0) * pT;
    cam.yaw = f.yaw0 + f.yawDelta * pT;
    cam.tilt = f.tilt0 * (1 - pT); // a flight always arrives gazing at its target

    if (t < 0.42) {
      // phase A: zoom out, focus fixed
      const k = smootherstep(t / 0.42);
      cam.dist = Math.exp(f.logD0 + (f.logPeak - f.logD0) * k);
    } else if (t < 0.58) {
      // phase B: pan at altitude (errors invisible up here)
      if (!f.switched) {
        f.switched = true;
        f.fromInToFrame = reexpress(f.fromFrame, f.fromPos, f.to.frame);
        cam.frame = f.to.frame;
      }
      const k = smootherstep((t - 0.42) / 0.16);
      cam.dist = Math.exp(f.logPeak);
      cam.focus = lerp3(f.fromInToFrame!, f.to.pos, k);
    } else {
      // phase C: zoom in on the target
      if (!f.switched) {
        f.switched = true;
        cam.frame = f.to.frame;
      }
      cam.focus = [...f.to.pos] as V3;
      const k = smootherstep((t - 0.58) / 0.42);
      cam.dist = Math.exp(f.logPeak + (f.logD1 - f.logPeak) * k);
    }
    if (f.t >= 1) flight = null;
  }

  // ---- render loop ----
  const globals = new Float32Array(32);
  let last = performance.now();
  const t0 = last;

  // Ground collision only applies at the surface site; resolve its frame by
  // slug (never by array position — hidden targets are appended at the end).
  const surfaceTarget = u.targets.find((t) => t.slug === 'surface')!;
  const surfaceFrame = surfaceTarget.frame;
  const surfaceUp = surfaceTarget.basis![1];

  // ?fps=1: a frame-rate probe in the tab title — the cheap way to check
  // render cost after a data scale-up (headless verification reads it too).
  const fpsProbe = starParams.get('fps') !== null;
  let fpsFrames = 0;
  let fpsWindow = performance.now();

  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    frameCount++;
    if (fpsProbe) {
      fpsFrames++;
      if (now - fpsWindow >= 2000) {
        document.title = `fps ${((fpsFrames * 1000) / (now - fpsWindow)).toFixed(0)} · ${Math.round(starCount / 1000)}k stars`;
        fpsFrames = 0;
        fpsWindow = now;
      }
    }
    if (pendingClick && frameCount > 5) {
      clickFocus(pendingClick[0] * canvas.clientWidth, pendingClick[1] * canvas.clientHeight);
      pendingClick = null;
    }
    if (!paused) {
      simMs = clamp(simMs + dt * SPEEDS[speedIndex] * 1000, SIM_MIN_MS, SIM_MAX_MS);
      updateBodies();
    }
    // Keyboard navigation: held arrows glide instead of stepping. Up/down
    // is the trackpad-friendly zoom (same exponential feel as scroll);
    // left/right orbit the focus like a horizontal drag.
    if (heldArrows.size) {
      if (heldArrows.has('ArrowUp') || heldArrows.has('ArrowDown')) {
        flight = null;
        touring = false;
        const dir = heldArrows.has('ArrowUp') ? -1 : 1;
        const minD = u.targets[activeTarget].slug === 'roam' ? 2 : MIN_DIST;
        cam.dist = clamp(cam.dist * Math.exp(dir * 1.8 * dt), minD, MAX_DIST);
      }
      if (heldArrows.has('ArrowLeft')) cam.yaw += 1.1 * dt;
      if (heldArrows.has('ArrowRight')) cam.yaw -= 1.1 * dt;
    }
    updateFlight(dt);
    updateRetarget(dt);
    updateAutoTarget();
    // Free roam: once panning settles, re-plant the street-level imagery
    // stack under the roamed point (or back home when the picnic regains
    // focus) — debounced, and only when close enough for it to matter.
    if (performance.now() - lastPanAt > 700) {
      const slug = u.targets[activeTarget].slug;
      let want: [number, number] | null = null;
      if (slug === 'roam' && cam.dist < 4e6) want = u.nav.roamLatLon();
      else if (slug === 'surface') want = u.nav.home;
      if (want) {
        const [ilat, ilon] = u.nav.imagerySite();
        const dLat = (want[0] - ilat) * 111e3;
        const dLon = (want[1] - ilon) * 111e3 * Math.cos((want[0] * Math.PI) / 180);
        if (Math.hypot(dLat, dLon) > 500) anchorImagery(want[0], want[1]);
      }
    }
    // Track the focused body: orbiting targets move, and the camera must
    // move with them (flights and glides manage the focus themselves).
    if (!flight && !retarget) {
      const t = u.targets[activeTarget];
      cam.focus = [t.pos[0], t.pos[1], t.pos[2]];
    }
    // Ground collision: on a surface (picnic or roamed), orbiting toward
    // the sky must not swing the camera through the planet. If the camera
    // dips below the local terrain (same grids the rings render), the pitch
    // floor rises until it is clear — and every degree the floor takes away
    // is handed to the head-tilt, so the drag keeps rotating the GAZE up
    // toward the zenith while the camera body rests on the ground.
    {
      const slug = u.targets[activeTarget].slug;
      const site =
        slug === 'surface' || slug === 'roam'
          ? { R: 6.371e6, frame: earthFrameRef, gn: u.nav.gnomonicEUN, fields: terrainFields }
          : slug === 'tranquility'
            ? { R: u.nav.moon.R, frame: u.moonFrame, gn: u.nav.moon.gnomonicEUN, fields: moonTerrainFields }
            : slug === 'jezero'
              ? { R: u.nav.mars.R, frame: u.marsFrame, gn: u.nav.mars.gnomonicEUN, fields: marsTerrainFields }
              : null;
      if (!flight && !retarget && site) {
        const R = site.R;
        const bodyFrame = site.frame;
        const gnomonic = site.gn;
        const fields = site.fields;
        for (let i = 0; i < 40; i++) {
          const camPos = add(cam.focus, scale(camDir(), cam.dist));
          const rel = relPos(cam.frame, camPos, bodyFrame, [0, 0, 0]);
          const r = len(rel);
          if (r > R + 12e3) break; // far above any terrain
          const en = gnomonic(rel);
          const ground = R + 1.5 + (en ? terrainHeightAt(fields, en[0], en[1]) : 0);
          if (i === 0 && r > ground + 60 && cam.tilt > 0) {
            // Comfortably clear of the ground (zooming away): the head-tilt
            // eases back so the familiar orbit gaze returns on its own.
            cam.tilt = Math.max(0, cam.tilt * (1 - Math.min(1, dt * 2)));
          }
          if (r >= ground + 1.2 || cam.pitch >= 1.53) break;
          cam.pitch = Math.min(cam.pitch + 0.02, 1.53);
          cam.tilt = Math.min(cam.tilt + 0.02, 1.5); // blocked orbit -> sky gaze
        }
      } else if (cam.tilt > 0 && !flight) {
        cam.tilt = Math.max(0, cam.tilt * (1 - Math.min(1, dt * 2)));
      }
    }
    maybeStreamMoonImagery();
    maybeStreamMarsImagery();
    maybeStreamStars();

    // Smooth the horizon roll toward the active basis (48° tilt at the
    // Chicago site) so basis hand-offs read as a gentle roll, not a snap.
    const targetUp = activeBasis()?.[1] ?? ([0, 1, 0] as V3);
    viewUp = norm(lerp3(viewUp, targetUp, Math.min(1, dt * 3)));
    const { view, right, up, fwd } = viewRotation(cam.yaw, cam.pitch, activeBasis(), viewUp, cam.tilt);
    const dir = camDir();
    let camLocal = add(cam.focus, scale(dir, cam.dist));
    if (cam.frame === surfaceFrame && !flight) {
      const h = dot(camLocal, surfaceUp); // ground collision along the local zenith
      if (h < 0.4) camLocal = add(camLocal, scale(surfaceUp, 0.4 - h));
    }

    // Near plane and the log-depth reference both track the focus distance,
    // so the same pipeline resolves a proton at 1e-15 m and a galaxy at 1e21.
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const near = clamp(cam.dist * 0.05, 1e-17, 0.05);
    const projMat = mat4Perspective(FOV, aspect, near, FAR * 2);
    const viewProj = mat4Mul(projMat, view);
    const pxFactor = (2 * Math.tan(FOV / 2)) / Math.max(1, canvas.clientHeight * dpr);
    const nearRef = clamp(cam.dist * 0.01, 2e-17, 0.05);

    globals.set(viewProj, 0);
    globals[16] = right[0];
    globals[17] = right[1];
    globals[18] = right[2];
    globals[19] = nearRef;
    globals[20] = up[0];
    globals[21] = up[1];
    globals[22] = up[2];
    globals[23] = seam ? 1 : 0;
    globals[24] = CAP;
    globals[25] = 1 / Math.log2(1 + FAR / nearRef);
    globals[26] = (now - t0) / 1000;
    globals[27] = pxFactor;
    globals[28] = starYears; // proper-motion years (see shaders.ts Globals.motion)
    // Small-body clock: days from J2000, clamped to ±100 years — osculating
    // elements are honest on that scale; beyond it the belt holds its pose.
    globals[29] = Math.max(-36525, Math.min(36525, (simMs - J2000) / 86400000));

    const data: FrameData = { globals, meshes: [], lines: [], groups: [] };

    // A focused catalog star gets a real (double-precision, jitter-free) star
    // mesh; its sprite near-fades out at the same range.
    const act = u.targets[activeTarget];
    const dynamicMeshes: typeof u.meshes =
      act.starColor && act.radius
        ? [
            {
              frame: act.frame,
              pos: act.pos,
              mesh: 'sphere',
              size: [act.radius, act.radius, act.radius],
              bound: act.radius,
              color: act.starColor,
              emissive: 0,
              matId: 2,
              rim: 0,
              gridScale: 0,
              prov: 0.5, // real radius & color, stylized surface
            },
          ]
        : [];

    for (const m of [...u.meshes, ...dynamicMeshes]) {
      if (m.hideBelow !== undefined && cam.dist < m.hideBelow) continue; // passed through on the dive
      // Imagery rings (and Saturn's) wait for their texture; textured globes
      // (matId 10) draw with their procedural fallback until the map lands.
      if (m.tex !== undefined && m.tex !== 'earth' && m.matId !== 10 && !renderer.hasTexture(m.tex)) continue;
      const rel = relPos(m.frame, m.pos, cam.frame, camLocal);
      const d = len(rel);
      if (m.bound / Math.max(d, 1e-18) < 2e-8) continue; // sub-pixel
      let s = 1;
      let p = rel;
      if (d > CAP) {
        const dc = CAP * (1 + Math.log(d / CAP));
        s = dc / d;
        p = scale(rel, s);
      }
      const o = new Float32Array(28);
      // column-major model = translate(p) * rotate * scale(size * s)
      if (m.rot) {
        for (let c = 0; c < 3; c++) {
          const sc = m.size[c] * s;
          o[c * 4] = m.rot[c][0] * sc;
          o[c * 4 + 1] = m.rot[c][1] * sc;
          o[c * 4 + 2] = m.rot[c][2] * sc;
        }
      } else {
        o[0] = m.size[0] * s;
        o[5] = m.size[1] * s;
        o[10] = m.size[2] * s;
      }
      o[15] = 1;
      o[12] = p[0];
      o[13] = p[1];
      o[14] = p[2];
      o[16] = m.color[0];
      o[17] = m.color[1];
      o[18] = m.color[2];
      o[19] = m.emissive;
      const sd = m.matId === 2 ? [0, 1, 0] : norm(relPos(u.sunFrame, [0, 0, 0], m.frame, m.pos));
      o[20] = sd[0];
      o[21] = sd[1];
      o[22] = sd[2];
      o[23] = m.matId;
      o[24] = m.rim;
      o[25] = m.gridScale;
      // Textured flag: matId 10 globes check their own map; Earth checks the
      // Blue/Black Marble pair.
      o[26] = (m.matId === 10 && m.tex ? renderer.hasTexture(m.tex) : renderer.earthReady) ? 1 : 0;
      o[27] = m.prov ?? 0;
      data.meshes.push({ kind: m.mesh, data: o, tex: m.tex });
    }

    // Orbit rings are GPU overlay too: they yield with the rest when the
    // overlay is hidden (H) — a clean frame means no scaffolding at all.
    for (const orbit of overlayHidden ? [] : u.orbits) {
      const rel = relPos(orbit.frame, orbit.center, cam.frame, camLocal);
      const ratio = len(rel) / orbit.radius;
      const fade = smootherstep((ratio - 0.02) / 0.25) * (1 - smootherstep((ratio - 40) / 360));
      if (fade < 0.01) continue;
      const l = new Float32Array(16);
      // Ellipse center = focus (the frame's origin) + the center offset.
      l[0] = rel[0] + (orbit.centerOff?.[0] ?? 0);
      l[1] = rel[1] + (orbit.centerOff?.[1] ?? 0);
      l[2] = rel[2] + (orbit.centerOff?.[2] ?? 0);
      l[4] = orbit.color[0];
      l[5] = orbit.color[1];
      l[6] = orbit.color[2];
      l[7] = orbit.alpha * fade;
      const A = orbit.axisA ?? [orbit.radius, 0, 0];
      const B = orbit.axisB ?? [0, 0, orbit.radius];
      l[8] = A[0];
      l[9] = A[1];
      l[10] = A[2];
      l[12] = B[0];
      l[13] = B[1];
      l[14] = B[2];
      data.lines.push(l);
    }

    // Frustum culling for coned star tiles: the deep sky is vertex-bound
    // (6.8M sprites), and from the ground only ~a fifth of it is on screen.
    // A tile draws when its bounding cone can intersect the view cone; the
    // parallax margin widens as the camera leaves the sun (star directions
    // were measured from there), disabling culling during star flights.
    const halfDiag = Math.atan(
      Math.tan(FOV / 2) * Math.hypot(1, canvas.clientWidth / Math.max(1, canvas.clientHeight)),
    );
    u.groups.forEach((g, i) => {
      if (g.hideBelow !== undefined && cam.dist < g.hideBelow) return;
      const rel = relPos(g.frame, g.pos, cam.frame, camLocal);
      const fade = g.fadeExtent !== undefined ? Math.min(g.fadeExtent / Math.max(len(rel), 1e-18), 1) : 1;
      if (fade < 0.012) return; // beyond the band's reach: invisible, skip the draw
      if (g.cone) {
        const camSunDist = len(rel); // star tiles live in the sun frame
        // Two margins: parallax (the camera left the sun) and proper-motion
        // drift (the stars left their J2000 tiles — over 100k years nearby
        // stars swing across the sky for real, and culling must let them).
        const margin = Math.atan2(camSunDist, 1e17) + Math.min(Math.PI, (Math.abs(starYears) * 3.2e12) / 1e17);
        const limit = halfDiag + g.cone.ang + margin + 0.06;
        if (limit < Math.PI) {
          const cos = fwd[0] * g.cone.dir[0] + fwd[1] * g.cone.dir[1] + fwd[2] * g.cone.dir[2];
          if (cos < Math.cos(limit)) return;
        }
      }
      const gd = new Float32Array(12);
      gd[0] = rel[0];
      gd[1] = rel[1];
      gd[2] = rel[2];
      gd[3] = fade;
      gd[4] = g.nearFade ? 1.2e12 : 0;
      gd[5] = g.prov ?? 0;
      if (g.tint) {
        gd[8] = g.tint[0];
        gd[9] = g.tint[1];
        gd[10] = g.tint[2];
        gd[11] = g.tint[3];
      }
      data.groups.push({ index: groupIndex[i], data: gd });
    });

    // Constellation figures: a dome of line segments around the sun, shown
    // while the camera is inside the stellar neighborhood. The figures are
    // drawn for the PRESENT sky — beyond ±25,000 years the stars have
    // visibly drifted off them (that's the point of proper motion), so the
    // lines bow out honestly rather than pointing at empty sky.
    const skyVisible = constellations && cam.dist < 2e19 && Math.abs(starYears) < 25000;
    if (skyVisible) {
      const rel = relPos(u.sunFrame, [0, 0, 0], cam.frame, camLocal);
      const s = new Float32Array(8);
      s[0] = rel[0];
      s[1] = rel[1];
      s[2] = rel[2];
      s[3] = SKY_DOME_R;
      s[4] = 0.35;
      s[5] = 0.55;
      s[6] = 0.85;
      s[7] = 0.28;
      data.sky = s;
      updateSkyLabels(rel, relPos(earthFrameRef, [0, 0, 0], cam.frame, camLocal));
    } else {
      updateSkyLabels(null, [0, 0, 0]);
    }

    renderer.render(data);
    if (snapResolve) {
      // Test hook: read the frame back in the task that rendered it. The
      // post-present canvas image never materializes on SwiftShader (the
      // CPU rasterizer CI runs on), so visual regression captures must
      // come from here, not from an external screenshot.
      const done = snapResolve;
      snapResolve = null;
      canvas.toBlob((blob) => {
        if (!blob) {
          done('');
          return;
        }
        const fr = new FileReader();
        fr.onload = () => done(fr.result as string);
        fr.readAsDataURL(blob);
      }, 'image/png');
    }
    if (captureRequested) {
      captureRequested = false;
      // The WebGPU canvas keeps this frame's pixels until the next
      // getCurrentTexture, so capture must happen here, same task. For the
      // supersampled shot, render once more at 2x and restore after.
      const w = canvas.width,
        h = canvas.height;
      renderer.resize(w * 2, h * 2);
      renderer.render(data);
      canvas.toBlob((blob) => {
        if (blob) {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `universe-atlas-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        }
        renderer.resize(w, h);
      }, 'image/png');
    }
    hud.update(
      2 * cam.dist * Math.tan(FOV / 2),
      focusName,
      activeTarget,
      touring,
      simMs,
      SPEED_LABELS[speedIndex],
      paused,
      starCount,
      u.targets[activeTarget].source ?? '',
    );
    requestAnimationFrame(frame);
  }

  (window as unknown as { __snap: () => Promise<string> }).__snap = () =>
    new Promise((resolve) => {
      snapResolve = resolve;
    });
  requestAnimationFrame(frame);
}

void start();
