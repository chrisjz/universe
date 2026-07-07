// HUD: live scale readout + target buttons. The scale readout is the soul of
// the prototype — it tells you where you are across 27 orders of magnitude.

import { Target } from './scene';

const AU = 1.496e11;
const LY = 9.4607e15;

export function formatWidth(m: number): { main: string; exp: string } {
  const exp = `≈ 10^${Math.round(Math.log10(m))} m`;
  const f = (v: number, u: string) => ({
    main: `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${u}`,
    exp,
  });
  if (m < 1e3) return f(m, 'm');
  if (m < 1e8) return f(m / 1e3, 'km');
  if (m < 0.08 * AU) return f(m / 1e6, 'thousand km');
  if (m < 0.25 * LY) return f(m / AU, 'AU');
  if (m < 1e3 * LY) return f(m / LY, 'light-years');
  if (m < 1e6 * LY) return f(m / (1e3 * LY), 'thousand ly');
  if (m < 1e9 * LY) return f(m / (1e6 * LY), 'million ly');
  return f(m / (1e9 * LY), 'billion ly');
}

const CONTEXTS: [number, string][] = [
  [30, 'human scale'],
  [3e4, 'landscape'],
  [3e7, 'planetary'],
  [1e10, 'orbital space'],
  [1e13, 'planetary system'],
  [1e15, 'outer system'],
  [1e18, 'interstellar'],
  [1e21, 'galactic'],
  [5e23, 'intergalactic'],
  [5e25, 'cosmic web'],
  [Infinity, 'observable universe'],
];

export function contextFor(width: number): string {
  for (const [lim, name] of CONTEXTS) if (width < lim) return name;
  return 'observable universe';
}

export class Hud {
  private widthEl = document.querySelector('#scale .width') as HTMLElement;
  private expEl = document.querySelector('#scale .exp') as HTMLElement;
  private ctxEl = document.querySelector('#scale .ctx') as HTMLElement;
  private timeEl = document.querySelector('#scale .time') as HTMLElement;
  private nameEl = document.querySelector('#focus .name') as HTMLElement;
  private buttons = new Map<number, HTMLButtonElement>();
  private tourBtn!: HTMLButtonElement;

  constructor(targets: Target[], onTarget: (i: number) => void, onTour: () => void) {
    const bar = document.getElementById('targets')!;
    targets.forEach((t, i) => {
      if (t.hidden) return;
      const b = document.createElement('button');
      b.textContent = `${i + 1} ${t.name}`;
      b.addEventListener('click', () => onTarget(i));
      bar.appendChild(b);
      this.buttons.set(i, b);
    });
    this.tourBtn = document.createElement('button');
    this.tourBtn.textContent = 'T GRAND TOUR';
    this.tourBtn.className = 'tour';
    this.tourBtn.addEventListener('click', onTour);
    bar.appendChild(this.tourBtn);
  }

  update(
    viewWidth: number,
    focusName: string,
    activeTarget: number,
    touring: boolean,
    simMs: number,
    speedLabel: string,
    paused: boolean,
    starCount: number,
  ): void {
    const w = formatWidth(viewWidth);
    this.widthEl.textContent = w.main;
    this.expEl.textContent = `field of view ${w.exp}`;
    this.ctxEl.textContent = contextFor(viewWidth);
    this.nameEl.textContent = focusName;
    const d = new Date(simMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
    const stars = starCount > 0 ? ` · ${Math.round(starCount / 1000)}k stars` : '';
    this.timeEl.textContent = (paused ? `${date} · paused` : `${date} · ${speedLabel}`) + stars;
    for (const [i, b] of this.buttons) b.classList.toggle('active', i === activeTarget);
    this.tourBtn.textContent = touring ? 'T STOP TOUR' : 'T GRAND TOUR';
  }
}
