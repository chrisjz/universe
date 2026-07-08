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
    emissive = textureSample(nightTex, samp, nuv).rgb * smoothstep(0.03, -0.12, ndl) * vec3f(1.0, 0.85, 0.6);
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
  let dif = max(ndl, 0.0);
  var amb = 0.05;
  var ambCol = vec3f(1.0);
  // Sky fill keeps the human-scale picnic scene readable; the imagery rings
  // (matId 8) are the planet itself and take planetary ambient instead.
  if (matId >= 5 && matId != 8 && matId != 9) { amb = 0.5; ambCol = vec3f(0.75, 0.85, 1.1); }
  var col = base * (amb * ambCol + 1.05 * dif) + emissive;
  col = col + base * O.color.a; // emissive boost (beacons etc.)

  if (O.misc.x > 0.0) { // atmosphere rim
    let v = normalize(-in.wp);
    let rim = pow(1.0 - max(dot(n, v), 0.0), 2.6) * (0.15 + dif);
    col = col + vec3f(0.3, 0.5, 1.0) * rim * O.misc.x;
  }
  out.col = vec4f(seamTint(col, O.misc.w), 1.0);
  return out;
}
`;

export const POINTS_WGSL =
  COMMON +
  /* wgsl */ `
struct Grp {
  origin : vec4f, // xyz: group origin rel camera, w: intensity fade
  misc : vec4f, // x: near-fade distance — sprites closer than this fade out
                // (f32 cancellation jitters near sprites at 1e16 m coords;
                // a double-precision star mesh takes over up close)
                // y: provenance (see seamTint)
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
  @location(0) ppos : vec3f,
  @location(1) psize : f32,
  @location(2) pcol : vec3f,
  @location(3) pint : f32,
) -> VOut {
  let raw = P.origin.xyz + ppos;
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
  var inten = pint * P.origin.w;
  if (P.misc.x > 0.0) { inten = inten * smoothstep(P.misc.x * 0.35, P.misc.x, d0); }
  o.inten = inten;
  return o;
}

@fragment fn fs(in : VOut) -> @location(0) vec4f {
  let r2 = dot(in.uv, in.uv);
  let a = (exp(-r2 * 4.5) + 0.6 * exp(-r2 * 30.0)) * in.inten;
  return vec4f(in.col * a, 1.0); // additive
}
`;

export const LINES_WGSL =
  COMMON +
  /* wgsl */ `
struct Line {
  origin : vec4f, // xyz: circle center rel camera, w: radius
  color  : vec4f, // rgb + alpha
};
@group(1) @binding(0) var<uniform> L : Line;

struct VOut { @builtin(position) pos : vec4f };

@vertex fn vs(@location(0) c : vec2f) -> VOut {
  let raw = L.origin.xyz + vec3f(c.x, 0.0, c.y) * L.origin.w;
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
  // Orbit guides depict real orbits with a drawn line: stylized-on-real.
  return vec4f(seamTint(L.color.rgb, 0.5) * L.color.a, 1.0); // additive
}
`;
