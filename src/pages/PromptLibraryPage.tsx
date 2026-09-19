import { useState, useMemo } from 'react';
import {
  BarChart3, Copy, Trash2, Check, Terminal as TerminalIcon,
  FileText, TrendingUp, Zap, ChevronRight,
  Cpu, DollarSign, Clock, X, ChevronDown, Download,
  Database, Calendar, ThumbsUp, ThumbsDown,
} from 'lucide-react';
import clsx from 'clsx';
import { Header } from '../components/Header';
import { usePromptStore } from '../promptStore';
import { useProjectStore } from '../projectStore';
import { useStore } from '../store';
import { TerminalModal } from '../components/TerminalModal';
import { KB_GEN_PROMPT } from '../kbConstants';
import { PromptEntry, PromptSource, MODEL_INFO, Task } from '../types';

const SOURCE_META: Record<PromptSource, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  terminal: { label: 'Terminal Run', color: 'text-violet-700', bg: 'bg-violet-50 border-violet-200', icon: <TerminalIcon size={10} /> },
  task:     { label: 'Task',         color: 'text-blue-700',   bg: 'bg-blue-50 border-blue-200',   icon: <FileText size={10} /> },
  manual:   { label: 'Manual',       color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200', icon: <Zap size={10} /> },
};

function SourceBadge({ source }: { source: PromptSource }) {
  const m = SOURCE_META[source];
  return (
    <span className={clsx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium', m.bg, m.color)}>
      {m.icon}{m.label}
    </span>
  );
}

function StatCard({ label, value, sub, color = 'text-slate-800', icon }: {
  label: string; value: string | number; sub?: string; color?: string; icon: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-border rounded-xl p-4 shadow-card">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-slate-400">{icon}</span>
        <span className="text-[11px] text-slate-500 font-medium">{label}</span>
      </div>
      <div className={clsx('text-xl font-bold', color)}>{value}</div>
      {sub && <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function toSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}

function getDailyStats(tasks: Task[]) {
  const byDay: Record<string, { done: number; failed: number; cost: number; count: number }> = {};
  tasks.forEach(t => {
    const day = t.updatedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (!byDay[day]) byDay[day] = { done: 0, failed: 0, cost: 0, count: 0 };
    byDay[day].count++;
    if (t.status === 'done') byDay[day].done++;
    if (t.status === 'failed') byDay[day].failed++;
    byDay[day].cost += t.terminal.cost;
  });
  return Object.entries(byDay)
    .sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime())
    .slice(0, 7);
}

function getStrengthWeakness(tasks: Task[]) {
  const byLabel: Record<string, { done: number; total: number }> = {};
  tasks.forEach(t => {
    if (!byLabel[t.label]) byLabel[t.label] = { done: 0, total: 0 };
    byLabel[t.label].total++;
    if (t.status === 'done') byLabel[t.label].done++;
  });
  const entries = Object.entries(byLabel).filter(([, v]) => v.total >= 2);
  const strengths = entries.filter(([, v]) => v.done / v.total >= 0.7).sort((a, b) => (b[1].done / b[1].total) - (a[1].done / a[1].total)).slice(0, 3);
  const weaknesses = entries.filter(([, v]) => v.done / v.total < 0.5).sort((a, b) => (a[1].done / a[1].total) - (b[1].done / b[1].total)).slice(0, 3);
  return { strengths, weaknesses };
}

export function PromptLibraryPage() {
  const { prompts, deletePrompt, incrementUsage } = usePromptStore();
  const { projects } = useProjectStore();
  const tasks = useStore(s => s.tasks);

  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => {
    const list = Object.values(useProjectStore.getState().projects);
    return list.length > 0 ? list[0].id : '';
  });
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showGenKb, setShowGenKb] = useState(false);
  const [copiedKb, setCopiedKb] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);

  const projectList = useMemo(() => Object.values(projects), [projects]);
  const taskList = useMemo(() => Object.values(tasks), [tasks]);

  const projectTasks = useMemo(() => {
    if (selectedProjectId === 'all') return taskList;
    return taskList.filter(t => t.projectId === selectedProjectId);
  }, [taskList, selectedProjectId]);

  const stats = useMemo(() => {
    const done = projectTasks.filter(t => t.status === 'done').length;
    const failed = projectTasks.filter(t => t.status === 'failed').length;
    const aiRuns = projectTasks.filter(t => t.terminal.logs.length > 0);
    const totalTokens = aiRuns.reduce((s, t) => s + t.terminal.tokenUsage.total, 0);
    const totalCost = aiRuns.reduce((s, t) => s + t.terminal.cost, 0);
    const avgTokens = aiRuns.length ? Math.round(totalTokens / aiRuns.length) : 0;
    const modelCounts: Record<string, number> = {};
    projectTasks.forEach(t => { modelCounts[t.agentConfig.model] = (modelCounts[t.agentConfig.model] ?? 0) + 1; });
    const topModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0];
    return {
      total: projectTasks.length, done, failed,
      aiRuns: aiRuns.length, toolOnly: projectTasks.length - aiRuns.length,
      totalTokens, totalCost, avgTokens,
      topModel: topModel ? MODEL_INFO[topModel[0] as keyof typeof MODEL_INFO]?.label : null,
    };
  }, [projectTasks]);

  const dailyStats = useMemo(() => getDailyStats(projectTasks), [projectTasks]);
  const { strengths, weaknesses } = useMemo(() => getStrengthWeakness(projectTasks), [projectTasks]);

  const aiTaskIds = useMemo(() => {
    const ids = new Set<string>();
    projectTasks.filter(t => t.terminal.logs.length > 0).forEach(t => ids.add(t.id));
    return ids;
  }, [projectTasks]);

  const projectPrompts = useMemo(() => {
    let list = Object.values(prompts);
    if (selectedProjectId !== 'all') list = list.filter(p => p.projectId === selectedProjectId);
    // Only include prompts from tasks that have actually run AI
    list = list.filter(p =>
      p.source === 'terminal' ||
      p.source === 'manual' ||
      (p.source === 'task' && p.taskId != null && aiTaskIds.has(p.taskId)),
    );
    return list.sort((a, b) => b.usageCount - a.usageCount || b.updatedAt.getTime() - a.updatedAt.getTime());
  }, [prompts, selectedProjectId, aiTaskIds]);

  const repeatedPrompts = useMemo(() => projectPrompts.filter(p => p.usageCount >= 2), [projectPrompts]);
  const singlePrompts   = useMemo(() => projectPrompts.filter(p => p.usageCount < 2), [projectPrompts]);

  const selectedProject = selectedProjectId !== 'all' ? projects[selectedProjectId] ?? null : null;
  const isJiraProject = selectedProject?.repoPath === '__jira__';

  function copyPrompt(p: PromptEntry) {
    navigator.clipboard.writeText(p.content).catch(() => {});
    incrementUsage(p.id);
    setCopiedId(p.id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  function downloadPromptFile(p: PromptEntry) {
    const slug = toSlug(p.title);
    const content = `# ${p.title}\n\n${p.content}\n`;
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${slug}.md`; a.click();
    URL.revokeObjectURL(url);
  }

  function exportReport() {
    const proj = selectedProjectId !== 'all' ? projects[selectedProjectId] : null;
    const name = proj?.name ?? 'All Projects';
    const lines = [
      `# Agent Performance Report — ${name}`,
      `Generated: ${new Date().toLocaleDateString()}`, '',
      '## Performance Summary',
      `- Total tasks: ${stats.total}`,
      `- Done: ${stats.done} (${stats.total ? Math.round(stats.done / stats.total * 100) : 0}%)`,
      `- Failed: ${stats.failed}`,
      `- AI Agent runs: ${stats.aiRuns}`,
      `- Total tokens: ${stats.totalTokens.toLocaleString()}`,
      `- Total cost: $${stats.totalCost.toFixed(4)}`,
      `- Top model: ${stats.topModel ?? 'N/A'}`, '',
      '## Daily Efficiency (last 7 days)',
      ...dailyStats.map(([day, s]) => `- ${day}: ${s.done}/${s.count} done, $${s.cost.toFixed(4)}`), '',
      '## Strengths',
      ...strengths.map(([label, v]) => `- ${label}: ${Math.round(v.done / v.total * 100)}% (${v.done}/${v.total})`), '',
      '## Needs Improvement',
      ...weaknesses.map(([label, v]) => `- ${label}: ${Math.round(v.done / v.total * 100)}% (${v.done}/${v.total})`), '',
      '## Repeated Prompts (≥2 uses)',
      ...repeatedPrompts.map(p => `- **${p.title}** (×${p.usageCount})`),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `agent-report-${name.replace(/\s+/g, '-').toLowerCase()}.md`; a.click();
    URL.revokeObjectURL(url);
  }

  function copyKbPrompt() {
    navigator.clipboard.writeText(KB_GEN_PROMPT).catch(() => {});
    setCopiedKb(true);
    setTimeout(() => setCopiedKb(false), 1500);
  }

  const successRate = stats.total ? Math.round(stats.done / stats.total * 100) : 0;

  return (
    <div className="flex-1 overflow-y-auto bg-base">
      <Header title="Agent Monitor" subtitle="Agent performance analytics · prompt aggregation per project" />
      <div className="px-6 py-4 space-y-5">

        {/* Project tabs */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
          {projectList.map(p => (
            <button key={p.id} onClick={() => setSelectedProjectId(p.id)}
              className={clsx('shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-colors border',
                selectedProjectId === p.id ? 'bg-primary text-white border-primary shadow-sm' : 'bg-white text-slate-600 border-border hover:border-violet-300',
              )}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
              {p.name}
              {p.repoPath === '__jira__' && <span className="text-[9px] px-1 py-0.5 bg-blue-100 text-blue-600 rounded font-medium ml-0.5">Jira</span>}
            </button>
          ))}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Total Tasks" value={stats.total} sub={`${stats.aiRuns} AI · ${stats.toolOnly} tool`} icon={<Cpu size={14} />} />
          <StatCard label="Success Rate" value={`${successRate}%`} sub={`${stats.done} done · ${stats.failed} failed`}
            color={successRate >= 70 ? 'text-emerald-600' : successRate >= 40 ? 'text-amber-600' : 'text-red-600'} icon={<TrendingUp size={14} />} />
          <StatCard label="Avg Tokens" value={stats.avgTokens > 1000 ? `${(stats.avgTokens / 1000).toFixed(1)}K` : stats.avgTokens} sub={stats.topModel ?? 'N/A'} icon={<Zap size={14} />} />
          <StatCard label="Total Cost" value={`$${stats.totalCost.toFixed(4)}`} sub={`${stats.aiRuns} tasks ran AI`} icon={<DollarSign size={14} />} />
        </div>

        {/* AI vs Tool breakdown */}
        <div className="bg-white border border-border rounded-xl p-4 shadow-card">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <BarChart3 size={14} className="text-slate-400" />
              <span className="text-xs font-semibold text-slate-700">Tool vs AI Agent Breakdown</span>
            </div>
            <button onClick={exportReport} className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 hover:bg-violet-50 border border-slate-200 hover:border-violet-300 text-xs text-slate-600 hover:text-violet-700 rounded-xl transition-colors">
              <Download size={12} /> Export Report
            </button>
          </div>
          {stats.total === 0 ? (
            <p className="text-xs text-slate-400 py-1">No tasks yet — create and run tasks to see the breakdown.</p>
          ) : (
            <>
              <div className="flex gap-2 mb-2">
                <div className="flex-1 h-3 bg-slate-100 rounded-full overflow-hidden flex">
                  <div className="h-full bg-violet-500 rounded-l-full transition-all" style={{ width: `${stats.aiRuns / stats.total * 100}%` }} />
                  <div className="h-full bg-slate-300" style={{ width: `${stats.toolOnly / stats.total * 100}%` }} />
                </div>
              </div>
              <div className="flex gap-4 text-[10px]">
                <span className="flex items-center gap-1.5 text-violet-600"><span className="w-2 h-2 rounded-full bg-violet-500 shrink-0" />AI Agent: {stats.aiRuns} ({Math.round(stats.aiRuns / stats.total * 100)}%)</span>
                <span className="flex items-center gap-1.5 text-slate-500"><span className="w-2 h-2 rounded-full bg-slate-300 shrink-0" />Tool-only: {stats.toolOnly} ({Math.round(stats.toolOnly / stats.total * 100)}%)</span>
              </div>
            </>
          )}
        </div>

        {/* Daily efficiency */}
        {dailyStats.length > 0 && (
          <div className="bg-white border border-border rounded-xl p-4 shadow-card">
            <div className="flex items-center gap-2 mb-3">
              <Calendar size={14} className="text-slate-400" />
              <span className="text-xs font-semibold text-slate-700">Daily Efficiency (last 7 days)</span>
            </div>
            <div className="space-y-2">
              {dailyStats.map(([day, s]) => {
                const rate = s.count > 0 ? Math.round(s.done / s.count * 100) : 0;
                return (
                  <div key={day} className="flex items-center gap-3">
                    <span className="text-[10px] text-slate-400 w-20 shrink-0 font-mono">{day}</span>
                    <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className={clsx('h-full rounded-full transition-all', rate >= 70 ? 'bg-emerald-400' : rate >= 40 ? 'bg-amber-400' : 'bg-red-400')} style={{ width: `${rate}%` }} />
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-slate-500 w-36 shrink-0">
                      <span className={clsx('font-bold w-7', rate >= 70 ? 'text-emerald-600' : rate >= 40 ? 'text-amber-600' : 'text-red-500')}>{rate}%</span>
                      <span>{s.done}/{s.count}</span>
                      {s.cost > 0 && <span className="text-slate-400">${s.cost.toFixed(3)}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Strengths / Weaknesses */}
        {(strengths.length > 0 || weaknesses.length > 0) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {strengths.length > 0 && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3"><ThumbsUp size={13} className="text-emerald-600" /><span className="text-xs font-semibold text-emerald-700">Strengths</span></div>
                <div className="space-y-2">
                  {strengths.map(([label, v]) => (
                    <div key={label} className="flex items-center justify-between">
                      <span className="text-xs text-emerald-800 capitalize">{label}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-emerald-600 font-bold">{Math.round(v.done / v.total * 100)}%</span>
                        <span className="text-[10px] text-emerald-500">{v.done}/{v.total}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {weaknesses.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3"><ThumbsDown size={13} className="text-red-500" /><span className="text-xs font-semibold text-red-600">Needs Improvement</span></div>
                <div className="space-y-2">
                  {weaknesses.map(([label, v]) => (
                    <div key={label} className="flex items-center justify-between">
                      <span className="text-xs text-red-700 capitalize">{label}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-red-600 font-bold">{Math.round(v.done / v.total * 100)}%</span>
                        <span className="text-[10px] text-red-400">{v.done}/{v.total}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Gen Knowledge Base */}
        {!isJiraProject && (
          <div className="bg-white border border-border rounded-xl shadow-card overflow-hidden">
            <button onClick={() => setShowGenKb(v => !v)} className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors">
              <div className="flex items-center gap-2">
                <Database size={14} className="text-violet-500" />
                <span className="text-xs font-semibold text-slate-700">Generate Project Knowledge Base</span>
                <span className="text-[10px] px-1.5 py-0.5 bg-violet-50 text-violet-600 border border-violet-200 rounded font-medium">KNOWLEDGE.md</span>
                {selectedProject && <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded">{selectedProject.name}</span>}
              </div>
              <ChevronDown size={13} className={clsx('text-slate-400 transition-transform', showGenKb && 'rotate-180')} />
            </button>
            {showGenKb && (
              <div className="border-t border-slate-100 px-4 py-4 space-y-3">
                <div className="flex items-start gap-2 p-3 bg-violet-50 border border-violet-200 rounded-xl">
                  <Zap size={12} className="text-violet-600 mt-0.5 shrink-0" />
                  <ol className="text-xs text-violet-700 space-y-0.5 list-decimal ml-2">
                    <li>Open terminal at the project directory</li>
                    <li>Run <code className="bg-violet-100 px-1 rounded font-mono">claude</code></li>
                    <li>Paste the prompt below into Claude Code</li>
                  </ol>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">KB generation prompt</span>
                    <button onClick={copyKbPrompt} className="flex items-center gap-1 text-[10px] text-violet-600 hover:text-violet-800 transition-colors">
                      {copiedKb ? <Check size={10} className="text-emerald-500" /> : <></>}
                      {copiedKb ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  <pre className="text-[10px] font-mono text-slate-600 bg-slate-50 border border-slate-200 rounded-xl p-3 max-h-40 overflow-y-auto whitespace-pre-wrap leading-relaxed">{KB_GEN_PROMPT}</pre>
                </div>
                {selectedProject && (
                  <button onClick={() => setTerminalOpen(true)} className="flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white text-xs font-medium rounded-xl transition-colors">
                    Open Terminal — {selectedProject.name}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Prompt Analysis */}
        <div className="flex items-center gap-2">
          <TrendingUp size={14} className="text-slate-400" />
          <span className="text-sm font-semibold text-slate-700">Prompt Analysis</span>
          <span className="px-1.5 py-0.5 bg-violet-100 text-violet-700 rounded text-[9px] font-bold">AI runs only</span>
          {repeatedPrompts.length > 0 && (
            <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded text-[9px] font-bold">{repeatedPrompts.length} repeated</span>
          )}
        </div>

        {repeatedPrompts.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] font-bold text-amber-700 uppercase tracking-wide flex items-center gap-1">
                <TrendingUp size={10} /> Repeated Patterns ({repeatedPrompts.length})
              </span>
              <span className="text-[10px] text-slate-400">— used 2+ times</span>
            </div>
            <div className="space-y-2">
              {repeatedPrompts.map(p => (
                <PromptCard key={p.id} prompt={p} copiedId={copiedId} expandedId={expandedId} setExpandedId={setExpandedId}
                  onCopy={copyPrompt} onDelete={deletePrompt} onDownload={() => downloadPromptFile(p)} highlight />
              ))}
            </div>
          </div>
        )}

        {singlePrompts.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wide flex items-center gap-1">
                <Clock size={10} /> Single Use ({singlePrompts.length})
              </span>
            </div>
            <div className="space-y-2">
              {singlePrompts.map(p => (
                <PromptCard key={p.id} prompt={p} copiedId={copiedId} expandedId={expandedId} setExpandedId={setExpandedId}
                  onCopy={copyPrompt} onDelete={deletePrompt} onDownload={() => downloadPromptFile(p)} />
              ))}
            </div>
          </div>
        )}

        {projectPrompts.length === 0 && (
          <div className="bg-white border border-border rounded-2xl p-10 text-center shadow-card">
            <BarChart3 size={28} className="mx-auto mb-3 text-slate-200" />
            <p className="text-sm font-medium text-slate-500">No AI-run prompts yet</p>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed max-w-xs mx-auto">
              Only tasks that have actually run an AI agent appear here.<br />
              Start a task run to capture its prompt.
            </p>
          </div>
        )}

      </div>

      {selectedProject && !isJiraProject && (
        <TerminalModal open={terminalOpen} onClose={() => setTerminalOpen(false)}
          title={`KB Generator — ${selectedProject.name}`} cwd={selectedProject.repoPath}
          prompt={KB_GEN_PROMPT} description="Runs claude in the project directory and feeds the KB generation prompt via stdin." />
      )}
    </div>
  );
}

function PromptCard({
  prompt, copiedId, expandedId, setExpandedId, onCopy, onDelete, onDownload, highlight,
}: {
  prompt: PromptEntry;
  copiedId: string | null;
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  onCopy: (p: PromptEntry) => void;
  onDelete: (id: string) => void;
  onDownload: () => void;
  highlight?: boolean;
}) {
  const isExpanded = expandedId === prompt.id;

  return (
    <div className={clsx('bg-white border rounded-xl shadow-card overflow-hidden', highlight ? 'border-amber-200' : 'border-border')}>
      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setExpandedId(isExpanded ? null : prompt.id)}>
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-xs font-semibold text-slate-800 truncate">{prompt.title}</span>
            <SourceBadge source={prompt.source} />
            {prompt.usageCount >= 2 && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-700 border border-amber-200">
                <TrendingUp size={9} /> ×{prompt.usageCount}
              </span>
            )}
            {prompt.usageCount === 1 && <span className="text-[10px] text-slate-400">×1</span>}
          </div>
          <p className="text-[11px] text-slate-400 font-mono truncate">{prompt.content.slice(0, 80)}…</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={onDownload} title="Download prompt" className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
            <Download size={13} />
          </button>
          <button onClick={() => onCopy(prompt)} className="p-1.5 text-slate-400 hover:text-violet-600 hover:bg-violet-50 rounded-lg transition-colors">
            {copiedId === prompt.id ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
          </button>
          <button onClick={() => onDelete(prompt.id)} className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
            <Trash2 size={13} />
          </button>
          <ChevronRight size={13} className={clsx('text-slate-300 transition-transform cursor-pointer', isExpanded && 'rotate-90')} onClick={() => setExpandedId(isExpanded ? null : prompt.id)} />
        </div>
      </div>
      {isExpanded && (
        <div className="border-t border-slate-100 px-4 pb-3">
          <pre className="mt-3 px-3 py-3 bg-slate-50 border border-slate-100 rounded-xl text-[11px] font-mono text-slate-600 whitespace-pre-wrap break-all max-h-48 overflow-y-auto leading-relaxed">
            {prompt.content}
          </pre>
          <div className="flex items-center gap-3 mt-2 text-[10px] text-slate-400">
            <span>Used {prompt.usageCount}×</span>
            <span>·</span>
            <span>{prompt.updatedAt.toLocaleDateString()}</span>
            {prompt.tags.length > 0 && prompt.tags.map(t => <span key={t} className="px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded font-mono">{t}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}
