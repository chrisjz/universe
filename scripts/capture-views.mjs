// Captures the visual-regression view set as PNGs from a real headless
// Chrome running the built app (dist/ via `vite preview`). Works on
// GPU-less CI runners: set WEBGPU_ADAPTER=swiftshader and Dawn rasterizes
// WebGPU on the CPU (SwiftShader Vulkan).
//
// Every view pins the whole scene to one instant (?at= + ?paused=1) and
// forces the bundled star catalog (?stars=athyg) so nothing external is
// fetched — the same commit always draws the same pixels.
//
//   node scripts/capture-views.mjs [outDir]        (default visual-out)
//   CHROME_PATH=...  chrome binary (default: the macOS app path)
//   WEBGPU_ADAPTER=swiftshader  adds the CPU-rasterizer flags for CI
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

// ---- serve dist/ ----
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'inherit'],
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
const swift = process.env.WEBGPU_ADAPTER;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--hide-scrollbars',
    `--window-size=${W},${H}`,
    // CI runners have no GPU and no user namespace guarantees. (Don't add
    // the DefaultANGLEVulkan/VulkanFromANGLE trio here: on the GPU-less
    // runner it kills adapter acquisition entirely.)
    ...(swift
      ? ['--no-sandbox', '--enable-features=Vulkan', '--disable-vulkan-surface', `--use-webgpu-adapter=${swift}`]
      : []),
  ],
  defaultViewport: { width: W, height: H },
});

let failed = 0;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(`  pageerror: ${e.message}`));
  // WebGPU validation failures land on the console, not as exceptions.
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.error(`  console.${m.type()}: ${m.text()}`);
  });

  // The spike's verdict, in the log: which adapter Chrome actually handed us.
  await page.goto(`http://localhost:${PORT}/?paused=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const adapter = await page.evaluate(async () => {
    if (!navigator.gpu) return 'no navigator.gpu';
    const a = await navigator.gpu.requestAdapter();
    if (!a) return 'requestAdapter() returned null';
    const i = a.info ?? {};
    return `${i.vendor ?? '?'} / ${i.architecture ?? '?'} / ${i.description ?? i.device ?? '?'}`;
  });
  console.log(`WebGPU adapter: ${adapter}`);

  for (const v of VIEWS) {
    const url = `http://localhost:${PORT}/?${v.q}&at=${AT}&paused=1&stars=athyg&fps=1`;
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });
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
    // back through the app's __snap hook — a same-task canvas.toBlob inside
    // the render loop. Post-present readback (CDP screenshot, plain toBlob)
    // returns opaque black under SwiftShader; this is the one path that
    // sees real pixels. The race guards against a dead frame loop.
    await new Promise((r) => setTimeout(r, 3000));
    const dataUrl = await page.evaluate(() =>
      Promise.race([window.__snap(), new Promise((r) => setTimeout(() => r(''), 60000))]),
    );
    if (!dataUrl) {
      failed++;
      writeFileSync(`${outDir}/debug-${v.name}-compositor.png`, await page.screenshot({ type: 'png' }));
      const fatal = await page.evaluate(() => document.querySelector('#fatal')?.textContent ?? '');
      console.error(`✗ ${v.name}: __snap never resolved — title "${title}"${fatal ? ` fatal "${fatal}"` : ''}`);
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
  await browser.close();
  server.kill();
}

if (failed) {
  console.error(`${failed} view(s) failed to render`);
  process.exit(1);
}
console.log(`captured ${VIEWS.length} views → ${outDir}/`);
