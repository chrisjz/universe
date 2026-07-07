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

// Rotation-only view matrix: the camera sits at the render-space origin
// (camera-relative rendering), so the view transform has no translation.
// Returns { view, right, up } — right/up feed billboard orientation.
export function viewRotation(
  yaw: number,
  pitch: number,
): { view: Float32Array<ArrayBuffer>; right: V3; up: V3; fwd: V3 } {
  // Camera is offset from its focus along dir; it looks back along -dir.
  const cp = Math.cos(pitch),
    sp = Math.sin(pitch);
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw);
  const dir: V3 = [cp * sy, sp, cp * cy]; // focus -> camera
  const f = norm(scale(dir, -1)); // camera forward
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
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
