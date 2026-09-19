import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, AlertCircle } from 'lucide-react';
import { decodeGoogleJwt, isAllowed, saveSession, getSession } from '../auth';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: object) => void;
          renderButton: (el: HTMLElement, config: object) => void;
          prompt: () => void;
        };
      };
    };
  }
}

export function LoginPage() {
  const navigate = useNavigate();
  const btnRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [scriptLoaded, setScriptLoaded] = useState(false);

  // Already logged in → redirect
  useEffect(() => {
    if (getSession()) navigate('/', { replace: true });
  }, [navigate]);

  // Load Google GIS script
  useEffect(() => {
    if (!CLIENT_ID) return;
    if (window.google?.accounts) { setScriptLoaded(true); return; }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => setScriptLoaded(true);
    document.head.appendChild(script);
  }, []);

  // Initialize + render button after script loads
  useEffect(() => {
    if (!scriptLoaded || !window.google || !btnRef.current || !CLIENT_ID) return;

    window.google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: (response: { credential: string }) => {
        const payload = decodeGoogleJwt(response.credential);
        if (!payload) { setError('Không đọc được thông tin tài khoản.'); return; }
        if (!isAllowed(payload.email)) {
          setError(`Tài khoản ${payload.email} không được phép truy cập.`);
          return;
        }
        saveSession(payload.email, payload.name, payload.picture);
        navigate('/', { replace: true });
      },
    });

    window.google.accounts.id.renderButton(btnRef.current, {
      theme: 'outline',
      size: 'large',
      width: 280,
      text: 'signin_with',
      locale: 'vi',
    });
  }, [scriptLoaded, navigate]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-violet-950 to-slate-900 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden">
        {/* Top accent */}
        <div className="h-1.5 bg-gradient-to-r from-violet-500 to-indigo-500" />

        <div className="p-8 space-y-6">
          {/* Logo */}
          <div className="text-center space-y-3">
            <div className="inline-flex items-center justify-center w-14 h-14 bg-primary/10 border border-primary/20 rounded-2xl">
              <ShieldCheck size={28} className="text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-black text-slate-800">Agent Task Manager</h1>
              <p className="text-xs text-slate-500 mt-0.5">Đăng nhập để tiếp tục</p>
            </div>
          </div>

          {/* Google button */}
          <div className="flex flex-col items-center gap-4">
            {!CLIENT_ID ? (
              <div className="w-full bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs text-amber-800 leading-relaxed">
                <strong>Chưa cấu hình Google Client ID.</strong><br />
                Thêm <code className="bg-amber-100 px-1 rounded">VITE_GOOGLE_CLIENT_ID=...</code> vào file <code className="bg-amber-100 px-1 rounded">.env.local</code>
              </div>
            ) : (
              <div ref={btnRef} />
            )}

            {error && (
              <div className="w-full flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-700">
                <AlertCircle size={13} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}
          </div>

          <p className="text-center text-[11px] text-slate-300">
            Chỉ tài khoản nội bộ được phép truy cập
          </p>
        </div>
      </div>
    </div>
  );
}
