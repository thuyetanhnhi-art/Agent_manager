import { useEffect, useRef, useState } from 'react';
import {
  X, GitBranch, FolderGit2, Plus, RefreshCw, AlertCircle,
  CheckCircle2, Clock, Search, Download, Gitlab,
} from 'lucide-react';
import clsx from 'clsx';
import { useProjectStore } from '../projectStore';
import { fetchRepos, fetchGitlabRepos, cloneRepo, RepoInfo, GitlabRepo } from '../services/api';
import { formatRelative } from '../utils';

type Tab = 'local' | 'gitlab';
type CloneState = 'idle' | 'cloning' | 'done' | 'error';

export function RepoPickerModal() {
  const {
    isRepoPickerOpen, closeRepoPicker, addProject, projects, reposRoot,
  } = useProjectStore();

  // ── Local tab state ─────────────────────────────────────────────────────
  const [tab, setTab] = useState<Tab>('local');
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // ── GitLab tab state ────────────────────────────────────────────────────
  const [glRepos, setGlRepos] = useState<GitlabRepo[]>([]);
  const [glLoading, setGlLoading] = useState(false);
  const [glError, setGlError] = useState<string | null>(null);
  const [glSearch, setGlSearch] = useState('');
  const [glPage, setGlPage] = useState(1);
  const [glHasMore, setGlHasMore] = useState(false);
  const [cloneStates, setCloneStates] = useState<Record<number, CloneState>>({});
  const [cloneMsgs, setCloneMsgs] = useState<Record<number, string>>({});
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const existingPaths = new Set(Object.values(projects).map(p => p.repoPath));

  // ── Load local repos ────────────────────────────────────────────────────
  async function loadLocal() {
    setLocalLoading(true);
    setLocalError(null);
    try {
      const data = await fetchRepos(reposRoot);
      setRepos(data.repos);
    } catch {
      setLocalError('Could not scan directory. Check the path in Settings.');
    } finally {
      setLocalLoading(false);
    }
  }

  // ── Load GitLab repos ───────────────────────────────────────────────────
  async function loadGitlab(search: string, page: number, append = false) {
    setGlLoading(true);
    if (!append) setGlError(null);
    try {
      const data = await fetchGitlabRepos(search, page);
      if (!data.ok) {
        setGlError(data.error ?? 'Failed to load GitLab repos');
        if (!append) setGlRepos([]);
      } else {
        const incoming = data.repos ?? [];
        setGlRepos(prev => append ? [...prev, ...incoming] : incoming);
        setGlHasMore(incoming.length === 50);
      }
    } catch {
      setGlError('Network error — check GitLab URL and token.');
    } finally {
      setGlLoading(false);
    }
  }

  useEffect(() => {
    if (!isRepoPickerOpen) return;
    if (tab === 'local') loadLocal();
    else loadGitlab(glSearch, 1);
  }, [isRepoPickerOpen, tab]);

  // Debounced search for GitLab
  const handleGlSearch = (value: string) => {
    setGlSearch(value);
    setGlPage(1);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => loadGitlab(value, 1), 400);
  };

  // ── Local: toggle + add ─────────────────────────────────────────────────
  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function handleAdd() {
    const toAdd = repos.filter(r => selected.has(r.id) && !existingPaths.has(r.path));
    toAdd.forEach(r => {
      addProject({
        name: r.name,
        repoPath: r.path,
        description: r.lastCommit || '',
        branch: r.branch,
        lastCommit: r.lastCommit,
        lastModified: r.lastModified,
      });
    });
    setSelected(new Set());
    closeRepoPicker();
  }

  // ── GitLab: clone ───────────────────────────────────────────────────────
  async function handleClone(repo: GitlabRepo) {
    const repoName = repo.pathWithNamespace.split('/').pop() ?? repo.name;
    setCloneStates(s => ({ ...s, [repo.id]: 'cloning' }));
    setCloneMsgs(s => ({ ...s, [repo.id]: '' }));
    try {
      const result = await cloneRepo(repo.httpUrl as string, repoName, reposRoot);
      if (result.alreadyExists) {
        // Dir exists — just add to projects
        addProject({
          name: repoName,
          repoPath: result.path!,
          description: repo.description,
          branch: result.branch ?? repo.defaultBranch,
          lastCommit: null,
          lastModified: new Date().toISOString(),
        });
        setCloneStates(s => ({ ...s, [repo.id]: 'done' }));
        setCloneMsgs(s => ({ ...s, [repo.id]: 'Already exists — added to projects' }));
      } else if (result.ok) {
        addProject({
          name: repoName,
          repoPath: result.path!,
          description: repo.description,
          branch: result.branch ?? repo.defaultBranch,
          lastCommit: null,
          lastModified: new Date().toISOString(),
        });
        setCloneStates(s => ({ ...s, [repo.id]: 'done' }));
        setCloneMsgs(s => ({ ...s, [repo.id]: `Cloned to ${result.path}` }));
      } else {
        setCloneStates(s => ({ ...s, [repo.id]: 'error' }));
        setCloneMsgs(s => ({ ...s, [repo.id]: result.error ?? 'Clone failed' }));
      }
    } catch {
      setCloneStates(s => ({ ...s, [repo.id]: 'error' }));
      setCloneMsgs(s => ({ ...s, [repo.id]: 'Network error' }));
    }
  }

  const isAlreadyCloned = (repo: GitlabRepo) => {
    const repoName = repo.pathWithNamespace.split('/').pop() ?? repo.name;
    const expectedPath = `${reposRoot}\\${repoName}`.replace(/\//g, '\\');
    const expectedPathFwd = `${reposRoot}/${repoName}`;
    return existingPaths.has(expectedPath) || existingPaths.has(expectedPathFwd);
  };

  if (!isRepoPickerOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-2xl bg-white border border-slate-200 rounded-2xl shadow-2xl shadow-slate-200/50 flex flex-col overflow-hidden animate-slide-in max-h-[85vh]">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100">
          <FolderGit2 size={16} className="text-violet-600" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-800">Add Repository as Project</div>
            <div className="text-[10px] text-slate-400 truncate font-mono">{reposRoot}</div>
          </div>
          <button
            onClick={tab === 'local' ? loadLocal : () => loadGitlab(glSearch, 1)}
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            title="Refresh"
          >
            <RefreshCw size={13} className={(localLoading || glLoading) ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={closeRepoPicker}
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-100 px-5 pt-2 gap-1">
          <TabBtn active={tab === 'local'} onClick={() => setTab('local')}>
            <FolderGit2 size={12} />
            Local
          </TabBtn>
          <TabBtn active={tab === 'gitlab'} onClick={() => setTab('gitlab')}>
            <GitlabIcon />
            GitLab
          </TabBtn>
        </div>

        {/* ── Local tab ─────────────────────────────────────────────────── */}
        {tab === 'local' && (
          <>
            <div className="flex-1 overflow-y-auto p-4">
              {localError && (
                <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-xl mb-4 text-sm text-red-700">
                  <AlertCircle size={14} className="shrink-0" />
                  {localError}
                </div>
              )}
              {localLoading && (
                <div className="flex items-center justify-center py-12 text-slate-400 text-sm gap-2">
                  <RefreshCw size={14} className="animate-spin" />
                  Scanning repositories...
                </div>
              )}
              {!localLoading && !localError && repos.length === 0 && (
                <div className="text-center py-12 text-slate-400 text-sm">
                  No git repositories found in {reposRoot}
                </div>
              )}
              {!localLoading && repos.length > 0 && (
                <div className="space-y-2">
                  {repos.map(repo => {
                    const alreadyAdded = existingPaths.has(repo.path);
                    const isSelected = selected.has(repo.id);
                    return (
                      <div
                        key={repo.id}
                        onClick={() => !alreadyAdded && toggleSelect(repo.id)}
                        className={clsx(
                          'flex items-center gap-3 p-3 rounded-xl border transition-all',
                          alreadyAdded
                            ? 'border-slate-200 bg-slate-50 opacity-60 cursor-default'
                            : isSelected
                            ? 'border-violet-300 bg-violet-50 cursor-pointer'
                            : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 cursor-pointer',
                        )}
                      >
                        <div className={clsx(
                          'w-5 h-5 rounded border flex items-center justify-center shrink-0 transition-colors',
                          alreadyAdded ? 'bg-emerald-500 border-emerald-500'
                            : isSelected ? 'bg-violet-600 border-violet-600' : 'border-slate-300',
                        )}>
                          {(isSelected || alreadyAdded) && <span className="text-[8px] text-white font-bold">✓</span>}
                        </div>
                        <div className="w-9 h-9 rounded-xl bg-violet-100 flex items-center justify-center shrink-0">
                          <FolderGit2 size={16} className="text-violet-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-slate-800">{repo.name}</div>
                          <div className="text-[10px] text-slate-400 truncate font-mono">{repo.path}</div>
                          {repo.lastCommit && (
                            <div className="text-[10px] text-slate-500 truncate mt-0.5">"{repo.lastCommit}"</div>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          {repo.branch && (
                            <div className="flex items-center gap-1 text-[10px] text-slate-500">
                              <GitBranch size={9} />
                              <span className="font-mono">{repo.branch}</span>
                            </div>
                          )}
                          <div className="flex items-center gap-1 text-[10px] text-slate-400">
                            <Clock size={9} />
                            {formatRelative(new Date(repo.lastModified))}
                          </div>
                          {alreadyAdded && (
                            <span className="text-[10px] text-emerald-600 font-medium flex items-center gap-1">
                              <CheckCircle2 size={9} /> Added
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100 bg-slate-50/50">
              <span className="text-xs text-slate-400">
                {selected.size > 0 ? `${selected.size} selected` : `${repos.length} repositories found`}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={closeRepoPicker}
                  className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAdd}
                  disabled={selected.size === 0}
                  className="flex items-center gap-1.5 px-4 py-1.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg transition-colors"
                >
                  <Plus size={12} />
                  Add {selected.size > 0 ? `${selected.size} Project${selected.size > 1 ? 's' : ''}` : 'Projects'}
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── GitLab tab ─────────────────────────────────────────────────── */}
        {tab === 'gitlab' && (
          <>
            {/* Search bar */}
            <div className="px-4 pt-3 pb-2 border-b border-slate-100">
              <div className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={glSearch}
                  onChange={e => handleGlSearch(e.target.value)}
                  placeholder="Search GitLab projects…"
                  className="w-full pl-8 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-300 bg-slate-50"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {/* Not configured */}
              {glError && glError.includes('not configured') && (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                  <div className="w-12 h-12 bg-orange-50 border border-orange-100 rounded-2xl flex items-center justify-center">
                    <GitlabIcon className="text-orange-400" size={20} />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-slate-700 mb-1">GitLab not connected</div>
                    <div className="text-xs text-slate-400">
                      Go to Projects page → click <strong>GitLab</strong> button to add your URL and token.
                    </div>
                  </div>
                </div>
              )}

              {/* Other errors */}
              {glError && !glError.includes('not configured') && (
                <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-xl mb-4 text-sm text-red-700">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  <span>{glError}</span>
                </div>
              )}

              {/* Loading */}
              {glLoading && glRepos.length === 0 && (
                <div className="flex items-center justify-center py-12 text-slate-400 text-sm gap-2">
                  <RefreshCw size={14} className="animate-spin" />
                  Loading GitLab projects…
                </div>
              )}

              {/* Empty */}
              {!glLoading && !glError && glRepos.length === 0 && (
                <div className="text-center py-12 text-slate-400 text-sm">
                  No GitLab projects found{glSearch ? ` for "${glSearch}"` : ''}
                </div>
              )}

              {/* Repo list */}
              {glRepos.length > 0 && (
                <div className="space-y-2">
                  {glRepos.map(repo => {
                    const cs = cloneStates[repo.id] ?? 'idle';
                    const cm = cloneMsgs[repo.id] ?? '';
                    const alreadyCloned = isAlreadyCloned(repo) || cs === 'done';
                    return (
                      <div
                        key={repo.id}
                        className={clsx(
                          'flex items-start gap-3 p-3 rounded-xl border transition-all',
                          alreadyCloned ? 'border-emerald-200 bg-emerald-50/40'
                            : cs === 'error' ? 'border-red-200 bg-red-50/40'
                            : 'border-slate-200 bg-white',
                        )}
                      >
                        <div className="w-9 h-9 rounded-xl bg-orange-100 flex items-center justify-center shrink-0 mt-0.5">
                          <GitlabIcon className="text-orange-500" size={16} />
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-slate-800 truncate">{repo.name}</div>
                          <div className="text-[10px] text-slate-400 truncate font-mono">{repo.pathWithNamespace}</div>
                          {repo.description && (
                            <div className="text-[10px] text-slate-500 truncate mt-0.5">{repo.description}</div>
                          )}
                          {cm && (
                            <div className={clsx(
                              'text-[10px] mt-1 truncate',
                              cs === 'done' ? 'text-emerald-600' : 'text-red-500',
                            )}>
                              {cm}
                            </div>
                          )}
                        </div>

                        <div className="flex flex-col items-end gap-1.5 shrink-0">
                          {repo.defaultBranch && (
                            <div className="flex items-center gap-1 text-[10px] text-slate-400">
                              <GitBranch size={9} />
                              <span className="font-mono">{repo.defaultBranch}</span>
                            </div>
                          )}
                          {repo.lastActivity && (
                            <div className="flex items-center gap-1 text-[10px] text-slate-400">
                              <Clock size={9} />
                              {formatRelative(new Date(repo.lastActivity))}
                            </div>
                          )}
                          {/* Clone button */}
                          {alreadyCloned ? (
                            <span className="flex items-center gap-1 text-[10px] text-emerald-600 font-medium">
                              <CheckCircle2 size={10} /> Added
                            </span>
                          ) : (
                            <button
                              onClick={() => { void handleClone(repo); }}
                              disabled={cs === 'cloning'}
                              className={clsx(
                                'flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-lg transition-colors',
                                cs === 'cloning'
                                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                                  : cs === 'error'
                                  ? 'bg-red-100 text-red-600 hover:bg-red-200'
                                  : 'bg-orange-100 text-orange-700 hover:bg-orange-200',
                              )}
                              title={`Clone to ${reposRoot}`}
                            >
                              {cs === 'cloning'
                                ? <><RefreshCw size={10} className="animate-spin" /> Cloning…</>
                                : cs === 'error'
                                ? <><AlertCircle size={10} /> Retry</>
                                : <><Download size={10} /> Clone</>}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {/* Load more */}
                  {glHasMore && (
                    <button
                      onClick={() => {
                        const next = glPage + 1;
                        setGlPage(next);
                        void loadGitlab(glSearch, next, true);
                      }}
                      disabled={glLoading}
                      className="w-full py-2.5 text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-50 border border-slate-200 rounded-xl transition-colors disabled:opacity-50"
                    >
                      {glLoading ? <RefreshCw size={12} className="animate-spin mx-auto" /> : 'Load more…'}
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100 bg-slate-50/50">
              <span className="text-xs text-slate-400">
                {glRepos.length > 0
                  ? `${glRepos.length} project${glRepos.length !== 1 ? 's' : ''} loaded`
                  : 'Connect GitLab in Projects → GitLab settings'}
              </span>
              <button
                onClick={closeRepoPicker}
                className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TabBtn({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg border-b-2 transition-colors',
        active
          ? 'border-violet-600 text-violet-700'
          : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50',
      )}
    >
      {children}
    </button>
  );
}

function GitlabIcon({ className, size = 12 }: { className?: string; size?: number }) {
  return <Gitlab size={size} className={className} />;
}
