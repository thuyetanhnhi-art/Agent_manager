import { create } from 'zustand';
import { Project } from './types';

const PROJECT_COLORS = ['#6B5FFF', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6'];
const PROJ_KEY = 'agentmgr:projects';
const ROOT_KEY = 'agentmgr:reposroot';

export interface SyncRepo {
  id: string; name: string; path: string; lastModified: string;
  branch: string | null; lastCommit: string | null;
}

function loadProjects(): Record<string, Project> {
  try {
    const raw = localStorage.getItem(PROJ_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as Record<string, Project>;
    Object.values(obj).forEach(p => { p.createdAt = new Date(p.createdAt); });
    return obj;
  } catch { return {}; }
}

function saveProjects(p: Record<string, Project>) {
  try { localStorage.setItem(PROJ_KEY, JSON.stringify(p)); } catch {}
  saveProjectsToBackend(p);
}

let _saveProjTimer: ReturnType<typeof setTimeout> | null = null;
function saveProjectsToBackend(projects: Record<string, Project>) {
  if (_saveProjTimer) clearTimeout(_saveProjTimer);
  _saveProjTimer = setTimeout(() => {
    fetch('/api/data/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: projects }),
    }).catch(() => {});
  }, 500);
}

export async function initProjectsFromBackend(): Promise<void> {
  try {
    const res = await fetch('/api/data/projects', { signal: AbortSignal.timeout(3000) });
    const { ok, data } = await res.json() as { ok: boolean; data: Record<string, Project> | null };
    if (!ok) return;
    if (data && Object.keys(data).length > 0) {
      Object.values(data).forEach(p => { p.createdAt = new Date(p.createdAt); });
      useProjectStore.setState({ projects: data });
      try { localStorage.setItem(PROJ_KEY, JSON.stringify(data)); } catch {}
    } else {
      const current = useProjectStore.getState().projects;
      if (Object.keys(current).length > 0) saveProjectsToBackend(current);
    }
  } catch { /* backend offline — localStorage data already loaded */ }
}

interface ProjectState {
  projects: Record<string, Project>;
  activeProjectId: string | null;
  isRepoPickerOpen: boolean;
  reposRoot: string;

  setActiveProject: (id: string | null) => void;
  openRepoPicker: () => void;
  closeRepoPicker: () => void;
  addProject: (data: Omit<Project, 'id' | 'color' | 'taskIds' | 'createdAt'>) => string;
  updateProject: (id: string, data: Partial<Pick<Project, 'jiraProjectKey' | 'description'>>) => void;
  removeProject: (id: string) => void;
  addTaskToProject: (projectId: string, taskId: string) => void;
  removeTaskFromProject: (projectId: string, taskId: string) => void;
  setReposRoot: (root: string) => void;
  syncProjects: (repos: SyncRepo[]) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: loadProjects(),
  activeProjectId: null,
  isRepoPickerOpen: false,
  reposRoot: localStorage.getItem(ROOT_KEY) ?? 'C:\\Users\\Admin\\source\\repos',

  setActiveProject: (id) => set({ activeProjectId: id }),
  openRepoPicker: () => set({ isRepoPickerOpen: true }),
  closeRepoPicker: () => set({ isRepoPickerOpen: false }),

  setReposRoot: (root) => {
    localStorage.setItem(ROOT_KEY, root);
    set({ reposRoot: root });
  },

  syncProjects: (repos) => {
    const { projects, reposRoot, activeProjectId } = get();
    const scannedPaths = new Set(repos.map(r => r.path));
    const byPath: Record<string, string> = {};
    Object.values(projects).forEach(p => { byPath[p.repoPath] = p.id; });

    // Build updated list: keep projects not under reposRoot (manually added elsewhere),
    // drop projects under reposRoot that no longer exist in the scan.
    // Always keep the virtual "jira" project (repoPath === '__jira__').
    const updated: Record<string, Project> = {};
    Object.values(projects).forEach(p => {
      const underRoot = p.repoPath.startsWith(reposRoot);
      if (!underRoot || scannedPaths.has(p.repoPath) || p.repoPath === '__jira__') updated[p.id] = p;
    });

    // Add new / refresh existing
    repos.forEach(r => {
      const existingId = byPath[r.path];
      if (existingId && updated[existingId]) {
        updated[existingId] = { ...updated[existingId], branch: r.branch, lastCommit: r.lastCommit, lastModified: r.lastModified };
      } else if (!existingId) {
        const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const colorIdx = Object.keys(updated).length % PROJECT_COLORS.length;
        updated[id] = {
          id, name: r.name, repoPath: r.path, description: r.lastCommit ?? '',
          branch: r.branch, lastCommit: r.lastCommit, lastModified: r.lastModified,
          color: PROJECT_COLORS[colorIdx], taskIds: [], createdAt: new Date(),
        };
      }
    });

    const newActiveId = activeProjectId && updated[activeProjectId] ? activeProjectId : null;
    saveProjects(updated);
    set({ projects: updated, activeProjectId: newActiveId });
  },

  updateProject: (id, data) => {
    set(s => {
      const proj = s.projects[id];
      if (!proj) return s;
      const projects = { ...s.projects, [id]: { ...proj, ...data } };
      saveProjects(projects);
      return { projects };
    });
  },

  addProject: (data) => {
    const id = `proj-${Date.now()}`;
    const colorIdx = Object.keys(get().projects).length % PROJECT_COLORS.length;
    const project: Project = { ...data, id, color: PROJECT_COLORS[colorIdx], taskIds: [], createdAt: new Date() };
    const projects = { ...get().projects, [id]: project };
    saveProjects(projects);
    set({ projects });
    return id;
  },

  removeProject: (id) => {
    set(s => {
      const { [id]: _rm, ...rest } = s.projects;
      saveProjects(rest);
      return { projects: rest, activeProjectId: s.activeProjectId === id ? null : s.activeProjectId };
    });
  },

  addTaskToProject: (projectId, taskId) => {
    set(s => {
      const proj = s.projects[projectId];
      if (!proj || proj.taskIds.includes(taskId)) return s;
      const projects = { ...s.projects, [projectId]: { ...proj, taskIds: [...proj.taskIds, taskId] } };
      saveProjects(projects);
      return { projects };
    });
  },

  removeTaskFromProject: (projectId, taskId) => {
    set(s => {
      const proj = s.projects[projectId];
      if (!proj) return s;
      const projects = { ...s.projects, [projectId]: { ...proj, taskIds: proj.taskIds.filter(t => t !== taskId) } };
      saveProjects(projects);
      return { projects };
    });
  },


}));
