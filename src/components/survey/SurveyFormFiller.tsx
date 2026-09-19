import { useState, useMemo } from 'react';
import {
  Building2, MapPin, CheckCircle, ArrowLeft, Search,
  ChevronRight, FileText, Star, CheckCircle2, AlertCircle,
} from 'lucide-react';
import { Survey, SurveyResponse, TransactionOffice } from '../../surveyTypes';
import { ALL_OFFICES, REGION_ZONES_2026 } from '../../data/offices';

interface Props {
  survey: Survey;
  existingResponses: SurveyResponse[];
  onSubmit: (surveyId: string, officeId: string, answers: Record<string, string | string[] | number>) => void;
  onBack: () => void;
}

export function SurveyFormFiller({ survey, existingResponses, onSubmit, onBack }: Props) {
  const [selectedOffice, setSelectedOffice] = useState<TransactionOffice | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [regionFilter, setRegionFilter] = useState('All');
  const [provinceFilter, setProvinceFilter] = useState('All');
  const [answers, setAnswers] = useState<Record<string, string | string[] | number>>({});
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const allProvinces = useMemo(() => [...new Set(ALL_OFFICES.map(o => o.province))].sort(), []);

  const { filtered, total } = useMemo(() => {
    let list = ALL_OFFICES;
    if (regionFilter !== 'All') list = list.filter(o => o.region === regionFilter);
    if (provinceFilter !== 'All') list = list.filter(o => o.province === provinceFilter);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(o => o.name.toLowerCase().includes(q) || o.code.toLowerCase().includes(q) || o.province.toLowerCase().includes(q));
    }
    return { filtered: list.slice(0, 100), total: list.length };
  }, [searchQuery, regionFilter, provinceFilter]);

  function setAnswer(id: string, value: string | string[] | number) {
    setAnswers(prev => ({ ...prev, [id]: value }));
    setErrors(prev => prev.filter(e => e !== id));
  }

  function toggleCheckbox(id: string, opt: string, checked: boolean) {
    const cur = (answers[id] as string[]) || [];
    setAnswer(id, checked ? [...cur, opt] : cur.filter(o => o !== opt));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedOffice) return;
    const errs = survey.questions.filter(q => {
      if (!q.required) return false;
      const a = answers[q.id];
      return a === undefined || a === null || a === '' || (Array.isArray(a) && a.length === 0);
    }).map(q => q.id);
    if (errs.length) {
      setErrors(errs);
      document.getElementById(`q-${errs[0]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    onSubmit(survey.id, selectedOffice.id, answers);
    setSubmitted(true);
  }

  if (submitted && selectedOffice) {
    return (
      <div className="max-w-lg mx-auto py-12 text-center space-y-5">
        <div className="inline-flex p-4 bg-emerald-50 rounded-full border border-emerald-100 text-emerald-600">
          <CheckCircle2 size={44} />
        </div>
        <h2 className="text-xl font-bold text-slate-900">Nộp khảo sát thành công!</h2>
        <div className="bg-slate-50 border border-border rounded-2xl p-5 text-left space-y-2 text-xs">
          <p className="font-semibold text-slate-800">{selectedOffice.name}</p>
          <p className="text-slate-500">Mã: {selectedOffice.code} · {selectedOffice.province} · {selectedOffice.region}</p>
          <div className="border-t border-slate-100 pt-2 mt-2 text-slate-500">
            <div className="flex justify-between"><span>Khảo sát:</span><span className="font-medium text-slate-700 max-w-[200px] truncate">{survey.title}</span></div>
            <div className="flex justify-between mt-1"><span>Thời gian:</span><span className="font-medium text-slate-700">{new Date().toLocaleString('vi-VN')}</span></div>
          </div>
        </div>
        <div className="flex gap-2 justify-center pt-2">
          <button onClick={onBack} className="px-4 py-2 text-xs font-medium border border-border rounded-xl text-slate-600 hover:bg-hover">Quay lại danh sách</button>
          <button onClick={() => { setSelectedOffice(null); setAnswers({}); setSubmitted(false); setErrors([]); setSearchQuery(''); }}
            className="px-4 py-2 text-xs font-semibold bg-primary text-white rounded-xl hover:bg-primary/90">Điền lại</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 font-medium">
          <ArrowLeft size={14} /> Quay lại danh sách
        </button>
        {selectedOffice && (
          <button onClick={() => setSelectedOffice(null)} className="text-xs text-primary hover:underline">Thay đổi PGD</button>
        )}
      </div>

      {/* Survey title */}
      <div className="bg-white border border-border rounded-2xl shadow-card p-5 relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-violet-500 to-indigo-500" />
        <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2 mt-1">
          <FileText size={20} className="text-primary shrink-0" /> {survey.title}
        </h2>
        {survey.description && <p className="text-sm text-slate-600 mt-2">{survey.description}</p>}
        {selectedOffice && (
          <div className="mt-3 px-3 py-2 bg-primary/5 border border-primary/20 rounded-xl flex items-center gap-2">
            <Building2 size={14} className="text-primary shrink-0" />
            <span className="text-xs text-slate-700"><strong>{selectedOffice.name}</strong> <span className="text-slate-400">({selectedOffice.code} · {selectedOffice.province})</span></span>
          </div>
        )}
      </div>

      {/* Step 1: Select PGD */}
      {!selectedOffice ? (
        <div className="bg-white border border-border rounded-2xl shadow-card p-5 space-y-4">
          <div>
            <h3 className="font-bold text-slate-800 flex items-center gap-2"><Building2 size={16} className="text-slate-400" /> Bước 1: Chọn Phòng Giao Dịch của bạn</h3>
            <p className="text-xs text-slate-500 mt-0.5">Hệ thống quản lý {ALL_OFFICES.length} PGD toàn quốc. Chọn chính xác đơn vị của bạn.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Tìm PGD (tên hoặc mã)..."
                className="w-full pl-8 pr-3 py-2 text-xs border border-slate-200 rounded-xl outline-none focus:border-violet-400" />
            </div>
            <select value={regionFilter} onChange={e => { setRegionFilter(e.target.value); setProvinceFilter('All'); }}
              className="border border-slate-200 rounded-xl px-3 py-2 text-xs bg-white outline-none text-slate-700">
              <option value="All">Tất cả vùng</option>
              {REGION_ZONES_2026.map(z => <option key={z.name} value={z.name}>{z.name}</option>)}
            </select>
            <select value={provinceFilter} onChange={e => setProvinceFilter(e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-xs bg-white outline-none text-slate-700">
              <option value="All">Tất cả tỉnh/thành</option>
              {allProvinces.filter(p => regionFilter === 'All' || ALL_OFFICES.filter(o => o.province === p).some(o => o.region === regionFilter)).map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>

          <div>
            <p className="text-[11px] text-slate-400 mb-2">Hiển thị {filtered.length}/{total} PGD khớp</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-72 overflow-y-auto border border-slate-100 rounded-xl p-2 bg-slate-50/50">
              {filtered.length === 0 ? (
                <div className="col-span-2 py-6 text-center text-xs text-slate-400">Không tìm thấy PGD nào</div>
              ) : filtered.map(office => {
                const hasDone = existingResponses.some(r => r.officeId === office.id);
                return (
                  <button key={office.id} type="button" onClick={() => setSelectedOffice(office)}
                    className="flex items-center justify-between p-2.5 bg-white border border-slate-200 hover:border-violet-300 hover:bg-primary/5 rounded-xl transition-all text-left group shadow-sm">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-mono bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-bold">{office.code}</span>
                        <span className="text-xs font-semibold text-slate-800 group-hover:text-primary">{office.name}</span>
                      </div>
                      <div className="flex items-center gap-1 mt-0.5 text-[11px] text-slate-400">
                        <MapPin size={10} /> {office.province}
                      </div>
                    </div>
                    {hasDone ? (
                      <span className="flex items-center gap-1 text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full font-medium shrink-0">
                        <CheckCircle size={9} /> Đã nộp
                      </span>
                    ) : (
                      <ChevronRight size={14} className="text-slate-300 group-hover:text-primary shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        /* Step 2: Fill questions */
        <form onSubmit={handleSubmit} className="space-y-4">
          {survey.questions.map((q, i) => {
            const isErr = errors.includes(q.id);
            const ans = answers[q.id];
            return (
              <div key={q.id} id={`q-${q.id}`}
                className={`bg-white border rounded-2xl p-5 shadow-card space-y-3 transition-all ${isErr ? 'border-red-300 ring-2 ring-red-100' : 'border-border'}`}>
                <div>
                  <label className="text-sm font-bold text-slate-800">
                    {i+1}. {q.title}{q.required && <span className="text-red-500 ml-0.5">*</span>}
                  </label>
                  {q.description && <p className="text-xs text-slate-500 mt-0.5">{q.description}</p>}
                </div>
                <div className="pt-1">
                  {q.type === 'text' && (
                    <input value={(ans as string) || ''} onChange={e => setAnswer(q.id, e.target.value)} placeholder="Nhập câu trả lời..."
                      className="w-full max-w-lg px-3 py-2 text-sm border border-slate-200 rounded-xl outline-none focus:border-violet-400" />
                  )}
                  {q.type === 'paragraph' && (
                    <textarea value={(ans as string) || ''} onChange={e => setAnswer(q.id, e.target.value)} placeholder="Nhập câu trả lời dài..." rows={3}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl outline-none focus:border-violet-400 resize-y" />
                  )}
                  {q.type === 'radio' && q.options && (
                    <div className="space-y-2">
                      {q.options.map((opt, oi) => (
                        <label key={oi} className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer group select-none">
                          <input type="radio" name={`q-${q.id}`} checked={ans === opt} onChange={() => setAnswer(q.id, opt)} className="accent-primary" />
                          <span className="group-hover:text-slate-900 font-medium">{opt}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  {q.type === 'checkbox' && q.options && (
                    <div className="space-y-2">
                      {q.options.map((opt, oi) => {
                        const checked = ((ans as string[]) || []).includes(opt);
                        return (
                          <label key={oi} className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer group select-none">
                            <input type="checkbox" checked={checked} onChange={e => toggleCheckbox(q.id, opt, e.target.checked)} className="accent-primary rounded" />
                            <span className="group-hover:text-slate-900 font-medium">{opt}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {q.type === 'select' && q.options && (
                    <select value={(ans as string) || ''} onChange={e => setAnswer(q.id, e.target.value)}
                      className="w-full max-w-xs px-3 py-2 text-sm border border-slate-200 rounded-xl outline-none focus:border-violet-400 bg-white">
                      <option value="">-- Chọn một --</option>
                      {q.options.map((opt, oi) => <option key={oi} value={opt}>{opt}</option>)}
                    </select>
                  )}
                  {q.type === 'rating' && (
                    <div className="flex items-center gap-1.5">
                      {[1,2,3,4,5].map(s => (
                        <button key={s} type="button" onClick={() => setAnswer(q.id, s)} className="p-0.5 text-slate-300 hover:text-amber-400 transition-colors">
                          <Star size={26} className={(ans as number) >= s ? 'fill-amber-400 stroke-amber-400' : 'stroke-slate-300 fill-slate-50'} />
                        </button>
                      ))}
                      {ans && <span className="text-xs text-amber-700 bg-amber-50 border border-amber-100 px-2 py-0.5 rounded-full font-semibold ml-1">{ans}/5 điểm</span>}
                    </div>
                  )}
                </div>
                {isErr && <div className="flex items-center gap-1 text-xs text-red-600 font-medium"><AlertCircle size={11} /> Trường bắt buộc không được để trống.</div>}
              </div>
            );
          })}

          <div className="bg-slate-50 border border-border rounded-2xl p-4 flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500"><span className="text-red-500">*</span> Trường bắt buộc. Nộp dưới danh nghĩa <strong>{selectedOffice.name}</strong>.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setSelectedOffice(null)} className="px-3 py-1.5 text-xs font-medium border border-border rounded-xl text-slate-600 hover:bg-hover">Quay lại</button>
              <button type="submit" className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-bold bg-primary text-white rounded-xl hover:bg-primary/90 shadow-sm">
                <CheckCircle size={13} /> Gửi khảo sát
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
