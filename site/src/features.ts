/**
 * The small live visuals in the features section, loaded when the section comes near the view.
 * Two of them run the product's own code: the markup loop draws with the editor's `drawDoc`, and
 * the sizing loop asks the engine's `planCopy` what ⌘C would copy for each set of marks.
 * Loops only run while on screen; under reduced motion each shows its finished state.
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

type Layout = (typeof data.layouts)['desktop'];
type Box = { x: number; y: number; w: number; h: number };

const DPR = data.dpr;
const desktop = data.layouts.desktop;
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const srcOf = (l: Layout) => `${import.meta.env.BASE_URL}${l.src}`;
const px = (css: number) => css * DPR;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => 1 - (1 - t) ** 3;

/** Start `start` while `el` is on screen; stop it when it leaves. */
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
    { threshold: 0.2 },
  ).observe(el);
}

const bitmaps = new Map<string, Promise<ImageBitmap>>();
function bitmap(src: string): Promise<ImageBitmap> {
  let p = bitmaps.get(src);
  if (!p) {
    p = fetch(src)
      .then((r) => r.blob())
      .then((b) => createImageBitmap(b));
    bitmaps.set(src, p);
  }
  return p;
}

// ------------------------------------------------------------------ stitching comparison

/** Screen by screen down the page; the plain stitch gets the top bar again on every screen. */
function capture(root: HTMLElement): void {
  const naive = root.querySelector<HTMLElement>('[data-naive]');
  const strips = [...root.querySelectorAll<HTMLElement>('.stitch-strip')];
  if (!naive) return;
  const H = desktop.css.h;
  const vh = 760;
  const ys: number[] = [];
  for (let y = 0; y < H - vh; y += vh) ys.push(y);
  ys.push(H - vh);
  const src = `url("${srcOf(desktop)}")`;
  const repeats = ys.slice(1).map((y, i) => {
    const hdr = document.createElement('i');
    hdr.className = 'hdr';
    hdr.style.setProperty('--y', `${((y / H) * 100).toFixed(3)}%`);
    hdr.style.setProperty('--src', src);
    naive.append(hdr);
    let mk: HTMLElement | null = null;
    if (i === 1) {
      mk = document.createElement('i');
      mk.className = 'mk';
      mk.style.setProperty('--y', `${((y / H) * 100).toFixed(3)}%`);
      naive.append(mk);
    }
    return { y, hdr, mk };
  });
  /** `done` screens taken (0..n). */
  const set = (done: number) => {
    const bottom = done <= 0 ? 0 : Math.min(H, (ys[done - 1] ?? 0) + vh);
    for (const s of strips) s.style.setProperty('--dev', `${((bottom / H) * 100).toFixed(2)}%`);
    for (const r of repeats) {
      r.hdr.style.setProperty('--on', r.y < bottom ? '1' : '0');
      r.mk?.style.setProperty('--on', done >= ys.length ? '1' : '0');
    }
  };
  if (reduce.matches) {
    set(ys.length);
    return;
  }
  set(0);
  whileVisible(root, () => {
    let done = 0;
    let hold = 0;
    const t = setInterval(() => {
      if (done < ys.length) set(++done);
      else if (++hold > 5) {
        hold = 0;
        done = 0;
        set(0);
      }
    }, 620);
    return () => clearInterval(t);
  });
}

// ------------------------------------------------------------------ markup loop

type ToolName = 'arrow' | 'rect' | 'underline' | 'highlight' | 'pen' | 'text';
const ORDER: ToolName[] = ['arrow', 'rect', 'underline', 'highlight', 'pen', 'text'];
const NAMES: Record<ToolName, [string, string]> = {
  arrow: ['A', 'Arrow'],
  rect: ['R', 'Box'],
  underline: ['U', 'Underline'],
  highlight: ['H', 'Highlighter'],
  pen: ['P', 'Pen'],
  text: ['T', 'Text'],
};

interface Scene {
  layout: Layout;
  /** Page CSS px shown: left, top, width. The height follows the canvas. */
  crop: { x: number; y: number; w: number };
  arrow: { a: [number, number]; b: [number, number]; bend: number };
  text: { at: [number, number]; size: number; body: string };
}

const SCENES: Record<'wide' | 'narrow', Scene> = {
  wide: {
    layout: data.layouts.desktop,
    crop: { x: 40, y: 440, w: 1120 },
    arrow: { a: [318, 868], b: [452, 618], bend: -60 },
    text: { at: [78, 876], size: 21, body: 'Why $8 here but $10 in the table?' },
  },
  narrow: {
    layout: data.layouts.mobile,
    crop: { x: 0, y: 925, w: 390 },
    arrow: { a: [342, 952], b: [116, 974], bend: -22 },
    text: { at: [196, 958], size: 17, body: 'Why $8?' },
  },
};

/** The mark each tool draws, `t` of the way through drawing it (0..1), in image px. */
function markFor(tool: ToolName, t: number, sc: Scene): Shape {
  const T = sc.layout.targets;
  const base = { id: tool, color: DEFAULT_COLOR, shadow: true } as const;
  const pt = ([x, y]: [number, number]) => ({ x: px(x), y: px(y) });
  switch (tool) {
    case 'arrow': {
      const a = pt(sc.arrow.a);
      const b = pt(sc.arrow.b);
      return {
        ...base,
        kind: 'arrow',
        a,
        b: { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) },
        width: px(DEFAULT_SIZES_CSS.arrow),
        bend: px(sc.arrow.bend) * t,
        heads: 'end',
      };
    }
    case 'rect': {
      const r: Box = T.plusButton;
      return {
        ...base,
        kind: 'rect',
        box: {
          x: px(r.x - 8),
          y: px(r.y - 8),
          w: px(r.w + 16) * t,
          h: px(r.h + 16) * Math.min(1, t * 1.6),
        },
        width: px(DEFAULT_SIZES_CSS.rect),
        fill: 'none',
      };
    }
    case 'underline': {
      const r: Box = T.plusBilled;
      const y = r.y + 17;
      return {
        ...base,
        kind: 'underline',
        a: { x: px(r.x), y: px(y) },
        b: { x: px(lerp(r.x, r.x + Math.min(196, r.w - 40), t)), y: px(y) },
        width: px(DEFAULT_SIZES_CSS.underline - 1),
      };
    }
    case 'highlight': {
      const r: Box = T.plusOffline;
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
      const r: Box = T.plusPrice;
      const cx = r.x + 34;
      const cy = r.y + r.h / 2 + 2;
      const n = Math.max(2, Math.round(56 * t));
      const pts: [number, number, number][] = [];
      for (let k = 0; k < n; k++) {
        const a = -2.3 + (k / 55) * Math.PI * 2.15;
        const wob = 1 + 0.04 * Math.sin(k * 0.7);
        pts.push([px(cx + Math.cos(a) * 46 * wob), px(cy + Math.sin(a) * 32 * wob), 0.5]);
      }
      return { ...base, kind: 'pen', pts, size: px(DEFAULT_SIZES_CSS.pen - 1), marker: false };
    }
    case 'text': {
      const full = sc.text.body;
      return {
        ...base,
        kind: 'text',
        at: pt(sc.text.at),
        text: full.slice(0, Math.max(1, Math.round(full.length * t))),
        size: px(sc.text.size),
        weight: 700,
        style: 'outline',
      };
    }
  }
}

function markup(root: HTMLElement): void {
  const canvas = root.querySelector('canvas');
  const key = root.querySelector<HTMLElement>('[data-key]');
  const name = root.querySelector<HTMLElement>('[data-name]');
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  const narrow = matchMedia('(max-width: 640px)');
  const scene = () => SCENES[narrow.matches ? 'narrow' : 'wide'];
  let drawn: ToolName[] = reduce.matches ? [...ORDER] : ['arrow'];
  let current: ToolName = reduce.matches ? 'text' : 'arrow';
  let t = reduce.matches ? 1 : 0;
  let img: ImageBitmap | null = null;
  let imgFor: string | null = null;

  const paint = () => {
    const sc = scene();
    const src = srcOf(sc.layout);
    if (imgFor !== src) {
      imgFor = src;
      img = null;
      void bitmap(src).then((b) => {
        if (imgFor === src) {
          img = b;
          paint();
        }
      });
    }
    const w = Math.round(canvas.clientWidth * devicePixelRatio);
    const h = Math.round(canvas.clientHeight * devicePixelRatio);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const view = { x: px(sc.crop.x), y: px(sc.crop.y), scale: w / px(sc.crop.w) };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    if (img) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        img,
        -view.x * view.scale,
        -view.y * view.scale,
        img.width * view.scale,
        img.height * view.scale,
      );
    }
    const shapes = drawn.map((k) => markFor(k, k === current ? ease(t) : 1, sc));
    const image = { w: px(sc.layout.css.w), h: px(sc.layout.css.h), dpr: DPR };
    drawDoc(ctx, { ...emptyDoc('site', image), shapes }, view);
  };
  const label = () => {
    const [k, n] = NAMES[current];
    if (key) key.textContent = k;
    if (name) name.textContent = n;
  };
  label();
  new ResizeObserver(paint).observe(canvas);
  narrow.addEventListener('change', paint);
  paint();
  if (reduce.matches) return;

  whileVisible(root, () => {
    let raf = 0;
    let last = performance.now();
    let hold = 0;
    const frame = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      if (t < 1) {
        t = Math.min(1, t + dt / 900);
        paint();
      } else {
        hold += dt;
        const all = drawn.length === ORDER.length;
        if (hold > (all ? 2800 : 1000)) {
          hold = 0;
          const next = all ? 'arrow' : (ORDER[ORDER.indexOf(current) + 1] as ToolName);
          drawn = all ? [next] : [...drawn, next];
          current = next;
          t = 0;
          label();
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
  const win = root.querySelector<HTMLElement>('.win');
  const br = root.querySelector<HTMLElement>('.br-win');
  const marks = [...root.querySelectorAll<HTMLElement>('.dot')];
  if (!win) return;
  const T = desktop.targets;
  const image = { w: px(desktop.css.w), h: px(desktop.css.h) };
  const rectMark = (b: Box, id: string): Shape => ({
    id,
    kind: 'rect',
    color: DEFAULT_COLOR,
    shadow: true,
    box: { x: px(b.x - 8), y: px(b.y - 8), w: px(b.w + 16), h: px(b.h + 16) },
    width: px(DEFAULT_SIZES_CSS.rect),
    fill: 'none',
  });
  const scenes: Box[][] = [[T.plusPrice, T.teamButton], [T.refund], [T.tablePrice, T.refund]];
  const show = (k: number) => {
    const boxes = scenes[k % scenes.length] ?? [];
    const plan = planCopy({
      request: 'default',
      image,
      dpr: DPR,
      shapes: boxes.map((b, i) => rectMark(b, `m${i}`)),
      view: { x: 0, y: 0, w: image.w, h: px(800) },
      fullMaxCssHeight: AI_MAX_LONG_EDGE_CSS,
      resolution: 'css',
      scope: 'fill',
    });
    const r = plan.region;
    const top = `${((r.y / image.h) * 100).toFixed(3)}%`;
    const height = `${((r.h / image.h) * 100).toFixed(3)}%`;
    win.style.top = top;
    win.style.height = height;
    if (br) {
      br.style.top = top;
      br.style.height = height;
    }
    for (const [i, m] of marks.entries()) {
      const b = boxes[i];
      m.toggleAttribute('data-on', !!b);
      if (!b) continue;
      m.style.left = `${(((b.x - 8) / desktop.css.w) * 100).toFixed(2)}%`;
      m.style.top = `${(((b.y - 8) / desktop.css.h) * 100).toFixed(2)}%`;
      m.style.width = `${(((b.w + 16) / desktop.css.w) * 100).toFixed(2)}%`;
      m.style.height = `${(((b.h + 16) / desktop.css.h) * 100).toFixed(2)}%`;
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
