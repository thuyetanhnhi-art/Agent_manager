import { useEffect, useRef, useMemo, useState } from 'react';
import {
  X, Play, PauseCircle, Square, GitBranch, Cpu, Clock,
  FileCode2, ChevronRight, Plus, Activity, Settings2, Terminal,
  GitPullRequest, CheckCircle2, Loader2, ExternalLink, XCircle, CircleDot,
  ClipboardList, RotateCcw,
} from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../store';
import { useProjectStore } from '../projectStore';
import { STATUS_META, PRIORITY_META, MODEL_INFO, LABEL_META, LogEntry, TaskStatus } from '../types';
import { makeLog } from '../simulator';
import { formatDuration, formatRelative, makeBranchName } from '../utils';
import { AttachmentGrid } from './AttachmentGrid';
import { FbTaskDetail } from './FbTaskDetail';

type Tab = 'activity' | 'details';

export function TaskDetailPanel() {
  const {
    tasks, detailPanelTaskId, autoRunTaskId, setAutoRunTaskId,
    closeDetailPanel, openCreateModal, openDetailPanel,
    startTask, stopTask, pauseTask, appendLog, updateTokens, updateLiveTokens, resetLiveTokens, tickElapsed,
    completeTask, setAbortFn, updateTaskStatus, setTaskBranch, setReviewPending,
    setProjectAnalysis, updateValidationResult, updateTodos, setTaskTodos,
    captureUsageStart, captureUsageEnd, deleteTask,
  } = useStore();
  const { projects } = useProjectStore();

  const [tab, setTab] = useState<Tab>('activity');
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [creatingPR, setCreatingPR] = useState(false);
  const [prResult, setPrResult] = useState<{ ok: boolean; prUrl?: string; error?: string } | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const handleRunRef = useRef<(() => void) | null>(null);
  // Signal to abort the running for-loop between subtasks
  const abortRequestedRef = useRef(false);
  const abortIsStopRef = useRef(false); // true = Stop, false = Pause

  const task = detailPanelTaskId ? tasks[detailPanelTaskId] : null;
  const project = task?.projectId ? projects[task.projectId] : null;

  const subtasks = useMemo(() => {
    if (!task) return [];
    return task.subtaskIds.map(id => tasks[id]).filter(Boolean);
  }, [task?.subtaskIds, tasks]);

  const doneSubs = subtasks.filter(t => t.status === 'done').length;
  const runningSub = subtasks.find(t => t.terminal.isRunning) ?? null;

  // In Activity tab: show the running subtask's logs, else the parent's logs
  const activityTask = runningSub ?? task;

  const filesChanged = useMemo(() => {
    if (!activityTask) return [];
    return activityTask.terminal.logs
      .filter(l => l.type === 'tool_call' && l.toolName === 'write_file')
      .map(l => {
        const p = l.content.match(/path:\s*"([^"]+)"/)?.[1] ?? '';
        const lines = l.content.match(/lines:\s*(\d+)/)?.[1];
        return { path: p, lines: lines ? parseInt(lines) : null };
      })
      .filter(f => f.path);
  }, [activityTask?.terminal.logs]);

  // Fetch real project files for simulation context
  useEffect(() => {
    if (!project?.repoPath) return;
    fetch(`/api/files?path=${encodeURIComponent(project.repoPath)}`)
      .then(r => r.json())
      .then((d: { files?: string[] }) => setProjectFiles(d.files ?? []))
      .catch(() => {});
  }, [project?.repoPath]);

  // Auto-scroll to latest log
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activityTask?.terminal.logs.length, tab]);

  // Close on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDetailPanel(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [closeDetailPanel]);

  // Cleanup SSE on unmount
  useEffect(() => () => { esRef.current?.close(); }, []);

  // Auto-run when opened from TaskCard Run button
  useEffect(() => {
    if (autoRunTaskId && autoRunTaskId === detailPanelTaskId && handleRunRef.current) {
      setAutoRunTaskId(null);
      handleRunRef.current();
    }
  }, [autoRunTaskId, detailPanelTaskId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to SSE stream for a running task, resolving when done
  function streamTask(taskId: string, runId: string): Promise<boolean> {
    resetLiveTokens(taskId);
    void captureUsageStart(taskId);

    return new Promise(resolve => {
      const es = new EventSource(`/api/task-stream/${runId}`);
      esRef.current = es;

      es.onmessage = (e: MessageEvent<string>) => {
        type Payload =
          | { type: 'event'; event: Record<string, unknown> }
          | { type: 'text'; content: string }
          | { type: 'stderr'; content: string }
          | { type: 'error'; content: string }
          | { type: 'done'; success: boolean };

        const data = JSON.parse(e.data) as Payload;

        if (data.type === 'event') {
          const ev = data.event;

          // Handle TodoWrite: update terminal.todos + taskTodos in realtime
          if (ev.type === 'assistant') {
            type Block = { type: string; name?: string; input?: unknown };
            const msg = ev.message as { content?: Block[] } | undefined;
            for (const block of msg?.content ?? []) {
              if (block.type === 'tool_use' && block.name === 'TodoWrite') {
                const inp = block.input as { todos?: Array<{ id?: string; content: string; status: string; priority?: string }> } | undefined;
                if (Array.isArray(inp?.todos)) {
                  const todos = inp!.todos.map((t, i) => ({
                    id: t.id ?? `todo-${Date.now()}-${i}`,
                    content: t.content,
                    status: t.status as 'pending' | 'in_progress' | 'completed',
                    priority: t.priority,
                  }));
                  updateTodos(taskId, todos);
                  setTaskTodos(taskId, todos);
                }
              }
            }
          }

          const entries = parseClaudeStreamEvents(ev);
          entries.forEach(e => appendLog(taskId, e));

          // Estimate tokens from streamed content → write to store for realtime display on TaskCard
          let inputDelta = 0, outputDelta = 0;
          for (const entry of entries) {
            const est = Math.ceil(entry.content.length / 3.5);
            if (entry.type === 'tool_result') inputDelta += est;
            else if (entry.type !== 'system') outputDelta += est;
          }
          if (inputDelta > 0 || outputDelta > 0) {
            updateLiveTokens(taskId, { input: inputDelta, output: outputDelta });
          }

          // Track token usage from the final result event
          if (ev.type === 'result') {
            const usage = ev.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
            const costUsd = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd as number : undefined;
            if (usage) {
              updateTokens(taskId, {
                input: usage.input_tokens,
                output: usage.output_tokens,
                cacheRead: usage.cache_read_input_tokens,
                cacheWrite: usage.cache_creation_input_tokens,
              }, costUsd);
            }
            const nTurns = ev.num_turns as number | undefined;
            const totalTok = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);
            appendLog(taskId, makeLog('system',
              `📊 Tokens: ${totalTok.toLocaleString()} (in ${usage?.input_tokens ?? 0} · out ${usage?.output_tokens ?? 0} · cacheR ${usage?.cache_read_input_tokens ?? 0} · cacheW ${usage?.cache_creation_input_tokens ?? 0})`
              + (nTurns != null ? ` · ${nTurns} turns` : '')
              + (costUsd != null ? ` · CLI cost $${costUsd.toFixed(4)}` : '')));
          }
        } else if (data.type === 'text') {
          // Always log (even empty — they act as spacers in the terminal)
          appendLog(taskId, makeLog('info', data.content ?? ''));
        } else if (data.type === 'stderr') {
          if (data.content.trim()) appendLog(taskId, makeLog('error', data.content.trim()));
        } else if (data.type === 'error') {
          appendLog(taskId, makeLog('error', data.content));
        } else if (data.type === 'done') {
          es.close();
          esRef.current = null;
          void captureUsageEnd(taskId);
          resolve(data.success);
        }
      };

      es.onerror = () => {
        es.close();
        esRef.current = null;
        resolve(false);
      };
    });
  }

  async function handleRun() {
    if (!task || task.terminal.isRunning) return;
    if (task.status === 'stopped') return;

    abortRequestedRef.current = false;
    abortIsStopRef.current = false;

    // ── Create branch before running ──────────────────────────────────────
    let branchName = task.branchName;
    if (project?.repoPath && !branchName) {
      const generated = makeBranchName(task.label, task.id, task.title, project.name);
      try {
        const r = await fetch('/api/create-branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPath: project.repoPath, branchName: generated }),
        });
        const data = await r.json() as { ok: boolean; branchName?: string };
        if (data.ok && data.branchName) {
          branchName = data.branchName;
          setTaskBranch(task.id, branchName);
        }
      } catch { /* proceed without branch */ }
    }

    // Filter out already-done subtasks so partial re-runs work correctly
    const pendingSubs = subtasks.filter(s => s.status !== 'done' && s.status !== 'in_progress');
    const tasksToRun = pendingSubs.length > 0
      ? pendingSubs.map(s => ({ id: s.id, title: s.title, description: s.description }))
      : subtasks.length === 0
        ? [{ id: task.id, title: task.title, description: task.description }]
        : [];

    if (tasksToRun.length === 0) return;

    startTask(task.id);
    setTab('activity');
    setPrResult(null);

    let allSuccess = true;

    for (const t of tasksToRun) {
      // Check if abort was requested before starting next subtask
      if (abortRequestedRef.current) break;

      if (subtasks.length > 0) startTask(t.id);
      appendLog(t.id, makeLog('system', `Starting: ${t.title}`));

      try {
        const isSubtask = subtasks.length > 0 && t.id !== task.id;
        // Always read fresh state so projectAnalysis captured from previous subtask is available
        const freshParent = useStore.getState().tasks[task.id];
        const freshAnalysis = freshParent?.projectAnalysis;

        const res = await fetch('/api/run-task', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: t.id,
            title: t.title,
            description: t.description,
            repoPath: project?.repoPath ?? '',
            projectName: project?.name ?? '',
            branchName: branchName ?? '',
            model: task.agentConfig.model,
            ...(isSubtask && freshAnalysis
              ? { projectContext: freshAnalysis }
              : isSubtask && task.description
              ? { parentContext: task.description }
              : {}),
          }),
        });
        const { runId } = await res.json() as { runId: string };
        setCurrentRunId(runId);

        const success = await streamTask(t.id, runId);

        // If user triggered pause/stop mid-run, don't mark as failed
        if (abortRequestedRef.current) {
          // Reset this subtask back to backlog so it reruns on resume
          updateTaskStatus(t.id, 'backlog');
          break;
        }

        completeTask(t.id, success);

        // After first subtask: capture its logs as projectAnalysis for remaining subtasks
        if (isSubtask && !freshAnalysis) {
          const freshTasks = useStore.getState().tasks;
          const subtaskLogs = freshTasks[t.id]?.terminal.logs ?? [];
          const analysis = subtaskLogs
            .filter(l => l.type === 'thinking' || l.type === 'tool_result')
            .map(l => l.content)
            .join('\n\n')
            .slice(0, 12000);
          if (analysis) setProjectAnalysis(task.id, analysis);
        }

        if (!success) { allSuccess = false; break; }
      } catch (err) {
        if (abortRequestedRef.current) {
          updateTaskStatus(t.id, 'backlog');
          break;
        }
        appendLog(t.id, makeLog('error', `Failed to start agent: ${err instanceof Error ? err.message : String(err)}`));
        completeTask(t.id, false);
        allSuccess = false;
        break;
      }
    }

    setCurrentRunId(null);
    setAbortFn(null);

    if (abortRequestedRef.current) {
      // Pause or Stop was triggered — store action already called by handlePause/handleStop
      return;
    }

    if (subtasks.length > 0) completeTask(task.id, allSuccess);
  }

  handleRunRef.current = handleRun;

  async function handlePause() {
    if (!task) return;
    abortRequestedRef.current = true;
    abortIsStopRef.current = false;
    // Close SSE — triggers onerror in streamTask → promise resolves → loop checks abort flag
    esRef.current?.close();
    esRef.current = null;
    if (currentRunId) {
      fetch('/api/stop-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: currentRunId }),
      }).catch(() => {});
    }
    // Stop all running subtasks visually (loop will reset their status to backlog)
    subtasks.forEach(s => { if (s.terminal.isRunning) updateTaskStatus(s.id, 'backlog'); });
    pauseTask(task.id);
  }

  async function handleStop() {
    if (!task) return;
    abortRequestedRef.current = true;
    abortIsStopRef.current = true;
    esRef.current?.close();
    esRef.current = null;
    if (currentRunId) {
      fetch('/api/stop-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: currentRunId }),
      }).catch(() => {});
      setCurrentRunId(null);
    }
    // Reset running subtasks to backlog (parent gets stopped status)
    subtasks.forEach(s => { if (s.terminal.isRunning) updateTaskStatus(s.id, 'backlog'); });
    stopTask(task.id);
    setAbortFn(null);
  }

  async function handleCreatePR() {
    if (!task?.branchName || !project?.repoPath) return;
    setCreatingPR(true);
    try {
      const res = await fetch('/api/create-pr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoPath: project.repoPath,
          branchName: task.branchName,
          title: task.title,
          body: [
            task.description || `Implemented by AI agent: ${task.title}`,
            '',
            `Branch: \`${task.branchName}\``,
            `Label: ${task.label}`,
          ].join('\n'),
        }),
      });
      const data = await res.json() as { ok: boolean; prUrl?: string; error?: string };
      setPrResult(data);
      if (data.ok) setReviewPending(task.id, false);
    } catch (err) {
      setPrResult({ ok: false, error: String(err) });
    }
    setCreatingPR(false);
  }

  // Aggregate tokens across parent + subtasks (must be before early return)
  const totalTokens = useMemo(() => {
    if (!task) return { input: 0, output: 0, cacheRead: 0, total: 0, cost: 0 };
    const all = [task, ...subtasks];
    return all.reduce((acc, t) => ({
      input: acc.input + t.terminal.tokenUsage.input,
      output: acc.output + t.terminal.tokenUsage.output,
      cacheRead: acc.cacheRead + t.terminal.tokenUsage.cacheRead,
      total: acc.total + t.terminal.tokenUsage.total,
      cost: acc.cost + t.terminal.cost,
    }), { input: 0, output: 0, cacheRead: 0, total: 0, cost: 0 });
  }, [task, subtasks]);

  if (!task) return null;

  if (task.taskKind === 'fb_phone_collector') {
    return (
      <div className="fixed inset-0 z-40 flex pointer-events-none">
        <div className="flex-1 pointer-events-auto" onClick={closeDetailPanel} />
        <div className="w-[48vw] min-w-[540px] h-full bg-white shadow-2xl flex flex-col pointer-events-auto animate-slide-in-right border-l border-slate-200">
          <div className="shrink-0 flex items-start gap-3 px-5 pt-4 pb-3 border-b border-slate-100">
            <button onClick={closeDetailPanel} className="mt-0.5 p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg shrink-0 transition-colors">
              <X size={15} />
            </button>
            <h2 className="text-sm font-semibold text-slate-800 leading-snug flex-1">{task.title}</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-5">
            <FbTaskDetail task={task} onDelete={() => { deleteTask(task.id); closeDetailPanel(); }} />
          </div>
        </div>
      </div>
    );
  }

  const sMeta = STATUS_META[task.status];
  const pMeta = PRIORITY_META[task.priority];
  const mInfo = MODEL_INFO[task.agentConfig.model];
  const { isRunning, isPaused, elapsedMs } = task.terminal;

  // Realtime token display: totalTokens (completed subtasks) + liveTokens (current subtask estimate from store)
  const live = task.terminal.liveTokens ?? { input: 0, output: 0 };
  const displayInput  = totalTokens.input  + (isRunning ? live.input  : 0);
  const displayOutput = totalTokens.output + (isRunning ? live.output : 0);
  const displayCost   = totalTokens.cost   + (isRunning
    ? (live.input / 1_000_000 * mInfo.inputPer1M + live.output / 1_000_000 * mInfo.outputPer1M)
    : 0);
  const displayCache = totalTokens.cacheRead;
  const displayTotal = displayInput + displayOutput + displayCache;

  const progress = subtasks.length > 0
    ? Math.round((doneSubs / subtasks.length) * 100)
    : task.progress;

  return (
    <div className="fixed inset-0 z-40 flex pointer-events-none">
      <div className="flex-1 pointer-events-auto" onClick={closeDetailPanel} />

      <div className="w-[48vw] min-w-[540px] h-full bg-white shadow-2xl flex flex-col pointer-events-auto animate-slide-in-right border-l border-slate-200 relative overflow-hidden">

        {/* ── Header ── */}
        <div className="shrink-0 px-5 pt-4 pb-3 border-b border-slate-100">
          <div className="flex items-start gap-3 mb-2.5">
            <button onClick={closeDetailPanel} className="mt-0.5 p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg shrink-0 transition-colors">
              <X size={15} />
            </button>
            <div className="flex-1 min-w-0">
              <h2 className="text-sm font-semibold text-slate-800 leading-snug">{task.title}</h2>
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                <span className={clsx('flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-lg', sMeta.bg, sMeta.color)}>
                  <span className={clsx('w-1.5 h-1.5 rounded-full', sMeta.dot)} />{sMeta.label}
                </span>
                <span className={clsx('text-[10px] font-semibold px-1.5 py-0.5 rounded-md border', pMeta.color, pMeta.border)}>
                  {pMeta.label.toUpperCase()}
                </span>
                {(() => { const lm = LABEL_META[task.label]; return (
                  <span className={clsx('text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded-md border', lm.color, lm.bg, lm.border)}>
                    {task.label}
                  </span>
                ); })()}
                {task.branchName && (
                  <span className="flex items-center gap-1 text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded-lg font-mono">
                    <GitBranch size={8} />{task.branchName}
                  </span>
                )}
                {project && (
                  <span className="flex items-center gap-1 text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded-lg">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: project.color }} />
                    {project.name}
                    {project.branch && <><GitBranch size={8} className="ml-0.5" /><span className="font-mono">{project.branch}</span></>}
                  </span>
                )}
                {elapsedMs > 0 && (
                  <span className="flex items-center gap-1 text-[10px] text-slate-400 font-mono">
                    <Clock size={9} />{formatDuration(elapsedMs)}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 pl-8">
            {(() => {
              const pendingSubs = subtasks.filter(s => s.status !== 'done' && s.status !== 'stopped');
              const isStopped = task.status === 'stopped';
              const canRun = !isRunning && !isStopped && (task.status !== 'done' || pendingSubs.length > 0);
              const runLabel = task.status === 'paused' ? 'Resume'
                : pendingSubs.length > 0 ? `Run ${pendingSubs.length} Subtask${pendingSubs.length > 1 ? 's' : ''}`
                : subtasks.length > 0 ? `Run ${subtasks.length} Subtasks`
                : 'Run Task';
              return canRun ? (
                <button onClick={handleRun} className={clsx(
                  'flex items-center gap-1.5 px-3 py-1.5 text-white text-xs font-medium rounded-xl transition-colors shadow-sm',
                  task.status === 'paused' ? 'bg-amber-500 hover:bg-amber-400' : 'bg-primary hover:bg-primary/90',
                )}>
                  <Play size={11} />{runLabel}
                </button>
              ) : null;
            })()}
            {isRunning && (
              <>
                <button onClick={handlePause} className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 border border-amber-200 text-amber-600 text-xs rounded-xl hover:bg-amber-100 transition-colors">
                  <PauseCircle size={11} />Pause
                </button>
                <button onClick={handleStop} className="flex items-center gap-1.5 px-2.5 py-1.5 bg-red-50 border border-red-200 text-red-500 text-xs rounded-xl hover:bg-red-100 transition-colors">
                  <Square size={11} />Stop
                </button>
                <span className="text-[10px] text-primary font-medium ml-1 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                  {runningSub ? `Running: ${runningSub.title.slice(0, 28)}${runningSub.title.length > 28 ? '…' : ''}` : 'Running…'}
                </span>
              </>
            )}
            {task.status === 'stopped' && (
              <span className="text-[10px] text-red-500 font-medium flex items-center gap-1">
                <Square size={10} /> Session stopped
              </span>
            )}
            {task.status === 'done' && doneSubs === subtasks.length && subtasks.length > 0 && (
              <span className="text-[10px] text-emerald-600 font-medium flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />All subtasks completed
              </span>
            )}
            {task.status === 'done' && subtasks.length === 0 && (
              <span className="text-[10px] text-emerald-600 font-medium flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />Completed
              </span>
            )}
          </div>

          {/* Progress bar */}
          {progress > 0 && (
            <div className="mt-3 pl-8">
              <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1">
                <span>{subtasks.length > 0 ? `${doneSubs} / ${subtasks.length} subtasks done` : 'Progress'}</span>
                <span className="font-mono font-medium text-slate-600">{progress}%</span>
              </div>
              <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className={clsx('h-full rounded-full transition-all duration-700', progress === 100 ? 'bg-emerald-500' : 'bg-primary')}
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Tabs */}
          <div className="flex items-center gap-1 mt-3 pl-8">
            <TabBtn active={tab === 'activity'} onClick={() => setTab('activity')} icon={<Activity size={11} />} label="Activity" pulse={isRunning && tab !== 'activity'} />
            <TabBtn active={tab === 'details'} onClick={() => setTab('details')} icon={<Settings2 size={11} />} label="Details" />
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto">

          {/* ── Activity + Log (merged) tab ── */}
          {tab === 'activity' && (
            <div className="px-4 py-3">
              {runningSub && (
                <div className="mb-3 flex items-center gap-2 text-[10px] bg-primary-glow border border-primary/20 rounded-xl px-3 py-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse shrink-0" />
                  <span className="text-primary font-medium">Now running:</span>
                  <span className="text-slate-600 truncate">{runningSub.title}</span>
                </div>
              )}

              {(activityTask?.terminal.logs ?? []).length === 0 ? (
                <div className="border-2 border-dashed border-slate-200 rounded-2xl py-10 text-center text-xs text-slate-400">
                  {task.status === 'done' ? 'Task completed — no logs.' : 'No activity yet — press Run to start.'}
                </div>
              ) : (
                <div className="relative">
                  <div className="bg-[#0d1117] rounded-xl overflow-hidden">
                    <div className="flex items-center justify-between text-[#6e7681] text-[10px] px-3 py-2 border-b border-[#21262d] font-mono">
                      <span>── {task.title.slice(0, 40)}{task.title.length > 40 ? '…' : ''} ──</span>
                      <span className="text-[#484f58] font-mono">{formatDuration(elapsedMs)}</span>
                    </div>
                    <div className="p-3 font-mono text-[11px] space-y-px pb-8">
                      {activityTask?.terminal.logs.map(log => <TerminalLogLine key={log.id} entry={log} />)}
                      {isRunning && (
                        <div className="flex items-center gap-2 pt-2 pb-1 border-t border-[#21262d]/60 mt-1">
                          <span className="flex gap-[3px] items-end">
                            <span className="inline-block w-[3px] h-3 bg-[#58a6ff] rounded-sm" style={{ animation: 'thinking-bar 1.2s ease-in-out 0s infinite' }} />
                            <span className="inline-block w-[3px] h-4 bg-[#58a6ff] rounded-sm" style={{ animation: 'thinking-bar 1.2s ease-in-out 0.2s infinite' }} />
                            <span className="inline-block w-[3px] h-3 bg-[#58a6ff] rounded-sm" style={{ animation: 'thinking-bar 1.2s ease-in-out 0.4s infinite' }} />
                          </span>
                          <span className="text-[#58a6ff] text-[10px] font-mono">
                            {runningSub ? `Running: ${runningSub.title.slice(0, 35)}` : 'AI agent working…'}
                          </span>
                        </div>
                      )}
                      <div ref={logsEndRef} />
                    </div>
                  </div>

                  {/* Absolute token badge — bottom-right of terminal */}
                  {(isRunning || displayTotal > 0) && (
                    <div className="absolute bottom-2.5 right-2.5 flex items-center gap-1 bg-[#161b22]/95 backdrop-blur-sm border border-[#30363d] rounded-lg px-2 py-1 font-mono text-[10px] z-10 flex-wrap max-w-xs">
                      <span className="text-[#58a6ff]">IN {displayInput > 0 ? `${(displayInput / 1000).toFixed(1)}k` : '—'}</span>
                      <span className="text-[#484f58]">·</span>
                      <span className="text-[#bc8cff]">OUT {displayOutput > 0 ? `${(displayOutput / 1000).toFixed(1)}k` : '—'}</span>
                      {displayCache > 0 && (
                        <>
                          <span className="text-[#484f58]">·</span>
                          <span className="text-[#e3b341]">CACHE {(displayCache / 1000).toFixed(1)}k</span>
                        </>
                      )}
                      <span className="text-[#484f58]">·</span>
                      <span className="text-[#c9d1d9] font-semibold">{displayTotal > 0 ? `${(displayTotal / 1000).toFixed(1)}k` : '—'}</span>
                      {displayCost > 0 && (
                        <>
                          <span className="text-[#484f58]">·</span>
                          <span className="text-[#3fb950] font-semibold">${displayCost.toFixed(4)}</span>
                        </>
                      )}
                      {isRunning && (
                        <span className="w-1.5 h-1.5 rounded-full bg-[#58a6ff] animate-pulse ml-0.5" />
                      )}
                    </div>
                  )}
                </div>
              )}

              {filesChanged.length > 0 && (
                <div className="mt-4">
                  <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 mb-2 flex items-center gap-1.5">
                    <FileCode2 size={10} />Files Changed ({filesChanged.length})
                  </div>
                  <div className="space-y-1">
                    {filesChanged.map((f, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs bg-amber-50 border border-amber-100 rounded-xl px-3 py-1.5">
                        <FileCode2 size={11} className="text-amber-500 shrink-0" />
                        <span className="font-mono text-slate-700 truncate flex-1">{f.path}</span>
                        {f.lines && <span className="text-[10px] text-slate-400 shrink-0">{f.lines} lines</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Details tab ── */}
          {tab === 'details' && (
            <div className="px-5 py-4 space-y-4">

              {/* Checklist progress */}
              {(() => {
                const aiTodos = task.terminal.todos ?? [];
                const userTodos = task.taskTodos ?? [];
                if (aiTodos.length === 0 && userTodos.length === 0) return null;

                const renderTodoList = (todos: typeof aiTodos, label: string) => {
                  if (todos.length === 0) return null;
                  const done = todos.filter(t => t.status === 'completed').length;
                  const inProg = todos.filter(t => t.status === 'in_progress').length;
                  const pct = Math.round((done / todos.length) * 100);
                  return (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">{label}</span>
                        <span className="text-[10px] font-mono text-slate-500">{done}/{todos.length} done{inProg > 0 ? ` · ${inProg} running` : ''}</span>
                      </div>
                      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden mb-2">
                        <div
                          className={clsx('h-full rounded-full transition-all duration-500', done === todos.length ? 'bg-emerald-500' : 'bg-primary')}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="space-y-px">
                        {todos.map((todo, i) => (
                          <div key={todo.id ?? i} className="flex items-start gap-2 py-1 font-mono text-[10px]">
                            {todo.status === 'completed'
                              ? <span className="text-emerald-500 shrink-0 mt-px select-none">✓</span>
                              : todo.status === 'in_progress'
                                ? <span className="text-amber-400 shrink-0 mt-px select-none animate-pulse">*</span>
                                : <span className="text-slate-300 shrink-0 mt-px select-none">□</span>}
                            <span className={clsx(
                              'flex-1 leading-snug break-words',
                              todo.status === 'completed' ? 'line-through text-slate-400' :
                              todo.status === 'in_progress' ? 'text-amber-700 font-medium' :
                              'text-slate-600',
                            )}>
                              {todo.content}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                };

                return (
                  <div className="bg-white border border-border rounded-2xl p-4 shadow-card">
                    <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 mb-3 flex items-center gap-1.5">
                      <CheckCircle2 size={10} />Checklist Progress
                    </div>
                    <div className="space-y-4">
                      {renderTodoList(aiTodos, 'AI Plan Steps')}
                      {aiTodos.length > 0 && userTodos.length > 0 && <div className="border-t border-slate-100" />}
                      {renderTodoList(userTodos, 'Task Checklist')}
                    </div>
                  </div>
                );
              })()}

              {/* Agent result */}
              {(() => {
                const logs = task.terminal.logs;
                const resultLog = [...logs].reverse().find(l => l.type === 'success' || (l.type === 'error' && task.status === 'failed'));
                if (!resultLog) return null;
                const isSuccess = resultLog.type === 'success';
                return (
                  <div className={clsx(
                    'rounded-2xl p-4 shadow-card border',
                    isSuccess ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200',
                  )}>
                    <div className={clsx('text-[10px] uppercase tracking-wider font-semibold mb-2 flex items-center gap-1.5', isSuccess ? 'text-emerald-600' : 'text-red-500')}>
                      {isSuccess ? <CheckCircle2 size={10} /> : <CircleDot size={10} />}
                      {isSuccess ? 'Task Result' : 'Failure Reason'}
                    </div>
                    <p className={clsx('text-xs leading-relaxed whitespace-pre-wrap break-words', isSuccess ? 'text-emerald-800' : 'text-red-700')}>
                      {resultLog.content}
                    </p>
                  </div>
                );
              })()}

              {/* Token usage */}
              {totalTokens.total > 0 && (
                <div className="bg-white border border-border rounded-2xl p-4 shadow-card">
                  <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 mb-3">Token Usage</div>
                  <div className="grid grid-cols-4 gap-3 mb-3">
                    <TokenPill label="Input"  value={totalTokens.input}    color="text-blue-600" />
                    <TokenPill label="Output" value={totalTokens.output}   color="text-violet-600" />
                    <TokenPill label="Cache"  value={totalTokens.cacheRead} color="text-amber-600" />
                    <TokenPill label="Total"  value={totalTokens.total}    color="text-slate-800" />
                  </div>
                  <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs">
                    <span className="text-slate-400">Elapsed: <span className="font-mono text-slate-600">{formatDuration(elapsedMs)}</span></span>
                    <span className="text-emerald-600 font-mono font-semibold text-sm">${totalTokens.cost.toFixed(4)}</span>
                  </div>
                </div>
              )}

              {/* Project info */}
              {project && (
                <div className="bg-white border border-border rounded-2xl p-4 shadow-card">
                  <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 mb-2">Project</div>
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-3 h-3 rounded-full shrink-0" style={{ background: project.color }} />
                    <span className="text-sm font-semibold text-slate-700">{project.name}</span>
                    {project.branch && (
                      <span className="flex items-center gap-1 text-[10px] text-slate-500 font-mono">
                        <GitBranch size={9} />{project.branch}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] font-mono text-slate-400 truncate">{project.repoPath}</div>
                  {project.lastCommit && <div className="text-[10px] text-slate-500 mt-1 truncate">"{project.lastCommit}"</div>}
                </div>
              )}

              {/* Agent config */}
              <div className="bg-white border border-border rounded-2xl p-4 shadow-card">
                <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 mb-3 flex items-center gap-1.5">
                  <Cpu size={10} />Agent Config
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs mb-3">
                  <div>
                    <div className="text-slate-400 mb-0.5">Model</div>
                    <div style={{ color: mInfo.color }} className="font-semibold text-[11px]">{mInfo.label}</div>
                  </div>
                  {task.agentConfig.schedule && (
                    <div>
                      <div className="text-slate-400 mb-0.5">Schedule</div>
                      <div className="font-mono text-slate-700 text-[10px]">{task.agentConfig.schedule}</div>
                    </div>
                  )}
                </div>
                <div>
                  <div className="text-[10px] text-slate-400 mb-1.5">Tools</div>
                  <div className="flex gap-1.5 flex-wrap">
                    {task.agentConfig.tools.map(tool => (
                      <span key={tool} className="text-[10px] px-1.5 py-0.5 bg-amber-50 border border-amber-200 rounded-lg font-mono text-amber-700">{tool}</span>
                    ))}
                  </div>
                </div>
              </div>

              {/* Description */}
              {task.description && (
                <div className="bg-white border border-border rounded-2xl p-4 shadow-card">
                  <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 mb-2">Description</div>
                  <p className="text-xs text-slate-600 leading-relaxed">{task.description}</p>
                  {task.attachments && task.attachments.length > 0 && (
                    <div className="mt-3"><AttachmentGrid attachments={task.attachments} /></div>
                  )}
                </div>
              )}

              {/* Meta */}
              <div className="text-[10px] text-slate-400 text-center pb-2">
                Created {formatRelative(task.createdAt)} · Updated {formatRelative(task.updatedAt)}
              </div>
            </div>
          )}
        </div>
        {/* ── Review & Validation overlay ── */}
        {task.reviewPending && task.status === 'done' && (() => {
          const hasCriteria = task.successCriteria.length > 0;
          const results = task.validationResults;
          const allPassed = hasCriteria && results.every(r => r.passed === true);
          const anyFailed = results.some(r => r.passed === false);
          const allReviewed = hasCriteria && results.every(r => r.passed !== null);
          const canCreatePR = task.branchName && !anyFailed && !prResult?.ok;
          const canApprove = !hasCriteria || allPassed;

          return (
            <div className="absolute inset-0 z-10 bg-white/95 backdrop-blur-sm flex flex-col animate-fade-in">
              <div className="flex-1 overflow-y-auto px-6 py-6">
                {/* Header */}
                <div className="flex items-center gap-3 mb-5">
                  <div className={clsx(
                    'w-10 h-10 rounded-2xl flex items-center justify-center',
                    anyFailed ? 'bg-red-100' : allPassed ? 'bg-emerald-100' : 'bg-amber-100',
                  )}>
                    {anyFailed
                      ? <XCircle size={20} className="text-red-600" />
                      : allPassed
                        ? <CheckCircle2 size={20} className="text-emerald-600" />
                        : <ClipboardList size={20} className="text-amber-600" />}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-slate-800">
                      {anyFailed ? 'Validation Failed' : allPassed ? 'All Criteria Met' : 'Review & Validate'}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {hasCriteria
                        ? `${results.filter(r => r.passed === true).length} of ${task.successCriteria.length} criteria passed`
                        : task.branchName ? 'Approve to create a Pull Request' : 'Confirm task completion'}
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  {/* Success Criteria Checklist */}
                  {hasCriteria && (
                    <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
                      <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 mb-3 flex items-center gap-1.5">
                        <ClipboardList size={10} />Success Criteria
                        <span className="ml-auto font-mono normal-case text-[10px]">
                          {results.filter(r => r.passed === true).length}/{task.successCriteria.length} passed
                        </span>
                      </div>
                      <div className="space-y-2">
                        {task.successCriteria.map((criterion, i) => {
                          const result = results[i];
                          const passed = result?.passed ?? null;
                          return (
                            <div key={i} className={clsx(
                              'flex items-start gap-2.5 rounded-xl px-3 py-2.5 border transition-colors',
                              passed === true ? 'bg-emerald-50 border-emerald-200' :
                              passed === false ? 'bg-red-50 border-red-200' :
                              'bg-white border-slate-200',
                            )}>
                              <span className={clsx(
                                'text-[10px] font-bold shrink-0 mt-0.5 w-4 text-center',
                                passed === true ? 'text-emerald-600' : passed === false ? 'text-red-500' : 'text-slate-400',
                              )}>{i + 1}</span>
                              <span className={clsx(
                                'flex-1 text-xs leading-snug',
                                passed === true ? 'text-emerald-800' : passed === false ? 'text-red-800 line-through opacity-70' : 'text-slate-700',
                              )}>{criterion}</span>
                              <div className="flex items-center gap-1 shrink-0">
                                <button
                                  onClick={() => updateValidationResult(task.id, i, passed === true ? null : true)}
                                  title="Mark as passed"
                                  className={clsx(
                                    'w-6 h-6 rounded-lg flex items-center justify-center transition-colors',
                                    passed === true ? 'bg-emerald-500 text-white' : 'text-slate-400 hover:text-emerald-600 hover:bg-emerald-50',
                                  )}
                                >
                                  <CheckCircle2 size={13} />
                                </button>
                                <button
                                  onClick={() => updateValidationResult(task.id, i, passed === false ? null : false)}
                                  title="Mark as failed"
                                  className={clsx(
                                    'w-6 h-6 rounded-lg flex items-center justify-center transition-colors',
                                    passed === false ? 'bg-red-500 text-white' : 'text-slate-400 hover:text-red-500 hover:bg-red-50',
                                  )}
                                >
                                  <XCircle size={13} />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Validation status banner */}
                      {allReviewed && (
                        <div className={clsx(
                          'mt-3 flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium',
                          allPassed ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700',
                        )}>
                          {allPassed
                            ? <><CheckCircle2 size={13} />All criteria passed — ready to approve</>
                            : <><XCircle size={13} />{results.filter(r => r.passed === false).length} criterion failed — request changes or override</>}
                        </div>
                      )}
                      {!allReviewed && results.some(r => r.passed !== null) && (
                        <div className="mt-3 flex items-center gap-2 text-[10px] text-slate-400">
                          <CircleDot size={11} />
                          {results.filter(r => r.passed === null).length} criterion not yet reviewed
                        </div>
                      )}
                    </div>
                  )}

                  {/* Branch */}
                  {task.branchName && (
                    <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
                      <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 mb-2 flex items-center gap-1.5">
                        <GitBranch size={10} />Branch
                      </div>
                      <div className="font-mono text-sm text-slate-700">{task.branchName}</div>
                    </div>
                  )}

                  {/* Label */}
                  {(() => { const lm = LABEL_META[task.label]; return (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-400">Type:</span>
                      <span className={clsx('text-[10px] font-mono font-semibold px-2 py-0.5 rounded-md border', lm.color, lm.bg, lm.border)}>
                        {task.label}
                      </span>
                    </div>
                  ); })()}

                  {/* Files changed */}
                  {filesChanged.length > 0 && (
                    <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
                      <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 mb-2 flex items-center gap-1.5">
                        <FileCode2 size={10} />Files Changed ({filesChanged.length})
                      </div>
                      <div className="space-y-1.5">
                        {filesChanged.map((f, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="text-emerald-500">+</span>
                            <span className="font-mono text-slate-600 truncate">{f.path}</span>
                            {f.lines && <span className="text-slate-400 shrink-0 text-[10px]">{f.lines} lines</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* PR result */}
                  {prResult && (
                    <div className={clsx('rounded-2xl p-4 border', prResult.ok ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200')}>
                      {prResult.ok ? (
                        <div className="flex items-center gap-2 text-emerald-700">
                          <CheckCircle2 size={14} />
                          <span className="text-xs font-medium">PR created!</span>
                          {prResult.prUrl && (
                            <a href={prResult.prUrl} target="_blank" rel="noreferrer"
                              className="ml-auto flex items-center gap-1 text-xs text-emerald-600 underline">
                              Open <ExternalLink size={10} />
                            </a>
                          )}
                        </div>
                      ) : (
                        <div className="text-xs text-red-700">
                          <div className="font-medium mb-1">PR creation failed:</div>
                          <div className="font-mono text-[10px] opacity-80">{prResult.error}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Footer */}
              <div className="shrink-0 px-6 py-4 border-t border-slate-100 flex items-center justify-between gap-3">
                <button
                  onClick={() => { setReviewPending(task.id, false); setPrResult(null); }}
                  className="px-4 py-2 text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  {prResult?.ok ? 'Done' : 'Skip'}
                </button>
                <div className="flex items-center gap-2">
                  {/* Request Changes — shown when any criterion failed */}
                  {anyFailed && (
                    <button
                      onClick={() => { updateTaskStatus(task.id, 'backlog'); setReviewPending(task.id, false); setPrResult(null); }}
                      className="flex items-center gap-1.5 px-4 py-2 bg-amber-50 border border-amber-300 text-amber-700 text-xs font-medium rounded-xl hover:bg-amber-100 transition-colors"
                    >
                      <RotateCcw size={11} />Request Changes
                    </button>
                  )}
                  {/* Create PR — shown when branch exists, no failures, PR not yet created */}
                  {canCreatePR && (
                    <button
                      onClick={handleCreatePR}
                      disabled={creatingPR || (hasCriteria && !canApprove)}
                      title={hasCriteria && !canApprove ? 'Validate all criteria before creating PR' : undefined}
                      className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium rounded-xl transition-colors shadow-sm"
                    >
                      {creatingPR
                        ? <><Loader2 size={12} className="animate-spin" />Creating PR…</>
                        : <><GitPullRequest size={12} />Create Pull Request</>}
                    </button>
                  )}
                  {/* Approve — shown when no branch but all criteria passed (or no criteria) */}
                  {!task.branchName && !anyFailed && (
                    <button
                      onClick={() => setReviewPending(task.id, false)}
                      disabled={hasCriteria && !allPassed}
                      title={hasCriteria && !allPassed ? 'Pass all criteria to approve' : undefined}
                      className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium rounded-xl transition-colors shadow-sm"
                    >
                      <CheckCircle2 size={12} />Approve
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, icon, label, pulse }: {
  active: boolean; onClick: () => void;
  icon: React.ReactNode; label: string; pulse?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] transition-colors',
        active ? 'bg-primary-glow text-primary font-medium' : 'text-slate-500 hover:bg-hover hover:text-slate-700',
      )}
    >
      {icon}{label}
      {pulse && <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse ml-0.5" />}
    </button>
  );
}

function TokenPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wide text-slate-400 mb-0.5">{label}</div>
      <div className={clsx('text-xs font-mono font-semibold', color)}>
        {value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value}
      </div>
    </div>
  );
}

function parseClaudeStreamEvents(ev: Record<string, unknown>): LogEntry[] {
  const type = ev.type as string;
  const out: LogEntry[] = [];

  if (type === 'assistant') {
    type Block = { type: string; text?: string; name?: string; input?: unknown };
    const msg = ev.message as { content?: Block[] } | undefined;
    for (const block of msg?.content ?? []) {
      if (block.type === 'text' && block.text) {
        const text = (block.text as string).trim();
        if (!text) continue;
        const isThinking = /^<thinking>|^I'll |^I am |^Let me |^First,|^Looking/i.test(text);
        out.push(makeLog(isThinking ? 'thinking' : 'info', text.replace(/<\/?thinking>/g, '').trim()));
      } else if (block.type === 'tool_use') {
        const args = block.input ? JSON.stringify(block.input, null, 2) : '';
        out.push(makeLog('tool_call', args, { toolName: (block.name as string) ?? 'tool' }));
      }
    }
    return out;
  }

  if (type === 'user') {
    type TRBlock = { type: string; tool_use_id?: string; content?: unknown };
    const msg = ev.message as { content?: TRBlock[] } | undefined;
    for (const block of msg?.content ?? []) {
      if (block.type === 'tool_result') {
        let text = '';
        if (typeof block.content === 'string') {
          text = block.content;
        } else if (Array.isArray(block.content)) {
          text = (block.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '';
        }
        if (text.trim()) out.push(makeLog('tool_result', text.slice(0, 500)));
      }
    }
    return out;
  }

  if (type === 'result') {
    const sub = ev.subtype as string;
    const result = (ev.result as string) ?? '';
    if (sub === 'success') out.push(makeLog('success', result || 'Task completed successfully'));
    else out.push(makeLog('error', result || 'Task failed'));
    return out;
  }

  if (type === 'system' && ev.subtype === 'init') {
    const tools = (ev.tools as string[] | undefined) ?? [];
    out.push(makeLog('system', `Session · model: ${ev.model as string ?? '?'} · tools: ${tools.length}`));
    return out;
  }

  return out;
}

function TerminalLogLine({ entry }: { entry: LogEntry }) {
  if (!entry.content.trim()) return <div className="h-1.5" />;

  switch (entry.type) {
    case 'system':
      return <div className="text-[#6e7681] text-[10px] tracking-wide">{entry.content}</div>;
    case 'thinking':
      return <div className="text-[#d2a8ff] italic pl-2 opacity-80">💭 {entry.content}</div>;
    case 'tool_call':
      return (
        <div className="mt-1">
          <div className="text-[#e3b341]">
            <span className="text-[#6e7681] mr-1">$</span>{entry.toolName ?? 'tool'}
          </div>
          {entry.content && (
            <div className="text-[#8b949e] pl-4 whitespace-pre-wrap text-[10px]">{entry.content}</div>
          )}
        </div>
      );
    case 'tool_result':
      return (
        <div className="text-[#3fb950] pl-4 text-[10px]">
          └─ {entry.content}
          {entry.duration && <span className="text-[#6e7681] ml-2">[{entry.duration}ms]</span>}
        </div>
      );
    case 'info':
      // npm install / plain text lines — no prefix decoration
      return <div className="text-[#c9d1d9]">{entry.content}</div>;
    case 'success':
      return <div className="text-[#3fb950] font-semibold">{entry.content}</div>;
    case 'error':
      return <div className="text-[#f85149] font-semibold">{entry.content}</div>;
    default:
      return <div className="text-[#8b949e]">{entry.content}</div>;
  }
}

function LogLine({ entry }: { entry: LogEntry }) {
  const base = 'py-1 text-xs leading-relaxed';
  switch (entry.type) {
    case 'system':
      return <div className={clsx(base, 'text-slate-400 text-[10px]')}><span className="mr-1.5 opacity-40">◆</span>{entry.content}</div>;
    case 'thinking':
      return (
        <div className={clsx(base, 'text-violet-500 italic pl-3 border-l-2 border-violet-100')}>
          <span className="mr-1.5 not-italic">💭</span>{entry.content}
        </div>
      );
    case 'tool_call':
      return (
        <div className={clsx(base, 'font-mono')}>
          <div className="flex items-center gap-1.5 text-amber-600">
            <span className="text-[10px] bg-amber-100 border border-amber-200 rounded px-1 py-0.5 not-italic font-semibold">{entry.toolName ?? 'tool'}</span>
          </div>
          <div className="text-[10px] text-slate-500 pl-2 mt-0.5 whitespace-pre-wrap">{entry.content}</div>
        </div>
      );
    case 'tool_result':
      return (
        <div className={clsx(base, 'text-emerald-600 pl-4 text-[11px]')}>
          <span className="mr-1.5 text-emerald-400">└─</span>{entry.content}
          {entry.duration && <span className="ml-2 text-[10px] text-slate-400">{entry.duration}ms</span>}
        </div>
      );
    case 'info':
      return <div className={clsx(base, 'text-slate-600')}><span className="mr-1.5 text-slate-400">▸</span>{entry.content}</div>;
    case 'success':
      return <div className={clsx(base, 'text-emerald-600 font-medium')}><span className="mr-1.5">✓</span>{entry.content}</div>;
    case 'error':
      return <div className={clsx(base, 'text-red-500 font-medium')}><span className="mr-1.5">✗</span>{entry.content}</div>;
    default:
      return <div className={clsx(base, 'text-slate-500')}>{entry.content}</div>;
  }
}
