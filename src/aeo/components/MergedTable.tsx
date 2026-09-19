import type { AeoRow } from '../types';
import { CopyButton } from './CopyButton';

type ColStyle = 'positive' | 'negative' | 'neutral';

function colStyle(header: string): ColStyle {
  const h = header.toLowerCase();
  if (h.includes('tích cực')) return 'positive';
  if (h.includes('tiêu cực')) return 'negative';
  return 'neutral';
}

const HEADER_CLASS: Record<ColStyle, string> = {
  positive: 'bg-emerald-700 text-white',
  negative: 'bg-rose-700 text-white',
  neutral: 'bg-slate-700 text-white',
};

const CELL_CLASS: Record<ColStyle, string> = {
  positive: 'bg-emerald-50/60',
  negative: 'bg-rose-50/60',
  neutral: '',
};

/** rowSpan per row for one column: 0 means "covered by a previous rowspan, don't render this cell". */
function computeSpans(rows: AeoRow[], colIdx: number): number[] {
  const spans = new Array(rows.length).fill(1);
  let anchor = -1;
  rows.forEach((r, i) => {
    if (r.group) {
      anchor = -1;
      return;
    }
    const val = (r.cells[colIdx] ?? '').trim();
    if (val) {
      anchor = i;
      spans[i] = 1;
    } else if (anchor >= 0) {
      spans[anchor]++;
      spans[i] = 0;
    }
  });
  return spans;
}

export function MergedTable({ headers, rows }: { headers: string[]; rows: AeoRow[] }) {
  const colIdx = headers.map((_, i) => i).filter(i => !headers[i].trim().toLowerCase().startsWith('cột'));
  const spansByCol = colIdx.map(ci => computeSpans(rows, ci));

  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 shadow-sm">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr>
            {colIdx.map(ci => {
              const style = colStyle(headers[ci]);
              return (
                <th
                  key={ci}
                  className={`px-3 py-2.5 text-left text-xs font-semibold ${HEADER_CLASS[style]} ${
                    style === 'neutral' ? 'min-w-[130px]' : 'min-w-[220px]'
                  }`}
                >
                  {headers[ci]}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => {
            if (row.group) {
              const label = row.cells.find(c => c.trim()) ?? '';
              return (
                <tr key={ri}>
                  <td colSpan={colIdx.length} className="bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-800">
                    {label}
                  </td>
                </tr>
              );
            }
            return (
              <tr key={ri} className="border-b border-slate-100 last:border-0">
                {colIdx.map((ci, k) => {
                  const span = spansByCol[k][ri];
                  if (span === 0) return null;
                  const value = row.cells[ci] ?? '';
                  const style = colStyle(headers[ci]);
                  return (
                    <td
                      key={ci}
                      rowSpan={span}
                      className={`align-top px-3 py-2.5 text-slate-700 ${CELL_CLASS[style]} ${
                        span > 1 ? 'border-r border-slate-100' : ''
                      }`}
                    >
                      {value.trim() && (
                        <div className="flex items-start justify-between gap-2">
                          <p className="whitespace-pre-line leading-relaxed">{value}</p>
                          {value.length > 15 && <CopyButton className="shrink-0" text={value} />}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
