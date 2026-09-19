import { useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  Plus, Kanban, List, Play, Terminal as TerminalIcon,
  ChevronDown, ChevronRight, Calendar, PauseCircle, FolderGit2, GitBranch,
  Trash2, CheckSquare,
} from 'lucide-react';
import { useStore } from '../store';
import { useProjectStore } from '../projectStore';
import { STATUS_META, PRIORITY_META, MODEL_INFO, TaskStatus, Priority } from '../types';
import { formatRelative, formatTokens, cronLabel } from '../utils';
import { Board } from '../components/Board';

type TabType = 'board' | 'list';

export function TasksPage() {
  const [tab, setTab] = useState<TabType>('board');
  const [filterStatus, setFilterStatus] = useState<TaskStatus | 'all'>('all');
  const [filterPriority, setFilterPriority] = useState<Priority | 'all'>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { tasks, openCreateModal, openTerminal, openDetailPanel, deleteTasks } = useStore();
  const { activeProjectId, projects } = useProjectStore();

  const activeProject = activeProjectId ? projects[activeProjectId] : null;

  const rootTasks = useMemo(() => {
    let list = Object.values(tasks).filter(t => t.parentId === null);
    if (activeProjectId) list = list.filter(t => t.projectId === activeProjectId);
    if (filterStatus !== 'all') list = list.filter(t => t.status === filterStatus);
    if (filterPriority !== 'all') list = list.filter(t => t.priority === filterPriority);
    return list.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }, [tasks, activeProjectId, filterStatus, filterPriority]);

  const totalRootCount = useMemo(() => {
    let list = Object.values(tasks).filter(t => t.parentId === null);
    if (activeProjectId) list = list.filter(t => t.projectId === activeProjectId);
    return list.length;
  }, [tasks, activeProjectId]);

  function toggleExpand(id: string) {
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function toggleSelectAll() {
    if (selectedIds.size === rootTasks.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(rootTasks.map(t => t.id)));
    }
  }

  function handleDeleteSelected() {
    if (selectedIds.size === 0) return;
    deleteTasks([...selectedIds]);
    setSelectedIds(new Set());
  }

  function handleDeleteAllInProject() {
    if (!activeProjectId) return;
    const ids = Object.values(tasks)
      .filter(t => t.projectId === activeProjectId && t.parentId === null)
      .map(t => t.id);
    deleteTasks(ids);
    setSelectedIds(new Set());
  }

  function handleRun(e: React.MouseEvent, taskId: string) {
    e.stopPropagation();
    openDetailPanel(taskId, true);
  }

  const STATUS_LIST: Array<TaskStatus | 'all'> = ['all', 'backlog', 'in_progress', 'paused', 'stopped', 'done', 'failed'];
  const PRIORITY_LIST: Array<Priority | 'all'> = ['all', 'low', 'medium', 'high', 'critical'];

  const allSelected = rootTasks.length > 0 && selectedIds.size === rootTasks.length;
  const someSelected = selectedIds.size > 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">

      {/* Sticky header */}
      <div className="shrink-0 bg-white border-b border-border px-5 py-3 flex items-center gap-3">
        {/* Project identity */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {activeProject ? (
            <>
              <div className="w-3 h-3 rounded-full shrink-0" style={{ background: activeProject.color }} />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800 leading-tight">{activeProject.name}</div>
                {activeProject.branch && (
                  <div className="flex items-center gap-1 text-[10px] text-slate-400 font-mono leading-tight">
                    <GitBranch size={8} />{activeProject.branch}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <FolderGit2 size={14} className="text-slate-400 shrink-0" />
              <span className="text-sm font-semibold text-slate-800">All Tasks</span>
            </>
          )}
          <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded-lg font-mono ml-1 shrink-0">
            {totalRootCount}
          </span>
        </div>

        {/* Delete all in project */}
        {activeProject && tab === 'list' && totalRootCount > 0 && (
          <button
            onClick={handleDeleteAllInProject}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-red-500 border border-red-200 hover:bg-red-50 rounded-xl transition-colors shrink-0"
            title={`Delete all tasks in ${activeProject.name}`}
          >
            <Trash2 size={11} /> Delete all
          </button>
        )}

        {/* Board / List tabs */}
        <div className="flex items-center bg-slate-100 rounded-xl p-0.5 shrink-0">
          <button
            onClick={() => { setTab('board'); setSelectedIds(new Set()); }}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors',
              tab === 'board' ? 'bg-white text-slate-800 font-medium shadow-sm' : 'text-slate-500 hover:text-slate-700',
            )}
          >
            <Kanban size={12} /> Board
          </button>
          <button
            onClick={() => setTab('list')}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors',
              tab === 'list' ? 'bg-white text-slate-800 font-medium shadow-sm' : 'text-slate-500 hover:text-slate-700',
            )}
          >
            <List size={12} /> List
          </button>
        </div>

        {/* New Task */}
        <button
          onClick={() => openCreateModal()}
          className="flex items-center gap-1.5 px-3 py-2 bg-primary hover:bg-primary/90 text-white text-xs font-medium rounded-xl transition-colors shadow-sm shrink-0"
        >
          <Plus size={12} /> New Task
        </button>
      </div>

      {/* Board tab */}
      {tab === 'board' && <Board />}

      {/* List tab */}
      {tab === 'list' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Filters + bulk action bar */}
          <div className="shrink-0 px-5 py-2 border-b border-border bg-white flex items-center gap-3 flex-wrap">
            {someSelected ? (
              <>
                <button
                  onClick={toggleSelectAll}
                  className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-700"
                >
                  <CheckSquare size={12} />
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
                <span className="text-[10px] text-slate-400">{selectedIds.size} selected</span>
                <button
                  onClick={handleDeleteSelected}
                  className="flex items-center gap-1 text-[10px] px-2.5 py-1 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors font-medium"
                >
                  <Trash2 size={10} /> Delete {selectedIds.size}
                </button>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="text-[10px] font-medium text-slate-500 mr-1">Status:</span>
                  {STATUS_LIST.map(s => (
                    <button key={s} onClick={() => setFilterStatus(s)}
                      className={clsx('text-[10px] px-2 py-1 rounded-lg transition-colors',
                        filterStatus === s ? 'bg-primary-glow text-primary font-medium' : 'text-slate-400 hover:text-slate-600 hover:bg-hover')}>
                      {s === 'all' ? 'All' : STATUS_META[s].label}
                    </button>
                  ))}
                </div>
                <div className="w-px h-3 bg-border" />
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="text-[10px] font-medium text-slate-500 mr-1">Priority:</span>
                  {PRIORITY_LIST.map(p => (
                    <button key={p} onClick={() => setFilterPriority(p)}
                      className={clsx('text-[10px] px-2 py-1 rounded-lg transition-colors',
                        filterPriority === p ? 'bg-primary-glow text-primary font-medium' : 'text-slate-400 hover:text-slate-600 hover:bg-hover')}>
                      {p === 'all' ? 'All' : PRIORITY_META[p].label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Task rows */}
          <div className="flex-1 overflow-y-auto bg-base px-5 py-4 space-y-1.5">
            {rootTasks.length === 0 && (
              <div className="text-center text-slate-400 text-sm py-16">
                {activeProject ? `No tasks in ${activeProject.name} yet.` : 'No tasks yet.'}
                {' '}
                <button onClick={() => openCreateModal()} className="text-primary underline">Create one</button>
              </div>
            )}

            {rootTasks.map(task => {
              const sMeta = STATUS_META[task.status];
              const pMeta = PRIORITY_META[task.priority];
              const mInfo = MODEL_INFO[task.agentConfig.model];
              const subtasks = task.subtaskIds.map(id => tasks[id]).filter(Boolean);
              const isExpanded = expanded.has(task.id);
              const isSelected = selectedIds.has(task.id);
              const taskProject = task.projectId && !activeProjectId ? projects[task.projectId] : null;

              return (
                <div key={task.id} className="animate-fade-in">
                  <div
                    onClick={() => { if (!someSelected) openDetailPanel(task.id); else toggleSelect(task.id); }}
                    className={clsx(
                      'group flex items-center gap-3 bg-white border rounded-2xl px-4 py-3 cursor-pointer transition-colors shadow-card',
                      isSelected
                        ? 'border-violet-400 bg-violet-50'
                        : 'border-border hover:border-slate-300 hover:shadow-card-hover',
                    )}
                  >
                    {/* Checkbox */}
                    <div
                      onClick={e => { e.stopPropagation(); toggleSelect(task.id); }}
                      className={clsx(
                        'w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors cursor-pointer',
                        isSelected ? 'bg-primary border-primary' : 'border-slate-300 hover:border-violet-400',
                      )}
                    >
                      {isSelected && <span className="text-[8px] text-white font-bold">✓</span>}
                    </div>

                    {/* Expand toggle for subtasks */}
                    {subtasks.length > 0 ? (
                      <button onClick={e => { e.stopPropagation(); toggleExpand(task.id); }} className="p-0.5 text-slate-400 hover:text-slate-600 shrink-0">
                        {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </button>
                    ) : <div className="w-5 shrink-0" />}

                    <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-4 gap-1 sm:gap-3 items-center">
                      <div className="sm:col-span-2 min-w-0">
                        <div className="text-sm font-medium text-slate-700 group-hover:text-slate-900 truncate">{task.title}</div>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          {/* Project badge — only when viewing all tasks */}
                          {taskProject && (
                            <span className="flex items-center gap-1 text-[10px] text-slate-500 border border-slate-200 rounded-md px-1.5 py-0.5">
                              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: taskProject.color }} />
                              {taskProject.name}
                            </span>
                          )}
                          {task.terminal.isRunning && <span className="text-[10px] text-primary font-medium">● Running</span>}
                          {task.terminal.isPaused && !task.terminal.isRunning && (
                            <span className="text-[10px] text-amber-600 font-medium flex items-center gap-0.5">
                              <PauseCircle size={9} /> Paused
                            </span>
                          )}
                          {task.agentConfig.schedule && (
                            <span className="flex items-center gap-0.5 text-[10px] text-amber-600 border border-amber-200 bg-amber-50 rounded-md px-1.5 py-0.5">
                              <Calendar size={8} /> {cronLabel(task.agentConfig.schedule)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={clsx('flex items-center gap-1 text-[10px]', sMeta.color)}>
                          <span className={clsx('w-1.5 h-1.5 rounded-full', sMeta.dot)} />{sMeta.label}
                        </span>
                        <span className={clsx('text-[10px] font-semibold', pMeta.color)}>{pMeta.label}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px]">
                        <span style={{ color: mInfo.color }} className="truncate">{mInfo.label}</span>
                        {task.terminal.tokenUsage.total > 0 && (
                          <span className="text-slate-400">{formatTokens(task.terminal.tokenUsage.total)}</span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <span className="text-[10px] text-slate-400 hidden sm:block">{formatRelative(task.updatedAt)}</span>
                      {task.terminal.logs.length > 0 && (
                        <button onClick={e => { e.stopPropagation(); openTerminal(task.id); }}
                          className="p-1.5 text-slate-400 hover:text-primary hover:bg-primary-glow rounded-lg transition-colors opacity-0 group-hover:opacity-100">
                          <TerminalIcon size={12} />
                        </button>
                      )}
                      {!task.terminal.isRunning && task.status !== 'done' && task.status !== 'stopped' && (
                        <button onClick={e => handleRun(e, task.id)}
                          className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100">
                          <Play size={12} />
                        </button>
                      )}
                    </div>
                  </div>

                  {isExpanded && subtasks.length > 0 && (
                    <div className="ml-8 mt-1 space-y-1">
                      {subtasks.map(sub => {
                        const ssMeta = STATUS_META[sub.status];
                        const ssMInfo = MODEL_INFO[sub.agentConfig.model];
                        return (
                          <div key={sub.id} onClick={() => openDetailPanel(sub.id)}
                            className="group flex items-center gap-3 bg-slate-50 border border-border hover:border-slate-300 rounded-xl px-4 py-2 cursor-pointer transition-colors">
                            <div className={clsx('w-1.5 h-1.5 rounded-full shrink-0', ssMeta.dot)} />
                            <div className="flex-1 min-w-0">
                              <span className="text-xs text-slate-600 group-hover:text-slate-800 truncate">{sub.title}</span>
                            </div>
                            <span className={clsx('text-[10px]', ssMeta.color)}>{ssMeta.label}</span>
                            <span className="text-[10px]" style={{ color: ssMInfo.color }}>{ssMInfo.label}</span>
                            {sub.terminal.tokenUsage.total > 0 && (
                              <span className="text-[10px] text-slate-400 font-mono">{formatTokens(sub.terminal.tokenUsage.total)}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
