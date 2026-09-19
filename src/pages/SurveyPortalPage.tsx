import { useState, useEffect } from 'react';
import { FileText, Clock, CheckCircle2, ArrowLeft, ChevronRight, ClipboardList } from 'lucide-react';
import { Survey, SurveyResponse } from '../surveyTypes';
import { SurveyFormFiller } from '../components/survey/SurveyFormFiller';

type PortalView = 'list' | 'fill';

export function SurveyPortalPage() {
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [responses, setResponses] = useState<SurveyResponse[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<PortalView>('list');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/surveys').then(r => r.json()).catch(() => ({ ok: false })),
      fetch('/api/survey-responses').then(r => r.json()).catch(() => ({ ok: false })),
    ]).then(([s, r]) => {
      if (s.ok) setSurveys((s.surveys || []).filter((sv: Survey) => sv.active));
      if (r.ok) setResponses(r.responses || []);
      setLoading(false);
    });
  }, []);

  async function submitResponse(surveyId: string, officeId: string, answers: Record<string, string | string[] | number>) {
    const d = await fetch('/api/survey-responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ surveyId, officeId, answers }),
    }).then(r => r.json());
    if (d.ok) {
      setResponses(prev => {
        const idx = prev.findIndex(r => r.surveyId === surveyId && r.officeId === officeId);
        return idx >= 0 ? prev.map((r, i) => i === idx ? d.response : r) : [d.response, ...prev];
      });
    }
  }

  const selectedSurvey = surveys.find(s => s.id === selectedId);

  if (view === 'fill' && selectedSurvey) {
    return (
      <div className="min-h-screen bg-slate-50">
        <PortalHeader />
        <div className="max-w-3xl mx-auto px-4 py-6">
          <SurveyFormFiller
            survey={selectedSurvey}
            existingResponses={responses.filter(r => r.surveyId === selectedSurvey.id)}
            onSubmit={submitResponse}
            onBack={() => { setView('list'); setSelectedId(null); }}
          />
        </div>
      </div>
    );
  }

  const now = new Date();

  return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader />

      <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        {/* Welcome */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-primary/10 border border-primary/20 rounded-2xl mb-1">
            <ClipboardList size={28} className="text-primary" />
          </div>
          <h1 className="text-xl font-black text-slate-800">Cổng Khảo sát PGD</h1>
          <p className="text-sm text-slate-500 max-w-sm mx-auto leading-relaxed">
            Danh sách khảo sát đang triển khai. Vui lòng chọn và điền đầy đủ trước thời hạn.
          </p>
        </div>

        {/* Survey list */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2].map(i => (
              <div key={i} className="bg-white border border-slate-200 rounded-2xl p-5 animate-pulse">
                <div className="h-4 bg-slate-100 rounded w-3/4 mb-3" />
                <div className="h-3 bg-slate-100 rounded w-full mb-1.5" />
                <div className="h-3 bg-slate-100 rounded w-2/3" />
              </div>
            ))}
          </div>
        ) : surveys.length === 0 ? (
          <div className="bg-white border border-border rounded-2xl p-12 text-center space-y-3">
            <CheckCircle2 size={40} className="text-slate-300 mx-auto" />
            <p className="font-bold text-slate-600">Hiện chưa có khảo sát nào đang mở</p>
            <p className="text-xs text-slate-400">Vui lòng quay lại sau.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {surveys.map(survey => {
              const surveyResponses = responses.filter(r => r.surveyId === survey.id);
              const deadline = survey.deadline ? new Date(survey.deadline) : null;
              const isExpired = deadline ? deadline < now : false;
              const daysLeft = deadline ? Math.ceil((deadline.getTime() - now.getTime()) / 86400000) : null;

              return (
                <button
                  key={survey.id}
                  onClick={() => { if (!isExpired) { setSelectedId(survey.id); setView('fill'); } }}
                  disabled={isExpired}
                  className="w-full text-left bg-white border border-slate-200 rounded-2xl p-5 hover:border-violet-300 hover:shadow-md disabled:opacity-60 disabled:cursor-not-allowed transition-all group relative overflow-hidden"
                >
                  <div className="absolute top-0 left-0 w-1 h-full bg-primary rounded-l-2xl opacity-0 group-hover:opacity-100 transition-opacity" />

                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div className="p-2 bg-slate-50 border border-slate-100 rounded-xl shrink-0 mt-0.5">
                        <FileText size={18} className="text-slate-500 group-hover:text-primary transition-colors" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-bold text-slate-800 text-sm leading-snug group-hover:text-primary transition-colors">{survey.title}</h3>
                        {survey.description && (
                          <p className="text-xs text-slate-500 mt-1 line-clamp-2 leading-relaxed">{survey.description}</p>
                        )}

                        <div className="flex flex-wrap items-center gap-3 mt-3">
                          <span className="text-[11px] text-slate-400 flex items-center gap-1">
                            <span className="w-1 h-1 rounded-full bg-slate-300" /> {survey.questions.length} câu hỏi
                          </span>

                          {deadline && (
                            <span className={`text-[11px] flex items-center gap-1 font-medium ${isExpired ? 'text-red-500' : daysLeft !== null && daysLeft <= 3 ? 'text-orange-500' : 'text-slate-400'}`}>
                              <Clock size={11} />
                              {isExpired
                                ? 'Đã hết hạn'
                                : daysLeft === 0
                                  ? 'Hết hạn hôm nay'
                                  : `Còn ${daysLeft} ngày (${deadline.toLocaleDateString('vi-VN')})`}
                            </span>
                          )}

                          {surveyResponses.length > 0 && (
                            <span className="text-[11px] text-emerald-600 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full font-semibold flex items-center gap-1">
                              <CheckCircle2 size={10} /> {surveyResponses.length} PGD đã nộp
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {!isExpired && (
                      <div className="shrink-0 mt-1 p-2 bg-primary text-white rounded-xl group-hover:bg-primary/90 transition-colors shadow-sm">
                        <ChevronRight size={14} />
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <p className="text-center text-[11px] text-slate-300 pt-2">
          Hệ thống Quản lý Khảo sát — Nội bộ F88
        </p>
      </div>
    </div>
  );
}

function PortalHeader() {
  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
      <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
            <ClipboardList size={14} className="text-white" />
          </div>
          <span className="text-sm font-bold text-slate-800">Khảo sát PGD</span>
          <span className="hidden sm:inline text-[10px] bg-slate-100 text-slate-500 border border-slate-200 px-2 py-0.5 rounded-full font-medium">
            F88
          </span>
        </div>
        <a href="/" className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 transition-colors">
          <ArrowLeft size={12} /> Quay về hệ thống
        </a>
      </div>
    </header>
  );
}
