// Performance attribution: for each problem view, measure real-time fps
// with the full scene and with one system knocked out (?skip=), so each
// system's cost is its fps delta — measured, not guessed. Runs the system
// Chrome with a real GPU; drag views hold a continuous orbit gesture so
// interaction cost is included.
//
//   node scripts/perf-attrib.mjs            (all views, all knockouts)
//   ONLY=bigbang node scripts/perf-attrib.mjs
//   CHROME_PATH=... overrides the browser binary.

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';

const AT = new Date().toISOString(); // satellites want a live epoch
const VIEWS = [
  // name, query, drag (hold a continuous orbit during measurement)
  ['bigbang', 'goto=sun&years=-13.7e9&speed=3.15576e16', false],
  ['earth-approach', 'goto=surface&dist=2e5', false],
  [`picnic-sky-1h`, `goto=surface&dist=40&pitch=-6&at=${AT}&speed=3600`, false],
  ['solar-drag', 'goto=sun&dist=1.4e12&pitch=-40', true],
  ['sub-picnic', 'goto=weave', false],
  ['star-close', 'goto=miaplacidus', false],
  ['star-mesh', 'goto=betelgeuse', false],
];
const KNOCKOUTS = ['none', 'atmo', 'belt', 'sats', 'stars', 'web', 'galaxies', 'imagery', 'rescale'];

const server = spawn('npx', ['vite', 'preview', '--port', '5229', '--strictPort'], {
  stdio: ['ignore', 'pipe', 'inherit'],
  detached: true,
});
await new Promise((res, rej) => {
  server.stdout.on('data', (d) => String(d).includes('5229') && res());
  setTimeout(rej, 15000);
});
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--window-size=1280,800'],
  defaultViewport: { width: 1280, height: 800 },
});

const views = process.env.ONLY ? VIEWS.filter((v) => v[0] === process.env.ONLY) : VIEWS;
const table = {};
for (const [name, q, drag] of views) {
  table[name] = {};
  for (const skip of KNOCKOUTS) {
    const page = await browser.newPage();
    const url = `http://localhost:5229/?${q}&fps=1${skip === 'none' ? '' : `&skip=${skip}`}`;
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });
    await new Promise((r) => setTimeout(r, 4000)); // streams settle
    let dragging = false;
    let dragDone = Promise.resolve();
    if (drag) {
      dragging = true;
      dragDone = (async () => {
        // a slow continuous orbit, re-issued while measuring
        try {
          while (dragging) {
            await page.mouse.move(400, 400);
            await page.mouse.down();
            for (let x = 400; x <= 880 && dragging; x += 16) {
              await page.mouse.move(x, 400);
              await new Promise((r) => setTimeout(r, 30));
            }
            await page.mouse.up();
          }
        } catch {
          /* page is closing */
        }
      })();
    }
    // The title updates every 2 s: take the median of three readings so a
    // GC pause or texture upload can't own the number.
    const reads = [];
    for (let k = 0; k < 3; k++) {
      await new Promise((r) => setTimeout(r, 2500));
      const t = await page.title();
      const f = parseFloat(/fps (\d+)/.exec(t)?.[1] ?? 'NaN');
      if (Number.isFinite(f)) reads.push(f);
    }
    dragging = false;
    await dragDone;
    reads.sort((a, b) => a - b);
    const fps = reads[Math.floor(reads.length / 2)] ?? NaN;
    table[name][skip] = fps;
    process.stdout.write(`${name.padEnd(16)} -${skip.padEnd(9)} ${String(fps).padStart(4)} fps\n`);
    await page.close();
  }
}

// summary: cost of each system per view (delta vs full scene)
console.log('\n=== attribution (fps gained when the system is removed) ===');
const header = ['view'.padEnd(16), ...KNOCKOUTS.slice(1).map((k) => k.padStart(9))].join('');
console.log(header + '   [full]');
for (const [name, row] of Object.entries(table)) {
  const base = row.none;
  const cells = KNOCKOUTS.slice(1).map((k) => {
    const d = row[k] - base;
    return (Number.isFinite(d) ? (d >= 0 ? '+' : '') + d.toFixed(0) : '?').padStart(9);
  });
  console.log(name.padEnd(16) + cells.join('') + String(base).padStart(9));
}

await browser.close();
try {
  process.kill(-server.pid, 'SIGKILL');
} catch {
  server.kill('SIGKILL');
}
process.exit(0);
