import { create } from 'zustand';

const KB_ROOT_KEY = 'agentmgr:kbroot';
const PROXY_ENABLED_KEY = 'agentmgr:proxy:enabled';
const PROXY_URL_KEY = 'agentmgr:proxy:url';

interface SettingsState {
  kbRootPath: string;
  setKbRootPath: (path: string) => void;
  proxyEnabled: boolean;
  setProxyEnabled: (enabled: boolean) => void;
  proxyUrl: string;
  setProxyUrl: (url: string) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  kbRootPath: localStorage.getItem(KB_ROOT_KEY) ?? '',
  setKbRootPath: (path) => {
    localStorage.setItem(KB_ROOT_KEY, path);
    set({ kbRootPath: path });
  },
  proxyEnabled: localStorage.getItem(PROXY_ENABLED_KEY) === 'true',
  setProxyEnabled: (enabled) => {
    localStorage.setItem(PROXY_ENABLED_KEY, String(enabled));
    set({ proxyEnabled: enabled });
  },
  proxyUrl: localStorage.getItem(PROXY_URL_KEY) ?? 'http://proxy.hcm.fpt.vn:80',
  setProxyUrl: (url) => {
    localStorage.setItem(PROXY_URL_KEY, url);
    set({ proxyUrl: url });
  },
}));

export function computeBasePath(kbRootPath: string, projectName: string, repoPath: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (kbRootPath.trim()) return `${norm(kbRootPath)}/${projectName}`;
  return norm(repoPath);
}
