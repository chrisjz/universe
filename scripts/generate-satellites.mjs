// Snapshots CelesTrak's 'visual' (the ~160 naked-eye-brightest satellites)
// and 'stations' groups into public/satellites.json as raw TLE lines. The
// app propagates them with src/sgp4.ts (near-Earth SGP4), so deep-space
// birds (period ≥ 225 min — GEO, Molniya) are filtered here.
//
// TLEs age: SGP4 holds to km-scale for days and drifts irrecoverably over
// months, so the app fades satellites out beyond ±30 days of each TLE's
// epoch. Rerun this script to refresh the snapshot.
//
// Usage: node scripts/generate-satellites.mjs
// Writes: public/satellites.json

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const curl = (url) => execFileSync('curl', ['-s', '--max-time', '120', url], { encoding: 'utf8' });

const GROUPS = ['visual', 'stations'];
const bySatnum = new Map();
for (const g of GROUPS) {
  const text = curl(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`);
  const lines = text.trim().split(/\r?\n/);
  for (let i = 0; i + 2 < lines.length + 1 && lines[i + 1]?.startsWith('1 '); i += 3) {
    const name = lines[i].trim();
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    const satnum = l1.slice(2, 7).trim();
    const revPerDay = parseFloat(l2.slice(52, 63));
    if (revPerDay < 6.4) continue; // period ≥ 225 min needs SDP4 (deep space)
    if (!bySatnum.has(satnum)) bySatnum.set(satnum, { n: name, l1, l2 });
  }
  console.log(`${g}: ${bySatnum.size} total after merge`);
}

const sats = [...bySatnum.values()];
writeFileSync('public/satellites.json', JSON.stringify(sats));
console.log(`wrote ${sats.length} satellites (${(JSON.stringify(sats).length / 1024).toFixed(0)} kB)`);
