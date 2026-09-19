import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw, Download, Eye, Save, CheckCircle2, XCircle,
  AlertCircle, ChevronDown, Loader, ArrowRight, Filter,
  GitBranch, Tag, Zap,
} from 'lucide-react';
import clsx from 'clsx';
import { Header } from '../components/Header';
import { useStore } from '../store';
import { TaskStatus, Priority, TaskLabel, AIModel } from '../types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface JiraImportConfig {
  projectKey: string;
  sprint: string;
  assignee: string;
  issueTypes: string[];
  excludeLabels: string[];
  customJql: string;
  maxResults: number;
  statusMap: Record<string, string>;
  priorityMap: Record<string, string>;
  labelMap: Record<string, string>;
  defaultStatus: string;
  defaultPriority: string;
  defaultLabel: string;
  defaultModel: string;
}

interface JiraProject { key: string; name: string; id: string; }
interface JiraSprint { id: number; name: string; state: string; }

interface PreviewIssue {
  key: string;
  title: string;
  type: string;
  jiraStatus: string;
  jiraPriority: string;
  assignee: string;
  mappedStatus: string;
  mappedPriority: string;
  mappedLabel: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const APP_STATUSES: TaskStatus[] = ['backlog', 'in_progress', 'paused', 'done', 'failed', 'stopped'];
const APP_PRIORITIES: Priority[] = ['low', 'medium', 'high', 'critical'];
const APP_LABELS: TaskLabel[] = ['feature', 'bugfix', 'hotfix', 'chore', 'refactor', 'docs', 'test', 'task'];
const APP_MODELS: AIModel[] = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'];

const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog', in_progress: 'In Progress', paused: 'Paused',
  done: 'Done', failed: 'Failed', stopped: 'Stopped',
};

const COMMON_JIRA_STATUSES = [
  'To Do', 'In Progress', 'In Review', 'Code Review',
  'Done', 'Closed', 'Resolved', 'Blocked', 'On Hold',
  'Cancelled', "Won't Do", 'Open', 'Ready for Dev',
  'Testing', 'UAT', 'Released',
];

const COMMON_JIRA_PRIORITIES = ['Highest', 'Critical', 'High', 'Medium', 'Low', 'Lowest'];

const COMMON_ISSUE_TYPES = ['Story', 'Bug', 'Task', 'Epic', 'Sub-task', 'Improvement', 'Technical Debt', 'Documentation', 'Test'];

// ── Small helpers ─────────────────────────────────────────────────────────────

function Select<T extends string>({ value, onChange, options, className }: {
  value: T; onChange: (v: T) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <div className={clsx('relative', className)}>
      <select
        value={value}
        onChange={e => onChange(e.target.value as T)}
        className="w-full appearance-none bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-3 py-1.5 text-xs text-slate-700 outline-none pr-7 cursor-pointer"
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
    </div>
  );
}

function Badge({ children, color = 'slate' }: { children: React.ReactNode; color?: string }) {
  return (
    <span className={clsx('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium', {
      'bg-violet-100 text-violet-700': color === 'violet',
      'bg-emerald-100 text-emerald-700': color === 'emerald',
      'bg-amber-100 text-amber-700': color === 'amber',
      'bg-red-100 text-red-700': color === 'red',
      'bg-slate-100 text-slate-600': color === 'slate',
      'bg-blue-100 text-blue-700': color === 'blue',
    })}>
      {children}
    </span>
  );
}

function statusColor(s: string) {
  if (s === 'in_progress') return 'violet';
  if (s === 'done') return 'emerald';
  if (s === 'paused') return 'amber';
  if (s === 'failed' || s === 'stopped') return 'red';
  return 'slate';
}
function priorityColor(p: string) {
  if (p === 'critical') return 'red';
  if (p === 'high') return 'amber';
  if (p === 'medium') return 'blue';
  return 'slate';
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function JiraImportPage() {
  const { tasks } = useStore();

  const [cfg, setCfg] = useState<JiraImportConfig | null>(null);
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [sprints, setSprints] = useState<JiraSprint[]>([]);
  const [jiraStatuses, setJiraStatuses] = useState<string[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [tab, setTab] = useState<'filters' | 'mapping' | 'preview'>('filters');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<PreviewIssue[]>([]);
  const [previewTotal, setPreviewTotal] = useState(0);
  const [previewJql, setPreviewJql] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [importResult, setImportResult] = useState<{ count: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingProjects, setLoadingProjects] = useState(false);

  // Load config + projects on mount
  useEffect(() => {
    fetch('/api/jira/config').then(r => r.json()).then(({ config }: { config: JiraImportConfig }) => {
      setCfg(config);
    }).catch(() => setCfg(null));

    setLoadingProjects(true);
    fetch('/api/jira/projects').then(r => r.json()).then(({ ok, projects: p }: { ok: boolean; projects?: JiraProject[] }) => {
      setConnected(ok);
      setProjects(p ?? []);
    }).catch(() => setConnected(false)).finally(() => setLoadingProjects(false));
  }, []);

  // Load sprints when project changes
  useEffect(() => {
    if (!cfg?.projectKey) { setSprints([]); return; }
    fetch(`/api/jira/sprints?projectKey=${cfg.projectKey}`).then(r => r.json()).then(({ sprints: s }: { sprints?: JiraSprint[] }) => {
      setSprints(s ?? []);
    }).catch(() => setSprints([]));
  }, [cfg?.projectKey]);

  // Load statuses when project changes
  useEffect(() => {
    const pk = cfg?.projectKey ?? '';
    fetch(`/api/jira/statuses?projectKey=${pk}`).then(r => r.json()).then(({ statuses }: { statuses?: string[] }) => {
      if (statuses && statuses.length > 0) setJiraStatuses(statuses);
      else setJiraStatuses(COMMON_JIRA_STATUSES);
    }).catch(() => setJiraStatuses(COMMON_JIRA_STATUSES));
  }, [cfg?.projectKey]);

  const updateCfg = useCallback(<K extends keyof JiraImportConfig>(key: K, val: JiraImportConfig[K]) => {
    setCfg(prev => prev ? { ...prev, [key]: val } : prev);
  }, []);

  async function saveCfg() {
    if (!cfg) return;
    setSaving(true);
    try {
      await fetch('/api/jira/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally { setSaving(false); }
  }

  async function runPreview() {
    if (!cfg) return;
    setPreviewing(true);
    setPreviewError('');
    setPreview([]);
    setSelected(new Set());
    setImportResult(null);
    try {
      const r = await fetch('/api/jira/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      const { ok, preview: p, total, jql, error } = await r.json() as { ok: boolean; preview?: PreviewIssue[]; total?: number; jql?: string; error?: string };
      if (!ok) { setPreviewError(error ?? 'Unknown error'); return; }
      setPreview(p ?? []);
      setPreviewTotal(total ?? 0);
      setPreviewJql(jql ?? '');
      setSelected(new Set((p ?? []).map(i => i.key)));
      setTab('preview');
    } catch (e) { setPreviewError(String(e)); }
    finally { setPreviewing(false); }
  }

  async function runImport() {
    if (!cfg || selected.size === 0) return;
    setImporting(true);
    const toImport = preview.filter(i => selected.has(i.key));
    try {
      const r = await fetch('/api/jira/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cfg, issues: toImport }),
      });
      const { ok, created } = await r.json() as { ok: boolean; created?: number };
      if (ok) {
        setImportResult({ count: created ?? 0 });
        // Reload tasks from backend
        const tr = await fetch('/api/data/tasks');
        const { data } = await tr.json() as { data: Record<string, unknown> | null };
        if (data) {
          const { useStore: s } = await import('../store');
          Object.values(data).forEach((t: any) => {
            t.createdAt = new Date(t.createdAt);
            t.updatedAt = new Date(t.updatedAt);
            if (t.terminal?.startedAt) t.terminal.startedAt = new Date(t.terminal.startedAt);
            if (t.terminal?.completedAt) t.terminal.completedAt = new Date(t.terminal.completedAt);
            if (t.terminal) t.terminal.isRunning = false;
          });
          s.setState({ tasks: data as any });
        }
      }
    } finally { setImporting(false); }
  }

  if (!cfg) {
    return (
      <div className="flex-1 overflow-y-auto bg-base">
        <Header title="Jira Import" subtitle="Import issues from Jira as tasks" />
        <div className="flex items-center justify-center h-64">
          <Loader size={20} className="animate-spin text-slate-400" />
        </div>
      </div>
    );
  }

  const tabs = [
    { id: 'filters' as const, label: 'Filters', icon: Filter },
    { id: 'mapping' as const, label: 'Status & Label Mapping', icon: Tag },
    { id: 'preview' as const, label: `Preview${preview.length ? ` (${preview.length})` : ''}`, icon: Eye },
  ];

  return (
    <div className="flex-1 overflow-y-auto bg-base">
      <Header title="Jira Import" subtitle="Import Jira issues as tasks with custom mapping" />

      <div className="px-6 py-4 space-y-4">

        {/* Connection status */}
        <div className={clsx(
          'flex items-center gap-3 px-4 py-3 rounded-xl border text-sm',
          connected === true ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
            : connected === false ? 'bg-red-50 border-red-200 text-red-800'
              : 'bg-slate-50 border-slate-200 text-slate-600',
        )}>
          {connected === true && <CheckCircle2 size={15} />}
          {connected === false && <XCircle size={15} />}
          {connected === null && <Loader size={15} className="animate-spin" />}
          <span className="text-xs font-medium">
            {connected === true
              ? `Connected — ${projects.length} project${projects.length !== 1 ? 's' : ''} found`
              : connected === false
                ? 'Jira not configured — go to MCP Servers and add the Jira server first'
                : 'Checking connection…'}
          </span>
          {connected === false && (
            <a href="/mcp" className="ml-auto text-xs text-red-700 underline">Go to MCP Servers</a>
          )}
        </div>

        {/* Tab bar */}
        <div className="flex gap-0.5 bg-slate-100 p-1 rounded-xl w-fit">
          {tabs.map(t => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={clsx(
                  'flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium transition-colors',
                  tab === t.id ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700',
                )}
              >
                <Icon size={12} />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* ── Tab: Filters ── */}
        {tab === 'filters' && (
          <div className="bg-white border border-border rounded-2xl p-5 shadow-card space-y-5">

            {/* Project */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Project</label>
              {loadingProjects ? (
                <div className="flex items-center gap-2 text-xs text-slate-400"><Loader size={12} className="animate-spin" /> Loading projects…</div>
              ) : projects.length > 0 ? (
                <Select
                  value={cfg.projectKey}
                  onChange={v => updateCfg('projectKey', v)}
                  options={[
                    { value: '', label: '— All projects —' },
                    ...projects.map(p => ({ value: p.key, label: `${p.key} — ${p.name}` })),
                  ]}
                />
              ) : (
                <input
                  value={cfg.projectKey}
                  onChange={e => updateCfg('projectKey', e.target.value.toUpperCase())}
                  placeholder="e.g. FOX"
                  className="w-full bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-700 outline-none"
                />
              )}
              <p className="text-[10px] text-slate-400 mt-1">Leave blank to search across all projects.</p>
            </div>

            {/* Sprint */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Sprint</label>
              <Select
                value={cfg.sprint}
                onChange={v => updateCfg('sprint', v)}
                options={[
                  { value: 'all', label: 'All sprints / no sprint filter' },
                  { value: 'current', label: 'Current (active) sprint' },
                  ...sprints.map(s => ({ value: s.name, label: `${s.name} (${s.state})` })),
                ]}
              />
            </div>

            {/* Assignee */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Assignee</label>
              <Select
                value={cfg.assignee}
                onChange={v => updateCfg('assignee', v)}
                options={[
                  { value: 'all', label: 'All users' },
                  { value: 'me', label: 'Assigned to me (currentUser())' },
                  { value: 'EMPTY', label: 'Unassigned' },
                ]}
              />
            </div>

            {/* Issue Types */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-2">Issue Types</label>
              <div className="flex flex-wrap gap-2">
                {COMMON_ISSUE_TYPES.map(type => {
                  const active = cfg.issueTypes.includes(type);
                  return (
                    <button
                      key={type}
                      onClick={() => updateCfg('issueTypes', active
                        ? cfg.issueTypes.filter(t => t !== type)
                        : [...cfg.issueTypes, type]
                      )}
                      className={clsx(
                        'px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors',
                        active
                          ? 'bg-violet-100 border-violet-300 text-violet-700'
                          : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300',
                      )}
                    >
                      {type}
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] text-slate-400 mt-1.5">None selected = all types.</p>
            </div>

            {/* Exclude labels */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-2">
                Loại trừ Jira Labels
                <span className="ml-1.5 text-[10px] font-normal text-slate-400">(không import task có những label này)</span>
              </label>
              <div className="flex flex-wrap gap-2">
                {['OT', 'upcode', 'internal', 'blocked', 'wontfix'].map(label => {
                  const active = (cfg.excludeLabels ?? ['OT', 'upcode']).includes(label);
                  return (
                    <button
                      key={label}
                      onClick={() => updateCfg('excludeLabels', active
                        ? (cfg.excludeLabels ?? ['OT', 'upcode']).filter(l => l !== label)
                        : [...(cfg.excludeLabels ?? ['OT', 'upcode']), label]
                      )}
                      className={clsx(
                        'px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors',
                        active
                          ? 'bg-red-100 border-red-300 text-red-700'
                          : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300',
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] text-slate-400 mt-1.5">OT và upcode mặc định bị loại trừ.</p>
            </div>

            {/* Max results */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Max Results</label>
              <input
                type="number"
                min={1} max={100}
                value={cfg.maxResults}
                onChange={e => updateCfg('maxResults', Number(e.target.value))}
                className="w-24 bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-3 py-1.5 text-xs text-slate-700 outline-none"
              />
            </div>

            {/* Custom JQL */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Custom JQL <span className="text-[10px] font-normal text-slate-400">(overrides all filters above when non-empty)</span>
              </label>
              <textarea
                value={cfg.customJql}
                onChange={e => updateCfg('customJql', e.target.value)}
                placeholder={`project = "${cfg.projectKey || 'FOX'}" AND sprint in openSprints() AND assignee = currentUser() ORDER BY priority DESC`}
                rows={3}
                className="w-full bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-3 py-2 text-xs font-mono text-slate-700 outline-none resize-none"
              />
              <p className="text-[10px] text-slate-400 mt-1">
                JQL reference: <span className="font-mono">project, sprint, assignee, issuetype, status, priority, labels, created, updated</span>
              </p>
            </div>

            {/* Default model */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Default Claude Model for imported tasks</label>
              <Select
                value={cfg.defaultModel}
                onChange={v => updateCfg('defaultModel', v)}
                options={APP_MODELS.map(m => ({ value: m, label: m }))}
                className="w-64"
              />
            </div>

            <div className="flex items-center gap-3 pt-2 border-t border-slate-100">
              <button
                onClick={saveCfg}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary/90 text-white text-xs font-medium rounded-xl transition-colors disabled:opacity-60"
              >
                {saving ? <Loader size={12} className="animate-spin" /> : <Save size={12} />}
                {saved ? 'Saved!' : 'Save Filters'}
              </button>
              <button
                onClick={runPreview}
                disabled={previewing || connected !== true}
                className="flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-xs font-medium rounded-xl transition-colors disabled:opacity-60"
              >
                {previewing ? <Loader size={12} className="animate-spin" /> : <Eye size={12} />}
                Preview Issues
              </button>
            </div>
          </div>
        )}

        {/* ── Tab: Mapping ── */}
        {tab === 'mapping' && (
          <div className="space-y-4">

            {/* Status mapping */}
            <div className="bg-white border border-border rounded-2xl p-5 shadow-card">
              <div className="flex items-center gap-2 mb-4">
                <GitBranch size={14} className="text-primary" />
                <h2 className="text-sm font-semibold text-slate-700">Status Mapping</h2>
                <span className="text-[10px] text-slate-400 ml-1">Jira status → App status</span>
              </div>
              <div className="space-y-2">
                {jiraStatuses.map(js => (
                  <div key={js} className="flex items-center gap-3">
                    <span className="text-xs text-slate-600 w-40 truncate font-medium" title={js}>{js}</span>
                    <ArrowRight size={12} className="text-slate-300 shrink-0" />
                    <Select
                      value={(cfg.statusMap[js] ?? cfg.defaultStatus) as TaskStatus}
                      onChange={v => updateCfg('statusMap', { ...cfg.statusMap, [js]: v })}
                      options={APP_STATUSES.map(s => ({ value: s, label: STATUS_LABEL[s] ?? s }))}
                      className="w-40"
                    />
                  </div>
                ))}
              </div>
              <div className="mt-4 pt-4 border-t border-slate-100">
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Default status (for unmapped Jira statuses)</label>
                <Select
                  value={cfg.defaultStatus as TaskStatus}
                  onChange={v => updateCfg('defaultStatus', v)}
                  options={APP_STATUSES.map(s => ({ value: s, label: STATUS_LABEL[s] ?? s }))}
                  className="w-40"
                />
              </div>
            </div>

            {/* Priority mapping */}
            <div className="bg-white border border-border rounded-2xl p-5 shadow-card">
              <div className="flex items-center gap-2 mb-4">
                <Zap size={14} className="text-amber-500" />
                <h2 className="text-sm font-semibold text-slate-700">Priority Mapping</h2>
                <span className="text-[10px] text-slate-400 ml-1">Jira priority → App priority</span>
              </div>
              <div className="space-y-2">
                {COMMON_JIRA_PRIORITIES.map(jp => (
                  <div key={jp} className="flex items-center gap-3">
                    <span className="text-xs text-slate-600 w-28 truncate font-medium">{jp}</span>
                    <ArrowRight size={12} className="text-slate-300 shrink-0" />
                    <Select
                      value={(cfg.priorityMap[jp] ?? cfg.defaultPriority) as Priority}
                      onChange={v => updateCfg('priorityMap', { ...cfg.priorityMap, [jp]: v })}
                      options={APP_PRIORITIES.map(p => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) }))}
                      className="w-32"
                    />
                  </div>
                ))}
              </div>
              <div className="mt-4 pt-4 border-t border-slate-100">
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Default priority</label>
                <Select
                  value={cfg.defaultPriority as Priority}
                  onChange={v => updateCfg('defaultPriority', v)}
                  options={APP_PRIORITIES.map(p => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) }))}
                  className="w-32"
                />
              </div>
            </div>

            {/* Label / issue type mapping */}
            <div className="bg-white border border-border rounded-2xl p-5 shadow-card">
              <div className="flex items-center gap-2 mb-4">
                <Tag size={14} className="text-blue-500" />
                <h2 className="text-sm font-semibold text-slate-700">Issue Type → Label</h2>
                <span className="text-[10px] text-slate-400 ml-1">Jira issue type → App task label</span>
              </div>
              <div className="space-y-2">
                {COMMON_ISSUE_TYPES.map(it => (
                  <div key={it} className="flex items-center gap-3">
                    <span className="text-xs text-slate-600 w-40 truncate font-medium">{it}</span>
                    <ArrowRight size={12} className="text-slate-300 shrink-0" />
                    <Select
                      value={(cfg.labelMap[it] ?? cfg.defaultLabel) as TaskLabel}
                      onChange={v => updateCfg('labelMap', { ...cfg.labelMap, [it]: v })}
                      options={APP_LABELS.map(l => ({ value: l, label: l }))}
                      className="w-36"
                    />
                  </div>
                ))}
              </div>
              <div className="mt-4 pt-4 border-t border-slate-100">
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Default label</label>
                <Select
                  value={cfg.defaultLabel as TaskLabel}
                  onChange={v => updateCfg('defaultLabel', v)}
                  options={APP_LABELS.map(l => ({ value: l, label: l }))}
                  className="w-36"
                />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={saveCfg}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary/90 text-white text-xs font-medium rounded-xl transition-colors disabled:opacity-60"
              >
                {saving ? <Loader size={12} className="animate-spin" /> : <Save size={12} />}
                {saved ? 'Saved!' : 'Save Mapping'}
              </button>
              <button
                onClick={runPreview}
                disabled={previewing || connected !== true}
                className="flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-xs font-medium rounded-xl transition-colors disabled:opacity-60"
              >
                {previewing ? <Loader size={12} className="animate-spin" /> : <Eye size={12} />}
                Preview Issues
              </button>
            </div>
          </div>
        )}

        {/* ── Tab: Preview ── */}
        {tab === 'preview' && (
          <div className="space-y-4">

            {previewError && (
              <div className="flex items-start gap-2 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <div>
                  <span className="font-medium">Jira error: </span>{previewError}
                </div>
              </div>
            )}

            {importResult && (
              <div className="flex items-center gap-2 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800">
                <CheckCircle2 size={13} />
                <span className="font-medium">{importResult.count} issue{importResult.count !== 1 ? 's' : ''} imported successfully — check the Tasks board.</span>
              </div>
            )}

            {preview.length === 0 && !previewError && (
              <div className="bg-white border border-border rounded-2xl p-8 shadow-card text-center">
                <Eye size={24} className="text-slate-300 mx-auto mb-3" />
                <p className="text-sm text-slate-500">No preview yet.</p>
                <p className="text-xs text-slate-400 mt-1">Configure filters, then click "Preview Issues".</p>
                <button
                  onClick={runPreview}
                  disabled={previewing || connected !== true}
                  className="mt-4 flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-xs font-medium rounded-xl transition-colors mx-auto disabled:opacity-60"
                >
                  {previewing ? <Loader size={12} className="animate-spin" /> : <Eye size={12} />}
                  Preview Issues
                </button>
              </div>
            )}

            {preview.length > 0 && (
              <div className="bg-white border border-border rounded-2xl shadow-card overflow-hidden">
                {/* Header row */}
                <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={selected.size === preview.length}
                      onChange={e => setSelected(e.target.checked ? new Set(preview.map(i => i.key)) : new Set())}
                      className="rounded"
                    />
                    <span className="text-xs font-semibold text-slate-700">
                      {selected.size} of {preview.length} selected
                      {previewTotal > preview.length && (
                        <span className="text-slate-400 font-normal"> (total {previewTotal} in Jira)</span>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={runPreview} disabled={previewing} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors">
                      <RefreshCw size={12} className={previewing ? 'animate-spin' : ''} />
                    </button>
                    <button
                      onClick={runImport}
                      disabled={importing || selected.size === 0}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-primary hover:bg-primary/90 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-60"
                    >
                      {importing ? <Loader size={11} className="animate-spin" /> : <Download size={11} />}
                      Import {selected.size > 0 ? selected.size : ''} Issue{selected.size !== 1 ? 's' : ''}
                    </button>
                  </div>
                </div>

                {/* JQL used */}
                {previewJql && (
                  <div className="px-5 py-2 bg-slate-50 border-b border-slate-100">
                    <span className="text-[10px] text-slate-400 font-mono">JQL: </span>
                    <span className="text-[10px] text-slate-600 font-mono">{previewJql}</span>
                  </div>
                )}

                {/* Column headers */}
                <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-3 px-5 py-2 border-b border-slate-100 bg-slate-50">
                  <div />
                  <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Issue</span>
                  <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Type</span>
                  <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">→ Status</span>
                  <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">→ Priority</span>
                  <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">→ Label</span>
                </div>

                {/* Rows */}
                <div className="divide-y divide-slate-50">
                  {preview.map(issue => (
                    <div
                      key={issue.key}
                      className={clsx(
                        'grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-3 items-center px-5 py-2.5 hover:bg-slate-50 transition-colors',
                        !selected.has(issue.key) && 'opacity-50',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(issue.key)}
                        onChange={e => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(issue.key); else next.delete(issue.key);
                          setSelected(next);
                        }}
                        className="rounded"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono text-violet-600 shrink-0">{issue.key}</span>
                          <span className="text-xs text-slate-700 truncate">{issue.title}</span>
                        </div>
                        {issue.assignee && (
                          <span className="text-[10px] text-slate-400">{issue.assignee}</span>
                        )}
                      </div>
                      <Badge color="slate">{issue.type}</Badge>
                      <Badge color={statusColor(issue.mappedStatus)}>{STATUS_LABEL[issue.mappedStatus] ?? issue.mappedStatus}</Badge>
                      <Badge color={priorityColor(issue.mappedPriority)}>{issue.mappedPriority}</Badge>
                      <Badge color="blue">{issue.mappedLabel}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
