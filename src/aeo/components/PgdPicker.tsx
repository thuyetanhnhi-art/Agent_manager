import { useMemo, useState } from 'react';
import { ChevronDown, MapPin, Search } from 'lucide-react';
import { ALL_OFFICES, REGION_ZONES_2026, ZONE_COLOR_CLASSES } from '../data/offices';
import type { RegionZone2026, TransactionOffice } from '../types';
import { normalizeSearch } from '../utils';

const RESULT_LIMIT = 40;

function Dropdown({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder: string;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="appearance-none rounded-2xl border border-slate-200 bg-white py-3 pl-4 pr-9 text-sm text-slate-700 outline-none transition-colors focus:border-violet-400"
      >
        <option value="">{placeholder}</option>
        {options.map(o => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
    </div>
  );
}

export function PgdPicker({ onSelect }: { onSelect: (office: TransactionOffice) => void }) {
  const [query, setQuery] = useState('');
  const [region, setRegion] = useState<RegionZone2026 | ''>('');
  const [province, setProvince] = useState('');

  const provinceOptions = useMemo(() => {
    const list = region ? ALL_OFFICES.filter(o => o.region === region) : ALL_OFFICES;
    return [...new Set(list.map(o => o.province))].sort((a, b) => a.localeCompare(b, 'vi'));
  }, [region]);

  function handleRegionChange(v: string) {
    setRegion(v as RegionZone2026 | '');
    setProvince('');
  }

  const filtered = useMemo(() => {
    const q = normalizeSearch(query);
    let list = ALL_OFFICES;
    if (region) list = list.filter(o => o.region === region);
    if (province) list = list.filter(o => o.province === province);
    if (q) {
      list = list.filter(o => normalizeSearch(o.name).includes(q) || normalizeSearch(o.code).includes(q));
    }
    return list;
  }, [query, region, province]);

  const results = filtered.slice(0, RESULT_LIMIT);

  return (
    <div>
      <p className="mb-3 text-sm text-slate-500">
        Hệ thống quản lý {ALL_OFFICES.length} PGD toàn quốc. Chọn chính xác đơn vị của bạn.
      </p>

      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Tìm PGD (tên hoặc mã)..."
            className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-10 pr-3 text-sm text-slate-700 outline-none transition-colors placeholder-slate-400 focus:border-violet-400"
          />
        </div>
        <Dropdown value={region} onChange={handleRegionChange} options={REGION_ZONES_2026.map(z => z.name)} placeholder="Vùng" />
        <Dropdown value={province} onChange={setProvince} options={provinceOptions} placeholder="Tỉnh/Thành" />
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        {results.length === 0 ? (
          <p className="px-4 py-10 text-center text-xs text-slate-400">Không tìm thấy PGD phù hợp.</p>
        ) : (
          <div className="max-h-[28rem] divide-y divide-slate-50 overflow-y-auto">
            {results.map(o => {
              const colors = ZONE_COLOR_CLASSES[o.region];
              return (
                <button
                  key={o.id}
                  onClick={() => onSelect(o)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-slate-50"
                >
                  <MapPin size={14} className="shrink-0 text-slate-300" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-slate-700">{o.name}</p>
                    <p className="truncate text-[10px] text-slate-400">{o.province}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${colors.badgeBg} ${colors.badgeText}`}>
                    {o.region}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {filtered.length > RESULT_LIMIT && (
        <p className="mt-2 text-center text-[10px] text-slate-400">
          Hiện {RESULT_LIMIT}/{filtered.length} kết quả — gõ thêm hoặc chọn Tỉnh/Thành để thu hẹp.
        </p>
      )}
    </div>
  );
}
