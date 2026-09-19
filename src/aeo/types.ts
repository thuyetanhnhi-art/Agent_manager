// Vùng miền theo Phân vùng 2026 (11 vùng, mã 01-11 từ Bắc vào Nam)
export type RegionZone2026 =
  | 'Hà Nội'
  | 'Đông Bắc Bộ'
  | 'Tây Bắc Bộ'
  | 'Bắc Trung Bộ'
  | 'Trung Bộ'
  | 'Nam Trung Bộ'
  | 'Đông Nam Bộ'
  | 'Hồ Chí Minh 1'
  | 'Hồ Chí Minh 2'
  | 'Tây Nam Bộ 1'
  | 'Tây Nam Bộ 2';

export interface TransactionOffice {
  id: string;
  name: string;
  code: string;
  region: RegionZone2026;
  province: string;
  status: 'Active' | 'Coming soon';
}

export type SheetKind = 'guide' | 'common' | 'local';
export type LocalityMode = 'row' | 'column' | 'none';
export type LocalitySource = 'explicit_column' | 'divider' | 'header' | 'none';

export interface AeoRow {
  cells: string[];
  group: boolean;
  locality: string | null;
}

export interface AeoSheet {
  name: string;
  kind: SheetKind;
  headers: string[];
  rows: AeoRow[];
  localityMode: LocalityMode;
  columnLocality: (string | null)[] | null;
  localitySource: LocalitySource;
}

export interface AeoRegionData {
  region: RegionZone2026;
  sheets: AeoSheet[];
}

export interface ManifestEntry {
  region: RegionZone2026;
  slug: string;
  sheetCount: number;
}
