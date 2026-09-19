import { useState, useEffect } from 'react';
import { useNavigate, useMatch } from 'react-router-dom';
import { Plus, FileText, Users, BarChart2, Edit3, Trash2, Sparkles, Download, Upload, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { Header } from '../components/Header';
import { SurveyFormBuilder } from '../components/survey/SurveyFormBuilder';
import { SurveyFormFiller } from '../components/survey/SurveyFormFiller';
import { SurveyDashboard } from '../components/survey/SurveyDashboard';
import { Survey, SurveyResponse } from '../surveyTypes';
import { ALL_OFFICES } from '../data/offices';

// ─── Mock data for simulation engine ─────────────────────────────────────────

const MOCK_NAMES = [
  'Nguyễn Văn Hùng','Trần Thị Mai','Phạm Minh Đức','Lê Tuấn Anh','Vũ Hồng Nhung',
  'Bùi Quang Huy','Hoàng Thanh Thảo','Phan Văn Sơn','Đỗ Quốc Việt','Ngô Thu Trang',
  'Dương Anh Tuấn','Lý Gia Bảo','Đinh Tiến Đạt','Trịnh Khánh Linh','Mai Phương Thảo',
];
const MOCK_COMMENTS = [
  'Hệ thống mượt mà hơn bản cũ nhiều, giao dịch viên rất phấn khởi.',
  'Cần cải thiện tốc độ tải phân hệ báo cáo cuối ngày.',
  'Thỉnh thoảng bị lỗi ngắt kết nối đột ngột khi in chứng từ.',
  'Giao diện trực quan, dễ thao tác, thời gian nhập liệu được rút ngắn.',
  'Đề xuất có thêm tài liệu hướng dẫn nhanh dán ở quầy.',
  'Hệ thống đôi khi bị trễ vào khung giờ cao điểm 14h-16h.',
  'Cảm ơn ban dự án đã hỗ trợ nhiệt tình trong quá trình chuyển đổi.',
  'Mong muốn tối ưu hóa quy trình mở thẻ tín dụng.',
];

// ─── SurveyPage ───────────────────────────────────────────────────────────────

export function SurveyPage() {
  const navigate = useNavigate();
  const createMatch  = useMatch('/survey/create');
  const editMatch    = useMatch('/survey/:id/edit');
  const fillMatch    = useMatch('/survey/:id/fill');
  const reportMatch  = useMatch('/survey/:id/report');

  const view = createMatch ? 'builder'
    : editMatch    ? 'builder'
    : fillMatch    ? 'filler'
    : reportMatch  ? 'dashboard'
    : 'list';

  const selectedId = editMatch?.params.id || fillMatch?.params.id || reportMatch?.params.id || null;

  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [responses, setResponses] = useState<SurveyResponse[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Load from backend ──────────────────────────────────────────────────────

  useEffect(() => {
    Promise.all([
      fetch('/api/surveys').then(r => r.json()).catch(() => ({ ok: false })),
      fetch('/api/survey-responses').then(r => r.json()).catch(() => ({ ok: false })),
    ]).then(([s, r]) => {
      if (s.ok) setSurveys(s.surveys || []);
      if (r.ok) setResponses(r.responses || []);
      setLoading(false);
    });
  }, []);

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async function saveSurvey(survey: Survey) {
    const existing = surveys.some(s => s.id === survey.id);
    let result: Survey;
    if (existing) {
      await fetch(`/api/surveys?id=${survey.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(survey),
      });
      result = survey;
      setSurveys(prev => prev.map(s => s.id === survey.id ? result : s));
    } else {
      const d = await fetch('/api/surveys', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(survey),
      }).then(r => r.json());
      result = d.survey || survey;
      setSurveys(prev => [result, ...prev]);
    }
    navigate('/survey');
  }

  async function deleteSurvey(id: string) {
    if (!confirm('Xóa khảo sát này và toàn bộ phản hồi liên quan?')) return;
    await fetch(`/api/surveys?id=${id}`, { method: 'DELETE' });
    await fetch(`/api/survey-responses?surveyId=${id}`, { method: 'DELETE' });
    setSurveys(prev => prev.filter(s => s.id !== id));
    setResponses(prev => prev.filter(r => r.surveyId !== id));
  }

  async function submitResponse(surveyId: string, officeId: string, answers: Record<string, string | string[] | number>) {
    const d = await fetch('/api/survey-responses', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ surveyId, officeId, answers }),
    }).then(r => r.json());
    if (d.ok) {
      setResponses(prev => {
        const idx = prev.findIndex(r => r.surveyId === surveyId && r.officeId === officeId);
        return idx >= 0 ? prev.map((r, i) => i === idx ? d.response : r) : [d.response, ...prev];
      });
    }
  }

  async function clearResponses(surveyId: string) {
    await fetch(`/api/survey-responses?surveyId=${surveyId}`, { method: 'DELETE' });
    setResponses(prev => prev.filter(r => r.surveyId !== surveyId));
  }

  // ── Simulation engine ──────────────────────────────────────────────────────

  async function simulateResponses(surveyId: string, count: number) {
    const survey = surveys.find(s => s.id === surveyId);
    if (!survey) return;
    const submitted = new Set(responses.filter(r => r.surveyId === surveyId).map(r => r.officeId));
    const available = ALL_OFFICES.filter(o => !submitted.has(o.id));
    if (!available.length) { alert('Tất cả PGD đã hoàn thành khảo sát này!'); return; }

    const toSim = [...available].sort(() => .5 - Math.random()).slice(0, Math.min(count, available.length));
    const now = Date.now();

    const simResponses: SurveyResponse[] = toSim.map((office, i) => {
      const answers: Record<string, string | string[] | number> = {};
      survey.questions.forEach(q => {
        if (q.type === 'text') {
          answers[q.id] = /họ|tên/i.test(q.title) ? MOCK_NAMES[Math.floor(Math.random() * MOCK_NAMES.length)] : `Ý kiến PGD ${office.code}`;
        } else if (q.type === 'paragraph') {
          answers[q.id] = MOCK_COMMENTS[Math.floor(Math.random() * MOCK_COMMENTS.length)];
        } else if (q.type === 'rating') {
          answers[q.id] = [3,4,4,5,5,5,5,2,5,4][Math.floor(Math.random() * 10)];
        } else if ((q.type === 'radio' || q.type === 'select') && q.options) {
          answers[q.id] = Math.random() > .3 ? q.options[Math.floor(Math.random() * 2)] : q.options[Math.floor(Math.random() * q.options.length)];
        } else if (q.type === 'checkbox' && q.options) {
          const shuffled = [...q.options].sort(() => .5 - Math.random());
          answers[q.id] = shuffled.slice(0, Math.floor(Math.random() * 3) + 1);
        }
      });
      return {
        id: `sim-${now}-${office.id}-${i}`,
        surveyId,
        officeId: office.id,
        submittedAt: new Date(now - Math.random() * 3 * 86400000).toISOString(),
        answers,
      };
    });

    // Batch save all simulated responses
    for (const r of simResponses) {
      await fetch('/api/survey-responses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r),
      });
    }
    setResponses(prev => [...simResponses, ...prev]);
    alert(`Đã mô phỏng ${simResponses.length} phản hồi từ ${simResponses.length} PGD.`);
  }

  // ── Export / Import ────────────────────────────────────────────────────────

  function exportData() {
    const blob = new Blob([JSON.stringify({ surveys, responses }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'SaoLuu_KhaoSat.json'; a.click();
  }

  function importData(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (data.surveys && data.responses) {
          for (const s of data.surveys) await fetch('/api/surveys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
          for (const r of data.responses) await fetch('/api/survey-responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) });
          setSurveys(data.surveys); setResponses(data.responses);
          alert('Khôi phục dữ liệu thành công!');
        } else alert('File không đúng định dạng.');
      } catch { alert('Lỗi đọc file JSON.'); }
    };
    reader.readAsText(file);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  const selectedSurvey = surveys.find(s => s.id === selectedId);
  const getResponseCount = (id: string) => responses.filter(r => r.surveyId === id).length;
  const TOTAL_PGD = ALL_OFFICES.length;

  // ── Render ─────────────────────────────────────────────────────────────────

  // Sub-views
  if (view === 'builder') {
    return (
      <div className="flex-1 overflow-y-auto bg-base">
        <Header title="Khảo sát PGD" subtitle={selectedSurvey ? 'Chỉnh sửa khảo sát' : 'Tạo khảo sát mới'} />
        <div className="px-6 py-4">
          <SurveyFormBuilder
            initialSurvey={selectedSurvey}
            onSave={saveSurvey}
            onCancel={() => navigate('/survey')}
          />
        </div>
      </div>
    );
  }

  if (view === 'filler' && selectedSurvey) {
    return (
      <div className="flex-1 overflow-y-auto bg-base">
        <Header title="Khảo sát PGD" subtitle="Giao diện điền khảo sát" />
        <div className="px-6 py-4">
          <SurveyFormFiller
            survey={selectedSurvey}
            existingResponses={responses.filter(r => r.surveyId === selectedSurvey.id)}
            onSubmit={submitResponse}
            onBack={() => navigate('/survey')}
          />
        </div>
      </div>
    );
  }

  if (view === 'dashboard' && selectedSurvey) {
    return (
      <div className="flex-1 overflow-y-auto bg-base">
        <Header title="Khảo sát PGD" subtitle="Báo cáo & Phân tích" />
        <div className="px-6 py-4">
          <SurveyDashboard
            survey={selectedSurvey}
            responses={responses}
            onBack={() => navigate('/survey')}
            onSimulate={count => simulateResponses(selectedSurvey.id, count)}
            onClear={() => clearResponses(selectedSurvey.id)}
          />
        </div>
      </div>
    );
  }

  // ── LIST VIEW ───────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 overflow-y-auto bg-base">
      <Header title="Khảo sát PGD" subtitle={`Quản lý & phân tích khảo sát mạng lưới ${TOTAL_PGD} PGD toàn quốc`} />

      <div className="px-6 py-4 space-y-5">
        {/* Top bar */}
        <div className="bg-white border border-border rounded-2xl shadow-card p-5 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 relative overflow-hidden">
          <div className="relative space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold bg-primary/10 text-primary border border-primary/20 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-ping" /> Dịch vụ Toàn quốc
              </span>
              <span className="text-[10px] bg-slate-100 text-slate-600 border border-slate-200 px-2.5 py-0.5 rounded-full font-medium">
                Chỉ tiêu: {TOTAL_PGD} PGD
              </span>
            </div>
            <p className="text-sm text-slate-600 max-w-lg leading-relaxed">
              Thiết kế form khảo sát, theo dõi tiến độ hoàn thành và xem báo cáo thống kê theo vùng miền thời gian thực.
            </p>
          </div>
          <div className="flex items-center gap-2 self-end md:self-auto">
            <button onClick={exportData} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium border border-border rounded-xl text-slate-600 hover:bg-hover shadow-card transition-colors">
              <Download size={13} /> Sao lưu
            </button>
            <label className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium border border-border rounded-xl text-slate-600 hover:bg-hover shadow-card transition-colors cursor-pointer">
              <Upload size={13} /> Khôi phục
              <input type="file" accept=".json" onChange={importData} className="hidden" />
            </label>
            <button onClick={() => navigate('/survey/create')}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-bold bg-primary text-white rounded-xl hover:bg-primary/90 shadow-sm transition-colors">
              <Plus size={13} /> Tạo khảo sát mới
            </button>
          </div>
        </div>

        {/* Survey list */}
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider">Danh sách khảo sát</h3>
            <p className="text-xs text-slate-400">Các form đang phân phối tới {TOTAL_PGD} PGD</p>
          </div>
          <span className="text-xs text-slate-500 bg-slate-100 border border-slate-200 px-2.5 py-0.5 rounded-full font-semibold">{surveys.length} form</span>
        </div>

        {loading ? (
          <div className="bg-white border border-border rounded-2xl shadow-card p-12 text-center text-sm text-slate-400 flex items-center justify-center gap-2">
            <RefreshCw size={14} className="animate-spin" /> Đang tải...
          </div>
        ) : surveys.length === 0 ? (
          <div className="bg-white border border-border rounded-2xl shadow-card p-12 flex flex-col items-center text-center gap-3">
            <FileText size={40} className="text-slate-300 stroke-[1.25]" />
            <h4 className="font-bold text-slate-700 text-sm">Chưa có khảo sát nào</h4>
            <p className="text-xs text-slate-400">Nhấn <strong>"Tạo khảo sát mới"</strong> để bắt đầu.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {surveys.map(survey => {
              const count = getResponseCount(survey.id);
              const pct = ((count / TOTAL_PGD) * 100).toFixed(1);
              return (
                <div key={survey.id}
                  className="bg-white border border-border rounded-2xl shadow-card p-5 flex flex-col gap-4 hover:border-violet-200 hover:shadow-md transition-all group relative overflow-hidden">
                  <div className="flex items-start justify-between gap-3">
                    <div className="p-2 bg-slate-50 border border-slate-100 rounded-xl shrink-0">
                      <FileText size={18} className="text-slate-500" />
                    </div>
                    <div className="flex items-center gap-1 opacity-50 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => navigate(`/survey/${survey.id}/edit`)} title="Chỉnh sửa"
                        className="p-1.5 text-slate-400 hover:text-primary hover:bg-primary/10 rounded-lg transition-colors">
                        <Edit3 size={13} />
                      </button>
                      <button onClick={() => deleteSurvey(survey.id)} title="Xóa"
                        className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  <div>
                    <h4 className="font-bold text-slate-800 text-sm leading-snug line-clamp-2">{survey.title}</h4>
                    {survey.description && <p className="text-xs text-slate-500 mt-1 line-clamp-2">{survey.description}</p>}
                    <div className="flex flex-wrap gap-2 mt-2 text-[11px] text-slate-400">
                      {survey.questions.length > 0 && <span>{survey.questions.length} câu hỏi</span>}
                      {survey.deadline && <span>Hạn: {new Date(survey.deadline).toLocaleDateString('vi-VN')}</span>}
                      {survey.sentAt && <span className="text-emerald-600 font-medium">✓ Đã gửi</span>}
                    </div>
                  </div>

                  {/* Progress */}
                  <div className="space-y-2 border-t border-slate-50 pt-3">
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500 flex items-center gap-1">
                        <Users size={11} /> <strong>{count}</strong> / {TOTAL_PGD} PGD đã nộp
                      </span>
                      <span className={clsx('font-bold', count > 0 ? 'text-primary' : 'text-slate-400')}>{pct}%</span>
                    </div>
                    <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>

                    <div className="grid grid-cols-2 gap-2 pt-1">
                      <button onClick={() => navigate(`/survey/${survey.id}/fill`)}
                        className="py-1.5 text-xs font-bold text-primary bg-primary/10 hover:bg-primary/20 rounded-xl transition-colors text-center flex items-center justify-center gap-1">
                        <Sparkles size={11} /> Điền khảo sát
                      </button>
                      <button onClick={() => navigate(`/survey/${survey.id}/report`)}
                        className="py-1.5 text-xs font-bold text-white bg-slate-800 hover:bg-slate-700 rounded-xl transition-colors text-center flex items-center justify-center gap-1">
                        <BarChart2 size={11} /> Báo cáo
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
