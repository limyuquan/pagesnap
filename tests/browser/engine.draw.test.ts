import { describe, expect, it } from 'vitest';
import { drawDoc } from '@/editor/engine/draw';
import { shapeBounds } from '@/editor/engine/geometry';
import { type AnnotationDoc, emptyDoc, type Shape } from '@/shared/annotations';

const RED: [number, number, number] = [0xff, 0x3b, 0x30];
const YELLOW: [number, number, number] = [0xff, 0xd6, 0x0a];

function doc(shapes: Shape[], dpr = 2): AnnotationDoc {
  return { ...emptyDoc('s', { w: 1000, h: 1000, dpr }), shapes };
}

function canvas(fill = '#ffffff', w = 1000, h = 1000) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('no ctx');
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  return ctx;
}

function px(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
): [number, number, number] {
  const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
}

const near = (a: readonly number[], b: readonly number[], tol = 3) =>
  a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= tol);

const base = { color: '#FF3B30', shadow: false } as const;

describe('drawDoc pixel output', () => {
  it('draws an arrow at known image coords, with its head at b', () => {
    const ctx = canvas();
    drawDoc(
      ctx,
      doc([
        {
          ...base,
          id: 'a',
          kind: 'arrow',
          a: { x: 100, y: 500 },
          b: { x: 700, y: 500 },
          width: 12,
          bend: 0,
          heads: 'end',
        },
      ]),
      { x: 0, y: 0, scale: 1 },
    );
    expect(px(ctx, 300, 500)).toEqual(RED); // shaft
    expect(px(ctx, 300, 520)).toEqual([255, 255, 255]); // outside the 12-px stroke
    // Head: at least 18 CSS px × dpr 2 = 48 px long (4 × 12), wider than the shaft.
    expect(px(ctx, 680, 510)).toEqual(RED);
    expect(px(ctx, 720, 500)).toEqual([255, 255, 255]); // nothing past the tip
  });

  it('applies the view: offset and scale map image px to output px', () => {
    const ctx = canvas('#ffffff', 400, 400);
    drawDoc(
      ctx,
      doc([
        {
          ...base,
          id: 'r',
          kind: 'rect',
          box: { x: 400, y: 400, w: 400, h: 400 },
          width: 20,
          fill: 'none',
        },
      ]),
      { x: 300, y: 300, scale: 0.5 },
    );
    // Left edge x = (400 - 300) * 0.5 = 50, stroke 10 px wide.
    expect(px(ctx, 50, 150)).toEqual(RED);
    expect(px(ctx, 150, 150)).toEqual([255, 255, 255]); // hollow inside
  });

  it('highlighter multiplies yellow over the base so dark text stays readable', () => {
    const ctx = canvas();
    ctx.fillStyle = '#4363d8';
    ctx.fillRect(0, 0, 1000, 500);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 500, 1000, 500);
    drawDoc(
      ctx,
      doc([
        {
          ...base,
          color: '#FFD60A',
          id: 'h',
          kind: 'highlight',
          a: { x: 100, y: 500 },
          b: { x: 900, y: 500 },
          thickness: 200,
          opacity: 0.45,
        },
      ]),
      { x: 0, y: 0, scale: 1 },
    );
    const blue = [0x43, 0x63, 0xd8];
    const expected = blue.map((c, i) => c * (1 - 0.45 + (0.45 * (YELLOW[i] ?? 0)) / 255));
    expect(near(px(ctx, 500, 450), expected, 2)).toBe(true);
    expect(px(ctx, 500, 550)).toEqual([0, 0, 0]); // multiply keeps black black
    // Butt caps: nothing before a.x.
    expect(px(ctx, 90, 450)).toEqual(blue);
  });

  it('draws highlights beneath other shapes regardless of array order', () => {
    const ctx = canvas();
    drawDoc(
      ctx,
      doc([
        {
          ...base,
          id: 'u',
          kind: 'underline',
          a: { x: 100, y: 500 },
          b: { x: 900, y: 500 },
          width: 10,
        },
        {
          ...base,
          color: '#FFD60A',
          id: 'h',
          kind: 'highlight',
          a: { x: 100, y: 500 },
          b: { x: 900, y: 500 },
          thickness: 60,
          opacity: 0.45,
        },
      ]),
      { x: 0, y: 0, scale: 1 },
    );
    expect(px(ctx, 500, 500)).toEqual(RED); // underline on top, untinted
  });

  it('text gets a white outline under a coloured fill', () => {
    const ctx = canvas('#000000');
    const text: Shape = {
      ...base,
      id: 't',
      kind: 'text',
      at: { x: 100, y: 100 },
      text: 'HHHH',
      size: 104,
      weight: 700,
      style: 'outline',
    };
    drawDoc(ctx, doc([text]), { x: 0, y: 0, scale: 1 });
    const b = shapeBounds(text, 2);
    const img = ctx.getImageData(b.x, b.y, b.w, b.h).data;
    let red = 0;
    let white = 0;
    for (let i = 0; i < img.length; i += 4) {
      const p = [img[i] ?? 0, img[i + 1] ?? 0, img[i + 2] ?? 0];
      if (near(p, RED, 8)) red++;
      if (near(p, [255, 255, 255], 8)) white++;
    }
    expect(red).toBeGreaterThan(1000);
    expect(white).toBeGreaterThan(300);
  });

  it('casts the contrast shadow below strokes when shadow is on', () => {
    const plain = canvas();
    const shaded = canvas();
    const line = (shadow: boolean): Shape => ({
      ...base,
      shadow,
      id: 'u',
      kind: 'underline',
      a: { x: 100, y: 500 },
      b: { x: 900, y: 500 },
      width: 10,
    });
    drawDoc(plain, doc([line(false)]), { x: 0, y: 0, scale: 1 });
    drawDoc(shaded, doc([line(true)]), { x: 0, y: 0, scale: 1 });
    expect(px(plain, 500, 500)).toEqual(RED);
    expect(px(shaded, 500, 500)).toEqual(RED);
    expect(px(plain, 500, 508)).toEqual([255, 255, 255]);
    const below = px(shaded, 500, 508);
    expect(below[0]).toBeLessThan(250); // darkened by the shadow
  });

  it('pen strokes fill a perfect-freehand outline; hidden shapes are skipped', () => {
    const ctx = canvas();
    const pen: Shape = {
      ...base,
      id: 'p',
      kind: 'pen',
      pts: Array.from({ length: 40 }, (_, i) => [100 + i * 20, 300, 0.5] as const),
      size: 16,
      marker: false,
    };
    drawDoc(ctx, doc([pen]), { x: 0, y: 0, scale: 1 });
    expect(px(ctx, 500, 300)).toEqual(RED);
    const hiddenCtx = canvas();
    drawDoc(hiddenCtx, doc([pen]), { x: 0, y: 0, scale: 1 }, { hidden: new Set(['p']) });
    expect(px(hiddenCtx, 500, 300)).toEqual([255, 255, 255]);
  });

  it('calls drawBase before the shapes', () => {
    const ctx = canvas();
    drawDoc(
      ctx,
      doc([
        {
          ...base,
          id: 'u',
          kind: 'underline',
          a: { x: 100, y: 500 },
          b: { x: 900, y: 500 },
          width: 10,
        },
      ]),
      { x: 0, y: 0, scale: 1 },
      {
        drawBase: (c) => {
          c.fillStyle = '#00ff00';
          c.fillRect(0, 0, 1000, 1000);
        },
      },
    );
    expect(px(ctx, 500, 500)).toEqual(RED);
    expect(px(ctx, 500, 700)).toEqual([0, 255, 0]);
  });
});
