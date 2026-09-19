import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Server, Plus, Trash2, PlayCircle, CheckCircle2, XCircle, Loader,
  ChevronDown, ChevronRight, ExternalLink, Zap, RefreshCw, Download,
  Filter, Tag, GitBranch, ArrowRight, Save,
} from 'lucide-react';
import clsx from 'clsx';
import { Header } from '../components/Header';
import { TaskStatus, Priority, TaskLabel, AIModel } from '../types';

// ── MCP types ─────────────────────────────────────────────────────────────────

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface TestResult {
  ok: boolean;
  testing?: boolean;
  stdout?: string;
  stderr?: string;
}

interface EnvField {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  hint?: string;
}

interface Template {
  id: string;
  name: string;
  emoji: string;
  description: string;
  command: string;
  args: string;
  defaultName: string;
  envFields: EnvField[];
  setupNote?: string;
  docsUrl?: string;
}

const TEMPLATES: Template[] = [
  {
    id: 'jira',
    name: 'Jira',
    emoji: '🎫',
    description: 'Manage issues, sprints & projects',
    command: 'uvx',
    args: 'mcp-atlassian',
    defaultName: 'jira',
    envFields: [
      { key: 'JIRA_URL', label: 'Jira URL', placeholder: 'https://your-domain.atlassian.net', hint: 'Your Atlassian Cloud URL' },
      { key: 'JIRA_USERNAME', label: 'Email', placeholder: 'your@email.com', hint: 'Atlassian account email' },
      { key: 'JIRA_API_TOKEN', label: 'API Token', placeholder: 'Paste your API token here', secret: true, hint: 'Generate at id.atlassian.com → Security → API tokens' },
    ],
    setupNote: 'Requires uv — install with: pip install uv  or  winget install astral-sh.uv',
    docsUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
  },
  {
    id: 'github',
    name: 'GitHub',
    emoji: '🐙',
    description: 'Repos, issues, PRs & code search',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-github',
    defaultName: 'github',
    envFields: [
      { key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'Personal Access Token', placeholder: 'ghp_...', secret: true, hint: 'Generate at GitHub → Settings → Developer settings → PAT' },
    ],
    docsUrl: 'https://github.com/settings/tokens',
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    emoji: '🦊',
    description: 'Repos, MRs, issues & CI/CD pipelines',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-gitlab',
    defaultName: 'gitlab',
    envFields: [
      { key: 'GITLAB_PERSONAL_ACCESS_TOKEN', label: 'Personal Access Token', placeholder: 'glpat-...', secret: true, hint: 'Generate at git.fpt.net → User Settings → Access Tokens (api + read_repository scopes)' },
      { key: 'GITLAB_API_URL', label: 'GitLab API URL', placeholder: 'https://git.fpt.net/api/v4', hint: 'Default: https://git.fpt.net/api/v4' },
    ],
    docsUrl: 'https://git.fpt.net/-/user_settings/personal_access_tokens',
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    emoji: '📁',
    description: 'Read & write local files',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-filesystem /path/to/allowed/dir',
    defaultName: 'filesystem',
    envFields: [],
    setupNote: 'Replace /path/to/allowed/dir in the Args field with the folder Claude should access.',
  },
];

async function tryBackendAdd(name: string, config: McpServerConfig): Promise<boolean> {
  try {
    const r = await fetch('/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', name, config }),
      signal: AbortSignal.timeout(3000),
    });
    const data = await r.json() as { ok: boolean };
    return data.ok === true;
  } catch { return false; }
}

async function tryBackendRemove(name: string): Promise<boolean> {
  try {
    const r = await fetch('/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove', name }),
      signal: AbortSignal.timeout(3000),
    });
    const data = await r.json() as { ok: boolean };
    return data.ok === true;
  } catch { return false; }
}

async function tryTestBackend(name: string, _config: McpServerConfig): Promise<TestResult> {
  try {
    const r = await fetch('/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'test', name }),
      signal: AbortSignal.timeout(8000),
    });
    return await r.json() as TestResult;
  } catch {
    return { ok: false, stderr: `Dev server offline. Start it with:\n  cd agent-task-manager && npm run dev\n\nThen retry Test. (Credentials are saved to file — not lost.)` };
  }
}

// ── Jira Sync types & constants ───────────────────────────────────────────────

interface JiraImportConfig {
  projectKey: string;
  sprint: string;
  assignee: string;
  issueTypes: string[];
  statusFilter: string[];
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
  syncToProjectId?: string;
}

interface PreviewIssue {
  key: string; title: string; type: string;
  jiraStatus: string; jiraPriority: string; assignee: string;
  description?: string;
  mappedStatus: string; mappedPriority: string; mappedLabel: string;
}

interface JiraProject { key: string; name: string; id: string; }
interface JiraSprint { id: number; name: string; state: string; }

const APP_STATUSES: TaskStatus[] = ['backlog', 'in_progress', 'paused', 'done', 'failed', 'stopped'];
const APP_PRIORITIES: Priority[] = ['low', 'medium', 'high', 'critical'];
const APP_LABELS: TaskLabel[] = ['feature', 'bugfix', 'hotfix', 'chore', 'refactor', 'docs', 'test', 'task'];
const APP_MODELS: AIModel[] = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'];

const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog', in_progress: 'In Progress', paused: 'Paused',
  done: 'Done', failed: 'Failed', stopped: 'Stopped',
};

const COMMON_JIRA_STATUSES = [
  'To Do', 'In Progress', 'In Review', 'Code Review', 'Done', 'Closed',
  'Resolved', 'Blocked', 'On Hold', 'Cancelled', "Won't Do", 'Open',
  'Ready for Dev', 'Testing', 'UAT', 'Released',
];
const COMMON_JIRA_PRIORITIES = ['Highest', 'Critical', 'High', 'Medium', 'Low', 'Lowest'];
const COMMON_ISSUE_TYPES = ['Story', 'Bug', 'Task', 'Epic', 'Sub-task', 'Improvement', 'Technical Debt', 'Documentation', 'Test'];

// ── Jira Sync Panel ───────────────────────────────────────────────────────────

function JiraSyncPanel({ configuredEmail }: { configuredEmail?: string }) {
  const [tab, setTab] = useState<'filters' | 'mapping'>('filters');
  const [cfg, setCfg] = useState<JiraImportConfig | null>(null);
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [sprints, setSprints] = useState<JiraSprint[]>([]);
  const [jiraStatuses, setJiraStatuses] = useState<string[]>(COMMON_JIRA_STATUSES);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncResult, setSyncResult] = useState<{ count: number; skipped?: number } | null>(null);
  const [syncError, setSyncError] = useState('');
  const [targetProjectId, setTargetProjectId] = useState<string>('__jira__');

  // Load tool projects for target selector
  const [toolProjects, setToolProjects] = useState<Array<{ id: string; name: string; jiraProjectKey?: string | null }>>([]);
  useEffect(() => {
    import('../projectStore').then(({ useProjectStore }) => {
      const projs = Object.values(useProjectStore.getState().projects);
      setToolProjects(projs.map(p => ({ id: p.id, name: p.name, jiraProjectKey: p.jiraProjectKey })));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/jira/config').then(r => r.json()).then(({ config }: { config: JiraImportConfig }) => {
      setCfg(config);
      if (config.syncToProjectId) setTargetProjectId(config.syncToProjectId);
    }).catch(() => {});
    fetch('/api/jira/projects').then(r => r.json()).then(({ ok, projects: p }: { ok: boolean; projects?: JiraProject[] }) => {
      if (ok) setProjects(p ?? []);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!cfg?.projectKey) { setSprints([]); return; }
    fetch(`/api/jira/sprints?projectKey=${cfg.projectKey}`).then(r => r.json()).then(({ sprints: s }: { sprints?: JiraSprint[] }) => setSprints(s ?? [])).catch(() => {});
    // Auto-detect matching tool project by jiraProjectKey
    const match = toolProjects.find(p => p.jiraProjectKey === cfg.projectKey);
    if (match) setTargetProjectId(match.id);
  }, [cfg?.projectKey, toolProjects]);

  useEffect(() => {
    const pk = cfg?.projectKey ?? '';
    fetch(`/api/jira/statuses?projectKey=${pk}`).then(r => r.json()).then(({ statuses }: { statuses?: string[] }) => {
      if (statuses && statuses.length > 0) {
      const seen = new Set<string>();
      setJiraStatuses(statuses.filter(s => { const k = s.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }));
    }
    }).catch(() => {});
  }, [cfg?.projectKey]);

  const updateCfg = useCallback(<K extends keyof JiraImportConfig>(key: K, val: JiraImportConfig[K]) => {
    setCfg(prev => prev ? { ...prev, [key]: val } : prev);
  }, []);

  async function handleSave() {
    if (!cfg) return;
    setSaving(true);
    try {
      await fetch('/api/jira/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cfg, syncToProjectId: targetProjectId }) });
    } finally { setSaving(false); }
  }

  async function handleSync() {
    if (!cfg) return;
    setSyncing(true); setSyncResult(null); setSyncError('');
    try {
      // Auto-save config so filter selections persist
      await fetch('/api/jira/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
      // Always lock assignee to the configured email when present
      const effectiveCfg = configuredEmail ? { ...cfg, assignee: configuredEmail } : cfg;
      // Preview
      const pr = await fetch('/api/jira/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(effectiveCfg) });
      const { ok: pOk, preview, skipped: pSkipped, error: pErr } = await pr.json() as { ok: boolean; preview?: PreviewIssue[]; skipped?: number; error?: string };
      if (!pOk) { setSyncError(pErr ?? 'Preview failed'); return; }
      const issues = preview ?? [];
      if (issues.length === 0) { setSyncResult({ count: 0, skipped: pSkipped }); return; }
      // Import only new issues — pass targetProjectId so backend sets task.projectId
      const ir = await fetch('/api/jira/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cfg, issues, targetProjectId }) });
      const { ok: iOk, created, skipped: iSkipped, error: iErr } = await ir.json() as { ok: boolean; created?: number; skipped?: number; error?: string };
      if (!iOk) { setSyncError(iErr ?? 'Import failed'); return; }
      setSyncResult({ count: created ?? 0, skipped: (pSkipped ?? 0) + (iSkipped ?? 0) });
      // Reload tasks + projects into store
      const { initTasksFromBackend } = await import('../store');
      const { initProjectsFromBackend } = await import('../projectStore');
      await Promise.all([initTasksFromBackend(), initProjectsFromBackend()]);
    } catch (e) { setSyncError(String(e)); }
    finally { setSyncing(false); }
  }

  if (!cfg) return (
    <div className="mt-4 pt-4 border-t border-slate-100 space-y-4 animate-pulse">
      {/* tab bar skeleton */}
      <div className="flex gap-0.5 bg-slate-100 p-0.5 rounded-lg w-fit">
        <div className="w-20 h-6 bg-white rounded-md shadow-sm" />
        <div className="w-20 h-6 bg-slate-200 rounded-md" />
      </div>
      {/* two-col row */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5"><div className="h-2.5 w-14 bg-slate-200 rounded" /><div className="h-7 bg-slate-100 rounded-lg" /></div>
        <div className="space-y-1.5"><div className="h-2.5 w-14 bg-slate-200 rounded" /><div className="h-7 bg-slate-100 rounded-lg" /></div>
      </div>
      {/* assignee row */}
      <div className="space-y-1.5"><div className="h-2.5 w-16 bg-slate-200 rounded" /><div className="h-7 bg-slate-100 rounded-lg" /></div>
      {/* chips */}
      <div className="space-y-1.5">
        <div className="h-2.5 w-20 bg-slate-200 rounded" />
        <div className="flex flex-wrap gap-1.5">{Array.from({ length: 7 }).map((_, i) => <div key={i} className="h-5 w-14 bg-slate-100 rounded-md" />)}</div>
      </div>
      {/* footer */}
      <div className="flex items-center gap-2 pt-3 border-t border-slate-100">
        <div className="h-7 w-24 bg-slate-100 rounded-lg" />
        <div className="h-7 w-36 bg-violet-100 rounded-lg" />
      </div>
    </div>
  );

  return (
    <div className="mt-4 pt-4 border-t border-slate-100">
      {/* Tab bar */}
      <div className="flex gap-0.5 bg-slate-100 p-0.5 rounded-lg w-fit mb-4">
        {([['filters', 'Filters', Filter], ['mapping', 'Mapping', Tag]] as const).map(([id, label, Icon]) => (
          <button key={id} onClick={() => setTab(id as 'filters' | 'mapping')}
            className={clsx('flex items-center gap-1 px-3 py-1 rounded-md text-xs font-medium transition-colors',
              tab === id ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
            <Icon size={11} />{label}
          </button>
        ))}
      </div>

      {/* Filters tab */}
      {tab === 'filters' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {/* Project */}
            <div>
              <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Project</label>
              {projects.length > 0 ? (
                <select value={cfg.projectKey} onChange={e => updateCfg('projectKey', e.target.value)}
                  className="w-full bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 outline-none">
                  <option value="">— All projects —</option>
                  {projects.map(p => <option key={p.key} value={p.key}>{p.key} — {p.name}</option>)}
                </select>
              ) : (
                <input value={cfg.projectKey} onChange={e => updateCfg('projectKey', e.target.value.toUpperCase())}
                  placeholder="e.g. FOX"
                  className="w-full bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-700 outline-none" />
              )}
            </div>
            {/* Sprint */}
            <div>
              <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Sprint</label>
              <select value={cfg.sprint} onChange={e => updateCfg('sprint', e.target.value)}
                className="w-full bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 outline-none">
                <option value="all">All sprints</option>
                <option value="current">Current sprint</option>
                {sprints.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
              </select>
            </div>
          </div>

          {/* Assignee — locked to configured email */}
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Assignee</label>
            <div className="flex items-center gap-2 px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg">
              <span className="text-xs font-mono text-slate-700 flex-1 truncate">
                {configuredEmail ?? 'all users'}
              </span>
              {configuredEmail && (
                <span className="text-[10px] text-slate-400 shrink-0">locked</span>
              )}
            </div>
          </div>

          {/* Issue types */}
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Issue Types <span className="font-normal normal-case text-slate-400">(none = all)</span></label>
            <div className="flex flex-wrap gap-1.5">
              {COMMON_ISSUE_TYPES.map(type => {
                const active = cfg.issueTypes.includes(type);
                return (
                  <button key={type} onClick={() => updateCfg('issueTypes', active ? cfg.issueTypes.filter(t => t !== type) : [...cfg.issueTypes, type])}
                    className={clsx('px-2 py-0.5 rounded-md text-[10px] font-medium border transition-colors',
                      active ? 'bg-violet-100 border-violet-300 text-violet-700' : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300')}>
                    {type}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Status filter */}
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Status Filter <span className="font-normal normal-case text-slate-400">(none = all)</span></label>
            <div className="flex flex-wrap gap-1.5">
              {jiraStatuses.map(status => {
                const active = (cfg.statusFilter ?? []).includes(status);
                return (
                  <button key={status} onClick={() => {
                    const cur = cfg.statusFilter ?? [];
                    updateCfg('statusFilter', active ? cur.filter(s => s !== status) : [...cur, status]);
                  }}
                    className={clsx('px-2 py-0.5 rounded-md text-[10px] font-medium border transition-colors',
                      active ? 'bg-sky-100 border-sky-300 text-sky-700' : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300')}>
                    {status}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Exclude labels */}
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Loại trừ Jira Labels <span className="font-normal normal-case text-slate-400">(không sync task có những label này)</span>
            </label>
            <div className="flex flex-wrap gap-1.5">
              {['OT', 'upcode', 'internal', 'blocked', 'wontfix'].map(label => {
                const active = (cfg.excludeLabels ?? ['OT', 'upcode']).includes(label);
                return (
                  <button key={label} onClick={() => {
                    const cur = cfg.excludeLabels ?? ['OT', 'upcode'];
                    updateCfg('excludeLabels', active ? cur.filter(l => l !== label) : [...cur, label]);
                  }}
                    className={clsx('px-2 py-0.5 rounded-md text-[10px] font-medium border transition-colors',
                      active ? 'bg-red-100 border-red-300 text-red-700' : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300')}>
                    {label}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-slate-400 mt-1">OT và upcode được chọn mặc định để không sync task OT/overtime.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Max results */}
            <div>
              <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Max Results</label>
              <input type="number" min={1} max={100} value={cfg.maxResults} onChange={e => updateCfg('maxResults', Number(e.target.value))}
                className="w-full bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 outline-none" />
            </div>
            {/* Default model */}
            <div>
              <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Default Model</label>
              <select value={cfg.defaultModel} onChange={e => updateCfg('defaultModel', e.target.value)}
                className="w-full bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 outline-none">
                {APP_MODELS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>

          {/* Custom JQL */}
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">
              Custom JQL <span className="font-normal normal-case text-slate-400">(overrides filters above)</span>
            </label>
            <textarea value={cfg.customJql} onChange={e => updateCfg('customJql', e.target.value)}
              placeholder={`project = "${cfg.projectKey || 'FOX'}" AND sprint in openSprints() AND assignee = currentUser()`}
              rows={2}
              className="w-full bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-700 outline-none resize-none" />
          </div>
        </div>
      )}

      {/* Mapping tab */}
      {tab === 'mapping' && (
        <div className="space-y-4">
          {/* Status mapping */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <GitBranch size={12} className="text-primary" />
              <span className="text-xs font-semibold text-slate-600">Status Mapping</span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {jiraStatuses.map(js => (
                <div key={js} className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-600 w-24 truncate font-medium shrink-0">{js}</span>
                  <ArrowRight size={10} className="text-slate-300 shrink-0" />
                  <select value={cfg.statusMap[js] ?? cfg.defaultStatus}
                    onChange={e => updateCfg('statusMap', { ...cfg.statusMap, [js]: e.target.value })}
                    className="flex-1 min-w-0 bg-white border border-slate-200 rounded-lg px-2 py-1 text-[10px] text-slate-700 outline-none">
                    {APP_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <div className="mt-2 pt-2 border-t border-slate-100 flex items-center gap-2">
              <span className="text-[10px] text-slate-400">Default:</span>
              <select value={cfg.defaultStatus} onChange={e => updateCfg('defaultStatus', e.target.value)}
                className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-[10px] text-slate-700 outline-none">
                {APP_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>)}
              </select>
            </div>
          </div>

          {/* Priority mapping */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Zap size={12} className="text-amber-500" />
              <span className="text-xs font-semibold text-slate-600">Priority Mapping</span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {COMMON_JIRA_PRIORITIES.map(jp => (
                <div key={jp} className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-600 w-20 truncate font-medium shrink-0">{jp}</span>
                  <ArrowRight size={10} className="text-slate-300 shrink-0" />
                  <select value={cfg.priorityMap[jp] ?? cfg.defaultPriority}
                    onChange={e => updateCfg('priorityMap', { ...cfg.priorityMap, [jp]: e.target.value })}
                    className="flex-1 min-w-0 bg-white border border-slate-200 rounded-lg px-2 py-1 text-[10px] text-slate-700 outline-none">
                    {APP_PRIORITIES.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>

          {/* Label mapping */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Tag size={12} className="text-blue-500" />
              <span className="text-xs font-semibold text-slate-600">Issue Type → Label</span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {COMMON_ISSUE_TYPES.map(it => (
                <div key={it} className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-600 w-24 truncate font-medium shrink-0">{it}</span>
                  <ArrowRight size={10} className="text-slate-300 shrink-0" />
                  <select value={cfg.labelMap[it] ?? cfg.defaultLabel}
                    onChange={e => updateCfg('labelMap', { ...cfg.labelMap, [it]: e.target.value })}
                    className="flex-1 min-w-0 bg-white border border-slate-200 rounded-lg px-2 py-1 text-[10px] text-slate-700 outline-none">
                    {APP_LABELS.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Footer actions */}
      <div className="mt-4 pt-3 border-t border-slate-100 space-y-2">
        {/* Target project selector */}
        <div>
          <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Sync vào project</label>
          <select
            value={targetProjectId}
            onChange={e => { setTargetProjectId(e.target.value); setCfg(prev => prev ? { ...prev, syncToProjectId: e.target.value } : prev); }}
            className="w-full bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 outline-none"
          >
            <option value="__jira__">— project "jira" (mặc định) —</option>
            {toolProjects.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}{p.jiraProjectKey ? ` [${p.jiraProjectKey}]` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleSave} disabled={saving}
            className="flex items-center gap-1 px-3 py-1.5 border border-slate-200 text-slate-500 text-xs rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50">
            {saving ? <Loader size={11} className="animate-spin" /> : <Save size={11} />}
            Save config
          </button>
          <button onClick={handleSync} disabled={syncing}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-primary hover:bg-primary/90 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-60">
            {syncing ? <Loader size={11} className="animate-spin" /> : <Download size={11} />}
            {syncing ? 'Syncing…' : `Sync → ${toolProjects.find(p => p.id === targetProjectId)?.name ?? 'jira'}`}
          </button>
          {syncResult && (
            <span className="flex items-center gap-1 text-xs text-emerald-600">
              <CheckCircle2 size={12} /> {syncResult.count} task{syncResult.count !== 1 ? 's' : ''} mới
              {syncResult.skipped ? <span className="text-slate-400"> · {syncResult.skipped} đã có (bỏ qua)</span> : null}
            </span>
          )}
          {syncError && <span className="text-xs text-red-500 truncate max-w-xs" title={syncError}>{syncError}</span>}
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

async function autoPullAllProjects() {
  try {
    const { useProjectStore } = await import('../projectStore');
    const projects = Object.values(useProjectStore.getState().projects)
      .filter(p => p.repoPath && p.repoPath !== '__jira__');
    const { pullMain } = await import('../services/api');
    await Promise.allSettled(projects.map(p => pullMain(p.repoPath)));
  } catch { /* backend offline */ }
}

export function McpPage() {
  const [serversMap, setServersMap] = useState<Record<string, McpServerConfig>>({});
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [expandedEnv, setExpandedEnv] = useState<Record<string, boolean>>({});
  const [syncExpanded, setSyncExpanded] = useState<Record<string, boolean>>({});
  const [autoPullToast, setAutoPullToast] = useState('');
  const autoPullTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [newName, setNewName] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [newArgs, setNewArgs] = useState('');
  const [newEnv, setNewEnv] = useState('');
  const [guidedEnv, setGuidedEnv] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

  const servers = Object.entries(serversMap).map(([name, config]) => ({ name, config }));

  useEffect(() => {
    fetch('/api/mcp', { signal: AbortSignal.timeout(2000) })
      .then(r => r.json())
      .then((data: { servers?: Record<string, McpServerConfig> }) => {
        setBackendOk(true);
        if (data?.servers && Object.keys(data.servers).length > 0) setServersMap(data.servers!);
      })
      .catch(() => setBackendOk(false));
  }, []);

  function isJiraServer(config: McpServerConfig) {
    return !!config.env?.JIRA_URL;
  }

  function openTemplate(tmpl: Template) {
    setSelectedTemplate(tmpl);
    setNewName(tmpl.defaultName);
    setNewCommand(tmpl.command);
    setNewArgs(tmpl.args);
    setNewEnv('');
    setGuidedEnv({});
    setShowAdd(true);
  }

  function openCustom() {
    setSelectedTemplate(null);
    setNewName(''); setNewCommand(''); setNewArgs(''); setNewEnv(''); setGuidedEnv({});
    setShowAdd(true);
  }

  function closeForm() {
    setShowAdd(false);
    setSelectedTemplate(null);
    setNewName(''); setNewCommand(''); setNewArgs(''); setNewEnv(''); setGuidedEnv({});
  }

  async function handleAdd() {
    if (!newName.trim() || !newCommand.trim()) return;
    setAdding(true);
    try {
      const args = newArgs.trim() ? newArgs.trim().split(/\s+/) : undefined;
      let env: Record<string, string> | undefined;

      if (selectedTemplate && selectedTemplate.envFields.length > 0) {
        env = {};
        for (const field of selectedTemplate.envFields) {
          const val = guidedEnv[field.key]?.trim();
          if (val) env[field.key] = val;
        }
        if (Object.keys(env).length === 0) env = undefined;
      } else if (newEnv.trim()) {
        env = {};
        for (const line of newEnv.trim().split('\n')) {
          const eq = line.indexOf('=');
          if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
      }

      const name = newName.trim();
      const config: McpServerConfig = { command: newCommand.trim(), args, env };
      const next = { ...serversMap, [name]: config };
      setServersMap(next);
      const saved = await tryBackendAdd(name, config);
      setBackendOk(saved);
      // Auto-pull code when GitHub or GitLab server is added
      const isGitServer = selectedTemplate?.id === 'github' || selectedTemplate?.id === 'gitlab';
      if (isGitServer && saved) {
        autoPullAllProjects().then(() => {
          if (autoPullTimer.current) clearTimeout(autoPullTimer.current);
          setAutoPullToast('Auto-pulled latest code cho tất cả projects');
          autoPullTimer.current = setTimeout(() => setAutoPullToast(''), 4000);
        }).catch(() => {});
      }
      closeForm();
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(name: string) {
    const next = { ...serversMap };
    delete next[name];
    setServersMap(next);
    const removed = await tryBackendRemove(name);
    setBackendOk(removed);
    setTestResults(prev => { const n = { ...prev }; delete n[name]; return n; });
  }

  async function handleTest(name: string) {
    const config = serversMap[name];
    if (!config) return;
    setTestResults(prev => ({ ...prev, [name]: { ok: false, testing: true } }));
    const result = await tryTestBackend(name, config);
    setTestResults(prev => ({ ...prev, [name]: { ...result, testing: false } }));
  }

  return (
    <div className="flex-1 overflow-y-auto bg-base">
      <Header title="MCP Servers" subtitle="Configure Model Context Protocol servers for AI agents" />
      {autoPullToast && (
        <div className="mx-6 mt-4 flex items-center gap-2 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800">
          <CheckCircle2 size={13} />
          {autoPullToast}
        </div>
      )}
      <div className="px-6 py-6 max-w-3xl mx-auto space-y-4">

        {servers.length === 0 && !showAdd && (
          <div className="bg-white border border-border rounded-2xl p-8 text-center shadow-card">
            <Server size={28} className="mx-auto mb-3 text-slate-200" />
            <p className="text-sm font-medium text-slate-500">No MCP servers configured</p>
            <p className="text-xs text-slate-400 mt-1">Use a template below or add a custom server.</p>
          </div>
        )}

        {servers.map(srv => {
          const testResult = testResults[srv.name];
          const envEntries = Object.entries(srv.config.env ?? {});
          const envExpanded = expandedEnv[srv.name];
          const showSync = syncExpanded[srv.name];
          const jira = isJiraServer(srv.config);

          return (
            <div key={srv.name} className="bg-white border border-border rounded-2xl p-5 shadow-card">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-xl bg-violet-50 flex items-center justify-center shrink-0">
                    <Server size={15} className="text-primary" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-700">{srv.name}</div>
                    <div className="text-xs text-slate-400 font-mono truncate">
                      {srv.config.command}
                      {srv.config.args?.length ? ' ' + srv.config.args.join(' ') : ''}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {jira && (
                    <button
                      onClick={() => setSyncExpanded(prev => ({ ...prev, [srv.name]: !prev[srv.name] }))}
                      className={clsx(
                        'flex items-center gap-1.5 px-3 py-1.5 text-xs border rounded-xl transition-colors',
                        showSync
                          ? 'border-violet-400 bg-violet-50 text-primary'
                          : 'border-slate-200 text-slate-500 hover:border-violet-300 hover:text-primary',
                      )}
                    >
                      <RefreshCw size={11} />
                      Sync
                      {showSync ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                    </button>
                  )}
                  <button
                    onClick={() => handleTest(srv.name)}
                    disabled={testResult?.testing}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-500 border border-slate-200 rounded-xl hover:border-violet-300 hover:text-primary transition-colors disabled:opacity-50"
                  >
                    {testResult?.testing ? <Loader size={11} className="animate-spin" /> : <PlayCircle size={11} />}
                    Test
                  </button>
                  <button
                    onClick={() => handleRemove(srv.name)}
                    className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition-colors"
                    title="Remove server"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>

              {testResult && !testResult.testing && (
                <div className={clsx('mt-3 p-3 rounded-xl text-xs font-mono', testResult.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600')}>
                  <div className="flex items-center gap-1.5 mb-1">
                    {testResult.ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
                    <span className="font-semibold">{testResult.ok ? 'Connected successfully' : 'Connection failed'}</span>
                  </div>
                  {testResult.stdout && <div className="opacity-80 whitespace-pre-wrap">{testResult.stdout}</div>}
                  {testResult.stderr && <div className="opacity-80 whitespace-pre-wrap">{testResult.stderr}</div>}
                </div>
              )}

              {envEntries.length > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-100">
                  <button
                    onClick={() => setExpandedEnv(prev => ({ ...prev, [srv.name]: !envExpanded }))}
                    className="flex items-center gap-1 text-[10px] text-slate-400 uppercase tracking-wide hover:text-slate-600 transition-colors mb-1.5"
                  >
                    {envExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                    Environment ({envEntries.length})
                  </button>
                  {envExpanded && envEntries.map(([k]) => (
                    <div key={k} className="text-xs font-mono text-slate-500">
                      {k}=<span className="text-slate-300">***</span>
                    </div>
                  ))}
                </div>
              )}

              {jira && showSync && <JiraSyncPanel key={srv.name} configuredEmail={srv.config.env?.JIRA_USERNAME} />}
            </div>
          );
        })}

        {/* Quick Setup Templates */}
        {!showAdd && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Zap size={13} className="text-primary" />
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Quick Setup</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {TEMPLATES.map(tmpl => (
                <button
                  key={tmpl.id}
                  onClick={() => openTemplate(tmpl)}
                  className="flex items-center gap-3 bg-white border border-border rounded-2xl p-4 text-left hover:border-violet-300 hover:shadow-md transition-all group"
                >
                  <span className="text-xl shrink-0">{tmpl.emoji}</span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-700 group-hover:text-primary transition-colors">{tmpl.name}</div>
                    <div className="text-[11px] text-slate-400 truncate">{tmpl.description}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {!showAdd ? (
          <button
            onClick={openCustom}
            className="w-full flex items-center justify-center gap-2 py-3 border-2 border-dashed border-slate-200 rounded-2xl text-sm text-slate-400 hover:border-violet-300 hover:text-primary transition-colors"
          >
            <Plus size={14} />
            Add Custom MCP Server
          </button>
        ) : (
          <div className="bg-white border border-border rounded-2xl p-5 shadow-card">
            {selectedTemplate ? (
              <div className="flex items-center gap-3 mb-5 pb-4 border-b border-slate-100">
                <span className="text-2xl">{selectedTemplate.emoji}</span>
                <div>
                  <h3 className="text-sm font-semibold text-slate-700">Connect {selectedTemplate.name}</h3>
                  <p className="text-xs text-slate-400">{selectedTemplate.description}</p>
                </div>
                {selectedTemplate.docsUrl && (
                  <a href={selectedTemplate.docsUrl} target="_blank" rel="noreferrer"
                    className="ml-auto flex items-center gap-1 text-xs text-primary hover:underline shrink-0">
                    Get token <ExternalLink size={10} />
                  </a>
                )}
              </div>
            ) : (
              <h3 className="text-sm font-semibold text-slate-700 mb-4">Add Custom MCP Server</h3>
            )}

            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Server Name *</label>
                <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. jira"
                  className="w-full border border-slate-200 focus:border-violet-400 rounded-xl px-3 py-2 text-sm font-mono placeholder-slate-300 outline-none transition-colors" />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Command *</label>
                <input value={newCommand} onChange={e => setNewCommand(e.target.value)} placeholder="e.g. npx or uvx"
                  className="w-full border border-slate-200 focus:border-violet-400 rounded-xl px-3 py-2 text-sm font-mono placeholder-slate-300 outline-none transition-colors" />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Arguments <span className="text-slate-300">(space-separated)</span></label>
                <input value={newArgs} onChange={e => setNewArgs(e.target.value)}
                  placeholder="e.g. -y @modelcontextprotocol/server-filesystem /path"
                  className="w-full border border-slate-200 focus:border-violet-400 rounded-xl px-3 py-2 text-sm font-mono placeholder-slate-300 outline-none transition-colors" />
              </div>

              {selectedTemplate && selectedTemplate.envFields.length > 0 && (
                <div className="space-y-3 pt-1">
                  <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Credentials</div>
                  {selectedTemplate.envFields.map(field => (
                    <div key={field.key}>
                      <label className="text-xs text-slate-500 mb-1 block">
                        {field.label}
                        {field.hint && <span className="text-slate-400 font-normal ml-1">— {field.hint}</span>}
                      </label>
                      <div className="relative">
                        <input
                          type={field.secret && !showSecrets[field.key] ? 'password' : 'text'}
                          value={guidedEnv[field.key] ?? ''}
                          onChange={e => setGuidedEnv(prev => ({ ...prev, [field.key]: e.target.value }))}
                          placeholder={field.placeholder}
                          className="w-full border border-slate-200 focus:border-violet-400 rounded-xl px-3 py-2 text-sm font-mono placeholder-slate-300 outline-none transition-colors pr-16"
                        />
                        {field.secret && (
                          <button type="button"
                            onClick={() => setShowSecrets(prev => ({ ...prev, [field.key]: !prev[field.key] }))}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 hover:text-slate-600">
                            {showSecrets[field.key] ? 'hide' : 'show'}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {!selectedTemplate && (
                <div>
                  <label className="text-xs text-slate-500 mb-1 block">
                    Environment Variables <span className="text-slate-300">(one per line: KEY=value)</span>
                  </label>
                  <textarea value={newEnv} onChange={e => setNewEnv(e.target.value)}
                    placeholder={'API_KEY=your-key\nBASE_URL=https://...'} rows={3}
                    className="w-full border border-slate-200 focus:border-violet-400 rounded-xl px-3 py-2 text-sm font-mono placeholder-slate-300 outline-none transition-colors resize-none" />
                </div>
              )}

              {selectedTemplate?.setupNote && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5">
                  <span className="text-amber-400 text-sm mt-0.5">⚠</span>
                  <p className="text-xs text-amber-700 font-mono leading-relaxed">{selectedTemplate.setupNote}</p>
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button onClick={handleAdd} disabled={!newName.trim() || !newCommand.trim() || adding}
                  className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white text-xs font-medium rounded-xl transition-colors hover:bg-primary/90 disabled:opacity-50">
                  {adding ? <Loader size={11} className="animate-spin" /> : <Plus size={11} />}
                  {selectedTemplate ? `Add ${selectedTemplate.name}` : 'Add Server'}
                </button>
                <button onClick={closeForm}
                  className="px-4 py-2 text-slate-500 text-xs border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Storage status */}
        <div className="bg-slate-50 border border-slate-100 rounded-2xl p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className={clsx('w-2 h-2 rounded-full shrink-0',
              backendOk === true ? 'bg-emerald-400' : backendOk === false ? 'bg-amber-400' : 'bg-slate-300 animate-pulse')} />
            <span className="text-xs font-medium text-slate-600">
              {backendOk === true
                ? 'Saved to .mcp-servers.json — tokens encrypted with AES-256-GCM'
                : backendOk === false
                ? 'Backend offline — start dev server (npm run dev) to load saved servers'
                : 'Connecting…'}
            </span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed pl-4">
            Claude reads from{' '}
            <code className="bg-slate-200 px-1 rounded font-mono text-[10px]">~/.claude/settings.json</code>.
            {' '}Copy <code className="bg-slate-200 px-1 rounded font-mono text-[10px]">.mcp-servers.json</code>{' '}
            → <code className="bg-slate-200 px-1 rounded font-mono text-[10px]">mcpServers</code> key there to apply.
            Encryption key auto-generated in <code className="bg-slate-200 px-1 rounded font-mono text-[10px]">.env.local</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
