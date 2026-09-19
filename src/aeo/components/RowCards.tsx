import type { AeoRow } from '../types';
import { CopyButton } from './CopyButton';

const COPY_THRESHOLD = 15;

export function RowCards({
  headers,
  rows,
  sttIdx,
  visibleColIdx,
}: {
  headers: string[];
  rows: AeoRow[];
  sttIdx: number;
  visibleColIdx: number[] | null;
}) {
  return (
    <div className="space-y-2.5">
      {rows.map((row, i) => {
        if (row.group) {
          const label = row.cells.find(c => c.trim()) ?? '';
          return (
            <div key={i} className="rounded-xl bg-violet-50 px-3.5 py-2 text-xs font-semibold text-violet-800">
              {label}
            </div>
          );
        }

        const fields = headers
          .map((h, ci) => ({ header: h, value: row.cells[ci] ?? '' }))
          .filter((f, ci) => ci !== sttIdx && f.value.trim() && (!visibleColIdx || visibleColIdx.includes(ci)));

        if (fields.length === 0) return null;

        const stt = sttIdx >= 0 ? row.cells[sttIdx] : '';

        return (
          <div key={i} className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm">
            {stt && (
              <span className="mb-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold text-slate-500">
                {stt}
              </span>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {fields.map((f, fi) => (
                <div key={fi} className="min-w-0">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{f.header}</span>
                    {f.value.length > COPY_THRESHOLD && <CopyButton text={f.value} />}
                  </div>
                  <p className="whitespace-pre-line text-[12.5px] leading-relaxed text-slate-700">{f.value}</p>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
