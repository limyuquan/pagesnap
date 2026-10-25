/**
 * The capture panel that drops from the toolbar icon, mirroring the extension's popup
 * (src/entrypoints/popup): the same skeleton, words, live miniature with its developing edge,
 * eased progress with a creep toward the next slice, the ETA rule and Esc / Stop.
 */
import { useEffect, useRef } from 'react';
import type { CaptureProgress } from './capture';
import { pageBitmap } from './capture';
import type { PageLayout } from './page';
import { PAGE_HOST } from './page';

const MINI_W = 52;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function plural(n: number, word: string) {
  return n === 1 ? word : `${word}s`;
}

function phaseText(p: CaptureProgress, stopping: boolean): string {
  if (stopping) return 'Stopping…';
  switch (p.phase) {
    case 'preparing':
      return 'Preparing the page…';
    case 'capturing':
      return 'Capturing';
    case 'stitching':
      return 'Stitching…';
    case 'opening':
      return 'Opening editor';
  }
}

export function ProgressPanel({
  progress,
  page,
  stopping,
  onStop,
}: {
  progress: CaptureProgress;
  page: PageLayout;
  stopping: boolean;
  onStop: () => void;
}) {
  const fillRef = useRef<HTMLElement>(null);
  const pctRef = useRef<HTMLSpanElement>(null);
  const metaRef = useRef<HTMLParagraphElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const filmRef = useRef<HTMLDivElement>(null);
  const edgeRef = useRef<HTMLDivElement>(null);
  const miniRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ progress, stopping, sliceAt: performance.now(), totalSince: 0 });
  const thumbs = useRef(new Map<number, HTMLCanvasElement>());

  // Keep the latest props for the animation loop.
  const prev = stateRef.current.progress;
  if (progress.done !== prev.done) stateRef.current.sliceAt = progress.lastSliceAt;
  if (progress.total !== prev.total) stateRef.current.totalSince = progress.done;
  stateRef.current.progress = progress;
  stateRef.current.stopping = stopping;

  // Bar, percentage and the "Slice 3 of 6 · about 2 s left" line, eased like the popup.
  useEffect(() => {
    let raf = 0;
    let shown = 0;
    let last = 0;
    let etaSecs: number | null = null;
    const full = (p: CaptureProgress) => p.phase === 'stitching' || p.phase === 'opening';
    const fraction = (now: number) => {
      const { progress: p, stopping: stop, sliceAt } = stateRef.current;
      if (full(p)) return 1;
      if (p.total <= 0) return 0;
      let f = p.done / p.total;
      if (p.phase === 'capturing' && !stop && p.done < p.total && !reducedMotion()) {
        const t = Math.min(1, (now - sliceAt) / (p.cadenceMs ?? 520));
        f += (0.85 * (1 - (1 - t) * (1 - t))) / p.total;
      }
      return Math.min(f, 0.995);
    };
    const eta = (now: number): string | null => {
      const { progress: p, stopping: stop, sliceAt, totalSince } = stateRef.current;
      if (p.cadenceMs == null || p.done < 3 || p.done - totalSince < 2 || stop) {
        etaSecs = null;
        return null;
      }
      const remaining =
        (p.total - p.done) * p.cadenceMs - Math.min(p.cadenceMs, now - sliceAt) + 250;
      if (remaining < 600) return etaSecs != null ? 'almost done' : null;
      let secs = Math.ceil(remaining / 1000);
      if (etaSecs != null && secs === etaSecs + 1) secs = etaSecs;
      etaSecs = secs;
      return `about ${secs} s left`;
    };
    const frame = (now: number) => {
      const p = stateRef.current.progress;
      const target = fraction(now);
      const dt = Math.min(64, last ? now - last : 16);
      last = now;
      shown = reducedMotion() ? target : shown + (target - shown) * (1 - Math.exp(-dt / 110));
      if (Math.abs(target - shown) < 0.0005) shown = target;
      if (fillRef.current) fillRef.current.style.transform = `scaleX(${shown.toFixed(4)})`;
      const pct = full(p) && shown >= 0.995 ? 100 : Math.min(99, Math.floor(shown * 100));
      if (pctRef.current && pctRef.current.textContent !== String(pct)) {
        pctRef.current.textContent = String(pct);
      }
      barRef.current?.setAttribute('aria-valuenow', String(pct));
      let meta = ' ';
      if (p.phase === 'capturing') {
        const line = `Slice ${Math.min(p.done + 1, p.total)} of ${p.total}`;
        const e = eta(now);
        meta = e ? `${line} · ${e}` : line;
      } else if (full(p)) {
        meta = `${p.total} ${plural(p.total, 'slice')} · ${page.css.h.toLocaleString('en-US')} px tall`;
      }
      if (metaRef.current && metaRef.current.textContent !== meta) {
        metaRef.current.textContent = meta;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [page.css.h]);

  // The miniature: each slice develops in as it lands; the strip follows the newest one.
  useEffect(() => {
    const film = filmRef.current;
    const mini = miniRef.current;
    if (!film || !mini) return;
    const scale = MINI_W / page.css.w;
    const filmH = page.css.h * scale;
    let edge = 0;
    for (const s of progress.slices) {
      edge = Math.max(edge, (s.y + s.h) * scale);
      if (thumbs.current.has(s.i)) continue;
      const node = document.createElement('canvas');
      thumbs.current.set(s.i, node);
      const dpr = Math.min(3, devicePixelRatio || 1);
      node.style.left = '0px';
      node.style.top = `${(s.y * scale).toFixed(2)}px`;
      node.style.width = `${MINI_W}px`;
      node.style.height = `${(s.h * scale).toFixed(2)}px`;
      node.style.zIndex = String(s.i + 1);
      void pageBitmap(page.src)
        .then((bmp) =>
          createImageBitmap(bmp, 0, Math.round(s.y * page.dpr), bmp.width, s.h * page.dpr, {
            resizeWidth: Math.round(MINI_W * dpr),
            resizeHeight: Math.max(1, Math.round(s.h * scale * dpr)),
            resizeQuality: 'medium',
          }),
        )
        .then((thumb) => {
          node.width = thumb.width;
          node.height = thumb.height;
          const ctx = node.getContext('bitmaprenderer');
          if (ctx) ctx.transferFromImageBitmap(thumb);
          else thumb.close();
          film.insertBefore(node, edgeRef.current);
        })
        .catch(() => {});
    }
    const ghost = film.querySelector<HTMLElement>('.pp-ghost');
    if (ghost) ghost.style.height = `${filmH.toFixed(1)}px`;
    const viewH = mini.clientHeight;
    const offset = filmH > viewH ? Math.max(0, Math.min(edge - viewH * 0.72, filmH - viewH)) : 0;
    film.style.transform = offset ? `translateY(${(-offset).toFixed(1)}px)` : '';
    mini.toggleAttribute('data-scrolled', offset > 0.5);
    if (edgeRef.current) edgeRef.current.style.transform = `translateY(${edge.toFixed(1)}px)`;
  }, [progress.slices, page]);

  return (
    <section
      className="pp"
      data-phase={stopping ? 'stopping' : progress.phase}
      aria-labelledby="pp-phase"
      data-testid="demo-progress"
    >
      <div className="pp-mini" ref={miniRef} aria-hidden="true">
        <div className="pp-film" ref={filmRef}>
          <div className="pp-ghost" />
          <div className="pp-edge" ref={edgeRef} />
        </div>
      </div>
      <div className="pp-info">
        <div className="pp-top">
          <p className="pp-phase" id="pp-phase" aria-live="polite">
            {phaseText(progress, stopping)}
          </p>
          {(progress.phase === 'preparing' || progress.phase === 'capturing') && !stopping && (
            <button
              type="button"
              className="pp-act"
              aria-label="Stop capture"
              aria-keyshortcuts="Escape"
              onClick={onStop}
            >
              <span>Stop</span>
              <kbd>esc</kbd>
            </button>
          )}
        </div>
        <p className="pp-pct tnum">
          <span ref={pctRef}>0</span>
          <span className="pp-pct-u">%</span>
        </p>
        <div className="pp-page">
          <p className="pp-title">{page.title}</p>
          <p className="pp-host">{PAGE_HOST}</p>
        </div>
        <div
          className="pp-bar"
          ref={barRef}
          role="progressbar"
          aria-label="Capture progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={0}
        >
          <i ref={fillRef} />
        </div>
        <p className="pp-meta tnum" ref={metaRef}>
          {' '}
        </p>
      </div>
    </section>
  );
}
