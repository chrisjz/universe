// Double-precision (JS number) vector math for world-space positions, plus
// Float32 matrix helpers for the GPU. Positions stay in doubles until the last
// moment: everything uploaded to the GPU is already camera-relative.

export type V3 = [number, number, number];

export const v3 = (x = 0, y = 0, z = 0): V3 => [x, y, z];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 0 ? scale(a, 1 / l) : [0, 1, 0];
};
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const lerp3 = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const smootherstep = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

// Column-major 4x4, WebGPU clip conventions (z in [0,1], right-handed, -Z forward).
export function mat4Perspective(fovY: number, aspect: number, near: number, far: number): Float32Array<ArrayBuffer> {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (near * far) / (near - far);
  return m;
}

export function mat4Mul(a: Float32Array, b: Float32Array): Float32Array<ArrayBuffer> {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

// Direction from focus toward camera for a yaw/pitch pair, optionally
// expressed in an orbit basis (east, up, north) — used for tilted surface
// sites where "up" is the local zenith rather than world +Y.
export type Basis = [V3, V3, V3];

export function orbitDir(yaw: number, pitch: number, basis?: Basis): V3 {
  const cp = Math.cos(pitch),
    sp = Math.sin(pitch);
  const d: V3 = [cp * Math.sin(yaw), sp, cp * Math.cos(yaw)];
  if (!basis) return d;
  return [
    basis[0][0] * d[0] + basis[1][0] * d[1] + basis[2][0] * d[2],
    basis[0][1] * d[0] + basis[1][1] * d[1] + basis[2][1] * d[2],
    basis[0][2] * d[0] + basis[1][2] * d[1] + basis[2][2] * d[2],
  ];
}

// Rotation-only view matrix: the camera sits at the render-space origin
// (camera-relative rendering), so the view transform has no translation.
// Returns { view, right, up } — right/up feed billboard orientation.
// `upHint` sets the horizon roll (smoothed across basis transitions).
export function viewRotation(
  yaw: number,
  pitch: number,
  basis?: Basis,
  upHint?: V3,
  tilt = 0,
): { view: Float32Array<ArrayBuffer>; right: V3; up: V3; fwd: V3 } {
  const dir = orbitDir(yaw, pitch, basis); // focus -> camera
  let f = norm(scale(dir, -1)); // camera forward
  const upRef = upHint ?? basis?.[1] ?? [0, 1, 0];
  let r = cross(f, upRef);
  const rl = len(r);
  // Degenerate when looking straight along the up reference; fall back.
  r = rl > 1e-6 ? scale(r, 1 / rl) : norm(cross(f, basis?.[0] ?? [1, 0, 0]));
  let u = cross(r, f);
  if (tilt !== 0) {
    // First-person head-tilt: rotate the gaze up around the view right axis,
    // lifting it off the focus point (the camera position doesn't move —
    // this is how you look at the sky while standing on the ground).
    const ct = Math.cos(tilt),
      st = Math.sin(tilt);
    f = [f[0] * ct + u[0] * st, f[1] * ct + u[1] * st, f[2] * ct + u[2] * st];
    u = cross(r, f);
  }
  const m = new Float32Array(16);
  m[0] = r[0];
  m[4] = r[1];
  m[8] = r[2];
  m[1] = u[0];
  m[5] = u[1];
  m[9] = u[2];
  m[2] = -f[0];
  m[6] = -f[1];
  m[10] = -f[2];
  m[15] = 1;
  return { view: m, right: r, up: u, fwd: f };
}

// Deterministic PRNG so the placeholder universe is identical every run.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number): number {
  let u = 0,
    v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
