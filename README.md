# UNIVERSE

**A true-scale, explorable atlas of the universe in your browser** — one continuous
scroll from the observable universe (~10²⁷ m) down to a one-meter cube standing on
Earth's surface. Pure WebGPU, zero runtime dependencies, ~11 KB gzipped.

[![CI](https://github.com/chrisjz/universe/actions/workflows/ci.yml/badge.svg)](https://github.com/chrisjz/universe/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

![Earth from orbit, with the plane of the Milky Way behind it](docs/screenshots/earth.png)

## The zoom

Twenty-seven orders of magnitude, and every step of it is the same scene — no level
loads, no cuts. Scroll in and the engine hands focus down the chain automatically
(universe → galaxy → solar system → Earth → surface); scroll out and it hands it
back. Or press **T** and let the grand tour fly you the whole way.

|                                                                                   |                                                                                |
| :-------------------------------------------------------------------------------: | :----------------------------------------------------------------------------: |
| ![Observable universe](docs/screenshots/universe.png) **10²⁷ m** · the cosmic web |      ![Milky Way](docs/screenshots/galaxy.png) **10²² m** · the Milky Way      |
|    ![Solar system](docs/screenshots/system.png) **10¹³ m** · the solar system     |           ![The Sun](docs/screenshots/sun.png) **10¹⁰ m** · the Sun            |
|              ![Earth](docs/screenshots/earth.png) **10⁸ m** · Earth               | ![Surface](docs/screenshots/surface.png) **10¹ m** · one red cube, exactly 1 m |

Structure outside the solar system is procedural placeholder (deterministic seed),
but every dimension that can be real already is: actual planetary radii and
semi-major axes, the real Moon distance, the real Sun–galactic-center distance,
a Milky Way with the real ~2.6 kpc disk scale length. The roadmap swaps the
placeholders for real catalogs — Gaia DR3 stars, SDSS galaxies, Earth terrain
tiles — without touching the engine.

## Try it

```
npm install
npm run dev
```

Open the printed URL in a WebGPU browser (Chrome, Edge, or Safari 18+).

| Input      | Action                                                                       |
| ---------- | ---------------------------------------------------------------------------- |
| **scroll** | seamless zoom — all the way down, all the way back up                        |
| **drag**   | orbit the current focus                                                      |
| **1–8**    | fly to a bookmark (universe, web, galaxy, system, sun, earth, moon, surface) |
| **T**      | grand tour: an automated flight through every scale                          |
| **Esc**    | cancel the current flight                                                    |

Or skip the install: the latest build is live at
**<https://chrisjz.github.io/universe/>**.

Every place is a shareable URL: [`?goto=galaxy`](https://chrisjz.github.io/universe/?goto=galaxy)
jumps straight to the Milky Way, and `&dist=6e20` sets the camera distance in
meters — deep links into a 10²⁷-meter scene.

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
- [ ] Gaia DR3 star catalog, streamed as hierarchical LOD point tiles
- [ ] Real deep-sky structure (SDSS/2MASS galaxies, cosmic-web survey data)
- [ ] Earth terrain via map tiles at the bottom of the zoom
- [ ] Click-to-focus on arbitrary objects (planets, stars, galaxies)
- [ ] Time: orbital motion, cosmic time scrubbing
- [ ] Honest rendering seam: visually distinguish measured vs procedural

## Development

Pre-commit hooks (husky + lint-staged) run ESLint and Prettier on staged files;
CI runs lint, format check, typecheck, and build on every PR.

```
npm run lint      # eslint (typed rules)
npm run format    # prettier --write
npm run build     # tsc --noEmit && vite build
```

## License

[MIT](LICENSE) © Chris Zaharia
