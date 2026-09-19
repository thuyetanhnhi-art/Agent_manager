import { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, Search, Bell, Menu, CheckCircle2, XCircle, Clock, GitBranch, AlertCircle } from 'lucide-react';
import { useStore } from '../store';
import type { Task } from '../types';
import { STATUS_META } from '../types';
import clsx from 'clsx';

interface HeaderProps {
  title: string;
  subtitle?: string;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function getInitials(name: string) {
  return name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
}

function useClickOutside(ref: React.RefObject<HTMLElement | null>, handler: () => void) {
  useEffect(() => {
    const listener = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) handler();
    };
    document.addEventListener('mousedown', listener);
    return () => document.removeEventListener('mousedown', listener);
  }, [ref, handler]);
}

export function Header({ title, subtitle }: HeaderProps) {
  const { openCreateModal, toggleSidebar, sidebarOpen, tasks, openDetailPanel } = useStore();

  // ── Search ────────────────────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  useClickOutside(searchRef, () => setSearchOpen(false));

  const taskList = Object.values(tasks);
  const q = query.trim().toLowerCase();
  const searchResults: Task[] = q.length < 1 ? [] : taskList
    .filter(t =>
      t.title.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.tags.some(tag => tag.toLowerCase().includes(q))
    )
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, 8);

  const handleSearchKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setSearchOpen(false); setQuery(''); }
  }, []);

  const handleSelectTask = (taskId: string) => {
    openDetailPanel(taskId);
    setSearchOpen(false);
    setQuery('');
  };

  // ── Notification ──────────────────────────────────────────────────────────
  const [notiOpen, setNotiOpen] = useState(false);
  const notiRef = useRef<HTMLDivElement>(null);
  useClickOutside(notiRef, () => setNotiOpen(false));

  const now = Date.now();
  const reviewPending = taskList.filter(t => t.reviewPending);
  const recentDone = taskList.filter(t =>
    t.status === 'done' &&
    t.terminal.completedAt &&
    now - new Date(t.terminal.completedAt).getTime() < ONE_DAY_MS
  ).sort((a, b) => new Date(b.terminal.completedAt!).getTime() - new Date(a.terminal.completedAt!).getTime()).slice(0, 5);
  const recentFailed = taskList.filter(t =>
    t.status === 'failed' &&
    t.terminal.completedAt &&
    now - new Date(t.terminal.completedAt).getTime() < ONE_DAY_MS
  ).sort((a, b) => new Date(b.terminal.completedAt!).getTime() - new Date(a.terminal.completedAt!).getTime()).slice(0, 3);

  const notiBadge = reviewPending.length + recentFailed.length;

  return (
    <header className="h-14 border-b border-border flex items-center px-5 gap-4 bg-white/80 backdrop-blur-sm sticky top-0 z-10">
      {!sidebarOpen && (
        <button onClick={toggleSidebar} className="text-slate-400 hover:text-slate-600 transition-colors">
          <Menu size={18} />
        </button>
      )}
      <div className="flex-1 min-w-0">
        <h1 className="text-sm font-semibold text-slate-800 leading-none">{title}</h1>
        {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
      </div>

      <div className="flex items-center gap-2">

        {/* ── Search ── */}
        <div ref={searchRef} className="relative hidden sm:block">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            value={query}
            onChange={e => { setQuery(e.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={handleSearchKey}
            placeholder="Search tasks..."
            className="bg-slate-50 border border-border rounded-xl pl-8 pr-3 py-1.5 text-xs text-slate-700 placeholder-slate-400 focus:outline-none focus:border-border-focus w-44 transition-colors"
          />

          {searchOpen && q.length > 0 && (
            <div className="absolute top-full mt-1.5 left-0 w-80 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden z-50">
              {searchResults.length === 0 ? (
                <div className="px-4 py-3 text-xs text-slate-400">No tasks matching "{query}"</div>
              ) : (
                <>
                  <div className="px-3 py-2 text-[10px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-100">
                    {searchResults.length} result{searchResults.length !== 1 ? 's' : ''}
                  </div>
                  <div className="max-h-72 overflow-y-auto">
                    {searchResults.map(task => {
                      const sMeta = STATUS_META[task.status];
                      return (
                        <button
                          key={task.id}
                          onClick={() => handleSelectTask(task.id)}
                          className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-slate-50 text-left transition-colors"
                        >
                          <span className={clsx('w-2 h-2 rounded-full shrink-0', sMeta.dot)} />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium text-slate-800 truncate">{task.title}</div>
                            <div className="text-[10px] text-slate-400 mt-0.5 flex items-center gap-1.5">
                              <span className={clsx('font-medium', sMeta.color)}>{sMeta.label}</span>
                              {task.tags.length > 0 && <span>· {task.tags.slice(0, 2).join(', ')}</span>}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* ── Notification ── */}
        <div ref={notiRef} className="relative">
          <button
            onClick={() => setNotiOpen(o => !o)}
            className="relative p-2 text-slate-400 hover:text-slate-600 hover:bg-hover rounded-xl transition-colors"
          >
            <Bell size={15} />
            {notiBadge > 0 && (
              <span className="absolute top-1 right-1 min-w-[14px] h-3.5 px-0.5 rounded-full bg-primary text-[9px] font-bold text-white flex items-center justify-center leading-none">
                {notiBadge > 99 ? '99+' : notiBadge}
              </span>
            )}
          </button>

          {notiOpen && (
            <div className="absolute top-full mt-1.5 right-0 w-80 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden z-50">
              <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700">Notifications</span>
                {notiBadge > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary rounded-full font-medium">{notiBadge} new</span>
                )}
              </div>

              <div className="max-h-96 overflow-y-auto divide-y divide-slate-50">
                {/* Review pending */}
                {reviewPending.length > 0 && (
                  <div>
                    <div className="px-3 py-2 text-[10px] font-semibold text-amber-600 uppercase tracking-wider bg-amber-50/60 flex items-center gap-1.5">
                      <GitBranch size={9} /> Review Pending ({reviewPending.length})
                    </div>
                    {reviewPending.map(task => (
                      <button
                        key={task.id}
                        onClick={() => { openDetailPanel(task.id); setNotiOpen(false); }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-slate-50 text-left transition-colors"
                      >
                        <div className="w-6 h-6 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
                          <GitBranch size={11} className="text-amber-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-slate-800 truncate">{task.title}</div>
                          {task.branchName && (
                            <div className="text-[10px] text-slate-400 font-mono truncate mt-0.5">{task.branchName}</div>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {/* Recent failed */}
                {recentFailed.length > 0 && (
                  <div>
                    <div className="px-3 py-2 text-[10px] font-semibold text-red-600 uppercase tracking-wider bg-red-50/60 flex items-center gap-1.5">
                      <AlertCircle size={9} /> Failed Recently ({recentFailed.length})
                    </div>
                    {recentFailed.map(task => (
                      <button
                        key={task.id}
                        onClick={() => { openDetailPanel(task.id); setNotiOpen(false); }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-slate-50 text-left transition-colors"
                      >
                        <div className="w-6 h-6 rounded-lg bg-red-100 flex items-center justify-center shrink-0">
                          <XCircle size={11} className="text-red-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-slate-800 truncate">{task.title}</div>
                          {task.failReason && (
                            <div className="text-[10px] text-red-500 truncate mt-0.5">{task.failReason}</div>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {/* Recent completed */}
                {recentDone.length > 0 && (
                  <div>
                    <div className="px-3 py-2 text-[10px] font-semibold text-emerald-600 uppercase tracking-wider bg-emerald-50/60 flex items-center gap-1.5">
                      <CheckCircle2 size={9} /> Completed Today ({recentDone.length})
                    </div>
                    {recentDone.map(task => (
                      <button
                        key={task.id}
                        onClick={() => { openDetailPanel(task.id); setNotiOpen(false); }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-slate-50 text-left transition-colors"
                      >
                        <div className="w-6 h-6 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0">
                          <CheckCircle2 size={11} className="text-emerald-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-slate-800 truncate">{task.title}</div>
                          <div className="text-[10px] text-slate-400 mt-0.5 flex items-center gap-1">
                            <Clock size={8} />
                            {task.terminal.completedAt
                              ? new Date(task.terminal.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                              : ''}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {reviewPending.length === 0 && recentFailed.length === 0 && recentDone.length === 0 && (
                  <div className="px-4 py-8 text-center">
                    <Bell size={22} className="mx-auto mb-2 text-slate-200" />
                    <p className="text-xs text-slate-400">No notifications</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <button
          onClick={() => openCreateModal()}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-primary hover:bg-primary/90 text-white text-xs font-medium rounded-xl transition-colors shadow-sm"
        >
          <Plus size={14} />
          New Task
        </button>
      </div>
    </header>
  );
}

// export for potential reuse
export { getInitials };
