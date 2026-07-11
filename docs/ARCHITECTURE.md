# Architecture

How a browser tab holds 43 orders of magnitude — the observable universe
(~10²⁷ m) down to a proton (10⁻¹⁶ m) — in one seamless, real-time scene.

This document is the deep dive. For what the atlas _is_, start at the
[README](../README.md).

## The scale problem

Single-precision floats carry ~7 significant digits; a GPU fed raw galactic
coordinates jitters by kilometers. Even float64 quantizes at ~57 km near the
edge of the observable universe. Three techniques, composed, make the scene
work anyway:

1. **Hierarchical reference frames** ([`src/frames.ts`](../src/frames.ts)) —
   every position is a double stored relative to a parent frame (universe →
   galaxy → sun → earth → moon → surface sites). Camera-relative positions
   are computed by walking both chains only to their _lowest common
   ancestor_: two objects standing on Earth subtract meter-scale numbers
   (exact) instead of galaxy-scale ones.
2. **Camera-relative rendering** — the camera is always the render-space
   origin. The GPU never sees an absolute coordinate.
3. **Log-compressed render space + logarithmic depth**
   ([`src/shaders.ts`](../src/shaders.ts)) — beyond 10⁷ m, distance _d_
   becomes `CAP·(1 + ln(d/CAP))`, with sizes scaled by the same factor.
   Angular size and depth ordering are preserved _exactly_, and 10²⁷ m of
   universe folds into ~5×10⁸ render units. Depth is logarithmic, written
   per-fragment for meshes so giant triangles (the ground plane) can't break
   ordering via interpolation.

Two hard-won details: WGSL's `length()` silently overflows f32 for vectors
beyond ~1.8×10¹⁹ m — `bigLength()` measures in a rescaled space instead. And
double-precision error is spent where it's sub-pixel: camera flights use a
three-phase profile (zoom out → pan at altitude → zoom in), so the
frame-to-frame subtraction that could jitter only ever happens far from the
ground.

## The camera

An orbit camera around a **focus**: `yaw`/`pitch`/`dist` around a point, with
an optional per-target orbit **basis** (east/up/north) so surface sites orbit
their local zenith rather than world axes. The rendered horizon roll eases
toward the active basis, so entering a tilted site reads as a gentle roll.

- **Zoom chain** — every target may declare a `child` with an `enter`
  distance and a `parent` with an `exit`. Scrolling in past `enter` hands
  focus down the chain (universe → galaxy → system → earth → picnic → weave →
  … → proton); scrolling out hands it back, with hysteresis so the handoff
  never oscillates.
- **Retargeting** — changing focus never moves the camera. The focus point
  glides to the new anchor while `dist`/`yaw`/`pitch` are re-derived each
  frame from the _fixed_ camera position, so zooming simply starts converging
  somewhere new.
- **Ground collision** ([`src/main.ts`](../src/main.ts)) — at a surface site
  the camera consults the same terrain heightfields the imagery rings render
  (bilinear sample of the ring grids, in gnomonic site-local coordinates) and
  a soft pitch floor rises until the camera clears the ground.
- **The sky look** — an orbit camera aimed at a ground-level focus can never
  look up without going underground, so at the pitch floor the drag changes
  regime: blocked orbit becomes a first-person head-tilt (`cam.tilt`) that
  rotates the gaze up off the focus, all the way to the zenith. Dragging back
  down consumes the tilt before resuming the orbit; the tilt eases out when
  zooming away and during flights.

## Turning worlds

Rotation is never a transform stack — it's a set of **oriented registries**
mutated in place each frame, so every reference (mesh bases, site frames,
anchored props, the camera's orbit basis) follows automatically.

- **Earth** — `orientEarth(θ, φ)`: diurnal spin θ at the sidereal rate,
  phase-locked so the sub-solar longitude matches UTC (the picnic sees
  sunrise when Chicago does), around an axis tilted 23.44° — real seasons,
  real day lengths. φ is axial precession (the 25,772-year cone): scrub
  +12,000 years and Vega is the pole star. Everything planted on the planet
  registers either site-local (east, up, north) coordinates or an
  earth-fixed vector, and one call re-orients them all.
- **Moon** — `orientMoon(ψ)`: **uniform** spin at the sidereal-month rate,
  phased by the mean longitude — not "always face Earth". The difference
  between uniform rotation and the varying orbital rate is the real ±7.9°
  optical libration in longitude, visible by scrubbing time. Tranquility
  Base hangs off a moon frame whose offset _is_ the live lunar position.
- **The sky** ([`src/sky.ts`](../src/sky.ts)) — star catalogs are stored in a
  neutral convention and rotated by a fixed equatorial→scene matrix built
  from the obliquity, so Polaris really stands over Earth's axis and the
  galactic plane crosses the ecliptic where it should (verified against
  textbook astronomy to under a degree).
- **The galaxy** — `orientGalaxy(β)`: the sun's 225-million-year lap around
  the galactic center, engaged by deep time.

## Time

One clock (`simMs`), one signed speed ladder from −1 Gyr/s through real time
to +1 Gyr/s (`[` and `]` are a throttle, `P` pauses).

- **Ephemeris** ([`src/ephemeris.ts`](../src/ephemeris.ts)) — planets fly a
  mean-longitude circular ephemeris; Earth adds its equation of center
  (upgrading the picnic's solar time from mean to apparent — the sundial
  kind); the Moon gets a truncated Meeus series (10 longitude / 6 latitude /
  4 distance terms): the inclined, perturbed orbit with its regressing node
  and varying distance. That is what makes every 2026 eclipse land within
  ~10 minutes of its true time, annular vs total decided by the Moon's
  actual distance that day.
- **Eclipse shading** — pure geometry from the real Sun/Earth/Moon sizes and
  live positions: the Moon's mesh color is a multiplier that dims through
  the penumbra and reddens in the umbra; the Tranquility ground rings share
  the tint, so the ground you stand on dims with the globe.
- **Deep time** ([`src/cosmo.ts`](../src/cosmo.ts)) — past ±10,000 years the
  HUD switches to cosmic phrasing, precession and the galactic year engage,
  and the cosmic web (drawn in comoving coordinates) expands with the real
  ΛCDM scale factor `a(t) ∝ sinh^(2/3)`: rewind toward the Big Bang and the
  filaments draw together.

## Street level

Six concentric annular **imagery rings** (2048 km down to 2 km) curve to the
exact sphere in gnomonic site-local coordinates, each textured with Esri
World Imagery stitched at a zoom matching its resolution — ~2 m/px at the
center ([`src/terrain.ts`](../src/terrain.ts)). The innermost hole is plugged
by a lawn disk that samples _the innermost ring's own texture_, so the ground
underfoot is the surrounding photograph with procedural close-up detail on
top.

- **Terrain** — every ring vertex is converted to its exact lat/lon and
  sampled from the AWS Terrain Tiles DEM (terrarium encoding). The site is
  the datum; heights are relative and floored at the local water level so
  lake bathymetry can't carve the water into a bowl. The smooth globe
  _dimples_ below the deepest carved point, so a canyon under a rim-top site
  doesn't fill with Blue Marble.
- **LOD seams** — adjacent rings sample the DEM at different resolutions, so
  holes are cut one cell smaller (sheets overlap) and one-cell skirts hang
  from every perimeter: grazing sight lines can't slip between LODs.
- **Free roam** — the whole imagery stack is re-plantable: pan the ground
  and the rings, textures, and terrain re-anchor under you (generation-
  stamped texture keys make stale streams drop cleanly). The picnic props
  stay in Chicago.
- **Night** — the day imagery is joined by the Black Marble (2016 3-km
  release): from afar you see the city lights themselves; standing on the
  ground you see the imagery lit _by_ them, with the glow modulated by the
  day imagery's luminance so light follows real streets instead of
  night-texture blobs.
- **The Moon** — same ring machinery, different sources: LRO WAC imagery
  from NASA Moon Trek's equirectangular WMTS at runtime, LOLA elevation
  baked at build time (the site is fixed), and no lawn — the innermost ring
  closes its hole. Ground collision and the sky-look generalize per site.

## The deep sky

**6.8 million stars**, every one at its measured 3D position, in a 16-byte
record: f32 position ×3, u8 color ×3 (blackbody from the measured color
index), u8 encoded absolute magnitude. Apparent magnitude and physical
sprite size are reconstructed at load time from absmag + distance.

The catalog is **hierarchical LOD tiles** served from
[chrisjz/universe-data](https://github.com/chrisjz/universe-data)
(`data.universeatlas.org`):

- LOD 0: the 854k ATHYG brights (mag ≤ 11), bundled with the app as the
  offline fallback, streamed brightest-first.
- LOD 1+: 5.9M Gaia DR3 stars (11 ≤ G < 13, 5σ parallaxes) in four
  half-magnitude bands × 64 count-balanced spatial tiles (recursive median
  splits — dense Milky Way regions get small, tight tiles).

Drawing 6.8M additive sprites brute-force is vertex-bound (~4 fps). Three
mechanisms restore 60:

1. **Frustum culling** — every tile ships its exact bounding cone in the
   manifest; the frame loop skips whole tile draws outside the view cone,
   with a parallax margin that widens (and disables culling) as the camera
   leaves the Sun, so star-flight destinations keep their full sky.
2. **Depth-scaled far fades** — each fainter band fades out sooner (194 pc
   down to 26 pc), and fully-faded groups skip their draws entirely: at
   galactic scale only the bright set pays vertex cost.
3. **Lazy start** — the stream begins only when the camera enters the
   stellar neighborhood; a visitor who stays at cosmic scale never
   downloads the deep catalog.

Sprites are floored at ~3 px, so intensity is the only brightness control
left for faint stars: below mag 11 the intensity floor decays flux-like, and
the faint millions read as the Milky Way's grain instead of a gray veil.

Beyond the stars: the **real local universe** — 43k 2MASS Redshift Survey
galaxies out to ~260 Mpc with Virgo, Coma, and the Great Wall at their
measured places — and only past the survey's reach does procedural
placeholder (deterministic seed) take over. The 88 IAU constellation figures
draw as a line dome with Earth-occluded labels.

## Honesty

Every focus shows its provenance in the HUD, and the **honest seam** (`X`)
recolors the scene by it: measured data keeps natural colors, real-size-but-
stylized turns amber, purely illustrative turns blueprint-cyan. The rule
extends to detail layers — procedural close-up regolith on real WAC
photography is amber, the aerial photograph under the picnic is natural.

## Rendering

A thin WebGPU renderer ([`src/renderer.ts`](../src/renderer.ts)): four
pipelines (lit meshes, additive point sprites, orbit/constellation lines,
sky dome), 4× MSAA, per-fragment log depth, camera-relative uniforms per
draw. Textures stream in as they land — the Earth pair, the Moon color map,
generation-stamped imagery rings — with procedural fallbacks so the scene
never blocks on the network.

Verification is headless: real-GPU Chrome (`--headless=new
--enable-unsafe-webgpu`) drives screenshot regressions for every feature,
and `?fps=1` puts a frame-rate probe in the tab title for performance work.

## Data pipelines

Everything real is regenerable from public sources by the scripts in
[`scripts/`](../scripts/):

| Script                        | Source                            | Output                                            |
| ----------------------------- | --------------------------------- | ------------------------------------------------- |
| `generate-stars.mjs`          | HYG CSV                           | `src/data/brightstars.ts` (300 brightest + named) |
| `generate-star-tiles.mjs`     | ATHYG CSV                         | `public/stars/` (854k-star fallback tiles)        |
| `generate-gaia-tiles.mjs`     | ESA Gaia TAP (chunked, resumable) | `universe-data/stars/` (6.8M-star tileset)        |
| `generate-galaxies.mjs`       | 2MASS Redshift Survey             | `public/galaxies/2mrs.bin`                        |
| `generate-constellations.mjs` | d3-celestial                      | `src/data/constellations.ts`                      |
| `generate-moon.mjs`           | LOLA DEM (CGI Moon Kit)           | `public/moon/tranquility.json`                    |
| `generate-planets.mjs`        | NASA Trek WMTS + JPL Photojournal | `public/planets/` (globe maps + ring strip)       |
| `generate-mars.mjs`           | MOLA MEGDR grid (PDS)             | `public/mars/jezero.json`                         |
