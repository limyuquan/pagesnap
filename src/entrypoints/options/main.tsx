import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@/editor/ui/ErrorBoundary';
import { Options } from './Options';
import '@/styles/app.css';
import '@/styles/options.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <Options />
    </ErrorBoundary>
  </StrictMode>,
);
