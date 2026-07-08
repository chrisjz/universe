# Universe Atlas

**The universe in your browser, to true scale** — one continuous scroll across
**43 orders of magnitude**, from quark to cosmos: the observable universe
(~10²⁷ m) down through a picnic blanket on the Chicago lakefront and into a
proton (10⁻¹⁶ m). Pure WebGPU, zero runtime dependencies, ~25 KB gzipped.

[![CI](https://github.com/chrisjz/universe/actions/workflows/ci.yml/badge.svg)](https://github.com/chrisjz/universe/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

https://github.com/user-attachments/assets/db0eea40-6617-40e0-815d-882b9786ad90

![The grand tour: one continuous zoom from the cosmic web through the Chicago picnic into a proton](docs/tour.gif)

_The grand tour, 43 orders of magnitude in one continuous flight — press **T** in
the [live atlas](https://chrisjz.github.io/universe/?tour=1) to fly it yourself._

## The zoom

Forty-three orders of magnitude, and every step of it is the same scene — no level
loads, no cuts. Scroll in and the engine hands focus down the chain automatically
(universe → galaxy → solar system → Earth → the picnic → the weave → a cotton
fiber → a cellulose molecule → a carbon atom → its nucleus → a proton); scroll
out and it hands it back. Or press **T** and let the grand tour fly you the way.
The inward half is _Powers of Ten_'s second act: sizes are true, arrangements
are illustrative — below the atom, nature stops posing for portraits.

|                                                                                   |                                                                                 |
| :-------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------: |
| ![Observable universe](docs/screenshots/universe.png) **10²⁷ m** · the cosmic web |      ![Milky Way](docs/screenshots/galaxy.png) **10²² m** · the Milky Way       |
|    ![Solar system](docs/screenshots/system.png) **10¹³ m** · the solar system     |            ![The Sun](docs/screenshots/sun.png) **10¹⁰ m** · the Sun            |
|              ![Earth](docs/screenshots/earth.png) **10⁸ m** · Earth               | ![The picnic](docs/screenshots/surface.png) **10¹ m** · the picnic, exactly 1 m |
|      ![A carbon atom](docs/screenshots/atom.jpg) **10⁻¹⁰ m** · a carbon atom      |  ![Inside the proton](docs/screenshots/proton.jpg) **10⁻¹⁴ m** · three quarks   |

Earth is the real Earth — NASA Blue Marble by day, Black Marble city lights on
the night side — and the bottom of the zoom is an homage: a one-meter
red-checkered **picnic blanket on the Chicago lakefront** (41.869°N, 87.618°W),
where the Eames' _Powers of Ten_ opened in 1977. Structure outside the solar
system is procedural placeholder (deterministic seed), but every dimension that
can be real already is: actual planetary radii and semi-major axes, the real
Moon distance, the real Sun–galactic-center distance, a Milky Way with the real
~2.6 kpc disk scale length. Time is real too: the
planets and the Moon sit at their true positions for the simulated date (a
mean-longitude ephemeris — circular, coplanar approximation) and move as the
clock runs, from real time up to ten years per second — and the Earth turns
at the sidereal rate, phase-locked so the sub-solar longitude matches UTC:
the picnic sees sunrise when Chicago does, seasons included — a 71.6° summer
solstice sun, 24.7° in December, fifteen-hour June days — and at one hour per
second you can watch the sun set from the blanket. The roadmap swaps the
placeholders for real catalogs — Gaia DR3 stars, SDSS galaxies — without
touching the engine.

## Try it

```
npm install
npm run dev
```

Open the printed URL in a WebGPU browser (Chrome, Edge, or Safari 18+).

| Input       | Action                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| **scroll**  | seamless zoom — all the way down, all the way back up                                                                 |
| **click**   | focus what's under the cursor (planet, moon, any named star) — camera stays put, scrolling now converges there        |
| **2×click** | fly to what's under the cursor                                                                                        |
| **drag**    | orbit the current focus                                                                                               |
| **1–8**     | fly to a bookmark (universe, web, galaxy, system, sun, earth, moon, surface)                                          |
| **/**       | search everything — all 195 named stars, planets, and every stage of the dive                                         |
| **X**       | the honest seam — recolor by provenance: natural = measured, amber = real size but stylized look, cyan = illustrative |
| **[ ]**     | slow down / speed up time (real time → 10 years per second)                                                           |
| **P**       | pause the simulation clock                                                                                            |
| **T**       | grand tour: an automated flight through all 43 orders, cosmic web to quarks                                           |
| **Esc**     | cancel the current flight                                                                                             |

On touch screens: drag orbits, **pinch zooms**, tap focuses, **double-tap
flies**, and the search / time / tour controls are on-screen buttons.

Or skip the install: the latest build is live at
**<https://chrisjz.github.io/universe/>**.

Every place is a shareable URL: [`?goto=galaxy`](https://chrisjz.github.io/universe/?goto=galaxy)
jumps straight to the Milky Way, [`?goto=jupiter`](https://chrisjz.github.io/universe/?goto=jupiter)
to any planet, `&dist=6e20` sets the camera distance in meters, and
[`?tour=1`](https://chrisjz.github.io/universe/?tour=1) starts the grand tour on
load — deep links into a 10²⁷-meter scene.

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

And the atlas is honest about itself: every focus shows its provenance in the
HUD, and pressing **X** opens the seam — measured data keeps its natural
colors, things with real dimensions but stylized looks turn amber, and the
purely illustrative turns blueprint-cyan. Stand at the picnic and toggle it:
the ground you stand on is imagined; the sky above you is real.

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
  terrain.ts   street-level Earth: Esri imagery + AWS terrain tiles, stitched at runtime
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
- [x] The inward journey: 1 m → 10⁻¹⁶ m, through the blanket to the quarks
- [x] Earth rotation: real diurnal spin — the picnic keeps true Chicago local time
- [x] Axial tilt (23.44°) and seasons: real solstice sun, real day lengths
- [ ] True ecliptic–galactic sky orientation (the celestial pole at Polaris)
- [x] Street-level Earth: Esri World Imagery rings, down to ~2 m/px over the picnic
- [x] Terrain elevation: real DEM heights on the imagery rings (AWS Terrain Tiles)
- [ ] Cosmic time scrubbing (deep-time structure evolution)
- [x] The honest seam: press **X** to see what is measured and what is imagined

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
(day, July) and [Black Marble](https://earthobservatory.nasa.gov/features/NightLights)
(night lights), public domain, in `public/earth/`. Street-level imagery around
the picnic site is fetched at runtime from **Esri World Imagery** — Source:
Esri, Maxar, Earthstar Geographics, and the GIS User Community — used with
attribution per Esri's terms. Terrain elevation comes from the
[Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) open dataset on
AWS (Mapzen terrarium encoding; SRTM, GMTED2010, ETOPO1 et al.), decoded at
runtime and floored at Lake Michigan's 176 m surface so the lake stays flat.

## License

[MIT](LICENSE) © Chris Zaharia
