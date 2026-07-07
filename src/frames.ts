// Hierarchical reference frames — the heart of the scale engine.
//
// A single coordinate system cannot span the observable universe (~1e27 m)
// down to 1 m: even float64 has ~57 km of quantization at galactic
// magnitudes. Instead, every object lives in a Frame whose origin is stored
// relative to a parent Frame. Relative positions between an object and the
// camera are computed by walking both chains only up to their LOWEST COMMON
// ANCESTOR, so two things standing on Earth's surface subtract meter-scale
// numbers (exact) instead of galaxy-scale numbers (57 km of error).

import { V3, add, sub } from './math';

export class Frame {
  readonly parent: Frame | null;
  readonly offset: V3; // position of this frame's origin in the parent frame
  readonly name: string;
  private readonly depth: number;

  constructor(name: string, parent: Frame | null, offset: V3) {
    this.name = name;
    this.parent = parent;
    this.offset = offset;
    this.depth = parent ? parent.depth + 1 : 0;
  }

  static lca(a: Frame, b: Frame): Frame {
    let x: Frame = a,
      y: Frame = b;
    while (x.depth > y.depth) x = x.parent!;
    while (y.depth > x.depth) y = y.parent!;
    while (x !== y) {
      x = x.parent!;
      y = y.parent!;
    }
    return x;
  }
}

// Position of (objFrame, objLocal) relative to (camFrame, camLocal), in doubles,
// accumulated only up to the common ancestor.
export function relPos(objFrame: Frame, objLocal: V3, camFrame: Frame, camLocal: V3): V3 {
  const lca = Frame.lca(objFrame, camFrame);
  let p: V3 = [objLocal[0], objLocal[1], objLocal[2]];
  for (let f: Frame = objFrame; f !== lca; f = f.parent!) p = add(p, f.offset);
  let q: V3 = [camLocal[0], camLocal[1], camLocal[2]];
  for (let f: Frame = camFrame; f !== lca; f = f.parent!) q = add(q, f.offset);
  return sub(p, q);
}

// Express a point given in `srcFrame` coordinates in `dstFrame` coordinates.
export function reexpress(srcFrame: Frame, srcLocal: V3, dstFrame: Frame): V3 {
  return relPos(srcFrame, srcLocal, dstFrame, [0, 0, 0]);
}
