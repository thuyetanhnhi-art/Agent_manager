import { useState } from 'react';
import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Bot, Settings, ChevronLeft, ChevronDown, ChevronRight,
  Zap, RefreshCw, Plus, List, Server, BookOpen, Layers, ScanEye, ClipboardList, Phone, LogOut, Sparkles,
} from 'lucide-react';

// Tạm ẩn mục "SĐT Facebook" khỏi menu — đổi thành true để hiện lại.
const SHOW_FB_LEADS_NAV = false;
import clsx from 'clsx';
import { useStore } from '../store';
import { useProjectStore } from '../projectStore';
import { fetchRepos } from '../services/api';

export function Sidebar() {
  const { sidebarOpen, toggleSidebar, tasks } = useStore();
  const { projects, activeProjectId, setActiveProject, openRepoPicker, reposRoot, syncProjects, setReposRoot } = useProjectStore();
  const navigate = useNavigate();

  const [projectsOpen, setProjectsOpen] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(false);

  const projectList = Object.values(projects).sort((a, b) => a.name.localeCompare(b.name));

  function allTaskCount() {
    return Object.values(tasks).filter(t => t.parentId === null).length;
  }

  function projectTaskCount(projectId: string) {
    return Object.values(tasks).filter(t => t.projectId === projectId && t.parentId === null).length;
  }

  async function handleSync() {
    setSyncing(true);
    setSyncError(false);
    try {
      const data = await fetchRepos(reposRoot);
      syncProjects(data.repos);
      if (data.root && data.root !== reposRoot) setReposRoot(data.root);
    } catch {
      setSyncError(true);
      setTimeout(() => setSyncError(false), 3000);
    } finally {
      setSyncing(false);
    }
  }

  function selectProject(id: string) {
    setActiveProject(activeProjectId === id ? null : id);
    navigate('/tasks');
  }

  /* ── Shared nav-item class ─────────────────────────────────────── */
  const navBase = 'flex items-center gap-2.5 px-2 py-2 rounded-xl text-sm transition-colors';
  const navActive = 'bg-primary-glow text-primary font-medium';
  const navIdle = 'text-slate-500 hover:bg-hover hover:text-slate-700';

  return (
    <aside
      className={clsx(
        'flex flex-col bg-surface border-r border-border transition-all duration-300 shrink-0 h-screen sticky top-0 shadow-sm',
        sidebarOpen ? 'w-56' : 'w-14',
      )}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 px-3 py-4 border-b border-border">
        <div className="w-8 h-8 rounded-xl bg-primary flex items-center justify-center shrink-0 shadow-sm">
          <Zap size={15} className="text-white" />
        </div>
        {sidebarOpen && (
          <span className="font-semibold text-sm text-slate-800 truncate">Agent Manager</span>
        )}
        <button
          onClick={toggleSidebar}
          className={clsx('ml-auto p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-hover transition-colors', !sidebarOpen && 'hidden')}
        >
          <ChevronLeft size={14} />
        </button>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-3 flex flex-col gap-0.5 px-2 overflow-y-auto">

        {/* Dashboard */}
        <NavLink to="/" end className={({ isActive }) => clsx(navBase, isActive ? navActive : navIdle)}>
          <LayoutDashboard size={16} className="shrink-0" />
          {sidebarOpen && <span>Dashboard</span>}
        </NavLink>

        {/* Agents */}
        <NavLink to="/agents" className={({ isActive }) => clsx(navBase, isActive ? navActive : navIdle)}>
          <Bot size={16} className="shrink-0" />
          {sidebarOpen && <span>Agents</span>}
        </NavLink>

        {/* MCP Servers */}
        <NavLink to="/mcp" className={({ isActive }) => clsx(navBase, isActive ? navActive : navIdle)}>
          <Server size={16} className="shrink-0" />
          {sidebarOpen && <span>MCP Servers</span>}
        </NavLink>

        {/* Agent Monitor */}
        <NavLink to="/prompts" className={({ isActive }) => clsx(navBase, isActive ? navActive : navIdle)}>
          <BookOpen size={16} className="shrink-0" />
          {sidebarOpen && <span>Agent Monitor</span>}
        </NavLink>

        {/* Skills Catalog */}
        <NavLink to="/skills" className={({ isActive }) => clsx(navBase, isActive ? navActive : navIdle)}>
          <Zap size={16} className="shrink-0" />
          {sidebarOpen && <span>Skills</span>}
        </NavLink>

        {/* QC Images */}
        <NavLink to="/qc" className={({ isActive }) => clsx(navBase, isActive ? navActive : navIdle)}>
          <ScanEye size={16} className="shrink-0" />
          {sidebarOpen && <span>QC Hình ảnh</span>}
        </NavLink>

        {/* Survey */}
        <NavLink to="/survey" className={({ isActive }) => clsx(navBase, isActive ? navActive : navIdle)}>
          <ClipboardList size={16} className="shrink-0" />
          {sidebarOpen && <span>Khảo sát</span>}
        </NavLink>

        {/* Facebook Leads — tạm ẩn khỏi menu, đổi SHOW_FB_LEADS_NAV = true để bật lại */}
        {SHOW_FB_LEADS_NAV && (
          <NavLink to="/fb-leads" className={({ isActive }) => clsx(navBase, isActive ? navActive : navIdle)}>
            <Phone size={16} className="shrink-0" />
            {sidebarOpen && <span>SĐT Facebook</span>}
          </NavLink>
        )}

        {/* AEO Toàn Dân — kịch bản phản hồi AI Search theo PGD */}
        <NavLink to="/aeo-scripts" className={({ isActive }) => clsx(navBase, isActive ? navActive : navIdle)}>
          <Sparkles size={16} className="shrink-0" />
          {sidebarOpen && <span>Kịch bản AEO</span>}
        </NavLink>

        {/* ── Projects section ──────────────────────────────────── */}
        {sidebarOpen ? (
          <div className="mt-3">
            {/* Section header — small label + controls */}
            <div className="flex items-center justify-between px-2 mb-1">
              <button
                onClick={() => setProjectsOpen(v => !v)}
                className="flex items-center gap-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider hover:text-slate-600 transition-colors"
              >
                {projectsOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                Projects
              </button>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={handleSync}
                  title="Sync from configured folder"
                  className={clsx(
                    'p-1 rounded-lg transition-colors',
                    syncError ? 'text-red-400 bg-red-50' : 'text-slate-400 hover:text-primary hover:bg-primary-glow',
                  )}
                >
                  <RefreshCw size={11} className={syncing ? 'animate-spin' : ''} />
                </button>
                <button
                  onClick={openRepoPicker}
                  title="Pick folders manually"
                  className="p-1 text-slate-400 hover:text-primary hover:bg-primary-glow rounded-lg transition-colors"
                >
                  <Plus size={11} />
                </button>
              </div>
            </div>

            {projectsOpen && (
              <div className="space-y-0.5">
                {/* All Tasks — same height/size as nav links */}
                <button
                  onClick={() => { setActiveProject(null); navigate('/tasks'); }}
                  className={clsx(navBase, 'w-full text-left', !activeProjectId ? navActive : navIdle)}
                >
                  <div className="w-4 h-4 rounded-lg bg-slate-100 shrink-0 flex items-center justify-center">
                    <List size={10} className="text-slate-500" />
                  </div>
                  <span className="truncate flex-1">All Tasks</span>
                  <span className="text-[9px] font-mono opacity-60">{allTaskCount()}</span>
                </button>

                {/* Project rows */}
                {projectList.map(p => {
                  const count = projectTaskCount(p.id);
                  const isActive = activeProjectId === p.id;
                  return (
                    <div key={p.id} className="group/row relative flex items-center">
                      <button
                        onClick={() => selectProject(p.id)}
                        className={clsx(navBase, 'w-full text-left min-w-0', isActive ? navActive : navIdle)}
                      >
                        <div
                          className="w-4 h-4 rounded-lg shrink-0 flex items-center justify-center"
                          style={{ background: `${p.color}22` }}
                        >
                          <div className="w-2 h-2 rounded-full" style={{ background: p.color }} />
                        </div>
                        <span className="truncate flex-1">{p.name}</span>
                        <span className={clsx('text-[9px] font-mono group-hover/row:invisible', isActive ? 'opacity-70' : 'opacity-40')}>
                          {count}
                        </span>
                      </button>
                      <button
                        onClick={() => navigate(`/project/${p.id}`)}
                        title="Source Manager"
                        className="absolute right-1.5 hidden group-hover/row:flex items-center justify-center p-1 rounded-md text-violet-500 hover:bg-violet-50 transition-colors"
                      >
                        <Layers size={11} />
                      </button>
                    </div>
                  );
                })}

                {projectList.length === 0 && (
                  <div className="px-2 py-2 text-xs text-slate-400 leading-relaxed">
                    No projects.{' '}
                    <button onClick={handleSync} className="text-primary underline">Sync</button>
                    {' '}or{' '}
                    <button onClick={openRepoPicker} className="text-primary underline">add</button>.
                  </div>
                )}

                {syncError && (
                  <div className="mx-1 px-2 py-1.5 text-[10px] text-red-600 bg-red-50 border border-red-200 rounded-lg">
                    Scan failed — check Settings path.
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          /* Collapsed: folder icon shortcut */
          <button
            onClick={toggleSidebar}
            title="Projects (expand sidebar)"
            className={clsx(
              'flex items-center justify-center mt-2 py-2 rounded-xl w-full transition-colors',
              activeProjectId ? navActive : 'text-slate-400 hover:text-slate-600 hover:bg-hover',
            )}
          >
            <List size={16} />
          </button>
        )}
      </nav>

      {/* Settings + Logout */}
      <div className="px-2 pb-4 border-t border-border pt-2 space-y-1">
        <NavLink to="/settings" className={({ isActive }) => clsx(navBase, isActive ? navActive : 'text-slate-400 hover:bg-hover hover:text-slate-600')}>
          <Settings size={16} className="shrink-0" />
          {sidebarOpen && <span>Settings</span>}
        </NavLink>
        <UserBadge sidebarOpen={sidebarOpen} />
      </div>
    </aside>
  );
}

function UserBadge({ sidebarOpen }: { sidebarOpen: boolean }) {
  const navigate = useNavigate();
  const [session, setSession] = React.useState(() => {
    try {
      const raw = localStorage.getItem('agentmgr:auth_v1');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });

  if (!session) return null;

  function logout() {
    localStorage.removeItem('agentmgr:auth_v1');
    setSession(null);
    navigate('/login', { replace: true });
  }

  return sidebarOpen ? (
    <div className="flex items-center gap-2 px-2 py-2 rounded-xl border border-border bg-slate-50/60">
      {session.picture && (
        <img src={session.picture} alt="" className="w-6 h-6 rounded-full shrink-0" referrerPolicy="no-referrer" />
      )}
      <span className="text-[10px] text-slate-500 truncate flex-1 min-w-0">{session.email}</span>
      <button onClick={logout} title="Đăng xuất"
        className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors shrink-0">
        <LogOut size={13} />
      </button>
    </div>
  ) : (
    <button onClick={logout} title="Đăng xuất"
      className="flex items-center justify-center w-full py-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition-colors">
      <LogOut size={16} />
    </button>
  );
}
