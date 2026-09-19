import { useMemo, useState } from 'react';
import {
  Cpu, Activity, Calendar, CheckCircle2, XCircle,
  Clock, TrendingUp, Zap, BarChart3, ChevronDown, ChevronRight, Gauge,
} from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../store';
import { MODEL_INFO, AIModel } from '../types';
import { Header } from '../components/Header';
import { UsageBars } from '../components/UsageBars';
import { formatTokens, formatDuration, cronLabel } from '../utils';

type PlanTab = 'overview' | 'planning';

interface ModelStats {
  model: AIModel;
  count: number;
  running: number;
  done: number;
  failed: number;
  tokens: number;
  cost: number;
  elapsedMs: number;
}

const MODEL_GUIDE: Record<AIModel, { strengths: string[]; bestFor: string[]; avoid: string }> = {
  'claude-opus-4-7': {
    strengths: ['Complex multi-step reasoning', 'Architecture decisions', 'Deep code analysis'],
    bestFor: ['Critical implementations', 'System design', 'Security audits', 'Complex refactors'],
    avoid: 'Simple or repetitive tasks (use Haiku to save cost)',
  },
  'claude-sonnet-4-6': {
    strengths: ['Balanced speed and quality', 'API design', 'Feature development'],
    bestFor: ['Feature tasks', 'Integration work', 'Code reviews', 'Test generation'],
    avoid: 'Extremely complex reasoning where Opus excels',
  },
  'claude-haiku-4-5': {
    strengths: ['Fast turnaround', 'Low cost', 'Simple transformations'],
    bestFor: ['Documentation', 'Quick fixes', 'Boilerplate generation', 'Chores'],
    avoid: 'Architectural or high-complexity tasks',
  },
};

const TASK_TYPE_RECOMMENDATIONS: Array<{
  pattern: string;
  model: AIModel;
  reason: string;
}> = [
  { pattern: 'Architecture / design', model: 'claude-opus-4-7', reason: 'Requires deep reasoning and trade-off analysis' },
  { pattern: 'Critical bug fix', model: 'claude-opus-4-7', reason: 'Root-cause analysis demands full reasoning power' },
  { pattern: 'Security / audit', model: 'claude-opus-4-7', reason: 'Vulnerability identification needs precise reasoning' },
  { pattern: 'Feature implementation', model: 'claude-sonnet-4-6', reason: 'Good balance of quality and cost for mid-size tasks' },
  { pattern: 'API / endpoint work', model: 'claude-sonnet-4-6', reason: 'Handles schema, validation, and tests efficiently' },
  { pattern: 'Unit / integration tests', model: 'claude-sonnet-4-6', reason: 'Understands business logic without Opus overhead' },
  { pattern: 'Documentation', model: 'claude-haiku-4-5', reason: 'Fast, cost-effective text generation' },
  { pattern: 'Chore / config change', model: 'claude-haiku-4-5', reason: "Simple tasks don't need expensive reasoning" },
  { pattern: 'Boilerplate / scaffold', model: 'claude-haiku-4-5', reason: 'Repetitive patterns are trivial at high speed' },
];

export function AgentsPage() {
  const [tab, setTab] = useState<PlanTab>('overview');
  const [guideOpen, setGuideOpen] = useState(true);
  const { tasks } = useStore();
  const allTasks = useMemo(() => Object.values(tasks), [tasks]);

  const byModel = useMemo((): ModelStats[] => {
    const map: Record<string, ModelStats> = {};
    allTasks.forEach(t => {
      const m = t.agentConfig.model;
      if (!map[m]) map[m] = { model: m, count: 0, running: 0, done: 0, failed: 0, tokens: 0, cost: 0, elapsedMs: 0 };
      map[m].count++;
      if (t.terminal.isRunning) map[m].running++;
      if (t.status === 'done') map[m].done++;
      if (t.status === 'failed') map[m].failed++;
      map[m].tokens += t.terminal.tokenUsage.total;
      map[m].cost += t.terminal.cost;
      map[m].elapsedMs += t.terminal.elapsedMs;
    });
    return Object.values(map);
  }, [allTasks]);

  const scheduledTasks = useMemo(
    () => allTasks.filter(t => t.agentConfig.schedule && t.parentId === null),
    [allTasks],
  );

  const globalStats = useMemo(() => {
    const total = allTasks.filter(t => t.parentId === null).length;
    const running = allTasks.filter(t => t.terminal.isRunning).length;
    const done = allTasks.filter(t => t.status === 'done').length;
    const failed = allTasks.filter(t => t.status === 'failed').length;
    const completed = done + failed;
    const successRate = completed > 0 ? Math.round((done / completed) * 100) : null;
    const totalCost = allTasks.reduce((s, t) => s + t.terminal.cost, 0);
    const totalTokens = allTasks.reduce((s, t) => s + t.terminal.tokenUsage.total, 0);
    return { total, running, done, failed, successRate, totalCost, totalTokens };
  }, [allTasks]);

  const maxTokens = Math.max(...byModel.map(m => m.tokens), 1);
  const maxCost = Math.max(...byModel.map(m => m.cost), 0.0001);

  return (
    <div className="flex-1 overflow-y-auto bg-base">
      <Header title="Agents" subtitle="Model performance, research, and planning" />
      <div className="px-6 py-6 max-w-5xl mx-auto space-y-6">

        {/* Tab switcher */}
        <div className="flex items-center bg-slate-100 rounded-xl p-0.5 w-fit">
          <button
            onClick={() => setTab('overview')}
            className={clsx(
              'flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs transition-colors',
              tab === 'overview' ? 'bg-white text-slate-800 font-medium shadow-sm' : 'text-slate-500 hover:text-slate-700',
            )}
          >
            <BarChart3 size={12} /> Overview
          </button>
          <button
            onClick={() => setTab('planning')}
            className={clsx(
              'flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs transition-colors',
              tab === 'planning' ? 'bg-white text-slate-800 font-medium shadow-sm' : 'text-slate-500 hover:text-slate-700',
            )}
          >
            <TrendingUp size={12} /> Planning Guide
          </button>
        </div>

        {/* ── OVERVIEW TAB ─────────────────────────────────────────────── */}
        {tab === 'overview' && (
          <>
            {/* Global stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <MiniStat
                icon={<Zap size={13} className="text-primary" />}
                label="Total Tasks"
                value={globalStats.total}
                color="text-slate-800"
              />
              <MiniStat
                icon={<div className="w-2 h-2 rounded-full bg-primary animate-pulse" />}
                label="Running"
                value={globalStats.running}
                color="text-primary"
              />
              <MiniStat
                icon={<CheckCircle2 size={13} className="text-emerald-500" />}
                label="Success Rate"
                value={globalStats.successRate !== null ? `${globalStats.successRate}%` : '—'}
                color="text-emerald-600"
              />
              <MiniStat
                icon={<Clock size={13} className="text-amber-500" />}
                label="Total Cost"
                value={`$${globalStats.totalCost.toFixed(3)}`}
                color="text-amber-600"
              />
            </div>

            {/* Account-level Claude usage (5hr session / 7day weekly rate-limit windows) */}
            <section>
              <SectionHeading icon={<Gauge size={11} />} label="Claude Usage" />
              <div className="bg-white border border-border rounded-2xl p-5 shadow-card max-w-md">
                <UsageBars />
              </div>
            </section>

            {/* Model performance cards */}
            <section>
              <SectionHeading icon={<Cpu size={11} />} label="Model Performance" />
              {byModel.length === 0 ? (
                <div className="text-sm text-slate-400 text-center py-8 bg-white border border-border rounded-2xl shadow-card">
                  No tasks yet. Create a task to see model statistics.
                </div>
              ) : (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {byModel.map(stats => {
                    const info = MODEL_INFO[stats.model];
                    const completed = stats.done + stats.failed;
                    const successRate = completed > 0 ? Math.round((stats.done / completed) * 100) : null;
                    const avgCost = stats.count > 0 ? stats.cost / stats.count : 0;
                    const avgDuration = stats.count > 0 ? stats.elapsedMs / stats.count : 0;

                    return (
                      <div key={stats.model} className="bg-white border border-border rounded-2xl p-5 space-y-4 shadow-card">
                        {/* Header */}
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-2xl flex items-center justify-center border shrink-0" style={{ background: `${info.color}12`, borderColor: `${info.color}30` }}>
                            <Cpu size={18} style={{ color: info.color }} />
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-slate-800">{info.label}</div>
                            {stats.running > 0 && (
                              <div className="flex items-center gap-1 text-[10px] text-primary">
                                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                                {stats.running} running
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Metrics grid */}
                        <div className="grid grid-cols-2 gap-y-2.5 gap-x-3 text-xs">
                          <Metric label="Tasks" value={stats.count} mono />
                          <Metric label="Tokens" value={formatTokens(stats.tokens)} color="text-violet-600" mono />
                          <Metric label="Cost" value={`$${stats.cost.toFixed(4)}`} color="text-amber-600" mono />
                          <Metric label="$/Task" value={`$${avgCost.toFixed(4)}`} color="text-slate-500" mono />
                          {successRate !== null && (
                            <Metric
                              label="Success"
                              value={`${successRate}%`}
                              color={successRate >= 80 ? 'text-emerald-600' : successRate >= 50 ? 'text-amber-600' : 'text-red-600'}
                              mono
                            />
                          )}
                          {avgDuration > 0 && (
                            <Metric label="Avg Time" value={formatDuration(avgDuration)} color="text-slate-500" mono />
                          )}
                        </div>

                        {/* Token bar */}
                        <div>
                          <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                            <span>Token share</span>
                            <span className="font-mono">{maxTokens > 0 ? Math.round((stats.tokens / maxTokens) * 100) : 0}%</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{ width: `${Math.min((stats.tokens / maxTokens) * 100, 100)}%`, background: info.color }}
                            />
                          </div>
                        </div>

                        {/* Cost bar */}
                        <div>
                          <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                            <span>Cost share</span>
                            <span className="font-mono">{maxCost > 0 ? Math.round((stats.cost / maxCost) * 100) : 0}%</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all bg-amber-400"
                              style={{ width: `${Math.min((stats.cost / maxCost) * 100, 100)}%` }}
                            />
                          </div>
                        </div>

                        {/* Done / failed */}
                        {(stats.done > 0 || stats.failed > 0) && (
                          <div className="flex items-center gap-3 text-[10px]">
                            {stats.done > 0 && (
                              <span className="flex items-center gap-1 text-emerald-600">
                                <CheckCircle2 size={10} /> {stats.done} done
                              </span>
                            )}
                            {stats.failed > 0 && (
                              <span className="flex items-center gap-1 text-red-500">
                                <XCircle size={10} /> {stats.failed} failed
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Active agents */}
            {allTasks.some(t => t.terminal.isRunning) && (
              <section>
                <SectionHeading icon={<Activity size={11} className="text-primary" />} label="Active Agents" />
                <div className="space-y-2">
                  {allTasks.filter(t => t.terminal.isRunning).map(task => {
                    const info = MODEL_INFO[task.agentConfig.model];
                    return (
                      <div key={task.id} className="flex items-center gap-3 bg-white border border-primary/20 rounded-2xl px-4 py-3 shadow-card">
                        <div className="w-2 h-2 rounded-full bg-primary animate-pulse shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-slate-700 truncate">{task.title}</div>
                          {task.terminal.elapsedMs > 0 && (
                            <div className="text-[10px] text-slate-400 mt-0.5 flex items-center gap-1">
                              <Clock size={9} />
                              {formatDuration(task.terminal.elapsedMs)} elapsed
                            </div>
                          )}
                        </div>
                        <div className="text-xs font-mono text-violet-600">{formatTokens(task.terminal.tokenUsage.total)}</div>
                        <div className="text-xs" style={{ color: info.color }}>{info.label}</div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Scheduled agents */}
            {scheduledTasks.length > 0 && (
              <section>
                <SectionHeading icon={<Calendar size={11} />} label="Scheduled Agents" />
                <div className="bg-white border border-border rounded-2xl overflow-hidden shadow-card">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="text-left px-4 py-3 text-slate-400 font-medium">Task</th>
                        <th className="text-left px-4 py-3 text-slate-400 font-medium">Schedule</th>
                        <th className="text-left px-4 py-3 text-slate-400 font-medium hidden sm:table-cell">Model</th>
                        <th className="text-right px-4 py-3 text-slate-400 font-medium hidden md:table-cell">Last Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scheduledTasks.map((task, i) => {
                        const info = MODEL_INFO[task.agentConfig.model];
                        return (
                          <tr key={task.id} className={clsx(i < scheduledTasks.length - 1 && 'border-b border-slate-100')}>
                            <td className="px-4 py-3">
                              <div className="font-medium text-slate-700 truncate max-w-48">{task.title}</div>
                            </td>
                            <td className="px-4 py-3">
                              <span className="flex items-center gap-1 text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-1.5 py-0.5 w-fit">
                                <Calendar size={9} />
                                {cronLabel(task.agentConfig.schedule!)}
                              </span>
                            </td>
                            <td className="px-4 py-3 hidden sm:table-cell">
                              <span style={{ color: info.color }}>{info.label}</span>
                            </td>
                            <td className="px-4 py-3 text-right font-mono text-amber-600 hidden md:table-cell">
                              {task.terminal.cost > 0 ? `$${task.terminal.cost.toFixed(4)}` : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}

        {/* ── PLANNING GUIDE TAB ──────────────────────────────────────── */}
        {tab === 'planning' && (
          <>
            {/* Model capability cards */}
            <section>
              <SectionHeading icon={<Cpu size={11} />} label="Model Capabilities" />
              <div className="grid sm:grid-cols-3 gap-4">
                {(Object.keys(MODEL_GUIDE) as AIModel[]).map(model => {
                  const info = MODEL_INFO[model];
                  const guide = MODEL_GUIDE[model];
                  return (
                    <div key={model} className="bg-white border border-border rounded-2xl p-5 space-y-3 shadow-card">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center border shrink-0" style={{ background: `${info.color}12`, borderColor: `${info.color}30` }}>
                          <Cpu size={16} style={{ color: info.color }} />
                        </div>
                        <div>
                          <div className="text-sm font-semibold text-slate-800">{info.label}</div>
                          <div className="text-[10px] text-slate-400 font-mono">${info.inputPer1M}/1M in · ${info.outputPer1M}/1M out</div>
                        </div>
                      </div>

                      <div>
                        <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Strengths</div>
                        <ul className="space-y-1">
                          {guide.strengths.map(s => (
                            <li key={s} className="flex items-start gap-1.5 text-xs text-slate-600">
                              <CheckCircle2 size={10} className="mt-0.5 shrink-0" style={{ color: info.color }} />
                              {s}
                            </li>
                          ))}
                        </ul>
                      </div>

                      <div>
                        <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Best For</div>
                        <div className="flex flex-wrap gap-1">
                          {guide.bestFor.map(tag => (
                            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-md border font-medium" style={{ color: info.color, background: `${info.color}10`, borderColor: `${info.color}30` }}>
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="text-[10px] text-slate-400 bg-slate-50 rounded-xl px-3 py-2 leading-relaxed">
                        <span className="font-semibold text-slate-500">Avoid: </span>{guide.avoid}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Task type → model recommendation table */}
            <section>
              <button
                onClick={() => setGuideOpen(v => !v)}
                className="w-full flex items-center justify-between mb-3"
              >
                <SectionHeading icon={<TrendingUp size={11} />} label="Task Type → Model Recommendations" inline />
                {guideOpen ? <ChevronDown size={13} className="text-slate-400" /> : <ChevronRight size={13} className="text-slate-400" />}
              </button>
              {guideOpen && (
                <div className="bg-white border border-border rounded-2xl overflow-hidden shadow-card">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="text-left px-4 py-3 text-slate-400 font-medium">Task Pattern</th>
                        <th className="text-left px-4 py-3 text-slate-400 font-medium">Recommended Model</th>
                        <th className="text-left px-4 py-3 text-slate-400 font-medium hidden sm:table-cell">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {TASK_TYPE_RECOMMENDATIONS.map((rec, i) => {
                        const info = MODEL_INFO[rec.model];
                        return (
                          <tr key={rec.pattern} className={clsx(i < TASK_TYPE_RECOMMENDATIONS.length - 1 && 'border-b border-slate-100')}>
                            <td className="px-4 py-3 font-medium text-slate-700">{rec.pattern}</td>
                            <td className="px-4 py-3">
                              <span className="flex items-center gap-1.5 font-medium" style={{ color: info.color }}>
                                <div className="w-2 h-2 rounded-full shrink-0" style={{ background: info.color }} />
                                {info.label}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-slate-400 hidden sm:table-cell">{rec.reason}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Cost comparison */}
            <section>
              <SectionHeading icon={<BarChart3 size={11} />} label="Cost at Scale" />
              <div className="bg-white border border-border rounded-2xl p-5 shadow-card">
                <div className="text-xs text-slate-500 mb-4">Estimated cost per 1,000 typical tasks (avg 50k tokens/task)</div>
                <div className="space-y-3">
                  {(Object.entries(MODEL_INFO) as [AIModel, typeof MODEL_INFO[AIModel]][]).map(([model, info]) => {
                    const costPer1kTasks = ((50_000 / 1_000_000) * info.inputPer1M + (10_000 / 1_000_000) * info.outputPer1M) * 1000;
                    const maxScale = 800;
                    const pct = Math.min((costPer1kTasks / maxScale) * 100, 100);
                    return (
                      <div key={model}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="font-medium" style={{ color: info.color }}>{info.label}</span>
                          <span className="font-mono text-slate-600">${costPer1kTasks.toFixed(0)}</span>
                        </div>
                        <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: info.color }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 text-[10px] text-slate-400 leading-relaxed">
                  Assumes 50k input tokens + 10k output tokens per task. Actual costs depend on context length and task complexity.
                </div>
              </div>
            </section>
          </>
        )}

      </div>
    </div>
  );
}

function SectionHeading({ icon, label, inline }: { icon: React.ReactNode; label: string; inline?: boolean }) {
  return (
    <h2 className={clsx(
      'text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2',
      !inline && 'mb-3',
    )}>
      {icon}
      {label}
    </h2>
  );
}

function MiniStat({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string | number; color: string }) {
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

function Metric({ label, value, color, mono }: { label: string; value: string | number; color?: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-slate-400 mb-0.5">{label}</div>
      <div className={clsx('font-bold', mono && 'font-mono', color ?? 'text-slate-800')}>{value}</div>
    </div>
  );
}
