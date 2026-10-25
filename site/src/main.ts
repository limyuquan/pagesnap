/**
 * The only script on the first paint: a few kilobytes. It loads the demo (React and the real
 * editor) when the demo comes near the view, and the feature visuals when they do.
 */
import './styles/site.css';

const io = (el: Element | null, margin: string, run: () => void) => {
  if (!el) return;
  const obs = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        obs.disconnect();
        run();
      }
    },
    { rootMargin: margin },
  );
  obs.observe(el);
};

// ------------------------------------------------------------------ demo

const host = document.getElementById('demo-root');
let demo: Promise<void> | null = null;
function loadDemo(autoStart = false): Promise<void> {
  demo ??= import('./demo/mount').then(({ mountDemo }) => {
    if (host) mountDemo(host, { autoStart });
  });
  return demo;
}
// A click on the stand-in's icon before the chunk landed starts the capture once it has.
document.getElementById('demo-static-icon')?.addEventListener('click', () => void loadDemo(true));
io(host, '300px 0px', () => {
  // Let the hero paint and settle first.
  const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 200));
  idle(() => void loadDemo(), { timeout: 1200 });
});

// ------------------------------------------------------------------ feature visuals

io(document.getElementById('features'), '400px 0px', () => {
  void import('./features').then(({ startFeatureVisuals }) => startFeatureVisuals());
});

// ------------------------------------------------------------------ reveal on scroll

const reveal = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.setAttribute('data-in', '');
      reveal.unobserve(e.target);
    }
  },
  { rootMargin: '0px 0px -12% 0px' },
);
for (const el of document.querySelectorAll('[data-reveal]')) reveal.observe(el);

// ------------------------------------------------------------------ top bar hairline once scrolled

const top = document.getElementById('top');
const hero = document.querySelector('.hero');
if (top && hero) {
  new IntersectionObserver(([e]) => top.toggleAttribute('data-stuck', !e?.isIntersecting), {
    rootMargin: '-60px 0px 0px 0px',
    threshold: 0,
  }).observe(hero.querySelector('h1') ?? hero);
}

// ------------------------------------------------------------------ copy buttons

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  btn.addEventListener('click', async () => {
    const text = document.getElementById(btn.dataset.copy ?? '')?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text.trim());
      btn.setAttribute('data-done', '');
      const label = btn.getAttribute('aria-label') ?? '';
      btn.setAttribute('aria-label', 'Copied');
      setTimeout(() => {
        btn.removeAttribute('data-done');
        btn.setAttribute('aria-label', label);
      }, 1600);
    } catch {
      // Clipboard blocked: the text is selectable anyway.
    }
  });
}
