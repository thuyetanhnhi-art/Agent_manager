import { Play, Terminal, Trash2, ChevronRight, Cpu, GitBranch, GitPullRequest, AlertTriangle, ListTodo, Gauge, Phone } from 'lucide-react';
import clsx from 'clsx';
import { Task, STATUS_META, PRIORITY_META, MODEL_INFO, LABEL_META } from '../types';
import { useStore } from '../store';
import { formatTokens } from '../utils';

interface TaskCardProps {
  task: Task;
  onClick: () => void;
}

export function TaskCard({ task, onClick }: TaskCardProps) {
  const { openTerminal, openDetailPanel, stopTask, deleteTask, tasks, runFbTask } = useStore();
  const isFbTask = task.taskKind === 'fb_phone_collector';
  const statusMeta = STATUS_META[task.status];
  const priorityMeta = PRIORITY_META[task.priority];
  const modelInfo = MODEL_INFO[task.agentConfig.model];
  const subtasks = task.subtaskIds.map(id => tasks[id]).filter(Boolean);
  const doneSubs = subtasks.filter(t => t.status === 'done').length;
  const taskTodos = task.taskTodos ?? [];
  const doneTodos = taskTodos.filter(t => t.status === 'completed').length;

  function handleRun(e: React.MouseEvent) {
    e.stopPropagation();
    if (isFbTask) { void runFbTask(task.id); return; }
    openDetailPanel(task.id, true);
  }

  function handleOpenTerminal(e: React.MouseEvent) {
    e.stopPropagation();
    openTerminal(task.id);
  }

  function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    if (confirm(`Delete "${task.title}"?`)) deleteTask(task.id);
  }

  const canRun = !task.terminal.isRunning && task.status !== 'done';

  return (
    <div
      onClick={onClick}
      className="group relative bg-white border border-border hover:border-slate-300 rounded-2xl p-4 cursor-pointer transition-all duration-200 hover:shadow-card-hover animate-fade-in"
    >
      {task.terminal.isRunning && (
        <div className="absolute inset-0 rounded-2xl border border-primary/30 bg-primary-glow pointer-events-none" />
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
            {(() => { const lm = LABEL_META[task.label]; return (
              <span className={clsx('text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded-md border', lm.color, lm.bg, lm.border)}>
                {task.label}
              </span>
            ); })()}
            <span className={clsx('text-[10px] font-semibold px-1.5 py-0.5 rounded-md border', priorityMeta.color, priorityMeta.border)}>
              {priorityMeta.label.toUpperCase()}
            </span>
            {task.terminal.isRunning && (
              <span className="flex items-center gap-1 text-[10px] text-primary font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                Running
              </span>
            )}
            {task.reviewPending && (
              <span className="flex items-center gap-1 text-[10px] text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-md font-medium">
                <GitPullRequest size={8} />Review
              </span>
            )}
          </div>
          <h3 className="text-sm font-medium text-slate-800 leading-snug line-clamp-2">{task.title}</h3>
        </div>
        <ChevronRight size={14} className="text-slate-300 group-hover:text-slate-400 shrink-0 mt-0.5 transition-colors" />
      </div>

      {task.description && (
        <p className="text-xs text-slate-500 line-clamp-2 mb-2">{task.description}</p>
      )}
      {task.branchName && (
        <div className="flex items-center gap-1 text-[10px] text-slate-400 font-mono mb-2 truncate">
          <GitBranch size={9} className="shrink-0" />
          <span className="truncate">{task.branchName}</span>
        </div>
      )}

      {task.progress > 0 && (
        <div className="mb-3">
          <div className="flex justify-between text-[10px] text-slate-400 mb-1">
            <span>Progress</span>
            <span>{task.progress}%</span>
          </div>
          <div className="h-1 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={clsx('h-full rounded-full transition-all duration-500', task.progress === 100 ? 'bg-emerald-500' : 'bg-primary')}
              style={{ width: `${task.progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Todo checklist progress */}
      {taskTodos.length > 0 && (
        <div className="mb-3">
          <div className="flex items-center gap-1.5 mb-1">
            <ListTodo size={10} className="text-slate-400" />
            <span className="text-[10px] text-slate-400">{doneTodos}/{taskTodos.length} checklist</span>
          </div>
          <div className="h-1 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={clsx('h-full rounded-full transition-all duration-500', doneTodos === taskTodos.length ? 'bg-emerald-500' : 'bg-primary')}
              style={{ width: `${taskTodos.length > 0 ? Math.round((doneTodos / taskTodos.length) * 100) : 0}%` }}
            />
          </div>
        </div>
      )}

      {subtasks.length > 0 && (
        <div className="flex items-center gap-1.5 mb-3">
          <div className="flex gap-0.5">
            {subtasks.slice(0, 8).map(st => (
              <div key={st.id} className={clsx('w-3 h-1.5 rounded-full', STATUS_META[st.status].dot)} />
            ))}
          </div>
          <span className="text-[10px] text-slate-400">{doneSubs}/{subtasks.length} subtasks</span>
        </div>
      )}

      {/* Fail reason snippet */}
      {task.status === 'failed' && task.failReason && (
        <div className="flex items-start gap-1.5 mb-3 px-2 py-1.5 bg-red-50 border border-red-100 rounded-lg">
          <AlertTriangle size={10} className="text-red-400 mt-0.5 shrink-0" />
          <span className="text-[10px] text-red-600 line-clamp-2 leading-relaxed">{task.failReason}</span>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={clsx('text-[10px] font-medium px-1.5 py-0.5 rounded-lg', statusMeta.bg, statusMeta.color)}>
            {statusMeta.label}
          </span>
          <div className="flex items-center gap-1 text-[10px] text-slate-400">
            {isFbTask ? (
              <>
                <Phone size={10} className="text-primary" />
                <span className="text-primary truncate max-w-24">SĐT Facebook</span>
              </>
            ) : (
              <>
                <Cpu size={10} />
                <span style={{ color: modelInfo.color }} className="truncate max-w-24">{modelInfo.label}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {task.terminal.logs.length > 0 && (
            <button onClick={handleOpenTerminal} className="p-1.5 text-slate-400 hover:text-primary hover:bg-primary-glow rounded-lg transition-colors" title="Terminal">
              <Terminal size={12} />
            </button>
          )}
          {canRun && (
            <button onClick={handleRun} className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors" title="Run">
              <Play size={12} />
            </button>
          )}
          {task.terminal.isRunning && (
            <button onClick={e => { e.stopPropagation(); stopTask(task.id); }} className="p-1.5 text-primary rounded-lg transition-colors">
              <span className="text-[10px] font-bold">■</span>
            </button>
          )}
          <button onClick={handleDelete} className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="Delete">
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* Token stats row */}
      {(() => {
        const usage = task.terminal.tokenUsage;
        const live = task.terminal.liveTokens ?? { input: 0, output: 0 };
        const isRunning = task.terminal.isRunning;
        const hasActual = usage.total > 0;
        const hasLive = isRunning && (live.input + live.output) > 0;
        if (!hasActual && !hasLive) return null;

        if (isRunning && !hasActual) {
          // Live-only: show live input+output with pulse
          return (
            <div className="mt-2 pt-2 border-t border-slate-100 flex items-center gap-1.5 text-[9px] font-mono">
              <span className="text-blue-500">IN {formatTokens(live.input)}</span>
              <span className="text-slate-300">·</span>
              <span className="text-purple-500">OUT {formatTokens(live.output)}</span>
              <span className="w-1 h-1 rounded-full bg-primary animate-pulse ml-0.5" />
            </div>
          );
        }

        return (
          <div className="mt-2 pt-2 border-t border-slate-100 flex items-center gap-1.5 text-[9px] font-mono flex-wrap">
            <span className="text-blue-500">IN {formatTokens(usage.input)}</span>
            <span className="text-slate-300">·</span>
            <span className="text-purple-500">OUT {formatTokens(usage.output)}</span>
            {usage.cacheRead > 0 && (
              <>
                <span className="text-slate-300">·</span>
                <span className="text-amber-500">CACHE {formatTokens(usage.cacheRead)}</span>
              </>
            )}
            <span className="text-slate-300">·</span>
            <span className="text-slate-600 font-semibold">{formatTokens(usage.total)}</span>
            {task.terminal.cost > 0 && (
              <>
                <span className="text-slate-300">·</span>
                <span className="text-emerald-600">${task.terminal.cost.toFixed(3)}</span>
              </>
            )}
            {isRunning && <span className="w-1 h-1 rounded-full bg-primary animate-pulse ml-0.5" />}
          </div>
        );
      })()}

      {/* This task's share of the 5hr / 7day rate-limit windows */}
      {task.terminal.usageConsumed && (task.terminal.usageConsumed.fiveHour > 0 || task.terminal.usageConsumed.sevenDay > 0) && (
        <div className="mt-2 pt-2 border-t border-slate-100 flex items-center gap-1.5 text-[9px] font-mono text-slate-500">
          <Gauge size={10} className="text-slate-400" />
          <span>5hr <span className="text-orange-500 font-semibold">+{task.terminal.usageConsumed.fiveHour}%</span></span>
          <span className="text-slate-300">·</span>
          <span>7d <span className="text-rose-500 font-semibold">+{task.terminal.usageConsumed.sevenDay}%</span></span>
        </div>
      )}
    </div>
  );
}
