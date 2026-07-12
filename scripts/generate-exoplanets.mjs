// Compacts the NASA Exoplanet Archive's confirmed-planet table into
// public/exoplanets.bin — one record per planetary SYSTEM (a dot marks a
// star we know has worlds; the planets sit at their star at any distance
// the atlas can show).
//
// Input: CSV from the archive's TAP service, columns
//   pl_name,hostname,ra,dec,sy_dist,pl_orbsmax,pl_orbper,pl_orbeccen,
//   pl_rade,st_rad,st_teff,sy_pnum
//   https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=
//     select+...+from+pscomppars+where+sy_dist+is+not+null&format=csv
//
// Record (12 bytes): f32 ra°, f32 dec°, u16 dist (0.1 pc, saturates),
// u8 planet count, u8 Teff/100 (0 = unknown).
//
// Usage: node scripts/generate-exoplanets.mjs <pscomppars.csv>

import { readFileSync, writeFileSync } from 'node:fs';

const rows = readFileSync(process.argv[2], 'utf8').trim().split('\n');
const header = rows.shift().split(',');
const col = (name) => header.indexOf(name);
const C = {
  host: col('hostname'),
  ra: col('ra'),
  dec: col('dec'),
  dist: col('sy_dist'),
  teff: col('st_teff'),
};

// CSV fields are quoted-or-bare; none of ours contain commas inside quotes
// except names, which we split around carefully.
const parse = (line) => {
  const out = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
};

const systems = new Map();
let planets = 0;
for (const line of rows) {
  const f = parse(line);
  const host = f[C.host];
  const ra = parseFloat(f[C.ra]);
  const dec = parseFloat(f[C.dec]);
  const dist = parseFloat(f[C.dist]);
  if (!host || !Number.isFinite(ra) || !Number.isFinite(dist)) continue;
  planets++;
  const s = systems.get(host) ?? { ra, dec, dist, teff: parseFloat(f[C.teff]) || 0, n: 0 };
  s.n++;
  systems.set(host, s);
}

const list = [...systems.values()];
const buf = Buffer.alloc(list.length * 12);
list.forEach((s, i) => {
  const o = i * 12;
  buf.writeFloatLE(s.ra, o);
  buf.writeFloatLE(s.dec, o + 4);
  buf.writeUInt16LE(Math.min(Math.round(s.dist * 10), 65535), o + 8);
  buf.writeUInt8(Math.min(s.n, 255), o + 10);
  buf.writeUInt8(Math.min(Math.round(s.teff / 100), 255), o + 11);
});

// ---- self-checks: fail loudly before writing a wrong sky ----
let failures = 0;
const check = (label, ok) => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok ' : 'FAIL '} ${label}`);
};
check(`${planets} planets in ${list.length} systems (expect > 5500 / > 3800)`, planets > 5500 && list.length > 3800);
const prox = systems.get('Proxima Cen');
check(`Proxima Cen present at ${prox?.dist} pc (expect 1.29–1.31)`, !!prox && prox.dist > 1.29 && prox.dist < 1.31);
// Proxima sits 2.2° from α Cen AB in the real sky.
if (prox) {
  const aCen = { ra: 219.9, dec: -60.83 };
  const d2r = Math.PI / 180;
  const sep =
    Math.acos(
      Math.sin(prox.dec * d2r) * Math.sin(aCen.dec * d2r) +
        Math.cos(prox.dec * d2r) * Math.cos(aCen.dec * d2r) * Math.cos((prox.ra - aCen.ra) * d2r),
    ) / d2r;
  check(`Proxima ${sep.toFixed(2)}° from α Cen (expect ~2.2)`, sep > 1.8 && sep < 2.6);
}
const trap = systems.get('TRAPPIST-1');
check(
  `TRAPPIST-1: ${trap?.n} planets at ${trap?.dist} pc (expect 7 at ~12.4)`,
  !!trap && trap.n === 7 && trap.dist > 12 && trap.dist < 13,
);
if (failures) {
  console.error(`\n${failures} FAILURES — not writing`);
  process.exit(1);
}

writeFileSync('public/exoplanets.bin', buf);
console.log(`\nwrote public/exoplanets.bin — ${list.length} systems, ${(buf.length / 1024).toFixed(1)} kB`);
