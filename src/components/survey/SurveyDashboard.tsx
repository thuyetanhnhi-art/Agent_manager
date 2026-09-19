import { useState, useMemo } from 'react';
import {
  BarChart3, Users, Building2, Download, Globe2, Search, CheckCircle,
  XCircle, ArrowLeft, Sparkles, Grid, FileSpreadsheet, Trash2,
} from 'lucide-react';
import clsx from 'clsx';
import { Survey, SurveyResponse } from '../../surveyTypes';
import { ALL_OFFICES, REGION_ZONES_2026, ZONE_COLOR_CLASSES } from '../../data/offices';

interface Props {
  survey: Survey;
  responses: SurveyResponse[];
  onBack: () => void;
  onSimulate: (count: number) => void;
  onClear: () => void;
}

export function SurveyDashboard({ survey, responses, onBack, onSimulate, onClear }: Props) {
  const [tab, setTab] = useState<'analytics' | 'offices'>('analytics');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'done' | 'pending'>('all');
  const [regionFilter, setRegionFilter] = useState('All');

  const surveyResponses = useMemo(() => responses.filter(r => r.surveyId === survey.id), [responses, survey.id]);
  const submittedIds = useMemo(() => new Set(surveyResponses.map(r => r.officeId)), [surveyResponses]);
  const total = ALL_OFFICES.length;
  const done = submittedIds.size;
  const pending = total - done;
  const pct = ((done / total) * 100).toFixed(1);

  const regionStats = useMemo(() => {
    const map: Record<string, { total: number; done: number }> = {};
    REGION_ZONES_2026.forEach(z => { map[z.name] = { total: 0, done: 0 }; });
    ALL_OFFICES.forEach(o => {
      if (map[o.region]) {
        map[o.region].total++;
        if (submittedIds.has(o.id)) map[o.region].done++;
      }
    });
    return REGION_ZONES_2026.map(z => ({ name: z.name, ...map[z.name], pct: map[z.name].total > 0 ? ((map[z.name].done / map[z.name].total) * 100).toFixed(1) : '0.0' }));
  }, [submittedIds]);

  const provinceStats = useMemo(() => {
    const map: Record<string, { total: number; done: number; region: string }> = {};
    ALL_OFFICES.forEach(o => {
      if (!map[o.province]) map[o.province] = { total: 0, done: 0, region: o.region };
      map[o.province].total++;
      if (submittedIds.has(o.id)) map[o.province].done++;
    });
    return Object.entries(map).map(([prov, d]) => ({ prov, ...d, pct: ((d.done / d.total) * 100).toFixed(1) })).sort((a, b) => b.total - a.total).slice(0, 10);
  }, [submittedIds]);

  const questionAnalytics = useMemo(() => {
    return survey.questions.map(q => {
      if (q.type === 'text' || q.type === 'paragraph') {
        const samples = surveyResponses.map(r => r.answers[q.id] as string).filter(v => v?.trim()).slice(0, 15);
        return { q, kind: 'text' as const, samples };
      }
      if (q.type === 'radio' || q.type === 'select') {
        const counts: Record<string, number> = {};
        q.options?.forEach(o => { counts[o] = 0; });
        let answered = 0;
        surveyResponses.forEach(r => { const a = r.answers[q.id] as string; if (a && counts[a] !== undefined) { counts[a]++; answered++; } });
        const breakdowns = (q.options || []).map(o => ({ label: o, count: counts[o], pct: answered > 0 ? parseFloat(((counts[o] / answered) * 100).toFixed(1)) : 0 }));
        return { q, kind: 'choice' as const, answered, breakdowns };
      }
      if (q.type === 'checkbox') {
        const counts: Record<string, number> = {};
        q.options?.forEach(o => { counts[o] = 0; });
        surveyResponses.forEach(r => { const a = r.answers[q.id] as string[]; if (Array.isArray(a)) a.forEach(x => { if (counts[x] !== undefined) counts[x]++; }); });
        const breakdowns = (q.options || []).map(o => ({ label: o, count: counts[o], pct: surveyResponses.length > 0 ? parseFloat(((counts[o] / surveyResponses.length) * 100).toFixed(1)) : 0 }));
        return { q, kind: 'multi' as const, total: surveyResponses.length, breakdowns };
      }
      if (q.type === 'rating') {
        const counts = [0, 0, 0, 0, 0];
        let totalScore = 0, ratingCount = 0;
        surveyResponses.forEach(r => { const v = r.answers[q.id] as number; if (v >= 1 && v <= 5) { counts[v-1]++; totalScore += v; ratingCount++; } });
        const avg = ratingCount > 0 ? (totalScore / ratingCount).toFixed(1) : '0.0';
        const dist = [5,4,3,2,1].map(s => ({ s, count: counts[s-1], pct: ratingCount > 0 ? parseFloat(((counts[s-1]/ratingCount)*100).toFixed(1)) : 0 }));
        return { q, kind: 'rating' as const, ratingCount, avg, dist };
      }
      return { q, kind: 'unknown' as const };
    });
  }, [survey, surveyResponses]);

  const trackedOffices = useMemo(() => ALL_OFFICES.map(o => {
    const r = surveyResponses.find(r => r.officeId === o.id);
    return { ...o, submitted: !!r, submittedAt: r ? new Date(r.submittedAt).toLocaleString('vi-VN') : null };
  }), [surveyResponses]);

  const filteredOffices = useMemo(() => {
    let list = trackedOffices;
    if (statusFilter === 'done') list = list.filter(o => o.submitted);
    if (statusFilter === 'pending') list = list.filter(o => !o.submitted);
    if (regionFilter !== 'All') list = list.filter(o => o.region === regionFilter);
    if (search.trim()) { const q = search.toLowerCase(); list = list.filter(o => o.name.toLowerCase().includes(q) || o.code.toLowerCase().includes(q)); }
    return list;
  }, [trackedOffices, statusFilter, regionFilter, search]);

  function exportCSV() {
    if (!surveyResponses.length) { alert('Không có dữ liệu để xuất.'); return; }
    const headers = ['Mã PGD','Tên PGD','Tỉnh/Thành','Vùng','Thời gian nộp',...survey.questions.map(q => `"${q.title.replace(/"/g,'""')}"`)];
    const rows = surveyResponses.map(r => {
      const o = ALL_OFFICES.find(x => x.id === r.officeId);
      return [o?.code||'',o?.name||'',o?.province||'',o?.region||'',new Date(r.submittedAt).toLocaleString('vi-VN'),...survey.questions.map(q => {
        const a = r.answers[q.id];
        return Array.isArray(a) ? `"${a.join(', ')}"` : `"${String(a||'').replace(/"/g,'""')}"`;
      })].join(',');
    });
    const csv = '﻿' + [headers.join(','), ...rows].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = `KhaoSat_${survey.title.replace(/\s+/g,'_')}.csv`;
    a.click();
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-4">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="p-2 text-slate-500 hover:text-slate-800 hover:bg-hover rounded-xl border border-border shadow-card transition-colors"><ArrowLeft size={14} /></button>
          <div>
            <h2 className="text-base font-bold text-slate-800 truncate max-w-sm">Báo cáo: {survey.title}</h2>
            <p className="text-xs text-slate-400">Tạo ngày {new Date(survey.createdAt).toLocaleDateString('vi-VN')}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {surveyResponses.length > 0 ? (
            <>
              <button onClick={exportCSV} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl transition-colors shadow-sm">
                <FileSpreadsheet size={12} /> Xuất CSV
              </button>
              <button onClick={() => onSimulate(ALL_OFFICES.length - done)} disabled={pending === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-primary border border-primary/30 rounded-xl hover:bg-primary/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                <Sparkles size={12} /> Mô phỏng {pending} PGD còn lại
              </button>
              <button onClick={() => confirm('Xóa toàn bộ phản hồi của khảo sát này?') && onClear()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-red-600 border border-red-200 rounded-xl hover:bg-red-50 transition-colors">
                <Trash2 size={12} /> Xóa phản hồi
              </button>
            </>
          ) : (
            <button onClick={() => onSimulate(ALL_OFFICES.length)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold bg-primary text-white rounded-xl hover:bg-primary/90 shadow-sm">
              <Sparkles size={12} className="animate-pulse" /> Mô phỏng {ALL_OFFICES.length} PGD
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { icon: Building2, label: 'Đơn vị mục tiêu', value: total, sub: 'PGD toàn quốc', color: 'text-slate-700' },
          { icon: Users, label: 'Đã nộp', value: done, sub: 'PGD phản hồi', color: 'text-primary' },
          { icon: BarChart3, label: 'Tỉ lệ hoàn thành', value: `${pct}%`, sub: 'Trên chỉ tiêu', color: 'text-primary' },
          { icon: pending === 0 ? CheckCircle : XCircle, label: 'Chưa phản hồi', value: pending, sub: pending === 0 ? '100% hoàn thành!' : 'Cần đôn đốc', color: pending === 0 ? 'text-emerald-600' : 'text-red-500' },
        ].map(({ icon: Icon, label, value, sub, color }) => (
          <div key={label} className="bg-white border border-border rounded-2xl shadow-card p-4 flex items-center gap-3">
            <div className={clsx('p-2.5 rounded-xl border shrink-0', color === 'text-primary' ? 'bg-primary/10 border-primary/20' : color === 'text-emerald-600' ? 'bg-emerald-50 border-emerald-100' : color === 'text-red-500' ? 'bg-red-50 border-red-100' : 'bg-slate-50 border-slate-100')}>
              <Icon size={20} className={color} />
            </div>
            <div>
              <p className="text-[10px] text-slate-400 uppercase font-semibold tracking-wider">{label}</p>
              <p className={clsx('text-2xl font-black mt-0.5', color)}>{value}</p>
              <p className="text-[10px] text-slate-400">{sub}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {(['analytics','offices'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={clsx('px-4 py-2 text-xs font-bold uppercase tracking-wider border-b-2 transition-all', tab === t ? 'border-primary text-primary' : 'border-transparent text-slate-400 hover:text-slate-600')}>
            {t === 'analytics' ? <span className="flex items-center gap-1.5"><BarChart3 size={13} /> Phân tích</span> : <span className="flex items-center gap-1.5"><Users size={13} /> Danh sách PGD ({filteredOffices.length})</span>}
          </button>
        ))}
      </div>

      {/* Analytics */}
      {tab === 'analytics' && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-5 items-start">
          <div className="space-y-4">
            {surveyResponses.length === 0 ? (
              <div className="bg-white border border-border rounded-2xl shadow-card p-10 text-center">
                <BarChart3 size={40} className="text-slate-300 mx-auto mb-3" />
                <p className="font-semibold text-slate-700 text-sm">Chưa có dữ liệu phản hồi</p>
                <p className="text-xs text-slate-400 mt-1">Nhấn <strong>Mô phỏng {ALL_OFFICES.length} PGD</strong> để xem trước báo cáo mẫu.</p>
              </div>
            ) : questionAnalytics.map((a, qi) => {
              if (!a.q) return null;
              return (
                <div key={a.q.id} className="bg-white border border-border rounded-2xl shadow-card p-5 space-y-4">
                  <div className="border-b border-slate-50 pb-3">
                    <span className="text-[10px] font-mono text-primary">Câu hỏi {qi+1}</span>
                    <h4 className="text-sm font-bold text-slate-800 mt-0.5">{a.q.title}</h4>
                    {a.q.description && <p className="text-xs text-slate-400">{a.q.description}</p>}
                  </div>

                  {a.kind === 'choice' && a.breakdowns && (
                    <div className="space-y-3">
                      {a.breakdowns.map((b, bi) => (
                        <div key={bi} className="space-y-1">
                          <div className="flex justify-between text-xs"><span className="font-semibold text-slate-700">{b.label}</span><span className="text-slate-500"><strong>{b.count}</strong> ({b.pct}%)</span></div>
                          <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-primary rounded-full transition-all" style={{ width: `${b.pct}%` }} /></div>
                        </div>
                      ))}
                    </div>
                  )}

                  {a.kind === 'multi' && a.breakdowns && (
                    <div className="space-y-3">
                      <p className="text-[10px] text-slate-400">* Tỉ lệ trên tổng {a.total} phiếu (một phiếu có thể chọn nhiều)</p>
                      {a.breakdowns.map((b, bi) => (
                        <div key={bi} className="space-y-1">
                          <div className="flex justify-between text-xs"><span className="font-semibold text-slate-700">{b.label}</span><span className="text-slate-500"><strong>{b.count}</strong> ({b.pct}%)</span></div>
                          <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-violet-500 rounded-full transition-all" style={{ width: `${b.pct}%` }} /></div>
                        </div>
                      ))}
                    </div>
                  )}

                  {a.kind === 'rating' && a.dist && (
                    <div className="grid grid-cols-[auto_1fr] gap-6 items-center">
                      <div className="text-center py-4 px-6 bg-amber-50 border border-amber-100 rounded-2xl">
                        <p className="text-[10px] font-bold text-amber-700 uppercase tracking-wide">Điểm TB</p>
                        <p className="text-4xl font-black text-amber-600 mt-1">{a.avg}</p>
                        <div className="flex justify-center text-amber-400 mt-1 text-lg">{[1,2,3,4,5].map(s => parseFloat(a.avg||'0') >= s ? '★' : '☆')}</div>
                        <p className="text-[10px] text-slate-400 mt-1">{a.ratingCount} lượt</p>
                      </div>
                      <div className="space-y-1.5">
                        {a.dist.map(d => (
                          <div key={d.s} className="flex items-center gap-2 text-xs">
                            <span className="w-8 text-right text-slate-500 shrink-0">{d.s}★</span>
                            <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-amber-400 rounded-full transition-all" style={{ width: `${d.pct}%` }} /></div>
                            <span className="w-20 text-slate-400 shrink-0">{d.count} ({d.pct}%)</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {a.kind === 'text' && a.samples && (
                    <div className="space-y-2">
                      <p className="text-[10px] text-slate-400">{a.samples.length} câu trả lời gần nhất:</p>
                      <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
                        {a.samples.map((s, si) => <div key={si} className="p-2.5 bg-slate-50 border border-slate-100 rounded-xl text-xs text-slate-700">{s}</div>)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Right: region + province */}
          <div className="space-y-4">
            <div className="bg-white border border-border rounded-2xl shadow-card p-5 space-y-3">
              <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2"><Globe2 size={14} className="text-primary" /> Hoàn thành theo vùng</h3>
              <div className="space-y-3">
                {regionStats.map(r => (
                  <div key={r.name} className="space-y-1">
                    <div className="flex justify-between text-xs"><span className="font-semibold text-slate-700">{r.name}</span><span className="text-slate-400">{r.done}/{r.total} ({r.pct}%)</span></div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className={clsx('h-full rounded-full transition-all', ZONE_COLOR_CLASSES[r.name as keyof typeof ZONE_COLOR_CLASSES]?.bar || 'bg-primary')} style={{ width: `${r.pct}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white border border-border rounded-2xl shadow-card p-5 space-y-3">
              <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2"><Grid size={14} className="text-primary" /> Top 10 Tỉnh/Thành</h3>
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {provinceStats.map(p => (
                  <div key={p.prov} className="flex items-center justify-between py-1.5 border-b border-slate-50 text-xs">
                    <div>
                      <p className="font-semibold text-slate-700">{p.prov}</p>
                      <p className="text-[10px] text-slate-400">{p.region}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-slate-800">{p.done}/{p.total}</p>
                      <p className="text-[10px] text-slate-500">({p.pct}%)</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PGD roster */}
      {tab === 'offices' && (
        <div className="bg-white border border-border rounded-2xl shadow-card overflow-hidden">
          <div className="p-4 border-b border-border bg-slate-50/40 flex flex-wrap gap-2">
            <div className="relative flex-1 min-w-40">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Tìm PGD..."
                className="w-full pl-8 pr-3 py-2 text-xs border border-slate-200 rounded-xl outline-none focus:border-violet-400 bg-white" />
            </div>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as 'all'|'done'|'pending')}
              className="border border-slate-200 rounded-xl px-3 py-2 text-xs bg-white outline-none text-slate-700">
              <option value="all">Tất cả</option>
              <option value="done">Đã nộp ({done})</option>
              <option value="pending">Chưa nộp ({pending})</option>
            </select>
            <select value={regionFilter} onChange={e => setRegionFilter(e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-xs bg-white outline-none text-slate-700">
              <option value="All">Tất cả vùng</option>
              {regionStats.map(r => <option key={r.name} value={r.name}>{r.name} ({r.total})</option>)}
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-[10px] text-slate-400 uppercase tracking-wider">
                <tr>{['Mã PGD','Tên PGD','Tỉnh/Thành','Vùng','Trạng thái','Thời gian nộp'].map(h => <th key={h} className="py-3 px-4 text-left font-semibold">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filteredOffices.length === 0 ? (
                  <tr><td colSpan={6} className="py-10 text-center text-slate-400">Không có kết quả</td></tr>
                ) : filteredOffices.slice(0, 150).map(o => (
                  <tr key={o.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="py-2.5 px-4 font-mono font-bold text-slate-500">{o.code}</td>
                    <td className="py-2.5 px-4 font-semibold text-slate-800">{o.name}</td>
                    <td className="py-2.5 px-4 text-slate-600">{o.province}</td>
                    <td className="py-2.5 px-4">
                      <span className={clsx('px-2 py-0.5 rounded text-[10px] font-bold', ZONE_COLOR_CLASSES[o.region as keyof typeof ZONE_COLOR_CLASSES]?.badgeBg, ZONE_COLOR_CLASSES[o.region as keyof typeof ZONE_COLOR_CLASSES]?.badgeText)}>
                        {o.region}
                      </span>
                    </td>
                    <td className="py-2.5 px-4">
                      {o.submitted
                        ? <span className="flex items-center gap-1 text-emerald-700 font-semibold"><CheckCircle size={12} className="text-emerald-500" /> Đã nộp</span>
                        : <span className="flex items-center gap-1 text-slate-400"><XCircle size={12} className="text-slate-300" /> Chưa nộp</span>}
                    </td>
                    <td className="py-2.5 px-4 text-slate-400">{o.submittedAt || '--'}</td>
                  </tr>
                ))}
                {filteredOffices.length > 150 && (
                  <tr><td colSpan={6} className="py-3 px-4 text-center text-slate-400 italic text-[11px]">Đang hiển thị 150/{filteredOffices.length} kết quả — tìm kiếm để xem cụ thể</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
