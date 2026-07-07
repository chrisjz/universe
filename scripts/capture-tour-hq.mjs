// Frame-perfect grand-tour capture via CDP virtual time: the page clock is
// advanced in exact (1000/fps) ms steps and a 1080p screenshot is taken at
// each step, so the result is deterministic and perfectly smooth regardless
// of how long each WebGPU frame takes to render or read back.
//
//   node scripts/capture-tour-hq.mjs <url> <outDir> <seconds> [captureFps]
//   node scripts/capture-tour-hq.mjs "http://localhost:5199/" /tmp/hq 66 25
//
// Encode at 60 fps input rate for a 2.4x time-compressed, 60 fps MP4:
//   ffmpeg -framerate 60 -i /tmp/hq/f%05d.png -c:v libx264 -pix_fmt yuv420p \
//     -crf 21 -preset slow -movflags +faststart tour.mp4

import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const [url, outDir, secondsArg, fpsArg] = process.argv.slice(2);
const seconds = parseFloat(secondsArg ?? '66');
const fps = parseFloat(fpsArg ?? '25');
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--window-size=1920,1080', '--hide-scrollbars'],
  defaultViewport: { width: 1920, height: 1080 },
});

const page = await browser.newPage();
await page.goto(url, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 4000)); // let star tiles + textures land
await page.keyboard.press('t'); // start the grand tour

const client = await page.createCDPSession();
const frames = Math.round(seconds * fps);
const step = 1000 / fps;
for (let i = 0; i < frames; i++) {
  const expired = new Promise((res) => client.once('Emulation.virtualTimeBudgetExpired', res));
  await client.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: step });
  await expired;
  const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  writeFileSync(`${outDir}/f${String(i).padStart(5, '0')}.png`, Buffer.from(shot.data, 'base64'));
  if (i % 100 === 0) console.log(`frame ${i}/${frames}`);
}
await browser.close();
console.log(`captured ${frames} frames (${seconds}s of tour at ${fps} fps virtual)`);
