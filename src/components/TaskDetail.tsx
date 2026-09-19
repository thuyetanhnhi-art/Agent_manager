import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, Play, Terminal as TerminalIcon, Clock, Cpu, Calendar, Tag, FolderGit2,
  PauseCircle, Loader2, CheckCircle2, RefreshCw, BookOpen, Sparkles, Plus, Trash2,
  AlertTriangle, ClipboardCopy, RotateCcw, ChevronDown, ChevronUp, ListTodo, Activity,
  Info,
} from 'lucide-react';
import clsx from 'clsx';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { useProjectStore } from '../projectStore';
import { useKnowledgeStore } from '../knowledgeStore';
import { STATUS_META, PRIORITY_META, MODEL_INFO, TaskStatus, TodoItem } from '../types';
import { makeLog, simulateAnalysis } from '../simulator';
import { formatDuration, formatRelative, cronLabel } from '../utils';
import { openExternalTerminal, createBranch } from '../services/api';
import { getCachedContext, fetchProjectContext, buildSimulatedContext } from '../contextCache';
import { BranchSelectionModal, BranchConfig } from './BranchSelectionModal';
import { AttachmentGrid } from './AttachmentGrid';
import { FbTaskDetail } from './FbTaskDetail';

type RunPhase = 'idle' | 'analyzing' | 'confirm';
type DetailTab = 'overview' | 'checklist' | 'activity';
type CheckItem = { title: string; description: string; priority: string; selected: boolean };
type LogItem = {
  id: string; type: string; content: string; toolName?: string;
  filePath?: string; lineRange?: string; linesAdded?: number; diffPreview?: string[];
};

interface TaskDetailProps {
  taskId: string;
}

export function TaskDetail({ taskId }: TaskDetailProps) {
  const navigate = useNavigate();
  const {
    tasks, openTerminal, startTask, pauseTask, stopTask,
    appendLog, updateTokens, updateTodos, tickElapsed, completeTask, captureUsageStart, captureUsageEnd,
    updateTaskStatus, setAbortFn, setTaskBranch, abortFn,
    setTaskTodos, addTaskTodo, toggleTaskTodo, setTodoStatus, deleteTaskTodo,
    setHandoffContext, deleteTask,
  } = useStore();
  const { projects } = useProjectStore();
  const { generateFromTask, generating, entries: knowledgeEntries } = useKnowledgeStore();
  const [openingTerminal, setOpeningTerminal] = useState(false);
  const [showBranchModal, setShowBranchModal] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');
  const [newTodoInput, setNewTodoInput] = useState('');
  const [editingHandoff, setEditingHandoff] = useState(false);
  const [handoffDraft, setHandoffDraft] = useState('');
  const [handoffCopied, setHandoffCopied] = useState(false);
  const [showSessionHistory, setShowSessionHistory] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const analysisEsRef = useRef<EventSource | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [runPhase, setRunPhase] = useState<RunPhase>('idle');
  const [checklist, setChecklist] = useState<CheckItem[]>([]);
  const [analysisLogs, setAnalysisLogs] = useState<LogItem[]>([]);
  const [capturedAnalysis, setCapturedAnalysis] = useState('');
  const [runningTodoId, setRunningTodoId] = useState<string | null>(null);

  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => {
    esRef.current?.close();
    analysisEsRef.current?.close();
    if (tickRef.current) clearInterval(tickRef.current);
  }, []);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [analysisLogs.length]);

  const task = tasks[taskId];

  if (!task) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
        Task not found.
      </div>
    );
  }

  if (task.taskKind === 'fb_phone_collector') {
    return (
      <div className="flex-1 overflow-y-auto bg-base">
        <div className="sticky top-0 z-10 bg-white/90 backdrop-blur-sm border-b border-border px-6 py-3 flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-hover rounded-xl transition-colors">
            <ArrowLeft size={15} />
          </button>
          <h1 className="text-sm font-semibold text-slate-800 truncate">{task.title}</h1>
        </div>
        <div className="px-6 py-5 max-w-2xl">
          <FbTaskDetail task={task} onDelete={() => { deleteTask(task.id); navigate(-1); }} />
        </div>
      </div>
    );
  }

  const subtasks = task.subtaskIds.map(id => tasks[id]).filter(Boolean);
  const statusMeta = STATUS_META[task.status];
  const priorityMeta = PRIORITY_META[task.priority];
  const modelInfo = MODEL_INFO[task.agentConfig.model];
  const doneSubs = subtasks.filter(t => t.status === 'done').length;
  const progress = subtasks.length > 0 ? Math.round((doneSubs / subtasks.length) * 100) : task.progress;
  const taskProject = task.projectId ? projects[task.projectId] : null;
  const taskTodos = task.taskTodos ?? [];
  const doneTodos = taskTodos.filter(t => t.status === 'completed').length;
  const canResume = (task.status === 'paused' || task.status === 'failed') && !task.terminal.isRunning;

  function cancelAnalysis() {
    analysisEsRef.current?.close();
    analysisEsRef.current = null;
    setRunPhase('idle');
    setAnalysisLogs([]);
    setChecklist([]);
  }

  async function handleAnalyze() {
    if (task.terminal.isRunning || runPhase !== 'idle') return;
    setRunPhase('analyzing');
    setAnalysisLogs([]);
    setChecklist([]);

    let idCounter = 0;
    const addLog = (
      type: string, content: string, toolName?: string,
      extra?: { filePath?: string; lineRange?: string; linesAdded?: number; diffPreview?: string[] },
    ) => setAnalysisLogs(prev => [...prev, { id: `al-${idCounter++}`, type, content, toolName, ...extra }]);

    // Pre-load project context cache
    const repoPath = taskProject?.repoPath ?? '';
    if (repoPath) {
      const cached = getCachedContext(repoPath);
      if (!cached) {
        const ctx = await fetchProjectContext(repoPath);
        if (!ctx) buildSimulatedContext(repoPath, taskProject?.name ?? '');
      }
    }

    let usedSimulation = false;

    try {
      const serviceTag = task.tags.find(t => t.startsWith('service:'))?.slice(8) ?? '';
      const res = await fetch('/api/analyze-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: task.title,
          description: task.description,
          repoPath,
          projectName: taskProject?.name ?? '',
          service: serviceTag,
        }),
        signal: AbortSignal.timeout(4000),
      });
      const { runId, ok } = await res.json() as { runId: string; ok: boolean };
      if (!ok) throw new Error('Failed to start analysis');

      await new Promise<void>(resolve => {
        const es = new EventSource(`/api/task-stream/${runId}`);
        analysisEsRef.current = es;

        es.onmessage = (ev: MessageEvent<string>) => {
          const msg = JSON.parse(ev.data) as Record<string, unknown>;

          if (msg.type === 'event' && msg.event) {
            const event = msg.event as Record<string, unknown>;
            if (event.type === 'assistant') {
              const blocks = (event.message as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> })?.content ?? [];
              for (const block of blocks) {
                if (block.type === 'text' && block.text?.trim()) {
                  const text = (block.text as string).replace(/<\/?thinking>/g, '').trim();
                  if (text) addLog('thinking', text);
                } else if (block.type === 'tool_use') {
                  const inp = block.input as Record<string, unknown> | undefined;
                  const fp = String(inp?.file_path ?? inp?.path ?? '');
                  const raw = inp ? JSON.stringify(inp) : '';
                  addLog('tool_call', fp || raw.slice(0, 150), block.name as string,
                    fp ? { filePath: fp } : undefined);
                }
              }
            } else if (event.type === 'user') {
              const blocks = (event.message as { content?: Array<{ type: string; content?: unknown }> })?.content ?? [];
              for (const block of blocks) {
                if (block.type === 'tool_result') {
                  const text = typeof block.content === 'string' ? block.content
                    : Array.isArray(block.content) ? ((block.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '')
                    : '';
                  if (text.trim()) addLog('tool_result', text.slice(0, 300));
                }
              }
            }
          } else if (msg.type === 'text' && (msg.content as string)?.trim()) {
            addLog('info', msg.content as string);
          } else if (msg.type === 'stderr' && (msg.content as string)?.trim()) {
            addLog('error', (msg.content as string).trim());
          } else if (msg.type === 'done') {
            es.close();
            analysisEsRef.current = null;

            const items = (msg.subtasks as Array<{ title: string; description: string; priority: string }> | undefined) ?? [];
            setChecklist(items.map(it => ({ ...it, selected: true })));

            setAnalysisLogs(prev => {
              const analysis = prev
                .filter(l => l.type === 'thinking' || l.type === 'tool_result')
                .map(l => l.content)
                .join('\n\n')
                .slice(0, 10000);
              setCapturedAnalysis(analysis || `${task.title}\n\n${task.description}`);
              return prev;
            });

            resolve();
          }
        };

        es.onerror = () => { es.close(); analysisEsRef.current = null; resolve(); };
      });
    } catch {
      // Backend unavailable — run simulation fallback
      usedSimulation = true;
      await new Promise<void>(resolve => {
        const stopSim = simulateAnalysis(
          task.title,
          task.description,
          repoPath,
          {
            onLog: log => addLog(log.type, log.content, log.toolName, {
              filePath: log.filePath,
              lineRange: log.lineRange,
              linesAdded: log.linesAdded,
              diffPreview: log.diffPreview,
            }),
            onTodos: items => {
              setChecklist(items.map(it => ({ ...it, selected: true })));
              const analysis = items.map(it => `${it.title}\n${it.description}`).join('\n\n').slice(0, 10000);
              setCapturedAnalysis(analysis || `${task.title}\n\n${task.description}`);
            },
            onComplete: () => {
              analysisEsRef.current = null;
              resolve();
            },
          },
        );
        // Store cleanup fn so Cancel works
        analysisEsRef.current = { close: stopSim } as unknown as EventSource;
      });
    }

    if (usedSimulation) {
      addLog('system', 'Analysis complete (simulated — backend offline)');
    }

    setRunPhase('confirm');
  }

  async function handleImplement(overrideDescription: string, projectContext: string) {
    if (task.terminal.isRunning) return;
    startTask(task.id);
    openTerminal(task.id);

    let runId = '';
    const abort = () => {
      esRef.current?.close();
      esRef.current = null;
      if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
      if (runId) {
        fetch('/api/stop-task', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId }),
        }).catch(() => {});
      }
    };
    setAbortFn(abort);
    tickRef.current = setInterval(() => tickElapsed(task.id, 500), 500);

    try {
      const res = await fetch('/api/run-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: task.id,
          title: task.title,
          description: overrideDescription,
          repoPath: taskProject?.repoPath ?? '',
          projectName: taskProject?.name ?? '',
          model: task.agentConfig.model,
          projectContext,
        }),
      });
      const json = await res.json() as { runId: string };
      runId = json.runId;
      void captureUsageStart(task.id);

      const success = await new Promise<boolean>(resolve => {
        const es = new EventSource(`/api/task-stream/${runId}`);
        esRef.current = es;

        es.onmessage = (ev: MessageEvent<string>) => {
          type Payload = { type: string; event?: Record<string, unknown>; content?: string; success?: boolean };
          const msg = JSON.parse(ev.data) as Payload;

          if (msg.type === 'event' && msg.event) {
            const event = msg.event;
            const evType = event.type as string;

            if (evType === 'assistant') {
              type Block = { type: string; text?: string; name?: string; input?: unknown };
              const msgObj = event.message as { content?: Block[] };
              for (const block of msgObj?.content ?? []) {
                if (block.type === 'text' && block.text?.trim()) {
                  const text = (block.text as string).replace(/<\/?thinking>/g, '').trim();
                  if (text) {
                    const isThinking = /^I('ll| am| will)|^Let me |^First,|^Looking|^Now/i.test(text);
                    appendLog(task.id, makeLog(isThinking ? 'thinking' : 'info', text));
                  }
                } else if (block.type === 'tool_use') {
                  if (block.name === 'TodoWrite') {
                    const inp = block.input as { todos?: TodoItem[] };
                    if (Array.isArray(inp?.todos)) {
                      updateTodos(task.id, inp.todos);
                      setTaskTodos(task.id, inp.todos);
                    }
                  }
                  const toolLabel = block.name === 'TodoWrite'
                    ? (() => { const t = (block.input as { todos?: TodoItem[] })?.todos ?? []; return `${t.filter(x => x.status === 'completed').length}/${t.length} steps`; })()
                    : block.input ? JSON.stringify(block.input).slice(0, 150) : '';
                  appendLog(task.id, makeLog('tool_call', toolLabel, { toolName: (block.name as string) ?? 'tool' }));
                }
              }
            } else if (evType === 'user') {
              type TRBlock = { type: string; content?: unknown };
              const msgObj = event.message as { content?: TRBlock[] };
              for (const block of msgObj?.content ?? []) {
                if (block.type === 'tool_result') {
                  const text = typeof block.content === 'string' ? block.content
                    : Array.isArray(block.content)
                      ? ((block.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '')
                      : '';
                  if (text.trim()) appendLog(task.id, makeLog('tool_result', text.slice(0, 500)));
                }
              }
            } else if (evType === 'result') {
              const sub = event.subtype as string;
              const result = (event.result as string) ?? '';
              appendLog(task.id, makeLog(sub === 'success' ? 'success' : 'error',
                result || (sub === 'success' ? 'Task completed' : 'Task failed')));
              const usage = event.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
              const costUsd = typeof event.total_cost_usd === 'number' ? event.total_cost_usd as number : undefined;
              if (usage) updateTokens(task.id, { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens }, costUsd);
              const nTurns = event.num_turns as number | undefined;
              const totalTok = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);
              appendLog(task.id, makeLog('system',
                `📊 Tokens: ${totalTok.toLocaleString()} (in ${usage?.input_tokens ?? 0} · out ${usage?.output_tokens ?? 0} · cacheR ${usage?.cache_read_input_tokens ?? 0} · cacheW ${usage?.cache_creation_input_tokens ?? 0})`
                + (nTurns != null ? ` · ${nTurns} turns` : '')
                + (costUsd != null ? ` · CLI cost $${costUsd.toFixed(4)}` : '')));
            } else if (evType === 'system' && event.subtype === 'init') {
              appendLog(task.id, makeLog('system', `Session · model: ${event.model as string ?? '?'}`));
            }
          } else if (msg.type === 'text' && msg.content?.trim()) {
            appendLog(task.id, makeLog('info', msg.content));
          } else if (msg.type === 'stderr' && msg.content?.trim()) {
            appendLog(task.id, makeLog('error', msg.content.trim()));
          } else if (msg.type === 'error' && msg.content) {
            appendLog(task.id, makeLog('error', msg.content));
          } else if (msg.type === 'done') {
            es.close();
            esRef.current = null;
            void captureUsageEnd(task.id);
            resolve(msg.success ?? false);
          }
        };

        es.onerror = () => { es.close(); esRef.current = null; resolve(false); };
      });

      completeTask(task.id, success);
    } catch (err) {
      appendLog(task.id, makeLog('error', `Failed to start agent: ${String(err)}`));
      completeTask(task.id, false);
    } finally {
      if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
      setAbortFn(null);
    }
  }

  function handleConfirm() {
    const selected = checklist.filter(c => c.selected);
    if (selected.length === 0) return;
    setRunPhase('idle');
    setAnalysisLogs([]);

    // Populate taskTodos from checklist
    const newTodos: TodoItem[] = selected.map((it, i) => ({
      id: `todo-${Date.now()}-${i}`,
      content: it.title,
      status: 'pending' as const,
      priority: it.priority,
    }));
    setTaskTodos(task.id, newTodos);
    setChecklist([]);

    const checklistText = selected
      .map((it, i) => `### ${i + 1}. ${it.title}\n${it.description}`)
      .join('\n\n');
    const implDescription = [task.description, '', '## Files to Implement', checklistText].filter(Boolean).join('\n');

    void handleImplement(implDescription, capturedAnalysis);
  }

  function handlePause() {
    abortFn?.();
    setAbortFn(null);
    pauseTask(task.id);
  }

  function handleStop() {
    abortFn?.();
    setAbortFn(null);
    stopTask(task.id);
  }

  function handleResume() {
    const handoff = task.handoffContext ? `${task.handoffContext}\n\n---\n\n` : '';
    const description = `${handoff}${task.description}`;
    void handleImplement(description, task.projectAnalysis ?? '');
  }

  async function handleRunTodo(todo: TodoItem) {
    if (runningTodoId || task.terminal.isRunning) return;
    setRunningTodoId(todo.id);
    setTodoStatus(task.id, todo.id, 'in_progress');

    const cachedCtx = taskProject?.repoPath ? getCachedContext(taskProject.repoPath)?.content ?? '' : '';
    const description = [
      `## Task: ${task.title}`,
      task.description ? `\n${task.description}` : '',
      '',
      `## Implement this specific step:`,
      todo.content,
    ].join('\n');

    try {
      await handleImplement(description, (cachedCtx || task.projectAnalysis) ?? '');
      setTodoStatus(task.id, todo.id, 'completed');
    } catch {
      setTodoStatus(task.id, todo.id, 'pending');
    } finally {
      setRunningTodoId(null);
    }
  }

  async function handleBranchConfirm(configs: BranchConfig[]) {
    setShowBranchModal(false);
    const projectsWithPaths = configs
      .map(c => ({ ...c, repoPath: projects[c.projectId]?.repoPath ?? '' }))
      .filter(c => c.repoPath && c.repoPath !== '__jira__');
    await Promise.allSettled(
      projectsWithPaths.map(c => createBranch(c.repoPath, c.baseBranch, c.newBranch)),
    );
    if (configs[0]) setTaskBranch(task.id, configs[0].newBranch);
    void handleAnalyze();
  }

  const STATUS_OPTIONS: TaskStatus[] = ['backlog', 'in_progress', 'paused', 'stopped', 'done', 'failed'];
  const selectedCount = checklist.filter(c => c.selected).length;
  const branchProjects = taskProject ? [taskProject] : [];

  return (
    <>
    {showBranchModal && branchProjects.length > 0 && (
      <BranchSelectionModal
        task={task}
        projects={branchProjects}
        onConfirm={configs => { void handleBranchConfirm(configs); }}
        onSkip={() => { setShowBranchModal(false); void handleAnalyze(); }}
        onCancel={() => setShowBranchModal(false)}
      />
    )}
    <div className="flex-1 overflow-y-auto bg-base">
      {/* Sticky top bar */}
      <div className="sticky top-0 z-10 bg-white/90 backdrop-blur-sm border-b border-border px-6 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-hover rounded-xl transition-colors">
          <ArrowLeft size={15} />
        </button>
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <div className={clsx('w-2 h-2 rounded-full', statusMeta.dot)} />
          <span className="text-xs text-slate-500">{statusMeta.label}</span>
          {task.terminal.isRunning && (
            <span className="text-[10px] text-primary font-medium flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              RUNNING
            </span>
          )}
          {runPhase === 'analyzing' && (
            <span className="text-[10px] text-violet-500 font-medium flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" />
              ANALYZING
            </span>
          )}
          {taskProject && (
            <div className="flex items-center gap-1 text-[10px] text-slate-400 ml-2">
              <FolderGit2 size={9} />
              <span>{taskProject.name}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {task.terminal.logs.length > 0 && (
            <button onClick={() => openTerminal(task.id)} className="flex items-center gap-1.5 px-3 py-1.5 border border-border hover:border-border-focus text-slate-500 hover:text-primary text-xs rounded-xl transition-colors">
              <TerminalIcon size={12} />
              Terminal
            </button>
          )}
          {taskProject?.repoPath && (
            <button
              onClick={async () => {
                setOpeningTerminal(true);
                await openExternalTerminal(taskProject.repoPath);
                setTimeout(() => setOpeningTerminal(false), 1500);
              }}
              disabled={openingTerminal}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-border hover:border-amber-300 text-slate-500 hover:text-amber-600 text-xs rounded-xl transition-colors disabled:opacity-50"
            >
              {openingTerminal ? <Loader2 size={12} className="animate-spin" /> : <TerminalIcon size={12} className="text-amber-500" />}
              {openingTerminal ? 'Opening…' : 'Open Folder'}
            </button>
          )}
          {/* Idle / backlog: Run Task */}
          {!task.terminal.isRunning && task.status !== 'done' && task.status !== 'paused' && task.status !== 'failed' && task.status !== 'stopped' && runPhase === 'idle' && (
            <button
              onClick={() => taskProject?.repoPath ? setShowBranchModal(true) : void handleAnalyze()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-primary hover:bg-primary/90 text-white text-xs font-medium rounded-xl transition-colors shadow-sm"
            >
              <Play size={12} />
              {task.terminal.logs.length > 0 ? 'Re-run' : 'Run Task'}
            </button>
          )}
          {/* Paused / Failed: Resume with handoff */}
          {canResume && runPhase === 'idle' && (
            <button
              onClick={handleResume}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-medium rounded-xl transition-colors shadow-sm"
            >
              <RotateCcw size={12} />
              {task.status === 'failed' ? 'Retry with Handoff' : 'Resume'}
            </button>
          )}
          {runPhase === 'analyzing' && (
            <button onClick={cancelAnalysis} className="px-3 py-1.5 text-xs border border-slate-200 text-slate-500 hover:text-red-500 hover:border-red-300 rounded-xl transition-colors">
              Cancel
            </button>
          )}
          {task.terminal.isRunning && (
            <>
              <button onClick={handlePause} className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 border border-amber-200 text-amber-600 text-xs rounded-xl hover:bg-amber-100 transition-colors">
                <PauseCircle size={12} /> Pause
              </button>
              <button onClick={handleStop} className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 border border-red-200 text-red-500 text-xs rounded-xl hover:bg-red-100 transition-colors">
                Stop
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="sticky top-[53px] z-10 bg-white/90 backdrop-blur-sm border-b border-border px-6 flex gap-1">
        {([
          ['overview', <Info size={12} />, 'Overview'],
          ['checklist', <ListTodo size={12} />, `Checklist${taskTodos.length > 0 ? ` (${doneTodos}/${taskTodos.length})` : ''}`],
          ['activity', <Activity size={12} />, `Activity${task.terminal.logs.length > 0 ? ` (${task.terminal.logs.length})` : ''}`],
        ] as [DetailTab, React.ReactNode, string][]).map(([tab, icon, label]) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors',
              activeTab === tab
                ? 'border-primary text-primary'
                : 'border-transparent text-slate-500 hover:text-slate-700',
            )}
          >
            {icon}{label}
          </button>
        ))}
      </div>

      <div className="px-6 py-6 max-w-4xl mx-auto space-y-5">

        {/* ── OVERVIEW TAB ── */}
        {activeTab === 'overview' && (
          <>
            {/* Analysis / Confirm panel */}
            {(runPhase === 'analyzing' || runPhase === 'confirm') && (
              <div className="space-y-3">
                <div className="bg-[#0d1117] rounded-xl overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-[#21262d]">
                    {runPhase === 'analyzing'
                      ? <Loader2 size={10} className="animate-spin text-[#3fb950] shrink-0" />
                      : <CheckCircle2 size={10} className="text-[#3fb950] shrink-0" />}
                    <span className="font-mono text-[10px] text-[#6e7681]">
                      {runPhase === 'analyzing' ? 'AI Agent analyzing codebase…' : 'Analysis complete — review implementation plan'}
                    </span>
                  </div>
                  <div className="p-3 font-mono text-[11px] space-y-0.5 max-h-52 overflow-y-auto">
                    {analysisLogs.map(log => <AnalysisLine key={log.id} log={log} />)}
                    {runPhase === 'analyzing' && <div className="text-[#3fb950] animate-pulse mt-1">▊</div>}
                    <div ref={logsEndRef} />
                  </div>
                </div>

                {runPhase === 'confirm' && (
                  <>
                    {checklist.length > 0 ? (
                      <div className="bg-[#0d1117] rounded-xl overflow-hidden">
                        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#21262d]">
                          <span className="font-mono text-xs text-[#c9d1d9] font-semibold flex-1">Implementation Plan</span>
                          <span className="font-mono text-[10px] text-[#6e7681]">{selectedCount}/{checklist.length}</span>
                        </div>
                        <div className="px-4 py-3 space-y-1.5">
                          {checklist.map((item, i) => (
                            <div
                              key={i}
                              onClick={() => setChecklist(prev => prev.map((c, j) => j === i ? { ...c, selected: !c.selected } : c))}
                              className="flex items-start gap-2.5 cursor-pointer group"
                            >
                              <span className={clsx('font-mono text-xs shrink-0 mt-px transition-colors', item.selected ? 'text-emerald-400' : 'text-[#6e7681]')}>
                                {item.selected ? '☑' : '○'}
                              </span>
                              <span className={clsx('flex-1 font-mono text-xs leading-relaxed transition-colors', item.selected ? 'text-[#c9d1d9] group-hover:text-white' : 'line-through text-[#6e7681]')}>
                                {item.title}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-700">
                        No implementation plan generated — try re-analyzing.
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <button onClick={cancelAnalysis} className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
                        Cancel
                      </button>
                      <button onClick={() => { void handleAnalyze(); }} className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-slate-200 text-slate-500 hover:text-primary hover:border-violet-300 rounded-lg transition-colors">
                        <RefreshCw size={11} /> Re-analyze
                      </button>
                      <button
                        onClick={handleConfirm}
                        disabled={selectedCount === 0}
                        className="flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg transition-colors shadow-sm ml-auto"
                      >
                        <Play size={12} />
                        Implement {selectedCount} {selectedCount === 1 ? 'change' : 'changes'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Fail reason */}
            {task.status === 'failed' && task.failReason && (
              <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={13} className="text-red-500 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-red-700 mb-1">Task Failed — Nguyên nhân</div>
                    <pre className="text-[11px] text-red-600 font-mono whitespace-pre-wrap break-all leading-relaxed">{task.failReason}</pre>
                  </div>
                </div>
              </div>
            )}

            {/* Handoff context panel when paused/failed */}
            {(task.status === 'paused' || task.status === 'failed') && task.handoffContext && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <RotateCcw size={13} className="text-amber-600" />
                    <span className="text-xs font-semibold text-amber-800">Context Handoff</span>
                    <span className="text-[10px] text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded-full">Sẽ được dùng khi Resume</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => {
                        void navigator.clipboard.writeText(editingHandoff ? handoffDraft : task.handoffContext ?? '');
                        setHandoffCopied(true);
                        setTimeout(() => setHandoffCopied(false), 1500);
                      }}
                      className="flex items-center gap-1 px-2 py-1 text-[10px] text-amber-700 hover:bg-amber-100 rounded-lg transition-colors"
                    >
                      <ClipboardCopy size={10} />
                      {handoffCopied ? 'Copied!' : 'Copy'}
                    </button>
                    <button
                      onClick={() => {
                        if (editingHandoff) {
                          setHandoffContext(task.id, handoffDraft);
                          setEditingHandoff(false);
                        } else {
                          setHandoffDraft(task.handoffContext ?? '');
                          setEditingHandoff(true);
                        }
                      }}
                      className="px-2 py-1 text-[10px] text-amber-700 hover:bg-amber-100 rounded-lg transition-colors"
                    >
                      {editingHandoff ? 'Save' : 'Edit'}
                    </button>
                    {editingHandoff && (
                      <button
                        onClick={() => setEditingHandoff(false)}
                        className="px-2 py-1 text-[10px] text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
                {editingHandoff ? (
                  <textarea
                    value={handoffDraft}
                    onChange={e => setHandoffDraft(e.target.value)}
                    className="w-full font-mono text-[11px] text-amber-900 bg-amber-50 border border-amber-300 rounded-lg p-2 resize-y min-h-32 outline-none focus:border-amber-500"
                  />
                ) : (
                  <pre className="text-[11px] text-amber-800 font-mono whitespace-pre-wrap break-all leading-relaxed max-h-48 overflow-y-auto">{task.handoffContext}</pre>
                )}
              </div>
            )}

            {/* Title */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className={clsx('text-[10px] font-semibold px-1.5 py-0.5 rounded-md border', priorityMeta.color, priorityMeta.border)}>
                  {priorityMeta.label.toUpperCase()}
                </span>
              </div>
              <h1 className="text-xl font-bold text-slate-800 mb-2">{task.title}</h1>
              {task.description && <p className="text-sm text-slate-500 leading-relaxed whitespace-pre-wrap">{task.description}</p>}
              {task.attachments && task.attachments.length > 0 && (
                <div className="mt-3"><AttachmentGrid attachments={task.attachments} /></div>
              )}
            </div>

            {/* Meta grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <MetaCard icon={<Cpu size={12} />} label="Model">
                <span style={{ color: modelInfo.color }} className="text-xs font-semibold">{modelInfo.label}</span>
              </MetaCard>
              <MetaCard icon={<Clock size={12} />} label="Status">
                <select value={task.status} onChange={e => updateTaskStatus(task.id, e.target.value as TaskStatus)} className="bg-transparent text-xs text-slate-700 outline-none cursor-pointer font-medium">
                  {STATUS_OPTIONS.map(s => <option key={s} value={s} className="bg-white">{STATUS_META[s].label}</option>)}
                </select>
              </MetaCard>
              <MetaCard icon={<Calendar size={12} />} label="Created">
                <span className="text-xs text-slate-500">{formatRelative(task.createdAt)}</span>
              </MetaCard>
              {task.agentConfig.schedule && (
                <MetaCard icon={<Calendar size={12} className="text-amber-500" />} label="Schedule">
                  <div>
                    <span className="text-xs font-semibold text-amber-600">{cronLabel(task.agentConfig.schedule)}</span>
                    <div className="text-[10px] font-mono text-slate-400 mt-0.5">{task.agentConfig.schedule}</div>
                  </div>
                </MetaCard>
              )}
            </div>

            {/* Tags */}
            {task.tags.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <Tag size={12} className="text-slate-400" />
                {task.tags.map(tag => (
                  <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 text-slate-500">{tag}</span>
                ))}
              </div>
            )}

            {/* Progress */}
            {progress > 0 && (
              <div className="bg-white border border-border rounded-2xl p-4 shadow-card">
                <div className="flex justify-between text-xs text-slate-500 mb-2">
                  <span>Overall Progress</span>
                  <span className="font-mono font-medium text-slate-700">{progress}%</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className={clsx('h-full rounded-full transition-all duration-700', progress === 100 ? 'bg-emerald-500' : 'bg-primary')} style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}

            {/* Token usage */}
            {task.terminal.tokenUsage.total > 0 && (
              <div className="bg-white border border-border rounded-2xl p-4 shadow-card">
                <h3 className="text-xs font-semibold text-slate-600 mb-3">Token Usage — Phiên hiện tại</h3>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                  <TokenStat label="Input" value={task.terminal.tokenUsage.input} color="text-blue-600" />
                  <TokenStat label="Output" value={task.terminal.tokenUsage.output} color="text-violet-600" />
                  <TokenStat label="Cache Read" value={task.terminal.tokenUsage.cacheRead} color="text-amber-600" />
                  <TokenStat label="Cache Write" value={task.terminal.tokenUsage.cacheWrite} color="text-orange-600" />
                  <TokenStat label="Total" value={task.terminal.tokenUsage.total} color="text-slate-800" />
                </div>
                <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
                  <span className="text-slate-400">Elapsed: {formatDuration(task.terminal.elapsedMs)}</span>
                  <span className="text-emerald-600 font-mono font-semibold">${task.terminal.cost.toFixed(4)}</span>
                </div>
              </div>
            )}

            {/* Session history */}
            {(task.sessions ?? []).length > 0 && (
              <div className="bg-white border border-border rounded-2xl shadow-card overflow-hidden">
                <button
                  onClick={() => setShowSessionHistory(v => !v)}
                  className="w-full flex items-center justify-between p-4 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  <span>Lịch sử phiên ({task.sessions!.length} phiên)</span>
                  {showSessionHistory ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
                {showSessionHistory && (
                  <div className="border-t border-border divide-y divide-slate-100">
                    {task.sessions!.map((s, i) => (
                      <div key={s.id} className="px-4 py-3 flex items-center gap-3 text-xs">
                        <span className={clsx('w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0',
                          s.success === true ? 'bg-emerald-100 text-emerald-700' :
                          s.success === false ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-500',
                        )}>
                          {i + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-slate-500">{formatRelative(s.startedAt)}</div>
                          {s.failReason && <div className="text-red-500 text-[10px] truncate mt-0.5">{s.failReason.slice(0, 80)}</div>}
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-mono text-slate-500">{(s.tokenUsage.total / 1000).toFixed(1)}k tok</div>
                          <div className="font-mono text-emerald-600">${s.cost.toFixed(4)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Knowledge generation */}
            {task.status === 'done' && task.projectId && (() => {
              const isGenerating = generating.has(task.id);
              const existing = Object.values(knowledgeEntries).find(k => k.taskId === task.id);
              return (
                <div className="bg-white border border-border rounded-2xl p-4 shadow-card">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <BookOpen size={13} className="text-primary" />
                      <h3 className="text-xs font-semibold text-slate-600">Project Knowledge</h3>
                    </div>
                    {!existing && (
                      <button
                        disabled={isGenerating}
                        onClick={() => generateFromTask(task.id, task.projectId!, task.title, task.terminal.logs.map(l => l.content), task.description)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-50 hover:bg-violet-100 border border-violet-200 text-violet-700 text-[10px] font-medium rounded-lg transition-colors disabled:opacity-50"
                      >
                        {isGenerating ? <><Loader2 size={10} className="animate-spin" /> Generating…</> : <><Sparkles size={10} /> Generate Knowledge</>}
                      </button>
                    )}
                  </div>
                  {existing ? (
                    <div className="space-y-2">
                      <p className="text-xs text-slate-600 leading-relaxed">{existing.summary}</p>
                      {existing.keyPoints.length > 0 && (
                        <ul className="space-y-1">
                          {existing.keyPoints.map((pt, i) => (
                            <li key={i} className="text-[11px] text-slate-500 flex items-start gap-1.5">
                              <span className="text-violet-400 mt-px shrink-0">•</span>{pt}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-400">Tổng hợp kiến thức từ task này vào knowledge base của project.</p>
                  )}
                </div>
              );
            })()}
          </>
        )}

        {/* ── CHECKLIST TAB ── */}
        {activeTab === 'checklist' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-slate-700">Update Todos</h2>
                <p className="text-[11px] text-slate-400 mt-0.5">Từng bước implement — click Run để agent thực hiện từng todo</p>
              </div>
              {taskTodos.length > 0 && (
                <span className="text-xs font-mono text-slate-500 bg-slate-100 px-2 py-1 rounded-lg">
                  {doneTodos}/{taskTodos.length} done
                </span>
              )}
            </div>

            {/* Progress bar */}
            {taskTodos.length > 0 && (
              <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className={clsx('h-full rounded-full transition-all duration-500', doneTodos === taskTodos.length ? 'bg-emerald-500' : 'bg-primary')}
                  style={{ width: `${taskTodos.length > 0 ? Math.round((doneTodos / taskTodos.length) * 100) : 0}%` }}
                />
              </div>
            )}

            {/* Todo list — image-2 style */}
            <div className="bg-[#0d1117] rounded-xl overflow-hidden">
              {taskTodos.length === 0 ? (
                <div className="py-10 flex flex-col items-center justify-center gap-2 text-[#6e7681]">
                  <ListTodo size={20} />
                  <p className="text-xs">Chưa có todos. Thêm mới bên dưới hoặc chạy task để AI tạo kế hoạch.</p>
                </div>
              ) : (
                <div className="divide-y divide-[#21262d]">
                  {taskTodos.map(todo => {
                    const isRunningThis = runningTodoId === todo.id;
                    const canRun = todo.status === 'pending' && !runningTodoId && !task.terminal.isRunning;
                    return (
                      <div key={todo.id} className="flex items-start gap-3 px-4 py-3 group hover:bg-[#161b22] transition-colors">
                        {/* Symbol column — ✓ / * / □ */}
                        <button
                          onClick={() => toggleTaskTodo(task.id, todo.id)}
                          className="shrink-0 mt-px font-mono text-sm leading-none w-4 text-center"
                          title="Toggle status"
                        >
                          {todo.status === 'completed'
                            ? <span className="text-emerald-400">✓</span>
                            : todo.status === 'in_progress'
                              ? <span className="text-amber-400 animate-pulse">*</span>
                              : <span className="text-[#6e7681]">□</span>}
                        </button>

                        {/* Content */}
                        <span className={clsx(
                          'flex-1 text-[11px] font-mono leading-relaxed',
                          todo.status === 'completed' ? 'line-through text-[#6e7681]' :
                          todo.status === 'in_progress' ? 'text-amber-300 font-medium' :
                          'text-[#c9d1d9]',
                        )}>
                          {todo.content}
                        </span>

                        {/* Actions */}
                        <div className="flex items-center gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                          {canRun && (
                            <button
                              onClick={() => { void handleRunTodo(todo); }}
                              className="flex items-center gap-1 px-2 py-0.5 bg-violet-900/60 border border-violet-700/50 text-violet-300 text-[10px] rounded-md hover:bg-violet-800/70 transition-colors"
                            >
                              <Play size={9} />
                              Run
                            </button>
                          )}
                          {isRunningThis && (
                            <span className="flex items-center gap-1 text-[10px] text-amber-400">
                              <Loader2 size={9} className="animate-spin" />
                              Running…
                            </span>
                          )}
                          <button
                            onClick={() => deleteTaskTodo(task.id, todo.id)}
                            className="p-1 text-[#6e7681] hover:text-red-400 transition-colors rounded"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Add new todo */}
            <div className="flex gap-2">
              <input
                type="text"
                value={newTodoInput}
                onChange={e => setNewTodoInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && newTodoInput.trim()) {
                    addTaskTodo(task.id, newTodoInput.trim());
                    setNewTodoInput('');
                  }
                }}
                placeholder="Thêm todo item… (Enter để lưu)"
                className="flex-1 text-xs border border-border rounded-xl px-3 py-2 outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 bg-white"
              />
              <button
                onClick={() => {
                  if (newTodoInput.trim()) {
                    addTaskTodo(task.id, newTodoInput.trim());
                    setNewTodoInput('');
                  }
                }}
                className="p-2 bg-primary text-white rounded-xl hover:bg-primary/90 transition-colors disabled:opacity-40"
                disabled={!newTodoInput.trim()}
              >
                <Plus size={14} />
              </button>
            </div>
          </div>
        )}

        {/* ── ACTIVITY TAB ── */}
        {activeTab === 'activity' && (
          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-700">Agent Activity</h2>
              <p className="text-[11px] text-slate-400 mt-0.5">Các bước AI đã thực hiện trong phiên hiện tại</p>
            </div>

            {/* Live steps plan — image-2 style */}
            {task.terminal.todos.length > 0 && (
              <div className="bg-[#0d1117] rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 border-b border-[#21262d] flex items-center justify-between">
                  <span className="font-mono text-[10px] text-[#6e7681] font-semibold uppercase tracking-wider">Update Todos</span>
                  <span className="text-[10px] font-mono text-[#6e7681]">
                    {task.terminal.todos.filter(t => t.status === 'completed').length}/{task.terminal.todos.length}
                  </span>
                </div>
                {/* Step progress bar */}
                <div className="h-0.5 bg-[#21262d]">
                  <div
                    className="h-full bg-[#3fb950] transition-all duration-500"
                    style={{ width: `${task.terminal.todos.length > 0 ? Math.round((task.terminal.todos.filter(t => t.status === 'completed').length / task.terminal.todos.length) * 100) : 0}%` }}
                  />
                </div>
                <div className="px-4 py-3 space-y-[3px]">
                  {task.terminal.todos.map((todo, i) => (
                    <div key={todo.id ?? i} className="flex items-start gap-2 font-mono text-[11px]">
                      {todo.status === 'completed'
                        ? <span className="shrink-0 text-emerald-400 mt-px select-none">✓</span>
                        : todo.status === 'in_progress'
                          ? <span className="shrink-0 text-amber-400 mt-px select-none animate-pulse">*</span>
                          : <span className="shrink-0 text-[#6e7681] mt-px select-none">□</span>
                      }
                      <span className={clsx(
                        'flex-1 leading-relaxed',
                        todo.status === 'completed' ? 'line-through text-[#6e7681]' :
                        todo.status === 'in_progress' ? 'text-amber-300 font-medium' :
                        'text-[#c9d1d9]',
                      )}>
                        {todo.content}
                      </span>
                      {todo.status === 'in_progress' && task.terminal.isRunning && (
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse mt-1.5 shrink-0" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Token stats while running */}
            {(task.terminal.isRunning || task.terminal.tokenUsage.total > 0) && (
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-blue-500 mb-1">Input tokens</div>
                  <div className="font-mono font-bold text-blue-700 text-sm">{(task.terminal.tokenUsage.input / 1000).toFixed(1)}k</div>
                </div>
                <div className="bg-violet-50 border border-violet-100 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-violet-500 mb-1">Output tokens</div>
                  <div className="font-mono font-bold text-violet-700 text-sm">{(task.terminal.tokenUsage.output / 1000).toFixed(1)}k</div>
                </div>
                <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-emerald-500 mb-1">Cost</div>
                  <div className="font-mono font-bold text-emerald-700 text-sm">${task.terminal.cost.toFixed(4)}</div>
                </div>
              </div>
            )}

            {/* Activity log */}
            <div className="bg-[#0d1117] rounded-xl overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-[#21262d]">
                <span className="font-mono text-[10px] text-[#6e7681]">
                  {task.terminal.isRunning ? 'Running…' : `${task.terminal.logs.length} log entries`}
                </span>
                {task.terminal.isRunning && <span className="w-1.5 h-1.5 rounded-full bg-[#3fb950] animate-pulse" />}
              </div>
              <div className="p-3 font-mono text-[11px] space-y-0.5 max-h-96 overflow-y-auto">
                {task.terminal.logs.length === 0 ? (
                  <div className="text-[#6e7681] py-6 text-center">Chưa có activity. Chạy task để bắt đầu.</div>
                ) : (
                  task.terminal.logs.map(log => (
                    <ActivityLogLine key={log.id} log={log} />
                  ))
                )}
                {task.terminal.isRunning && <div className="text-[#3fb950] animate-pulse">▊</div>}
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
    </>
  );
}

// ── Rich log renderer shared by Activity log + AnalysisLine ─────────────────

type RichLog = {
  id: string; type: string; content: string; toolName?: string;
  timestamp?: Date;
  filePath?: string; lineRange?: string; linesAdded?: number;
  linesRemoved?: number; diffPreview?: string[];
};

const LOG_TYPE_COLORS: Record<string, string> = {
  system:      'text-[#6e7681]',
  info:        'text-[#c9d1d9]',
  thinking:    'text-[#d2a8ff]',
  tool_call:   'text-[#e3b341]',
  tool_result: 'text-[#3fb950]',
  success:     'text-[#3fb950]',
  error:       'text-[#f85149]',
};

function RichLogLine({ log, showTime }: { log: RichLog; showTime?: boolean }) {
  if (!log.content.trim() && !log.filePath) return null;

  const time = log.timestamp
    ? log.timestamp.toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  // File-aware tool calls — image-1 style
  if (log.type === 'tool_call' && (log.filePath || log.toolName)) {
    const isEdit  = log.toolName === 'Edit';
    const isWrite = log.toolName === 'Write';
    const isRead  = log.toolName === 'Read';
    const isBash  = log.toolName === 'Bash';
    const toolColor = isEdit ? 'text-[#e3b341]' : isWrite ? 'text-[#d2a8ff]' : isRead ? 'text-[#79c0ff]' : isBash ? 'text-[#3fb950]' : 'text-[#e3b341]';

    return (
      <div className="space-y-0.5 my-[2px]">
        <div className="flex gap-2 leading-relaxed items-baseline">
          {showTime && time && (
            <span className="text-[#484f58] shrink-0 select-none tabular-nums">{time}</span>
          )}
          <span className="text-[#e3b341] shrink-0">●</span>
          <span className="flex-1 flex items-baseline gap-1.5 flex-wrap">
            <span className={clsx('font-semibold shrink-0', toolColor)}>{log.toolName}</span>
            {log.filePath
              ? <span className="text-[#79c0ff] break-all">{log.filePath}</span>
              : <span className="text-[#8b949e] break-all">{log.content.slice(0, 120)}</span>}
            {log.lineRange && (
              <span className="text-[#6e7681] shrink-0">({log.lineRange})</span>
            )}
          </span>
        </div>
        {(isEdit || isWrite) && log.linesAdded && (
          <div className="flex gap-3 pl-8">
            <span className="text-[#3fb950]">Added {log.linesAdded} lines</span>
            {log.linesRemoved && <span className="text-[#f85149]">Removed {log.linesRemoved} lines</span>}
          </div>
        )}
        {log.diffPreview && log.diffPreview.length > 0 && (
          <div className="ml-8 bg-[#0d1117] border border-[#21262d] rounded px-2 py-1 space-y-px">
            {log.diffPreview.map((line, i) => (
              <div key={i} className={clsx(
                line.startsWith('+') ? 'text-[#3fb950]' :
                line.startsWith('-') ? 'text-[#f85149]' :
                'text-[#6e7681]',
              )}>{line}</div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Thinking
  if (log.type === 'thinking') {
    return (
      <div className="flex gap-2 leading-relaxed">
        {showTime && time && <span className="text-[#484f58] shrink-0 tabular-nums">{time}</span>}
        <span className="text-[#d2a8ff] italic opacity-80 flex-1">💭 {log.content.slice(0, 300)}</span>
      </div>
    );
  }

  // Tool result
  if (log.type === 'tool_result') {
    return (
      <div className="flex gap-2 leading-relaxed">
        {showTime && time && <span className="text-[#484f58] shrink-0 tabular-nums">{time}</span>}
        <span className="text-[#3fb950] flex-1">└─ {log.content.slice(0, 300)}</span>
      </div>
    );
  }

  // Default
  const color = LOG_TYPE_COLORS[log.type] ?? 'text-[#c9d1d9]';
  const prefixes: Record<string, string> = { system: '──', info: '▸ ', success: '✔ ', error: '✖ ' };
  const prefix = prefixes[log.type] ?? '▸ ';
  return (
    <div className="flex gap-2 leading-relaxed">
      {showTime && time && <span className="text-[#484f58] shrink-0 select-none tabular-nums">{time}</span>}
      <span className={clsx('shrink-0', color)}>{prefix}</span>
      <span className={clsx('flex-1 break-all', color)}>{log.content.slice(0, 400)}</span>
    </div>
  );
}

function ActivityLogLine({ log }: { log: RichLog & { timestamp: Date } }) {
  return <RichLogLine log={log} showTime />;
}

function AnalysisLine({ log }: { log: LogItem }) {
  return <RichLogLine log={log} />;
}

function MetaCard({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-border rounded-2xl p-3 shadow-card">
      <div className="flex items-center gap-1 text-[10px] text-slate-400 mb-1.5">
        {icon}
        <span className="uppercase tracking-wide font-medium">{label}</span>
      </div>
      {children}
    </div>
  );
}

function TokenStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="text-slate-400 mb-0.5">{label}</div>
      <div className={clsx('font-mono font-bold', color)}>{value.toLocaleString()}</div>
    </div>
  );
}
