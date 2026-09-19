import { create } from 'zustand';
import { PromptEntry, LogEntry, Task } from './types';

const PROMPTS_KEY = 'agentmgr:prompts';

function loadPrompts(): Record<string, PromptEntry> {
  try {
    const raw = localStorage.getItem(PROMPTS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as Record<string, PromptEntry>;
    Object.values(obj).forEach(p => {
      p.createdAt = new Date(p.createdAt);
      p.updatedAt = new Date(p.updatedAt);
    });
    return obj;
  } catch { return {}; }
}

interface PromptState {
  prompts: Record<string, PromptEntry>;
  addPrompt: (data: Omit<PromptEntry, 'id' | 'createdAt' | 'updatedAt' | 'usageCount'>) => string;
  updatePrompt: (id: string, data: Partial<Pick<PromptEntry, 'title' | 'content' | 'tags'>>) => void;
  deletePrompt: (id: string) => void;
  incrementUsage: (id: string) => void;
  promotePrompt: (id: string) => void;
  demotePrompt: (id: string) => void;
  captureFromTask: (task: Task) => void;
  captureFromTerminal: (task: Task, logs: LogEntry[]) => void;
}

export const usePromptStore = create<PromptState>((set, get) => ({
  prompts: loadPrompts(),

  addPrompt: (data) => {
    const id = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date();
    const prompt: PromptEntry = { ...data, id, usageCount: 0, createdAt: now, updatedAt: now };
    set(s => ({ prompts: { ...s.prompts, [id]: prompt } }));
    return id;
  },

  updatePrompt: (id, data) => {
    set(s => {
      const p = s.prompts[id];
      if (!p) return s;
      return { prompts: { ...s.prompts, [id]: { ...p, ...data, updatedAt: new Date() } } };
    });
  },

  deletePrompt: (id) => {
    set(s => {
      const { [id]: _, ...rest } = s.prompts;
      return { prompts: rest };
    });
  },

  incrementUsage: (id) => {
    set(s => {
      const p = s.prompts[id];
      if (!p) return s;
      return { prompts: { ...s.prompts, [id]: { ...p, usageCount: p.usageCount + 1 } } };
    });
  },

  promotePrompt: (id) => {
    set(s => {
      const p = s.prompts[id];
      if (!p) return s;
      return { prompts: { ...s.prompts, [id]: { ...p, promoted: true, updatedAt: new Date() } } };
    });
  },

  demotePrompt: (id) => {
    set(s => {
      const p = s.prompts[id];
      if (!p) return s;
      return { prompts: { ...s.prompts, [id]: { ...p, promoted: false, updatedAt: new Date() } } };
    });
  },

  captureFromTask: (task) => {
    if (!task.description.trim() && !task.successCriteria.length) return;
    const existing = Object.values(get().prompts).find(
      p => p.source === 'task' && p.taskId === task.id,
    );
    if (existing) return;
    const parts = [task.description.trim()];
    if (task.successCriteria.length) {
      parts.push(`\n## Success Criteria\n${task.successCriteria.map(c => `- ${c}`).join('\n')}`);
    }
    get().addPrompt({
      title: task.title,
      content: parts.join(''),
      source: 'task',
      taskId: task.id,
      projectId: task.projectId,
      tags: [task.label, ...(task.tags ?? [])].filter(Boolean),
    });
  },

  captureFromTerminal: (task, logs) => {
    const meaningful = logs
      .filter(l => l.type === 'info' || l.type === 'thinking' || l.type === 'success')
      .map(l => l.content)
      .filter(c => c.trim().length > 20)
      .slice(0, 10);
    if (meaningful.length === 0) return;
    const existing = Object.values(get().prompts).find(
      p => p.source === 'terminal' && p.taskId === task.id,
    );
    if (existing) return;
    const content = [
      `## Task: ${task.title}`,
      task.description.trim() ? `\n${task.description.trim()}` : '',
      `\n## Agent Output\n${meaningful.map(m => `- ${m.slice(0, 200)}`).join('\n')}`,
    ].filter(Boolean).join('');
    get().addPrompt({
      title: `[Run] ${task.title}`,
      content,
      source: 'terminal',
      taskId: task.id,
      projectId: task.projectId,
      tags: [task.label, 'terminal-run'],
    });
  },
}));

usePromptStore.subscribe(state => {
  try { localStorage.setItem(PROMPTS_KEY, JSON.stringify(state.prompts)); } catch {}
});
