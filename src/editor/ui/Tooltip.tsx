/**
 * One tooltip for the whole page, driven by event delegation. Any element with `data-tip` gets a
 * tooltip (label), plus `data-kbd` for its shortcut. It updates the DOM directly, so hovering
 * across the toolbar never re-renders React.
 *
 * Behaviour: appears below the element after a short delay; once one is showing, moving to a
 * neighbour swaps instantly ("warm" state, like native toolbars). Keyboard focus shows it at once.
 * Pointer down hides it.
 */
import { useEffect, useRef } from 'react';

const DELAY_MS = 450;
const WARM_MS = 350;
const GAP = 8;
const EDGE = 8;

export function TooltipLayer() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tip = ref.current;
    if (!tip) return;
    let target: HTMLElement | null = null;
    let timer = 0;
    let lastHiddenAt = 0;
    let open = false;

    const render = (el: HTMLElement) => {
      const label = el.dataset.tip ?? '';
      const kbd = el.dataset.kbd;
      tip.replaceChildren(document.createTextNode(label));
      if (kbd) {
        const k = document.createElement('kbd');
        k.textContent = kbd;
        tip.append(k);
      }
      const r = el.getBoundingClientRect();
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      let x = r.left + r.width / 2 - w / 2;
      x = Math.max(EDGE, Math.min(x, window.innerWidth - w - EDGE));
      let y = r.bottom + GAP;
      if (y + h > window.innerHeight - EDGE) y = r.top - GAP - h;
      tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      tip.setAttribute('data-open', '');
      open = true;
    };

    const show = (el: HTMLElement, immediate: boolean) => {
      window.clearTimeout(timer);
      target = el;
      const warm = open || performance.now() - lastHiddenAt < WARM_MS;
      if (immediate || warm) render(el);
      else timer = window.setTimeout(() => target === el && render(el), DELAY_MS);
    };

    const hide = () => {
      window.clearTimeout(timer);
      if (open) lastHiddenAt = performance.now();
      open = false;
      target = null;
      tip.removeAttribute('data-open');
    };

    const tipTarget = (e: Event) =>
      (e.target instanceof Element ? e.target.closest<HTMLElement>('[data-tip]') : null) ?? null;

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = tipTarget(e);
      if (el === target) return;
      if (el) show(el, false);
      else hide();
    };
    const onOut = (e: PointerEvent) => {
      if (!e.relatedTarget) hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = tipTarget(e);
      if (el?.matches(':focus-visible')) show(el, true);
      else if (!el) hide();
    };
    const onDown = () => {
      hide();
      lastHiddenAt = 0;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };

    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  return <div ref={ref} className="ps-tip" role="presentation" data-testid="tooltip" />;
}
