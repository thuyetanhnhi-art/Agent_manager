import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { AeoSheet } from '../types';
import { normalizeSearch } from '../utils';
import { RowCards } from './RowCards';

export function SheetView({ sheet }: { sheet: AeoSheet }) {
  const [query, setQuery] = useState('');
  const sttIdx = sheet.headers.findIndex(h => h.trim().toLowerCase() === 'stt');

  const filteredRows = useMemo(() => {
    const q = normalizeSearch(query);
    if (!q) return sheet.rows;
    return sheet.rows.filter(r => r.group || normalizeSearch(r.cells.join(' ')).includes(q));
  }, [sheet.rows, query]);

  return (
    <div>
      <div className="relative mb-3 max-w-sm">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={`Tìm trong "${sheet.name}"...`}
          className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-8 pr-3 text-xs text-slate-700 outline-none transition-colors placeholder-slate-400 focus:border-violet-400"
        />
      </div>

      {filteredRows.length === 0 && (
        <p className="py-8 text-center text-xs text-slate-400">Không tìm thấy nội dung phù hợp.</p>
      )}

      <RowCards headers={sheet.headers} rows={filteredRows} sttIdx={sttIdx} visibleColIdx={null} />
    </div>
  );
}
