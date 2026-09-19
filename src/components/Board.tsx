import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../store';
import { useProjectStore } from '../projectStore';
import { TaskCard } from './TaskCard';
import { TaskStatus, STATUS_META } from '../types';

const COLUMNS: TaskStatus[] = ['backlog', 'in_progress', 'paused', 'stopped', 'done', 'failed'];

export function Board() {
  const { tasks, openCreateModal, openDetailPanel } = useStore();
  const { activeProjectId } = useProjectStore();

  const rootTasks = useMemo(() => {
    let list = Object.values(tasks).filter(t => t.parentId === null);
    if (activeProjectId) list = list.filter(t => t.projectId === activeProjectId);
    return list;
  }, [tasks, activeProjectId]);

  const byStatus = useMemo(() => {
    const map: Record<TaskStatus, typeof rootTasks> = {
      backlog: [], in_progress: [], paused: [], stopped: [], done: [], failed: [],
    };
    rootTasks.forEach(t => map[t.status].push(t));
    return map;
  }, [rootTasks]);

  return (
    <div className="flex gap-4 overflow-x-auto pb-6 px-5 pt-4" style={{ minHeight: 'calc(100vh - 7rem)' }}>
      {COLUMNS.map(status => {
        const meta = STATUS_META[status];
        const col = byStatus[status];
        return (
          <div key={status} className="flex flex-col gap-3 w-72 shrink-0">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <div className={clsx('w-2 h-2 rounded-full', meta.dot)} />
                <span className="text-xs font-semibold text-slate-600">{meta.label}</span>
                <span className={clsx('text-[10px] font-medium px-1.5 py-0.5 rounded-lg', meta.bg, meta.color)}>
                  {col.length}
                </span>
              </div>
              {status !== 'done' && status !== 'failed' && status !== 'stopped' && (
                <button onClick={() => openCreateModal()} className="p-1 text-slate-400 hover:text-primary hover:bg-primary-glow rounded-lg transition-colors">
                  <Plus size={13} />
                </button>
              )}
            </div>
            <div className="flex flex-col gap-2.5">
              {col.map(task => (
                <TaskCard key={task.id} task={task} onClick={() => openDetailPanel(task.id)} />
              ))}
              {col.length === 0 && (
                <div className="border-2 border-dashed border-slate-200 rounded-2xl h-24 flex items-center justify-center text-xs text-slate-400">
                  No tasks
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
