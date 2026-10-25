/**
 * Minimal accessible menu button (zoom, stroke size, colour). Opens below its button, focuses the
 * checked item, arrows move (left/right too for a horizontal menu), Enter/Space pick, Esc or Tab
 * or a click outside closes. Keys it handles don't reach the editor's global shortcuts (so Esc
 * closes the menu instead of switching tools, and arrows don't scroll the capture).
 */
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronIcon } from './icons';

interface MenuButtonProps {
  label: string;
  tip: string;
  kbd?: string;
  disabled?: boolean;
  className?: string;
  align?: 'start' | 'center' | 'end';
  testId?: string;
  /** Lay the items out in a row (colour); left/right arrows move between them. */
  orientation?: 'vertical' | 'horizontal';
  popClassName?: string;
  button: ReactNode;
  children: (close: () => void) => ReactNode;
}

const ITEM = '[role="menuitem"],[role="menuitemradio"]';

export function MenuButton({
  label,
  tip,
  kbd,
  disabled,
  className = 'ps-tbtn',
  align = 'center',
  testId,
  orientation = 'vertical',
  popClassName,
  button,
  children,
}: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!open) return;
    const pop = popRef.current;
    const items = pop ? [...pop.querySelectorAll<HTMLElement>(ITEM)] : [];
    const checked = items.find((el) => el.getAttribute('aria-checked') === 'true');
    (checked ?? items[0])?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, close]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const pop = popRef.current;
    if (!open || !pop) return;
    const items = [...pop.querySelectorAll<HTMLElement>(ITEM)];
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    const horizontal = orientation === 'horizontal';
    const fwd = horizontal ? 'ArrowRight' : 'ArrowDown';
    const back = horizontal ? 'ArrowLeft' : 'ArrowUp';
    switch (e.key) {
      case fwd:
        next = items[(i + 1) % items.length];
        break;
      case back:
        next = items[(i - 1 + items.length) % items.length];
        break;
      case 'ArrowDown':
      case 'ArrowUp':
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'PageUp':
      case 'PageDown':
        // The other axis: swallow, so the capture doesn't scroll behind an open menu.
        break;
      case 'Home':
        next = items[0];
        break;
      case 'End':
        next = items[items.length - 1];
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      case 'Tab':
        close(false);
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    next?.focus({ preventScroll: true });
  };

  const popStyle: React.CSSProperties =
    align === 'end'
      ? { right: 0 }
      : align === 'start'
        ? { left: 0 }
        : { left: '50%', translate: '-50% 0' };

  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        ref={btnRef}
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-tip={open ? undefined : tip}
        data-kbd={kbd}
        data-testid={testId}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }
        }}
      >
        {button}
        <ChevronIcon className="ps-chev" />
      </button>
      {open && (
        <div
          ref={popRef}
          id={id}
          role="menu"
          aria-label={label}
          aria-orientation={orientation}
          className={popClassName ? `ps-pop ${popClassName}` : 'ps-pop'}
          style={popStyle}
          onKeyDown={onKeyDown}
        >
          {children(() => close())}
        </div>
      )}
    </span>
  );
}
