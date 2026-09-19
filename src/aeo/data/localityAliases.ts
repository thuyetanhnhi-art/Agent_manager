import type { RegionZone2026 } from '../types';

/**
 * Maps each *current* province name (as stored on TransactionOffice.province,
 * post-2025 administrative merger) to the raw place-name text fragments that
 * appear inside the AEO keyword scripts for that region — the scripts still
 * use the pre-merger names people actually search with (e.g. "Bình Thuận",
 * "Cam Ranh"), while the PGD dataset already reports the merged province.
 *
 * Only regions with more than one distinct province in the office dataset
 * need an entry — a region with a single province (Hà Nội, Hồ Chí Minh 1/2)
 * has nothing to disambiguate, so it's intentionally omitted here.
 */
export const REGION_LOCALITY_ALIASES: Partial<Record<RegionZone2026, Record<string, string[]>>> = {
  'Đông Bắc Bộ': {
    'Bắc Ninh': ['bắc ninh', 'bắc giang'],
    'Hải Phòng': ['hải phòng', 'hải dương'],
    'Hưng Yên': ['hưng yên', 'thái bình'],
    'Quảng Ninh': ['quảng ninh'],
  },
  'Tây Bắc Bộ': {
    'Cao Bằng': ['cao bằng'],
    'Lai Châu': ['lai châu'],
    'Lào Cai': ['lào cai', 'yên bái'],
    'Lạng Sơn': ['lạng sơn'],
    'Phú Thọ': ['phú thọ', 'vĩnh phúc', 'hòa bình'],
    'Sơn La': ['sơn la'],
    'Thái Nguyên': ['thái nguyên', 'bắc kạn'],
    'Tuyên Quang': ['tuyên quang', 'hà giang'],
    'Điện Biên': ['điện biên'],
  },
  'Bắc Trung Bộ': {
    'Hà Tĩnh': ['hà tĩnh'],
    'Nghệ An': ['nghệ an'],
    'Ninh Bình': ['ninh bình', 'nam định', 'hà nam'],
    'Thanh Hóa': ['thanh hóa'],
  },
  'Trung Bộ': {
    'Đà Nẵng': ['đà nẵng', 'quảng nam'],
    'Quảng Trị': ['quảng trị', 'quảng bình'],
    'Huế': ['huế', 'thừa thiên'],
    'Quảng Ngãi': ['quảng ngãi', 'kon tum'],
    'Gia Lai': ['gia lai', 'bình định'],
  },
  'Nam Trung Bộ': {
    'Khánh Hòa': ['khánh hòa', 'cam ranh', 'nha trang', 'ninh thuận'],
    'Lâm Đồng': ['lâm đồng', 'đà lạt', 'lâm hà', 'bình thuận', 'đắk nông'],
    'Đắk Lắk': ['đắk lắk', 'phú yên', 'buôn ma thuột'],
  },
  'Đông Nam Bộ': {
    'Hồ Chí Minh': ['hồ chí minh', 'tphcm', 'tp.hcm', 'sài gòn', 'bà rịa', 'vũng tàu'],
    'Đồng Nai': ['đồng nai', 'bình phước'],
  },
  'Tây Nam Bộ 1': {
    'Tây Ninh': ['tây ninh', 'long an'],
    'Vĩnh Long': ['vĩnh long', 'bến tre', 'trà vinh'],
    'Đồng Tháp': ['đồng tháp', 'tiền giang'],
  },
  'Tây Nam Bộ 2': {
    'An Giang': ['an giang', 'kiên giang'],
    'Cà Mau': ['cà mau', 'bạc liêu'],
    'Cần Thơ': ['cần thơ', 'hậu giang', 'sóc trăng'],
  },
};
