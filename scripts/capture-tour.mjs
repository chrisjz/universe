// Captures the grand tour as a frame sequence using the system Chrome
// (headless WebGPU) via puppeteer-core + CDP screencast. Assemble with
// ffmpeg afterwards — see scripts/README note in the repo docs.
//
//   node scripts/capture-tour.mjs <url> <outDir> <seconds>
//   node scripts/capture-tour.mjs "http://localhost:5199/?tour=1" /tmp/frames 95

import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const [url, outDir, secondsArg, widthArg, heightArg] = process.argv.slice(2);
const W = parseInt(widthArg ?? '960', 10);
const H = parseInt(heightArg ?? '600', 10);
const seconds = parseFloat(secondsArg ?? '95');
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', `--window-size=${W},${H}`, '--hide-scrollbars'],
  defaultViewport: { width: W, height: H },
});

const page = await browser.newPage();
await page.goto(url, { waitUntil: 'networkidle2' });

const client = await page.createCDPSession();
let i = 0;
const times = [];
const t0 = Date.now();
client.on('Page.screencastFrame', (ev) => {
  writeFileSync(`${outDir}/f${String(i).padStart(5, '0')}.png`, Buffer.from(ev.data, 'base64'));
  times.push(Date.now() - t0);
  i++;
  client.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
});
await client.send('Page.startScreencast', { format: 'png', maxWidth: W, maxHeight: H, everyNthFrame: 1 });

await new Promise((r) => setTimeout(r, seconds * 1000));
await client.send('Page.stopScreencast');
writeFileSync(`${outDir}/times.json`, JSON.stringify(times));
await browser.close();
console.log(`captured ${i} frames over ${seconds}s (~${(i / seconds).toFixed(1)} fps)`);
