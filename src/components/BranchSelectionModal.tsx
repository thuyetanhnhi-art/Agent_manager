import { useState, useEffect } from 'react';
import { GitBranch, X, Check, AlertCircle, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { Task, Project } from '../types';
import { generateBranchName, validateBranchName } from '../branchUtils';

export interface BranchConfig {
  projectId: string;
  projectName: string;
  baseBranch: string;
  newBranch: string;
  skip: boolean;
}

interface Props {
  task: Task;
  projects: Project[];
  onConfirm: (configs: BranchConfig[]) => void;
  onSkip: () => void;
  onCancel: () => void;
}

const DEFAULT_BASE = 'main';

export function BranchSelectionModal({ task, projects, onConfirm, onSkip, onCancel }: Props) {
  const suggestedBranch = generateBranchName(task.label, task.title);

  const [configs, setConfigs] = useState<BranchConfig[]>(() =>
    projects.map(p => ({
      projectId: p.id,
      projectName: p.name,
      baseBranch: DEFAULT_BASE,
      newBranch: suggestedBranch,
      skip: false,
    })),
  );

  useEffect(() => {
    setConfigs(projects.map(p => ({
      projectId: p.id,
      projectName: p.name,
      baseBranch: DEFAULT_BASE,
      newBranch: suggestedBranch,
      skip: false,
    })));
  }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function update(idx: number, patch: Partial<BranchConfig>) {
    setConfigs(prev => prev.map((c, i) => i === idx ? { ...c, ...patch } : c));
  }

  function applyDefaultAll() {
    setConfigs(prev => prev.map(c => ({ ...c, baseBranch: DEFAULT_BASE, skip: false })));
  }

  const activeConfigs = configs.filter(c => !c.skip);
  const errors = configs.map(c => c.skip ? null : validateBranchName(c.newBranch));
  const hasErrors = errors.some(Boolean);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-violet-50 rounded-xl flex items-center justify-center">
              <GitBranch size={15} className="text-primary" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Tạo branch mới</h3>
              <p className="text-[10px] text-slate-400 truncate max-w-xs">{task.title}</p>
            </div>
          </div>
          <button onClick={onCancel} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3 max-h-[60vh] overflow-y-auto">
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-slate-500">
              Chọn base branch và tên branch mới cho từng project.
            </p>
            <button
              onClick={applyDefaultAll}
              className="text-[10px] text-violet-600 hover:text-violet-800 hover:underline"
            >
              Default all (main)
            </button>
          </div>

          {configs.map((cfg, idx) => (
            <div
              key={cfg.projectId}
              className={clsx(
                'border rounded-xl p-3 space-y-2 transition-colors',
                cfg.skip ? 'border-slate-200 bg-slate-50 opacity-50' : 'border-violet-200 bg-violet-50/30',
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700">{cfg.projectName}</span>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={cfg.skip}
                    onChange={e => update(idx, { skip: e.target.checked })}
                    className="rounded"
                  />
                  <span className="text-[10px] text-slate-500">Bỏ qua</span>
                </label>
              </div>

              {!cfg.skip && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-1">Base branch</label>
                      <div className="relative">
                        <input
                          value={cfg.baseBranch}
                          onChange={e => update(idx, { baseBranch: e.target.value })}
                          placeholder="main"
                          className="w-full bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-700 outline-none pr-6"
                        />
                        <ChevronDown size={10} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-1">New branch</label>
                      <input
                        value={cfg.newBranch}
                        onChange={e => update(idx, { newBranch: e.target.value })}
                        className={clsx(
                          'w-full bg-white border rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-700 outline-none',
                          errors[idx] ? 'border-red-300 focus:border-red-400' : 'border-slate-200 focus:border-violet-400',
                        )}
                      />
                    </div>
                  </div>
                  {errors[idx] && (
                    <div className="flex items-center gap-1 text-[10px] text-red-600">
                      <AlertCircle size={10} /> {errors[idx]}
                    </div>
                  )}
                  <div className="text-[10px] text-slate-400 font-mono truncate">
                    git checkout -b {cfg.newBranch} origin/{cfg.baseBranch}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-slate-100 bg-slate-50/50">
          <div className="flex gap-2">
            <button onClick={onCancel} className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
              Cancel
            </button>
            <button
              onClick={onSkip}
              className="px-3 py-1.5 text-xs text-slate-500 border border-slate-200 hover:bg-slate-100 rounded-lg transition-colors"
            >
              Chạy không tạo branch
            </button>
          </div>
          <button
            onClick={() => !hasErrors && onConfirm(activeConfigs)}
            disabled={hasErrors || activeConfigs.length === 0}
            className="flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary/90 disabled:opacity-40 text-white text-xs font-medium rounded-xl transition-colors shadow-sm"
          >
            <Check size={12} />
            Tạo {activeConfigs.length} branch & Chạy
          </button>
        </div>
      </div>
    </div>
  );
}
