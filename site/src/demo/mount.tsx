/**
 * Demo chunk entry, loaded by main.ts when the demo comes near the viewport (or when the static
 * toolbar icon is clicked before it loaded). It replaces the static stand-in in `#demo-root`.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Demo } from './Demo';
import './demo.css';

export function mountDemo(host: HTMLElement, opts: { autoStart?: boolean } = {}): void {
  host.replaceChildren();
  host.removeAttribute('data-static');
  createRoot(host).render(
    <StrictMode>
      <Demo autoStart={opts.autoStart ?? false} />
    </StrictMode>,
  );
}
