import { create } from 'zustand';
import { KnowledgeEntry } from './types';

const KEY = 'agentmgr:knowledge';

function load(): Record<string, KnowledgeEntry> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as Record<string, KnowledgeEntry>;
    Object.values(obj).forEach(k => { k.createdAt = new Date(k.createdAt); });
    return obj;
  } catch { return {}; }
}

interface KnowledgeState {
  entries: Record<string, KnowledgeEntry>;
  generating: Set<string>;
  addEntry: (entry: Omit<KnowledgeEntry, 'id' | 'createdAt'>) => void;
  deleteEntry: (id: string) => void;
  addSkillEntry: (projectId: string, skill: { id: string; name: string; description: string; promptTemplate: string }) => void;
  generateFromTask: (taskId: string, projectId: string, title: string, logs: string[], description: string) => Promise<void>;
}

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  entries: load(),
  generating: new Set(),

  addEntry: (data) => {
    const id = `kn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const entry: KnowledgeEntry = { ...data, id, createdAt: new Date() };
    set(s => ({ entries: { ...s.entries, [id]: entry } }));
  },

  deleteEntry: (id) => {
    set(s => {
      const { [id]: _, ...rest } = s.entries;
      return { entries: rest };
    });
  },

  addSkillEntry: (projectId, skill) => {
    const already = Object.values(get().entries).find(
      e => e.projectId === projectId && e.skillId === skill.id,
    );
    if (already) return;
    get().addEntry({
      projectId,
      taskId: `skill-${skill.id}`,
      title: `[Skill] ${skill.name}`,
      summary: skill.description,
      keyPoints: [skill.promptTemplate.slice(0, 500)],
      entryType: 'skill',
      skillId: skill.id,
    });
  },

  generateFromTask: async (taskId, projectId, title, logs, description) => {
    if (get().generating.has(taskId)) return;
    set(s => ({ generating: new Set([...s.generating, taskId]) }));
    try {
      const res = await fetch('/api/generate-knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, title, logs, description }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json() as { ok: boolean; summary?: string; keyPoints?: string[] };
      if (data.ok && data.summary) {
        get().addEntry({
          projectId,
          taskId,
          title,
          summary: data.summary,
          keyPoints: data.keyPoints ?? [],
        });
      }
    } catch {
      // backend offline — create a basic entry from logs
      const meaningful = logs.filter(l => l.length > 30).slice(0, 5);
      if (meaningful.length > 0) {
        get().addEntry({
          projectId,
          taskId,
          title,
          summary: `${description.slice(0, 200) || title}`,
          keyPoints: meaningful.map(l => l.slice(0, 150)),
        });
      }
    } finally {
      set(s => {
        const next = new Set(s.generating);
        next.delete(taskId);
        return { generating: next };
      });
    }
  },
}));

useKnowledgeStore.subscribe(state => {
  try { localStorage.setItem(KEY, JSON.stringify(state.entries)); } catch {}
});
