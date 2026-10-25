/**
 * The small live visuals in the features section, loaded when the section comes near the view.
 * Two of them run the product's own code: the markup loop draws with the editor's `drawDoc`, and
 * the sizing loop asks the engine's `planCopy` what ⌘C would copy for each set of marks.
 * Each loop only runs while it's on screen, and shows a still frame under reduced motion.
 */
import { drawDoc } from '@/editor/engine/draw';
import { planCopy } from '@/editor/engine/scope';
import {
  DEFAULT_COLOR,
  DEFAULT_HIGHLIGHT_COLOR,
  DEFAULT_HIGHLIGHT_OPACITY,
  DEFAULT_SIZES_CSS,
  emptyDoc,
  type Shape,
} from '@/shared/annotations';
import { AI_MAX_LONG_EDGE_CSS } from '@/shared/limits';
import data from './demo/pageData.json';

const page = data.layouts.desktop;
const DPR = data.dpr;
const IMAGE = { w: page.css.w * DPR, h: page.css.h * DPR };
const T = page.targets;
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const SRC = `${import.meta.env.BASE_URL}${page.src}`;

/** Run `tick` on a timer only while `el` is visible. */
function whileVisible(el: Element, start: () => () => void): void {
  let stop: (() => void) | null = null;
  new IntersectionObserver(
    ([e]) => {
      if (e?.isIntersecting && !stop) stop = start();
      else if (!e?.isIntersecting && stop) {
        stop();
        stop = null;
      }
    },
    { threshold: 0.15 },
  ).observe(el);
}

// ------------------------------------------------------------------ capture strip

function capture(root: HTMLElement): void {
  const strip = root.querySelector<HTMLElement>('.cap-strip');
  const panel = root.querySelector<HTMLElement>('.cap-panel');
  if (!strip || !panel) return;
  const q = <E extends HTMLElement>(sel: string) => panel.querySelector<E>(sel);
  const film = q('.pp-film');
  const mini = q('.pp-mini');
  const edge = q('.pp-edge');
  const pct = q('[data-pct]');
  const fill = q('[data-fill]');
  const meta = q('[data-meta]');
  const phase = q('[data-phase-text]');
  const vh = 760;
  const H = page.css.h;
  const ys: number[] = [];
  for (let y = 0; y < H - vh; y += vh) ys.push(y);
  ys.push(H - vh);
  const n = ys.length;

  /** Slices `done` captured; `next` is being taken. */
  const set = (done: number) => {
    const y = ys[Math.min(Math.max(done, 0), n - 1)] ?? 0;
    const dev = done <= 0 ? 0 : ((ys[done - 1] ?? 0) + vh) / H;
    strip.style.setProperty('--vp', `${((y / vh) * 100).toFixed(2)}%`);
    strip.style.setProperty('--dev', `${(dev * 100).toFixed(2)}%`);
    panel.style.setProperty('--dev', `${(dev * 100).toFixed(2)}%`);
    const finished = done >= n;
    panel.dataset.phase = finished ? 'stitching' : 'capturing';
    if (phase) phase.textContent = finished ? 'Opening editor' : 'Capturing';
    const p = finished ? 100 : Math.floor((done / n) * 100);
    if (pct) pct.textContent = String(p);
    if (fill) fill.style.transform = `scaleX(${(p / 100).toFixed(3)})`;
    if (meta) {
      meta.textContent = finished
        ? `${n} slices · ${H.toLocaleString('en-US')} px tall`
        : `Slice ${done + 1} of ${n}`;
    }
    // The miniature follows the developing edge, like the popup's.
    if (film && mini) {
      const filmH = film.offsetHeight;
      const e = dev * filmH;
      const viewH = mini.clientHeight;
      const off = filmH > viewH ? Math.max(0, Math.min(e - viewH * 0.72, filmH - viewH)) : 0;
      film.style.transform = off ? `translateY(${(-off).toFixed(1)}px)` : '';
      if (edge) edge.style.transform = `translateY(${e.toFixed(1)}px)`;
    }
  };
  if (reduce.matches) {
    set(n);
    return;
  }
  set(0);
  whileVisible(root, () => {
    let done = 0;
    const step = () => {
      done = done > n + 3 ? 0 : done + 1;
      set(Math.min(done, n));
    };
    const t = setInterval(step, 700);
    return () => clearInterval(t);
  });
}

// ------------------------------------------------------------------ markup loop

type ToolName = 'arrow' | 'rect' | 'underline' | 'highlight' | 'pen' | 'text';
const ORDER: ToolName[] = ['arrow', 'rect', 'underline', 'highlight', 'pen', 'text'];
const px = (css: number) => css * DPR;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => 1 - (1 - t) ** 3;

/** The mark each tool draws, `t` of the way through drawing it (0..1), in image px. */
function markFor(tool: ToolName, t: number): Shape {
  const base = { id: tool, color: DEFAULT_COLOR, shadow: true } as const;
  switch (tool) {
    case 'arrow': {
      const a = { x: px(250), y: px(790) };
      const b = { x: px(T.plusPrice.x - 8), y: px(T.plusPrice.y + 30) };
      return {
        ...base,
        kind: 'arrow',
        a,
        b: { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) },
        width: px(DEFAULT_SIZES_CSS.arrow),
        bend: px(-70) * t,
        heads: 'end',
      };
    }
    case 'rect': {
      const r = T.teamButton;
      const x = px(r.x - 10);
      const y = px(r.y - 10);
      return {
        ...base,
        kind: 'rect',
        box: { x, y, w: px(r.w + 20) * t, h: px(r.h + 20) * Math.min(1, t * 1.6) },
        width: px(DEFAULT_SIZES_CSS.rect),
        fill: 'none',
      };
    }
    case 'underline': {
      const r = T.plusBilled;
      return {
        ...base,
        kind: 'underline',
        a: { x: px(r.x), y: px(r.y + 18) },
        b: { x: px(lerp(r.x, r.x + 196, t)), y: px(r.y + 18) },
        width: px(DEFAULT_SIZES_CSS.underline),
      };
    }
    case 'highlight': {
      const r = T.plusOffline;
      return {
        ...base,
        kind: 'highlight',
        color: DEFAULT_HIGHLIGHT_COLOR,
        a: { x: px(r.x + 22), y: px(r.y + 10) },
        b: { x: px(lerp(r.x + 22, r.x + 196, t)), y: px(r.y + 10) },
        thickness: px(DEFAULT_SIZES_CSS.highlight),
        opacity: DEFAULT_HIGHLIGHT_OPACITY,
      };
    }
    case 'pen': {
      const r = T.teamPrice;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2 + 2;
      const n = Math.max(2, Math.round(56 * t));
      const pts: [number, number, number][] = [];
      for (let k = 0; k < n; k++) {
        const a = -2.3 + (k / 55) * Math.PI * 2.15;
        const wob = 1 + 0.04 * Math.sin(k * 0.7);
        pts.push([px(cx + Math.cos(a) * 52 * wob), px(cy + Math.sin(a) * 34 * wob), 0.5]);
      }
      return { ...base, kind: 'pen', pts, size: px(DEFAULT_SIZES_CSS.pen), marker: false };
    }
    case 'text': {
      const full = 'Why $8 here but $10 in the table?';
      return {
        ...base,
        kind: 'text',
        at: { x: px(78), y: px(812) },
        text: full.slice(0, Math.max(1, Math.round(full.length * t))),
        size: px(22),
        weight: 700,
        style: 'outline',
      };
    }
  }
}

function markup(root: HTMLElement): void {
  const canvas = root.querySelector('canvas');
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-tool]')];
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  let bitmap: ImageBitmap | null = null;
  let drawn: ToolName[] = [];
  let current: ToolName = 'arrow';
  let t = 1;
  let pinnedUntil = 0;

  const paint = () => {
    const w = Math.round(canvas.clientWidth * devicePixelRatio);
    const h = Math.round(canvas.clientHeight * devicePixelRatio);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    // A window on the plans, wide enough for every mark.
    const cropW = 1120;
    const cropH = (cropW * h) / w;
    const view = { x: px(40), y: px(Math.max(440, 900 - cropH)), scale: w / px(cropW) };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    if (bitmap)
      ctx.drawImage(
        bitmap,
        -view.x * view.scale,
        -view.y * view.scale,
        bitmap.width * view.scale,
        bitmap.height * view.scale,
      );
    const shapes = drawn.map((k) => markFor(k, k === current ? ease(t) : 1));
    drawDoc(ctx, { ...emptyDoc('site', { ...IMAGE, dpr: DPR }), shapes }, view);
  };

  const select = (tool: ToolName) => {
    current = tool;
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  };
  const play = (tool: ToolName) => {
    select(tool);
    drawn = [...drawn.filter((k) => k !== tool), tool];
    t = reduce.matches ? 1 : 0;
    paint();
  };

  for (const b of buttons) {
    b.addEventListener('click', () => {
      pinnedUntil = performance.now() + 6000;
      play(b.dataset.tool as ToolName);
    });
  }
  new ResizeObserver(paint).observe(canvas);
  void fetch(SRC)
    .then((r) => r.blob())
    .then((b) => createImageBitmap(b))
    .then((b) => {
      bitmap = b;
      if (reduce.matches) drawn = [...ORDER];
      else if (drawn.length === 0) drawn = ['arrow'];
      paint();
    })
    .catch(() => {});

  if (reduce.matches) return;
  whileVisible(root, () => {
    let raf = 0;
    let last = performance.now();
    let hold = 0;
    const frame = (now: number) => {
      const dt = now - last;
      last = now;
      if (t < 1) {
        t = Math.min(1, t + dt / 900);
        paint();
      } else if (now > pinnedUntil) {
        hold += dt;
        const done = drawn.length === ORDER.length;
        if (hold > (done ? 2600 : 1100)) {
          hold = 0;
          if (done) {
            drawn = [];
            play('arrow');
          } else {
            const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] as ToolName;
            play(next);
          }
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  });
}

// ------------------------------------------------------------------ sizing loop

function sizing(root: HTMLElement): void {
  const col = root.querySelector<HTMLElement>('.size-col');
  const win = root.querySelector<HTMLElement>('.win');
  const marks = [...root.querySelectorAll<HTMLElement>('.dot')];
  const label = root.querySelector<HTMLElement>('[data-copy-h]');
  if (!col || !win) return;
  const rectMark = (b: { x: number; y: number; w: number; h: number }, id: string): Shape => ({
    id,
    kind: 'rect',
    color: DEFAULT_COLOR,
    shadow: true,
    box: { x: px(b.x - 8), y: px(b.y - 8), w: px(b.w + 16), h: px(b.h + 16) },
    width: px(DEFAULT_SIZES_CSS.rect),
    fill: 'none',
  });
  const scenes = [[T.plusPrice, T.teamButton], [T.refund], [T.tablePrice, T.refund]];
  const show = (k: number) => {
    const boxes = scenes[k % scenes.length] ?? [];
    const shapes = boxes.map((b, i) => rectMark(b, `m${i}`));
    const plan = planCopy({
      request: 'default',
      image: IMAGE,
      dpr: DPR,
      shapes,
      view: { x: 0, y: 0, w: IMAGE.w, h: px(800) },
      fullMaxCssHeight: AI_MAX_LONG_EDGE_CSS,
      resolution: 'css',
      scope: 'fill',
    });
    const r = plan.region;
    win.style.top = `${((r.y / IMAGE.h) * 100).toFixed(3)}%`;
    win.style.height = `${((r.h / IMAGE.h) * 100).toFixed(3)}%`;
    marks.forEach((m, i) => {
      const b = boxes[i];
      m.toggleAttribute('data-on', !!b);
      if (!b) return;
      m.style.left = `${(((b.x - 8) / page.css.w) * 100).toFixed(2)}%`;
      m.style.top = `${(((b.y - 8) / page.css.h) * 100).toFixed(2)}%`;
      m.style.width = `${(((b.w + 16) / page.css.w) * 100).toFixed(2)}%`;
      m.style.height = `${(((b.h + 16) / page.css.h) * 100).toFixed(2)}%`;
    });
    if (label) {
      const top = Math.round(r.y / DPR);
      const bottom = Math.round((r.y + r.h) / DPR);
      label.innerHTML = `${(bottom - top).toLocaleString('en-US')} <small>px, from ${top.toLocaleString('en-US')} to ${bottom.toLocaleString('en-US')}</small>`;
    }
  };
  show(0);
  if (reduce.matches) return;
  whileVisible(root, () => {
    let k = 0;
    const t = setInterval(() => show(++k), 2800);
    return () => clearInterval(t);
  });
}

export function startFeatureVisuals(): void {
  const q = (name: string) => document.querySelector<HTMLElement>(`[data-visual="${name}"]`);
  const c = q('capture');
  const m = q('tools');
  const s = q('size');
  if (c) capture(c);
  if (m) markup(m);
  if (s) sizing(s);
}
