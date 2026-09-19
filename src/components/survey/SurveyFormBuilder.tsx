import { useState } from 'react';
import {
  Plus, Trash2, ChevronUp, ChevronDown, Type, AlignLeft,
  CheckSquare, List, Star, HelpCircle, Settings, Check, AlertCircle,
} from 'lucide-react';
import clsx from 'clsx';
import { SurveyQuestion, QuestionType, Survey } from '../../surveyTypes';

interface Props {
  initialSurvey?: Survey;
  onSave: (survey: Survey) => void;
  onCancel: () => void;
}

const TYPE_LABELS: Record<QuestionType, string> = {
  text: 'Trả lời ngắn',
  paragraph: 'Đoạn văn',
  radio: 'Trắc nghiệm',
  checkbox: 'Hộp kiểm',
  select: 'Thả xuống',
  rating: 'Xếp hạng sao',
};

export function SurveyFormBuilder({ initialSurvey, onSave, onCancel }: Props) {
  const [title, setTitle] = useState(initialSurvey?.title || '');
  const [description, setDescription] = useState(initialSurvey?.description || '');
  const [questions, setQuestions] = useState<SurveyQuestion[]>(
    initialSurvey?.questions.length ? initialSurvey.questions : [
      { id: 'q1', type: 'text', title: 'Họ và tên người thực hiện khảo sát', required: true },
    ]
  );
  const [activeId, setActiveId] = useState<string | null>(questions[0]?.id ?? null);
  const [deadline, setDeadline] = useState(initialSurvey?.deadline || '');
  const [formsLink, setFormsLink] = useState(initialSurvey?.formsLink || '');
  const [sheetUrl, setSheetUrl] = useState(initialSurvey?.sheetUrl || '');

  function addQuestion(type: QuestionType) {
    const id = `q-${Date.now()}`;
    const q: SurveyQuestion = {
      id, type, title: type === 'rating' ? 'Đánh giá chất lượng dịch vụ' : 'Câu hỏi mới',
      required: false,
      options: ['radio', 'checkbox', 'select'].includes(type) ? ['Tùy chọn 1', 'Tùy chọn 2'] : undefined,
      ratingMax: type === 'rating' ? 5 : undefined,
    };
    setQuestions(prev => [...prev, q]);
    setActiveId(id);
  }

  function updateQ(id: string, patch: Partial<SurveyQuestion>) {
    setQuestions(prev => prev.map(q => q.id === id ? { ...q, ...patch } : q));
  }

  function deleteQ(id: string) {
    if (questions.length <= 1) { alert('Cần ít nhất 1 câu hỏi.'); return; }
    const idx = questions.findIndex(q => q.id === id);
    const next = questions.filter(q => q.id !== id);
    setQuestions(next);
    if (activeId === id) setActiveId(next[Math.max(0, idx - 1)]?.id ?? null);
  }

  function moveQ(index: number, dir: 'up' | 'down') {
    if (dir === 'up' && index === 0) return;
    if (dir === 'down' && index === questions.length - 1) return;
    const arr = [...questions];
    const target = dir === 'up' ? index - 1 : index + 1;
    [arr[index], arr[target]] = [arr[target], arr[index]];
    setQuestions(arr);
  }

  function addOption(qId: string) {
    const q = questions.find(q => q.id === qId);
    if (!q) return;
    updateQ(qId, { options: [...(q.options || []), `Tùy chọn ${(q.options?.length || 0) + 1}`] });
  }

  function updateOption(qId: string, idx: number, text: string) {
    const q = questions.find(q => q.id === qId);
    if (!q?.options) return;
    const opts = [...q.options];
    opts[idx] = text;
    updateQ(qId, { options: opts });
  }

  function deleteOption(qId: string, idx: number) {
    const q = questions.find(q => q.id === qId);
    if (!q?.options || q.options.length <= 1) { alert('Cần ít nhất 1 tùy chọn.'); return; }
    updateQ(qId, { options: q.options.filter((_, i) => i !== idx) });
  }

  function handleSave() {
    if (!title.trim()) { alert('Vui lòng nhập tiêu đề khảo sát.'); return; }
    if (questions.some(q => !q.title.trim())) { alert('Vui lòng điền tiêu đề cho tất cả câu hỏi.'); return; }
    const now = new Date().toISOString();
    onSave({
      id: initialSurvey?.id || `survey-${Date.now()}`,
      title: title.trim(),
      description: description.trim(),
      createdAt: initialSurvey?.createdAt || now,
      updatedAt: now,
      active: true,
      questions,
      deadline: deadline || undefined,
      formsLink: formsLink || undefined,
      sheetUrl: sheetUrl || undefined,
      targetPGDs: initialSurvey?.targetPGDs,
      sentAt: initialSurvey?.sentAt,
    });
  }

  return (
    <div className="space-y-6">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div className="flex items-center gap-2">
          <span className="p-2 bg-primary/10 text-primary rounded-xl"><Settings size={18} /></span>
          <div>
            <h2 className="text-base font-bold text-slate-800">{initialSurvey ? 'Chỉnh sửa khảo sát' : 'Thiết kế khảo sát mới'}</h2>
            <p className="text-xs text-slate-500">Tạo form câu hỏi linh hoạt tương tự Google Forms</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-border rounded-xl hover:bg-hover">Hủy</button>
          <button onClick={handleSave} className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-primary rounded-xl hover:bg-primary/90 shadow-sm">
            <Check size={13} /> Lưu khảo sát
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-6 items-start">
        {/* Main column */}
        <div className="space-y-4">
          {/* Survey header card */}
          <div className="bg-white border border-border rounded-2xl shadow-card overflow-hidden">
            <div className="h-1.5 bg-gradient-to-r from-violet-500 to-indigo-500" />
            <div className="p-5 space-y-3">
              <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Tiêu đề khảo sát *"
                className="w-full text-xl font-bold text-slate-900 placeholder-slate-300 outline-none border-b border-transparent focus:border-primary pb-1 transition-colors" />
              <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Mô tả khảo sát..." rows={2}
                className="w-full text-sm text-slate-600 placeholder-slate-300 outline-none resize-none border-b border-transparent focus:border-slate-200 transition-colors" />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                <label>
                  <span className="text-xs text-slate-500 block mb-1">Thời hạn</span>
                  <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
                    className="w-full border border-slate-200 focus:border-violet-400 rounded-xl px-3 py-1.5 text-xs outline-none" />
                </label>
                <label>
                  <span className="text-xs text-slate-500 block mb-1">Link Forms</span>
                  <input value={formsLink} onChange={e => setFormsLink(e.target.value)} placeholder="https://forms.gle/..."
                    className="w-full border border-slate-200 focus:border-violet-400 rounded-xl px-3 py-1.5 text-xs font-mono placeholder-slate-400 outline-none" />
                </label>
                <label>
                  <span className="text-xs text-slate-500 block mb-1">Google Sheet phản hồi</span>
                  <input value={sheetUrl} onChange={e => setSheetUrl(e.target.value)} placeholder="https://docs.google.com/..."
                    className="w-full border border-slate-200 focus:border-violet-400 rounded-xl px-3 py-1.5 text-xs font-mono placeholder-slate-400 outline-none" />
                </label>
              </div>
            </div>
          </div>

          {/* Questions */}
          <div className="space-y-3">
            {questions.map((q, i) => {
              const active = activeId === q.id;
              return (
                <div key={q.id} onClick={() => setActiveId(q.id)}
                  className={clsx('bg-white border rounded-2xl shadow-card transition-all cursor-pointer overflow-hidden', active ? 'ring-2 ring-violet-500/70 border-transparent shadow-md' : 'border-border hover:border-slate-300')}>
                  <div className="p-5 space-y-3">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono text-slate-400">Câu {i + 1}</span>
                          <span className="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded uppercase font-medium">{TYPE_LABELS[q.type]}</span>
                        </div>
                        <input value={q.title} onChange={e => updateQ(q.id, { title: e.target.value })} placeholder="Nhập tiêu đề câu hỏi..."
                          className="w-full font-semibold text-slate-800 text-sm placeholder-slate-300 outline-none border-b border-transparent focus:border-slate-200 py-0.5" />
                        {active && (
                          <input value={q.description || ''} onChange={e => updateQ(q.id, { description: e.target.value })}
                            placeholder="Mô tả thêm / gợi ý (không bắt buộc)..."
                            className="w-full text-xs text-slate-400 placeholder-slate-300 outline-none border-b border-transparent focus:border-slate-100 pb-0.5" />
                        )}
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button onClick={e => { e.stopPropagation(); moveQ(i, 'up'); }} disabled={i === 0} className="p-1 text-slate-300 hover:text-slate-600 rounded disabled:opacity-20"><ChevronUp size={14} /></button>
                        <button onClick={e => { e.stopPropagation(); moveQ(i, 'down'); }} disabled={i === questions.length - 1} className="p-1 text-slate-300 hover:text-slate-600 rounded disabled:opacity-20"><ChevronDown size={14} /></button>
                        <button onClick={e => { e.stopPropagation(); deleteQ(q.id); }} className="p-1 text-slate-300 hover:text-red-500 rounded"><Trash2 size={14} /></button>
                      </div>
                    </div>

                    {/* Question preview */}
                    <div className="pt-1">
                      {q.type === 'text' && <div className="text-xs text-slate-400 border-b border-dashed border-slate-200 pb-1 max-w-xs">Văn bản ngắn</div>}
                      {q.type === 'paragraph' && <div className="text-xs text-slate-400 border-b border-dashed border-slate-200 pb-1">Văn bản nhiều dòng</div>}
                      {q.type === 'rating' && (
                        <div className="flex gap-1 text-amber-300">
                          {[1,2,3,4,5].map(s => <Star key={s} size={20} className="fill-amber-50 stroke-amber-300" />)}
                        </div>
                      )}
                      {['radio','checkbox','select'].includes(q.type) && q.options && (
                        <div className="space-y-1.5 max-w-sm">
                          {q.options.map((opt, oi) => (
                            <div key={oi} className="flex items-center gap-2 group/opt">
                              {q.type === 'radio' && <div className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0" />}
                              {q.type === 'checkbox' && <div className="w-3.5 h-3.5 rounded border border-slate-300 shrink-0" />}
                              {q.type === 'select' && <span className="text-[10px] text-slate-400 w-4">{oi+1}.</span>}
                              <input value={opt} onChange={e => updateOption(q.id, oi, e.target.value)}
                                className="flex-1 text-xs text-slate-700 bg-transparent outline-none border-b border-transparent focus:border-violet-300 py-0.5" />
                              <button onClick={() => deleteOption(q.id, oi)} className="opacity-0 group-hover/opt:opacity-100 p-0.5 text-slate-300 hover:text-red-400 rounded"><Trash2 size={11} /></button>
                            </div>
                          ))}
                          {active && (
                            <button onClick={() => addOption(q.id)} className="flex items-center gap-1 text-xs text-primary hover:underline mt-1"><Plus size={11} /> Thêm tùy chọn</button>
                          )}
                        </div>
                      )}
                    </div>

                    {active && (
                      <div className="pt-2 border-t border-slate-50 flex items-center justify-end">
                        <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none">
                          <input type="checkbox" checked={q.required} onChange={e => updateQ(q.id, { required: e.target.checked })}
                            className="w-3.5 h-3.5 accent-primary rounded" />
                          Bắt buộc
                        </label>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right toolbar */}
        <div className="space-y-3 lg:sticky lg:top-4">
          <div className="bg-white border border-border rounded-2xl shadow-card p-4 space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-3">Thêm loại câu hỏi</p>
            {([['text','Trả lời ngắn',Type],['paragraph','Đoạn văn tự do',AlignLeft],['radio','Trắc nghiệm (Radio)',HelpCircle],['checkbox','Hộp kiểm',CheckSquare],['select','Thả chọn (Dropdown)',List],['rating','Xếp hạng sao',Star]] as [QuestionType, string, React.ElementType][]).map(([type, label, Icon]) => (
              <button key={type} onClick={() => addQuestion(type)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-100 hover:border-violet-100 hover:bg-primary/5 text-xs text-slate-700 font-medium transition-all text-left group">
                <Icon size={13} className="text-slate-400 group-hover:text-primary shrink-0" />
                {label}
              </button>
            ))}
          </div>
          <div className="bg-amber-50 border border-amber-100 rounded-2xl p-3 text-xs text-amber-800 space-y-1.5">
            <div className="flex items-center gap-1.5 font-semibold"><AlertCircle size={12} /> Gợi ý</div>
            <p className="leading-relaxed">Click vào thẻ câu hỏi để chỉnh sửa. Nhấn <strong>Lưu</strong> để tạo hoặc cập nhật khảo sát.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
