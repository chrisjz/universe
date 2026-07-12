// WGSL shaders. All positions arriving on the GPU are already camera-relative
// (camera at the origin). Two tricks shared by every pipeline:
//
// 1. Scaled render space: anything beyond CAP meters is compressed along the
//    view ray by d' = CAP * (1 + ln(d/CAP)), with sizes scaled by d'/d. This
//    preserves angular size exactly, preserves depth ordering, and folds
//    1e27 m of universe into ~5e8 render units that a float pipeline handles.
//    (Meshes are compressed CPU-side in doubles; points/lines here in-shader.)
//
// 2. Logarithmic depth: clip.z = log2(1+d)/log2(1+FAR) * clip.w.

const COMMON = /* wgsl */ `
struct Globals {
  viewProj : mat4x4f,
  camRight : vec4f,
  camUp    : vec4f,
  params   : vec4f, // x: cap, y: 1/log2(1+far), z: time, w: worldPerPixel@d=1
  motion   : vec4f, // x: years from J2000 (clamped ±1e6 — proper motion is
                    // linear on that scale; beyond it stars hold position)
  ecl0     : vec4f, // solar eclipse: Moon in earth-fixed units of R⊕ (xyz),
                    // w: Moon radius / R⊕ while an eclipse is possible, else 0
  ecl1     : vec4f, // sun in earth-fixed R⊕ units (xyz), w: ground-light
                    // factor at the camera's site (umbra >100 km: locally flat)
  lens     : vec4f, // gravitational lens: xyz Sgr A* rel camera (true meters),
                    // w its Schwarzschild radius while the camera is near
                    // the galactic center, else 0 (the branch below is free)
};
@group(0) @binding(0) var<uniform> G : Globals;

// Logarithmic depth with a dynamic reference scale (camRight.w tracks the
// camera's focus distance): the naive log2(1+d) collapses to zero below
// ~1e-7 m because 1+d rounds to 1 in f32 — fatal for the subatomic zoom.
fn logDepth(d : f32) -> f32 {
  return log2(1.0 + max(d, 0.0) / G.camRight.w) * G.params.y;
}

// length() overflows f32 for astronomical vectors (|v| > ~1.8e19 squares past
// f32 max) and underflows for subatomic ones, so normalize by the largest
// component first.
fn bigLength(v : vec3f) -> f32 {
  let m = max(max(abs(v.x), abs(v.y)), abs(v.z));
  if (m < 1e-30) { return 0.0; }
  return length(v / m) * m;
}

// The honest seam (camUp.w toggles it): recolor by provenance so you can see
// what is measured and what is imagined. 0 = measured (untouched),
// 0.5 = real dimensions but stylized look (amber), 1 = illustrative (cyan).
fn seamTint(col : vec3f, prov : f32) -> vec3f {
  if (G.camUp.w < 0.5 || prov <= 0.01) { return col; }
  let g = dot(col, vec3f(0.299, 0.587, 0.114));
  if (prov < 0.75) { return mix(col, vec3f(1.0, 0.72, 0.3) * (g * 0.9 + 0.1), 0.75); }
  return vec3f(0.3, 0.85, 1.0) * (g * 0.85 + 0.15);
}

// Gravitational lensing by Sgr A* (active only near the galactic center —
// G.lens.w carries the Schwarzschild radius, or 0). A source behind the
// hole appears displaced OUTWARD: the point-mass lens equation
// θ² − βθ − θ_E² = 0 with θ_E² = 2·rs·D_LS/(D_L·D_S), solved per vertex,
// so the S stars, their orbit lines, and the background galaxies all bend
// for real. Returns the displaced position (same distance, new direction)
// and the magnification μ — a star sweeping behind the hole visibly
// flares, exactly the microlensing a real observer would see.
//
// The second arg selects the equation's OTHER root: the counter-image on the far
// side of the hole. The S-star groups draw twice near the center, so a
// source crossing behind the shadow shows both arcs of its Einstein ring.
// A secondary draw returns weight 0 wherever the image is undefined.
fn lensPoint(raw : vec3f, second : f32) -> vec4f {
  let rs = G.lens.w;
  let dead = vec4f(raw, 1.0 - second); // no lensing: secondary images vanish
  if (rs <= 0.0) { return dead; }
  let dl = length(G.lens.xyz);
  let ds = bigLength(raw);
  if (ds < 1e-6 || dl < rs * 3.0) { return dead; }
  let bh = G.lens.xyz / dl;
  let sh = raw / ds;
  // Only light that passes the hole bends: the source must lie beyond it.
  let along = dot(sh, bh) * ds;
  if (along <= dl * 1.02) { return dead; }
  // β from the chord (acos loses small angles in f32); skip wide pairs.
  let beta = 2.0 * asin(min(0.5 * length(sh - bh), 1.0));
  if (beta > 0.7) { return dead; }
  let dls = along - dl;
  let te2 = (2.0 * rs * (dls / (dls + dl))) / dl; // θ_E²
  let root = sqrt(beta * beta + 4.0 * te2);
  // Primary root bends outward; the secondary lands on the opposite side
  // (negative angle — the rotation below takes it across the hole).
  let th = select(0.5 * (beta + root), 0.5 * (beta - root), second > 0.5);
  // Rotate the source direction away from the hole, in their common plane.
  let ax = sh - bh * dot(sh, bh);
  let axn = length(ax);
  if (axn < 1e-9) { return dead; } // dead center: a ring, not a point
  let t = ax / axn;
  let dir = bh * cos(th) + t * sin(th);
  // Magnification; the far cap only guards β/θ_E → 0. μ₋ falls to zero for
  // far-off-axis sources — their counter-images demagnify to nothing.
  let u = max(beta / max(sqrt(te2), 1e-12), 1e-3);
  let mu = (u * u + 2.0) / (2.0 * u * sqrt(u * u + 4.0));
  let mag = select(mu + 0.5, mu - 0.5, second > 0.5);
  return vec4f(dir * ds, min(mag, 60.0));
}
`;

const NOISE = /* wgsl */ `
fn hash3(p : vec3f) -> f32 {
  var q = fract(p * 0.3183099 + vec3f(0.71, 0.113, 0.419));
  q = q * 17.0;
  return fract(q.x * q.y * q.z * (q.x + q.y + q.z));
}
fn vnoise(p : vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(hash3(i + vec3f(0., 0., 0.)), hash3(i + vec3f(1., 0., 0.)), u.x);
  let b = mix(hash3(i + vec3f(0., 1., 0.)), hash3(i + vec3f(1., 1., 0.)), u.x);
  let c = mix(hash3(i + vec3f(0., 0., 1.)), hash3(i + vec3f(1., 0., 1.)), u.x);
  let d = mix(hash3(i + vec3f(0., 1., 1.)), hash3(i + vec3f(1., 1., 1.)), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}
fn fbm(p : vec3f) -> f32 {
  var v = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < 4; i = i + 1) {
    v = v + amp * vnoise(q);
    q = q * 2.03 + vec3f(1.7, 9.2, 4.1);
    amp = amp * 0.5;
  }
  return v;
}
`;

export const MESH_WGSL =
  COMMON +
  NOISE +
  /* wgsl */ `
// Fraction of the sun's disc visible from p (earth-fixed, units of R⊕):
// the exact two-circle overlap of the solar and lunar discs in angular
// radii. This is the whole solar-eclipse model — umbra, penumbra, and
// annularity all fall out of the same lens area.
fn sunVisible(p : vec3f, m : vec3f, rm : f32, s : vec3f) -> f32 {
  let sv = s - p;
  let mv = m - p;
  let ds = length(sv);
  let dm = length(mv);
  let ra = 109.2 / ds; // solar angular radius (R_sun = 109.2 R⊕)
  let rb = rm / dm;
  let sep = acos(clamp(dot(sv, mv) / (ds * dm), -1.0, 1.0));
  if (sep >= ra + rb) { return 1.0; }
  if (sep <= abs(ra - rb)) {
    if (rb >= ra) { return 0.0; } // totality
    return 1.0 - (rb * rb) / (ra * ra); // annularity: the ring of fire
  }
  let a2 = ra * ra;
  let b2 = rb * rb;
  let d1 = (sep * sep + a2 - b2) / (2.0 * sep);
  let d2 = sep - d1;
  let area = a2 * acos(clamp(d1 / ra, -1.0, 1.0)) + b2 * acos(clamp(d2 / rb, -1.0, 1.0))
           - d1 * sqrt(max(a2 - d1 * d1, 0.0)) - d2 * sqrt(max(b2 - d2 * d2, 0.0));
  return 1.0 - area / (3.14159265 * a2);
}

struct Obj {
  model : mat4x4f,
  color : vec4f, // rgb + emissive
  sun   : vec4f, // xyz: dir to sun (world axes), w: material id
  misc  : vec4f, // x: rim strength, y: local->meters scale (grid), z: textured flag, w: provenance
};
@group(1) @binding(0) var<uniform> O : Obj;

@group(2) @binding(0) var samp : sampler;
@group(2) @binding(1) var dayTex : texture_2d<f32>;
@group(2) @binding(2) var nightTex : texture_2d<f32>;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) wp : vec3f,
  @location(1) nrm : vec3f,
  @location(2) lp : vec3f,
};

@vertex fn vs(@location(0) p : vec3f, @location(1) n : vec3f) -> VOut {
  var o : VOut;
  let wp = (O.model * vec4f(p, 1.0)).xyz;
  // Standard projective z here; exact log depth is written per-fragment so
  // huge triangles (the ground plane) can't break depth via interpolation.
  o.pos = G.viewProj * vec4f(wp, 1.0);
  o.wp = wp;
  o.nrm = (O.model * vec4f(n, 0.0)).xyz;
  o.lp = p;
  return o;
}

struct FOut {
  @location(0) col : vec4f,
  @builtin(frag_depth) depth : f32,
};

@fragment fn fs(in : VOut) -> FOut {
  let matId = i32(O.sun.w + 0.5);
  let t = G.params.z;
  var base = O.color.rgb;
  let lp = in.lp;

  var out : FOut;
  out.depth = logDepth(length(in.wp));

  if (matId == 2) { // star surface: emissive, no lighting; highlight keeps the star's own hue
    let g = fbm(lp * 5.0 + vec3f(t * 0.03, 0.0, -t * 0.02));
    out.col = vec4f(seamTint(base * (0.85 + 0.4 * g) + base * base * pow(g, 3.0) * 0.55, O.misc.w), 1.0);
    return out;
  }

  // Normals/lighting first: the Earth night-lights blend needs the sun angle.
  // (No front_facing flip — see the winding note below.)
  var n = normalize(in.nrm);
  let L = O.sun.xyz;
  let ndl = dot(n, L);
  var emissive = vec3f(0.0);

  if (matId == 1) { // Earth
    // Equirectangular UV from the unit-sphere local position. Sampled per
    // fragment (not interpolated), so there is no UV seam to unwrap.
    let uv = vec2f(0.5 + atan2(-lp.z, lp.x) / 6.2831853, 0.5 - asin(clamp(lp.y, -1.0, 1.0)) / 3.1415927);
    if (O.misc.z > 0.5) { // NASA Blue Marble day + Black Marble city lights
      base = textureSample(dayTex, samp, uv).rgb;
      emissive = textureSample(nightTex, samp, uv).rgb * smoothstep(0.03, -0.12, ndl) * vec3f(1.0, 0.85, 0.6);
    } else { // procedural fallback until (or unless) the textures load
      let h = fbm(lp * 2.6);
      let landMask = smoothstep(0.5, 0.55, h);
      let landCol = mix(vec3f(0.16, 0.3, 0.12), vec3f(0.52, 0.45, 0.28), fbm(lp * 7.1));
      let oceanCol = mix(vec3f(0.015, 0.08, 0.2), vec3f(0.03, 0.16, 0.34), fbm(lp * 4.3));
      base = mix(oceanCol, landCol, landMask);
      let ice = smoothstep(0.86, 0.96, abs(lp.y) + 0.06 * h);
      base = mix(base, vec3f(0.88, 0.91, 0.95), ice);
    }
  } else if (matId == 10) { // the Moon: LROC WAC global color, eclipse tint in O.color
    let uv = vec2f(0.5 + atan2(-lp.z, lp.x) / 6.2831853, 0.5 - asin(clamp(lp.y, -1.0, 1.0)) / 3.1415927);
    if (O.misc.z > 0.5) {
      base = textureSample(dayTex, samp, uv).rgb * O.color.rgb;
    } else { // procedural regolith until (or unless) the texture loads
      base = vec3f(0.72, 0.7, 0.68) * O.color.rgb * (0.7 + 0.6 * fbm(lp * 9.0));
    }
  } else if (matId == 11) {
    // Airless/thin-air imagery ring (Moon WAC, Mars Viking via NASA Trek):
    // plain sun-lit imagery draped on the sphere — no night lights. O.color
    // carries a tint (the Moon's rings share the lunar-eclipse multiplier so
    // the ground dims and reddens with the globe). O.misc.x is an exposure
    // gain matching the ring mosaic to its globe map (WAC 1.6, Viking 1.0).
    let uv = vec2f(lp.x / O.misc.y + 0.5, 0.5 - lp.z / O.misc.y);
    let gain = select(1.0, O.misc.x, O.misc.x > 0.0);
    base = textureSample(dayTex, samp, uv).rgb * gain * O.color.rgb;
    // Up close the source is ~83 m/px: procedural regolith detail carries
    // the last two orders of magnitude, fading out by a few km away.
    let lpm = lp.xz * O.misc.y;
    let reg = 0.75 + 0.5 * fbm(vec3f(lpm.x * 0.4, 0.0, lpm.y * 0.4));
    base = base * mix(reg, 1.0, smoothstep(300.0, 3000.0, length(in.wp)));
  } else if (matId == 3) { // banded gas giant
    let band = fbm(vec3f(lp.y * 6.0, lp.y * 6.0 + 3.7, 0.5) + lp * 0.6);
    base = mix(base, base * vec3f(0.72, 0.68, 0.66), band);
  } else if (matId == 4) { // rocky
    base = base * (0.7 + 0.6 * fbm(lp * 9.0));
  } else if (matId == 5) { // park lawn: grass and a faint 1 m / 10 m grid
    let lpm = lp.xz * O.misc.y; // meters; local +X = east, +Z = north
    let d = length(in.wp);
    let f1 = exp(-d / 60.0);
    let f10 = exp(-d / 500.0);
    let g1x = 1.0 - smoothstep(0.0, 0.05, abs(fract(lpm.x) - 0.5) - 0.45);
    let g1z = 1.0 - smoothstep(0.0, 0.05, abs(fract(lpm.y) - 0.5) - 0.45);
    let g10x = 1.0 - smoothstep(0.0, 0.006, abs(fract(lpm.x / 10.0) - 0.5) - 0.492);
    let g10z = 1.0 - smoothstep(0.0, 0.006, abs(fract(lpm.y / 10.0) - 0.5) - 0.492);
    base = base * (0.85 + 0.3 * fbm(vec3f(lpm.x * 0.2, 0.0, lpm.y * 0.2)));
    base = base * (1.0 - 0.22 * max(g1x, g1z) * f1 - 0.3 * max(g10x, g10z) * f10);
  } else if (matId == 8 || matId == 9) {
    // Imagery draped on the sphere (Esri World Imagery). matId 9 is the lawn:
    // it samples the innermost ring's texture so the picnic ground IS the
    // surrounding photograph, plus close-up procedural detail and the 1 m grid.
    let uv = vec2f(lp.x / O.misc.y + 0.5, 0.5 - lp.z / O.misc.y);
    base = textureSample(dayTex, samp, uv).rgb;
    // Night: the global Black Marble sampled via a local affine linearization
    // of the equirectangular map around the site (color.rg = uv there,
    // color.b = du per east-meter, misc.x = dv per north-meter).
    var meters = lp.xz;
    if (matId == 9) { meters = lp.xz * 380.0; } // the lawn disk is a 380 m unit disk
    else { meters = lp.xz; }
    let nuv = vec2f(O.color.r + meters.x * O.color.b, O.color.g + meters.y * O.misc.x);
    let lights = textureSample(nightTex, samp, nuv).rgb;
    let nightF = smoothstep(0.03, -0.12, ndl);
    // From afar you see the city lights themselves; standing on the ground
    // you see the imagery lit BY them. Black Marble is ~5 km/px, so up
    // close it can only supply the overall glow level — use it as a dim
    // warm ambient on the imagery and blend to the raw lights with camera
    // distance, once a pixel of the night texture is genuinely far away.
    // In between, the glow is modulated by the day imagery's luminance —
    // streets and rooftops are bright by day too — so the light pattern
    // follows real city blocks instead of night-texture blob resolution.
    let glowMix = smoothstep(1.0e4, 1.5e5, length(in.wp));
    let lum = dot(lights, vec3f(0.299, 0.587, 0.114));
    let dayLum = dot(base, vec3f(0.299, 0.587, 0.114));
    let lit = base * (0.06 + 0.3 * lum) * vec3f(1.0, 0.88, 0.7);
    let detail = mix(0.35 + 1.3 * dayLum, 1.0, glowMix);
    let glow = lights * vec3f(1.0, 0.85, 0.6) * detail;
    emissive = nightF * mix(lit, glow, glowMix);
    if (matId == 9) {
      let lpm = lp.xz * 380.0;
      let d = length(in.wp);
      let f1 = exp(-d / 60.0);
      let f10 = exp(-d / 500.0);
      let g1x = 1.0 - smoothstep(0.0, 0.05, abs(fract(lpm.x) - 0.5) - 0.45);
      let g1z = 1.0 - smoothstep(0.0, 0.05, abs(fract(lpm.y) - 0.5) - 0.45);
      let g10x = 1.0 - smoothstep(0.0, 0.006, abs(fract(lpm.x / 10.0) - 0.5) - 0.492);
      let g10z = 1.0 - smoothstep(0.0, 0.006, abs(fract(lpm.y / 10.0) - 0.5) - 0.492);
      base = base * (0.9 + 0.2 * fbm(vec3f(lpm.x * 0.6, 0.0, lpm.y * 0.6)));
      base = base * (1.0 - 0.16 * max(g1x, g1z) * f1 - 0.2 * max(g10x, g10z) * f10);
    }
  } else if (matId == 7) { // the picnic blanket: 8x8 red/white checker
    let cell = (i32(floor((lp.x + 1.0) * 4.0)) + i32(floor((lp.z + 1.0) * 4.0))) & 1;
    base = mix(vec3f(0.72, 0.09, 0.07), vec3f(0.93, 0.9, 0.84), f32(cell));
    base = base * (0.9 + 0.2 * fbm(lp * 24.0)); // a little fabric weave
  }

  // All meshes carry correct outward normals; do NOT flip on front_facing —
  // our sphere/box winding is CW in framebuffer space, so the outside is
  // rasterized as "back" and flipping would point every normal inward
  // (which made planets render black on their sunlit side).
  var amb = 0.05;
  var ambCol = vec3f(1.0);
  // Sky fill keeps the human-scale picnic scene readable; the imagery rings
  // (matId 8) and the Moon materials are planets and take planetary ambient.
  if (matId >= 5 && matId != 8 && matId != 9 && matId != 10 && matId != 11 && matId != 12) { amb = 0.5; ambCol = vec3f(0.75, 0.85, 1.1); }
  var alpha = 1.0;
  var dif = max(ndl, 0.0);
  // Solar eclipse: the Moon's shadow. The globe (matId 1) computes real
  // per-fragment sun coverage — the umbra spot crosses the map where it
  // really lands; earthbound site materials share the ground factor.
  if (G.ecl0.w > 0.0) {
    if (matId == 1) {
      dif = dif * sunVisible(lp, G.ecl0.xyz, G.ecl0.w, G.ecl1.xyz);
    } else if (matId == 5 || matId == 6 || matId == 7 || matId == 8 || matId == 9) {
      dif = dif * G.ecl1.w;
    }
  }
  if (matId == 12) {
    // Saturn's rings: Cassini's radial scan (color measured, opacity from
    // brightness) sampled by distance from the planet's center. The strip
    // spans 74,500..140,500 km; the mesh is a unit annulus scaled to the
    // outer radius. Ice sheets scatter from both faces: light the ring by
    // |n·L| so the unlit-side view shows the rings too (translucency).
    let rf = (length(lp.xz) - 0.53025) / (1.0 - 0.53025);
    let tex = textureSample(dayTex, samp, vec2f(clamp(rf, 0.001, 0.999), 0.5));
    base = tex.rgb * O.color.rgb;
    alpha = tex.a;
    dif = abs(ndl) * 0.9 + 0.05;
  }
  var col = base * (amb * ambCol + 1.05 * dif) + emissive;
  col = col + base * O.color.a; // emissive boost (beacons etc.)

  if (O.misc.x > 0.0) { // atmosphere rim
    let v = normalize(-in.wp);
    let rim = pow(1.0 - max(dot(n, v), 0.0), 2.6) * (0.15 + dif);
    col = col + vec3f(0.3, 0.5, 1.0) * rim * O.misc.x;
  }
  out.col = vec4f(seamTint(col, O.misc.w), alpha);
  return out;
}
`;

// Two variants share this body: static point groups (planet sprites, the
// web, galaxies) and MOVING star groups, whose instances carry a real 3D
// space velocity applied in the vertex shader (pos + vel · years). The
// years uniform is clamped ±1e6 in main.ts — proper motion is linear on
// that scale; beyond it the stars hold their positions (the galactic-year
// rotation carries the deep-time story instead).
// Three variants share this sprite body:
//   'static'  — planet locators, the web, galaxies (8-float instances)
//   'moving'  — stars with a 3D space velocity (11 floats; pos + vel·years)
//   'orbital' — small bodies on full Kepler orbits (10 floats: ellipse
//               semi-axis vectors A/B + e, M0, n, H). The vertex shader
//               solves Kepler's equation E − e·sinE = M by Newton iteration
//               EVERY FRAME for every asteroid — 40k real orbits at zero
//               CPU cost. Radius and brightness derive from H (albedo 0.1:
//               D ≈ 1329 km · 10^(−H/5) / √0.1).
export type PointsMode = 'static' | 'moving' | 'orbital';
export const pointsWgsl = (mode: PointsMode): string =>
  COMMON +
  /* wgsl */ `
struct Grp {
  origin : vec4f, // xyz: group origin rel camera, w: intensity fade
  misc : vec4f, // x: near-fade distance — sprites closer than this fade out
                // (f32 cancellation jitters near sprites at 1e16 m coords;
                // a double-precision star mesh takes over up close)
                // y: provenance (see seamTint)
  tint : vec4f, // orbital groups: rgb population color, w base intensity
};
@group(1) @binding(0) var<uniform> P : Grp;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
  @location(1) col : vec3f,
  @location(2) inten : f32,
};

@vertex fn vs(
  @builtin(vertex_index) vi : u32,
${
  mode === 'orbital'
    ? `  @location(0) axA : vec3f,
  @location(1) axB : vec3f,
  @location(2) prm : vec4f, // e, M0 (rad @J2000), n (rad/day), H`
    : `  @location(0) ppos0 : vec3f,
  @location(1) psize : f32,
  @location(2) pcol : vec3f,
  @location(3) pint : f32,${mode === 'moving' ? '\n  @location(4) pvel : vec3f,' : ''}`
}
) -> VOut {
${
  mode === 'orbital'
    ? `  let e = prm.x;
  var M = prm.y + prm.z * G.motion.y; // days from J2000, clamped ±100 yr
  M = M - 6.2831853 * floor(M / 6.2831853);
  var E = M + e * sin(M);
  for (var k = 0; k < 5; k++) { E = E - (E - e * sin(E) - M) / (1.0 - e * cos(E)); }
  let ppos = axA * (cos(E) - e) + axB * sin(E);
  let psize = 2.1e6 * pow(10.0, -prm.w * 0.2); // radius from H, albedo 0.1
  let pcol = P.tint.rgb;
  let pint = P.tint.w * clamp(1.3 - 0.09 * prm.w, 0.15, 1.0);`
    : `  let ppos = ppos0${mode === 'moving' ? ' + pvel * G.motion.x' : ''};`
}
  // Sgr A* bends passing light; misc.z > 0 marks a secondary-image draw.
  let lz = lensPoint(P.origin.xyz + ppos, P.misc.z);
  let raw = lz.xyz;
  let d0 = max(bigLength(raw), 1e-18);
  let cap = G.params.x;
  var dc = d0;
  var pc = raw;
  if (d0 > cap) {
    dc = cap * (1.0 + log(d0 / cap));
    pc = raw * (dc / d0);
  }
  var size = psize * (dc / d0);
  size = max(size, 1.4 * G.params.w * dc); // never smaller than ~3 px
  let ux = select(-1.0, 1.0, vi == 1u || vi == 2u || vi == 4u);
  let uy = select(-1.0, 1.0, vi == 2u || vi == 4u || vi == 5u);
  let wp = pc + (G.camRight.xyz * ux + G.camUp.xyz * uy) * size;
  var clip = G.viewProj * vec4f(wp, 1.0);
  clip.z = logDepth(dc) * clip.w;
  var o : VOut;
  o.pos = clip;
  o.uv = vec2f(ux, uy);
  o.col = seamTint(pcol, P.misc.y);
  var inten = pint * P.origin.w * lz.w; // lensed images brighten (μ₊)
  // Near fade: f32 cancellation jitters a sprite by ~6e-8 of its distance
  // from the group origin, and a focused star's arrival distance grows with
  // its radius — so the fade radius scales with the sprite's own remoteness
  // (1%), floored at the group constant. The double-precision star mesh has
  // taken over long before the sprite goes.
  if (P.misc.x > 0.0) {
    let nf = max(P.misc.x, 0.01 * bigLength(ppos));
    inten = inten * smoothstep(nf * 0.35, nf, d0);
  }
  o.inten = inten;
  return o;
}

@fragment fn fs(in : VOut) -> @location(0) vec4f {
  let r2 = dot(in.uv, in.uv);
  let a = (exp(-r2 * 4.5) + 0.6 * exp(-r2 * 30.0)) * in.inten;
  return vec4f(in.col * a, 1.0); // additive
}
`;

// Constellation figures: free line-list segments on the celestial sphere
// (unit directions × the dome radius in origin.w). Same uniform layout as
// the orbit lines, so they share the dynamic buffer.
export const SKY_WGSL =
  COMMON +
  /* wgsl */ `
struct Line {
  origin : vec4f, // xyz: dome center rel camera, w: dome radius
  color  : vec4f, // rgb + alpha
};
@group(1) @binding(0) var<uniform> L : Line;

struct VOut { @builtin(position) pos : vec4f };

@vertex fn vs(@location(0) dir : vec3f) -> VOut {
  let raw = L.origin.xyz + dir * L.origin.w;
  let d0 = max(bigLength(raw), 1e-3);
  let cap = G.params.x;
  var dc = d0;
  var pc = raw;
  if (d0 > cap) {
    dc = cap * (1.0 + log(d0 / cap));
    pc = raw * (dc / d0);
  }
  var clip = G.viewProj * vec4f(pc, 1.0);
  clip.z = logDepth(dc) * clip.w;
  var o : VOut;
  o.pos = clip;
  return o;
}

@fragment fn fs() -> @location(0) vec4f {
  // The stars are measured; the figures are ours: stylized-on-real.
  return vec4f(seamTint(L.color.rgb, 0.5) * L.color.a, 1.0); // additive
}
`;

// The real sky, from one integral: single-scatter Rayleigh + Mie through an
// exponential atmosphere, ray-marched per fragment. The same shell drawn the
// same way gives the blue limb from orbit, the blue daytime dome from the
// ground, the white horizon band (long tangent air paths), red sunsets
// (Rayleigh strips blue from low-sun light paths), twilight, and aerial
// star-fading — none are coded as effects; they are the integral.
//
// Marching happens in TRUE camera-relative meters from the uniform (the
// scaled-space compression preserves ray directions, so only the vertex
// position and frag depth are compressed). Blending is src=one,
// dst=one-minus-src-alpha: the in-scatter adds, and everything behind is
// attenuated by mean transmittance — stars fade at noon, the sun dims at
// the horizon. Fragment depth is the ray's LAST scattering point, so
// foreground objects (a tree against the horizon, the Moon crossing the
// limb) occlude the sky behind them instead of glowing through it.
export const atmoWgsl = (nView: number, nLight: number, jitter: boolean): string =>
  COMMON +
  /* wgsl */ `
struct Atmo {
  center : vec4f, // xyz: planet center rel camera (true meters), w: ground radius
  sun    : vec4f, // xyz: unit direction to the sun, w: atmosphere top radius
  beta   : vec4f, // xyz: molecular/dust scattering per meter (rgb), w: scale height
  mie    : vec4f, // x: Mie beta, y: Mie scale height, z: anisotropy g, w: sun radiance
};
@group(1) @binding(0) var<uniform> A : Atmo;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) dir : vec3f,
};

fn compDist(d : f32) -> f32 {
  let cap = G.params.x;
  if (d > cap) { return cap * (1.0 + log(d / cap)); }
  return d;
}

@vertex fn vs(@location(0) p : vec3f, @location(1) n : vec3f) -> VOut {
  // The unit sphere scaled to the shell top; back faces are drawn so the
  // shell reads from outside (the limb) and from inside (the sky) alike.
  let raw = A.center.xyz + p * A.sun.w;
  let d0 = max(bigLength(raw), 1e-3);
  let dc = compDist(d0);
  var clip = G.viewProj * vec4f(raw * (dc / d0), 1.0);
  clip.z = logDepth(dc) * clip.w;
  var o : VOut;
  o.pos = clip;
  o.dir = raw;
  return o;
}

// Ray from the camera (origin) against a sphere at c: entry/exit distances,
// or (1e30, -1e30) on a miss.
fn raySphere(v : vec3f, c : vec3f, r : f32) -> vec2f {
  let b = dot(v, c);
  let disc = b * b - dot(c, c) + r * r;
  if (disc < 0.0) { return vec2f(1e30, -1e30); }
  let s = sqrt(disc);
  return vec2f(b - s, b + s);
}

const PI_A = 3.14159265;
const MIE_ABS = 1.11; // Mie extinction = scattering x 1.11

struct FOut {
  @location(0) col : vec4f,
  @builtin(frag_depth) depth : f32,
};

@fragment fn fs(in : VOut) -> FOut {
  let v = normalize(in.dir);
  let c = A.center.xyz;
  let Rg = A.center.w;
  let Rt = A.sun.w;
  let shell = raySphere(v, c, Rt);
  if (shell.x > shell.y) { discard; }
  let t0 = max(shell.x, 0.0);
  var t1 = shell.y;
  let gnd = raySphere(v, c, Rg);
  if (gnd.x < gnd.y && gnd.x > 0.0) { t1 = min(t1, gnd.x); }
  if (t1 <= t0) { discard; }

  let sd = A.sun.xyz;
  let dt = (t1 - t0) / ${nView}.0;
  var odR = 0.0;
  var odM = 0.0;
  var accR = vec3f(0.0);
  var accM = vec3f(0.0);
${jitter ? '  let jit = fract(sin(dot(in.pos.xy, vec2f(12.9898, 78.233))) * 43758.547);' : '  let jit = 0.5;'}
  for (var i = 0; i < ${nView}; i = i + 1) {
    let t = t0 + (f32(i) + jit) * dt;
    let pos = v * t - c; // planet-centric sample
    let h = max(length(pos) - Rg, 0.0);
    let sR = exp(-h / A.beta.w) * dt;
    let sM = exp(-h / A.mie.y) * dt;
    odR = odR + sR;
    odM = odM + sM;
    // Night side: the sun ray from this sample hits the planet.
    let lg = raySphere(sd, -pos, Rg);
    if (lg.x < lg.y && lg.x > 0.0) { continue; }
    // Optical depth along the light path to the top of the shell.
    let dl = raySphere(sd, -pos, Rt).y / ${nLight}.0;
    var lodR = 0.0;
    var lodM = 0.0;
    for (var j = 0; j < ${nLight}; j = j + 1) {
      let lh = max(length(pos + sd * ((f32(j) + 0.5) * dl)) - Rg, 0.0);
      lodR = lodR + exp(-lh / A.beta.w) * dl;
      lodM = lodM + exp(-lh / A.mie.y) * dl;
    }
    let T = exp(-(A.beta.xyz * (odR + lodR) + vec3f(A.mie.x * MIE_ABS * (odM + lodM))));
    accR = accR + T * sR;
    accM = accM + T * sM;
  }
  let mu = dot(v, sd);
  let phR = 3.0 / (16.0 * PI_A) * (1.0 + mu * mu);
  let gg = A.mie.z * A.mie.z;
  let phM = 3.0 / (8.0 * PI_A) * ((1.0 - gg) * (1.0 + mu * mu)) /
            ((2.0 + gg) * pow(1.0 + gg - 2.0 * A.mie.z * mu, 1.5));
  var L = A.mie.w * (A.beta.xyz * phR * accR + vec3f(A.mie.x) * phM * accM);
  L = vec3f(1.0) - exp(-L); // soft shoulder: the zenith stays blue, not white
  let Tv = exp(-(A.beta.xyz * odR + vec3f(A.mie.x * MIE_ABS * odM)));
  // Transmittance dims what's behind — and bright air also MASKS it. Stars
  // sit above the atmosphere, so daylight hides them by contrast, not
  // extinction; a veiling-luminance term folds that into the blend.
  let veil = clamp(dot(L, vec3f(0.299, 0.587, 0.114)) * 5.0, 0.0, 1.0);
  let Tbar = clamp(dot(Tv, vec3f(0.299, 0.587, 0.114)), 0.0, 1.0);
  let alpha = 1.0 - Tbar * (1.0 - veil);
  var o : FOut;
  // Real physics, real constants, but still a model: stylized-on-real.
  o.col = vec4f(seamTint(L, 0.5), alpha);
  // Depth at the last scattering point (nudged past coincident surfaces):
  // geometry nearer than the ray's air column occludes the sky behind it.
  o.depth = logDepth(compDist(t1 * 1.0001));
  return o;
}
`;

// The far-field dome: the faint Gaia bands baked into a float cubemap
// (renderer.bakeFarFace) and drawn as one additive sphere — millions of
// sub-8-bit sprites become six vertices. The bake accumulates in fp16, so
// stars too faint to survive the swapchain's 8-bit quantization now sum
// honestly into the Milky Way's grain.
export const DOME_WGSL =
  COMMON +
  /* wgsl */ `
struct Dome { fade : vec4f }; // x: intensity multiplier (far/deep-time fades)
@group(1) @binding(0) var<uniform> D : Dome;
@group(1) @binding(1) var domeSamp : sampler;
@group(1) @binding(2) var farCube : texture_cube<f32>;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) dir : vec3f,
};

@vertex fn vs(@location(0) p : vec3f, @location(1) n : vec3f) -> VOut {
  // A sky-distance sphere around the camera; direction is all that matters.
  let raw = p * 1e18;
  let d0 = 1e18;
  let cap = G.params.x;
  let dc = cap * (1.0 + log(d0 / cap));
  var clip = G.viewProj * vec4f(raw * (dc / d0), 1.0);
  clip.z = logDepth(dc) * clip.w;
  var o : VOut;
  o.pos = clip;
  o.dir = p;
  return o;
}

@fragment fn fs(in : VOut) -> @location(0) vec4f {
  let c = textureSample(farCube, domeSamp, normalize(in.dir)).rgb;
  return vec4f(c * D.fade.x, 1.0); // additive over the black sky
}
`;

export const LINES_WGSL =
  COMMON +
  /* wgsl */ `
struct Line {
  origin : vec4f, // xyz: ELLIPSE center rel camera (the sun sits at a focus)
  color  : vec4f, // rgb + alpha
  axisA  : vec4f, // xyz: semi-major axis vector (scene meters)
                  // w: 1 on a secondary-image draw (Sgr A* counter-image)
  axisB  : vec4f, // xyz: semi-minor axis vector
};
@group(1) @binding(0) var<uniform> L : Line;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) am : f32, // per-vertex brightness (secondary images fade out)
};

@vertex fn vs(@location(0) c : vec2f) -> VOut {
  // pos(θ) = center + A·cosθ + B·sinθ: the true inclined Kepler ellipse
  // (a circle is the special case A = (r,0,0), B = (0,0,r)). Near Sgr A*
  // each sample point lenses independently — the far side of an S-star
  // orbit visibly warps around the shadow, and a second draw adds the
  // counter-image arcs hugging the Einstein ring. A line is an extended
  // source (surface brightness is conserved), so the primary image keeps
  // its alpha; the secondary fades by its demagnification.
  let lz = lensPoint(L.origin.xyz + L.axisA.xyz * c.x + L.axisB.xyz * c.y, L.axisA.w);
  let raw = lz.xyz;
  let d0 = max(bigLength(raw), 1e-3);
  let cap = G.params.x;
  var dc = d0;
  var pc = raw;
  if (d0 > cap) {
    dc = cap * (1.0 + log(d0 / cap));
    pc = raw * (dc / d0);
  }
  var clip = G.viewProj * vec4f(pc, 1.0);
  clip.z = logDepth(dc) * clip.w;
  var o : VOut;
  o.pos = clip;
  o.am = select(1.0, clamp(abs(lz.w), 0.0, 1.0), L.axisA.w > 0.5);
  return o;
}

@fragment fn fs(in : VOut) -> @location(0) vec4f {
  // Orbit guides depict real orbits with a drawn line: stylized-on-real.
  return vec4f(seamTint(L.color.rgb, 0.5) * L.color.a * in.am, 1.0); // additive
}
`;
