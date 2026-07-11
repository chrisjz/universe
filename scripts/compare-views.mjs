// Compares captured view PNGs (scripts/capture-views.mjs) against the
// checked-in baselines in tests/visual/baseline/. A view fails when more
// than 0.5% of its pixels differ beyond pixelmatch's perceptual threshold —
// loose enough to absorb rasterizer noise, tight enough that a missing
// draw call, a broken shader, or an undersized bind group lights up red.
//
//   node scripts/compare-views.mjs [candidateDir]   (default .visual-out)
//
// Baselines are generated ON CI (SwiftShader pixels differ from local
// Metal/Vulkan ones): download the `visual` artifact from an Actions run,
// copy the PNGs into tests/visual/baseline/, and commit. A candidate with
// no baseline warns but passes, so adding a view is a two-step: land it,
// then commit its first CI capture.

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';

const candDir = process.argv[2] ?? '.visual-out';
const baseDir = 'tests/visual/baseline';
const RATIO_MAX = 0.005; // fraction of pixels allowed to differ
const THRESHOLD = 0.12; // pixelmatch per-pixel perceptual threshold

const candidates = readdirSync(candDir).filter((f) => f.endsWith('.png') && !f.startsWith('diff-'));
if (!candidates.length) {
  console.error(`no candidate PNGs in ${candDir}/ — run capture-views.mjs first`);
  process.exit(1);
}

let failed = 0;
let missing = 0;
for (const f of candidates.sort()) {
  const basePath = `${baseDir}/${f}`;
  if (!existsSync(basePath)) {
    missing++;
    console.warn(`~ ${f}: no baseline yet — commit this capture to ${baseDir}/`);
    continue;
  }
  const base = PNG.sync.read(readFileSync(basePath));
  const cand = PNG.sync.read(readFileSync(`${candDir}/${f}`));
  if (base.width !== cand.width || base.height !== cand.height) {
    failed++;
    console.error(`✗ ${f}: size ${cand.width}×${cand.height} vs baseline ${base.width}×${base.height}`);
    continue;
  }
  const diff = new PNG({ width: base.width, height: base.height });
  const n = pixelmatch(base.data, cand.data, diff.data, base.width, base.height, { threshold: THRESHOLD });
  const ratio = n / (base.width * base.height);
  if (ratio > RATIO_MAX) {
    failed++;
    writeFileSync(`${candDir}/diff-${f}`, PNG.sync.write(diff));
    console.error(`✗ ${f}: ${(ratio * 100).toFixed(2)}% of pixels differ (limit ${RATIO_MAX * 100}%)`);
  } else {
    console.log(`✓ ${f}  (${(ratio * 100).toFixed(3)}% differ)`);
  }
}

if (failed) {
  console.error(`\n${failed} view(s) regressed — diff-*.png images written to ${candDir}/`);
  process.exit(1);
}
console.log(
  `\nall ${candidates.length - missing} baselined views match${missing ? ` (${missing} awaiting baselines)` : ''}`,
);
