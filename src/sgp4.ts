// SGP4: the standard analytic propagator for two-line elements (TLEs) —
// the format every tracked satellite is published in (NORAD/CelesTrak).
// This is the near-Earth branch of Vallado's "Revisiting Spacetrack
// Report #3" formulation (WGS-72 constants, as TLEs assume): secular J2
// rates, atmospheric drag via B*, long- and short-period periodics.
// Deep-space satellites (period ≥ 225 min: GEO, Molniya) need SDP4 and are
// filtered out at generation time — the visible sky is LEO anyway.
//
// Output is TEME (true equator, mean equinox of date); temeToJ2000 applies
// IAU-1976 precession so positions land in the same J2000 frame as the
// star catalog (the ~0.4°/26yr of precession matters: it is ~45 km at ISS
// altitude, larger than TLE error). Verified against JPL Horizons' ISS
// ephemeris by scripts/verify-sgp4.mjs.

import type { V3 } from './math';

const XKE = 0.07436691613317342; // 60/sqrt(Re³/μ), WGS-72
const J2 = 0.001082616;
const J3 = -2.53881e-6;
const J4 = -1.65597e-6;
const RE = 6378.135; // km, WGS-72
const X2O3 = 2 / 3;
const J3OJ2 = J3 / J2;
const TWO_PI = 2 * Math.PI;
const DEG = Math.PI / 180;

export interface Tle {
  name: string;
  satnum: string;
  epochMs: number; // TLE epoch as a JS timestamp (UTC)
  no: number; // mean motion, rad/min (Kozai)
  ecco: number;
  inclo: number; // rad
  nodeo: number; // rad
  argpo: number; // rad
  mo: number; // rad
  bstar: number; // 1/earth-radii
}

// Fixed-column TLE fields, per the NORAD format.
export function parseTle(name: string, l1: string, l2: string): Tle {
  const yy = parseInt(l1.slice(18, 20), 10);
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const doy = parseFloat(l1.slice(20, 32));
  const epochMs = Date.UTC(year, 0, 1) + (doy - 1) * 86400000;
  // B* is a decimal with implied point and separate exponent: " 34123-4".
  const bs = l1.slice(53, 61);
  const bstar = parseFloat(`${bs.slice(0, 1)}.${bs.slice(1, 6)}e${bs.slice(6)}`.replace(/ /g, '')) || 0;
  return {
    name: name.trim(),
    satnum: l1.slice(2, 7).trim(),
    epochMs,
    no: (parseFloat(l2.slice(52, 63)) * TWO_PI) / 1440,
    ecco: parseFloat(`0.${l2.slice(26, 33).trim()}`),
    inclo: parseFloat(l2.slice(8, 16)) * DEG,
    nodeo: parseFloat(l2.slice(17, 25)) * DEG,
    argpo: parseFloat(l2.slice(34, 42)) * DEG,
    mo: parseFloat(l2.slice(43, 51)) * DEG,
    bstar,
  };
}

export interface Sat {
  tle: Tle;
  // precomputed init terms
  no: number; // un-Kozaied mean motion
  a: number;
  isimp: boolean;
  cc1: number;
  cc4: number;
  cc5: number;
  d2: number;
  d3: number;
  d4: number;
  t2cof: number;
  t3cof: number;
  t4cof: number;
  t5cof: number;
  mdot: number;
  argpdot: number;
  nodedot: number;
  nodecf: number;
  omgcof: number;
  xmcof: number;
  eta: number;
  delmo: number;
  sinmao: number;
  aycof: number;
  xlcof: number;
  con41: number;
  x1mth2: number;
  x7thm1: number;
  cosio: number;
  sinio: number;
}

export function sgp4Init(tle: Tle): Sat {
  const { no: noKozai, ecco, inclo, argpo, mo, bstar } = tle;
  const eccsq = ecco * ecco;
  const omeosq = 1 - eccsq;
  const rteosq = Math.sqrt(omeosq);
  const cosio = Math.cos(inclo);
  const sinio = Math.sin(inclo);
  const cosio2 = cosio * cosio;

  // Un-Kozai the mean motion (SGP4 works with Brouwer mean elements).
  const ak = Math.pow(XKE / noKozai, X2O3);
  const d1 = (0.75 * J2 * (3 * cosio2 - 1)) / (rteosq * omeosq);
  let del = d1 / (ak * ak);
  const adel = ak * (1 - del * del - del * (1 / 3 + (134 * del * del) / 81));
  del = d1 / (adel * adel);
  const no = noKozai / (1 + del);

  const ao = Math.pow(XKE / no, X2O3);
  const po = ao * omeosq;
  const con42 = 1 - 5 * cosio2;
  const con41 = -con42 - 2 * cosio2;
  const posq = po * po;
  const rp = ao * (1 - ecco);

  // Drag reference height s4 adapts for low perigees (Vallado).
  const perigeeKm = (rp - 1) * RE;
  let sfour = 78;
  if (perigeeKm < 156) sfour = perigeeKm > 98 ? perigeeKm - 78 : 20;
  const qzms24 = Math.pow((120 - sfour) / RE, 4);
  sfour = sfour / RE + 1;

  const pinvsq = 1 / posq;
  const tsi = 1 / (ao - sfour);
  const eta = ao * ecco * tsi;
  const etasq = eta * eta;
  const eeta = ecco * eta;
  const psisq = Math.abs(1 - etasq);
  const coef = qzms24 * Math.pow(tsi, 4);
  const coef1 = coef / Math.pow(psisq, 3.5);
  const cc2 =
    coef1 *
    no *
    (ao * (1 + 1.5 * etasq + eeta * (4 + etasq)) +
      ((0.375 * J2 * tsi) / psisq) * con41 * (8 + 3 * etasq * (8 + etasq)));
  const cc1 = bstar * cc2;
  let cc3 = 0;
  if (ecco > 1e-4) cc3 = (-2 * coef * tsi * J3OJ2 * no * sinio) / ecco;
  const x1mth2 = 1 - cosio2;
  const cc4 =
    2 *
    no *
    coef1 *
    ao *
    omeosq *
    (eta * (2 + 0.5 * etasq) +
      ecco * (0.5 + 2 * etasq) -
      ((J2 * tsi) / (ao * psisq)) *
        (-3 * con41 * (1 - 2 * eeta + etasq * (1.5 - 0.5 * eeta)) +
          0.75 * x1mth2 * (2 * etasq - eeta * (1 + etasq)) * Math.cos(2 * argpo)));
  const cc5 = 2 * coef1 * ao * omeosq * (1 + 2.75 * (etasq + eeta) + eeta * etasq);
  const cosio4 = cosio2 * cosio2;
  const temp1 = 1.5 * J2 * pinvsq * no;
  const temp2 = 0.5 * temp1 * J2 * pinvsq;
  const temp3 = -0.46875 * J4 * pinvsq * pinvsq * no;
  const mdot = no + 0.5 * temp1 * rteosq * con41 + 0.0625 * temp2 * rteosq * (13 - 78 * cosio2 + 137 * cosio4);
  const argpdot =
    -0.5 * temp1 * con42 + 0.0625 * temp2 * (7 - 114 * cosio2 + 395 * cosio4) + temp3 * (3 - 36 * cosio2 + 49 * cosio4);
  const xhdot1 = -temp1 * cosio;
  const nodedot = xhdot1 + (0.5 * temp2 * (4 - 19 * cosio2) + 2 * temp3 * (3 - 7 * cosio2)) * cosio;
  const omgcof = bstar * cc3 * Math.cos(argpo);
  let xmcof = 0;
  if (ecco > 1e-4) xmcof = (-X2O3 * coef * bstar) / eeta;
  const nodecf = 3.5 * omeosq * xhdot1 * cc1;
  const t2cof = 1.5 * cc1;
  const div = Math.abs(1 + cosio) > 1.5e-12 ? 1 + cosio : 1.5e-12;
  const xlcof = (-0.25 * J3OJ2 * sinio * (3 + 5 * cosio)) / div;
  const aycof = -0.5 * J3OJ2 * sinio;
  const delmo = Math.pow(1 + eta * Math.cos(mo), 3);
  const sinmao = Math.sin(mo);
  const x7thm1 = 7 * cosio2 - 1;

  // Perigee under 220 km: the simplified drag equations.
  const isimp = rp < 220 / RE + 1;
  let d2 = 0,
    d3 = 0,
    d4 = 0,
    t3cof = 0,
    t4cof = 0,
    t5cof = 0;
  if (!isimp) {
    const cc1sq = cc1 * cc1;
    d2 = 4 * ao * tsi * cc1sq;
    const temp = (d2 * tsi * cc1) / 3;
    d3 = (17 * ao + sfour) * temp;
    d4 = 0.5 * temp * ao * tsi * (221 * ao + 31 * sfour) * cc1;
    t3cof = d2 + 2 * cc1sq;
    t4cof = 0.25 * (3 * d3 + cc1 * (12 * d2 + 10 * cc1sq));
    t5cof = 0.2 * (3 * d4 + 12 * cc1 * d3 + 6 * d2 * d2 + 15 * cc1sq * (2 * d2 + cc1sq));
  }

  return {
    tle,
    no,
    a: ao,
    isimp,
    cc1,
    cc4,
    cc5,
    d2,
    d3,
    d4,
    t2cof,
    t3cof,
    t4cof,
    t5cof,
    mdot,
    argpdot,
    nodedot,
    nodecf,
    omgcof,
    xmcof,
    eta,
    delmo,
    sinmao,
    aycof,
    xlcof,
    con41,
    x1mth2,
    x7thm1,
    cosio,
    sinio,
  };
}

// Propagate `t` minutes past the TLE epoch. Writes the TEME position in
// KILOMETERS into `out`; returns false when the orbit has decayed (or the
// elements have gone unphysical — drag does that far from epoch).
export function sgp4(s: Sat, t: number, out: V3): boolean {
  const { tle } = s;
  const xmdf = tle.mo + s.mdot * t;
  const argpdf = tle.argpo + s.argpdot * t;
  const nodedf = tle.nodeo + s.nodedot * t;
  let argpm = argpdf;
  let mm = xmdf;
  const t2 = t * t;
  let nodem = nodedf + s.nodecf * t2;
  let tempa = 1 - s.cc1 * t;
  let tempe = tle.bstar * s.cc4 * t;
  let templ = s.t2cof * t2;
  if (!s.isimp) {
    const delomg = s.omgcof * t;
    const delmtemp = 1 + s.eta * Math.cos(xmdf);
    const delm = s.xmcof * (delmtemp * delmtemp * delmtemp - s.delmo);
    const tempp = delomg + delm;
    mm = xmdf + tempp;
    argpm = argpdf - tempp;
    const t3 = t2 * t;
    const t4 = t3 * t;
    tempa = tempa - s.d2 * t2 - s.d3 * t3 - s.d4 * t4;
    tempe = tempe + tle.bstar * s.cc5 * (Math.sin(mm) - s.sinmao);
    templ = templ + s.t3cof * t3 + t4 * (s.t4cof + t * s.t5cof);
  }
  let em = tle.ecco - tempe;
  if (em >= 1 || em < -0.001) return false;
  if (em < 1e-6) em = 1e-6;
  const am = Math.pow(XKE / s.no, X2O3) * tempa * tempa;
  if (am < 0.95) return false; // decayed
  mm = mm + s.no * templ;
  const xlm = mm + argpm + nodem;
  nodem = nodem % TWO_PI;
  argpm = argpm % TWO_PI;
  mm = (xlm - argpm - nodem) % TWO_PI;

  // Long-period periodics.
  const axnl = em * Math.cos(argpm);
  const tem = 1 / (am * (1 - em * em));
  const aynl = em * Math.sin(argpm) + tem * s.aycof;
  const xl = mm + argpm + nodem + tem * s.xlcof * axnl;

  // Kepler for the "eccentric longitude".
  const u = (xl - nodem) % TWO_PI;
  let eo1 = u;
  let tem5 = 9999.9;
  let ktr = 0;
  let sineo1 = 0;
  let coseo1 = 0;
  while (Math.abs(tem5) >= 1e-12 && ktr < 10) {
    sineo1 = Math.sin(eo1);
    coseo1 = Math.cos(eo1);
    tem5 = 1 - coseo1 * axnl - sineo1 * aynl;
    tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) / tem5;
    if (Math.abs(tem5) >= 0.95) tem5 = tem5 > 0 ? 0.95 : -0.95;
    eo1 += tem5;
    ktr++;
  }

  // Short-period periodics.
  const ecose = axnl * coseo1 + aynl * sineo1;
  const esine = axnl * sineo1 - aynl * coseo1;
  const el2 = axnl * axnl + aynl * aynl;
  const pl = am * (1 - el2);
  if (pl < 0) return false;
  const rl = am * (1 - ecose);
  const betal = Math.sqrt(1 - el2);
  const temp = esine / (1 + betal);
  const sinu = (am / rl) * (sineo1 - aynl - axnl * temp);
  const cosu = (am / rl) * (coseo1 - axnl + aynl * temp);
  let su = Math.atan2(sinu, cosu);
  const sin2u = (cosu + cosu) * sinu;
  const cos2u = 1 - 2 * sinu * sinu;
  const tempP = 1 / pl;
  const temp1 = 0.5 * J2 * tempP;
  const temp2 = temp1 * tempP;
  const mrt = rl * (1 - 1.5 * temp2 * betal * s.con41) + 0.5 * temp1 * s.x1mth2 * cos2u;
  su = su - 0.25 * temp2 * s.x7thm1 * sin2u;
  const xnode = nodem + 1.5 * temp2 * s.cosio * sin2u;
  const xinc = tle.inclo + 1.5 * temp2 * s.cosio * s.sinio * cos2u;

  const sinsu = Math.sin(su);
  const cossu = Math.cos(su);
  const snod = Math.sin(xnode);
  const cnod = Math.cos(xnode);
  const sini = Math.sin(xinc);
  const cosi = Math.cos(xinc);
  const ux = -snod * cosi * sinsu + cnod * cossu;
  const uy = cnod * cosi * sinsu + snod * cossu;
  const uz = sini * sinsu;
  const r = mrt * RE;
  out[0] = r * ux;
  out[1] = r * uy;
  out[2] = r * uz;
  return mrt >= 1; // below one earth radius = decayed
}

// TEME → J2000 via IAU-1976 precession (mean of date → J2000). TEME's
// remaining difference from the mean equator/equinox — the equation of the
// equinoxes, ≤ ~17″ — is a few km at LEO, under TLE noise, and ignored.
export function temeToJ2000(msUtc: number): number[][] {
  const T = (msUtc - Date.UTC(2000, 0, 1, 12)) / (86400000 * 36525);
  const AS = (Math.PI / 180 / 3600) * T;
  const zeta = (2306.2181 + (0.30188 + 0.017998 * T) * T) * AS;
  const z = (2306.2181 + (1.09468 + 0.018203 * T) * T) * AS;
  const theta = (2004.3109 - (0.42665 + 0.041833 * T) * T) * AS;
  const cz = Math.cos(zeta),
    sz = Math.sin(zeta);
  const ct = Math.cos(theta),
    st = Math.sin(theta);
  const cZ = Math.cos(z),
    sZ = Math.sin(z);
  // P (J2000 → mean-of-date) = R3(−z)·R2(θ)·R3(−ζ); we return Pᵀ.
  const p = [
    [cz * ct * cZ - sz * sZ, -sz * ct * cZ - cz * sZ, -st * cZ],
    [cz * ct * sZ + sz * cZ, -sz * ct * sZ + cz * cZ, -st * sZ],
    [cz * st, -sz * st, ct],
  ];
  return [
    [p[0][0], p[1][0], p[2][0]],
    [p[0][1], p[1][1], p[2][1]],
    [p[0][2], p[1][2], p[2][2]],
  ];
}
