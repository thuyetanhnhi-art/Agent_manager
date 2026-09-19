import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FolderGit2, Plus, GitBranch, Trash2, ExternalLink, Zap,
  CheckCircle2, Clock, RefreshCw, Settings, X, KeyRound, AlertCircle,
  Tag, GitPullRequest, ChevronRight, ChevronDown,
  TerminalSquare, ArrowUp, ArrowDown, AlertTriangle,
  Download, GitCommit, Layers, Loader2, Circle, GitMerge,
} from 'lucide-react';
import clsx from 'clsx';
import { useProjectStore } from '../projectStore';
import { useStore } from '../store';
import { Header } from '../components/Header';
import { STATUS_META, type Project, type Task, type TaskStatus } from '../types';
import { formatRelative, formatTokens } from '../utils';
import {
  fetchGitlabConfig, saveGitlabConfig, pullMain,
  fetchRepoGitStatus, fetchConflictDetails, resolveConflictFile,
  finalizeConflictResolution, abortMerge, fetchProjectMRs, fetchProjectPipeline,
  openExternalTerminal,
  type RepoGitStatusResult, type ConflictFile, type GitlabMRInfo, type PipelineInfo,
} from '../services/api';

type PullState = 'idle' | 'loading' | 'ok' | 'err';

const STATUS_BADGE: Record<string, { label: string; dot: string; text: string; bg: string }> = {
  clean:    { label: 'Up to date',  dot: 'bg-emerald-400', text: 'text-emerald-700', bg: 'bg-emerald-50' },
  behind:   { label: 'Behind',      dot: 'bg-sky-400',     text: 'text-sky-700',     bg: 'bg-sky-50' },
  ahead:    { label: 'Ahead',       dot: 'bg-amber-400',   text: 'text-amber-700',   bg: 'bg-amber-50' },
  diverged: { label: 'Diverged',    dot: 'bg-purple-400',  text: 'text-purple-700',  bg: 'bg-purple-50' },
  conflict: { label: 'Conflict',    dot: 'bg-red-500',     text: 'text-red-700',     bg: 'bg-red-50' },
  unknown:  { label: 'Unknown',     dot: 'bg-slate-300',   text: 'text-slate-500',   bg: 'bg-slate-50' },
};

const PIPELINE_META: Record<string, { color: string; bg: string; icon: string }> = {
  success:  { color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200', icon: '●' },
  failed:   { color: 'text-red-700',     bg: 'bg-red-50 border-red-200',         icon: '●' },
  running:  { color: 'text-sky-700',     bg: 'bg-sky-50 border-sky-200',         icon: '○' },
  pending:  { color: 'text-amber-700',   bg: 'bg-amber-50 border-amber-200',     icon: '○' },
  canceled: { color: 'text-slate-600',   bg: 'bg-slate-50 border-slate-200',     icon: '●' },
};

// ── Main Page ─────────────────────────────────────────────────────────────────

export function ProjectsPage() {
  const { projects, activeProjectId, setActiveProject, openRepoPicker, removeProject, updateProject } = useProjectStore();
  const { tasks } = useStore();
  const navigate = useNavigate();

  const [sourcePanelId, setSourcePanelId] = useState<string | null>(null);
  const [repoStatuses, setRepoStatuses] = useState<Record<string, RepoGitStatusResult>>({});
  const [loadingStatus, setLoadingStatus] = useState<Record<string, boolean>>({});
  const [pullStates, setPullStates] = useState<Record<string, PullState>>({});
  const [pullMsgs, setPullMsgs] = useState<Record<string, string>>({});
  const [pullingAll, setPullingAll] = useState(false);

  const [showGitlabModal, setShowGitlabModal] = useState(false);
  const [gitlabUrlInput, setGitlabUrlInput] = useState('');
  const [gitlabTokenInput, setGitlabTokenInput] = useState('');
  const [gitlabConfiguredUrl, setGitlabConfiguredUrl] = useState('');
  const [gitlabHasToken, setGitlabHasToken] = useState(false);
  const [savingGitlab, setSavingGitlab] = useState(false);

  const projectList = Object.values(projects).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const pullableCount = projectList.filter(p => p.repoPath !== '__jira__').length;

  useEffect(() => {
    fetchGitlabConfig()
      .then(cfg => {
        setGitlabConfiguredUrl(cfg.url);
        setGitlabHasToken(cfg.hasToken);
        setGitlabUrlInput(cfg.url);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    projectList.forEach(p => {
      if (p.repoPath !== '__jira__') void refreshRepoStatus(p.id, p.repoPath);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshRepoStatus = useCallback(async (projectId: string, repoPath: string) => {
    setLoadingStatus(s => ({ ...s, [projectId]: true }));
    const result = await fetchRepoGitStatus(repoPath);
    setRepoStatuses(s => ({ ...s, [projectId]: result }));
    setLoadingStatus(s => ({ ...s, [projectId]: false }));
  }, []);

  const handlePullMain = async (projectId: string, repoPath: string) => {
    if (repoPath === '__jira__') return;
    setPullStates(s => ({ ...s, [projectId]: 'loading' }));
    setPullMsgs(s => ({ ...s, [projectId]: '' }));
    try {
      const result = await pullMain(repoPath);
      setPullStates(s => ({ ...s, [projectId]: result.ok ? 'ok' : 'err' }));
      const msg = result.ok
        ? (result.output ?? 'Done')
        : `[${result.step ?? 'error'}] ${result.error ?? 'Failed'}`;
      setPullMsgs(s => ({ ...s, [projectId]: msg }));
      if (result.ok) void refreshRepoStatus(projectId, repoPath);
    } catch {
      setPullStates(s => ({ ...s, [projectId]: 'err' }));
      setPullMsgs(s => ({ ...s, [projectId]: 'Network error' }));
    }
    setTimeout(() => setPullStates(s => ({ ...s, [projectId]: 'idle' })), 7000);
  };

  const handlePullAll = async () => {
    if (pullingAll) return;
    setPullingAll(true);
    for (const p of projectList.filter(p => p.repoPath !== '__jira__')) {
      await handlePullMain(p.id, p.repoPath);
    }
    setPullingAll(false);
  };

  const openGitlabModal = () => {
    setGitlabUrlInput(gitlabConfiguredUrl);
    setGitlabTokenInput('');
    setShowGitlabModal(true);
  };

  const handleSaveGitlab = async () => {
    setSavingGitlab(true);
    try {
      await saveGitlabConfig(gitlabUrlInput.trim(), gitlabTokenInput.trim());
      setGitlabConfiguredUrl(gitlabUrlInput.trim());
      if (gitlabTokenInput.trim()) setGitlabHasToken(true);
      setShowGitlabModal(false);
    } catch { /* ignore */ }
    setSavingGitlab(false);
  };

  const handleClearToken = async () => {
    await saveGitlabConfig(gitlabConfiguredUrl, '');
    setGitlabHasToken(false);
    setShowGitlabModal(false);
  };

  return (
    <div className="flex-1 overflow-y-auto bg-base">
      <Header title="Projects" subtitle="Repositories linked to this workspace" />

      <div className="px-6 py-4 space-y-4">
        {projectList.length === 0 ? (
          <EmptyState onAdd={openRepoPicker} />
        ) : (
          <>
            {/* ── Toolbar ── */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h2 className="text-xs font-medium text-slate-400 uppercase tracking-wider shrink-0">
                {projectList.length} {projectList.length === 1 ? 'project' : 'projects'}
              </h2>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={openGitlabModal}
                  className={clsx(
                    'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors',
                    gitlabHasToken
                      ? 'bg-orange-50 border-orange-200 text-orange-700 hover:bg-orange-100'
                      : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100',
                  )}
                >
                  <Settings size={12} />
                  GitLab{gitlabHasToken ? ' ✓' : ''}
                </button>
                {pullableCount > 0 && (
                  <button
                    onClick={() => { void handlePullAll(); }}
                    disabled={pullingAll}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-sky-600 hover:bg-sky-700 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-60"
                  >
                    <Download size={12} className={pullingAll ? 'animate-bounce' : ''} />
                    Pull All ({pullableCount})
                  </button>
                )}
                <button
                  onClick={openRepoPicker}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white text-xs font-medium rounded-lg transition-colors"
                >
                  <Plus size={12} />
                  Add Repo
                </button>
              </div>
            </div>

            {/* ── Project cards ── */}
            <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {projectList.map(project => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  isActive={activeProjectId === project.id}
                  status={repoStatuses[project.id]}
                  loading={loadingStatus[project.id] ?? false}
                  pullState={pullStates[project.id] ?? 'idle'}
                  pullMsg={pullMsgs[project.id] ?? ''}
                  tasks={tasks}
                  onActivate={() => setActiveProject(activeProjectId === project.id ? null : project.id)}
                  onOpenSource={() => setSourcePanelId(project.id)}
                  onPull={() => { void handlePullMain(project.id, project.repoPath); }}
                  onNavigateTasks={() => navigate('/tasks')}
                  onRemove={() => { if (confirm(`Remove "${project.name}"?`)) removeProject(project.id); }}
                  onUpdateJiraKey={(key) => updateProject(project.id, { jiraProjectKey: key || null })}
                />
              ))}
            </div>

            {/* Active project tasks */}
            {activeProjectId && projects[activeProjectId] && (
              <div>
                <h2 className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Zap size={11} className="text-violet-500" />
                  Tasks in {projects[activeProjectId].name}
                </h2>
                {projects[activeProjectId].taskIds.length === 0 ? (
                  <div className="text-sm text-slate-400 py-4 text-center border border-dashed border-slate-200 rounded-xl">
                    No tasks linked to this project yet
                  </div>
                ) : (
                  <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden max-w-2xl">
                    {projects[activeProjectId].taskIds.map((tid, i, arr) => {
                      const task = tasks[tid] as Task | undefined;
                      if (!task) return null;
                      const sMeta = STATUS_META[task.status as TaskStatus];
                      return (
                        <div
                          key={tid}
                          onClick={() => navigate(`/tasks/${tid}`)}
                          className={clsx(
                            'flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 transition-colors',
                            i < arr.length - 1 && 'border-b border-slate-100',
                          )}
                        >
                          <div className={clsx('w-2 h-2 rounded-full shrink-0', sMeta.dot)} />
                          <span className="flex-1 text-sm text-slate-700 truncate">{task.title}</span>
                          <span className={clsx('text-[10px] font-medium', sMeta.color)}>{sMeta.label}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Source Drawer overlay ── */}
      {sourcePanelId && projects[sourcePanelId] && (
        <SourceDrawer
          project={projects[sourcePanelId]}
          status={repoStatuses[sourcePanelId]}
          pullState={pullStates[sourcePanelId] ?? 'idle'}
          pullMsg={pullMsgs[sourcePanelId] ?? ''}
          gitlabHasToken={gitlabHasToken}
          onClose={() => setSourcePanelId(null)}
          onPull={() => { void handlePullMain(sourcePanelId, projects[sourcePanelId].repoPath); }}
          onRefresh={() => refreshRepoStatus(sourcePanelId, projects[sourcePanelId].repoPath)}
        />
      )}

      {/* ── GitLab settings modal ── */}
      {showGitlabModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm"
          onClick={() => setShowGitlabModal(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 mx-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 bg-orange-100 rounded-lg flex items-center justify-center">
                  <KeyRound size={14} className="text-orange-600" />
                </div>
                <h3 className="text-sm font-semibold text-slate-800">GitLab Settings</h3>
              </div>
              <button onClick={() => setShowGitlabModal(false)} className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100">
                <X size={16} />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">GitLab URL</label>
                <input
                  type="url"
                  value={gitlabUrlInput}
                  onChange={e => setGitlabUrlInput(e.target.value)}
                  placeholder="https://gitlab.com"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-300"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">
                  Personal Access Token
                  {gitlabHasToken && <span className="ml-2 text-emerald-600 font-normal">● configured</span>}
                </label>
                <input
                  type="password"
                  value={gitlabTokenInput}
                  onChange={e => setGitlabTokenInput(e.target.value)}
                  placeholder={gitlabHasToken ? 'Leave blank to keep existing token' : 'glpat-xxxxxxxxxxxxxxxxxxxx'}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-300 font-mono"
                />
                <p className="text-[10px] text-slate-400 mt-1.5">
                  Requires <strong>read_repository</strong> + <strong>read_api</strong> scopes.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between mt-6 pt-4 border-t border-slate-100">
              {gitlabHasToken ? (
                <button onClick={() => { void handleClearToken(); }} className="text-xs text-red-500 hover:text-red-700">Clear token</button>
              ) : <span />}
              <div className="flex gap-2">
                <button onClick={() => setShowGitlabModal(false)} className="px-4 py-2 text-xs text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
                  Cancel
                </button>
                <button
                  onClick={() => { void handleSaveGitlab(); }}
                  disabled={savingGitlab}
                  className="px-4 py-2 text-xs font-medium bg-orange-500 hover:bg-orange-600 text-white rounded-lg disabled:opacity-60"
                >
                  {savingGitlab ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Project Card ──────────────────────────────────────────────────────────────

interface ProjectCardProps {
  project: Project;
  isActive: boolean;
  status: RepoGitStatusResult | undefined;
  loading: boolean;
  pullState: PullState;
  pullMsg: string;
  tasks: Record<string, Task>;
  onActivate: () => void;
  onOpenSource: () => void;
  onPull: () => void;
  onNavigateTasks: () => void;
  onRemove: () => void;
  onUpdateJiraKey: (key: string) => void;
}

function ProjectCard({
  project, isActive, status, loading, pullState, pullMsg, tasks,
  onActivate, onOpenSource, onPull, onNavigateTasks, onRemove, onUpdateJiraKey,
}: ProjectCardProps) {
  const [editingJira, setEditingJira] = useState(false);
  const [jiraInput, setJiraInput] = useState('');
  const [terminalOpening, setTerminalOpening] = useState(false);
  const isJira = project.repoPath === '__jira__';
  const projectTasks = project.taskIds.map(id => tasks[id]).filter(Boolean);
  const runningCount = projectTasks.filter(t => t.terminal.isRunning).length;
  const doneCount = projectTasks.filter(t => t.status === 'done').length;
  const totalTokens = projectTasks.reduce((s, t) => s + t.terminal.tokenUsage.total, 0);
  const gitStatus = status?.status ?? 'unknown';
  const badgeMeta = STATUS_BADGE[gitStatus] ?? STATUS_BADGE.unknown;
  const hasConflict = gitStatus === 'conflict' || (status?.conflictFiles?.length ?? 0) > 0;

  const handleOpenTerminal = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setTerminalOpening(true);
    await openExternalTerminal(project.repoPath);
    setTimeout(() => setTerminalOpening(false), 1500);
  };

  return (
    <div
      className={clsx(
        'relative bg-white border rounded-2xl p-5 transition-all cursor-pointer hover:shadow-md hover:shadow-slate-200/60 flex flex-col',
        isActive ? 'border-violet-300 shadow-md shadow-violet-100/60' : 'border-slate-200',
      )}
      onClick={onActivate}
    >
      {isActive && (
        <div className="absolute inset-0 rounded-2xl border-2 border-violet-400/40 pointer-events-none" />
      )}

      {/* ── Card header ── */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 relative"
            style={{ background: `${project.color}18`, border: `1.5px solid ${project.color}30` }}
          >
            <FolderGit2 size={16} style={{ color: project.color }} />
            {hasConflict && (
              <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-red-500 rounded-full flex items-center justify-center">
                <AlertTriangle size={8} className="text-white" />
              </span>
            )}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-800 truncate">{project.name}</div>
            {project.branch && (
              <div className="flex items-center gap-1 text-[10px] text-slate-400 mt-0.5">
                <GitBranch size={9} />
                <span className="font-mono truncate">{project.branch}</span>
              </div>
            )}
          </div>
        </div>

        {/* Top-right: inline action buttons */}
        <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
          {!isJira && (
            <button
              onClick={e => { e.stopPropagation(); onPull(); }}
              disabled={pullState === 'loading'}
              className={clsx(
                'p-1.5 rounded-lg transition-colors',
                pullState === 'ok' && 'text-emerald-600 bg-emerald-50',
                pullState === 'err' && 'text-red-500 bg-red-50',
                pullState === 'loading' && 'text-sky-500 bg-sky-50',
                pullState === 'idle' && 'text-slate-400 hover:text-sky-600 hover:bg-sky-50',
              )}
              title="git pull"
            >
              {pullState === 'ok' ? <CheckCircle2 size={13} /> :
               pullState === 'err' ? <AlertCircle size={13} /> :
               pullState === 'loading' ? <RefreshCw size={13} className="animate-spin" /> :
               <Download size={13} />}
            </button>
          )}
          {!isJira && (
            <button
              onClick={handleOpenTerminal}
              title="Open terminal"
              className={clsx(
                'p-1.5 rounded-lg transition-colors',
                terminalOpening
                  ? 'text-emerald-600 bg-emerald-50'
                  : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100',
              )}
            >
              {terminalOpening
                ? <CheckCircle2 size={13} />
                : <TerminalSquare size={13} />}
            </button>
          )}
          <button
            onClick={e => { e.stopPropagation(); onNavigateTasks(); }}
            className="p-1.5 text-slate-400 hover:text-violet-600 hover:bg-violet-50 rounded-lg transition-colors"
            title="View tasks"
          >
            <ExternalLink size={13} />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onRemove(); }}
            className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
            title="Remove project"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Repo path */}
      <div className="text-[10px] font-mono text-slate-400 truncate mb-2 bg-slate-50 px-2 py-1 rounded-lg">
        {project.repoPath}
      </div>

      {/* Git status */}
      {!isJira && (
        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
          {status ? (
            <div className={clsx('flex items-center gap-1.5 px-2 py-1 rounded-lg w-fit', badgeMeta.bg)}>
              {loading
                ? <Loader2 size={9} className="animate-spin text-slate-400" />
                : <span className={clsx('w-1.5 h-1.5 rounded-full', badgeMeta.dot)} />
              }
              <span className={clsx('text-[10px] font-medium', badgeMeta.text)}>{badgeMeta.label}</span>
              {(status.aheadCount ?? 0) > 0 && (
                <span className={clsx('text-[9px] flex items-center gap-0.5', badgeMeta.text)}>
                  <ArrowUp size={8} />{status.aheadCount}
                </span>
              )}
              {(status.behindCount ?? 0) > 0 && (
                <span className={clsx('text-[9px] flex items-center gap-0.5', badgeMeta.text)}>
                  <ArrowDown size={8} />{status.behindCount}
                </span>
              )}
            </div>
          ) : loading ? (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-slate-50">
              <Loader2 size={9} className="animate-spin text-slate-400" />
              <span className="text-[10px] text-slate-400">Checking…</span>
            </div>
          ) : null}
          {hasConflict && (
            <div className="flex items-center gap-1 px-2 py-1 bg-red-50 rounded-lg">
              <AlertTriangle size={9} className="text-red-500" />
              <span className="text-[10px] text-red-600 font-medium">Conflicts</span>
            </div>
          )}
        </div>
      )}

      {/* Pull message */}
      {pullMsg && pullState !== 'idle' && (
        <div className={clsx('text-[10px] px-2 py-1 rounded-lg mb-2 break-all',
          pullState === 'ok' ? 'text-emerald-700 bg-emerald-50' : 'text-red-600 bg-red-50')}>
          {pullMsg}
        </div>
      )}

      {/* Last commit */}
      {project.lastCommit && !pullMsg && (
        <div className="text-[10px] text-slate-400 italic mb-2 truncate">"{project.lastCommit}"</div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-4 gap-2 text-center mt-auto pt-3">
        <MiniStat label="Tasks" value={projectTasks.length} color="text-slate-700" />
        <MiniStat label="Done" value={doneCount} color="text-emerald-600" />
        <MiniStat label="Tokens" value={formatTokens(totalTokens)} color="text-violet-600" />
        <MiniStat label="Running" value={runningCount} color={runningCount > 0 ? 'text-primary animate-pulse' : 'text-slate-400'} />
      </div>

      {/* Task status bar */}
      {projectTasks.length > 0 && (
        <div className="mt-2 flex gap-0.5">
          {projectTasks.slice(0, 12).map(t => (
            <div key={t.id} className={clsx('flex-1 h-1 rounded-full', STATUS_META[t.status].dot)} title={t.title} />
          ))}
        </div>
      )}

      {/* Jira mapping */}
      {!isJira && (
        <div className="mt-3 pt-3 border-t border-slate-100" onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-2">
            <Tag size={9} className="text-slate-400 shrink-0" />
            <span className="text-[10px] text-slate-400 shrink-0">Jira Key:</span>
            {editingJira ? (
              <div className="flex items-center gap-1 flex-1">
                <input
                  autoFocus
                  value={jiraInput}
                  onChange={e => setJiraInput(e.target.value.toUpperCase())}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { onUpdateJiraKey(jiraInput.trim()); setEditingJira(false); }
                    if (e.key === 'Escape') setEditingJira(false);
                  }}
                  placeholder="e.g. FOX"
                  className="flex-1 min-w-0 bg-white border border-violet-300 rounded px-2 py-0.5 text-[10px] font-mono text-slate-700 outline-none"
                />
                <button
                  onClick={() => { onUpdateJiraKey(jiraInput.trim()); setEditingJira(false); }}
                  className="text-[10px] text-violet-600 hover:text-violet-800 font-medium"
                >Save</button>
              </div>
            ) : (
              <button
                onClick={() => { setEditingJira(true); setJiraInput(project.jiraProjectKey ?? ''); }}
                className="text-[10px] font-mono text-violet-600 hover:text-violet-800 hover:underline"
              >
                {project.jiraProjectKey || '+ Add key'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Footer: time + Source button ── */}
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-100">
        <div className="flex items-center gap-1 text-[10px] text-slate-400">
          <Clock size={9} />
          {formatRelative(new Date(project.lastModified))}
        </div>
        <div className="flex items-center gap-2">
          {isActive && (
            <span className="text-[10px] text-violet-500 font-medium flex items-center gap-1">
              <CheckCircle2 size={9} />
              Active
            </span>
          )}
          <button
            onClick={e => { e.stopPropagation(); onOpenSource(); }}
            className={clsx(
              'flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-lg border transition-colors',
              hasConflict
                ? 'text-red-600 bg-red-50 border-red-200 hover:bg-red-100'
                : 'text-violet-600 bg-violet-50 border-violet-200 hover:bg-violet-100',
            )}
          >
            <Layers size={11} />
            Source
            {hasConflict && <AlertTriangle size={10} className="text-red-500" />}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Source Drawer (right-side overlay) ───────────────────────────────────────

interface SourceDrawerProps {
  project: Project;
  status: RepoGitStatusResult | undefined;
  pullState: PullState;
  pullMsg: string;
  gitlabHasToken: boolean;
  onClose: () => void;
  onPull: () => void;
  onRefresh: () => void;
}

function SourceDrawer(props: SourceDrawerProps) {
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-slate-900/25 backdrop-blur-[1px]"
        onClick={props.onClose}
      />
      {/* Drawer panel */}
      <div className="fixed right-0 top-0 h-full z-50 w-[460px] max-w-[95vw] flex flex-col bg-white border-l border-slate-200 shadow-2xl">
        <SourceDrawerContent {...props} />
      </div>
    </>
  );
}

function SourceDrawerContent({ project, status, pullState, pullMsg, gitlabHasToken, onClose, onPull, onRefresh }: SourceDrawerProps) {
  const [mrs, setMrs] = useState<GitlabMRInfo[]>([]);
  const [pipeline, setPipeline] = useState<PipelineInfo | null>(null);
  const [loadingGitlab, setLoadingGitlab] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [showConflictModal, setShowConflictModal] = useState(false);
  const [terminalOpening, setTerminalOpening] = useState(false);
  const isJira = project.repoPath === '__jira__';

  useEffect(() => {
    if (gitlabHasToken && !isJira) {
      setLoadingGitlab(true);
      Promise.all([
        fetchProjectMRs(project.repoPath),
        fetchProjectPipeline(project.repoPath),
      ]).then(([mrsResult, pipelineResult]) => {
        if (mrsResult.ok) setMrs(mrsResult.mrs ?? []);
        if (pipelineResult.ok && pipelineResult.pipeline) setPipeline(pipelineResult.pipeline);
      }).finally(() => setLoadingGitlab(false));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, gitlabHasToken]);

  const handleOpenTerminal = async () => {
    setTerminalOpening(true);
    await openExternalTerminal(project.repoPath);
    setTimeout(() => setTerminalOpening(false), 1500);
  };

  const gitStatus = status?.status ?? 'unknown';
  const badgeMeta = STATUS_BADGE[gitStatus] ?? STATUS_BADGE.unknown;
  const conflictFiles = status?.conflictFiles ?? [];
  const hasConflicts = gitStatus === 'conflict' || conflictFiles.length > 0;
  const branches = status?.branches ?? [];

  return (
    <>
      {/* Drawer header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-200 shrink-0 bg-white">
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: `${project.color}18`, border: `1.5px solid ${project.color}30` }}
        >
          <FolderGit2 size={16} style={{ color: project.color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-800 truncate">{project.name}</div>
          <div className="text-[10px] text-slate-400 flex items-center gap-1 mt-0.5">
            <Layers size={9} className="text-violet-400" />
            <span>Source Manager</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {!isJira && (
            <button
              onClick={onPull}
              disabled={pullState === 'loading'}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors',
                pullState === 'ok'      && 'bg-emerald-50 border-emerald-200 text-emerald-700',
                pullState === 'err'     && 'bg-red-50 border-red-200 text-red-700',
                pullState === 'loading' && 'bg-sky-50 border-sky-200 text-sky-700',
                pullState === 'idle'    && 'bg-sky-600 hover:bg-sky-700 border-sky-600 text-white',
              )}
            >
              {pullState === 'loading' ? <RefreshCw size={12} className="animate-spin" /> :
               pullState === 'ok'      ? <CheckCircle2 size={12} /> :
               pullState === 'err'     ? <AlertCircle size={12} /> :
               <Download size={12} />}
              {pullState === 'loading' ? 'Pulling…' : pullState === 'ok' ? 'Updated' : pullState === 'err' ? 'Failed' : 'Pull'}
            </button>
          )}
          <button
            onClick={onRefresh}
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Drawer body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 bg-slate-50/50">

        {/* ── Repository info ── */}
        <PanelSection title="Repository" icon={<FolderGit2 size={13} />}>
          <div className="space-y-2">
            <div className="text-[10px] font-mono text-slate-500 bg-slate-50 border border-slate-200 px-3 py-2 rounded-lg break-all">
              {project.repoPath}
            </div>

            {!isJira && (
              <div className="flex items-center gap-2 flex-wrap">
                {project.branch && (
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg">
                    <GitBranch size={11} className="text-slate-400" />
                    <span className="text-xs font-mono text-slate-700">{project.branch}</span>
                  </div>
                )}
                {status && (
                  <div className={clsx(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border',
                    badgeMeta.bg,
                    gitStatus === 'clean'    ? 'border-emerald-200' :
                    gitStatus === 'behind'   ? 'border-sky-200' :
                    gitStatus === 'ahead'    ? 'border-amber-200' :
                    gitStatus === 'diverged' ? 'border-purple-200' :
                    gitStatus === 'conflict' ? 'border-red-200' : 'border-slate-200',
                  )}>
                    <span className={clsx('w-1.5 h-1.5 rounded-full', badgeMeta.dot)} />
                    <span className={clsx('text-xs font-medium', badgeMeta.text)}>{badgeMeta.label}</span>
                    {(status.aheadCount ?? 0) > 0 && (
                      <span className={clsx('flex items-center gap-0.5 text-[10px]', badgeMeta.text)}>
                        <ArrowUp size={9} />{status.aheadCount}
                      </span>
                    )}
                    {(status.behindCount ?? 0) > 0 && (
                      <span className={clsx('flex items-center gap-0.5 text-[10px]', badgeMeta.text)}>
                        <ArrowDown size={9} />{status.behindCount}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}

            {status?.lastCommit && (
              <div className="flex items-start gap-2 px-3 py-2 bg-white border border-slate-200 rounded-lg">
                <GitCommit size={12} className="text-slate-400 mt-0.5 shrink-0" />
                <span className="text-[11px] text-slate-600 italic leading-snug">"{status.lastCommit}"</span>
              </div>
            )}

            {pullMsg && pullState !== 'idle' && (
              <div className={clsx('text-[10px] px-3 py-2 rounded-lg break-all border',
                pullState === 'ok'
                  ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                  : 'text-red-600 bg-red-50 border-red-200')}>
                {pullMsg}
              </div>
            )}

            {!isJira && (
              <button
                onClick={handleOpenTerminal}
                className={clsx(
                  'flex items-center gap-2 w-full px-3 py-2 text-xs font-medium rounded-lg border transition-colors',
                  terminalOpening
                    ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                    : 'text-slate-600 bg-white hover:bg-slate-50 border-slate-200 hover:border-slate-300',
                )}
              >
                {terminalOpening
                  ? <><CheckCircle2 size={13} className="text-emerald-600" /> Terminal opened</>
                  : <><TerminalSquare size={13} /> Open Terminal Here</>
                }
              </button>
            )}
          </div>
        </PanelSection>

        {/* ── Conflict alert ── */}
        {hasConflicts && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-7 h-7 bg-red-100 rounded-lg flex items-center justify-center shrink-0">
                <AlertTriangle size={14} className="text-red-600" />
              </div>
              <div>
                <div className="text-sm font-semibold text-red-800">Merge Conflict Detected</div>
                <div className="text-[10px] text-red-600">
                  {conflictFiles.length > 0
                    ? `${conflictFiles.length} file${conflictFiles.length > 1 ? 's' : ''} need resolution`
                    : 'Files need resolution'}
                </div>
              </div>
            </div>
            {conflictFiles.length > 0 && (
              <div className="space-y-1 mb-3">
                {conflictFiles.slice(0, 5).map(f => (
                  <div key={f} className="flex items-center gap-2 px-2 py-1.5 bg-white/70 rounded-lg">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                    <span className="text-[10px] font-mono text-red-700 truncate">{f}</span>
                  </div>
                ))}
                {conflictFiles.length > 5 && (
                  <div className="text-[10px] text-red-600 px-2">+{conflictFiles.length - 5} more…</div>
                )}
              </div>
            )}
            <button
              onClick={() => setShowConflictModal(true)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-lg transition-colors"
            >
              <GitMerge size={13} />
              Resolve Conflicts
            </button>
          </div>
        )}

        {/* ── Branches ── */}
        {branches.length > 0 && (
          <PanelSection
            title={`Branches (${branches.length})`}
            icon={<GitBranch size={13} />}
            collapsible
            open={branchesOpen}
            onToggle={() => setBranchesOpen(v => !v)}
          >
            <div className="space-y-1">
              {branches.map(b => (
                <div
                  key={b}
                  className={clsx(
                    'flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[11px] font-mono',
                    b === project.branch
                      ? 'bg-violet-50 border border-violet-200 text-violet-700'
                      : 'bg-white border border-slate-200 text-slate-600',
                  )}
                >
                  <GitBranch size={9} />
                  <span className="truncate flex-1">{b}</span>
                  {b === project.branch && (
                    <span className="text-[9px] text-violet-500 font-sans font-medium shrink-0">current</span>
                  )}
                </div>
              ))}
            </div>
          </PanelSection>
        )}

        {/* ── GitLab: Merge Requests ── */}
        {gitlabHasToken && (
          <PanelSection
            title={loadingGitlab ? 'Merge Requests' : `Merge Requests (${mrs.length})`}
            icon={<GitPullRequest size={13} />}
          >
            {loadingGitlab ? (
              <div className="flex items-center gap-2 text-xs text-slate-400 py-2">
                <Loader2 size={12} className="animate-spin" /> Loading from GitLab…
              </div>
            ) : mrs.length === 0 ? (
              <div className="text-xs text-slate-400 py-1">No open merge requests</div>
            ) : (
              <div className="space-y-2">
                {mrs.map(mr => (
                  <a
                    key={mr.id}
                    href={mr.webUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="block px-3 py-2.5 bg-white border border-slate-200 rounded-xl hover:border-slate-300 hover:shadow-sm transition-all"
                    onClick={e => e.stopPropagation()}
                  >
                    <div className="flex items-start gap-2">
                      <span className={clsx('text-[9px] px-1.5 py-0.5 rounded font-medium shrink-0 mt-0.5',
                        mr.draft ? 'bg-slate-100 text-slate-500' : 'bg-emerald-100 text-emerald-700')}>
                        {mr.draft ? 'Draft' : 'Open'}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-slate-700 leading-snug truncate">{mr.title}</div>
                        <div className="text-[9px] text-slate-400 mt-0.5 flex items-center gap-1">
                          <span className="font-mono">{mr.sourceBranch}</span>
                          <ChevronRight size={8} />
                          <span className="font-mono">{mr.targetBranch}</span>
                        </div>
                      </div>
                      <span className="text-[9px] text-slate-400 shrink-0">{mr.author}</span>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </PanelSection>
        )}

        {/* ── GitLab: Pipeline ── */}
        {gitlabHasToken && (pipeline || loadingGitlab) && (
          <PanelSection title="Latest Pipeline" icon={<Circle size={13} />}>
            {loadingGitlab ? (
              <div className="flex items-center gap-2 text-xs text-slate-400 py-2">
                <Loader2 size={12} className="animate-spin" /> Loading pipeline…
              </div>
            ) : pipeline ? (
              <a
                href={pipeline.webUrl}
                target="_blank"
                rel="noreferrer"
                className={clsx(
                  'flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all hover:shadow-sm',
                  PIPELINE_META[pipeline.status]?.bg ?? 'bg-slate-50 border-slate-200',
                )}
                onClick={e => e.stopPropagation()}
              >
                <span className={clsx('text-sm leading-none', PIPELINE_META[pipeline.status]?.color ?? 'text-slate-500')}>
                  {PIPELINE_META[pipeline.status]?.icon}
                </span>
                <div className="flex-1 min-w-0">
                  <div className={clsx('text-xs font-semibold capitalize', PIPELINE_META[pipeline.status]?.color ?? 'text-slate-600')}>
                    {pipeline.status}
                  </div>
                  <div className="text-[9px] text-slate-400 font-mono truncate">{pipeline.ref}</div>
                </div>
                <div className="text-[9px] text-slate-400 shrink-0">
                  {formatRelative(new Date(pipeline.updatedAt))}
                </div>
                <ExternalLink size={9} className="text-slate-400 shrink-0" />
              </a>
            ) : null}
          </PanelSection>
        )}

        {/* Connect GitLab prompt */}
        {!gitlabHasToken && !isJira && (
          <div className="flex items-center gap-3 px-4 py-3 bg-orange-50 border border-orange-200 rounded-xl">
            <KeyRound size={14} className="text-orange-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-orange-800">Connect GitLab</div>
              <div className="text-[10px] text-orange-600">Configure a PAT to see MRs & pipelines</div>
            </div>
          </div>
        )}
      </div>

      {/* Conflict Resolver Modal */}
      {showConflictModal && (
        <ConflictResolverModal
          projectName={project.name}
          repoPath={project.repoPath}
          initialConflictFiles={conflictFiles}
          onClose={() => setShowConflictModal(false)}
          onResolved={() => {
            setShowConflictModal(false);
            onRefresh();
          }}
        />
      )}
    </>
  );
}

// ── Conflict Resolver Modal ───────────────────────────────────────────────────

interface ConflictModalProps {
  projectName: string;
  repoPath: string;
  initialConflictFiles: string[];
  onClose: () => void;
  onResolved: () => void;
}

function ConflictResolverModal({ projectName, repoPath, initialConflictFiles, onClose, onResolved }: ConflictModalProps) {
  const [files, setFiles] = useState<ConflictFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [resolving, setResolving] = useState<Record<string, boolean>>({});
  const [resolved, setResolved] = useState<Record<string, 'ours' | 'theirs' | 'manual'>>({});
  const [finalizing, setFinalizing] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    fetchConflictDetails(repoPath).then(result => {
      if (result.ok && result.files && result.files.length > 0) {
        setFiles(result.files);
        setExpanded(result.files[0].path);
      } else {
        setFiles(initialConflictFiles.map(path => ({ path, oursContent: '', theirsContent: '' })));
        if (initialConflictFiles.length > 0) setExpanded(initialConflictFiles[0]);
      }
      setLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);

  const handleResolve = async (filePath: string, resolution: 'ours' | 'theirs') => {
    setResolving(s => ({ ...s, [filePath]: true }));
    const result = await resolveConflictFile(repoPath, filePath, resolution);
    setResolving(s => ({ ...s, [filePath]: false }));
    if (result.ok) {
      setResolved(s => ({ ...s, [filePath]: resolution }));
    } else {
      setError(result.error ?? 'Failed to resolve');
    }
  };

  const handleMarkManual = (filePath: string) => {
    setResolved(s => ({ ...s, [filePath]: 'manual' }));
  };

  const handleFinalize = async () => {
    setFinalizing(true);
    const result = await finalizeConflictResolution(repoPath);
    setFinalizing(false);
    if (result.ok) {
      onResolved();
    } else {
      setError(result.error ?? 'Failed to finalize merge');
    }
  };

  const handleAbort = async () => {
    if (!confirm('Abort merge? All conflict resolution progress will be lost.')) return;
    setAborting(true);
    const result = await abortMerge(repoPath);
    setAborting(false);
    if (result.ok) {
      onResolved();
    } else {
      setError(result.error ?? 'Failed to abort merge');
    }
  };

  const handleOpenTerminal = () => { void openExternalTerminal(repoPath); };

  const totalFiles = files.length;
  const resolvedCount = Object.keys(resolved).length;
  const allResolved = totalFiles > 0 && resolvedCount >= totalFiles;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl mx-4 flex flex-col overflow-hidden"
        style={{ maxHeight: '90vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-200 shrink-0">
          <div className="w-8 h-8 bg-red-100 rounded-xl flex items-center justify-center shrink-0">
            <GitMerge size={16} className="text-red-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-slate-800">Resolve Conflicts — {projectName}</h3>
            <p className="text-[10px] text-slate-400">
              {loading ? 'Loading…' : `${resolvedCount} / ${totalFiles} files resolved`}
            </p>
          </div>
          {!loading && totalFiles > 0 && (
            <div className="w-24 h-1.5 bg-slate-100 rounded-full overflow-hidden shrink-0">
              <div
                className="h-full bg-emerald-500 rounded-full transition-all duration-300"
                style={{ width: `${(resolvedCount / totalFiles) * 100}%` }}
              />
            </div>
          )}
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {loading ? (
            <div className="flex items-center gap-3 py-8 justify-center">
              <Loader2 size={18} className="animate-spin text-slate-400" />
              <span className="text-sm text-slate-400">Loading conflict details…</span>
            </div>
          ) : (
            files.map((file, idx) => {
              const isExpanded = expanded === file.path;
              const fileResolved = resolved[file.path];
              const isResolving = resolving[file.path] ?? false;
              return (
                <div
                  key={file.path}
                  className={clsx(
                    'border rounded-xl overflow-hidden transition-all',
                    fileResolved ? 'border-emerald-200 bg-emerald-50/30' : 'border-red-200 bg-white',
                  )}
                >
                  <button
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors text-left"
                    onClick={() => setExpanded(isExpanded ? null : file.path)}
                  >
                    <span className="text-[10px] text-slate-400 font-mono shrink-0 w-4">{idx + 1}</span>
                    {fileResolved
                      ? <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />
                      : <AlertTriangle size={14} className="text-red-500 shrink-0" />}
                    <span className="flex-1 text-xs font-mono text-slate-700 truncate">{file.path}</span>
                    {fileResolved && (
                      <span className="text-[9px] px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full font-medium shrink-0">
                        {fileResolved === 'manual' ? 'Manual' : fileResolved === 'ours' ? 'Accepted Ours' : 'Accepted Theirs'}
                      </span>
                    )}
                    {isExpanded
                      ? <ChevronDown size={13} className="text-slate-400 shrink-0" />
                      : <ChevronRight size={13} className="text-slate-400 shrink-0" />}
                  </button>

                  {isExpanded && (
                    <div className="border-t border-slate-200">
                      {file.oursContent || file.theirsContent ? (
                        <div className="grid grid-cols-2 divide-x divide-slate-200">
                          <div className="bg-emerald-50/40">
                            <div className="px-3 py-2 bg-emerald-50 border-b border-emerald-200">
                              <span className="text-[10px] font-semibold text-emerald-700 uppercase tracking-wider">Ours (HEAD)</span>
                            </div>
                            <pre className="text-[10px] font-mono text-slate-700 p-3 overflow-x-auto max-h-52 leading-relaxed whitespace-pre-wrap break-all">
                              {file.oursContent || '(empty)'}
                            </pre>
                          </div>
                          <div className="bg-sky-50/40">
                            <div className="px-3 py-2 bg-sky-50 border-b border-sky-200">
                              <span className="text-[10px] font-semibold text-sky-700 uppercase tracking-wider">Theirs (incoming)</span>
                            </div>
                            <pre className="text-[10px] font-mono text-slate-700 p-3 overflow-x-auto max-h-52 leading-relaxed whitespace-pre-wrap break-all">
                              {file.theirsContent || '(empty)'}
                            </pre>
                          </div>
                        </div>
                      ) : (
                        <div className="px-4 py-3 text-xs text-slate-400 italic">
                          Open the file in your editor to see conflict markers.
                        </div>
                      )}
                      <div className="flex items-center gap-2 px-4 py-3 bg-slate-50 border-t border-slate-200 flex-wrap">
                        <button
                          onClick={() => { void handleResolve(file.path, 'ours'); }}
                          disabled={isResolving || !!fileResolved}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg disabled:opacity-50 transition-colors"
                        >
                          {isResolving ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
                          Accept Ours
                        </button>
                        <button
                          onClick={() => { void handleResolve(file.path, 'theirs'); }}
                          disabled={isResolving || !!fileResolved}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-sky-600 hover:bg-sky-700 text-white rounded-lg disabled:opacity-50 transition-colors"
                        >
                          {isResolving ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
                          Accept Theirs
                        </button>
                        <button
                          onClick={handleOpenTerminal}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-600 hover:text-slate-800 bg-white border border-slate-200 hover:border-slate-300 rounded-lg transition-colors"
                        >
                          <TerminalSquare size={11} />
                          Open Terminal
                        </button>
                        {!fileResolved && (
                          <button
                            onClick={() => handleMarkManual(file.path)}
                            className="ml-auto text-[10px] text-slate-400 hover:text-slate-600 underline transition-colors"
                          >
                            Mark as manually resolved
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}

          {error && (
            <div className="flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
              <AlertCircle size={12} />
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-200 bg-slate-50 shrink-0">
          <button
            onClick={() => { void handleAbort(); }}
            disabled={aborting || finalizing}
            className="flex items-center gap-2 px-4 py-2 text-xs font-medium text-red-600 hover:text-red-700 hover:bg-red-50 border border-red-200 rounded-lg disabled:opacity-50 transition-colors"
          >
            {aborting ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
            Abort Merge
          </button>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-400">
              {allResolved ? 'All resolved — ready to finalize' : `${totalFiles - resolvedCount} remaining`}
            </span>
            <button
              onClick={() => { void handleFinalize(); }}
              disabled={!allResolved || finalizing || aborting}
              className="flex items-center gap-2 px-4 py-2 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-40 transition-colors"
            >
              {finalizing ? <Loader2 size={11} className="animate-spin" /> : <GitMerge size={11} />}
              Finalize Merge
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Shared UI helpers ─────────────────────────────────────────────────────────

function PanelSection({
  title, icon, children, collapsible = false, open = true, onToggle,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <button
        className={clsx(
          'w-full flex items-center gap-2 px-4 py-2.5 text-left',
          collapsible ? 'hover:bg-slate-50 transition-colors cursor-pointer' : 'cursor-default',
        )}
        onClick={collapsible ? onToggle : undefined}
        disabled={!collapsible}
      >
        {icon && <span className="text-slate-400">{icon}</span>}
        <span className="flex-1 text-xs font-semibold text-slate-700">{title}</span>
        {collapsible && (
          open
            ? <ChevronDown size={13} className="text-slate-400" />
            : <ChevronRight size={13} className="text-slate-400" />
        )}
      </button>
      {(!collapsible || open) && (
        <div className="px-4 pb-3 pt-1 border-t border-slate-100">
          {children}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4">
      <div className="w-16 h-16 rounded-2xl bg-violet-50 border border-violet-100 flex items-center justify-center">
        <FolderGit2 size={28} className="text-violet-400" />
      </div>
      <div className="text-center">
        <div className="text-slate-700 font-medium mb-1">No projects yet</div>
        <div className="text-sm text-slate-400">Add a repository from your local machine to get started</div>
      </div>
      <button
        onClick={onAdd}
        className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium rounded-xl transition-colors"
      >
        <Plus size={14} />
        Add Repository
      </button>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="bg-slate-50 rounded-lg py-2">
      <div className={clsx('text-sm font-bold font-mono', color)}>{value}</div>
      <div className="text-[9px] text-slate-400 uppercase tracking-wide">{label}</div>
    </div>
  );
}
