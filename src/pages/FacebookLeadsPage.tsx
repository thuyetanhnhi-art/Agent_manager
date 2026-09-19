import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw, Phone, Search, AlertTriangle, Inbox, Settings2,
  ChevronDown, ChevronUp, Play, CheckCircle2, XCircle, Facebook, Calendar, Plus,
} from 'lucide-react';
import clsx from 'clsx';
import { Header } from '../components/Header';
import { useStore } from '../store';
import { STATUS_META } from '../types';
import { cronLabel } from '../utils';

interface FbLeadRow {
  id: string; time: string; psid: string; name: string; phone: string; message: string;
}

interface FbConfig {
  ok: boolean;
  pageId: string;
  pageName: string;
  hasToken: boolean;
  enabled: boolean;
  pollIntervalMinutes: number;
  autoReplyEnabled: boolean;
  autoReplyMessage: string;
  lastRunAt: string | null;
  lastRunSummary: string | null;
  lastError: string | null;
}

const INTERVAL_OPTIONS = [
  { value: 5, label: '5 phút' },
  { value: 15, label: '15 phút' },
  { value: 30, label: '30 phút' },
  { value: 60, label: '1 giờ' },
  { value: 180, label: '3 giờ' },
];

export function FacebookLeadsPage() {
  const { tasks, openDetailPanel, openCreateModal, runFbTask } = useStore();
  const fbTasks = Object.values(tasks).filter(t => t.taskKind === 'fb_phone_collector');

  const [rows, setRows] = useState<FbLeadRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  const [config, setConfig] = useState<FbConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [intervalMin, setIntervalMin] = useState(15);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(true);
  const [autoReplyMessage, setAutoReplyMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<{ ok: boolean; newLeads: number; conversationsChecked: number; error?: string } | null>(null);

  const loadLeads = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/fb/leads');
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Không tải được dữ liệu');
      setRows(data.leads ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không tải được dữ liệu');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/fb/config');
      const data = await res.json() as FbConfig;
      setConfig(data);
      setEnabled(data.enabled);
      setIntervalMin(data.pollIntervalMinutes);
      setAutoReplyEnabled(data.autoReplyEnabled);
      setAutoReplyMessage(data.autoReplyMessage);
      if (!data.hasToken) setSettingsOpen(true);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadLeads(); loadConfig(); }, [loadLeads, loadConfig]);

  async function saveSettings() {
    setSaving(true);
    setSaved(false);
    try {
      await fetch('/api/fb/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(tokenInput.trim() ? { pageAccessToken: tokenInput.trim() } : {}),
          enabled,
          pollIntervalMinutes: intervalMin,
          autoReplyEnabled,
          autoReplyMessage,
        }),
      });
      setTokenInput('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await loadConfig();
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setRunning(true);
    setRunResult(null);
    try {
      const res = await fetch('/api/fb/run', { method: 'POST' });
      const data = await res.json();
      setRunResult(data);
      await Promise.all([loadLeads(), loadConfig()]);
    } finally {
      setRunning(false);
    }
  }

  const q = query.trim().toLowerCase();
  const filtered = q.length === 0 ? rows : rows.filter(r =>
    r.phone.toLowerCase().includes(q) ||
    r.name.toLowerCase().includes(q) ||
    r.message.toLowerCase().includes(q)
  );

  return (
    <div className="flex-1 overflow-y-auto bg-base">
      <Header title="SĐT Facebook" subtitle="Số điện thoại thu từ inbox Messenger" />
      <div className="px-6 py-4 space-y-4">

        {/* ── Settings panel ─────────────────────────────────────────────── */}
        <div className="bg-white border border-border rounded-2xl shadow-card overflow-hidden">
          <button
            onClick={() => setSettingsOpen(o => !o)}
            className="w-full flex items-center gap-2 px-5 py-3.5 hover:bg-slate-50/60 transition-colors"
          >
            <Settings2 size={14} className="text-primary" />
            <span className="text-sm font-semibold text-slate-700 flex-1 text-left">Cài đặt</span>
            {config?.pageName && (
              <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <Facebook size={11} className="text-blue-500" /> {config.pageName}
              </span>
            )}
            <span
              className={clsx('w-1.5 h-1.5 rounded-full', config?.enabled ? 'bg-emerald-500' : 'bg-slate-300')}
              title={config?.enabled ? 'Đang tự động chạy theo lịch cố định' : 'Chưa bật lịch cố định'}
            />
            {settingsOpen ? <ChevronUp size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
          </button>

          {settingsOpen && (
            <div className="px-5 pb-5 pt-1 space-y-4 border-t border-slate-100">
              <div>
                <label className="text-xs font-medium text-slate-600 mb-1.5 block">
                  Page Access Token {config?.hasToken && <span className="text-emerald-500 font-normal">(đã lưu — chỉ nhập nếu muốn đổi)</span>}
                </label>
                <input
                  type="password"
                  value={tokenInput}
                  onChange={e => setTokenInput(e.target.value)}
                  placeholder={config?.hasToken ? '••••••••••••••••' : 'Dán Page Access Token từ Meta App Dashboard'}
                  className="w-full bg-white border border-slate-200 focus:border-violet-400 rounded-xl px-3 py-2 text-xs text-slate-700 font-mono placeholder-slate-400 outline-none transition-colors"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  Lấy từ Meta App Dashboard &gt; Messenger &gt; Access Tokens (chọn Page cần thu SĐT). Page ID/tên sẽ tự nhận diện sau khi lưu.
                </p>
              </div>

              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={e => setEnabled(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-300 text-primary focus:ring-primary"
                  />
                  <span className="text-xs text-slate-600 font-medium">Tự động chạy theo lịch cố định</span>
                </label>

                {enabled && (
                  <select
                    value={intervalMin}
                    onChange={e => setIntervalMin(Number(e.target.value))}
                    className="bg-white border border-slate-200 focus:border-violet-400 rounded-xl px-2.5 py-1.5 text-xs text-slate-700 outline-none transition-colors"
                  >
                    {INTERVAL_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>Mỗi {o.label}</option>
                    ))}
                  </select>
                )}
              </div>
              <p className="text-[10px] text-slate-400 -mt-2">
                Cách này chạy song song với lịch đặt qua Task bên dưới — dùng cái nào tiện hơn, hoặc cả hai.
              </p>

              <div>
                <label className="flex items-center gap-2 cursor-pointer mb-1.5">
                  <input
                    type="checkbox"
                    checked={autoReplyEnabled}
                    onChange={e => setAutoReplyEnabled(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-300 text-primary focus:ring-primary"
                  />
                  <span className="text-xs text-slate-600 font-medium">Tự động trả lời khi lấy được SĐT</span>
                </label>
                {autoReplyEnabled && (
                  <textarea
                    value={autoReplyMessage}
                    onChange={e => setAutoReplyMessage(e.target.value)}
                    rows={2}
                    placeholder="Nội dung trả lời khách sau khi lấy được số điện thoại"
                    className="w-full bg-white border border-slate-200 focus:border-violet-400 rounded-xl px-3 py-2 text-xs text-slate-700 placeholder-slate-400 outline-none transition-colors resize-none"
                  />
                )}
                <p className="text-[10px] text-slate-400 mt-1">
                  Chỉ áp dụng cho hội thoại đang <strong>chưa đọc</strong> — nếu bạn đã tự tay trả lời trong Inbox thì bot sẽ bỏ qua.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={saveSettings}
                  disabled={saving}
                  className={clsx(
                    'px-3 py-2 text-white text-xs font-medium rounded-xl transition-colors shadow-sm disabled:opacity-50',
                    saved ? 'bg-emerald-500' : 'bg-primary hover:bg-primary/90',
                  )}
                >
                  {saved ? 'Đã lưu' : saving ? 'Đang lưu...' : 'Lưu cài đặt'}
                </button>
                <button
                  onClick={runNow}
                  disabled={running || !config?.hasToken}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-xl transition-colors disabled:opacity-50"
                  title={!config?.hasToken ? 'Cần lưu Page Access Token trước' : ''}
                >
                  <Play size={12} className={running ? 'animate-pulse' : ''} />
                  {running ? 'Đang chạy...' : 'Chạy ngay'}
                </button>
              </div>

              {runResult && (
                <div className={clsx(
                  'flex items-start gap-2 rounded-xl p-3 text-xs',
                  runResult.ok ? 'bg-emerald-50 border border-emerald-200 text-emerald-700' : 'bg-red-50 border border-red-200 text-red-700',
                )}>
                  {runResult.ok ? <CheckCircle2 size={13} className="shrink-0 mt-0.5" /> : <XCircle size={13} className="shrink-0 mt-0.5" />}
                  <span>
                    {runResult.ok
                      ? `Tìm thấy ${runResult.newLeads} SĐT mới trong ${runResult.conversationsChecked} hội thoại.`
                      : runResult.error}
                  </span>
                </div>
              )}

              {!runResult && config?.lastRunAt && (
                <p className="text-[10px] text-slate-400">
                  Lần chạy gần nhất: {new Date(config.lastRunAt).toLocaleString('vi-VN')}
                  {config.lastError ? ` — lỗi: ${config.lastError}` : config.lastRunSummary ? ` — ${config.lastRunSummary}` : ''}
                </p>
              )}
            </div>
          )}
        </div>

        {/* ── Linked Tasks (lịch tự động) ───────────────────────────────── */}
        <div className="bg-white border border-border rounded-2xl shadow-card p-4">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-xs font-semibold text-slate-700">Lịch tự động (Task)</span>
            <button
              onClick={() => openCreateModal()}
              className="flex items-center gap-1 text-[10px] text-violet-600 hover:text-violet-800 transition-colors"
            >
              <Plus size={10} /> Tạo task lịch
            </button>
          </div>
          {fbTasks.length === 0 ? (
            <p className="text-[11px] text-slate-400">
              Chưa có Task nào. Bấm "New Task" ở góc trên phải, chọn loại <strong>Thu SĐT Facebook</strong>,
              rồi đặt Schedule ở bước 2 để tự động chạy theo giờ.
            </p>
          ) : (
            <div className="space-y-1.5">
              {fbTasks.map(t => {
                const sMeta = STATUS_META[t.status];
                return (
                  <div key={t.id} className="flex items-center gap-2 px-2.5 py-2 rounded-xl hover:bg-slate-50 transition-colors">
                    <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', sMeta.dot)} />
                    <button onClick={() => openDetailPanel(t.id)} className="text-xs text-slate-700 hover:text-primary font-medium truncate flex-1 text-left">
                      {t.title}
                    </button>
                    {t.agentConfig.schedule ? (
                      <span className="flex items-center gap-1 text-[10px] text-amber-600 shrink-0">
                        <Calendar size={9} /> {cronLabel(t.agentConfig.schedule)}
                      </span>
                    ) : (
                      <span className="text-[10px] text-slate-300 shrink-0">Chưa đặt lịch</span>
                    )}
                    <button
                      onClick={() => runFbTask(t.id)}
                      className="p-1 text-slate-400 hover:text-primary hover:bg-primary-glow rounded-lg transition-colors shrink-0"
                      title="Chạy ngay"
                    >
                      <Play size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Toolbar ────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 max-w-sm">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Tìm theo SĐT, tên, nội dung..."
              className="w-full bg-white border border-slate-200 focus:border-violet-400 rounded-xl pl-8 pr-3 py-2 text-xs text-slate-700 placeholder-slate-400 outline-none transition-colors"
            />
          </div>
          <button
            onClick={loadLeads}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-xl transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            Làm mới
          </button>
          <span className="text-xs text-slate-400 ml-auto">{filtered.length} kết quả</span>
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-700">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* ── Leads table ────────────────────────────────────────────────── */}
        <div className="bg-white border border-border rounded-2xl shadow-card overflow-hidden">
          {filtered.length === 0 && !loading ? (
            <div className="px-4 py-16 text-center">
              <Inbox size={22} className="mx-auto mb-2 text-slate-200" />
              <p className="text-xs text-slate-400">Chưa có số điện thoại nào được ghi nhận</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                    <th className="px-4 py-2.5 whitespace-nowrap">Thời gian</th>
                    <th className="px-4 py-2.5 whitespace-nowrap">Tên</th>
                    <th className="px-4 py-2.5 whitespace-nowrap">Số điện thoại</th>
                    <th className="px-4 py-2.5">Nội dung tin nhắn</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {filtered.map(r => (
                    <tr key={r.id + r.phone} className="hover:bg-slate-50/60 transition-colors">
                      <td className="px-4 py-2.5 whitespace-nowrap text-slate-400">
                        {r.time ? new Date(r.time).toLocaleString('vi-VN') : '—'}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-slate-700">{r.name || '—'}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap font-mono font-medium text-slate-800">
                        <span className="inline-flex items-center gap-1.5">
                          <Phone size={11} className="text-primary" />
                          {r.phone}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-500 max-w-md truncate" title={r.message}>{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
