import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App';
import { initTasksFromBackend, useStore } from './store';
import { initProjectsFromBackend } from './projectStore';
import { usePromptStore } from './promptStore';

void initTasksFromBackend();
void initProjectsFromBackend();

// Backfill existing task descriptions into prompt store (one-time, deduplication built-in)
const _tasks = Object.values(useStore.getState().tasks);
const _captureFromTask = usePromptStore.getState().captureFromTask;
_tasks.forEach(t => _captureFromTask(t));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
