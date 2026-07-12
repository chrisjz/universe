// Thin WebGPU renderer: three pipelines (lit meshes, additive point sprites,
// additive orbit lines) sharing a globals uniform and a per-draw dynamic
// uniform buffer. 4x MSAA, float32 log depth.

import { MESH_WGSL, pointsWgsl, PointsMode, LINES_WGSL, SKY_WGSL, atmoWgsl, DOME_WGSL } from './shaders';
import { mat4Mul, mat4Perspective, V3 } from './math';

export type MeshKind = string; // 'sphere' | 'box' | 'disk' built in; more via addGeometry()

export type F32 = Float32Array<ArrayBuffer>;

export interface FrameData {
  globals: F32; // 28 floats
  // tex: 'earth' -> the day/night pair; other keys -> textures registered via
  // addTexture (draw is skipped until the texture has landed).
  meshes: { kind: MeshKind; data: F32; tex?: string }[]; // 28 floats each
  lines: F32[]; // 8 floats each
  groups: { index: number; data: F32 }[]; // 4 floats each
  sky?: F32 | null; // 8 floats: constellation-dome origin rel camera, radius, color, alpha
  atmo?: F32 | null; // 8 floats: planet center rel camera + ground R, sun dir + top R
  farDome?: number; // baked far-field intensity (0 = draw nothing)
}

const SLOT = 256; // dynamic uniform offset alignment
const MAX_DRAWS = 256; // the cellulose chain alone is ~90 spheres

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
  private pointMovePipe!: GPURenderPipeline;
  private pointOrbitPipe!: GPURenderPipeline;
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
  private pointGroups: { buf: GPUBuffer; count: number; mode: PointsMode }[] = [];
  private circleBuf!: GPUBuffer;
  private skyPipe!: GPURenderPipeline;
  private atmoPipe!: GPURenderPipeline;
  private atmoUBO!: GPUBuffer;
  private atmoBG!: GPUBindGroup;
  // Far-field bake: faint star bands accumulate into a fp16 cubemap once,
  // then draw as a single dome (see bakeFarFace / DOME_WGSL).
  private farTex: GPUTexture | null = null;
  private farFaceViews: GPUTextureView[] = [];
  private farSize = 0;
  private bakeMovePipe!: GPURenderPipeline;
  private bakeGlobals!: GPUBuffer;
  private bakeGlobalsBG!: GPUBindGroup;
  private bakeGrpBG!: GPUBindGroup;
  private bakeGrp!: GPUBuffer;
  private domePipe!: GPURenderPipeline;
  private domeBGL!: GPUBindGroupLayout;
  private domeBG: GPUBindGroup | null = null;
  private domeUBO!: GPUBuffer;
  private domeSampler!: GPUSampler;
  private skyBuf: GPUBuffer | null = null;
  private skyVerts = 0;
  private circleVerts = 0;

  private depthTex: GPUTexture | null = null;
  private msaaTex: GPUTexture | null = null;

  private texBGL!: GPUBindGroupLayout;
  private sampler!: GPUSampler;
  private defaultTexBG!: GPUBindGroup;
  private earthTexBG!: GPUBindGroup;

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
    void this.device.lost.then((info) => {
      console.error('[webgpu] device lost:', info.reason, info.message);
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
    const texBGL = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    this.texBGL = texBGL;
    const layout = d.createPipelineLayout({ bindGroupLayouts: [globalsBGL, dynBGL] });
    const meshLayout = d.createPipelineLayout({ bindGroupLayouts: [globalsBGL, dynBGL, texBGL] });

    this.globalsBG = d.createBindGroup({
      layout: globalsBGL,
      entries: [{ binding: 0, resource: { buffer: this.globalsBuf } }],
    });
    const mkDyn = (buf: GPUBuffer, size: number) =>
      d.createBindGroup({ layout: dynBGL, entries: [{ binding: 0, resource: { buffer: buf, size } }] });
    this.meshBG = mkDyn(this.meshUBO, 112);
    this.lineBG = mkDyn(this.lineUBO, 64);
    this.groupBG = mkDyn(this.groupUBO, 48); // Grp: origin + misc + tint

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

    // Textures: a 1x1 fallback pair (used by every untextured material) and
    // the Earth day/night pair, swapped in when the fetches land.
    this.sampler = d.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
    });
    const onePx = (rgba: [number, number, number, number]) => {
      const t = d.createTexture({
        size: [1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      d.queue.writeTexture({ texture: t }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1]);
      return t;
    };
    this.defaultTexBG = d.createBindGroup({
      layout: texBGL,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: onePx([255, 255, 255, 255]).createView() },
        { binding: 2, resource: onePx([0, 0, 0, 255]).createView() },
      ],
    });
    this.earthTexBG = this.defaultTexBG;

    const meshMod = d.createShaderModule({ code: MESH_WGSL });
    this.meshPipe = d.createRenderPipeline({
      layout: meshLayout,
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
      // Alpha-to-coverage: Saturn's translucent rings dither their alpha
      // into the 4x MSAA mask — order-independent, no blend pipeline needed.
      // Every other material writes alpha 1 (full coverage), so this is free.
      multisample: { count: 4, alphaToCoverageEnabled: true },
    });

    const pointMod = d.createShaderModule({ code: pointsWgsl('static') });
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
    // Moving stars: same sprite, plus a per-instance 3D space velocity
    // applied in the vertex shader (pos + vel · years-from-J2000).
    const pointMoveMod = d.createShaderModule({ code: pointsWgsl('moving') });
    this.pointMovePipe = d.createRenderPipeline({
      layout,
      vertex: {
        module: pointMoveMod,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 44,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32' },
              { shaderLocation: 2, offset: 16, format: 'float32x3' },
              { shaderLocation: 3, offset: 28, format: 'float32' },
              { shaderLocation: 4, offset: 32, format: 'float32x3' },
            ],
          },
        ],
      },
      fragment: { module: pointMoveMod, entryPoint: 'fs', targets: [{ format: this.format, blend: additive }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: depthNoWrite,
      multisample: { count: 4 },
    });

    // Small bodies: Kepler's equation solved per instance in the vertex
    // shader — the whole asteroid belt orbits with zero CPU involvement.
    const pointOrbitMod = d.createShaderModule({ code: pointsWgsl('orbital') });
    this.pointOrbitPipe = d.createRenderPipeline({
      layout,
      vertex: {
        module: pointOrbitMod,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 40,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
              { shaderLocation: 2, offset: 24, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: { module: pointOrbitMod, entryPoint: 'fs', targets: [{ format: this.format, blend: additive }] },
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

    // Sky lines (constellation figures): free 3D line-list segments on the
    // celestial sphere, sharing the line shader's uniform slot layout.
    const skyMod = d.createShaderModule({ code: SKY_WGSL });
    this.skyPipe = d.createRenderPipeline({
      layout,
      vertex: {
        module: skyMod,
        entryPoint: 'vs',
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
      },
      fragment: { module: skyMod, entryPoint: 'fs', targets: [{ format: this.format, blend: additive }] },
      primitive: { topology: 'line-list' },
      depthStencil: depthNoWrite,
      multisample: { count: 4 },
    });

    // The atmosphere shell: back faces of a unit sphere, ray-marched single
    // scattering. Premultiplied blend — in-scatter adds, and everything
    // behind (stars, the sun, the surface) attenuates by transmittance.
    this.atmoUBO = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.atmoBG = d.createBindGroup({
      layout: globalsBGL,
      entries: [{ binding: 0, resource: { buffer: this.atmoUBO } }],
    });
    // Atmosphere quality tier: phones get half the view samples and half
    // the light march (jittered — dither hides the banding); desktops keep
    // the full integral. ?atmoq=low|high overrides for testing.
    const atmoQ = new URLSearchParams(location.search).get('atmoq');
    const coarseAtmo =
      atmoQ === 'low' ||
      (atmoQ !== 'high' && navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) < 900);
    const atmoMod = d.createShaderModule({ code: atmoWgsl(coarseAtmo ? 12 : 16, coarseAtmo ? 3 : 6, false) });
    this.atmoPipe = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [globalsBGL, globalsBGL] }),
      vertex: {
        module: atmoMod,
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
      fragment: {
        module: atmoMod,
        entryPoint: 'fs',
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      // Cull so exactly ONE shell surface survives per view ray — the near
      // hemisphere from outside (same disc + limb; the integral only uses
      // the ray direction) and the whole bowl from inside. The opposite
      // mode culls the entire shell when the camera stands on the ground.
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: depthNoWrite,
      multisample: { count: 4 },
    });

    // ---- far-field bake pipeline: the moving-star sprites, rendered into
    // an fp16 cube face instead of the swapchain (no depth, no MSAA — pure
    // additive accumulation; quantization-free, unlike the 8-bit canvas).
    this.bakeGlobals = d.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bakeGlobalsBG = d.createBindGroup({
      layout: globalsBGL,
      entries: [{ binding: 0, resource: { buffer: this.bakeGlobals } }],
    });
    const bakeGrp = d.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bakeGrp = bakeGrp;
    this.bakeGrpBG = mkDyn(bakeGrp, 48);
    this.bakeMovePipe = d.createRenderPipeline({
      layout,
      vertex: {
        module: pointMoveMod,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 44,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32' },
              { shaderLocation: 2, offset: 16, format: 'float32x3' },
              { shaderLocation: 3, offset: 28, format: 'float32' },
              { shaderLocation: 4, offset: 32, format: 'float32x3' },
            ],
          },
        ],
      },
      fragment: { module: pointMoveMod, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend: additive }] },
      primitive: { topology: 'triangle-list' },
    });

    // ---- the dome that plays the bake back ----
    this.domeUBO = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.domeSampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.domeBGL = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
      ],
    });
    const domeMod = d.createShaderModule({ code: DOME_WGSL });
    this.domePipe = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [globalsBGL, this.domeBGL] }),
      vertex: {
        module: domeMod,
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
      fragment: { module: domeMod, entryPoint: 'fs', targets: [{ format: this.format, blend: additive }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthNoWrite,
      multisample: { count: 4 },
    });

    this.buildGeometries();
    this.buildCircle();
  }

  // Upload the constellation line-list (unit directions on the sky).
  setSkyLines(verts: F32): void {
    this.skyBuf = this.device.createBuffer({
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.skyBuf, 0, verts);
    this.skyVerts = verts.length / 3;
  }

  // 'static' groups carry 8 floats per instance, 'moving' 11 (…, vel3),
  // 'orbital' 10 (ellipse axes A/B + e, M0, n, H — Kepler solved in-shader).
  addPointGroup(instances: F32, mode: PointsMode = 'static'): number {
    const buf = this.device.createBuffer({
      size: instances.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buf, 0, instances);
    const stride = mode === 'moving' ? 11 : mode === 'orbital' ? 10 : 8;
    this.pointGroups.push({ buf, count: instances.length / stride, mode });
    return this.pointGroups.length - 1;
  }

  // Re-upload a point group whose instances move (e.g. planet locator sprites).
  updatePointGroup(index: number, instances: F32): void {
    this.device.queue.writeBuffer(this.pointGroups[index].buf, 0, instances);
  }

  // Register a named geometry (interleaved pos3+normal3 vertices).
  addGeometry(name: string, verts: F32, indices: Uint32Array<ArrayBuffer>): void {
    this.geoms.set(name, this.makeGeometry(verts, indices));
  }

  // Register a single-image texture. The night slot carries the global
  // Black Marble (city lights for the imagery rings) once it has loaded.
  private texBGs = new Map<string, GPUBindGroup>();
  private dayViews = new Map<string, GPUTextureView>();
  private dayTextures = new Map<string, GPUTexture>();
  private nightView: GPUTextureView | null = null;
  private blackView: GPUTextureView | null = null;
  hasTexture(key: string): boolean {
    return this.texBGs.has(key);
  }
  // Evict a registered texture (free-roam re-anchoring streams a fresh set
  // per site; without eviction each visited site would pin ~30 MB of VRAM).
  dropTexture(key: string): void {
    this.dayTextures.get(key)?.destroy();
    this.dayTextures.delete(key);
    this.dayViews.delete(key);
    this.texBGs.delete(key);
  }
  // Renders one frame into a private offscreen texture and reads it back
  // through the WebGPU API — never touching the canvas swap chain. On the
  // software Vulkan stacks CI runs on, the canvas image is unreachable
  // (screenshots, toBlob and even copies from the canvas texture all fail),
  // so regression captures must come from a texture the renderer owns.
  private captureView: GPUTextureView | null = null;
  snapshot(renderAgain: () => void): Promise<ImageData> {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const tex = this.device.createTexture({
      size: [w, h],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.captureView = tex.createView();
    renderAgain();
    this.captureView = null;
    const rowBytes = Math.ceil((w * 4) / 256) * 256;
    const buf = this.device.createBuffer({
      size: rowBytes * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: rowBytes }, [w, h]);
    this.device.queue.submit([enc.finish()]);
    console.log('[snap] submitted');
    void this.device.queue.onSubmittedWorkDone().then(() => console.log('[snap] work done'));
    return buf.mapAsync(GPUMapMode.READ).then(() => {
      console.log('[snap] mapped');
      const src = new Uint8Array(buf.getMappedRange());
      const out = new Uint8ClampedArray(w * h * 4);
      const b = this.format === 'bgra8unorm' ? 2 : 0; // swizzle to RGBA
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const si = y * rowBytes + x * 4;
          const di = (y * w + x) * 4;
          out[di] = src[si + b];
          out[di + 1] = src[si + 1];
          out[di + 2] = src[si + (2 - b)];
          out[di + 3] = 255;
        }
      }
      buf.unmap();
      buf.destroy();
      tex.destroy();
      return new ImageData(out, w, h);
    });
  }

  // SwiftShader (the CPU rasterizer CI runs on) can't blit an ImageBitmap
  // straight into a texture — copyExternalImageToTexture wants a GPU-backed
  // image. Fall back to a 2D-canvas readback and a plain writeTexture.
  private uploadBitmap(bmp: ImageBitmap, tex: GPUTexture, level: number, w: number, h: number): void {
    try {
      this.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex, mipLevel: level }, [w, h]);
    } catch {
      const cv = new OffscreenCanvas(w, h);
      const ctx = cv.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      this.device.queue.writeTexture({ texture: tex, mipLevel: level }, data, { bytesPerRow: w * 4 }, [w, h]);
    }
  }
  async addTexture(key: string, bmp: ImageBitmap): Promise<void> {
    const d = this.device;
    const mips = Math.floor(Math.log2(Math.max(bmp.width, bmp.height))) + 1;
    const tex = d.createTexture({
      size: [bmp.width, bmp.height],
      format: 'rgba8unorm',
      mipLevelCount: mips,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    for (let level = 0; level < mips; level++) {
      const w = Math.max(1, bmp.width >> level);
      const h = Math.max(1, bmp.height >> level);
      const m =
        level === 0 ? bmp : await createImageBitmap(bmp, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      this.uploadBitmap(m, tex, level, w, h);
      if (level > 0) m.close();
    }
    if (!this.blackView) {
      const black = d.createTexture({
        size: [1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      d.queue.writeTexture({ texture: black }, new Uint8Array([0, 0, 0, 255]), { bytesPerRow: 4 }, [1, 1]);
      this.blackView = black.createView();
    }
    const view = tex.createView();
    this.dayTextures.get(key)?.destroy(); // replacing an existing key
    this.dayTextures.set(key, tex);
    this.dayViews.set(key, view);
    this.texBGs.set(
      key,
      d.createBindGroup({
        layout: this.texBGL,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: view },
          { binding: 2, resource: this.nightView ?? this.blackView },
        ],
      }),
    );
  }

  // Once the Black Marble lands, rebind it into every registered texture so
  // imagery rings glow with real city lights at night (load-order safe).
  private setNightView(view: GPUTextureView): void {
    this.nightView = view;
    for (const [key, day] of this.dayViews) {
      this.texBGs.set(
        key,
        this.device.createBindGroup({
          layout: this.texBGL,
          entries: [
            { binding: 0, resource: this.sampler },
            { binding: 1, resource: day },
            { binding: 2, resource: view },
          ],
        }),
      );
    }
  }

  // Fetch the Earth day/night textures and swap them in when ready. Mip
  // levels are generated CPU-side via createImageBitmap resizing.
  async loadEarthTextures(dayUrl: string, nightUrl: string): Promise<void> {
    const load = async (url: string): Promise<GPUTexture | null> => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const blob = await res.blob();
        const full = await createImageBitmap(blob);
        const mips = Math.floor(Math.log2(Math.max(full.width, full.height))) + 1;
        const tex = this.device.createTexture({
          size: [full.width, full.height],
          format: 'rgba8unorm',
          mipLevelCount: mips,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        for (let level = 0; level < mips; level++) {
          const w = Math.max(1, full.width >> level);
          const h = Math.max(1, full.height >> level);
          const bmp =
            level === 0
              ? full
              : await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
          this.uploadBitmap(bmp, tex, level, w, h);
          if (level > 0) bmp.close();
        }
        full.close();
        return tex;
      } catch {
        return null;
      }
    };
    const [day, night] = await Promise.all([load(dayUrl), load(nightUrl)]);
    if (!day || !night) return; // keep the procedural fallback
    const nightView = night.createView();
    this.earthTexBG = this.device.createBindGroup({
      layout: this.texBGL,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: day.createView() },
        { binding: 2, resource: nightView },
      ],
    });
    this.setNightView(nightView);
    this.earthReady = true;
  }

  earthReady = false;

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

    const nLine = Math.min(frame.lines.length, MAX_DRAWS - 1);
    for (let i = 0; i < nLine; i++) this.lineStaging.set(frame.lines[i], (SLOT / 4) * i);
    // The constellation dome borrows the slot after the last orbit line.
    const drawSky = frame.sky && this.skyBuf ? 1 : 0;
    if (drawSky) this.lineStaging.set(frame.sky!, (SLOT / 4) * nLine);
    if (nLine + drawSky) q.writeBuffer(this.lineUBO, 0, this.lineStaging, 0, (SLOT / 4) * (nLine + drawSky));

    const nGrp = Math.min(frame.groups.length, MAX_DRAWS);
    for (let i = 0; i < nGrp; i++) this.groupStaging.set(frame.groups[i].data, (SLOT / 4) * i);
    if (nGrp) q.writeBuffer(this.groupUBO, 0, this.groupStaging, 0, (SLOT / 4) * nGrp);
    if (frame.atmo) q.writeBuffer(this.atmoUBO, 0, frame.atmo);
    if (frame.farDome) q.writeBuffer(this.domeUBO, 0, new Float32Array([frame.farDome, 0, 0, 0]));

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.msaaTex.createView(),
          resolveTarget: this.captureView ?? this.ctx.getCurrentTexture().createView(),
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
      const tex = frame.meshes[i].tex;
      pass.setBindGroup(1, this.meshBG, [SLOT * i]);
      pass.setBindGroup(2, tex === 'earth' ? this.earthTexBG : (tex && this.texBGs.get(tex)) || this.defaultTexBG);
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

    if (drawSky) {
      pass.setPipeline(this.skyPipe);
      pass.setVertexBuffer(0, this.skyBuf);
      pass.setBindGroup(1, this.lineBG, [SLOT * nLine]);
      pass.draw(this.skyVerts);
    }

    // The baked far field: millions of faint stars as one additive dome.
    if (frame.farDome && this.domeBG) {
      const gd = this.geoms.get('sphere')!;
      pass.setPipeline(this.domePipe);
      pass.setBindGroup(1, this.domeBG);
      pass.setVertexBuffer(0, gd.vbuf);
      pass.setIndexBuffer(gd.ibuf, 'uint32');
      pass.drawIndexed(gd.indexCount);
    }

    let curMode: PointsMode | null = null;
    for (let i = 0; i < nGrp; i++) {
      const g = this.pointGroups[frame.groups[i].index];
      if (g.mode !== curMode) {
        curMode = g.mode;
        pass.setPipeline(
          g.mode === 'moving' ? this.pointMovePipe : g.mode === 'orbital' ? this.pointOrbitPipe : this.pointPipe,
        );
      }
      pass.setBindGroup(1, this.groupBG, [SLOT * i]);
      pass.setVertexBuffer(0, g.buf);
      pass.draw(6, g.count);
    }

    // Atmosphere last: its transmittance must attenuate everything already
    // drawn behind it — stars fade into the day sky, the sun dims and
    // reddens at the horizon, the surface hazes at the limb.
    if (frame.atmo) {
      const g = this.geoms.get('sphere')!;
      pass.setPipeline(this.atmoPipe);
      pass.setBindGroup(1, this.atmoBG);
      pass.setVertexBuffer(0, g.vbuf);
      pass.setIndexBuffer(g.ibuf, 'uint32');
      pass.drawIndexed(g.indexCount);
    }

    pass.end();
    q.submit([enc.finish()]);
  }

  // Diagnoses which pipeline a software Vulkan driver cannot execute: one
  // tiny offscreen draw per pipeline, each awaited with a timeout. The
  // first HANG names the shader whose compiled code the driver never
  // finishes — exposed as window.__gpuSelfTest for the CI capture rig.
  async selfTest(): Promise<string> {
    const results: string[] = [];
    const run = async (name: string, fn: ((pass: GPURenderPassEncoder) => void) | null): Promise<boolean> => {
      if (!fn) {
        results.push(`${name}: skip`);
        return true;
      }
      const mk = (fmt: GPUTextureFormat, samples: number): GPUTexture =>
        this.device.createTexture({
          size: [8, 8],
          sampleCount: samples,
          format: fmt,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
      const ms = mk(this.format, 4);
      const target = mk(this.format, 1);
      const depth = mk('depth32float', 4);
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: ms.createView(),
            resolveTarget: target.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'discard',
          },
        ],
        depthStencilAttachment: {
          view: depth.createView(),
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'discard',
        },
      });
      pass.setBindGroup(0, this.globalsBG);
      fn(pass);
      pass.end();
      this.device.queue.submit([enc.finish()]);
      const ok = await Promise.race([
        this.device.queue.onSubmittedWorkDone().then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 10000)),
      ]);
      results.push(`${name}: ${ok ? 'ok' : 'HANG'}`);
      ms.destroy();
      target.destroy();
      depth.destroy();
      return ok;
    };
    const geom = this.geoms.values().next().value;
    const pointTest = (mode: PointsMode, pipe: GPURenderPipeline): ((pass: GPURenderPassEncoder) => void) | null => {
      const g = this.pointGroups.find((pg) => pg.mode === mode);
      if (!g) return null;
      return (p) => {
        p.setPipeline(pipe);
        p.setBindGroup(1, this.groupBG, [0]);
        p.setVertexBuffer(0, g.buf);
        p.draw(6, 1);
      };
    };
    const tests: [string, ((pass: GPURenderPassEncoder) => void) | null][] = [
      ['clear', () => {}],
      [
        'mesh',
        geom
          ? (p) => {
              p.setPipeline(this.meshPipe);
              p.setBindGroup(1, this.meshBG, [0]);
              p.setBindGroup(2, this.defaultTexBG);
              p.setVertexBuffer(0, geom.vbuf);
              p.setIndexBuffer(geom.ibuf, 'uint32');
              p.drawIndexed(Math.min(6, geom.indexCount));
            }
          : null,
      ],
      [
        'line',
        (p) => {
          p.setPipeline(this.linePipe);
          p.setBindGroup(1, this.lineBG, [0]);
          p.setVertexBuffer(0, this.circleBuf);
          p.draw(Math.min(4, this.circleVerts));
        },
      ],
      [
        'sky',
        this.skyBuf
          ? (p) => {
              p.setPipeline(this.skyPipe);
              p.setBindGroup(1, this.lineBG, [0]);
              p.setVertexBuffer(0, this.skyBuf);
              p.draw(3);
            }
          : null,
      ],
      ['points-static', pointTest('static', this.pointPipe)],
      ['points-moving', pointTest('moving', this.pointMovePipe)],
      ['points-orbital', pointTest('orbital', this.pointOrbitPipe)],
    ];
    for (const [name, fn] of tests) {
      if (!(await run(name, fn))) break; // a hang wedges the queue for good
    }
    return results.join(' | ');
  }

  // ---- far-field bake ----
  // Renders the given point groups (moving-mode star tiles, sun-frame
  // positions) into one face of the fp16 cubemap, viewpoint at the sun.
  // Six calls — one per face, typically one per frame — complete a bake.
  bakeFarFace(face: number, starYears: number, indices: number[], origin: V3): void {
    const d = this.device;
    const size = 1024;
    if (!this.farTex || this.farSize !== size) {
      this.farTex?.destroy();
      this.farTex = d.createTexture({
        size: [size, size, 6],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.farSize = size;
      this.farFaceViews = Array.from({ length: 6 }, (_, i) =>
        this.farTex!.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }),
      );
      this.domeBG = d.createBindGroup({
        layout: this.domeBGL,
        entries: [
          { binding: 0, resource: { buffer: this.domeUBO } },
          { binding: 1, resource: this.domeSampler },
          { binding: 2, resource: this.farTex.createView({ dimension: 'cube' }) },
        ],
      });
    }
    // Face bases chosen so sampling the cube with a scene direction returns
    // exactly what was rendered toward that direction (WebGPU face layout).
    const FACES: [V3, V3, V3][] = [
      [
        [0, 0, -1],
        [0, 1, 0],
        [1, 0, 0],
      ], // +X
      [
        [0, 0, 1],
        [0, 1, 0],
        [-1, 0, 0],
      ], // -X
      [
        [1, 0, 0],
        [0, 0, -1],
        [0, 1, 0],
      ], // +Y
      [
        [1, 0, 0],
        [0, 0, 1],
        [0, -1, 0],
      ], // -Y
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ], // +Z
      [
        [-1, 0, 0],
        [0, 1, 0],
        [0, 0, -1],
      ], // -Z
    ];
    const [r, u, f] = FACES[face];
    const view = new Float32Array(16);
    view[0] = r[0];
    view[4] = r[1];
    view[8] = r[2];
    view[1] = u[0];
    view[5] = u[1];
    view[9] = u[2];
    view[2] = -f[0];
    view[6] = -f[1];
    view[10] = -f[2];
    view[15] = 1;
    const g = new Float32Array(32);
    g.set(mat4Mul(mat4Perspective(Math.PI / 2, 1, 0.1, 100), view), 0);
    g[16] = r[0];
    g[17] = r[1];
    g[18] = r[2];
    g[19] = 1; // log-depth reference
    g[20] = u[0];
    g[21] = u[1];
    g[22] = u[2];
    g[24] = 1e7; // scaled-space cap, matching the live pass
    g[25] = 1 / Math.log2(1 + 1e21);
    g[27] = 2 / size; // worldPerPixel at d=1 for a 90° face
    g[28] = starYears;
    d.queue.writeBuffer(this.bakeGlobals, 0, g);
    // Baked tiles live in the sun frame; the bake camera sits at `origin`
    // (the live camera's sun-frame position), so the tiles' group origin
    // relative to it is −origin. Fade 1, no near-fade, provenance 0.
    d.queue.writeBuffer(
      this.bakeGrp,
      0,
      new Float32Array([-origin[0], -origin[1], -origin[2], 1, 0, 0, 0, 0, 0, 0, 0, 0]),
    );
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: this.farFaceViews[face], clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
    });
    pass.setPipeline(this.bakeMovePipe);
    pass.setBindGroup(0, this.bakeGlobalsBG);
    pass.setBindGroup(1, this.bakeGrpBG, [0]);
    for (const idx of indices) {
      const grp = this.pointGroups[idx];
      if (grp.mode !== 'moving') continue;
      pass.setVertexBuffer(0, grp.buf);
      pass.draw(6, grp.count);
    }
    pass.end();
    d.queue.submit([enc.finish()]);
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
