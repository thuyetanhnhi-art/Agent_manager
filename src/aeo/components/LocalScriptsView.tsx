import { useMemo, useState } from 'react';
import { MapPin, Search } from 'lucide-react';
import type { AeoSheet, TransactionOffice } from '../types';
import { REGION_LOCALITY_ALIASES } from '../data/localityAliases';
import { computeLocalityFilteredRows, computeVisibleColIdx, normalizeSearch, sheetHasVisibleContent, toMergedLocalityShape } from '../utils';
import { RowCards } from './RowCards';
import { MergedTable } from './MergedTable';

export function LocalScriptsView({ sheets, office }: { sheets: AeoSheet[]; office: TransactionOffice }) {
  const [query, setQuery] = useState('');
  const [showAllLocalities, setShowAllLocalities] = useState(false);

  const aliasMap = REGION_LOCALITY_ALIASES[office.region];

  const sections = useMemo(() => {
    const q = normalizeSearch(query);
    return sheets
      .map(sheet => {
        const sttIdx = sheet.headers.findIndex(h => h.trim().toLowerCase() === 'stt');
        const visibleColIdx = computeVisibleColIdx(sheet, office, aliasMap, showAllLocalities);
        let rows = computeLocalityFilteredRows(sheet, office, aliasMap, showAllLocalities);
        if (q) rows = rows.filter(r => r.group || normalizeSearch(r.cells.join(' ')).includes(q));
        const visible = sheetHasVisibleContent(rows, visibleColIdx, sttIdx);
        return { sheet, sttIdx, visibleColIdx, rows, visible };
      })
      .filter(s => s.visible);
  }, [sheets, office, aliasMap, showAllLocalities, query]);

  const anyLocalityStructure = !!aliasMap && sheets.some(s => s.localityMode !== 'none');
  const totalUnfiltered = sheets.reduce((n, s) => n + s.rows.filter(r => !r.group).length, 0);
  const totalFiltered = sections.reduce((n, s) => n + s.rows.filter(r => !r.group).length, 0);
  const fellBackToAll = anyLocalityStructure && !showAllLocalities && totalFiltered === 0 && totalUnfiltered > 0;

  return (
    <div>
      {anyLocalityStructure && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          <MapPin size={13} className="shrink-0" />
          {showAllLocalities ? (
            <>
              <span>Đang xem kịch bản của tất cả địa phương trong vùng.</span>
              <button onClick={() => setShowAllLocalities(false)} className="ml-auto font-semibold underline underline-offset-2">
                Chỉ xem {office.province}
              </button>
            </>
          ) : fellBackToAll ? (
            <span>Không có mục riêng cho {office.province} — đang hiện tất cả địa phương trong vùng.</span>
          ) : (
            <>
              <span>
                Đang lọc theo địa phương của PGD: <strong>{office.province}</strong>
              </span>
              <button onClick={() => setShowAllLocalities(true)} className="ml-auto font-semibold underline underline-offset-2">
                Xem tất cả địa phương
              </button>
            </>
          )}
        </div>
      )}

      <div className="relative mb-4 max-w-sm">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Tìm trong kịch bản địa phương..."
          className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-8 pr-3 text-xs text-slate-700 outline-none transition-colors placeholder-slate-400 focus:border-violet-400"
        />
      </div>

      {sections.length === 0 && (
        <p className="py-8 text-center text-xs text-slate-400">Không tìm thấy nội dung phù hợp.</p>
      )}

      <div className="space-y-6">
        {sections.map(({ sheet, sttIdx, visibleColIdx, rows }) => {
          // Every "địa phương" sheet renders as the same merged Excel-style table —
          // whatever its original layout, so all PGDs share one consistent look.
          const useTable = sheet.localityMode === 'row';
          return (
            <div key={sheet.name}>
              {sections.length > 1 && (
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{sheet.name}</p>
              )}
              {useTable ? (
                (() => {
                  const shaped = toMergedLocalityShape(sheet, rows, aliasMap);
                  return <MergedTable headers={shaped.headers} rows={shaped.rows} />;
                })()
              ) : (
                <RowCards headers={sheet.headers} rows={rows} sttIdx={sttIdx} visibleColIdx={visibleColIdx} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
