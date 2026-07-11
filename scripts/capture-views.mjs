// Captures the visual-regression view set as PNGs from a real headless
// Chrome running the built app (dist/ via `vite preview`). Works on
// GPU-less CI runners: set WEBGPU_CI=1 and Chrome runs its normal Vulkan
// path on Mesa lavapipe (CPU-rasterized Vulkan; install
// mesa-vulkan-drivers first).
//
// Every view pins the whole scene to one instant (?at= + ?paused=1) and
// forces the bundled star catalog (?stars=athyg) so nothing external is
// fetched — the same commit always draws the same pixels.
//
//   node scripts/capture-views.mjs [outDir]        (default visual-out)
//   CHROME_PATH=...  chrome binary (default: the macOS app path)
//   WEBGPU_CI=1  adds the GPU-less-runner flags (Vulkan/lavapipe)
//
// A capture fails loudly if the canvas never varies (a dead render pass
// composites as uniform black — the exact failure this net exists to catch).

import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const W = 800;
const H = 500;
const PORT = parseInt(process.env.PREVIEW_PORT ?? '5209', 10);
const AT = '2026-01-01T12:00:00Z'; // the frozen instant every view shares

// The regression views: one per rendering subsystem. Keep names stable —
// they are the baseline filenames in tests/visual/baseline/.
const VIEWS = [
  // 2MRS galaxies + cosmic web at gigaparsec scale
  { name: 'galaxies', q: 'goto=sun&dist=1e24' },
  // stellar neighborhood: bundled ATHYG tiles, proper-motion pipeline
  { name: 'stars', q: 'goto=sun&dist=2e17' },
  // inner system: Kepler orbit lines, 40k GPU-solved small bodies, Trojans
  { name: 'solar', q: 'goto=sun&dist=1.4e12&pitch=-40' },
  // outer system: Kuiper belt, outer planet ellipses
  { name: 'outer', q: 'goto=sun&dist=1.1e13&pitch=-40' },
  // alpha-to-coverage rings, near-edge-on 2026 geometry
  { name: 'saturn', q: 'goto=saturn&dist=6e8' },
  // textured Earth globe + atmosphere-less limb + axis line
  { name: 'earth', q: 'goto=earth&dist=5e7' },
  // LROC WAC global texture (matId 10)
  { name: 'moon', q: 'goto=moon&dist=1.2e7' },
  // Viking global mosaic
  { name: 'mars', q: 'goto=mars&dist=2.5e7' },
];

const outDir = process.argv[2] ?? 'visual-out'; // NOT dot-prefixed: upload-artifact drops hidden paths
mkdirSync(outDir, { recursive: true });

// A blank page served from dist/ for the readback probe — about:blank has
// no navigator.gpu, and every other path SPA-falls-back to the app.
writeFileSync('dist/__probe.html', '<!doctype html><meta charset="utf-8" /><title>probe</title>');

// ---- serve dist/ ----
// detached: npx wraps vite in a child; killing the process GROUP is the
// only way the server actually dies (an orphaned vite holding stdout kept
// the CI step alive forever after a fully successful capture).
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'inherit'],
  detached: true,
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite preview did not start')), 20000);
  server.stdout.on('data', (d) => {
    if (String(d).includes(String(PORT))) {
      clearTimeout(t);
      resolve();
    }
  });
  server.on('exit', () => reject(new Error('vite preview exited — is dist/ built and the port free?')));
});

// ---- launch chrome ----
// WEBGPU_CI=1 targets GPU-less runners with Mesa lavapipe (a real, software
// Vulkan driver — `apt-get install mesa-vulkan-drivers`). Chrome's fallback
// `--use-webgpu-adapter=swiftshader` is a dead end in stable: the canvas
// never composites AND mapAsync rejects ("valid external Instance reference
// no longer exists"), so no readback path exists. With lavapipe, Dawn,
// ANGLE, and the compositor share one ordinary Vulkan device.
const ci = process.env.WEBGPU_CI;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--hide-scrollbars',
    `--window-size=${W},${H}`,
    ...(ci
      ? [
          '--no-sandbox',
          '--use-angle=vulkan',
          '--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE',
          '--disable-vulkan-surface',
        ]
      : []),
  ],
  defaultViewport: { width: W, height: H },
});

let failed = 0;
try {
  const mkPage = async () => {
    const p = await browser.newPage();
    p.on('pageerror', (e) => console.error(`  pageerror: ${e.message}`));
    // WebGPU validation failures land on the console, not as exceptions.
    p.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.error(`  console.${m.type()}: ${m.text()}`);
      else if (m.text().startsWith('[webgpu]') || m.text().startsWith('[snap]')) console.log(`  ${m.text()}`);
    });
    // Localhost only: the Moon/Mars views trigger Trek WMTS imagery streams,
    // and waiting on trek.nasa.gov from a CI runner is both nondeterministic
    // (tiles must never land in a regression frame) and the source of the
    // networkidle timeouts that flaked earlier runs.
    await p.setRequestInterception(true);
    p.on('request', (r) => {
      const host = new URL(r.url()).hostname;
      if (host === 'localhost' || host === '127.0.0.1') void r.continue();
      else void r.abort();
    });
    return p;
  };
  let page = await mkPage();

  // Staged WebGPU readback probes on a blank page, escalating from a tiny
  // clear-copy-map to the app's exact render shape (full-size bgra8unorm,
  // 4×MSAA + depth, resolve into a COPY_SRC texture). The first stage that
  // hangs or errors names the primitive the runner's driver can't do.
  await page.goto(`http://localhost:${PORT}/__probe.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const probe = await page.evaluate(async () => {
    try {
      if (!navigator.gpu) return 'no navigator.gpu';
      const a = await navigator.gpu.requestAdapter();
      if (!a) return 'no adapter';
      const d = await a.requestDevice();
      const stages = [
        { name: 'tiny-rgba', w: 4, h: 4, format: 'rgba8unorm', msaa: false },
        { name: 'full-rgba', w: 800, h: 500, format: 'rgba8unorm', msaa: false },
        { name: 'full-bgra', w: 800, h: 500, format: 'bgra8unorm', msaa: false },
        { name: 'full-bgra-msaa-depth-resolve', w: 800, h: 500, format: 'bgra8unorm', msaa: true },
      ];
      const results = [];
      for (const s of stages) {
        const target = d.createTexture({
          size: [s.w, s.h],
          format: s.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        const att = {
          loadOp: 'clear',
          storeOp: s.msaa ? 'discard' : 'store',
          clearValue: { r: 1, g: 0.5, b: 0.25, a: 1 },
        };
        const enc = d.createCommandEncoder();
        if (s.msaa) {
          const ms = d.createTexture({
            size: [s.w, s.h],
            sampleCount: 4,
            format: s.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          });
          const depth = d.createTexture({
            size: [s.w, s.h],
            sampleCount: 4,
            format: 'depth32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          });
          enc
            .beginRenderPass({
              colorAttachments: [{ ...att, view: ms.createView(), resolveTarget: target.createView() }],
              depthStencilAttachment: {
                view: depth.createView(),
                depthClearValue: 1,
                depthLoadOp: 'clear',
                depthStoreOp: 'discard',
              },
            })
            .end();
        } else {
          enc.beginRenderPass({ colorAttachments: [{ ...att, view: target.createView() }] }).end();
        }
        const rowBytes = Math.ceil((s.w * 4) / 256) * 256;
        const buf = d.createBuffer({ size: rowBytes * s.h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: rowBytes }, [s.w, s.h]);
        d.queue.submit([enc.finish()]);
        const out = await Promise.race([
          buf.mapAsync(GPUMapMode.READ).then(() => {
            const px = new Uint8Array(buf.getMappedRange());
            return `ok ${px[0]},${px[1]},${px[2]},${px[3]}`;
          }),
          new Promise((r) => setTimeout(() => r('HANG'), 15000)),
        ]).catch((e) => `error: ${e.message}`);
        results.push(`${s.name}: ${out}`);
        if (out === 'HANG') break; // the device is wedged; later stages are noise
      }
      return results.join(' | ');
    } catch (e) {
      return `error: ${e.message}`;
    }
  });
  console.log(`WebGPU readback probes: ${probe}`);
  // Fresh page for the views — software stacks are stingy with adapters.
  await page.close().catch(() => {});
  page = await mkPage();

  // Pipeline self-test: the app boots with ?norender=1 (nothing touches the
  // queue), then draws one tiny primitive per pipeline. The first HANG
  // names the shader the driver can't execute.
  await page.goto(`http://localhost:${PORT}/?goto=sun&dist=1.4e12&at=${AT}&paused=1&norender=1&stars=athyg`, {
    waitUntil: 'networkidle0',
    timeout: 90000,
  });
  await new Promise((r) => setTimeout(r, 3000)); // let point groups upload
  const selfTest = await page.evaluate(() => window.__gpuSelfTest());
  console.log(`Pipeline self-test: ${selfTest}`);
  await page.close().catch(() => {});
  page = await mkPage();
  if (selfTest.includes('HANG')) {
    console.error('a pipeline hangs this driver — skipping view captures');
    failed = VIEWS.length;
  }

  // ONLY=<name> captures a single view — the fast lane when iterating on a
  // CI-only failure. In CI mode the app runs with ?norender=1: presenting
  // to the swap chain is the one operation software Vulkan never finishes,
  // so the snapshot's offscreen render must be the ONLY work on the queue.
  const views = process.env.ONLY ? VIEWS.filter((v) => v.name === process.env.ONLY) : VIEWS;
  const noRender = ci || process.env.NORENDER;
  for (const v of failed ? [] : views) {
    const url = `http://localhost:${PORT}/?${v.q}&at=${AT}&paused=1&stars=athyg&fps=1${noRender ? '&norender=1' : ''}`;
    // Heavy view loads occasionally wedge a tab on a software rasterizer;
    // one retry on a fresh page absorbs the flake without hiding real
    // failures — and a view that fails twice fails ALONE, not the whole run.
    try {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });
    } catch (e) {
      console.error(`  goto ${v.name} failed (${e.message}) — retrying on a fresh page`);
      await page.close().catch(() => {});
      page = await mkPage();
      try {
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });
      } catch (e2) {
        failed++;
        console.error(`✗ ${v.name}: navigation failed twice (${e2.message})`);
        await page.close().catch(() => {});
        page = await mkPage();
        continue;
      }
    }
    // Hide every DOM overlay (HUD, labels): the diff should see only GPU
    // pixels — text rendering varies across runner images and star-count
    // readouts vary with load timing.
    await page.addStyleTag({ content: 'body > *:not(#gpu) { visibility: hidden !important; }' });
    // ?fps=1 writes `fps N · Nk stars` to the title once frames flow.
    let title = '';
    for (let i = 0; i < 60 && !/fps \d/.test(title); i++) {
      await new Promise((r) => setTimeout(r, 500));
      title = await page.title();
    }
    // Let late texture uploads and star chunks land, then read the frame
    // back through the app's __snap hook — a WebGPU copyTextureToBuffer in
    // the render loop, encoded before present. Every canvas-side readback
    // (CDP screenshot, toBlob, even same-task toBlob) is opaque black under
    // SwiftShader; the API readback is the one path that sees real pixels.
    // The race guards against a dead frame loop.
    await new Promise((r) => setTimeout(r, 3000));
    let dataUrl = '';
    try {
      dataUrl = await page.evaluate(() =>
        Promise.race([window.__snap(), new Promise((r) => setTimeout(() => r(''), 60000))]),
      );
    } catch (e) {
      console.error(`  __snap evaluate threw: ${e.message}`); // tab crash/reload
    }
    if (!dataUrl) {
      failed++;
      writeFileSync(`${outDir}/debug-${v.name}-compositor.png`, await page.screenshot({ type: 'png' }));
      const fatal = await page.evaluate(() => document.querySelector('#fatal')?.textContent ?? '');
      console.error(`✗ ${v.name}: empty snapshot — title "${title}"${fatal ? ` fatal "${fatal}"` : ''}`);
      continue;
    }
    const shot = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

    const png = PNG.sync.read(Buffer.from(shot));
    const first = png.data.readUInt32BE(0);
    let uniform = true;
    for (let o = 4; uniform && o < png.data.length; o += 4) uniform = png.data.readUInt32BE(o) === first;
    writeFileSync(`${outDir}/${v.name}.png`, shot);
    if (uniform || !/fps \d/.test(title)) {
      failed++;
      // Debug evidence: what the compositor sees (vs the canvas readback).
      writeFileSync(`${outDir}/debug-${v.name}-compositor.png`, await page.screenshot({ type: 'png' }));
      const px = [png.data[0], png.data[1], png.data[2], png.data[3]].join(',');
      const fatal = await page.evaluate(() => document.querySelector('#fatal')?.textContent ?? '');
      console.error(
        `✗ ${v.name}: ${uniform ? `uniform canvas rgba(${px})` : 'no frames'} — title "${title}"${fatal ? ` fatal "${fatal}"` : ''}`,
      );
    } else {
      console.log(`✓ ${v.name}  (${title})`);
    }
  }
} finally {
  // A wedged GPU process can make Chrome refuse a graceful close; don't
  // let cleanup outlive the work it's cleaning up after.
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 10000))]);
  browser.process()?.kill('SIGKILL');
  try {
    process.kill(-server.pid, 'SIGKILL');
  } catch {
    server.kill('SIGKILL');
  }
}

if (failed) {
  console.error(`${failed} view(s) failed to render`);
  process.exit(1);
}
console.log(`captured ${VIEWS.length} views → ${outDir}/`);
process.exit(0); // lingering watchdog timers must not keep the step alive
