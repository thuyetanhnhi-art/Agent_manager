import { create } from 'zustand';
import { Task, TaskStatus, Priority, LogEntry, TokenUsage, TodoItem, AgentConfig, TaskLabel, TaskKind, ValidationResult, AgentSession, TaskAttachment, calcCost } from './types';
import { inferLabel, generateHandoffContext } from './utils';
import { fetchUsageSnapshot } from './usageStore';

const TASKS_KEY = 'agentmgr:tasks';

function loadTasks(): Record<string, Task> {
  try {
    const raw = localStorage.getItem(TASKS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as Record<string, Task>;
    Object.values(obj).forEach(t => {
      t.createdAt = new Date(t.createdAt);
      t.updatedAt = new Date(t.updatedAt);
      if (t.terminal.startedAt) t.terminal.startedAt = new Date(t.terminal.startedAt);
      if (t.terminal.completedAt) t.terminal.completedAt = new Date(t.terminal.completedAt);
      if (t.terminal.logs) t.terminal.logs.forEach(l => { l.timestamp = new Date(l.timestamp); });
      t.terminal.isRunning = false;
      // Migrate removed statuses from old format
      if ((t.status as string) === 'todo') t.status = 'backlog';
      if ((t.status as string) === 'review') t.status = 'done';
      if (!t.label) t.label = inferLabel(t.title, t.description);
      if (t.branchName === undefined) t.branchName = null;
      if (t.reviewPending === undefined) t.reviewPending = false;
      if (!t.successCriteria) t.successCriteria = [];
      if (!t.validationResults) t.validationResults = [];
      while (t.validationResults.length < t.successCriteria.length) {
        t.validationResults.push({ passed: null, notes: '' });
      }
      if (!t.terminal.todos) t.terminal.todos = [];
      if (!t.terminal.liveTokens) t.terminal.liveTokens = { input: 0, output: 0 };
      if (!t.taskTodos) t.taskTodos = [];
      if (!t.sessions) t.sessions = [];
    });
    return obj;
  } catch { return {}; }
}

interface AppState {
  tasks: Record<string, Task>;
  activeTaskId: string | null;
  terminalTaskId: string | null;
  detailPanelTaskId: string | null;
  autoRunTaskId: string | null;
  isCreateModalOpen: boolean;
  createParentId: string | null;
  sidebarOpen: boolean;
  activeTimers: Record<string, ReturnType<typeof setInterval>>;
  abortFn: (() => void) | null;

  // actions
  setActiveTask: (id: string | null) => void;
  openTerminal: (id: string) => void;
  closeTerminal: () => void;
  openDetailPanel: (id: string, autoRun?: boolean) => void;
  closeDetailPanel: () => void;
  setAutoRunTaskId: (id: string | null) => void;
  openCreateModal: (parentId?: string) => void;
  closeCreateModal: () => void;
  toggleSidebar: () => void;
  setAbortFn: (fn: (() => void) | null) => void;

  createTask: (data: {
    title: string;
    description: string;
    priority: Priority;
    agentConfig: AgentConfig;
    parentId?: string;
    projectId?: string;
    tags?: string[];
    label?: TaskLabel;
    taskKind?: TaskKind;
    projectAnalysis?: string;
    successCriteria?: string[];
    attachments?: TaskAttachment[];
  }) => string;
  /** Trigger an immediate run of a fb_phone_collector task (backend job, not a Claude agent). */
  runFbTask: (id: string) => Promise<void>;
  createTasks: (tasks: Array<{
    title: string;
    description: string;
    priority: Priority;
    agentConfig: AgentConfig;
    parentId?: string;
    projectId?: string;
    tags?: string[];
    label?: TaskLabel;
  }>) => void;
  updateTaskStatus: (id: string, status: TaskStatus) => void;
  deleteTask: (id: string) => void;
  deleteTasks: (ids: string[]) => void;
  setTaskBranch: (id: string, branchName: string) => void;
  setReviewPending: (id: string, pending: boolean) => void;
  setProjectAnalysis: (id: string, analysis: string) => void;
  setSuccessCriteria: (id: string, criteria: string[]) => void;
  updateValidationResult: (id: string, index: number, passed: boolean | null) => void;

  startTask: (id: string) => void;
  pauseTask: (id: string) => void;
  stopTask: (id: string) => void;
  appendLog: (id: string, entry: LogEntry) => void;
  updateTokens: (id: string, usage: Partial<TokenUsage>, costUsd?: number) => void;
  captureUsageStart: (id: string) => Promise<void>;
  captureUsageEnd: (id: string) => Promise<void>;
  updateLiveTokens: (id: string, delta: { input: number; output: number }) => void;
  resetLiveTokens: (id: string) => void;
  updateTodos: (id: string, todos: TodoItem[]) => void;
  tickElapsed: (id: string, ms: number) => void;
  completeTask: (id: string, success: boolean) => void;

  setTaskTodos: (id: string, todos: TodoItem[]) => void;
  addTaskTodo: (id: string, content: string) => void;
  toggleTaskTodo: (id: string, todoId: string) => void;
  setTodoStatus: (id: string, todoId: string, status: TodoItem['status']) => void;
  deleteTaskTodo: (id: string, todoId: string) => void;
  setHandoffContext: (id: string, context: string) => void;
  setFailReason: (id: string, reason: string) => void;
}

function makeTerminal() {
  return {
    isRunning: false,
    isPaused: false,
    logs: [],
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    liveTokens: { input: 0, output: 0 },
    todos: [] as TodoItem[],
    elapsedMs: 0,
    cost: 0,
  };
}

export const useStore = create<AppState>((set, get) => ({
  tasks: loadTasks(),
  activeTaskId: null,
  terminalTaskId: null,
  detailPanelTaskId: null,
  autoRunTaskId: null,
  isCreateModalOpen: false,
  createParentId: null,
  sidebarOpen: true,
  activeTimers: {},
  abortFn: null,

  setActiveTask: (id) => set({ activeTaskId: id }),
  openTerminal: (id) => set({ terminalTaskId: id }),
  closeTerminal: () => set({ terminalTaskId: null }),
  openDetailPanel: (id, autoRun) => set({ detailPanelTaskId: id, autoRunTaskId: autoRun ? id : null }),
  closeDetailPanel: () => set({ detailPanelTaskId: null, autoRunTaskId: null }),
  setAutoRunTaskId: (id) => set({ autoRunTaskId: id }),
  openCreateModal: (parentId) => set({ isCreateModalOpen: true, createParentId: parentId ?? null }),
  closeCreateModal: () => set({ isCreateModalOpen: false, createParentId: null }),
  toggleSidebar: () => set(s => ({ sidebarOpen: !s.sidebarOpen })),
  setAbortFn: (fn) => set({ abortFn: fn }),

  createTask: (data) => {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date();
    const task: Task = {
      id,
      title: data.title,
      description: data.description,
      priority: data.priority,
      label: data.label ?? inferLabel(data.title, data.description),
      status: 'backlog',
      parentId: data.parentId ?? null,
      subtaskIds: [],
      agentConfig: data.agentConfig,
      terminal: makeTerminal(),
      progress: 0,
      tags: data.tags ?? [],
      projectId: data.projectId ?? null,
      branchName: null,
      reviewPending: false,
      successCriteria: data.successCriteria ?? [],
      validationResults: (data.successCriteria ?? []).map(() => ({ passed: null as null, notes: '' })),
      createdAt: now,
      updatedAt: now,
      ...(data.taskKind ? { taskKind: data.taskKind } : {}),
      ...(data.projectAnalysis ? { projectAnalysis: data.projectAnalysis } : {}),
      ...(data.attachments?.length ? { attachments: data.attachments } : {}),
    };
    set(s => {
      const tasks = { ...s.tasks, [id]: task };
      if (data.parentId && tasks[data.parentId]) {
        tasks[data.parentId] = {
          ...tasks[data.parentId],
          subtaskIds: [...tasks[data.parentId].subtaskIds, id],
          updatedAt: now,
        };
      }
      return { tasks };
    });
    // Auto-capture task description into prompt store
    import('./promptStore').then(({ usePromptStore }) => {
      usePromptStore.getState().captureFromTask(task);
    }).catch(() => {});
    return id;
  },

  createTasks: (list) => {
    list.forEach(t => get().createTask(t));
  },

  updateTaskStatus: (id, status) => {
    set(s => ({
      tasks: {
        ...s.tasks,
        [id]: { ...s.tasks[id], status, updatedAt: new Date() },
      },
    }));
  },

  deleteTask: (id) => {
    const task = get().tasks[id];
    if (!task) return;
    set(s => {
      const tasks = { ...s.tasks };
      task.subtaskIds.forEach(sid => delete tasks[sid]);
      delete tasks[id];
      if (task.parentId && tasks[task.parentId]) {
        tasks[task.parentId] = {
          ...tasks[task.parentId],
          subtaskIds: tasks[task.parentId].subtaskIds.filter(sid => sid !== id),
        };
      }
      return { tasks };
    });
  },

  deleteTasks: (ids) => {
    set(s => {
      const tasks = { ...s.tasks };
      const idSet = new Set(ids);
      for (const id of ids) {
        const task = tasks[id];
        if (!task) continue;
        task.subtaskIds.forEach(sid => delete tasks[sid]);
        delete tasks[id];
        if (task.parentId && tasks[task.parentId] && !idSet.has(task.parentId)) {
          tasks[task.parentId] = {
            ...tasks[task.parentId],
            subtaskIds: tasks[task.parentId].subtaskIds.filter(sid => sid !== id),
          };
        }
      }
      return { tasks };
    });
  },

  startTask: (id) => {
    const prev = get().tasks[id];
    const prevSessions: AgentSession[] = prev?.sessions ?? [];
    const newSessions: AgentSession[] = prev && prev.terminal.logs.length > 0
      ? [...prevSessions, {
          id: `session-${Date.now()}`,
          startedAt: prev.terminal.startedAt ?? new Date(),
          completedAt: prev.terminal.completedAt,
          success: prev.status === 'done' ? true : prev.status === 'failed' ? false : undefined,
          tokenUsage: prev.terminal.tokenUsage,
          cost: prev.terminal.cost,
          elapsedMs: prev.terminal.elapsedMs,
          failReason: prev.failReason,
        }]
      : prevSessions;

    set(s => ({
      tasks: {
        ...s.tasks,
        [id]: {
          ...s.tasks[id],
          status: 'in_progress',
          failReason: undefined,
          sessions: newSessions,
          terminal: {
            ...makeTerminal(),
            isRunning: true,
            startedAt: new Date(),
          },
          updatedAt: new Date(),
        },
      },
    }));
  },

  runFbTask: async (id) => {
    set(s => ({
      tasks: {
        ...s.tasks,
        [id]: { ...s.tasks[id], terminal: { ...s.tasks[id].terminal, isRunning: true } },
      },
    }));
    try {
      await fetch('/api/fb/run', { method: 'POST' });
    } finally {
      await initTasksFromBackend();
    }
  },

  pauseTask: (id) => {
    const task = get().tasks[id];
    const handoffContext = task ? generateHandoffContext(task) : undefined;
    set(s => ({
      tasks: {
        ...s.tasks,
        [id]: {
          ...s.tasks[id],
          status: 'paused',
          handoffContext: handoffContext ?? s.tasks[id].handoffContext,
          terminal: {
            ...s.tasks[id].terminal,
            isRunning: false,
            isPaused: true,
          },
          updatedAt: new Date(),
        },
      },
    }));
  },

  stopTask: (id) => {
    const timer = get().activeTimers[id];
    if (timer) {
      clearInterval(timer);
      const { [id]: _removed, ...rest } = get().activeTimers;
      set({ activeTimers: rest });
    }
    set(s => ({
      tasks: {
        ...s.tasks,
        [id]: {
          ...s.tasks[id],
          status: 'stopped',
          terminal: {
            ...s.tasks[id].terminal,
            isRunning: false,
          },
          updatedAt: new Date(),
        },
      },
    }));
  },

  appendLog: (id, entry) => {
    set(s => {
      const task = s.tasks[id];
      if (!task) return s;
      return {
        tasks: {
          ...s.tasks,
          [id]: {
            ...task,
            terminal: {
              ...task.terminal,
              logs: [...task.terminal.logs, entry],
            },
          },
        },
      };
    });
  },

  updateTokens: (id, delta, costUsd) => {
    set(s => {
      const task = s.tasks[id];
      if (!task) return s;
      const prev = task.terminal.tokenUsage;
      const next: TokenUsage = {
        input: prev.input + (delta.input ?? 0),
        output: prev.output + (delta.output ?? 0),
        cacheRead: prev.cacheRead + (delta.cacheRead ?? 0),
        cacheWrite: prev.cacheWrite + (delta.cacheWrite ?? 0),
        total: prev.total + ((delta.input ?? 0) + (delta.output ?? 0) + (delta.cacheRead ?? 0) + (delta.cacheWrite ?? 0)),
      };
      return {
        tasks: {
          ...s.tasks,
          [id]: {
            ...task,
            terminal: {
              ...task.terminal,
              tokenUsage: next,
              // Prefer the CLI's own total_cost_usd when provided — it is the ground truth;
              // fall back to calcCost (catalog pricing) only when the run did not report one.
              cost: typeof costUsd === 'number' ? costUsd : calcCost(next, task.agentConfig.model),
            },
          },
        },
      };
    });
  },

  captureUsageStart: async (id) => {
    const snap = await fetchUsageSnapshot();
    if (!snap) return;
    set(s => {
      const task = s.tasks[id];
      if (!task) return s;
      return {
        tasks: {
          ...s.tasks,
          [id]: {
            ...task,
            terminal: {
              ...task.terminal,
              usageStart: { fiveHour: snap.fiveHour, sevenDay: snap.sevenDay, at: Date.now() },
              usageConsumed: undefined,
            },
          },
        },
      };
    });
  },

  captureUsageEnd: async (id) => {
    const start = get().tasks[id]?.terminal.usageStart;
    if (!start) return;
    const snap = await fetchUsageSnapshot();
    if (!snap) return;
    // Delta in percentage points. Clamp at 0 — a negative value means the window
    // reset mid-run (or other activity dropped it), in which case the attribution
    // is unreliable, so we report 0 rather than a misleading number.
    const delta = (before: number, after: number) => Math.max(0, +(after - before).toFixed(1));
    set(s => {
      const task = s.tasks[id];
      if (!task) return s;
      return {
        tasks: {
          ...s.tasks,
          [id]: {
            ...task,
            terminal: {
              ...task.terminal,
              usageConsumed: {
                fiveHour: delta(start.fiveHour, snap.fiveHour),
                sevenDay: delta(start.sevenDay, snap.sevenDay),
              },
            },
          },
        },
      };
    });
  },

  updateLiveTokens: (id, delta) => {
    set(s => {
      const task = s.tasks[id];
      if (!task) return s;
      const prev = task.terminal.liveTokens ?? { input: 0, output: 0 };
      return {
        tasks: {
          ...s.tasks,
          [id]: {
            ...task,
            terminal: {
              ...task.terminal,
              liveTokens: { input: prev.input + delta.input, output: prev.output + delta.output },
            },
          },
        },
      };
    });
  },

  resetLiveTokens: (id) => {
    set(s => {
      const task = s.tasks[id];
      if (!task) return s;
      return {
        tasks: {
          ...s.tasks,
          [id]: { ...task, terminal: { ...task.terminal, liveTokens: { input: 0, output: 0 } } },
        },
      };
    });
  },

  updateTodos: (id, todos) => {
    set(s => {
      const task = s.tasks[id];
      if (!task) return s;
      return {
        tasks: { ...s.tasks, [id]: { ...task, terminal: { ...task.terminal, todos } } },
      };
    });
  },

  tickElapsed: (id, ms) => {
    set(s => {
      const task = s.tasks[id];
      if (!task) return s;
      return {
        tasks: {
          ...s.tasks,
          [id]: {
            ...task,
            terminal: {
              ...task.terminal,
              elapsedMs: task.terminal.elapsedMs + ms,
            },
          },
        },
      };
    });
  },

  completeTask: (id, success) => {
    const timer = get().activeTimers[id];
    if (timer) {
      clearInterval(timer);
      const { [id]: _removed, ...rest } = get().activeTimers;
      set({ activeTimers: rest });
    }
    const task = get().tasks[id];
    const failReason = !success && task
      ? ([...task.terminal.logs].reverse().find(l => l.type === 'error' || l.type === 'success')?.content?.slice(0, 600) ?? 'Task failed without error detail')
      : undefined;
    const handoffOnFail = !success && task ? generateHandoffContext(task) : undefined;

    // Sync terminal todos → taskTodos on completion
    const syncedTodos = task?.terminal.todos.length
      ? task.terminal.todos
      : undefined;

    set(s => {
      const t = s.tasks[id];
      if (!t) return s;
      return {
        tasks: {
          ...s.tasks,
          [id]: {
            ...t,
            status: success ? 'done' : 'failed',
            failReason,
            handoffContext: handoffOnFail ?? t.handoffContext,
            taskTodos: syncedTodos ?? t.taskTodos ?? [],
            progress: success ? 100 : t.progress,
            reviewPending: success && !t.parentId && (!!t.branchName || t.successCriteria.length > 0),
            terminal: {
              ...t.terminal,
              isRunning: false,
              completedAt: new Date(),
            },
            updatedAt: new Date(),
          },
        },
      };
    });
    if (success && task && task.terminal.logs.length > 0) {
      import('./promptStore').then(({ usePromptStore }) => {
        usePromptStore.getState().captureFromTerminal(task, task.terminal.logs);
      }).catch(() => {});
    }
  },

  setTaskTodos: (id, todos) => {
    set(s => ({
      tasks: { ...s.tasks, [id]: { ...s.tasks[id], taskTodos: todos, updatedAt: new Date() } },
    }));
  },

  addTaskTodo: (id, content) => {
    const todo: TodoItem = { id: `todo-${Date.now()}`, content, status: 'pending' };
    set(s => {
      const task = s.tasks[id];
      if (!task) return s;
      return { tasks: { ...s.tasks, [id]: { ...task, taskTodos: [...(task.taskTodos ?? []), todo] } } };
    });
  },

  toggleTaskTodo: (id, todoId) => {
    set(s => {
      const task = s.tasks[id];
      if (!task) return s;
      const updated = (task.taskTodos ?? []).map(t =>
        t.id === todoId ? { ...t, status: t.status === 'completed' ? 'pending' : 'completed' as const } : t,
      );
      return { tasks: { ...s.tasks, [id]: { ...task, taskTodos: updated } } };
    });
  },

  setTodoStatus: (id, todoId, status) => {
    set(s => {
      const task = s.tasks[id];
      if (!task) return s;
      const updated = (task.taskTodos ?? []).map(t =>
        t.id === todoId ? { ...t, status } : t,
      );
      return { tasks: { ...s.tasks, [id]: { ...task, taskTodos: updated } } };
    });
  },

  deleteTaskTodo: (id, todoId) => {
    set(s => {
      const task = s.tasks[id];
      if (!task) return s;
      return { tasks: { ...s.tasks, [id]: { ...task, taskTodos: (task.taskTodos ?? []).filter(t => t.id !== todoId) } } };
    });
  },

  setHandoffContext: (id, context) => {
    set(s => ({
      tasks: { ...s.tasks, [id]: { ...s.tasks[id], handoffContext: context, updatedAt: new Date() } },
    }));
  },

  setFailReason: (id, reason) => {
    set(s => ({
      tasks: { ...s.tasks, [id]: { ...s.tasks[id], failReason: reason, updatedAt: new Date() } },
    }));
  },

  setTaskBranch: (id, branchName) => {
    set(s => ({
      tasks: { ...s.tasks, [id]: { ...s.tasks[id], branchName, updatedAt: new Date() } },
    }));
  },

  setReviewPending: (id, pending) => {
    set(s => ({
      tasks: { ...s.tasks, [id]: { ...s.tasks[id], reviewPending: pending } },
    }));
  },

  setProjectAnalysis: (id, analysis) => {
    set(s => ({
      tasks: { ...s.tasks, [id]: { ...s.tasks[id], projectAnalysis: analysis } },
    }));
  },

  setSuccessCriteria: (id, criteria) => {
    set(s => {
      const task = s.tasks[id];
      if (!task) return s;
      const existing = task.validationResults;
      const validationResults: ValidationResult[] = criteria.map((_, i) =>
        existing[i] ?? { passed: null, notes: '' }
      );
      return {
        tasks: {
          ...s.tasks,
          [id]: { ...task, successCriteria: criteria, validationResults, updatedAt: new Date() },
        },
      };
    });
  },

  updateValidationResult: (id, index, passed) => {
    set(s => {
      const task = s.tasks[id];
      if (!task) return s;
      const results = task.validationResults.map((r, i) =>
        i === index ? { ...r, passed } : r
      );
      return {
        tasks: { ...s.tasks, [id]: { ...task, validationResults: results } },
      };
    });
  },
}));

let _saveTasksTimer: ReturnType<typeof setTimeout> | null = null;
function saveTasksToBackend(tasks: Record<string, Task>) {
  if (_saveTasksTimer) clearTimeout(_saveTasksTimer);
  _saveTasksTimer = setTimeout(() => {
    fetch('/api/data/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: tasks }),
    }).catch(() => {});
  }, 500);
}

useStore.subscribe(state => {
  try { localStorage.setItem(TASKS_KEY, JSON.stringify(state.tasks)); } catch {}
  saveTasksToBackend(state.tasks);
});

function migrateTask(t: Task) {
  t.createdAt = new Date(t.createdAt);
  t.updatedAt = new Date(t.updatedAt);
  if (t.terminal.startedAt) t.terminal.startedAt = new Date(t.terminal.startedAt);
  if (t.terminal.completedAt) t.terminal.completedAt = new Date(t.terminal.completedAt);
  if (t.terminal.logs) t.terminal.logs.forEach(l => { l.timestamp = new Date(l.timestamp); });
  t.terminal.isRunning = false;
  if ((t.status as string) === 'todo') t.status = 'backlog';
  if ((t.status as string) === 'review') t.status = 'done';
  if (!t.label) t.label = inferLabel(t.title, t.description);
  if (t.branchName === undefined) t.branchName = null;
  if (t.reviewPending === undefined) t.reviewPending = false;
  if (!t.successCriteria) t.successCriteria = [];
  if (!t.validationResults) t.validationResults = [];
  while (t.validationResults.length < t.successCriteria.length) {
    t.validationResults.push({ passed: null, notes: '' });
  }
  if (!t.terminal.todos) t.terminal.todos = [];
  if (!t.taskTodos) t.taskTodos = [];
  if (!t.sessions) t.sessions = [];
}

export async function initTasksFromBackend(): Promise<void> {
  try {
    const res = await fetch('/api/data/tasks', { signal: AbortSignal.timeout(3000) });
    const { ok, data } = await res.json() as { ok: boolean; data: Record<string, Task> | null };
    if (!ok) return;
    if (data && Object.keys(data).length > 0) {
      Object.values(data).forEach(migrateTask);
      useStore.setState({ tasks: data });
      try { localStorage.setItem(TASKS_KEY, JSON.stringify(data)); } catch {}
    } else {
      // Backend file is empty — migrate current localStorage data into it
      const current = useStore.getState().tasks;
      if (Object.keys(current).length > 0) saveTasksToBackend(current);
    }
  } catch { /* backend offline — localStorage data already loaded */ }
}
