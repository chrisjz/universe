// Compresses the deep-space probes' JPL Horizons trajectories into
// Chebyshev polynomial segments — the same representation JPL's own SPK
// kernels use. Sampling is dense through the gravity-assist years (a
// Jupiter flyby bends the path in days) and monthly through the cruise
// decades; segments split recursively until every sample fits within
// tolerance, so the flybys get short segments and the long coasts get
// almost none.
//
// Usage: node scripts/generate-probes.mjs
// Writes: public/probes.json (heliocentric ecliptic J2000, meters, ms)

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const KM = 1000;
const TOL_KM = 2e4; // max fit residual — invisible at any display scale
const DEG = 12; // Chebyshev degree per coordinate per segment

const PROBES = [
  // slug, display, Horizons id, spans [start, stop, step]
  {
    slug: 'voyager-1',
    name: 'VOYAGER 1',
    id: '-31',
    spans: [
      ['1977-09-09', '1990-01-01', '2d'], // launch, Jupiter '79, Saturn '80
      ['1990-01-01', '2060-01-01', '30d'],
    ],
  },
  {
    slug: 'voyager-2',
    name: 'VOYAGER 2',
    id: '-32',
    spans: [
      ['1977-08-23', '1990-01-01', '2d'], // the Grand Tour: J/S/U/N
      ['1990-01-01', '2060-01-01', '30d'],
    ],
  },
  {
    slug: 'new-horizons',
    name: 'NEW HORIZONS',
    id: '-98',
    spans: [
      ['2006-01-20', '2017-01-01', '2d'], // Jupiter '07, Pluto '15, Arrokoth '19
      ['2017-01-01', '2049-12-01', '30d'], // Horizons' NH ephemeris ends at 2050
    ],
  },
  {
    slug: 'jwst',
    name: 'JWST',
    id: '-170',
    // The Sun–Earth L2 halo orbit loops every ~6 months: dense throughout,
    // and only as far as Horizons' predicted station-keeping extends.
    spans: [['2022-01-26', '2031-01-01', '4d']],
  },
];

const curl = (url) => execFileSync('curl', ['-s', '--max-time', '300', url], { encoding: 'utf8' });
const J2000_JD = 2451545.0;

function fetchSpan(id, start, stop, step) {
  const url =
    `https://ssd.jpl.nasa.gov/api/horizons.api?format=text&COMMAND='${id}'` +
    `&OBJ_DATA=NO&MAKE_EPHEM=YES&EPHEM_TYPE=VECTORS&CENTER='500@10'&REF_PLANE=ECLIPTIC` +
    `&OUT_UNITS='KM-S'&VEC_TABLE=1&CSV_FORMAT=YES&START_TIME='${start}'&STOP_TIME='${stop}'&STEP_SIZE='${step}'`;
  const text = curl(url);
  const body = text.split('$$SOE')[1]?.split('$$EOE')[0];
  if (!body) throw new Error(`bad Horizons response for ${id} ${start}..${stop}:\n${text.slice(0, 400)}`);
  return body
    .trim()
    .split('\n')
    .map((line) => {
      const c = line.split(',').map((v) => parseFloat(v));
      // CSV: JDTDB, date, x, y, z — convert TDB to UTC ms (69.184 s offset)
      return { ms: (c[0] - J2000_JD) * 86400000 + Date.UTC(2000, 0, 1, 12) - 69184, r: [c[2], c[3], c[4]] };
    })
    .filter((s) => Number.isFinite(s.r[0]));
}

// Least-squares Chebyshev fit of degree DEG over [t0, t1].
function chebFit(samples, t0, t1) {
  const n = samples.length;
  const m = DEG + 1;
  const T = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = (2 * (samples[i].ms - t0)) / (t1 - t0) - 1;
    const row = new Array(m);
    row[0] = 1;
    row[1] = x;
    for (let k = 2; k < m; k++) row[k] = 2 * x * row[k - 1] - row[k - 2];
    T[i] = row;
  }
  const coeffs = [];
  for (let dim = 0; dim < 3; dim++) {
    // normal equations AᵀA c = Aᵀy, solved by Gaussian elimination
    const A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const y = samples[i].r[dim];
      for (let a = 0; a < m; a++) {
        for (let b = 0; b <= a; b++) A[a][b] += T[i][a] * T[i][b];
        A[a][m] += T[i][a] * y;
      }
    }
    for (let a = 0; a < m; a++) for (let b = a + 1; b < m; b++) A[a][b] = A[b][a];
    for (let col = 0; col < m; col++) {
      let piv = col;
      for (let rw = col + 1; rw < m; rw++) if (Math.abs(A[rw][col]) > Math.abs(A[piv][col])) piv = rw;
      [A[col], A[piv]] = [A[piv], A[col]];
      for (let rw = 0; rw < m; rw++) {
        if (rw === col || A[col][col] === 0) continue;
        const f = A[rw][col] / A[col][col];
        for (let cc = col; cc <= m; cc++) A[rw][cc] -= f * A[col][cc];
      }
    }
    coeffs.push(A.map((row, k) => row[m] / (A[k][k] || 1)));
  }
  return coeffs;
}

function chebEval(c, x) {
  // Clenshaw
  let b1 = 0;
  let b2 = 0;
  for (let k = c.length - 1; k >= 1; k--) {
    const t = 2 * x * b1 - b2 + c[k];
    b2 = b1;
    b1 = t;
  }
  return x * b1 - b2 + c[0];
}

// Fit a sample run; split recursively while any residual exceeds TOL_KM.
function fitSegments(samples, out, depth = 0) {
  const t0 = samples[0].ms;
  const t1 = samples[samples.length - 1].ms;
  const coeffs = chebFit(samples, t0, t1);
  let worst = 0;
  for (const s of samples) {
    const x = (2 * (s.ms - t0)) / (t1 - t0) - 1;
    const err = Math.hypot(
      chebEval(coeffs[0], x) - s.r[0],
      chebEval(coeffs[1], x) - s.r[1],
      chebEval(coeffs[2], x) - s.r[2],
    );
    if (err > worst) worst = err;
  }
  if (worst > TOL_KM && samples.length > DEG + 4 && depth < 14) {
    const mid = Math.floor(samples.length / 2);
    fitSegments(samples.slice(0, mid + 1), out, depth + 1);
    fitSegments(samples.slice(mid), out, depth + 1);
    return;
  }
  out.push({ t0, t1, worst, c: coeffs });
}

const output = [];
for (const p of PROBES) {
  const samples = [];
  for (const [start, stop, step] of p.spans) {
    const chunk = fetchSpan(p.id, start, stop, step);
    // avoid duplicating the boundary sample
    samples.push(...(samples.length ? chunk.slice(1) : chunk));
  }
  const segs = [];
  fitSegments(samples, segs);
  const worst = Math.max(...segs.map((s) => s.worst));
  // Ballistic escape: beyond the data span the probes coast nearly
  // straight, so store the end state for linear extension (JWST instead
  // fades out — its future station-keeping is not predictable).
  const a = samples[samples.length - 2];
  const b = samples[samples.length - 1];
  const velKmMs = [0, 1, 2].map((k) => (b.r[k] - a.r[k]) / (b.ms - a.ms));
  output.push({
    slug: p.slug,
    name: p.name,
    startMs: samples[0].ms,
    endMs: b.ms,
    extend: p.slug === 'jwst' ? null : { r: b.r, v: velKmMs },
    segs: segs.map((s) => ({
      t0: s.t0,
      t1: s.t1,
      c: s.c.map((dim) => dim.map((v) => Number(v.toPrecision(10)))),
    })),
  });
  console.log(
    `${p.slug.padEnd(13)} ${samples.length} samples → ${segs.length} segments, worst residual ${worst.toFixed(1)} km`,
  );
}

writeFileSync('public/probes.json', JSON.stringify(output));
console.log(`wrote public/probes.json (${(JSON.stringify(output).length / 1024).toFixed(0)} kB)`);
