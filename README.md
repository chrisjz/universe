# UNIVERSE

A true-scale, explorable atlas of the universe in the browser — a continuous
zoom from the observable universe (~10²⁷ m) down to a one-meter cube on
Earth's surface. WebGPU, no dependencies, ~10 KB gzipped.

**Prototype 001** proves the scale engine. All structure is placeholder
(procedural, deterministic seed), but every solar-system dimension is real:
actual planetary radii and semi-major axes, the real Moon distance, the real
Sun–galactic-center distance. The roadmap is to swap the placeholders for
real catalogs (Gaia DR3 stars, SDSS galaxies, NASA exoplanets, Earth tiles)
without touching the engine.

## Run

```
npm install
npm run dev
```

Open the printed URL in a WebGPU browser (Chrome, Edge, Safari 18+).

- **drag** orbit · **scroll** zoom · **1–8** fly to a target · **T** grand tour
- Every place is a URL: `?goto=universe`, `?goto=galaxy`, `?goto=earth`, `?goto=surface`, …

## How 27 orders of magnitude fit in one scene

Three techniques, composed:

1. **Hierarchical frames** (`src/frames.ts`) — positions are doubles stored
   relative to a parent frame (universe → galaxy → sun → earth → surface).
   Camera-relative positions are computed by walking only to the lowest
   common ancestor, so meter-scale subtractions stay exact. (A flat float64
   coordinate system has ~57 km of quantization at galactic magnitudes.)
2. **Camera-relative rendering** — the camera is always the render-space
   origin; the GPU never sees an absolute coordinate.
3. **Log-compressed render space + log depth** (`src/shaders.ts`) — beyond
   10⁷ m, distance d becomes CAP·(1+ln(d/CAP)) with sizes scaled to preserve
   angular diameter exactly; depth is logarithmic (written per-fragment for
   meshes). Note `bigLength()`: naive `length()` overflows f32 beyond
   ~1.8e19 m.

Flights use a three-phase profile (zoom out → pan at altitude → zoom in) so
double-precision error is only spent where it is sub-pixel.

## Roadmap

- [ ] Gaia DR3 star catalog, streamed as hierarchical LOD point tiles
- [ ] Real deep-sky structure (SDSS/2MASS galaxies, cosmic-web survey data)
- [ ] Earth terrain via map tiles at the bottom of the zoom
- [ ] Scroll-zoom auto-retargeting (zoom _toward what you look at_)
- [ ] Time: orbital motion, cosmic time scrubbing
- [ ] Honest rendering seam: visually distinguish measured vs procedural
