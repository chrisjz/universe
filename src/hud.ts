// HUD: live scale readout + target buttons. The scale readout is the soul of
// the prototype — it tells you where you are across 27 orders of magnitude.

import { Target } from './scene';

const AU = 1.496e11;
const LY = 9.4607e15;
const YEAR_MS = 3.15576e10;

// Beyond ±10,000 years a calendar date stops meaning anything — switch to
// cosmic phrasing ("2.31 Myr from now", "13.79 Gyr ago").
export function formatDeepTime(msFromNow: number): string {
  const y = msFromNow / YEAR_MS;
  const a = Math.abs(y);
  const num =
    a < 1e6
      ? `${Math.round(a).toLocaleString('en-US')} yr`
      : a < 1e9
        ? `${(a / 1e6).toPrecision(3)} Myr`
        : `${(a / 1e9).toPrecision(4)} Gyr`;
  return y < 0 ? `${num} ago` : `${num} from now`;
}

export function formatWidth(m: number): { main: string; exp: string } {
  const exp = `≈ 10^${Math.round(Math.log10(m))} m`;
  const f = (v: number, u: string) => ({
    main: `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${u}`,
    exp,
  });
  if (m < 1e-12) return f(m / 1e-15, 'fm');
  if (m < 1e-9) return f(m / 1e-12, 'pm');
  if (m < 1e-6) return f(m / 1e-9, 'nm');
  if (m < 1e-3) return f(m / 1e-6, 'µm');
  if (m < 0.01) return f(m / 1e-3, 'mm');
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
  [2.5e-15, 'the edge of the known'],
  [5e-13, 'subatomic'],
  [2e-9, 'atomic'],
  [5e-7, 'molecular'],
  [2e-3, 'microscopic'],
  [0.5, 'the weave'],
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
  private srcEl = document.querySelector('#focus .src') as HTMLElement;
  private seamEl = document.getElementById('seam') as HTMLElement;
  private seamBtn!: HTMLButtonElement;
  private buttons = new Map<number, HTMLButtonElement>();
  private tourBtn!: HTMLButtonElement;

  private searchEl = document.getElementById('search') as HTMLElement;
  private searchInput = document.querySelector('#search input') as HTMLInputElement;
  private searchList = document.querySelector('#search ul') as HTMLElement;
  private searchResults: number[] = [];
  private searchSel = 0;
  private targets: Target[];
  private onTarget: (i: number) => void;

  private constBtn!: HTMLButtonElement;

  constructor(
    targets: Target[],
    onTarget: (i: number) => void,
    onTour: () => void,
    onTime: (action: 'slower' | 'pause' | 'faster' | 'share') => void,
    onSeam: () => void,
    onConstellations: () => void,
  ) {
    this.targets = targets;
    this.onTarget = onTarget;
    // On-screen time controls: [ ] and P have no keys on touch devices.
    document.querySelectorAll<HTMLButtonElement>('#scale .timectl button').forEach((b) => {
      b.addEventListener('click', () => onTime(b.dataset.t as 'slower' | 'pause' | 'faster' | 'share'));
    });
    // Layout: [search] [scrollable target buttons] [tour] — search and tour
    // stay pinned; the target list scrolls between them.
    const bar = document.getElementById('targets')!;
    const searchBtn = document.createElement('button');
    searchBtn.textContent = '🔍';
    searchBtn.title = 'search ( / )';
    searchBtn.addEventListener('click', () => this.openSearch());
    bar.appendChild(searchBtn);
    this.seamBtn = document.createElement('button');
    this.seamBtn.textContent = '◐';
    this.seamBtn.title = 'the honest seam: what is measured vs imagined ( X )';
    this.seamBtn.addEventListener('click', onSeam);
    bar.appendChild(this.seamBtn);
    this.constBtn = document.createElement('button');
    this.constBtn.textContent = '✦';
    this.constBtn.title = 'constellations ( C )';
    this.constBtn.addEventListener('click', onConstellations);
    bar.appendChild(this.constBtn);
    const scroller = document.createElement('div');
    scroller.className = 'scroller';
    bar.appendChild(scroller);
    // Plain names, in tour order — the bar has outgrown number-key labels
    // (the tour keeps adding stops; search (/) reaches everything by name).
    targets.forEach((t, i) => {
      if (t.hidden && !t.button) return;
      const b = document.createElement('button');
      b.textContent = t.name;
      b.addEventListener('click', () => onTarget(i));
      scroller.appendChild(b);
      this.buttons.set(i, b);
    });
    this.tourBtn = document.createElement('button');
    this.tourBtn.textContent = 'T TOUR';
    this.tourBtn.className = 'tour';
    this.tourBtn.addEventListener('click', onTour);
    bar.appendChild(this.tourBtn);
    this.wireSearch();
  }

  setSeam(on: boolean): void {
    this.seamEl.style.display = on ? 'block' : 'none';
    this.seamBtn.classList.toggle('active', on);
  }

  setConstellations(on: boolean): void {
    this.constBtn.classList.toggle('active', on);
  }

  // ---- search: every target (all 195 named stars included) is reachable ----
  isSearchOpen(): boolean {
    return this.searchEl.style.display === 'flex';
  }

  openSearch(initial = ''): void {
    this.searchEl.style.display = 'flex';
    this.searchInput.value = initial;
    this.renderResults(initial);
    this.searchInput.focus();
  }

  closeSearch(): void {
    this.searchEl.style.display = 'none';
    this.searchInput.blur();
    // Mobile keyboards can scroll the layout viewport while the input is
    // focused; put the page back so the fixed bottom bar stays on screen.
    window.scrollTo(0, 0);
  }

  private renderResults(q: string): void {
    const query = q.trim().toLowerCase();
    const scored: [number, number][] = [];
    this.targets.forEach((t, i) => {
      const name = t.name.toLowerCase();
      if (query === '') {
        if (!t.hidden || t.button) scored.push([i, 1]);
        return;
      }
      if (name.startsWith(query)) scored.push([i, 0]);
      else if (name.includes(query) || t.slug.includes(query)) scored.push([i, 1]);
    });
    scored.sort((a, b) => a[1] - b[1]);
    this.searchResults = scored.slice(0, 8).map(([i]) => i);
    this.searchSel = 0;
    this.searchList.innerHTML = '';
    this.searchResults.forEach((ti, ri) => {
      const li = document.createElement('li');
      li.textContent = this.targets[ti].name;
      li.classList.toggle('sel', ri === this.searchSel);
      li.addEventListener('click', () => {
        this.closeSearch();
        this.onTarget(ti);
      });
      this.searchList.appendChild(li);
    });
  }

  private wireSearch(): void {
    // Tap/click anywhere outside the panel dismisses it — on touch screens
    // there is no Escape key.
    document.addEventListener('pointerdown', (e) => {
      if (this.isSearchOpen() && !this.searchEl.contains(e.target as Node)) this.closeSearch();
    });
    this.searchInput.addEventListener('input', () => this.renderResults(this.searchInput.value));
    this.searchInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.closeSearch();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = this.searchResults.length;
        if (n) this.searchSel = (this.searchSel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        [...this.searchList.children].forEach((el, i) => el.classList.toggle('sel', i === this.searchSel));
      }
      if (e.key === 'Enter' && this.searchResults.length) {
        const ti = this.searchResults[this.searchSel];
        this.closeSearch();
        this.onTarget(ti);
      }
    });
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
    source: string,
  ): void {
    const w = formatWidth(viewWidth);
    this.widthEl.textContent = w.main;
    this.expEl.textContent = `field of view ${w.exp}`;
    this.ctxEl.textContent = contextFor(viewWidth);
    this.nameEl.textContent = focusName;
    this.srcEl.textContent = source;
    const msFromNow = simMs - Date.now();
    let date: string;
    if (Math.abs(msFromNow) < 1e4 * YEAR_MS) {
      const d = new Date(simMs);
      const pad = (n: number) => String(n).padStart(2, '0');
      date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
    } else {
      date = formatDeepTime(msFromNow);
    }
    const stars = starCount > 0 ? ` · ${Math.round(starCount / 1000)}k stars` : '';
    this.timeEl.textContent = (paused ? `${date} · paused` : `${date} · ${speedLabel}`) + stars;
    const pauseBtn = document.querySelector<HTMLButtonElement>('#scale .timectl button[data-t="pause"]');
    if (pauseBtn) pauseBtn.textContent = paused ? '▶' : '⏸';
    for (const [i, b] of this.buttons) b.classList.toggle('active', i === activeTarget);
    this.tourBtn.textContent = touring ? 'T STOP' : 'T TOUR';
  }
}
