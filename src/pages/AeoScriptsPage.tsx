import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BookOpen, Loader2, MapPin } from 'lucide-react';
import { Header } from '../components/Header';
import { PgdPicker } from '../aeo/components/PgdPicker';
import { SheetView } from '../aeo/components/SheetView';
import { LocalScriptsView } from '../aeo/components/LocalScriptsView';
import { ZONE_COLOR_CLASSES } from '../aeo/data/offices';
import manifest from '../aeo/data/aeo/manifest.json';
import guideData from '../aeo/data/aeo/guide.json';
import type { AeoRegionData, AeoSheet, ManifestEntry, TransactionOffice } from '../aeo/types';

const aeoModules = import.meta.glob<{ default: AeoRegionData }>([
  '../aeo/data/aeo/*.json',
  '!../aeo/data/aeo/manifest.json',
  '!../aeo/data/aeo/guide.json',
]);

const GUIDE_SHEET: AeoSheet = {
  name: guideData.name,
  kind: 'guide',
  headers: guideData.headers,
  rows: guideData.rows.map(r => ({ ...r, locality: null })),
  localityMode: 'none',
  columnLocality: null,
  localitySource: 'none',
};

type GroupKey = 'common' | 'local';

const GROUP_META: Record<GroupKey, { label: string; icon: string; hint: string }> = {
  common: { label: 'Kịch bản chung', icon: '🌐', hint: 'Áp dụng cho mọi PGD trong vùng' },
  local: { label: 'Kịch bản địa phương', icon: '📍', hint: 'Lọc riêng theo tỉnh/thành của PGD' },
};
const GROUP_ORDER: GroupKey[] = ['common', 'local'];

export function AeoScriptsPage() {
  const [view, setView] = useState<'main' | 'guide'>('main');
  const [office, setOffice] = useState<TransactionOffice | null>(null);
  const [data, setData] = useState<AeoRegionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeGroup, setActiveGroup] = useState<GroupKey>('common');

  useEffect(() => {
    if (!office) {
      setData(null);
      return;
    }
    const entry = (manifest as ManifestEntry[]).find(m => m.region === office.region);
    if (!entry) return;
    const loader = aeoModules[`../aeo/data/aeo/${entry.slug}.json`];
    if (!loader) return;
    setLoading(true);
    setActiveGroup('common');
    loader().then(mod => {
      setData(mod.default);
      setLoading(false);
    });
  }, [office]);

  const grouped = useMemo(() => {
    const g: Record<GroupKey, AeoSheet[]> = { common: [], local: [] };
    for (const s of data?.sheets ?? []) {
      if (s.kind === 'common' || s.kind === 'local') g[s.kind].push(s);
    }
    // Wide keyword-matrix sheets (one column per locality) are older, less
    // structured duplicates of the same content already covered by a proper
    // per-row "Địa phương | Từ khóa | Phiên bản | ..." script sheet — drop them
    // so the clean, copy-ready format is what's shown, not a redundant table.
    if (g.local.some(s => s.localityMode === 'row')) {
      g.local = g.local.filter(s => s.localityMode !== 'column');
    }
    return g;
  }, [data]);

  const availableGroups = GROUP_ORDER.filter(k => grouped[k].length > 0);

  return (
    <div className="flex-1 overflow-y-auto bg-base">
      <Header title="Kịch bản AEO Toàn Dân" subtitle="Kịch bản phản hồi AI Search theo phòng giao dịch" />
      <div className="px-6 py-4 space-y-4">
        <div className="flex justify-end">
          <button
            onClick={() => setView(v => (v === 'guide' ? 'main' : 'guide'))}
            className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors ${
              view === 'guide' ? 'bg-primary text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            <BookOpen size={13} /> Hướng dẫn
          </button>
        </div>

        {view === 'guide' ? (
          <div>
            <button
              onClick={() => setView('main')}
              className="mb-4 flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-primary"
            >
              <ArrowLeft size={13} /> Quay lại
            </button>
            <p className="mb-3 text-[11px] font-medium text-slate-400">
              Dùng chung cho toàn hệ thống — không tách theo PGD hay vùng.
            </p>
            <SheetView sheet={GUIDE_SHEET} />
          </div>
        ) : !office ? (
          <PgdPicker onSelect={setOffice} />
        ) : (
          <div>
            <button
              onClick={() => setOffice(null)}
              className="mb-4 flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-primary"
            >
              <ArrowLeft size={13} /> Đổi phòng giao dịch
            </button>

            <div className="mb-5 flex items-center gap-3 rounded-2xl border border-border bg-white p-4 shadow-card">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-glow text-primary">
                <MapPin size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-800">{office.name}</p>
                <p className="text-xs text-slate-400">{office.province}</p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${ZONE_COLOR_CLASSES[office.region].badgeBg} ${ZONE_COLOR_CLASSES[office.region].badgeText}`}
              >
                {office.region}
              </span>
            </div>

            {loading && (
              <div className="flex items-center justify-center gap-2 py-16 text-xs text-slate-400">
                <Loader2 size={14} className="animate-spin" /> Đang tải kịch bản vùng {office.region}...
              </div>
            )}

            {!loading && data && (
              <div>
                <div className="mb-4 flex flex-wrap gap-1.5 border-b border-border pb-3">
                  {availableGroups.map(k => (
                    <button
                      key={k}
                      onClick={() => setActiveGroup(k)}
                      className={`rounded-xl px-3.5 py-2 text-xs font-medium transition-colors ${
                        activeGroup === k ? 'bg-primary text-white' : 'bg-white text-slate-500 border border-border hover:bg-slate-100'
                      }`}
                    >
                      {GROUP_META[k].icon} {GROUP_META[k].label}
                    </button>
                  ))}
                </div>

                {availableGroups.includes(activeGroup) && (
                  <div>
                    <p className="mb-3 text-[11px] font-medium text-slate-400">{GROUP_META[activeGroup].hint}</p>
                    {activeGroup === 'local' ? (
                      <LocalScriptsView sheets={grouped.local} office={office} />
                    ) : (
                      grouped[activeGroup].map(sheet => (
                        <div key={sheet.name} className="mb-6">
                          {grouped[activeGroup].length > 1 && (
                            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{sheet.name}</p>
                          )}
                          <SheetView sheet={sheet} />
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
