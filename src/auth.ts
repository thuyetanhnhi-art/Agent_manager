const ALLOWED_EMAILS = ['thanhungpham2601@gmail.com', 'thanhhungpham2601@gmail.com'];
const STORAGE_KEY = 'agentmgr:auth_v1';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000; // 7 ngày

export interface AuthSession {
  email: string;
  name: string;
  picture: string;
  exp: number;
}

export function getSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s: AuthSession = JSON.parse(raw);
    if (Date.now() > s.exp) { localStorage.removeItem(STORAGE_KEY); return null; }
    if (!ALLOWED_EMAILS.includes(s.email)) { localStorage.removeItem(STORAGE_KEY); return null; }
    return s;
  } catch { return null; }
}

export function saveSession(email: string, name: string, picture: string) {
  const s: AuthSession = { email, name, picture, exp: Date.now() + SESSION_MS };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

/** Decode Google JWT credential (no library needed — payload is base64url) */
export function decodeGoogleJwt(credential: string): { email: string; name: string; picture: string } | null {
  try {
    const payload = credential.split('.')[1];
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return { email: json.email ?? '', name: json.name ?? '', picture: json.picture ?? '' };
  } catch { return null; }
}

export function isAllowed(email: string) {
  return ALLOWED_EMAILS.includes(email);
}
