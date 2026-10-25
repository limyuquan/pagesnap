import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/editor/App';
import { ErrorBoundary } from '@/editor/ui/ErrorBoundary';
import '@/styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
