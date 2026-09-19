import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, CheckCircle2, AlertCircle, Clock, TrendingUp, Play, Terminal, FolderGit2 } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../store';
import { useProjectStore } from '../projectStore';
import { STATUS_META, MODEL_INFO } from '../types';
import { Header } from '../components/Header';
import { formatRelative, formatTokens } from '../utils';

export function DashboardPage() {
  const { tasks, openTerminal, openDetailPanel } = useStore();
  const { projects } = useProjectStore();
  const navigate = useNavigate();
  const allTasks = useMemo(() => Object.values(tasks), [tasks]);
  const rootTasks = useMemo(() => allTasks.filter(t => t.parentId === null), [allTasks]);

  const stats = useMemo(() => ({
    total: rootTasks.length,
    running: allTasks.filter(t => t.terminal.isRunning).length,
    done: rootTasks.filter(t => t.status === 'done').length,
    failed: rootTasks.filter(t => t.status === 'failed').length,
    totalTokens: allTasks.reduce((sum, t) => sum + t.terminal.tokenUsage.total, 0),
    totalCost: allTasks.reduce((sum, t) => sum + t.terminal.cost, 0),
  }), [allTasks, rootTasks]);

  const recent = useMemo(
    () => [...rootTasks].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, 5),
    [rootTasks],
  );

  const projectList = Object.values(projects);

  return (
    <div className="flex-1 overflow-y-auto bg-base">
      <Header title="Dashboard" subtitle="Overview of your AI agent workspace" />
      <div className="px-6 py-6 max-w-6xl mx-auto space-y-6">

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard icon={<Zap size={14} className="text-primary" />} label="Total Tasks" value={stats.total} color="text-slate-800" />
          <StatCard icon={<div className="w-2 h-2 rounded-full bg-primary animate-pulse" />} label="Running" value={stats.running} color="text-primary" />
          <StatCard icon={<CheckCircle2 size={14} className="text-emerald-500" />} label="Completed" value={stats.done} color="text-emerald-600" />
          <StatCard icon={<AlertCircle size={14} className="text-red-400" />} label="Failed" value={stats.failed} color="text-red-600" />
          <StatCard icon={<TrendingUp size={14} className="text-violet-500" />} label="Tokens" value={formatTokens(stats.totalTokens)} color="text-violet-600" />
          <StatCard icon={<Clock size={14} className="text-amber-500" />} label="Total Cost" value={`$${stats.totalCost.toFixed(3)}`} color="text-amber-600" />
        </div>

        {/* Projects quick view */}
        {projectList.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
              <FolderGit2 size={11} />
              Projects
            </h2>
            <div className="grid sm:grid-cols-3 gap-3">
              {projectList.slice(0, 3).map(p => {
                const pTasks = p.taskIds.map(id => tasks[id]).filter(Boolean);
                return (
                  <div key={p.id} onClick={() => { useProjectStore.getState().setActiveProject(p.id); navigate('/tasks'); }} className="bg-white border border-border rounded-2xl p-4 cursor-pointer hover:border-slate-300 hover:shadow-card-hover transition-all">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-3 h-3 rounded-full" style={{ background: p.color }} />
                      <span className="text-sm font-medium text-slate-700">{p.name}</span>
                    </div>
                    <div className="text-xs text-slate-400 font-mono truncate mb-1">{p.branch || 'main'}</div>
                    <div className="text-xs text-slate-400">{pTasks.length} tasks</div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Running tasks */}
        {stats.running > 0 && (
          <section>
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Running Now</h2>
            <div className="grid sm:grid-cols-2 gap-3">
              {allTasks.filter(t => t.terminal.isRunning).map(task => (
                <div
                  key={task.id}
                  onClick={() => navigate(`/tasks/${task.id}`)}
                  className="relative bg-white border border-primary/30 rounded-2xl p-4 cursor-pointer hover:border-primary/50 transition-colors shadow-card"
                >
                  <div className="absolute inset-0 rounded-2xl bg-primary-glow pointer-events-none" />
                  <div className="relative flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                        <span className="text-[10px] text-primary font-semibold">RUNNING</span>
                      </div>
                      <div className="text-sm font-medium text-slate-800 truncate">{task.title}</div>
                      <div className="text-[10px] mt-0.5" style={{ color: MODEL_INFO[task.agentConfig.model].color }}>
                        {MODEL_INFO[task.agentConfig.model].label}
                      </div>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); openTerminal(task.id); }}
                      className="p-2 bg-primary-glow border border-primary/20 text-primary rounded-xl hover:bg-primary/15 transition-colors"
                    >
                      <Terminal size={13} />
                    </button>
                  </div>
                  <div className="relative mt-3 flex items-center gap-3 text-[10px] text-slate-400">
                    <span className="text-violet-600 font-mono">{formatTokens(task.terminal.tokenUsage.total)} tok</span>
                    <span>·</span>
                    <span className="text-amber-600">${task.terminal.cost.toFixed(4)}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Recent tasks table */}
        <section>
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Recent Tasks</h2>
          <div className="bg-white border border-border rounded-2xl overflow-hidden shadow-card">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left px-4 py-3 text-slate-400 font-medium">Task</th>
                  <th className="text-left px-4 py-3 text-slate-400 font-medium hidden sm:table-cell">Status</th>
                  <th className="text-left px-4 py-3 text-slate-400 font-medium hidden md:table-cell">Model</th>
                  <th className="text-right px-4 py-3 text-slate-400 font-medium hidden lg:table-cell">Tokens</th>
                  <th className="text-right px-4 py-3 text-slate-400 font-medium">Updated</th>
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody>
                {recent.map((task, i) => {
                  const sMeta = STATUS_META[task.status];
                  const mInfo = MODEL_INFO[task.agentConfig.model];
                  return (
                    <tr
                      key={task.id}
                      onClick={() => openDetailPanel(task.id)}
                      className={clsx('cursor-pointer hover:bg-slate-50 transition-colors', i < recent.length - 1 && 'border-b border-slate-100')}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-700 truncate max-w-48">{task.title}</div>
                        {task.subtaskIds.length > 0 && <div className="text-slate-400 mt-0.5">{task.subtaskIds.length} subtasks</div>}
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <span className={clsx('flex items-center gap-1.5', sMeta.color)}>
                          <span className={clsx('w-1.5 h-1.5 rounded-full', sMeta.dot)} />
                          {sMeta.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span style={{ color: mInfo.color }}>{mInfo.label}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-400 hidden lg:table-cell">
                        {task.terminal.tokenUsage.total > 0 ? formatTokens(task.terminal.tokenUsage.total) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-400">{formatRelative(task.updatedAt)}</td>
                      <td className="px-3 py-3">
                        {task.terminal.logs.length > 0 && (
                          <button onClick={e => { e.stopPropagation(); openTerminal(task.id); }} className="p-1.5 text-slate-400 hover:text-primary hover:bg-primary-glow rounded-lg transition-colors">
                            <Terminal size={12} />
                          </button>
                        )}
                        {!task.terminal.isRunning && task.status !== 'done' && task.status !== 'stopped' && (
                          <button onClick={e => { e.stopPropagation(); navigate(`/tasks/${task.id}`); }} className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors">
                            <Play size={12} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string | number; color: string }) {
  return (
    <div className="bg-white border border-border rounded-2xl p-4 shadow-card">
      <div className="flex items-center gap-1.5 text-slate-400 mb-2">
        {icon}
        <span className="text-[10px] uppercase tracking-wide font-medium">{label}</span>
      </div>
      <div className={clsx('text-xl font-bold font-mono', color)}>{value}</div>
    </div>
  );
}
