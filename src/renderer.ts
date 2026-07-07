// Thin WebGPU renderer: three pipelines (lit meshes, additive point sprites,
// additive orbit lines) sharing a globals uniform and a per-draw dynamic
// uniform buffer. 4x MSAA, float32 log depth.

import { MESH_WGSL, POINTS_WGSL, LINES_WGSL } from './shaders';

export type MeshKind = 'sphere' | 'box' | 'disk';

export type F32 = Float32Array<ArrayBuffer>;

export interface FrameData {
  globals: F32; // 28 floats
  meshes: { kind: MeshKind; data: F32 }[]; // 28 floats each
  lines: F32[]; // 8 floats each
  groups: { index: number; data: F32 }[]; // 4 floats each
}

const SLOT = 256; // dynamic uniform offset alignment
const MAX_DRAWS = 64;

interface Geometry {
  vbuf: GPUBuffer;
  ibuf: GPUBuffer;
  indexCount: number;
}

export class Renderer {
  private device!: GPUDevice;
  private ctx!: GPUCanvasContext;
  private format!: GPUTextureFormat;
  private canvas: HTMLCanvasElement;

  private meshPipe!: GPURenderPipeline;
  private pointPipe!: GPURenderPipeline;
  private linePipe!: GPURenderPipeline;

  private globalsBuf!: GPUBuffer;
  private meshUBO!: GPUBuffer;
  private lineUBO!: GPUBuffer;
  private groupUBO!: GPUBuffer;
  private globalsBG!: GPUBindGroup;
  private meshBG!: GPUBindGroup;
  private lineBG!: GPUBindGroup;
  private groupBG!: GPUBindGroup;

  private geoms = new Map<MeshKind, Geometry>();
  private pointGroups: { buf: GPUBuffer; count: number }[] = [];
  private circleBuf!: GPUBuffer;
  private circleVerts = 0;

  private depthTex: GPUTexture | null = null;
  private msaaTex: GPUTexture | null = null;

  private meshStaging = new Float32Array((SLOT / 4) * MAX_DRAWS);
  private lineStaging = new Float32Array((SLOT / 4) * MAX_DRAWS);
  private groupStaging = new Float32Array((SLOT / 4) * MAX_DRAWS);

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async init(): Promise<void> {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    this.device = await adapter.requestDevice();
    this.device.addEventListener('uncapturederror', (e) => {
      console.error('[webgpu]', e.error.message);
    });
    console.log('[webgpu] adapter ok');
    this.ctx = this.canvas.getContext('webgpu') as GPUCanvasContext;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });

    const d = this.device;
    this.globalsBuf = d.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.meshUBO = d.createBuffer({ size: SLOT * MAX_DRAWS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.lineUBO = d.createBuffer({ size: SLOT * MAX_DRAWS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.groupUBO = d.createBuffer({ size: SLOT * MAX_DRAWS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const globalsBGL = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const dynBGL = d.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
      ],
    });
    const layout = d.createPipelineLayout({ bindGroupLayouts: [globalsBGL, dynBGL] });

    this.globalsBG = d.createBindGroup({
      layout: globalsBGL,
      entries: [{ binding: 0, resource: { buffer: this.globalsBuf } }],
    });
    const mkDyn = (buf: GPUBuffer, size: number) =>
      d.createBindGroup({ layout: dynBGL, entries: [{ binding: 0, resource: { buffer: buf, size } }] });
    this.meshBG = mkDyn(this.meshUBO, 112);
    this.lineBG = mkDyn(this.lineUBO, 32);
    this.groupBG = mkDyn(this.groupUBO, 16);

    const depthStencil: GPUDepthStencilState = {
      format: 'depth32float',
      depthWriteEnabled: true,
      depthCompare: 'less',
    };
    const depthNoWrite: GPUDepthStencilState = {
      format: 'depth32float',
      depthWriteEnabled: false,
      depthCompare: 'less',
    };
    const additive: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };

    const meshMod = d.createShaderModule({ code: MESH_WGSL });
    this.meshPipe = d.createRenderPipeline({
      layout,
      vertex: {
        module: meshMod,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 24,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
            ],
          },
        ],
      },
      fragment: { module: meshMod, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
      multisample: { count: 4 },
    });

    const pointMod = d.createShaderModule({ code: POINTS_WGSL });
    this.pointPipe = d.createRenderPipeline({
      layout,
      vertex: {
        module: pointMod,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 32,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32' },
              { shaderLocation: 2, offset: 16, format: 'float32x3' },
              { shaderLocation: 3, offset: 28, format: 'float32' },
            ],
          },
        ],
      },
      fragment: { module: pointMod, entryPoint: 'fs', targets: [{ format: this.format, blend: additive }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: depthNoWrite,
      multisample: { count: 4 },
    });

    const lineMod = d.createShaderModule({ code: LINES_WGSL });
    this.linePipe = d.createRenderPipeline({
      layout,
      vertex: {
        module: lineMod,
        entryPoint: 'vs',
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
      },
      fragment: { module: lineMod, entryPoint: 'fs', targets: [{ format: this.format, blend: additive }] },
      primitive: { topology: 'line-strip' },
      depthStencil: depthNoWrite,
      multisample: { count: 4 },
    });

    this.buildGeometries();
    this.buildCircle();
  }

  addPointGroup(instances: F32): number {
    const buf = this.device.createBuffer({
      size: instances.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buf, 0, instances);
    this.pointGroups.push({ buf, count: instances.length / 8 });
    return this.pointGroups.length - 1;
  }

  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
    this.depthTex?.destroy();
    this.msaaTex?.destroy();
    this.depthTex = this.device.createTexture({
      size: [width, height],
      sampleCount: 4,
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.msaaTex = this.device.createTexture({
      size: [width, height],
      sampleCount: 4,
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  render(frame: FrameData): void {
    if (!this.depthTex || !this.msaaTex) return;
    const q = this.device.queue;
    q.writeBuffer(this.globalsBuf, 0, frame.globals);

    const nMesh = Math.min(frame.meshes.length, MAX_DRAWS);
    for (let i = 0; i < nMesh; i++) this.meshStaging.set(frame.meshes[i].data, (SLOT / 4) * i);
    if (nMesh) q.writeBuffer(this.meshUBO, 0, this.meshStaging, 0, (SLOT / 4) * nMesh);

    const nLine = Math.min(frame.lines.length, MAX_DRAWS);
    for (let i = 0; i < nLine; i++) this.lineStaging.set(frame.lines[i], (SLOT / 4) * i);
    if (nLine) q.writeBuffer(this.lineUBO, 0, this.lineStaging, 0, (SLOT / 4) * nLine);

    const nGrp = Math.min(frame.groups.length, MAX_DRAWS);
    for (let i = 0; i < nGrp; i++) this.groupStaging.set(frame.groups[i].data, (SLOT / 4) * i);
    if (nGrp) q.writeBuffer(this.groupUBO, 0, this.groupStaging, 0, (SLOT / 4) * nGrp);

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.msaaTex.createView(),
          resolveTarget: this.ctx.getCurrentTexture().createView(),
          clearValue: { r: 0.004, g: 0.005, b: 0.01, a: 1 },
          loadOp: 'clear',
          storeOp: 'discard',
        },
      ],
      depthStencilAttachment: {
        view: this.depthTex.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });

    pass.setBindGroup(0, this.globalsBG);

    pass.setPipeline(this.meshPipe);
    for (let i = 0; i < nMesh; i++) {
      const g = this.geoms.get(frame.meshes[i].kind)!;
      pass.setBindGroup(1, this.meshBG, [SLOT * i]);
      pass.setVertexBuffer(0, g.vbuf);
      pass.setIndexBuffer(g.ibuf, 'uint32');
      pass.drawIndexed(g.indexCount);
    }

    pass.setPipeline(this.linePipe);
    pass.setVertexBuffer(0, this.circleBuf);
    for (let i = 0; i < nLine; i++) {
      pass.setBindGroup(1, this.lineBG, [SLOT * i]);
      pass.draw(this.circleVerts);
    }

    pass.setPipeline(this.pointPipe);
    for (let i = 0; i < nGrp; i++) {
      const g = this.pointGroups[frame.groups[i].index];
      pass.setBindGroup(1, this.groupBG, [SLOT * i]);
      pass.setVertexBuffer(0, g.buf);
      pass.draw(6, g.count);
    }

    pass.end();
    q.submit([enc.finish()]);
  }

  private makeGeometry(verts: F32, indices: Uint32Array<ArrayBuffer>): Geometry {
    const vbuf = this.device.createBuffer({
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    const ibuf = this.device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vbuf, 0, verts);
    this.device.queue.writeBuffer(ibuf, 0, indices);
    return { vbuf, ibuf, indexCount: indices.length };
  }

  private buildGeometries(): void {
    // Unit sphere (radius 1), positions double as normals.
    {
      const W = 96,
        H = 64;
      const verts: number[] = [];
      const idx: number[] = [];
      for (let y = 0; y <= H; y++) {
        const phi = (y / H) * Math.PI;
        for (let x = 0; x <= W; x++) {
          const th = (x / W) * Math.PI * 2;
          const nx = Math.sin(phi) * Math.cos(th);
          const ny = Math.cos(phi);
          const nz = Math.sin(phi) * Math.sin(th);
          verts.push(nx, ny, nz, nx, ny, nz);
        }
      }
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const a = y * (W + 1) + x,
            b = a + W + 1;
          idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
      this.geoms.set('sphere', this.makeGeometry(new Float32Array(verts), new Uint32Array(idx)));
    }
    // Unit box (half-extent 1).
    {
      const faces: [number[], number[]][] = [
        [
          [0, 0, 1],
          [1, 0, 0],
        ],
        [
          [0, 0, -1],
          [-1, 0, 0],
        ],
        [
          [1, 0, 0],
          [0, 0, -1],
        ],
        [
          [-1, 0, 0],
          [0, 0, 1],
        ],
        [
          [0, 1, 0],
          [1, 0, 0],
        ],
        [
          [0, -1, 0],
          [-1, 0, 0],
        ],
      ];
      const verts: number[] = [];
      const idx: number[] = [];
      faces.forEach(([n, t], f) => {
        const b = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
        for (const [su, sv] of [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ] as const) {
          verts.push(
            n[0] + t[0] * su + b[0] * sv,
            n[1] + t[1] * su + b[1] * sv,
            n[2] + t[2] * su + b[2] * sv,
            n[0],
            n[1],
            n[2],
          );
        }
        const o = f * 4;
        idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
      });
      this.geoms.set('box', this.makeGeometry(new Float32Array(verts), new Uint32Array(idx)));
    }
    // Unit disk in XZ, +Y normal, radial rings dense near the center so
    // per-vertex log depth interpolates well when the camera stands on it.
    {
      const SEG = 96,
        RINGS = 40;
      const verts: number[] = [0, 0, 0, 0, 1, 0];
      const idx: number[] = [];
      for (let r = 1; r <= RINGS; r++) {
        const rad = Math.pow(r / RINGS, 3); // cubic spacing: dense center
        for (let s = 0; s < SEG; s++) {
          const th = (s / SEG) * Math.PI * 2;
          verts.push(Math.cos(th) * rad, 0, Math.sin(th) * rad, 0, 1, 0);
        }
      }
      const ring = (r: number, s: number) => 1 + (r - 1) * SEG + (s % SEG);
      for (let s = 0; s < SEG; s++) idx.push(0, ring(1, s + 1), ring(1, s));
      for (let r = 1; r < RINGS; r++) {
        for (let s = 0; s < SEG; s++) {
          const a = ring(r, s),
            b = ring(r, s + 1),
            c = ring(r + 1, s),
            d = ring(r + 1, s + 1);
          idx.push(a, b, c, b, d, c);
        }
      }
      this.geoms.set('disk', this.makeGeometry(new Float32Array(verts), new Uint32Array(idx)));
    }
  }

  private buildCircle(): void {
    const N = 512;
    const v = new Float32Array((N + 1) * 2);
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * Math.PI * 2;
      v[i * 2] = Math.cos(th);
      v[i * 2 + 1] = Math.sin(th);
    }
    this.circleVerts = N + 1;
    this.circleBuf = this.device.createBuffer({
      size: v.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.circleBuf, 0, v);
  }
}
