import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/app.css';

/** Options page (owner: C). PHASE-0 placeholder. */
function Options() {
  return (
    <main data-testid="options-root" className="mx-auto max-w-xl p-6">
      <h1 className="text-lg font-semibold">Page Snap settings</h1>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
