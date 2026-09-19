import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Settings, RefreshCw, Download,
  CheckCircle2, XCircle, Key, FolderOpen,
  Play, Square, ChevronDown, ChevronUp, CheckSquare, Square as SquareIcon, Trash2,
} from 'lucide-react';
import clsx from 'clsx';
import { Header } from '../components/Header';

// ─── AI QC types ─────────────────────────────────────────────────────────────

interface AiQcConfig {
  inputDir: string;
  apiKey: string;
  model: string;
  baseUrl: string;
}

interface AiQcUnit {
  name: string;
  dateCount: number;
  imgCount: number;
}

interface AiQcReport {
  api_file_name: string;
  status: string;
  error_type: string | null;
  is_duplicate: boolean;
  confidence: number;
  extracted_info: { timestamp: string; battery: string; network: string };
  reason: string;
}

interface AiQcTaskResult {
  total_images_processed: number;
  detailed_report: AiQcReport[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DAY_LABELS = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'CN'];

function getMonday(d: Date): string {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  date.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
  return date.toISOString().slice(0, 10);
}

function formatWeekLabel(weekStart: string): string {
  const start = new Date(weekStart + 'T00:00:00');
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const fmt = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `${fmt(start)} – ${fmt(end)}/${end.getFullYear()}`;
}

function shiftWeek(weekStart: string, delta: number): string {
  const d = new Date(weekStart + 'T00:00:00');
  d.setDate(d.getDate() + delta * 7);
  return d.toISOString().slice(0, 10);
}

// ─── Component ────────────────────────────────────────────────────────────────

export function QCPage() {
  // ── AI QC state ──────────────────────────────────────────────────────────
  const [aiQcConfig, setAiQcConfig] = useState<AiQcConfig>({
    inputDir: '',
    apiKey: '',
    model: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  });
  const [aiQcConfigOpen, setAiQcConfigOpen] = useState(false);
  const [aiQcConfigSaved, setAiQcConfigSaved] = useState(false);
  const [aiQcUnits, setAiQcUnits] = useState<AiQcUnit[]>([]);
  const [loadingUnits, setLoadingUnits] = useState(false);
  const [selectedUnits, setSelectedUnits] = useState<Set<string>>(new Set());
  const [aiQcRunning, setAiQcRunning] = useState(false);
  const [aiQcLog, setAiQcLog] = useState<string[]>([]);
  const [aiQcProgress, setAiQcProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [aiQcResults, setAiQcResults] = useState<Record<string, Record<string, AiQcTaskResult>>>({});
  const localIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const [reportFrom, setReportFrom] = useState(() => { const d = new Date(); return localIso(new Date(d.getFullYear(), d.getMonth(), 1)); });
  const [reportTo, setReportTo] = useState(() => localIso(new Date()));
  const [reportBusy, setReportBusy] = useState(false);
  const [reportMsg, setReportMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function exportAeoReport() {
    setReportBusy(true);
    setReportMsg(null);
    try {
      const res = await fetch('/api/ai-qc/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: reportFrom, to: reportTo }),
      });
      if ((res.headers.get('content-type') ?? '').includes('application/json')) {
        const j = await res.json() as { error?: string };
        setReportMsg({ ok: false, text: j.error ?? 'Không tạo được báo cáo.' });
        return;
      }
      const sampled = res.headers.get('X-Qc-Sampled') ?? '0';
      const unmatched = JSON.parse(decodeURIComponent(res.headers.get('X-Qc-Unmatched') ?? '%5B%5D')) as string[];
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'QC_AEO.xlsx';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
      setReportMsg({
        ok: true,
        text: `Đã xuất ${name} (${sampled} PGD có mẫu)` + (unmatched.length ? ` — không khớp PGD nào trong org chart: ${unmatched.join(', ')}` : ''),
      });
    } catch (e) {
      setReportMsg({ ok: false, text: String(e) });
    } finally {
      setReportBusy(false);
    }
  }
  const [expandedUnits, setExpandedUnits] = useState<Set<string>>(new Set());
  const logEndRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  // ── AI QC effects ─────────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/ai-qc/config').then(r => r.json()).then(d => {
      if (d.ok && d.data) setAiQcConfig(prev => ({ ...prev, ...d.data }));
    }).catch(() => {});
    fetch('/api/ai-qc/results').then(r => r.json()).then(d => {
      if (d.ok) setAiQcResults(d.data || {});
    }).catch(() => {});
  }, []);

  const loadAiQcUnits = useCallback(async () => {
    setLoadingUnits(true);
    try {
      const d = await fetch('/api/ai-qc/units').then(r => r.json());
      if (d.ok) setAiQcUnits(d.units || []);
    } finally { setLoadingUnits(false); }
  }, []);

  useEffect(() => { loadAiQcUnits(); }, [loadAiQcUnits]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [aiQcLog]);

  // ── AI QC handlers ────────────────────────────────────────────────────────

  async function saveAiQcConfig() {
    await fetch('/api/ai-qc/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(aiQcConfig) });
    setAiQcConfigSaved(true);
    setTimeout(() => setAiQcConfigSaved(false), 2000);
    loadAiQcUnits();
  }

  function toggleUnit(name: string) {
    setSelectedUnits(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  function selectAllUnits() { setSelectedUnits(new Set(aiQcUnits.map(u => u.name))); }
  function deselectAllUnits() { setSelectedUnits(new Set()); }

  function stopAiQc() {
    esRef.current?.close();
    esRef.current = null;
    setAiQcRunning(false);
    setAiQcLog(prev => [...prev, '— Đã dừng —']);
  }

  async function runAiQc() {
    if (!selectedUnits.size || aiQcRunning) return;
    setAiQcRunning(true);
    setAiQcLog([]);
    setAiQcProgress({ done: 0, total: 0 });

    const d = await fetch('/api/ai-qc/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ units: [...selectedUnits] }),
    }).then(r => r.json());

    if (!d.ok) {
      alert(d.error || 'Lỗi khởi động QC');
      setAiQcRunning(false);
      return;
    }

    const es = new EventSource(`/api/ai-qc/stream?runId=${d.runId}`);
    esRef.current = es;

    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type === 'start') {
        setAiQcProgress({ done: 0, total: event.total });
        setAiQcLog(prev => [...prev, `▶ Bắt đầu: ${event.total} batch`]);
      } else if (event.type === 'progress') {
        setAiQcLog(prev => [...prev, `  [${event.index + 1}/${event.total}] ${event.unit} · ${event.date} — đang gọi AI...`]);
      } else if (event.type === 'result') {
        const report: AiQcReport[] = (event.data as AiQcTaskResult).detailed_report || [];
        const passCount = report.filter(r => r.status === 'ĐẠT').length;
        setAiQcProgress(prev => ({ ...prev, done: prev.done + 1 }));
        setAiQcLog(prev => [...prev, `  ✓ ${event.unit} · ${event.date}: ${passCount}/${report.length} đạt`]);
        setAiQcResults(prev => ({
          ...prev,
          [event.unit]: { ...(prev[event.unit] || {}), [event.date]: event.data },
        }));
      } else if (event.type === 'retry') {
        setAiQcLog(prev => [...prev, `  ⟳ ${event.unit} · ${event.date}: retry ${event.attempt}/${3}, chờ ${event.waitSec}s...`]);
      } else if (event.type === 'error') {
        setAiQcLog(prev => [...prev, `  ✗ ${event.unit} · ${event.date}: ${event.message}`]);
      } else if (event.type === 'done') {
        setAiQcLog(prev => [...prev, `✔ Hoàn thành tất cả ${event.total} batch`]);
        setAiQcRunning(false);
        es.close();
        esRef.current = null;
      }
    };

    es.onerror = () => {
      setAiQcLog(prev => [...prev, '✗ Lỗi kết nối stream']);
      setAiQcRunning(false);
      es.close();
      esRef.current = null;
    };
  }

  // ── AI QC derived stats ───────────────────────────────────────────────────

  function getUnitStats(unitName: string) {
    const dates = aiQcResults[unitName] || {};
    let totalImgs = 0, passCount = 0, failCount = 0;
    for (const result of Object.values(dates)) {
      for (const r of result.detailed_report || []) {
        totalImgs++;
        if (r.status === 'ĐẠT') passCount++; else failCount++;
      }
    }
    return { totalImgs, passCount, failCount, dateCount: Object.keys(dates).length };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 overflow-y-auto bg-base">
      <Header title="AI QC Đơn vị" subtitle="Kiểm tra ảnh báo cáo Google AI Overview" />

      <div className="px-6 py-4 space-y-4">

          {/* Config Panel */}
          <div className="bg-white border border-border rounded-2xl shadow-card overflow-hidden">
            <button onClick={() => setAiQcConfigOpen(v => !v)} className="w-full flex items-center gap-2 px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-hover transition-colors">
              <Settings size={14} className="text-primary" />
              Cấu hình AI QC
              <span className="ml-auto text-xs text-slate-400 font-normal">{aiQcConfigOpen ? 'Thu gọn' : 'Mở rộng'}</span>
            </button>
            {aiQcConfigOpen && (
              <div className="px-5 pb-5 border-t border-border pt-4 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <label className="block md:col-span-2">
                    <div className="flex items-center gap-1 text-xs text-slate-500 mb-1"><FolderOpen size={11} /> Thư mục input (chứa các đơn vị)</div>
                    <input value={aiQcConfig.inputDir} onChange={e => setAiQcConfig(p => ({ ...p, inputDir: e.target.value }))}
                      placeholder="C:\FPT\ai_QC\input"
                      className="w-full border border-slate-200 focus:border-violet-400 rounded-xl px-3 py-2 text-xs font-mono placeholder-slate-400 outline-none" />
                  </label>
                  <label className="block">
                    <div className="flex items-center gap-1 text-xs text-slate-500 mb-1"><Key size={11} /> API Key (Gemini / OpenAI)</div>
                    <input type="password" value={aiQcConfig.apiKey} onChange={e => setAiQcConfig(p => ({ ...p, apiKey: e.target.value }))}
                      placeholder="API key..."
                      className="w-full border border-slate-200 focus:border-violet-400 rounded-xl px-3 py-2 text-xs font-mono placeholder-slate-400 outline-none" />
                  </label>
                  <label className="block">
                    <div className="flex items-center gap-1 text-xs text-slate-500 mb-1">Model</div>
                    <input value={aiQcConfig.model} onChange={e => setAiQcConfig(p => ({ ...p, model: e.target.value }))}
                      placeholder="gemini-2.5-flash"
                      className="w-full border border-slate-200 focus:border-violet-400 rounded-xl px-3 py-2 text-xs font-mono placeholder-slate-400 outline-none" />
                  </label>
                  <label className="block md:col-span-2">
                    <div className="flex items-center gap-1 text-xs text-slate-500 mb-1">Base URL (OpenAI-compatible)</div>
                    <input value={aiQcConfig.baseUrl} onChange={e => setAiQcConfig(p => ({ ...p, baseUrl: e.target.value }))}
                      placeholder="https://generativelanguage.googleapis.com/v1beta/openai/"
                      className="w-full border border-slate-200 focus:border-violet-400 rounded-xl px-3 py-2 text-xs font-mono placeholder-slate-400 outline-none" />
                  </label>
                </div>
                <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-2 text-xs text-blue-700">
                  Cấu trúc thư mục: <code className="font-mono bg-blue-100 px-1 rounded">[inputDir]\[Đơn vị]\[YYYY-MM-DD]\photo.jpg</code>
                </div>
                <button onClick={saveAiQcConfig} className={clsx('px-4 py-2 text-xs font-medium text-white rounded-xl transition-colors shadow-sm', aiQcConfigSaved ? 'bg-emerald-500' : 'bg-primary hover:bg-primary/90')}>
                  {aiQcConfigSaved ? 'Đã lưu ✓' : 'Lưu cấu hình'}
                </button>
              </div>
            )}
          </div>

          {/* Unit Selection */}
          <div className="bg-white border border-border rounded-2xl shadow-card overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-slate-700">Chọn đơn vị</span>
                {aiQcUnits.length > 0 && (
                  <span className="text-xs bg-slate-100 text-slate-500 rounded-full px-2 py-0.5">
                    {selectedUnits.size}/{aiQcUnits.length} đã chọn
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={loadAiQcUnits} disabled={loadingUnits} className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-500 border border-border rounded-lg hover:bg-hover transition-colors">
                  <RefreshCw size={11} className={loadingUnits ? 'animate-spin' : ''} /> Tải lại
                </button>
                <button onClick={selectAllUnits} className="px-2.5 py-1.5 text-xs text-primary border border-primary/30 rounded-lg hover:bg-primary-glow transition-colors">
                  Chọn tất cả
                </button>
                <button onClick={deselectAllUnits} className="px-2.5 py-1.5 text-xs text-slate-500 border border-border rounded-lg hover:bg-hover transition-colors">
                  Bỏ chọn
                </button>
              </div>
            </div>

            {loadingUnits ? (
              <div className="flex items-center justify-center py-10 text-sm text-slate-400">
                <RefreshCw size={14} className="animate-spin mr-2" /> Đang quét thư mục...
              </div>
            ) : aiQcUnits.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-2 text-slate-400">
                <FolderOpen size={28} className="opacity-30" />
                <p className="text-sm">Chưa cấu hình thư mục input hoặc không tìm thấy đơn vị nào</p>
                <button onClick={() => setAiQcConfigOpen(true)} className="text-xs text-primary hover:underline">Mở Cấu hình</button>
              </div>
            ) : (
              <div className="p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {aiQcUnits.map(unit => {
                  const checked = selectedUnits.has(unit.name);
                  const unitStats = getUnitStats(unit.name);
                  return (
                    <button
                      key={unit.name}
                      onClick={() => toggleUnit(unit.name)}
                      className={clsx(
                        'flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-colors',
                        checked ? 'bg-violet-50 border-violet-300 text-slate-700' : 'bg-slate-50 border-border text-slate-600 hover:bg-hover',
                      )}
                    >
                      <div className={clsx('shrink-0 w-4 h-4 rounded flex items-center justify-center border', checked ? 'bg-primary border-primary' : 'border-slate-300 bg-white')}>
                        {checked ? <CheckSquare size={12} className="text-white" /> : <SquareIcon size={12} className="text-transparent" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium truncate">{unit.name}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          {unit.dateCount} ngày · {unit.imgCount} ảnh
                          {unitStats.totalImgs > 0 && (
                            <span className="ml-1.5">
                              · <span className="text-emerald-600">{unitStats.passCount}đ</span>/<span className="text-red-500">{unitStats.failCount}k</span>
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Action Bar */}
          <div className="flex items-center gap-3">
            <button
              onClick={runAiQc}
              disabled={!selectedUnits.size || aiQcRunning}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-primary rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              <Play size={13} />
              {aiQcRunning ? 'Đang chạy...' : `Chạy AI QC${selectedUnits.size ? ` (${selectedUnits.size} đơn vị)` : ''}`}
            </button>
            {aiQcRunning && (
              <button onClick={stopAiQc} className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-red-600 border border-red-200 bg-red-50 rounded-xl hover:bg-red-100 transition-colors">
                <Square size={11} /> Dừng
              </button>
            )}
            {aiQcProgress.total > 0 && (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <div className="w-32 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                  <div className="h-full bg-primary transition-all" style={{ width: `${(aiQcProgress.done / aiQcProgress.total) * 100}%` }} />
                </div>
                <span>{aiQcProgress.done}/{aiQcProgress.total}</span>
              </div>
            )}
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => window.open('/api/ai-qc/export-excel', '_blank')}
                disabled={Object.keys(aiQcResults).length === 0}
                className="flex items-center gap-1.5 px-3 py-2 text-xs bg-white border border-border rounded-xl hover:bg-hover transition-colors text-slate-600 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Download size={12} /> Xuất Excel
              </button>
              <button
                onClick={async () => {
                  if (!confirm('Xóa toàn bộ kết quả AI QC đã lưu?')) return;
                  await fetch('/api/ai-qc/results', { method: 'DELETE' });
                  setAiQcResults({});
                  setAiQcLog([]);
                  setAiQcProgress({ done: 0, total: 0 });
                }}
                disabled={Object.keys(aiQcResults).length === 0}
                className="flex items-center gap-1.5 px-3 py-2 text-xs bg-white border border-red-200 rounded-xl hover:bg-red-50 transition-colors text-red-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Trash2 size={12} /> Xóa kết quả
              </button>
            </div>
          </div>

          {/* Báo cáo QC AEO theo mẫu */}
          <div className="flex flex-wrap items-center gap-2 bg-white border border-border rounded-2xl px-4 py-3">
            <span className="text-xs font-semibold text-slate-700">Báo cáo QC AEO</span>
            <span className="text-[11px] text-slate-400">từ</span>
            <input type="date" value={reportFrom} onChange={e => setReportFrom(e.target.value)}
              className="bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-2 py-1 text-xs text-slate-700 outline-none" />
            <span className="text-[11px] text-slate-400">đến</span>
            <input type="date" value={reportTo} onChange={e => setReportTo(e.target.value)}
              className="bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-2 py-1 text-xs text-slate-700 outline-none" />
            <button
              onClick={exportAeoReport}
              disabled={reportBusy || !reportFrom || !reportTo || Object.keys(aiQcResults).length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-primary rounded-xl hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              <Download size={12} /> {reportBusy ? 'Đang tạo...' : 'Xuất báo cáo AEO'}
            </button>
            {reportMsg && (
              <span className={clsx('text-[11px] basis-full', reportMsg.ok ? 'text-emerald-600' : 'text-red-600')}>{reportMsg.text}</span>
            )}
          </div>

          {/* Progress Log */}
          {aiQcLog.length > 0 && (
            <div className="bg-slate-900 rounded-2xl overflow-hidden">
              <div className="px-4 py-2 border-b border-slate-700 flex items-center justify-between">
                <span className="text-xs font-medium text-slate-300">Log</span>
                <button onClick={() => setAiQcLog([])} className="text-xs text-slate-500 hover:text-slate-300 transition-colors">Xóa</button>
              </div>
              <div className="px-4 py-3 max-h-48 overflow-y-auto font-mono text-[11px] text-slate-300 space-y-0.5">
                {aiQcLog.map((line, i) => (
                  <div key={i} className={clsx(
                    line.startsWith('✔') && 'text-emerald-400',
                    line.startsWith('  ✓') && 'text-emerald-300',
                    line.startsWith('  ✗') && 'text-red-400',
                    line.startsWith('✗') && 'text-red-400',
                    line.startsWith('  ⟳') && 'text-amber-400',
                  line.startsWith('▶') && 'text-violet-300',
                  )}>{line}</div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          )}

          {/* Results */}
          {Object.keys(aiQcResults).length > 0 && (
            <div className="bg-white border border-border rounded-2xl shadow-card overflow-hidden">
              <div className="px-5 py-3 border-b border-border">
                <span className="text-sm font-semibold text-slate-700">Kết quả</span>
              </div>
              <div className="divide-y divide-slate-50">
                {Object.entries(aiQcResults).map(([unitName, dates]) => {
                  const s = getUnitStats(unitName);
                  const expanded = expandedUnits.has(unitName);
                  return (
                    <div key={unitName}>
                      <button
                        onClick={() => setExpandedUnits(prev => {
                          const next = new Set(prev);
                          if (next.has(unitName)) next.delete(unitName); else next.add(unitName);
                          return next;
                        })}
                        className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-slate-50 transition-colors"
                      >
                        <span className="font-medium text-sm text-slate-700 flex-1">{unitName}</span>
                        <span className="text-xs text-slate-400">{s.dateCount} ngày · {s.totalImgs} ảnh</span>
                        <span className={clsx('text-xs font-semibold', s.passCount === s.totalImgs ? 'text-emerald-600' : 'text-amber-600')}>
                          {s.passCount}đ / {s.failCount}k
                        </span>
                        {expanded ? <ChevronUp size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
                      </button>

                      {expanded && (
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs border-t border-slate-100">
                            <thead>
                              <tr className="bg-slate-50">
                                <th className="text-left px-4 py-2 font-semibold text-slate-500">Ngày</th>
                                <th className="text-left px-4 py-2 font-semibold text-slate-500">Tên ảnh</th>
                                <th className="px-4 py-2 font-semibold text-slate-500">Trạng thái</th>
                                <th className="text-left px-4 py-2 font-semibold text-slate-500">Loại lỗi</th>
                                <th className="text-left px-4 py-2 font-semibold text-slate-500">Mạng</th>
                                <th className="text-left px-4 py-2 font-semibold text-slate-500 max-w-[200px]">Lý do</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                              {Object.entries(dates).sort(([a], [b]) => a.localeCompare(b)).flatMap(([date, result]) =>
                                (result.detailed_report || []).map((r, ri) => (
                                  <tr key={`${date}-${ri}`} className="hover:bg-slate-50/50">
                                    <td className="px-4 py-2 text-slate-400 font-mono">{date}</td>
                                    <td className="px-4 py-2 font-mono text-slate-600 truncate max-w-[160px]" title={r.api_file_name}>{r.api_file_name}</td>
                                    <td className="px-4 py-2 text-center">
                                      <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium', r.status === 'ĐẠT' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-600')}>
                                        {r.status === 'ĐẠT' ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
                                        {r.status}
                                      </span>
                                    </td>
                                    <td className="px-4 py-2 text-slate-500">{r.error_type || '—'}</td>
                                    <td className="px-4 py-2 text-slate-500">{r.extracted_info?.network || '—'}</td>
                                    <td className="px-4 py-2 text-slate-400 max-w-[200px] truncate" title={r.reason}>{r.reason || '—'}</td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
    </div>
  );
}
