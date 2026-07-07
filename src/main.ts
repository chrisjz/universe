// Orchestration: camera state in hierarchical frames, three-phase flights
// (zoom out → pan at altitude → zoom in, so double-precision error is only
// ever spent where it's invisible), the grand tour, and per-frame conversion
// of double-precision world state into camera-relative float GPU data.

import {
  V3,
  add,
  sub,
  scale,
  len,
  norm,
  clamp,
  lerp3,
  smootherstep,
  mat4Perspective,
  mat4Mul,
  viewRotation,
} from './math';
import { Frame, relPos, reexpress } from './frames';
import { Renderer, FrameData } from './renderer';
import { buildUniverse, Target } from './scene';
import { streamStars } from './stars';
import { Hud } from './hud';

const FOV = (60 * Math.PI) / 180;
const CAP = 1e7; // true-scale within 10,000 km, log-compressed beyond
const MAX_D = 1.5e27;
const FAR = CAP * (1 + Math.log(MAX_D / CAP));
const LOG_FAR_INV = 1 / Math.log2(1 + FAR);
const MIN_DIST = 1.2,
  MAX_DIST = 2.5e27;

interface Flight {
  fromFrame: Frame;
  fromPos: V3;
  logD0: number;
  to: Target;
  logD1: number;
  logPeak: number;
  pitch0: number;
  yaw0: number;
  yawDelta: number; // shortest-arc turn toward the target's arrival yaw (0 if none)
  t: number;
  dur: number;
  switched: boolean;
  fromInToFrame: V3 | null;
}

const fatal = (msg: string) => {
  const el = document.getElementById('fatal')!;
  el.style.display = 'flex';
  el.innerHTML = msg;
};

async function start(): Promise<void> {
  const canvas = document.getElementById('gpu') as HTMLCanvasElement;
  const renderer = new Renderer(canvas);
  try {
    await renderer.init();
  } catch (e) {
    fatal(`UNIVERSE needs WebGPU.<br><br>${(e as Error).message}<br><br>Try Chrome, Edge, or Safari 18+.`);
    return;
  }

  const u = buildUniverse();
  const groupIndex = u.groups.map((g) => renderer.addPointGroup(g.data));

  // ---- simulation clock & mean-longitude ephemeris ----
  // Planet/Moon positions are real for the simulated date (circular, coplanar
  // approximation). The clock starts at the actual current time.
  const J2000 = Date.UTC(2000, 0, 1, 12);
  const SPEEDS = [1, 60, 3600, 86400, 604800, 2629800, 31557600, 315576000];
  const SPEED_LABELS = [
    'real time',
    '1 min/s',
    '1 hour/s',
    '1 day/s',
    '1 week/s',
    '1 month/s',
    '1 year/s',
    '10 years/s',
  ];
  let simMs = Date.now();
  let speedIndex = 0;
  let paused = false;

  function updateBodies(): void {
    const days = (simMs - J2000) / 86400000;
    for (const b of u.bodies) {
      const theta = 2 * Math.PI * (b.L0 / 360 + days / b.periodDays);
      const x = b.a * Math.cos(theta),
        z = b.a * Math.sin(theta);
      if (b.frameOffset) {
        b.frameOffset[0] = x;
        b.frameOffset[2] = z;
      }
      for (const p of b.positions) {
        p[0] = x;
        p[2] = z;
      }
      if (b.spriteFloatBase !== undefined) {
        const d = u.groups[u.planetSpriteGroup].data;
        d[b.spriteFloatBase] = x;
        d[b.spriteFloatBase + 2] = z;
      }
    }
    renderer.updatePointGroup(groupIndex[u.planetSpriteGroup], u.groups[u.planetSpriteGroup].data);
  }
  updateBodies(); // targets must sit at their real positions before any ?goto jump

  // ---- stream the ATHYG star tiles (brightest chunks first) ----
  let starCount = 0;
  void streamStars(`${import.meta.env.BASE_URL}stars/`, (instances) => {
    groupIndex.push(renderer.addPointGroup(instances));
    u.groups.push({ frame: u.sunFrame, pos: [0, 0, 0], data: instances, fadeExtent: 6e18 });
    starCount += instances.length / 8;
  });

  // ---- camera state ----
  const cam = {
    frame: u.targets[0].frame,
    focus: [...u.targets[0].pos] as V3,
    yaw: 0.6,
    pitch: u.targets[0].pitch,
    dist: u.targets[0].dist,
  };
  let flight: Flight | null = null;
  let retarget: { to: number; from: V3; t: number } | null = null;
  let touring = false;
  let tourIndex = 0;
  let tourDwell = 0;
  let activeTarget = 0;
  let focusName = u.targets[0].name;

  const bySlug = new Map(u.targets.map((t, i) => [t.slug, i]));

  const camDir = (): V3 => [
    Math.cos(cam.pitch) * Math.sin(cam.yaw),
    Math.sin(cam.pitch),
    Math.cos(cam.pitch) * Math.cos(cam.yaw),
  ];

  // Arrival yaw for sunlit-side targets, computed live (bodies move now).
  function arrivalYaw(t: Target): number | undefined {
    if (!t.sunlit) return undefined;
    const s = relPos(u.sunFrame, [0, 0, 0], t.frame, t.pos);
    return Math.atan2(s[0], s[2]);
  }

  // ---- seamless zoom: focus retargeting ----
  // A retarget changes what scrolling converges on without moving the camera:
  // the camera pose is preserved exactly while the focus glides to the new
  // anchor, and dist/yaw/pitch are re-derived from the fixed camera position.
  // Exit hand-offs are disarmed until the camera has actually been closer
  // than the exit threshold; otherwise clicking a far-away object would
  // retarget and instantly bounce focus back up the chain.
  let exitArmed = false;

  function retargetTo(i: number): void {
    if (i === activeTarget) return;
    const t = u.targets[i];
    const camPos = add(cam.focus, scale(camDir(), cam.dist));
    const focusInNew = reexpress(cam.frame, cam.focus, t.frame);
    const camInNew = reexpress(cam.frame, camPos, t.frame);
    cam.frame = t.frame;
    cam.focus = focusInNew;
    const rel = sub(camInNew, focusInNew);
    cam.dist = clamp(len(rel), MIN_DIST, MAX_DIST);
    retarget = { to: i, from: focusInNew, t: 0 };
    activeTarget = i;
    focusName = t.name;
    exitArmed = false;
  }

  function updateRetarget(dt: number): void {
    if (!retarget) return;
    const t = u.targets[retarget.to];
    const camPos = add(cam.focus, scale(camDir(), cam.dist));
    retarget.t += dt / 0.7;
    const k = smootherstep(retarget.t);
    cam.focus = lerp3(retarget.from, t.pos, k);
    const rel = sub(camPos, cam.focus);
    const d = len(rel);
    cam.dist = clamp(d, MIN_DIST, MAX_DIST);
    cam.pitch = clamp(Math.asin(clamp(rel[1] / Math.max(d, 1e-9), -1, 1)), -1.53, 1.53);
    cam.yaw = Math.atan2(rel[0], rel[2]);
    if (retarget.t >= 1) retarget = null;
  }

  // Walk the zoom chain declared on the targets: scrolling in past a child's
  // `enter` distance descends to it; scrolling out past `exit` ascends.
  function updateAutoTarget(): void {
    if (flight || touring || retarget) return;
    const t = u.targets[activeTarget];
    if (t.child !== undefined && t.enter !== undefined && cam.dist < t.enter) {
      retargetTo(bySlug.get(t.child)!);
    } else if (t.parent !== undefined && t.exit !== undefined) {
      if (!exitArmed) {
        if (cam.dist < t.exit * 0.7) exitArmed = true;
      } else if (cam.dist > t.exit) {
        retargetTo(bySlug.get(t.parent)!);
      }
    }
  }

  // ---- click-to-focus: pick the target whose direction best matches the
  // ---- ray through the clicked pixel (tolerance-padded angular hit test)
  function pickAt(px: number, py: number): number {
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    const tanF = Math.tan(FOV / 2);
    const { right, up, fwd } = viewRotation(cam.yaw, cam.pitch);
    const ray = norm(
      add(add(scale(right, ((px / w) * 2 - 1) * tanF * (w / h)), scale(up, (1 - (py / h) * 2) * tanF)), fwd),
    );
    const camPos = add(cam.focus, scale(camDir(), cam.dist));
    const tolAngle = (12 * 2 * tanF) / h; // ~12 px of slack
    let best = -1;
    let bestScore = 1;
    u.targets.forEach((t, i) => {
      if (t.radius === undefined || i === activeTarget) return;
      const rel = relPos(t.frame, t.pos, cam.frame, camPos);
      const d = len(rel);
      if (d < t.radius * 1.5) return; // camera is inside/next to it
      const cosA = (rel[0] * ray[0] + rel[1] * ray[1] + rel[2] * ray[2]) / d;
      if (cosA <= 0) return;
      const angle = Math.acos(Math.min(cosA, 1));
      const lim = Math.max(Math.atan(t.radius / d) * 1.15, tolAngle);
      if (angle > lim) return;
      const score = angle / lim; // prefer the object you aimed at most precisely
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    return best;
  }

  function flyTo(i: number): void {
    const t = u.targets[i];
    retarget = null;
    exitArmed = false;
    activeTarget = i;
    focusName = t.name;
    const sep = len(relPos(t.frame, t.pos, cam.frame, cam.focus));
    const d0 = cam.dist,
      d1 = t.dist;
    const peak = Math.max(d0, d1, sep * 1.5);
    const decades = Math.abs(Math.log10(peak / Math.min(d0, d1)));
    flight = {
      fromFrame: cam.frame,
      fromPos: [...cam.focus] as V3,
      logD0: Math.log(d0),
      logD1: Math.log(d1),
      logPeak: Math.log(peak),
      to: t,
      pitch0: cam.pitch,
      yaw0: cam.yaw,
      yawDelta: (() => {
        const ay = arrivalYaw(t);
        return ay === undefined ? 0 : ((((ay - cam.yaw) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
      })(),
      t: 0,
      dur: clamp(1.5 + decades * 0.28, 2, 9),
      switched: false,
      fromInToFrame: null,
    };
  }

  function jumpTo(i: number): void {
    const t = u.targets[i];
    retarget = null;
    exitArmed = false;
    cam.frame = t.frame;
    cam.focus = [...t.pos] as V3;
    cam.dist = t.dist;
    cam.pitch = t.pitch;
    const ay = arrivalYaw(t);
    if (ay !== undefined) cam.yaw = ay;
    activeTarget = i;
    focusName = t.name;
  }

  function toggleTour(): void {
    touring = !touring;
    if (touring) {
      tourIndex = 0;
      tourDwell = 0;
      flyTo(0);
    }
  }

  const hud = new Hud(
    u.targets,
    (i) => {
      touring = false;
      flyTo(i);
    },
    toggleTour,
  );

  // ---- input ----
  // A press that barely moves is a click (focus what's under the cursor);
  // anything longer or farther is an orbit drag. Double-click flies there.
  let dragging = false;
  let pressed: { x: number; y: number; at: number } | null = null;
  let dragDist = 0;

  function clickFocus(px: number, py: number): void {
    const i = pickAt(px, py);
    if (i < 0) return;
    flight = null;
    touring = false;
    retargetTo(i);
  }

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    dragDist = 0;
    pressed = { x: e.offsetX, y: e.offsetY, at: performance.now() };
    canvas.classList.add('dragging');
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', (e) => {
    dragging = false;
    canvas.classList.remove('dragging');
    if (pressed && dragDist < 5 && performance.now() - pressed.at < 500) {
      clickFocus(e.offsetX, e.offsetY);
    }
    pressed = null;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dragDist += Math.abs(e.movementX) + Math.abs(e.movementY);
    if (dragDist < 5) return; // still within click slop — don't jitter the orbit
    cam.yaw -= e.movementX * 0.004;
    cam.pitch = clamp(cam.pitch + e.movementY * 0.004, -1.53, 1.53);
  });
  canvas.addEventListener('dblclick', (e) => {
    const i = pickAt(e.offsetX, e.offsetY);
    if (i < 0) return;
    touring = false;
    flyTo(i);
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      flight = null;
      touring = false;
      cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0014), MIN_DIST, MAX_DIST);
    },
    { passive: false },
  );
  const visibleCount = u.targets.filter((t) => !t.hidden).length;
  window.addEventListener('keydown', (e) => {
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= visibleCount) {
      touring = false;
      flyTo(n - 1);
    }
    if (e.key === 't' || e.key === 'T') toggleTour();
    if (e.key === '[') speedIndex = Math.max(0, speedIndex - 1);
    if (e.key === ']') speedIndex = Math.min(SPEEDS.length - 1, speedIndex + 1);
    if (e.key === 'p' || e.key === 'P') paused = !paused;
    if (e.key === 'Escape') {
      flight = null;
      retarget = null;
      touring = false;
    }
  });

  // ?goto=<slug>&dist=<meters> — every place in the universe is a URL.
  const params = new URLSearchParams(location.search);
  const goto = params.get('goto');
  if (goto) {
    const i = u.targets.findIndex((t) => t.slug === goto);
    if (i >= 0) jumpTo(i);
  }
  const distParam = parseFloat(params.get('dist') ?? '');
  if (Number.isFinite(distParam)) cam.dist = clamp(distParam, MIN_DIST, MAX_DIST);
  // ?speed=<sim seconds per real second> — snaps to the nearest preset.
  const speedParam = parseFloat(params.get('speed') ?? '');
  if (Number.isFinite(speedParam) && speedParam > 0) {
    speedIndex = SPEEDS.reduce(
      (best, s, i) => (Math.abs(Math.log(s / speedParam)) < Math.abs(Math.log(SPEEDS[best] / speedParam)) ? i : best),
      0,
    );
  }
  // ?click=fx,fy — synthetic click at fractional screen coords, fired once
  // after a few frames. Exists so headless tests can exercise picking.
  let pendingClick: number[] | null = (params.get('click') ?? '').split(',').map(parseFloat);
  if (pendingClick.length !== 2 || pendingClick.some((v) => !Number.isFinite(v))) pendingClick = null;
  let frameCount = 0;

  // ---- resize ----
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const doResize = () =>
    renderer.resize(
      Math.max(1, Math.floor(canvas.clientWidth * dpr)),
      Math.max(1, Math.floor(canvas.clientHeight * dpr)),
    );
  doResize();
  window.addEventListener('resize', doResize);

  // ---- flight update ----
  function updateFlight(dt: number): void {
    if (!flight) {
      if (touring) {
        tourDwell += dt;
        if (tourDwell > 1.6) {
          tourDwell = 0;
          tourIndex++;
          if (tourIndex >= u.targets.length || u.targets[tourIndex].hidden) {
            touring = false;
            return;
          }
          flyTo(tourIndex);
        }
      }
      return;
    }
    const f = flight;
    f.t += dt / f.dur;
    const t = clamp(f.t, 0, 1);
    const pT = smootherstep(t);
    cam.pitch = f.pitch0 + (f.to.pitch - f.pitch0) * pT;
    cam.yaw = f.yaw0 + f.yawDelta * pT;

    if (t < 0.42) {
      // phase A: zoom out, focus fixed
      const k = smootherstep(t / 0.42);
      cam.dist = Math.exp(f.logD0 + (f.logPeak - f.logD0) * k);
    } else if (t < 0.58) {
      // phase B: pan at altitude (errors invisible up here)
      if (!f.switched) {
        f.switched = true;
        f.fromInToFrame = reexpress(f.fromFrame, f.fromPos, f.to.frame);
        cam.frame = f.to.frame;
      }
      const k = smootherstep((t - 0.42) / 0.16);
      cam.dist = Math.exp(f.logPeak);
      cam.focus = lerp3(f.fromInToFrame!, f.to.pos, k);
    } else {
      // phase C: zoom in on the target
      if (!f.switched) {
        f.switched = true;
        cam.frame = f.to.frame;
      }
      cam.focus = [...f.to.pos] as V3;
      const k = smootherstep((t - 0.58) / 0.42);
      cam.dist = Math.exp(f.logPeak + (f.logD1 - f.logPeak) * k);
    }
    if (f.t >= 1) flight = null;
  }

  // ---- render loop ----
  const proj = { aspect: 0, mat: new Float32Array(16) };
  const globals = new Float32Array(28);
  let last = performance.now();
  const t0 = last;

  // Ground collision only applies at the surface site; resolve its frame by
  // slug (never by array position — hidden targets are appended at the end).
  const surfaceFrame = u.targets.find((t) => t.slug === 'surface')!.frame;

  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    frameCount++;
    if (pendingClick && frameCount > 5) {
      clickFocus(pendingClick[0] * canvas.clientWidth, pendingClick[1] * canvas.clientHeight);
      pendingClick = null;
    }
    if (!paused) {
      simMs += dt * SPEEDS[speedIndex] * 1000;
      updateBodies();
    }
    updateFlight(dt);
    updateRetarget(dt);
    updateAutoTarget();
    // Track the focused body: orbiting targets move, and the camera must
    // move with them (flights and glides manage the focus themselves).
    if (!flight && !retarget) {
      const t = u.targets[activeTarget];
      cam.focus = [t.pos[0], t.pos[1], t.pos[2]];
    }

    const { view, right, up } = viewRotation(cam.yaw, cam.pitch);
    const dir: V3 = [
      Math.cos(cam.pitch) * Math.sin(cam.yaw),
      Math.sin(cam.pitch),
      Math.cos(cam.pitch) * Math.cos(cam.yaw),
    ];
    const camLocal = add(cam.focus, scale(dir, cam.dist));
    if (cam.frame === surfaceFrame && !flight) camLocal[1] = Math.max(camLocal[1], 0.4);

    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    if (aspect !== proj.aspect) {
      proj.aspect = aspect;
      proj.mat = mat4Perspective(FOV, aspect, 0.05, FAR * 2);
    }
    const viewProj = mat4Mul(proj.mat, view);
    const pxFactor = (2 * Math.tan(FOV / 2)) / Math.max(1, canvas.clientHeight * dpr);

    globals.set(viewProj, 0);
    globals[16] = right[0];
    globals[17] = right[1];
    globals[18] = right[2];
    globals[19] = 0;
    globals[20] = up[0];
    globals[21] = up[1];
    globals[22] = up[2];
    globals[23] = 0;
    globals[24] = CAP;
    globals[25] = LOG_FAR_INV;
    globals[26] = (now - t0) / 1000;
    globals[27] = pxFactor;

    const data: FrameData = { globals, meshes: [], lines: [], groups: [] };

    for (const m of u.meshes) {
      const rel = relPos(m.frame, m.pos, cam.frame, camLocal);
      const d = len(rel);
      if (m.bound / Math.max(d, 1) < 2e-8) continue; // sub-pixel
      let s = 1;
      let p = rel;
      if (d > CAP) {
        const dc = CAP * (1 + Math.log(d / CAP));
        s = dc / d;
        p = scale(rel, s);
      }
      const o = new Float32Array(28);
      // column-major model = translate(p) * scale(size * s)
      o[0] = m.size[0] * s;
      o[5] = m.size[1] * s;
      o[10] = m.size[2] * s;
      o[15] = 1;
      o[12] = p[0];
      o[13] = p[1];
      o[14] = p[2];
      o[16] = m.color[0];
      o[17] = m.color[1];
      o[18] = m.color[2];
      o[19] = m.emissive;
      const sd = m.matId === 2 ? [0, 1, 0] : norm(relPos(u.sunFrame, [0, 0, 0], m.frame, m.pos));
      o[20] = sd[0];
      o[21] = sd[1];
      o[22] = sd[2];
      o[23] = m.matId;
      o[24] = m.rim;
      o[25] = m.gridScale;
      data.meshes.push({ kind: m.mesh, data: o });
    }

    for (const orbit of u.orbits) {
      const rel = relPos(orbit.frame, orbit.center, cam.frame, camLocal);
      const ratio = len(rel) / orbit.radius;
      const fade = smootherstep((ratio - 0.02) / 0.25) * (1 - smootherstep((ratio - 40) / 360));
      if (fade < 0.01) continue;
      const l = new Float32Array(8);
      l[0] = rel[0];
      l[1] = rel[1];
      l[2] = rel[2];
      l[3] = orbit.radius;
      l[4] = orbit.color[0];
      l[5] = orbit.color[1];
      l[6] = orbit.color[2];
      l[7] = orbit.alpha * fade;
      data.lines.push(l);
    }

    u.groups.forEach((g, i) => {
      const rel = relPos(g.frame, g.pos, cam.frame, camLocal);
      const gd = new Float32Array(4);
      gd[0] = rel[0];
      gd[1] = rel[1];
      gd[2] = rel[2];
      gd[3] = g.fadeExtent !== undefined ? Math.min(g.fadeExtent / Math.max(len(rel), 1), 1) : 1;
      data.groups.push({ index: groupIndex[i], data: gd });
    });

    renderer.render(data);
    hud.update(
      2 * cam.dist * Math.tan(FOV / 2),
      focusName,
      activeTarget,
      touring,
      simMs,
      SPEED_LABELS[speedIndex],
      paused,
      starCount,
    );
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

void start();
