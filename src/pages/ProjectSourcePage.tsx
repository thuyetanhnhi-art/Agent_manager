import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  FolderGit2, GitBranch, RefreshCw, Download, AlertTriangle,
  CheckCircle2, AlertCircle, Loader2, TerminalSquare, Layers,
  GitMerge, GitPullRequest, Circle, ExternalLink, ChevronRight,
  ChevronDown, ArrowUp, ArrowDown, X, GitCommit, KeyRound,
  ScanLine, Inbox, Plus, GitFork,
} from 'lucide-react';
import clsx from 'clsx';
import { useProjectStore } from '../projectStore';
import { useStore } from '../store';
import { Header } from '../components/Header';
import { STATUS_META, type Task, type TaskStatus } from '../types';
import { formatRelative } from '../utils';
import {
  fetchGitlabConfig, pullMain, fetchRepoGitStatus, fetchRepoGitStatusBatch, scanGitRepos,
  fetchConflictDetails, resolveConflictFile, finalizeConflictResolution,
  abortMerge, fetchProjectMRs, fetchProjectPipeline, fetchProjectMRsBatch, retryPipeline,
  openExternalTerminal, createBranch, checkoutBranch, mergeBranch,
  type RepoGitStatusResult, type ConflictFile, type GitlabMRInfo,
  type PipelineInfo, type ScannedRepo,
} from '../services/api';

type PullState = 'idle' | 'loading' | 'ok' | 'err';

const STATUS_BADGE: Record<string, { label: string; dot: string; text: string; bg: string; border: string }> = {
  clean:    { label: 'Up to date', dot: 'bg-emerald-400', text: 'text-emerald-700', bg: 'bg-emerald-50',  border: 'border-emerald-200' },
  behind:   { label: 'Behind',     dot: 'bg-sky-400',     text: 'text-sky-700',     bg: 'bg-sky-50',      border: 'border-sky-200' },
  ahead:    { label: 'Ahead',      dot: 'bg-amber-400',   text: 'text-amber-700',   bg: 'bg-amber-50',    border: 'border-amber-200' },
  diverged: { label: 'Diverged',   dot: 'bg-purple-400',  text: 'text-purple-700',  bg: 'bg-purple-50',   border: 'border-purple-200' },
  conflict: { label: 'Conflict',   dot: 'bg-red-500',     text: 'text-red-700',     bg: 'bg-red-50',      border: 'border-red-200' },
  unknown:  { label: 'Unknown',    dot: 'bg-slate-300',   text: 'text-slate-500',   bg: 'bg-slate-50',    border: 'border-slate-200' },
};

const PIPELINE_META: Record<string, { color: string; bg: string }> = {
  success:  { color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' },
  failed:   { color: 'text-red-700',     bg: 'bg-red-50 border-red-200' },
  running:  { color: 'text-sky-700',     bg: 'bg-sky-50 border-sky-200' },
  pending:  { color: 'text-amber-700',   bg: 'bg-amber-50 border-amber-200' },
  canceled: { color: 'text-slate-600',   bg: 'bg-slate-50 border-slate-200' },
};

// ── Page ─────────────────────────────────────────────────────────────────────

export function ProjectSourcePage() {
  const { id } = useParams<{ id: string }>();
  const { projects, setActiveProject } = useProjectStore();
  const { tasks } = useStore();
  const navigate = useNavigate();

  const project = id ? projects[id] : undefined;

  const [repos, setRepos] = useState<ScannedRepo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [statuses, setStatuses] = useState<Record<string, RepoGitStatusResult>>({});
  const [loadingStatus, setLoadingStatus] = useState<Record<string, boolean>>({});
  const [pullStates, setPullStates] = useState<Record<string, PullState>>({});
  const [pullMsgs, setPullMsgs] = useState<Record<string, string>>({});
  const [drawerPath, setDrawerPath] = useState<string | null>(null);
  const [gitlabHasToken, setGitlabHasToken] = useState(false);
  const [pageTab, setPageTab] = useState<'sources' | 'mrs'>('sources');
  const [allMRs, setAllMRs] = useState<Array<GitlabMRInfo & { repoName: string }>>([]);
  const [repoPipelines, setRepoPipelines] = useState<Array<{ repoPath: string; repoName: string; pipelines: PipelineInfo[] }>>([]);
  const [loadingMRs, setLoadingMRs] = useState(false);
  const [mrLoadError, setMrLoadError] = useState('');
  const [retryingPipeline, setRetryingPipeline] = useState<number | null>(null);

  useEffect(() => {
    fetchGitlabConfig().then(c => setGitlabHasToken(c.hasToken)).catch(() => {});
  }, []);

  // Fetch MRs + pipelines only when user opens the MR tab — single batch call
  const loadMRs = useCallback(() => {
    if (!gitlabHasToken || repos.length === 0) return;
    setLoadingMRs(true);
    setMrLoadError('');
    const pathToName = Object.fromEntries(repos.map(r => [r.path, r.name]));
    fetchProjectMRsBatch(repos.map(r => r.path)).then(res => {
      if (!res.ok) {
        setMrLoadError(res.error ?? 'Failed to load MRs');
        setLoadingMRs(false);
        return;
      }
      if (res.results) {
        const flat = res.results.flatMap(r =>
          r.mrs.map(mr => ({ ...mr, repoName: pathToName[r.repoPath] ?? r.repoPath })),
        ).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        setAllMRs(flat);
        setRepoPipelines(
          res.results
            .filter(r => r.pipelines.length > 0)
            .map(r => ({ repoPath: r.repoPath, repoName: pathToName[r.repoPath] ?? r.repoPath, pipelines: r.pipelines })),
        );
      }
      setLoadingMRs(false);
    }).catch(e => { setMrLoadError(String(e)); setLoadingMRs(false); });
  }, [gitlabHasToken, repos]);

  useEffect(() => {
    if (pageTab !== 'mrs') return;
    loadMRs();
  }, [pageTab, loadMRs]);

  const handleRetryPipeline = async (repoPath: string, pipelineId: number) => {
    setRetryingPipeline(pipelineId);
    const res = await retryPipeline(repoPath, pipelineId);
    setRetryingPipeline(null);
    if (res.ok && res.pipeline) {
      setRepoPipelines(prev => prev.map(r => {
        if (r.repoPath !== repoPath) return r;
        return { ...r, pipelines: r.pipelines.map(p => p.id === pipelineId ? { ...res.pipeline! } : p) };
      }));
    }
  };

  // Sync sidebar active state with current URL
  useEffect(() => {
    if (id) setActiveProject(id);
  }, [id, setActiveProject]);

  const fetchStatus = useCallback(async (repoPath: string) => {
    setLoadingStatus(s => ({ ...s, [repoPath]: true }));
    const result = await fetchRepoGitStatus(repoPath);
    setStatuses(s => ({ ...s, [repoPath]: result }));
    setLoadingStatus(s => ({ ...s, [repoPath]: false }));
  }, []);

  const doScan = useCallback(async (rootPath: string) => {
    setScanning(true);
    setScanError('');
    setRepos([]);
    setStatuses({});
    const result = await scanGitRepos(rootPath);
    if (result.ok && result.repos) {
      setRepos(result.repos);
      // Single batch request for all repos instead of N individual calls
      const paths = result.repos.map(r => r.path);
      setLoadingStatus(Object.fromEntries(paths.map(p => [p, true])));
      const batch = await fetchRepoGitStatusBatch(paths);
      if (batch.ok && batch.statuses) {
        setStatuses(batch.statuses as Record<string, RepoGitStatusResult>);
      }
      setLoadingStatus({});
    } else {
      setScanError(result.error ?? 'Scan failed');
    }
    setScanning(false);
  }, []);

  useEffect(() => {
    if (project?.repoPath) void doScan(project.repoPath);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const handlePull = async (repoPath: string) => {
    setPullStates(s => ({ ...s, [repoPath]: 'loading' }));
    setPullMsgs(s => ({ ...s, [repoPath]: '' }));
    try {
      const result = await pullMain(repoPath);
      setPullStates(s => ({ ...s, [repoPath]: result.ok ? 'ok' : 'err' }));
      setPullMsgs(s => ({ ...s, [repoPath]: result.ok ? (result.output ?? 'Done') : (result.error ?? 'Failed') }));
      if (result.ok) void fetchStatus(repoPath);
    } catch {
      setPullStates(s => ({ ...s, [repoPath]: 'err' }));
      setPullMsgs(s => ({ ...s, [repoPath]: 'Network error' }));
    }
    setTimeout(() => setPullStates(s => ({ ...s, [repoPath]: 'idle' })), 6000);
  };

  const handlePullAll = async () => {
    for (const r of repos) await handlePull(r.path);
  };

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-400">
        <div className="text-center">
          <FolderGit2 size={32} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">Project not found</p>
          <button onClick={() => navigate('/tasks')} className="mt-3 text-xs text-violet-600 hover:underline">
            Back to tasks
          </button>
        </div>
      </div>
    );
  }

  const projectTasks = project.taskIds.map(tid => tasks[tid]).filter(Boolean) as Task[];
  const drawerRepo = drawerPath ? repos.find(r => r.path === drawerPath) : null;
  const conflictCount = repos.filter(r => statuses[r.path]?.status === 'conflict').length;

  return (
    <div className="flex-1 overflow-y-auto bg-base">
      <Header
        title={project.name}
        subtitle={project.repoPath}
      />

      <div className="px-6 py-4 space-y-5">

        {/* ── Toolbar ── */}
        <div className="flex items-center gap-3 flex-wrap">
          {pageTab === 'sources' && (
            <button
              onClick={() => void doScan(project.repoPath)}
              disabled={scanning}
              className="flex items-center gap-2 px-3 py-2 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors disabled:opacity-60"
            >
              {scanning
                ? <Loader2 size={13} className="animate-spin" />
                : <ScanLine size={13} />}
              {scanning ? 'Scanning…' : 'Scan Sources'}
            </button>
          )}

          {pageTab === 'mrs' && (
            <button
              onClick={loadMRs}
              disabled={loadingMRs}
              className="flex items-center gap-2 px-3 py-2 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors disabled:opacity-60"
            >
              {loadingMRs ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              {loadingMRs ? 'Loading…' : 'Refresh MR'}
            </button>
          )}

          {repos.length > 0 && pageTab === 'sources' && (
            <button
              onClick={() => void handlePullAll()}
              className="flex items-center gap-2 px-3 py-2 text-xs font-medium bg-sky-600 hover:bg-sky-700 text-white rounded-lg transition-colors"
            >
              <Download size={13} />
              Pull All ({repos.length})
            </button>
          )}

          {conflictCount > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 font-medium">
              <AlertTriangle size={13} />
              {conflictCount} conflict{conflictCount > 1 ? 's' : ''}
            </div>
          )}

          {/* Tab switcher */}
          <div className="ml-auto flex items-center bg-slate-100 rounded-xl p-0.5">
            <button
              onClick={() => setPageTab('sources')}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors',
                pageTab === 'sources' ? 'bg-white text-slate-800 font-medium shadow-sm' : 'text-slate-500 hover:text-slate-700',
              )}
            >
              <Layers size={11} /> Sources
              {repos.length > 0 && <span className="text-[10px] font-mono">{repos.length}</span>}
            </button>
            <button
              onClick={() => setPageTab('mrs')}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors',
                pageTab === 'mrs' ? 'bg-white text-slate-800 font-medium shadow-sm' : 'text-slate-500 hover:text-slate-700',
              )}
            >
              <GitPullRequest size={11} /> Merge Requests
              {allMRs.length > 0 && (
                <span className="text-[10px] font-mono px-1 py-0.5 bg-violet-100 text-violet-700 rounded">{allMRs.length}</span>
              )}
            </button>
          </div>
        </div>

        {/* ── MR Tab ── */}
        {pageTab === 'mrs' && (
          <MRListView
            mrs={allMRs}
            repoPipelines={repoPipelines}
            loading={loadingMRs}
            loadError={mrLoadError}
            hasToken={gitlabHasToken}
            repoCount={repos.length}
            retryingPipeline={retryingPipeline}
            onRetryPipeline={handleRetryPipeline}
          />
        )}

        {/* ── Sources list + Tasks (only in 'sources' tab) ── */}
        {pageTab === 'sources' && <>
        <section>
          <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Layers size={11} className="text-violet-400" />
            Git Sources
            {repos.length > 0 && (
              <span className="text-[10px] font-normal normal-case tracking-normal text-slate-400">
                — {repos.length} repo{repos.length !== 1 ? 's' : ''} found
              </span>
            )}
          </h2>

          {scanning && repos.length === 0 && (
            <div className="flex items-center gap-3 py-8 justify-center text-slate-400">
              <Loader2 size={18} className="animate-spin" />
              <span className="text-sm">Scanning for git repositories…</span>
            </div>
          )}

          {!scanning && scanError && (
            <div className="flex items-center gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
              <AlertCircle size={16} className="shrink-0" />
              <div>
                <div className="font-medium">Scan failed</div>
                <div className="text-xs text-red-600 mt-0.5">{scanError}</div>
                <div className="text-xs text-red-500 mt-1">
                  Backend endpoint <code className="font-mono bg-red-100 px-1 rounded">/api/git/scan</code> required.
                </div>
              </div>
            </div>
          )}

          {!scanning && !scanError && repos.length === 0 && (
            <div className="flex flex-col items-center py-10 text-slate-400 gap-3">
              <Inbox size={28} className="opacity-40" />
              <span className="text-sm">No git repositories found in this project folder.</span>
            </div>
          )}

          {repos.length > 0 && (
            <div className="space-y-2">
              {repos.map(repo => {
                const st = statuses[repo.path];
                const loading = loadingStatus[repo.path] ?? false;
                const pullState = pullStates[repo.path] ?? 'idle';
                const pullMsg = pullMsgs[repo.path] ?? '';
                const gitStatus = st?.status ?? 'unknown';
                const badge = STATUS_BADGE[gitStatus] ?? STATUS_BADGE.unknown;
                const hasConflict = gitStatus === 'conflict' || (st?.conflictFiles?.length ?? 0) > 0;
                const isActive = drawerPath === repo.path;

                return (
                  <div
                    key={repo.path}
                    className={clsx(
                      'bg-white border rounded-xl px-4 py-3 flex items-center gap-4 transition-all',
                      isActive ? 'border-violet-300 shadow-sm shadow-violet-100' : 'border-slate-200 hover:border-slate-300',
                    )}
                  >
                    {/* Icon */}
                    <div className="w-8 h-8 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-center shrink-0 relative">
                      <FolderGit2 size={15} className="text-slate-500" />
                      {hasConflict && (
                        <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full flex items-center justify-center">
                          <AlertTriangle size={7} className="text-white" />
                        </span>
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-slate-800 truncate">{repo.name}</div>
                      <div className="text-[10px] text-slate-400 font-mono truncate mt-0.5">{repo.relativePath || repo.path}</div>
                    </div>

                    {/* Git status badge */}
                    <div className="flex items-center gap-2 shrink-0">
                      {st ? (
                        <div className={clsx('flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[10px] font-medium', badge.bg, badge.border, badge.text)}>
                          {loading
                            ? <Loader2 size={9} className="animate-spin" />
                            : <span className={clsx('w-1.5 h-1.5 rounded-full', badge.dot)} />}
                          {badge.label}
                          {(st.aheadCount ?? 0) > 0 && <span className="flex items-center gap-0.5"><ArrowUp size={8} />{st.aheadCount}</span>}
                          {(st.behindCount ?? 0) > 0 && <span className="flex items-center gap-0.5"><ArrowDown size={8} />{st.behindCount}</span>}
                        </div>
                      ) : loading ? (
                        <Loader2 size={13} className="animate-spin text-slate-300" />
                      ) : null}

                      {st?.branch && (
                        <div className="flex items-center gap-1 px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg text-[10px] text-slate-600 font-mono">
                          <GitBranch size={9} />
                          {st.branch}
                        </div>
                      )}
                    </div>

                    {/* Pull message */}
                    {pullMsg && pullState !== 'idle' && (
                      <div className={clsx('text-[10px] px-2 py-1 rounded-lg max-w-[140px] truncate',
                        pullState === 'ok' ? 'text-emerald-700 bg-emerald-50' : 'text-red-600 bg-red-50')}>
                        {pullMsg}
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => void handlePull(repo.path)}
                        disabled={pullState === 'loading'}
                        title="git pull"
                        className={clsx(
                          'p-1.5 rounded-lg transition-colors',
                          pullState === 'ok'      && 'text-emerald-600 bg-emerald-50',
                          pullState === 'err'     && 'text-red-500 bg-red-50',
                          pullState === 'loading' && 'text-sky-500',
                          pullState === 'idle'    && 'text-slate-400 hover:text-sky-600 hover:bg-sky-50',
                        )}
                      >
                        {pullState === 'loading' ? <RefreshCw size={14} className="animate-spin" /> :
                         pullState === 'ok'      ? <CheckCircle2 size={14} /> :
                         pullState === 'err'     ? <AlertCircle size={14} /> :
                         <Download size={14} />}
                      </button>

                      <button
                        onClick={() => setDrawerPath(isActive ? null : repo.path)}
                        title="Source Manager"
                        className={clsx(
                          'flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium rounded-lg border transition-colors',
                          isActive
                            ? 'bg-violet-600 border-violet-600 text-white'
                            : hasConflict
                            ? 'text-red-600 bg-red-50 border-red-200 hover:bg-red-100'
                            : 'text-violet-600 bg-violet-50 border-violet-200 hover:bg-violet-100',
                        )}
                      >
                        <Layers size={12} />
                        {hasConflict ? 'Conflict!' : 'Source'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Tasks ── */}
        {projectTasks.length > 0 && (
          <section>
            <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
              Tasks
              <span className="text-[10px] font-normal normal-case tracking-normal">— {projectTasks.length} total</span>
            </h2>
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              {projectTasks.map((task, i) => {
                const sMeta = STATUS_META[task.status as TaskStatus];
                return (
                  <div
                    key={task.id}
                    onClick={() => navigate(`/tasks/${task.id}`)}
                    className={clsx(
                      'flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 transition-colors',
                      i < projectTasks.length - 1 && 'border-b border-slate-100',
                    )}
                  >
                    <div className={clsx('w-2 h-2 rounded-full shrink-0', sMeta.dot)} />
                    <span className="flex-1 text-sm text-slate-700 truncate">{task.title}</span>
                    <span className={clsx('text-[10px] font-medium', sMeta.color)}>{sMeta.label}</span>
                    <ExternalLink size={11} className="text-slate-300 shrink-0" />
                  </div>
                );
              })}
            </div>
          </section>
        )}
        </>}
      </div>

      {/* ── Source Drawer ── */}
      {drawerPath && drawerRepo && (
        <SourceDrawer
          repoPath={drawerPath}
          repoName={drawerRepo.name}
          projectColor={project.color}
          status={statuses[drawerPath]}
          pullState={pullStates[drawerPath] ?? 'idle'}
          pullMsg={pullMsgs[drawerPath] ?? ''}
          gitlabHasToken={gitlabHasToken}
          onClose={() => setDrawerPath(null)}
          onPull={() => void handlePull(drawerPath)}
          onRefresh={() => void fetchStatus(drawerPath)}
        />
      )}

    </div>
  );
}

// ── MR List View ─────────────────────────────────────────────────────────────

const PIPELINE_STATUS_ICON: Record<string, string> = {
  success: '✓', failed: '✗', running: '▶', pending: '…', canceled: '—',
};

function MRListView({ mrs, repoPipelines, loading, loadError, hasToken, repoCount, retryingPipeline, onRetryPipeline }: {
  mrs: Array<GitlabMRInfo & { repoName: string }>;
  repoPipelines: Array<{ repoPath: string; repoName: string; pipelines: PipelineInfo[] }>;
  loading: boolean;
  loadError: string;
  hasToken: boolean;
  repoCount: number;
  retryingPipeline: number | null;
  onRetryPipeline: (repoPath: string, pipelineId: number) => void;
}) {
  const navigate = useNavigate();
  if (!hasToken) {
    return (
      <div className="flex items-start gap-3 px-4 py-5 bg-orange-50 border border-orange-200 rounded-xl">
        <KeyRound size={16} className="text-orange-500 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-orange-800">GitLab MCP chưa được kết nối</div>
          <div className="text-xs text-orange-600 mt-0.5">
            Vào <strong>MCP Servers</strong> → thêm server <strong>GitLab</strong> và điền <code className="font-mono bg-orange-100 px-1 rounded">GITLAB_PERSONAL_ACCESS_TOKEN</code> để xem MR & Pipeline.
          </div>
        </div>
        <button
          onClick={() => navigate('/mcp')}
          className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-orange-600 hover:bg-orange-700 text-white text-xs font-medium rounded-lg transition-colors"
        >
          Mở MCP
        </button>
      </div>
    );
  }

  if (repoCount === 0) {
    return (
      <div className="flex flex-col items-center py-10 text-slate-400 gap-3">
        <GitPullRequest size={28} className="opacity-30" />
        <span className="text-sm">Scan sources first to load merge requests.</span>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-3 py-10 justify-center text-slate-400">
        <Loader2 size={18} className="animate-spin" />
        <span className="text-sm">Loading merge requests…</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex items-start gap-3 px-4 py-4 bg-red-50 border border-red-200 rounded-xl">
        <AlertCircle size={15} className="text-red-500 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-red-800">Không tải được MR</div>
          <div className="text-xs text-red-600 mt-0.5 font-mono break-all">{loadError}</div>
        </div>
      </div>
    );
  }

  if (mrs.length === 0 && repoPipelines.length === 0) {
    return (
      <div className="flex flex-col items-center py-10 text-slate-400 gap-3">
        <GitPullRequest size={28} className="opacity-30" />
        <span className="text-sm">No open merge requests across all repos.</span>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── MR list ── */}
      <div className="space-y-2">
        <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
          <GitPullRequest size={11} className="text-violet-400" />
          Merge Requests
          <span className="text-[10px] font-normal normal-case tracking-normal text-slate-400">
            — {mrs.length} open across {repoCount} repo{repoCount !== 1 ? 's' : ''}
          </span>
        </div>

        {mrs.length === 0 && (
          <div className="flex flex-col items-center py-6 text-slate-400 gap-2">
            <GitPullRequest size={22} className="opacity-30" />
            <span className="text-sm">No open merge requests</span>
          </div>
        )}

        {mrs.map(mr => {
          const initials = mr.author
            .split(/[\s.@_-]+/).filter(Boolean)
            .map((p: string) => p[0]).join('').slice(0, 2).toUpperCase();

          return (
            <a
              key={`${mr.repoName}-${mr.id}`}
              href={mr.webUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-start gap-3 px-4 py-3 bg-white border border-slate-200 rounded-xl hover:border-violet-200 hover:shadow-sm transition-all"
            >
              <span className={clsx(
                'text-[9px] px-1.5 py-0.5 rounded-md font-semibold shrink-0 mt-0.5',
                mr.state === 'merged' ? 'bg-purple-100 text-purple-700' :
                mr.draft ? 'bg-slate-100 text-slate-500' : 'bg-emerald-100 text-emerald-700',
              )}>
                {mr.state === 'merged' ? 'Merged' : mr.draft ? 'Draft' : 'Open'}
              </span>

              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-slate-800 truncate">{mr.title}</div>
                <div className="flex items-center gap-1.5 mt-1 text-[10px] text-slate-400 font-mono flex-wrap">
                  <span className="px-1.5 py-0.5 bg-slate-100 rounded text-slate-600">{mr.repoName}</span>
                  <GitBranch size={8} />
                  <span className="truncate max-w-[100px]">{mr.sourceBranch}</span>
                  <ChevronRight size={8} />
                  <span>{mr.targetBranch}</span>
                </div>
              </div>

              <div className="flex flex-col items-end gap-1.5 shrink-0">
                <div className="flex items-center gap-1.5">
                  <div className="w-6 h-6 rounded-full bg-violet-100 text-violet-700 flex items-center justify-center text-[9px] font-bold" title={mr.author}>
                    {initials}
                  </div>
                  <span className="text-[10px] text-slate-600 max-w-[80px] truncate">{mr.author}</span>
                </div>
                <span className="text-[9px] text-slate-400">{formatRelative(new Date(mr.updatedAt))}</span>
                <ExternalLink size={9} className="text-slate-300" />
              </div>
            </a>
          );
        })}
      </div>

      {/* ── Pipeline list per repo ── */}
      {repoPipelines.length > 0 && (
        <div className="space-y-3">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
            <Circle size={11} className="text-violet-400" />
            Pipelines
          </div>

          {repoPipelines.map(({ repoPath, repoName, pipelines }) => (
            <div key={repoPath} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 flex items-center gap-2">
                <FolderGit2 size={11} className="text-slate-400 shrink-0" />
                <span className="text-[11px] font-semibold text-slate-700">{repoName}</span>
              </div>
              <div className="divide-y divide-slate-50">
                {pipelines.map(pl => {
                  const pMeta = PIPELINE_META[pl.status];
                  const canRetry = pl.status === 'failed' || pl.status === 'canceled';
                  const isRetrying = retryingPipeline === pl.id;
                  return (
                    <div key={pl.id} className="flex items-center gap-3 px-4 py-2.5">
                      <span className={clsx(
                        'text-[10px] px-2 py-0.5 rounded-md font-semibold capitalize border shrink-0',
                        pMeta?.bg ?? 'bg-slate-50 border-slate-200',
                        pMeta?.color ?? 'text-slate-500',
                      )}>
                        {PIPELINE_STATUS_ICON[pl.status] ?? '?'} {pl.status}
                      </span>
                      <span className="text-[10px] font-mono text-slate-500 truncate flex-1">{pl.ref}</span>
                      <span className="text-[9px] text-slate-400 shrink-0">{formatRelative(new Date(pl.updatedAt))}</span>
                      {canRetry && (
                        <button
                          onClick={() => onRetryPipeline(repoPath, pl.id)}
                          disabled={isRetrying || retryingPipeline !== null}
                          title="Retry pipeline"
                          className="shrink-0 flex items-center gap-1 px-2 py-1 text-[9px] font-medium text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 rounded-md transition-colors disabled:opacity-40"
                        >
                          {isRetrying ? <Loader2 size={9} className="animate-spin" /> : <RefreshCw size={9} />}
                          Retry
                        </button>
                      )}
                      <a
                        href={pl.webUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={e => e.stopPropagation()}
                        className="shrink-0 text-slate-300 hover:text-slate-500 transition-colors"
                      >
                        <ExternalLink size={10} />
                      </a>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Source Drawer ─────────────────────────────────────────────────────────────

interface DrawerProps {
  repoPath: string;
  repoName: string;
  projectColor: string;
  status: RepoGitStatusResult | undefined;
  pullState: PullState;
  pullMsg: string;
  gitlabHasToken: boolean;
  onClose: () => void;
  onPull: () => void;
  onRefresh: () => void;
}

function SourceDrawer(props: DrawerProps) {
  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-900/20 backdrop-blur-[1px]" onClick={props.onClose} />
      <div className="fixed right-0 top-0 h-full z-50 w-[460px] max-w-[95vw] flex flex-col bg-white border-l border-slate-200 shadow-2xl">
        <DrawerContent {...props} />
      </div>
    </>
  );
}

function DrawerContent({ repoPath, repoName, projectColor, status, pullState, pullMsg, gitlabHasToken, onClose, onPull, onRefresh }: DrawerProps) {
  const [mrs, setMrs] = useState<GitlabMRInfo[]>([]);
  const [pipeline, setPipeline] = useState<PipelineInfo | null>(null);
  const [loadingGitlab, setLoadingGitlab] = useState(false);
  const [showConflictModal, setShowConflictModal] = useState(false);
  // Branch management state
  const [checkingOut, setCheckingOut] = useState<string | null>(null);
  const [merging, setMerging] = useState<string | null>(null);
  const [mergeResult, setMergeResult] = useState<{ branch: string; ok: boolean; hasConflict: boolean; output: string } | null>(null);
  const [showNewBranch, setShowNewBranch] = useState(false);
  const [newBranch, setNewBranch] = useState('');
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [branchError, setBranchError] = useState('');

  useEffect(() => {
    if (gitlabHasToken) {
      setLoadingGitlab(true);
      Promise.all([fetchProjectMRs(repoPath), fetchProjectPipeline(repoPath)])
        .then(([mrsRes, plRes]) => {
          if (mrsRes.ok) setMrs(mrsRes.mrs ?? []);
          if (plRes.ok && plRes.pipeline) setPipeline(plRes.pipeline);
        })
        .finally(() => setLoadingGitlab(false));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, gitlabHasToken]);

  const handleCheckout = async (branch: string) => {
    setCheckingOut(branch);
    setBranchError('');
    setMergeResult(null);
    const r = await checkoutBranch(repoPath, branch);
    setCheckingOut(null);
    if (r.ok) onRefresh();
    else setBranchError(r.error ?? 'Checkout failed');
  };

  const handleMerge = async (branch: string) => {
    setMerging(branch);
    setBranchError('');
    setMergeResult(null);
    const r = await mergeBranch(repoPath, branch);
    setMerging(null);
    setMergeResult({ branch, ok: r.ok, hasConflict: r.hasConflict ?? false, output: r.output ?? r.error ?? '' });
    if (r.ok) onRefresh();
    else if (!r.hasConflict) setBranchError(r.error ?? 'Merge failed');
  };

  const handleCreateBranch = async () => {
    const name = newBranch.trim().replace(/\s+/g, '-');
    if (!name) return;
    setCreatingBranch(true);
    setBranchError('');
    const r = await createBranch(repoPath, status?.branch ?? 'main', name);
    setCreatingBranch(false);
    if (r.ok) { setNewBranch(''); setShowNewBranch(false); onRefresh(); }
    else setBranchError(r.error ?? 'Failed to create branch');
  };

  const gitStatus = status?.status ?? 'unknown';
  const badge = STATUS_BADGE[gitStatus] ?? STATUS_BADGE.unknown;
  const conflictFiles = status?.conflictFiles ?? [];
  const hasConflicts = gitStatus === 'conflict' || conflictFiles.length > 0;
  const branches = status?.branches ?? [];

  return (
    <>
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-200 shrink-0">
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: `${projectColor}18`, border: `1.5px solid ${projectColor}30` }}
        >
          <FolderGit2 size={16} style={{ color: projectColor }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-800 truncate">{repoName}</div>
          <div className="text-[10px] text-slate-400 font-mono truncate mt-0.5">{repoPath}</div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {(
            <button
              onClick={onPull}
              disabled={pullState === 'loading'}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors',
                pullState === 'ok'      && 'bg-emerald-50 border-emerald-200 text-emerald-700',
                pullState === 'err'     && 'bg-red-50 border-red-200 text-red-700',
                pullState === 'loading' && 'bg-sky-50 border-sky-200 text-sky-700',
                pullState === 'idle'    && 'bg-sky-600 border-sky-600 text-white hover:bg-sky-700',
              )}
            >
              {pullState === 'loading' ? <RefreshCw size={12} className="animate-spin" /> :
               pullState === 'ok'      ? <CheckCircle2 size={12} /> :
               pullState === 'err'     ? <AlertCircle size={12} /> :
               <Download size={12} />}
              {pullState === 'loading' ? 'Pulling…' : pullState === 'ok' ? 'Updated' : pullState === 'err' ? 'Failed' : 'Pull'}
            </button>
          )}
          <button onClick={onRefresh} title="Refresh" className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
            <RefreshCw size={14} />
          </button>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 bg-slate-50/40">

        {/* Git status */}
        <PanelSection title="Repository" icon={<FolderGit2 size={13} />}>
          <div className="space-y-2">
            {status && (
              <div className="flex items-center gap-2 flex-wrap">
                {status.branch && (
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg">
                    <GitBranch size={11} className="text-slate-400" />
                    <span className="text-xs font-mono text-slate-700">{status.branch}</span>
                  </div>
                )}
                <div className={clsx('flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border', badge.bg, badge.border)}>
                  <span className={clsx('w-1.5 h-1.5 rounded-full', badge.dot)} />
                  <span className={clsx('text-xs font-medium', badge.text)}>{badge.label}</span>
                  {(status.aheadCount ?? 0) > 0 && <span className={clsx('flex items-center gap-0.5 text-[10px]', badge.text)}><ArrowUp size={9} />{status.aheadCount}</span>}
                  {(status.behindCount ?? 0) > 0 && <span className={clsx('flex items-center gap-0.5 text-[10px]', badge.text)}><ArrowDown size={9} />{status.behindCount}</span>}
                </div>
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
                pullState === 'ok' ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-red-600 bg-red-50 border-red-200')}>
                {pullMsg}
              </div>
            )}
          </div>
        </PanelSection>

        {/* Conflict alert */}
        {hasConflicts && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-7 h-7 bg-red-100 rounded-lg flex items-center justify-center shrink-0">
                <AlertTriangle size={14} className="text-red-600" />
              </div>
              <div>
                <div className="text-sm font-semibold text-red-800">Merge Conflict Detected</div>
                <div className="text-[10px] text-red-600">
                  {conflictFiles.length > 0 ? `${conflictFiles.length} file${conflictFiles.length > 1 ? 's' : ''} need resolution` : 'Files need resolution'}
                </div>
              </div>
            </div>
            {conflictFiles.slice(0, 5).map(f => (
              <div key={f} className="flex items-center gap-2 px-2 py-1.5 bg-white/70 rounded-lg mb-1">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                <span className="text-[10px] font-mono text-red-700 truncate">{f}</span>
              </div>
            ))}
            {conflictFiles.length > 5 && <div className="text-[10px] text-red-600 px-2 mb-2">+{conflictFiles.length - 5} more…</div>}
            <button
              onClick={() => setShowConflictModal(true)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-lg transition-colors mt-2"
            >
              <GitMerge size={13} />
              Resolve Conflicts
            </button>
          </div>
        )}

        {/* Branches */}
        <PanelSection title={`Branches${branches.length > 0 ? ` (${branches.length})` : ''}`} icon={<GitBranch size={13} />}>
          <div className="space-y-1.5">
            {branches.length === 0 && !status && (
              <div className="text-xs text-slate-400 py-1">Loading…</div>
            )}

            {branches.map(b => {
              const isCurrent = b === status?.branch;
              const isCheckingOut = checkingOut === b;
              const isMerging = merging === b;
              const busy = !!checkingOut || !!merging || creatingBranch;
              return (
                <div key={b} className={clsx(
                  'flex items-center gap-2 px-2.5 py-2 rounded-lg border transition-colors',
                  isCurrent ? 'bg-violet-50 border-violet-200' : 'bg-white border-slate-200 hover:border-slate-300',
                )}>
                  <GitBranch size={9} className={isCurrent ? 'text-violet-500 shrink-0' : 'text-slate-400 shrink-0'} />
                  <span className={clsx('flex-1 text-[11px] font-mono truncate min-w-0', isCurrent ? 'text-violet-700 font-semibold' : 'text-slate-600')}>{b}</span>
                  {isCurrent && (
                    <span className="text-[9px] font-sans text-violet-500 font-medium shrink-0 px-1.5 py-0.5 bg-violet-100 rounded">current</span>
                  )}
                  {!isCurrent && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => void handleCheckout(b)}
                        disabled={busy}
                        title={`Checkout ${b}`}
                        className="text-[9px] px-2 py-0.5 text-slate-600 border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-40 transition-colors"
                      >
                        {isCheckingOut ? <Loader2 size={9} className="animate-spin" /> : 'Checkout'}
                      </button>
                      <button
                        onClick={() => void handleMerge(b)}
                        disabled={busy}
                        title={`Merge ${b} → ${status?.branch ?? 'current'}`}
                        className="text-[9px] px-2 py-0.5 text-amber-700 bg-amber-50 border border-amber-200 rounded-md hover:bg-amber-100 disabled:opacity-40 transition-colors flex items-center gap-1"
                      >
                        {isMerging ? <Loader2 size={9} className="animate-spin" /> : <><GitFork size={8} /> Merge</>}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Merge result */}
            {mergeResult && (
              <div className={clsx(
                'px-3 py-2.5 rounded-lg border text-[10px] space-y-1',
                mergeResult.hasConflict ? 'bg-red-50 border-red-200' :
                mergeResult.ok ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200',
              )}>
                <div className={clsx('font-semibold flex items-center gap-1.5',
                  mergeResult.hasConflict ? 'text-red-700' : mergeResult.ok ? 'text-emerald-700' : 'text-red-700')}>
                  {mergeResult.hasConflict ? <AlertTriangle size={11} /> : mergeResult.ok ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
                  {mergeResult.hasConflict ? `Conflict merging "${mergeResult.branch}"` :
                   mergeResult.ok ? `Merged "${mergeResult.branch}" ✓` : 'Merge failed'}
                </div>
                {mergeResult.output && (
                  <pre className="font-mono text-[9px] text-slate-600 whitespace-pre-wrap break-all leading-relaxed">{mergeResult.output.slice(0, 300)}</pre>
                )}
                <div className="flex items-center gap-2 pt-0.5">
                  {mergeResult.hasConflict && (
                    <button
                      onClick={() => { setMergeResult(null); setShowConflictModal(true); }}
                      className="text-[10px] text-red-700 font-medium underline"
                    >
                      Resolve Conflicts →
                    </button>
                  )}
                  <button onClick={() => setMergeResult(null)} className="text-[9px] text-slate-400 hover:text-slate-600 ml-auto">Dismiss</button>
                </div>
              </div>
            )}

            {/* Branch error */}
            {branchError && (
              <div className="flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-[10px] text-red-700">
                <AlertCircle size={11} />{branchError}
                <button onClick={() => setBranchError('')} className="ml-auto"><X size={10} /></button>
              </div>
            )}

            {/* Create new branch */}
            {showNewBranch ? (
              <div className="flex items-center gap-2 pt-0.5">
                <input
                  value={newBranch}
                  onChange={e => setNewBranch(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void handleCreateBranch(); if (e.key === 'Escape') { setShowNewBranch(false); setNewBranch(''); } }}
                  placeholder="feature/branch-name"
                  autoFocus
                  className="flex-1 text-[11px] font-mono bg-white border border-violet-300 focus:border-violet-500 rounded-lg px-2.5 py-1.5 outline-none min-w-0"
                />
                <button
                  onClick={() => void handleCreateBranch()}
                  disabled={!newBranch.trim() || creatingBranch}
                  className="shrink-0 text-[10px] px-2.5 py-1.5 bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-40 transition-colors"
                >
                  {creatingBranch ? <Loader2 size={11} className="animate-spin" /> : 'Create'}
                </button>
                <button onClick={() => { setShowNewBranch(false); setNewBranch(''); }} className="text-slate-400 hover:text-slate-600 shrink-0">
                  <X size={13} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowNewBranch(true)}
                className="flex items-center gap-1.5 text-[10px] text-violet-600 hover:text-violet-700 px-1 py-0.5 transition-colors"
              >
                <Plus size={11} /> New branch
              </button>
            )}
          </div>
        </PanelSection>

        {/* GitLab MRs + Pipeline inline */}
        {gitlabHasToken && (
          <PanelSection
            title={loadingGitlab ? 'Merge Requests' : `Merge Requests (${mrs.length})`}
            icon={<GitPullRequest size={13} />}
            extra={pipeline && !loadingGitlab ? (
              <a
                href={pipeline.webUrl}
                target="_blank"
                rel="noreferrer"
                onClick={e => e.stopPropagation()}
                className={clsx(
                  'flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[9px] font-semibold capitalize transition-colors hover:opacity-80',
                  PIPELINE_META[pipeline.status]?.bg ?? 'bg-slate-50 border-slate-200',
                  PIPELINE_META[pipeline.status]?.color ?? 'text-slate-500',
                )}
              >
                <Circle size={7} className="shrink-0" />
                {pipeline.status}
              </a>
            ) : undefined}
          >
            {loadingGitlab ? (
              <div className="flex items-center gap-2 text-xs text-slate-400 py-2"><Loader2 size={12} className="animate-spin" /> Loading…</div>
            ) : mrs.length === 0 ? (
              <div className="text-xs text-slate-400 py-1">No open merge requests</div>
            ) : (
              <div className="space-y-2">
                {mrs.map(mr => {
                  const initials = mr.author
                    .split(/[\s.@_-]+/).filter(Boolean)
                    .map((p: string) => p[0]).join('').slice(0, 2).toUpperCase();
                  return (
                    <a key={mr.id} href={mr.webUrl} target="_blank" rel="noreferrer"
                      className="block px-3 py-2.5 bg-white border border-slate-200 rounded-xl hover:border-violet-200 hover:shadow-sm transition-all"
                      onClick={e => e.stopPropagation()}
                    >
                      <div className="flex items-start gap-2">
                        {/* State badge */}
                        <span className={clsx(
                          'text-[9px] px-1.5 py-0.5 rounded font-medium shrink-0 mt-0.5',
                          mr.state === 'merged' ? 'bg-purple-100 text-purple-700' :
                          mr.draft ? 'bg-slate-100 text-slate-500' : 'bg-emerald-100 text-emerald-700',
                        )}>
                          {mr.state === 'merged' ? 'Merged' : mr.draft ? 'Draft' : 'Open'}
                        </span>

                        {/* Title + branch */}
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-slate-700 truncate">{mr.title}</div>
                          <div className="text-[9px] text-slate-400 mt-0.5 flex items-center gap-1 font-mono">
                            <GitBranch size={7} className="shrink-0" />
                            <span className="truncate">{mr.sourceBranch}</span>
                            <ChevronRight size={7} />
                            <span className="truncate">{mr.targetBranch}</span>
                          </div>
                        </div>

                        {/* Author avatar + time */}
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <div className="flex items-center gap-1">
                            <div
                              className="w-5 h-5 rounded-full bg-violet-100 text-violet-700 flex items-center justify-center text-[8px] font-bold shrink-0"
                              title={mr.author}
                            >
                              {initials}
                            </div>
                            <span className="text-[9px] text-slate-500 max-w-[70px] truncate">{mr.author}</span>
                          </div>
                          <span className="text-[9px] text-slate-400">{formatRelative(new Date(mr.updatedAt))}</span>
                        </div>
                      </div>
                    </a>
                  );
                })}
              </div>
            )}
          </PanelSection>
        )}

        {/* Pipeline detail (kept as standalone when no MRs) */}
        {gitlabHasToken && !loadingGitlab && pipeline && mrs.length === 0 && (
          <PanelSection title="Latest Pipeline" icon={<Circle size={13} />}>
            <a href={pipeline.webUrl} target="_blank" rel="noreferrer"
              className={clsx('flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all hover:shadow-sm', PIPELINE_META[pipeline.status]?.bg ?? 'bg-slate-50 border-slate-200')}
              onClick={e => e.stopPropagation()}
            >
              <div className="flex-1 min-w-0">
                <div className={clsx('text-xs font-semibold capitalize', PIPELINE_META[pipeline.status]?.color)}>{pipeline.status}</div>
                <div className="text-[9px] text-slate-400 font-mono truncate">{pipeline.ref}</div>
              </div>
              <div className="text-[9px] text-slate-400">{formatRelative(new Date(pipeline.updatedAt))}</div>
              <ExternalLink size={9} className="text-slate-400 shrink-0" />
            </a>
          </PanelSection>
        )}

        {!gitlabHasToken && (
          <div className="flex items-center gap-3 px-4 py-3 bg-orange-50 border border-orange-200 rounded-xl">
            <KeyRound size={14} className="text-orange-500 shrink-0" />
            <div>
              <div className="text-xs font-medium text-orange-800">GitLab MCP chưa kết nối</div>
              <div className="text-[10px] text-orange-600">Thêm GitLab server trong trang MCP Servers</div>
            </div>
          </div>
        )}
      </div>

      {showConflictModal && (
        <ConflictResolverModal
          repoName={repoName}
          repoPath={repoPath}
          initialConflictFiles={conflictFiles}
          onClose={() => setShowConflictModal(false)}
          onResolved={() => { setShowConflictModal(false); onRefresh(); }}
        />
      )}
    </>
  );
}

// ── Conflict Resolver Modal ───────────────────────────────────────────────────

function ConflictResolverModal({ repoName, repoPath, initialConflictFiles, onClose, onResolved }: {
  repoName: string; repoPath: string; initialConflictFiles: string[];
  onClose: () => void; onResolved: () => void;
}) {
  const [files, setFiles] = useState<ConflictFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [resolving, setResolving] = useState<Record<string, boolean>>({});
  const [resolved, setResolved] = useState<Record<string, 'ours' | 'theirs' | 'manual'>>({});
  const [finalizing, setFinalizing] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchConflictDetails(repoPath).then(res => {
      if (res.ok && res.files?.length) {
        setFiles(res.files);
        setExpanded(res.files[0].path);
      } else {
        setFiles(initialConflictFiles.map(p => ({ path: p, oursContent: '', theirsContent: '' })));
        if (initialConflictFiles.length) setExpanded(initialConflictFiles[0]);
      }
      setLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);

  const handleResolve = async (filePath: string, resolution: 'ours' | 'theirs') => {
    setResolving(s => ({ ...s, [filePath]: true }));
    const res = await resolveConflictFile(repoPath, filePath, resolution);
    setResolving(s => ({ ...s, [filePath]: false }));
    if (res.ok) setResolved(s => ({ ...s, [filePath]: resolution }));
    else setError(res.error ?? 'Failed');
  };

  const handleFinalize = async () => {
    setFinalizing(true);
    const res = await finalizeConflictResolution(repoPath);
    setFinalizing(false);
    if (res.ok) onResolved(); else setError(res.error ?? 'Failed to finalize');
  };

  const handleAbort = async () => {
    if (!confirm('Abort merge? Progress will be lost.')) return;
    setAborting(true);
    const res = await abortMerge(repoPath);
    setAborting(false);
    if (res.ok) onResolved(); else setError(res.error ?? 'Failed to abort');
  };

  const totalFiles = files.length;
  const resolvedCount = Object.keys(resolved).length;
  const allResolved = totalFiles > 0 && resolvedCount >= totalFiles;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl mx-4 flex flex-col overflow-hidden" style={{ maxHeight: '90vh' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-200 shrink-0">
          <div className="w-8 h-8 bg-red-100 rounded-xl flex items-center justify-center shrink-0">
            <GitMerge size={16} className="text-red-600" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-slate-800">Resolve Conflicts — {repoName}</div>
            <div className="text-[10px] text-slate-400">{loading ? 'Loading…' : `${resolvedCount} / ${totalFiles} resolved`}</div>
          </div>
          {!loading && totalFiles > 0 && (
            <div className="w-24 h-1.5 bg-slate-100 rounded-full overflow-hidden shrink-0">
              <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${(resolvedCount / totalFiles) * 100}%` }} />
            </div>
          )}
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {loading ? (
            <div className="flex items-center gap-3 py-8 justify-center">
              <Loader2 size={18} className="animate-spin text-slate-400" />
              <span className="text-sm text-slate-400">Loading conflict details…</span>
            </div>
          ) : files.map((file, idx) => {
            const isExpanded = expanded === file.path;
            const fileResolved = resolved[file.path];
            const isResolving = resolving[file.path] ?? false;
            return (
              <div key={file.path} className={clsx('border rounded-xl overflow-hidden', fileResolved ? 'border-emerald-200 bg-emerald-50/30' : 'border-red-200 bg-white')}>
                <button className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 text-left" onClick={() => setExpanded(isExpanded ? null : file.path)}>
                  <span className="text-[10px] text-slate-400 font-mono w-4">{idx + 1}</span>
                  {fileResolved ? <CheckCircle2 size={14} className="text-emerald-500 shrink-0" /> : <AlertTriangle size={14} className="text-red-500 shrink-0" />}
                  <span className="flex-1 text-xs font-mono text-slate-700 truncate">{file.path}</span>
                  {fileResolved && (
                    <span className="text-[9px] px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full font-medium shrink-0">
                      {fileResolved === 'manual' ? 'Manual' : fileResolved === 'ours' ? 'Accepted Ours' : 'Accepted Theirs'}
                    </span>
                  )}
                  {isExpanded ? <ChevronDown size={13} className="text-slate-400 shrink-0" /> : <ChevronRight size={13} className="text-slate-400 shrink-0" />}
                </button>
                {isExpanded && (
                  <div className="border-t border-slate-200">
                    {(file.oursContent || file.theirsContent) ? (
                      <div className="grid grid-cols-2 divide-x divide-slate-200">
                        <div className="bg-emerald-50/40">
                          <div className="px-3 py-2 bg-emerald-50 border-b border-emerald-200">
                            <span className="text-[10px] font-semibold text-emerald-700 uppercase tracking-wider">Ours (HEAD)</span>
                          </div>
                          <pre className="text-[10px] font-mono text-slate-700 p-3 overflow-x-auto max-h-48 whitespace-pre-wrap break-all">{file.oursContent || '(empty)'}</pre>
                        </div>
                        <div className="bg-sky-50/40">
                          <div className="px-3 py-2 bg-sky-50 border-b border-sky-200">
                            <span className="text-[10px] font-semibold text-sky-700 uppercase tracking-wider">Theirs (incoming)</span>
                          </div>
                          <pre className="text-[10px] font-mono text-slate-700 p-3 overflow-x-auto max-h-48 whitespace-pre-wrap break-all">{file.theirsContent || '(empty)'}</pre>
                        </div>
                      </div>
                    ) : (
                      <div className="px-4 py-3 text-xs text-slate-400 italic">Open the file in your editor to see conflict markers.</div>
                    )}
                    <div className="flex items-center gap-2 px-4 py-3 bg-slate-50 border-t border-slate-200 flex-wrap">
                      <button onClick={() => void handleResolve(file.path, 'ours')} disabled={isResolving || !!fileResolved}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg disabled:opacity-50">
                        {isResolving ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />} Accept Ours
                      </button>
                      <button onClick={() => void handleResolve(file.path, 'theirs')} disabled={isResolving || !!fileResolved}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-sky-600 hover:bg-sky-700 text-white rounded-lg disabled:opacity-50">
                        {isResolving ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />} Accept Theirs
                      </button>
                      <button onClick={() => void openExternalTerminal(repoPath)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-600 bg-white border border-slate-200 hover:border-slate-300 rounded-lg">
                        <TerminalSquare size={11} /> Open Terminal
                      </button>
                      {!fileResolved && (
                        <button onClick={() => setResolved(s => ({ ...s, [file.path]: 'manual' }))} className="ml-auto text-[10px] text-slate-400 hover:text-slate-600 underline">
                          Mark as manually resolved
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
              <AlertCircle size={12} />{error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-200 bg-slate-50 shrink-0">
          <button onClick={() => void handleAbort()} disabled={aborting || finalizing}
            className="flex items-center gap-2 px-4 py-2 text-xs font-medium text-red-600 border border-red-200 hover:bg-red-50 rounded-lg disabled:opacity-50">
            {aborting ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />} Abort Merge
          </button>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-400">
              {allResolved ? 'All resolved — ready to finalize' : `${totalFiles - resolvedCount} remaining`}
            </span>
            <button onClick={() => void handleFinalize()} disabled={!allResolved || finalizing || aborting}
              className="flex items-center gap-2 px-4 py-2 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-40">
              {finalizing ? <Loader2 size={11} className="animate-spin" /> : <GitMerge size={11} />} Finalize Merge
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Panel Section helper ──────────────────────────────────────────────────────

function PanelSection({ title, icon, extra, children, collapsible = false, open = true, onToggle }: {
  title: string; icon?: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode;
  collapsible?: boolean; open?: boolean; onToggle?: () => void;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div
        className={clsx('flex items-center gap-2 px-4 py-2.5', collapsible ? 'hover:bg-slate-50 cursor-pointer' : 'cursor-default')}
        onClick={collapsible ? onToggle : undefined}
      >
        {icon && <span className="text-slate-400">{icon}</span>}
        <span className="flex-1 text-xs font-semibold text-slate-700">{title}</span>
        {extra && <span onClick={e => e.stopPropagation()}>{extra}</span>}
        {collapsible && (open ? <ChevronDown size={13} className="text-slate-400" /> : <ChevronRight size={13} className="text-slate-400" />)}
      </div>
      {(!collapsible || open) && (
        <div className="px-4 pb-3 pt-1 border-t border-slate-100">{children}</div>
      )}
    </div>
  );
}
