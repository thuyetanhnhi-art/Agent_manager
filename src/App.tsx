import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { FolderOpen, Check, Network } from 'lucide-react';
import clsx from 'clsx';
import { Sidebar } from './components/Sidebar';
import { Terminal } from './components/Terminal';
import { CreateTaskModal } from './components/CreateTaskModal';
import { RepoPickerModal } from './components/RepoPickerModal';
import { TaskDetailPanel } from './components/TaskDetailPanel';
import { Header } from './components/Header';
import { DashboardPage } from './pages/DashboardPage';
import { TasksPage } from './pages/TasksPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { AgentsPage } from './pages/AgentsPage';
import { McpPage } from './pages/McpPage';
import { PromptLibraryPage } from './pages/PromptLibraryPage';
import { SkillsPage } from './pages/SkillsPage';
import { ProjectSourcePage } from './pages/ProjectSourcePage';
import { QCPage } from './pages/QCPage';
import { FacebookLeadsPage } from './pages/FacebookLeadsPage';
import { AeoScriptsPage } from './pages/AeoScriptsPage';
import { SurveyPage } from './pages/SurveyPage';
import { SurveyPortalPage } from './pages/SurveyPortalPage';
import { LoginPage } from './pages/LoginPage';
import { useProjectStore } from './projectStore';
import { useUsageStore } from './usageStore';
import { useSettingsStore } from './settingsStore';
import { getSession } from './auth';

export default function App() {
  const startAutoRefresh = useUsageStore(s => s.startAutoRefresh);
  useEffect(() => { startAutoRefresh(); }, [startAutoRefresh]);

  return (
    <Routes>
      {/* Public: survey portal for PGD respondents */}
      <Route path="/portal" element={<SurveyPortalPage />} />
      {/* Public: login */}
      <Route path="/login" element={<LoginPage />} />
      {/* Protected: admin layout */}
      <Route path="/*" element={<AuthGuard><AdminLayout /></AuthGuard>} />
    </Routes>
  );
}

// Tạm ẩn chức năng đăng nhập — bỏ comment dòng dưới để bật lại yêu cầu đăng nhập.
const LOGIN_REQUIRED = false;

function AuthGuard({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const session = getSession();
  if (LOGIN_REQUIRED && !session) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

function AdminLayout() {
  return (
    <div className="flex h-screen bg-base text-slate-800 overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-hidden flex flex-col">
        <Routes>
          <Route path="/"          element={<DashboardPage />} />
          <Route path="/tasks"     element={<TasksPage />} />
          <Route path="/tasks/:id" element={<TaskDetailPage />} />
          <Route path="/agents"    element={<AgentsPage />} />
          <Route path="/mcp"       element={<McpPage />} />
          <Route path="/prompts"   element={<PromptLibraryPage />} />
          <Route path="/skills"      element={<SkillsPage />} />
          <Route path="/project/:id" element={<ProjectSourcePage />} />
          <Route path="/qc"        element={<QCPage />} />
          <Route path="/fb-leads"  element={<FacebookLeadsPage />} />
          <Route path="/aeo-scripts" element={<AeoScriptsPage />} />
          <Route path="/survey"    element={<SurveyPage />} />
          <Route path="/survey/create"         element={<SurveyPage />} />
          <Route path="/survey/:id/edit"       element={<SurveyPage />} />
          <Route path="/survey/:id/fill"       element={<SurveyPage />} />
          <Route path="/survey/:id/report"     element={<SurveyPage />} />
          <Route path="/settings"  element={<SettingsPage />} />
        </Routes>
      </main>
      <Terminal />
      <TaskDetailPanel />
      <CreateTaskModal />
      <RepoPickerModal />
    </div>
  );
}

function SettingsPage() {
  const { reposRoot, setReposRoot } = useProjectStore();
  const { proxyEnabled, setProxyEnabled, proxyUrl, setProxyUrl } = useSettingsStore();
  const [reposInput, setReposInput] = useState(reposRoot);
  const [proxyInput, setProxyInput] = useState(proxyUrl);
  const [saved, setSaved] = useState(false);

  function saveRepos() {
    const v = reposInput.trim() || reposRoot;
    setReposRoot(v);
    localStorage.setItem('agentmgr:terminalBasePath', v);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function saveProxy() {
    const newUrl = proxyInput.trim() || proxyUrl;
    setProxyUrl(newUrl);
    fetch('/api/settings/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxyEnabled, proxyUrl: newUrl }),
    }).catch(console.error);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="flex-1 overflow-y-auto bg-base">
      <Header title="Settings" subtitle="Configuration" />
      <div className="px-6 py-4 max-w-2xl space-y-4">
        <div className="bg-white border border-border rounded-2xl p-5 shadow-card">
          <div className="flex items-center gap-2 mb-1">
            <FolderOpen size={14} className="text-primary" />
            <h2 className="text-sm font-semibold text-slate-700">Repositories Root</h2>
          </div>
          <p className="text-xs text-slate-500 mb-3 leading-relaxed">
            Shared base path for scanning projects, opening terminals, and knowledge base folders
            (<code className="bg-slate-100 px-1 rounded font-mono text-violet-600">_skills/</code>,{' '}
            <code className="bg-slate-100 px-1 rounded font-mono text-violet-600">_prompt/</code>).
          </p>
          <div className="flex gap-2">
            <input
              value={reposInput}
              onChange={e => setReposInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveRepos()}
              placeholder="C:\Users\...\source\repos"
              className="flex-1 bg-white border border-slate-200 focus:border-violet-400 rounded-xl px-3 py-2 text-xs text-slate-700 font-mono placeholder-slate-400 outline-none transition-colors"
            />
            <button
              onClick={saveRepos}
              className={clsx('px-3 py-2 text-white text-xs font-medium rounded-xl transition-colors shadow-sm', saved ? 'bg-emerald-500' : 'bg-primary hover:bg-primary/90')}
            >
              {saved ? <Check size={13} /> : 'Save'}
            </button>
          </div>
          <p className="text-[10px] text-slate-400 mt-2 font-mono truncate">{reposRoot || '—'}</p>
        </div>

        <div className="bg-white border border-border rounded-2xl p-5 shadow-card">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Network size={14} className="text-primary" />
              <h2 className="text-sm font-semibold text-slate-700">Proxy for MCP</h2>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={proxyEnabled}
                onChange={e => {
                  setProxyEnabled(e.target.checked);
                  fetch('/api/settings/proxy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ proxyEnabled: e.target.checked, proxyUrl }),
                  }).catch(console.error);
                }}
                className="w-4 h-4 rounded border-slate-300 text-primary focus:ring-primary"
              />
              <span className="text-xs text-slate-600 font-medium">{proxyEnabled ? 'Enabled' : 'Disabled'}</span>
            </label>
          </div>
          <p className="text-xs text-slate-500 mb-3 leading-relaxed">
            Enable proxy for MCP servers to connect through corporate network (GitLab, Jira, etc.)
          </p>
          {proxyEnabled && (
            <div className="flex gap-2">
              <input
                value={proxyInput}
                onChange={e => setProxyInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveProxy()}
                placeholder="http://proxy.hcm.fpt.vn:80"
                className="flex-1 bg-white border border-slate-200 focus:border-violet-400 rounded-xl px-3 py-2 text-xs text-slate-700 font-mono placeholder-slate-400 outline-none transition-colors"
              />
              <button
                onClick={saveProxy}
                className={clsx('px-3 py-2 text-white text-xs font-medium rounded-xl transition-colors shadow-sm', saved ? 'bg-emerald-500' : 'bg-primary hover:bg-primary/90')}
              >
                {saved ? <Check size={13} /> : 'Save'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
