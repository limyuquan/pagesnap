import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Options } from './Options';
import '@/styles/app.css';
import '@/styles/options.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
