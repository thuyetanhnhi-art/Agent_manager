export type QuestionType = 'text' | 'paragraph' | 'radio' | 'checkbox' | 'select' | 'rating';

export interface SurveyQuestion {
  id: string;
  type: QuestionType;
  title: string;
  description?: string;
  required: boolean;
  options?: string[];
  ratingMax?: number;
}

export interface Survey {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  questions: SurveyQuestion[];
  // Distribution metadata
  deadline?: string;
  formsLink?: string;
  sheetUrl?: string;
  targetPGDs?: string[];
  sentAt?: string;
}

export interface SurveyResponse {
  id: string;
  surveyId: string;
  officeId: string;
  submittedAt: string;
  answers: Record<string, string | string[] | number>;
}

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
