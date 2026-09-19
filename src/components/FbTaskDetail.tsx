import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, Play, Calendar, CheckCircle2, XCircle, ExternalLink, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { Task, STATUS_META, PRIORITY_META } from '../types';
import { useStore } from '../store';
import { cronLabel, formatRelative } from '../utils';

interface FbConfigStatus {
  ok: boolean;
  pageName: string;
  hasToken: boolean;
  lastRunAt: string | null;
  lastRunSummary: string | null;
  lastError: string | null;
}

/** Shared body for a fb_phone_collector task — no repo, no Claude agent, just a schedule + run status. */
export function FbTaskDetail({ task, onDelete }: { task: Task; onDelete?: () => void }) {
  const navigate = useNavigate();
  const { runFbTask } = useStore();
  const [running, setRunning] = useState(false);
  const [config, setConfig] = useState<FbConfigStatus | null>(null);
  const sMeta = STATUS_META[task.status];
  const pMeta = PRIORITY_META[task.priority];

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/fb/config');
      setConfig(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  async function handleRun() {
    setRunning(true);
    try {
      await runFbTask(task.id);
      await loadConfig();
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={clsx('flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-lg', sMeta.bg, sMeta.color)}>
          <span className={clsx('w-1.5 h-1.5 rounded-full', sMeta.dot)} />{sMeta.label}
        </span>
        <span className={clsx('text-[10px] font-semibold px-1.5 py-0.5 rounded-md border', pMeta.color, pMeta.border)}>
          {pMeta.label.toUpperCase()}
        </span>
        <span className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-lg bg-primary-glow text-primary">
          <Phone size={9} /> Thu SĐT Facebook
        </span>
      </div>

      {task.description && <p className="text-xs text-slate-500 leading-relaxed">{task.description}</p>}

      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <Calendar size={12} className="text-amber-500 shrink-0" />
          {task.agentConfig.schedule
            ? <span>Tự động chạy: <span className="font-medium">{cronLabel(task.agentConfig.schedule)}</span></span>
            : <span className="text-slate-400">Chưa đặt lịch — chỉ chạy khi bấm "Chạy ngay"</span>}
        </div>

        {config && (
          <div className="text-xs text-slate-500 space-y-1">
            {config.hasToken ? (
              <div>Kết nối: <span className="font-medium text-slate-700">{config.pageName || 'đang nhận diện...'}</span></div>
            ) : (
              <div className="text-amber-600">Chưa cấu hình Page Access Token trong trang SĐT Facebook.</div>
            )}
            {config.lastRunAt && (
              <div className={config.lastError ? 'text-red-600 flex items-start gap-1' : 'text-emerald-600 flex items-start gap-1'}>
                {config.lastError ? <XCircle size={11} className="shrink-0 mt-0.5" /> : <CheckCircle2 size={11} className="shrink-0 mt-0.5" />}
                <span>{formatRelative(new Date(config.lastRunAt))} — {config.lastError || config.lastRunSummary}</span>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleRun}
            disabled={running || !config?.hasToken}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary hover:bg-primary/90 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition-colors shadow-sm"
          >
            <Play size={12} className={running ? 'animate-pulse' : ''} />
            {running ? 'Đang chạy...' : 'Chạy ngay'}
          </button>
          <button
            onClick={() => navigate('/fb-leads')}
            className="flex items-center gap-1.5 px-3 py-1.5 text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 text-xs font-medium rounded-lg transition-colors"
          >
            <ExternalLink size={12} /> Xem trang SĐT Facebook
          </button>
          {onDelete && (
            <button
              onClick={onDelete}
              className="ml-auto flex items-center gap-1.5 px-2.5 py-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 text-xs rounded-lg transition-colors"
              title="Xoá task"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
