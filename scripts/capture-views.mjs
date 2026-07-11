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
      else if (m.text().startsWith('[webgpu]')) console.log(`  ${m.text()}`);
    });
    return p;
  };
  let page = await mkPage();

  for (const v of VIEWS) {
    const url = `http://localhost:${PORT}/?${v.q}&at=${AT}&paused=1&stars=athyg&fps=1`;
    // Heavy view loads occasionally wedge a tab on SwiftShader; one retry
    // on a fresh page absorbs the flake without hiding real failures.
    try {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });
    } catch (e) {
      console.error(`  goto ${v.name} failed (${e.message}) — retrying on a fresh page`);
      await page.close().catch(() => {});
      page = await mkPage();
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });
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
  await browser.close();
  server.kill();
}

if (failed) {
  console.error(`${failed} view(s) failed to render`);
  process.exit(1);
}
console.log(`captured ${VIEWS.length} views → ${outDir}/`);
