import type { AeoRow, AeoSheet, TransactionOffice } from './types';

export function normalizeSearch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

/**
 * Whether a locality-labelled item (a row or a column) is relevant to the
 * given office. `aliasMap` is this region's province -> raw-text-fragment
 * table (see localityAliases.ts). An item with no recognizable locality text,
 * or whose text doesn't positively match a *different* known province, is
 * treated as relevant by default — only a confident match to another
 * province hides it. This keeps the filter a safety net, not a data-loss risk.
 */
export function isLocalityRelevant(
  rawLabel: string | null,
  province: string,
  aliasMap: Record<string, string[]> | undefined,
): boolean {
  if (!rawLabel || !rawLabel.trim()) return true;
  if (!aliasMap) return true;
  const norm = normalizeSearch(rawLabel);
  const target = aliasMap[province] ?? [];
  if (target.some(a => norm.includes(normalizeSearch(a)))) return true;
  for (const [prov, aliases] of Object.entries(aliasMap)) {
    if (prov === province) continue;
    if (aliases.some(a => norm.includes(normalizeSearch(a)))) return false;
  }
  return true;
}

export function computeVisibleColIdx(
  sheet: AeoSheet,
  office: TransactionOffice,
  aliasMap: Record<string, string[]> | undefined,
  showAll: boolean,
): number[] | null {
  if (sheet.localityMode !== 'column' || !sheet.columnLocality) return null;
  if (showAll || !aliasMap) return null;
  const sttIdx = sheet.headers.findIndex(h => h.trim().toLowerCase() === 'stt');
  const idx = sheet.headers
    .map((_, i) => i)
    .filter(i => i === sttIdx || isLocalityRelevant(sheet.columnLocality![i], office.province, aliasMap));
  return idx.length > (sttIdx >= 0 ? 1 : 0) ? idx : null; // fall back to "all" if nothing matched
}

export function computeLocalityFilteredRows(
  sheet: AeoSheet,
  office: TransactionOffice,
  aliasMap: Record<string, string[]> | undefined,
  showAll: boolean,
): AeoRow[] {
  if (sheet.localityMode !== 'row' || showAll || !aliasMap) return sheet.rows;
  const filtered = sheet.rows.filter(r => r.group || isLocalityRelevant(r.locality, office.province, aliasMap));
  const hasAnyData = filtered.some(r => !r.group);
  return hasAnyData ? filtered : sheet.rows;
}

export function sheetHasVisibleContent(rows: AeoRow[], visibleColIdx: number[] | null, sttIdx: number): boolean {
  return rows.some(r => {
    if (r.group) return false;
    return r.cells.some((v, ci) => ci !== sttIdx && v.trim() && (!visibleColIdx || visibleColIdx.includes(ci)));
  });
}

/** Strips a divider's decoration (leading emoji, "TỪ KHÓA n:"/"NHÓM n:" prefix, quotes) for display. */
function cleanDividerLabel(text: string): string {
  return text
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/^(TỪ KHÓA|NHÓM)\s*\d*\s*[:\-–]\s*/iu, '')
    .replace(/^["“]+|["”]+$/g, '')
    .trim();
}

/**
 * Resolves a raw divider label to a clean display value: the province name
 * it refers to when it matches this region's alias table (e.g. `TỪ KHÓA 1:
 * "VAY TIỀN NHANH HÀ TĨNH"` → `Hà Tĩnh`), otherwise its decoration stripped
 * as-is (e.g. Hà Nội's `NHÓM 1: F88 KHÔNG ĐƯỢC NHẮC` → `F88 KHÔNG ĐƯỢC NHẮC`)
 * — every region's local sheet renders through the same merged table either way.
 */
function resolveLocalityLabel(rawLabel: string, aliasMap: Record<string, string[]> | undefined): string {
  if (aliasMap) {
    const norm = normalizeSearch(rawLabel);
    for (const [province, aliases] of Object.entries(aliasMap)) {
      if (aliases.some(a => norm.includes(normalizeSearch(a)))) return province;
    }
  }
  return cleanDividerLabel(rawLabel);
}

/**
 * Reshapes a divider-grouped sheet into the same "merged Địa phương column"
 * table shape as an explicit_column sheet: drops the divider banner rows,
 * prepends a synthetic Địa phương column carrying each row's already-resolved
 * `locality`, blanked out on every row but the first of each group so
 * MergedTable's existing blank-cell rowspan logic merges it automatically —
 * giving every region the same Excel-style merged table, whatever its
 * original sheet layout was.
 */
export function toMergedLocalityShape(
  sheet: AeoSheet,
  rows: AeoRow[],
  aliasMap?: Record<string, string[]>,
): { headers: string[]; rows: AeoRow[] } {
  if (sheet.localitySource !== 'divider') return { headers: sheet.headers, rows };
  const sttIdx = sheet.headers.findIndex(h => h.trim().toLowerCase() === 'stt');
  const keepIdx = sheet.headers.map((_, i) => i).filter(i => i !== sttIdx);
  const headers = ['Địa phương', ...keepIdx.map(i => sheet.headers[i])];
  let lastRaw: string | null = null;
  const outRows: AeoRow[] = [];
  for (const r of rows) {
    if (r.group) continue;
    const rawLoc = r.locality ?? '';
    const show = rawLoc !== lastRaw;
    lastRaw = rawLoc;
    const label = show ? resolveLocalityLabel(rawLoc, aliasMap) : '';
    outRows.push({ group: false, locality: r.locality, cells: [label, ...keepIdx.map(i => r.cells[i] ?? '')] });
  }
  return { headers, rows: outRows };
}
