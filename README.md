# UNIVERSE

**A true-scale, explorable atlas of the universe in your browser** — one continuous
scroll from the observable universe (~10²⁷ m) down to a one-meter picnic blanket
on the Chicago lakefront. Pure WebGPU, zero runtime dependencies, ~24 KB gzipped.

[![CI](https://github.com/chrisjz/universe/actions/workflows/ci.yml/badge.svg)](https://github.com/chrisjz/universe/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

![Earth from orbit, with the plane of the Milky Way behind it](docs/screenshots/earth.png)

## The zoom

Twenty-seven orders of magnitude, and every step of it is the same scene — no level
loads, no cuts. Scroll in and the engine hands focus down the chain automatically
(universe → galaxy → solar system → Earth → surface); scroll out and it hands it
back. Or press **T** and let the grand tour fly you the whole way.

|                                                                                   |                                                                                 |
| :-------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------: |
| ![Observable universe](docs/screenshots/universe.png) **10²⁷ m** · the cosmic web |      ![Milky Way](docs/screenshots/galaxy.png) **10²² m** · the Milky Way       |
|    ![Solar system](docs/screenshots/system.png) **10¹³ m** · the solar system     |            ![The Sun](docs/screenshots/sun.png) **10¹⁰ m** · the Sun            |
|              ![Earth](docs/screenshots/earth.png) **10⁸ m** · Earth               | ![The picnic](docs/screenshots/surface.png) **10¹ m** · the picnic, exactly 1 m |

Earth is the real Earth — NASA Blue Marble by day, Black Marble city lights on
the night side — and the bottom of the zoom is an homage: a one-meter
red-checkered **picnic blanket on the Chicago lakefront** (41.878°N, 87.630°W),
where the Eames' _Powers of Ten_ opened in 1977. Structure outside the solar
system is procedural placeholder (deterministic seed), but every dimension that
can be real already is: actual planetary radii and semi-major axes, the real
Moon distance, the real Sun–galactic-center distance, a Milky Way with the real
~2.6 kpc disk scale length. Time is real too: the
planets and the Moon sit at their true positions for the simulated date (a
mean-longitude ephemeris — circular, coplanar approximation) and move as the
clock runs, from real time up to ten years per second. The roadmap swaps the
placeholders for real catalogs — Gaia DR3 stars, SDSS galaxies, Earth terrain
tiles — without touching the engine.

## Try it

```
npm install
npm run dev
```

Open the printed URL in a WebGPU browser (Chrome, Edge, or Safari 18+).

| Input       | Action                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| **scroll**  | seamless zoom — all the way down, all the way back up                                                          |
| **click**   | focus what's under the cursor (planet, moon, any named star) — camera stays put, scrolling now converges there |
| **2×click** | fly to what's under the cursor                                                                                 |
| **drag**    | orbit the current focus                                                                                        |
| **1–8**     | fly to a bookmark (universe, web, galaxy, system, sun, earth, moon, surface)                                   |
| **[ ]**     | slow down / speed up time (real time → 10 years per second)                                                    |
| **P**       | pause the simulation clock                                                                                     |
| **T**       | grand tour: an automated flight through every scale                                                            |
| **Esc**     | cancel the current flight                                                                                      |

Or skip the install: the latest build is live at
**<https://chrisjz.github.io/universe/>**.

Every place is a shareable URL: [`?goto=galaxy`](https://chrisjz.github.io/universe/?goto=galaxy)
jumps straight to the Milky Way, [`?goto=jupiter`](https://chrisjz.github.io/universe/?goto=jupiter)
to any planet, and `&dist=6e20` sets the camera distance in meters — deep
links into a 10²⁷-meter scene.

The sky is real: **854,000 stars** stream in progressively from binary tiles
built out of the ATHYG catalog (Tycho-2 + Gaia DR3) — true 3D positions,
colors from measured B–V indices, brightness from apparent magnitude, 16
bytes per star. Five of them are destinations —
[`?goto=sirius`](https://chrisjz.github.io/universe/?goto=sirius),
[`?goto=alpha-centauri`](https://chrisjz.github.io/universe/?goto=alpha-centauri),
[`?goto=vega`](https://chrisjz.github.io/universe/?goto=vega),
[`?goto=betelgeuse`](https://chrisjz.github.io/universe/?goto=betelgeuse), and
[`?goto=polaris`](https://chrisjz.github.io/universe/?goto=polaris) — rendered
at their real radii (Betelgeuse is 764 solar radii and it _feels_ like it).

## How 27 orders of magnitude fit in one float pipeline

Single-precision floats hold ~7 significant digits; even float64 has ~57 km of
quantization at galactic magnitudes. Three techniques, composed, make the scene
work anyway:

1. **Hierarchical reference frames** ([`src/frames.ts`](src/frames.ts)) — every
   position is a double stored relative to a parent frame (universe → galaxy →
   sun → earth → surface). Camera-relative positions are computed by walking
   both chains only to their _lowest common ancestor_, so two objects standing
   on Earth subtract meter-scale numbers (exact) instead of galaxy-scale ones.
2. **Camera-relative rendering** — the camera is always the render-space origin.
   The GPU never sees an absolute coordinate.
3. **Log-compressed render space + logarithmic depth**
   ([`src/shaders.ts`](src/shaders.ts)) — beyond 10⁷ m, distance _d_ becomes
   `CAP·(1 + ln(d/CAP))`, with sizes scaled by the same factor. Angular size and
   depth ordering are preserved _exactly_, and 10²⁷ m of universe folds into
   ~5×10⁸ render units. Depth is logarithmic, written per-fragment for meshes.

Two hard-won details: WGSL's `length()` silently overflows f32 for vectors
beyond ~1.8×10¹⁹ m (fixed by measuring in a rescaled space — `bigLength()`), and
camera flights use a three-phase profile (zoom out → pan at altitude → zoom in)
so double-precision error is only ever spent where it is sub-pixel. Seamless
scrolling works the same way: a focus retarget never moves the camera, it only
glides the point that zooming converges on.

## Project structure

```
src/
  frames.ts    hierarchical double-precision reference frames (the scale engine)
  math.ts      double-precision vectors, f32 matrices, deterministic PRNG
  scene.ts     the placeholder universe: real dimensions, procedural structure
  shaders.ts   WGSL: lit meshes, additive point sprites, orbit lines
  renderer.ts  thin WebGPU renderer (3 pipelines, 4x MSAA, log depth)
  hud.ts       live scale readout (m → km → AU → ly → Gly) and target buttons
  main.ts      camera, flights, seamless-zoom retargeting, frame loop
```

## Roadmap

- [x] Scale engine: 10²⁷ m → 1 m in one seamless scene
- [x] Scroll-zoom auto-retargeting (zoom _toward what's next_, hands-free)
- [x] Real stars: the 300 brightest (HYG catalog), with five named star destinations
- [x] Click-to-focus: planets, moons, and every named star are clickable destinations
- [x] Deep star catalog: 854k real stars (ATHYG: Tycho-2 + Gaia DR3), streamed as binary tiles
- [ ] Full Gaia DR3 (1.8B sources) via hierarchical spatial LOD tiles
- [ ] Real deep-sky structure (SDSS/2MASS galaxies, cosmic-web survey data)
- [x] Time: real orbital motion (mean-longitude ephemeris, adjustable clock, `?speed=`)
- [x] Real Earth: NASA Blue/Black Marble globe + the _Powers of Ten_ picnic site in Chicago
- [ ] Earth rotation: diurnal day/night cycle at the picnic (sunset at 1 hour/s)
- [ ] Street-level Earth: elevation/imagery tile streaming at the bottom of the zoom
- [ ] Cosmic time scrubbing (deep-time structure evolution)
- [ ] Honest rendering seam: visually distinguish measured vs procedural

## Development

Pre-commit hooks (husky + lint-staged) run ESLint and Prettier on staged files;
CI runs lint, format check, typecheck, and build on every PR.

```
npm run lint      # eslint (typed rules)
npm run format    # prettier --write
npm run build     # tsc --noEmit && vite build
```

## Data

Star data comes from two catalogs by [astronexus](https://github.com/astronexus)
(both CC BY-SA 4.0):

- [HYG](https://github.com/astronexus/HYG-Database) (Hipparcos + Yale + Gliese)
  powers the 300 brightest stars and the named destinations —
  `node scripts/generate-stars.mjs <hyg.csv>` regenerates `src/data/brightstars.ts`.
- [ATHYG](https://github.com/astronexus/ATHYG-Database) (Tycho-2 + Gaia DR3)
  powers the 854k-star deep sky — `node scripts/generate-star-tiles.mjs <athyg.csv>`
  regenerates the binary tiles in `public/stars/`.

Earth imagery is NASA's [Blue Marble](https://visibleearth.nasa.gov/collection/1484/blue-marble)
(day) and [Black Marble](https://earthobservatory.nasa.gov/features/NightLights)
(night lights), public domain, in `public/earth/`.

## License

[MIT](LICENSE) © Chris Zaharia
