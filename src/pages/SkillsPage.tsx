import { useState, useMemo, useEffect } from 'react';
import {
  ExternalLink, Copy, Check, Zap, Shield, TestTube, FileText,
  Code2, BarChart3, Bug, Layers, Star, Plus, X,
  FolderOpen, ChevronDown, Loader, Download, Database,
  Github,
} from 'lucide-react';
import clsx from 'clsx';
import { Header } from '../components/Header';
import { useKnowledgeStore } from '../knowledgeStore';
import { useProjectStore } from '../projectStore';
import { computeBasePath } from '../settingsStore';
import { saveSkillToProject } from '../services/api';
import { KB_GEN_PROMPT } from '../kbConstants';
import { Project } from '../types';
import { TerminalModal } from '../components/TerminalModal';

interface ParsedGithubSkill {
  id: string;
  name: string;
  description: string;
  category: string;
  tools: string[];
  promptTemplate: string;
  repoUrl: string;
  sourceRepo: string;
  stars: number;
}

interface ImportedSkill {
  id: string;
  name: string;
  description: string;
  category: string;
  tools: string[];
  promptTemplate: string;
  repoUrl: string;
  sourceRepo: string;
  importedAt: string;
}

interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  tools: string[];
  promptTemplate: string;
  repoUrl?: string;
  icon: React.ReactNode;
  color: string;
  bg: string;
}

const CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
  engineering: { label: 'Engineering', color: 'text-blue-600 bg-blue-50' },
  quality:     { label: 'Quality',     color: 'text-emerald-600 bg-emerald-50' },
  docs:        { label: 'Docs',        color: 'text-teal-600 bg-teal-50' },
};

const SKILL_PATHS_KEY = 'agentmgr:skill-paths';

function loadSkillPaths(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(SKILL_PATHS_KEY) ?? '{}'); } catch { return {}; }
}

function saveSkillPath(projectId: string, path: string) {
  const paths = loadSkillPaths();
  paths[projectId] = path;
  localStorage.setItem(SKILL_PATHS_KEY, JSON.stringify(paths));
}

type ModalStep = 'pick-project' | 'saving' | 'added';

interface AddSkillState {
  skill: Skill;
  step: ModalStep;
  selectedProject: Project | null;
  savedToFile: boolean;
  saveError: string | null;
  showKbPrompt: boolean;
  customPathSuffix: string;
}

function buildPageList(current: number, total: number): (number | '...')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | '...')[] = [];
  const addPage = (p: number) => { if (!pages.includes(p)) pages.push(p); };
  addPage(1);
  if (current > 3) pages.push('...');
  for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p++) addPage(p);
  if (current < total - 2) pages.push('...');
  addPage(total);
  return pages;
}

export function SkillsPage() {
  const [copied, setCopied] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'engineering' | 'quality' | 'docs'>('all');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 4;
  const [addState, setAddState] = useState<AddSkillState | null>(null);
  const [copiedKb, setCopiedKb] = useState(false);
  const [showGenKb, setShowGenKb] = useState(false);
  const [genKbProjectId, setGenKbProjectId] = useState<string>('');
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalCwd, setTerminalCwd] = useState('');
  const [skillPaths, setSkillPaths] = useState<Record<string, string>>(loadSkillPaths);

  const { entries, addSkillEntry } = useKnowledgeStore();
  const { projects, reposRoot } = useProjectStore();

  const [githubSkills, setGithubSkills] = useState<ParsedGithubSkill[]>(() => {
    try { return JSON.parse(localStorage.getItem('agentmgr:github-skills') ?? '[]') as ParsedGithubSkill[]; } catch { return []; }
  });
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [needsGithubSetup, setNeedsGithubSetup] = useState(false);
  const [importedSkills, setImportedSkills] = useState<ImportedSkill[]>(() => {
    try { return JSON.parse(localStorage.getItem('agentmgr:imported-skills') ?? '[]') as ImportedSkill[]; } catch { return []; }
  });

  const projectList = useMemo(() => Object.values(projects).filter(p => p.repoPath !== '__jira__'), [projects]);

  const tabCounts = useMemo(() => ({
    all:         githubSkills.length,
    engineering: githubSkills.filter(s => s.category === 'engineering').length,
    quality:     githubSkills.filter(s => s.category === 'quality').length,
    docs:        githubSkills.filter(s => s.category === 'docs').length,
  }), [githubSkills]);

  const filteredSkills = useMemo(
    () => filter === 'all' ? githubSkills : githubSkills.filter(s => s.category === filter),
    [githubSkills, filter],
  );
  const totalPages = Math.max(1, Math.ceil(filteredSkills.length / PAGE_SIZE));
  const pagedSkills = filteredSkills.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    if (githubSkills.length === 0 && !githubLoading) {
      fetchAllGithubSkills();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startAddToProject(skill: Skill) {
    setAddState({
      skill, step: 'pick-project', selectedProject: null,
      savedToFile: false, saveError: null, showKbPrompt: false,
      customPathSuffix: '/_skills',
    });
  }

  function handleProjectClick(project: Project) {
    const suffix = skillPaths[project.id]?.trim() || '/_skills';
    confirmProjectSelection(project, suffix);
  }

  async function confirmProjectSelection(project: Project, pathSuffix: string) {
    if (!addState) return;
    const suffix = pathSuffix.trim() || '/_skills';
    setAddState(s => s ? { ...s, step: 'saving', selectedProject: project, customPathSuffix: suffix } : s);

    const basePath = computeBasePath(reposRoot, project.name, project.repoPath);
    const result = await saveSkillToProject({
      skillsDir: `${basePath}${suffix}`,
      skillId: addState.skill.id,
      skillName: addState.skill.name,
      description: addState.skill.description,
      promptTemplate: addState.skill.promptTemplate,
    });

    saveSkillPath(project.id, suffix);
    setSkillPaths(loadSkillPaths());
    addSkillEntry(project.id, addState.skill);

    setAddState(s => s ? {
      ...s, step: 'added', selectedProject: project,
      savedToFile: result.ok,
      saveError: result.ok ? null : (result.error ?? 'Backend offline'),
      showKbPrompt: false,
    } : s);
  }

  function handleGenKbTerminal() {
    const proj = projects[genKbProjectId];
    if (!proj) return;
    setTerminalCwd(computeBasePath(reposRoot, proj.name, proj.repoPath));
    setTerminalOpen(true);
  }

  function copyKbPrompt() {
    navigator.clipboard.writeText(KB_GEN_PROMPT).catch(() => {});
    setCopiedKb(true);
    setTimeout(() => setCopiedKb(false), 1500);
  }

  async function fetchAllGithubSkills() {
    setGithubLoading(true);
    setGithubError(null);
    try {
      const r = await fetch('/api/github/all-skills');
      const d = await r.json() as { ok: boolean; skills?: ParsedGithubSkill[]; needsSetup?: boolean; error?: string };
      if (d.needsSetup) { setNeedsGithubSetup(true); }
      else if (d.ok) {
        const skills = d.skills ?? [];
        setGithubSkills(skills);
        setNeedsGithubSetup(false);
        localStorage.setItem('agentmgr:github-skills', JSON.stringify(skills));
      } else { setGithubError(d.error ?? 'Failed to fetch'); }
    } catch (e) { setGithubError(String(e)); }
    setGithubLoading(false);
  }

  function removeGithubSkill(id: string) {
    const updated = githubSkills.filter(s => s.id !== id);
    setGithubSkills(updated);
    localStorage.setItem('agentmgr:github-skills', JSON.stringify(updated));
  }

  function removeImportedSkill(id: string) {
    const updated = importedSkills.filter(s => s.id !== id);
    setImportedSkills(updated);
    localStorage.setItem('agentmgr:imported-skills', JSON.stringify(updated));
  }

  function getGithubSkillMeta(category: string, name: string): { icon: React.ReactNode; color: string; bg: string } {
    const n = (name + ' ' + category).toLowerCase();
    if (/security|auth|vuln|owasp|inject/.test(n)) return { icon: <Shield size={18} />, color: 'text-red-700', bg: 'bg-red-50 border-red-200' };
    if (/test|spec|coverage|lint/.test(n)) return { icon: <TestTube size={18} />, color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' };
    if (/doc|readme|comment|changelog/.test(n)) return { icon: <FileText size={18} />, color: 'text-teal-700', bg: 'bg-teal-50 border-teal-200' };
    if (/refactor|clean|structure|pattern|layer/.test(n)) return { icon: <Layers size={18} />, color: 'text-violet-700', bg: 'bg-violet-50 border-violet-200' };
    if (/perf|optim|speed|cache|memory|benchmark/.test(n)) return { icon: <BarChart3 size={18} />, color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' };
    if (/debug|bug|error|fix|rca/.test(n)) return { icon: <Bug size={18} />, color: 'text-orange-700', bg: 'bg-orange-50 border-orange-200' };
    if (category === 'quality') return { icon: <Shield size={18} />, color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' };
    if (category === 'docs') return { icon: <FileText size={18} />, color: 'text-teal-700', bg: 'bg-teal-50 border-teal-200' };
    return { icon: <Code2 size={18} />, color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200' };
  }

  function downloadSkillFile(skill: Skill) {
    const content = `# ${skill.name}\n\n## Description\n${skill.description}\n\n## Prompt Template\n\n${skill.promptTemplate}\n\n## Tools\n${skill.tools.length > 0 ? skill.tools.map(t => `- \`${t}\``).join('\n') : '_No specific tools required._'}\n`;
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${skill.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const projectSkillCount = useMemo(() => {
    const counts: Record<string, number> = {};
    Object.values(entries).forEach(e => {
      if (e.entryType === 'skill') {
        counts[e.projectId] = (counts[e.projectId] ?? 0) + 1;
      }
    });
    return counts;
  }, [entries]);

  const genKbProject = projects[genKbProjectId] ?? null;

  return (
    <div className="flex-1 overflow-y-auto bg-base">
      <Header
        title="Skills Catalog"
        subtitle="Reference skill library — add skills to a project's knowledge base"
      />
      <div className="px-6 py-4 space-y-4">

        {/* Category filter + GitHub fetch */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-1 bg-slate-100 p-1 rounded-xl">
            {(['all', 'engineering', 'quality', 'docs'] as const).map(cat => (
              <button
                key={cat}
                onClick={() => { setFilter(cat); setPage(1); }}
                className={clsx(
                  'flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-colors capitalize',
                  filter === cat ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700',
                )}
              >
                {cat === 'all' ? 'All' : CATEGORY_LABELS[cat].label}
                {tabCounts[cat] > 0 && (
                  <span className={clsx(
                    'text-[9px] font-semibold px-1 py-0.5 rounded-md min-w-[16px] text-center',
                    filter === cat ? 'bg-slate-200 text-slate-700' : 'bg-slate-200/60 text-slate-400',
                  )}>
                    {tabCounts[cat]}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            {needsGithubSetup && <span className="text-[10px] text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">GitHub PAT required</span>}
            {githubError && <span className="text-[10px] text-red-500 truncate max-w-40">{githubError}</span>}
            {githubSkills.length > 0 && <span className="text-[10px] text-violet-600 bg-violet-50 border border-violet-200 px-1.5 py-0.5 rounded">{githubSkills.length} from GitHub</span>}
            <button
              onClick={fetchAllGithubSkills}
              disabled={githubLoading}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-900 disabled:opacity-60 text-white text-[10px] font-medium rounded-lg transition-colors"
            >
              {githubLoading ? <Loader size={10} className="animate-spin" /> : <Github size={10} />}
              {githubLoading ? 'Fetching…' : 'Fetch GitHub'}
            </button>
          </div>
        </div>

        {/* Gen Knowledge Base section */}
        <div className="bg-white border border-border rounded-xl shadow-card overflow-hidden">
          <button
            onClick={() => setShowGenKb(v => !v)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Database size={14} className="text-violet-500" />
              <span className="text-xs font-semibold text-slate-700">Generate Project Knowledge Base</span>
              <span className="text-[10px] px-1.5 py-0.5 bg-violet-50 text-violet-600 border border-violet-200 rounded font-medium">KNOWLEDGE.md</span>
            </div>
            <ChevronDown size={13} className={clsx('text-slate-400 transition-transform', showGenKb && 'rotate-180')} />
          </button>

          {showGenKb && (
            <div className="border-t border-slate-100 px-4 py-4 space-y-3">
              <div>
                <label className="block text-[10px] text-slate-500 font-medium mb-1.5">Select project</label>
                <select
                  value={genKbProjectId}
                  onChange={e => setGenKbProjectId(e.target.value)}
                  className="w-full text-xs px-2.5 py-1.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:border-violet-400 text-slate-700"
                >
                  <option value="">— choose a project —</option>
                  {projectList.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-start gap-2 p-3 bg-violet-50 border border-violet-200 rounded-xl">
                <Zap size={12} className="text-violet-600 mt-0.5 shrink-0" />
                <ol className="text-xs text-violet-700 space-y-0.5 list-decimal ml-2">
                  <li>Open terminal at the project directory</li>
                  <li>Run <code className="bg-violet-100 px-1 rounded font-mono">claude</code></li>
                  <li>Paste the prompt below into Claude Code</li>
                </ol>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">KB generation prompt</span>
                  <button onClick={copyKbPrompt} className="flex items-center gap-1 text-[10px] text-violet-600 hover:text-violet-800 transition-colors">
                    {copiedKb ? <Check size={10} className="text-emerald-500" /> : <Copy size={10} />}
                    {copiedKb ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <pre className="text-[10px] font-mono text-slate-600 bg-slate-50 border border-slate-200 rounded-xl p-3 max-h-40 overflow-y-auto whitespace-pre-wrap leading-relaxed">
                  {KB_GEN_PROMPT}
                </pre>
              </div>

              {genKbProject && (
                <button
                  onClick={handleGenKbTerminal}
                  className="flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white text-xs font-medium rounded-xl transition-colors"
                >
                  <Github size={12} />
                  Open Terminal — {genKbProject.name}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Skills list */}
        {githubLoading && (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-slate-400">
            <Loader size={20} className="animate-spin text-violet-400" />
            <span className="text-xs">Fetching trending skills from GitHub…</span>
          </div>
        )}

        {!githubLoading && githubSkills.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
            <Github size={28} className="text-slate-300" />
            <p className="text-sm font-medium text-slate-500">No skills yet</p>
            {needsGithubSetup ? (
              <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg">
                Configure GitHub PAT in MCP Settings to fetch skills.
              </p>
            ) : (
              <button
                onClick={fetchAllGithubSkills}
                className="flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white text-xs font-medium rounded-xl transition-colors"
              >
                <Github size={12} /> Fetch GitHub Skills
              </button>
            )}
          </div>
        )}

        {githubSkills.length > 0 && (
          <div className="grid grid-cols-1 gap-3">
            {pagedSkills.map(skill => {
              const isExpanded = expanded === skill.id;
              const meta = getGithubSkillMeta(skill.category, skill.name);
              const catMeta = CATEGORY_LABELS[skill.category] ?? { label: 'Engineering', color: 'text-blue-600 bg-blue-50' };
              return (
                <div key={skill.id} className={clsx('border rounded-2xl shadow-card overflow-hidden transition-all', meta.bg)}>
                  <div className="flex items-start gap-4 px-5 py-4">
                    <div
                      className={clsx('w-10 h-10 rounded-xl flex items-center justify-center shrink-0 cursor-pointer', meta.bg, meta.color)}
                      onClick={() => setExpanded(isExpanded ? null : skill.id)}
                    >
                      {meta.icon}
                    </div>
                    <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setExpanded(isExpanded ? null : skill.id)}>
                      <p className="text-sm font-semibold text-slate-800 leading-snug mb-1.5">{skill.name}</p>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={clsx('text-[10px] px-1.5 py-0.5 rounded font-medium', catMeta.color)}>{catMeta.label}</span>
                        <a href={skill.repoUrl} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="flex items-center gap-0.5 text-[10px] text-slate-400 hover:text-violet-500 font-mono">
                          <Github size={9} /> {skill.sourceRepo}
                        </a>
                        <span className="flex items-center gap-0.5 text-[10px] text-amber-600">
                          <Star size={9} fill="currentColor" /> {skill.stars.toLocaleString()}
                        </span>
                      </div>
                      {skill.tools.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {skill.tools.map(t => (
                            <span key={t} className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded font-mono">{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <a
                        href={skill.repoUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={e => e.stopPropagation()}
                        className="p-1.5 text-slate-400 hover:text-primary hover:bg-violet-50 rounded-lg transition-colors"
                        title="View source"
                      >
                        <ExternalLink size={13} />
                      </a>
                      <button
                        onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(skill.promptTemplate).catch(() => {}); setCopied(skill.id); setTimeout(() => setCopied(null), 1500); }}
                        className="flex items-center gap-1 px-2.5 py-1.5 bg-white border border-slate-200 hover:border-violet-300 text-slate-500 hover:text-primary text-[10px] font-medium rounded-lg transition-colors"
                      >
                        {copied === skill.id ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
                        {copied === skill.id ? 'Copied!' : 'Copy'}
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); startAddToProject({ ...meta, id: skill.id, name: skill.name, description: skill.description, category: skill.category, tools: skill.tools, promptTemplate: skill.promptTemplate, repoUrl: skill.repoUrl } as Skill); }}
                        className="flex items-center gap-1 px-2.5 py-1.5 bg-violet-600 hover:bg-violet-700 text-white text-[10px] font-medium rounded-lg transition-colors shadow-sm"
                      >
                        <Plus size={11} /> Add
                      </button>
                      <button onClick={e => { e.stopPropagation(); removeGithubSkill(skill.id); }} className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="Remove">
                        <X size={13} />
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="border-t border-slate-100 px-5 py-4 bg-slate-50/50">
                      <div className="flex items-center gap-1.5 mb-2">
                        <Zap size={11} className="text-violet-500" />
                        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Prompt Template</span>
                      </div>
                      <pre className="text-[11px] font-mono text-slate-600 whitespace-pre-wrap leading-relaxed bg-white border border-slate-200 rounded-xl p-3 max-h-64 overflow-y-auto">
                        {skill.promptTemplate}
                      </pre>
                      <p className="text-[10px] text-slate-400 mt-2">
                        Replace <code className="bg-slate-200 px-1 rounded">{'{placeholder}'}</code> with task-specific info, then paste into the task description.
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {filteredSkills.length > PAGE_SIZE && (
          <div className="flex items-center justify-between pt-1">
            <span className="text-[11px] text-slate-400">
              {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filteredSkills.length)} / {filteredSkills.length} skills
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-2.5 py-1 text-[11px] font-medium rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                ← Prev
              </button>
              {buildPageList(page, totalPages).map((p, i) =>
                p === '...' ? (
                  <span key={`ellipsis-${i}`} className="w-7 h-7 flex items-center justify-center text-[11px] text-slate-400 select-none">…</span>
                ) : (
                  <button
                    key={p}
                    onClick={() => setPage(p as number)}
                    className={clsx(
                      'w-7 h-7 text-[11px] font-medium rounded-lg transition-colors',
                      p === page ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100',
                    )}
                  >
                    {p}
                  </button>
                ),
              )}
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-2.5 py-1 text-[11px] font-medium rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next →
              </button>
            </div>
          </div>
        )}

        {/* Imported skills */}
        {importedSkills.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Github size={12} className="text-violet-500" />
              <span className="text-xs font-semibold text-slate-600">Imported from GitHub</span>
              <span className="text-[10px] px-1.5 py-0.5 bg-violet-100 text-violet-600 rounded-full font-medium">{importedSkills.length}</span>
            </div>
            <div className="grid grid-cols-1 gap-3">
              {importedSkills.map(skill => {
                const isExpanded = expanded === skill.id;
                return (
                  <div key={skill.id} className="bg-white border border-violet-200 rounded-2xl shadow-card overflow-hidden">
                    <div className="flex items-start gap-4 px-5 py-4">
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-violet-50 text-violet-600 cursor-pointer" onClick={() => setExpanded(isExpanded ? null : skill.id)}>
                        <Github size={18} />
                      </div>
                      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setExpanded(isExpanded ? null : skill.id)}>
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-sm font-semibold text-slate-800">{skill.name}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium text-violet-600 bg-violet-50">Imported</span>
                          <a href={skill.repoUrl} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="text-[10px] text-slate-400 hover:text-violet-500 font-mono truncate max-w-40">{skill.sourceRepo}</a>
                        </div>
                        <p className="text-xs text-slate-500 leading-relaxed line-clamp-2">{skill.description}</p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(skill.promptTemplate).catch(() => {}); setCopied(skill.id); setTimeout(() => setCopied(null), 1500); }}
                          className="flex items-center gap-1 px-2.5 py-1.5 bg-white border border-slate-200 hover:border-violet-300 text-slate-500 hover:text-primary text-[10px] font-medium rounded-lg transition-colors"
                        >
                          {copied === skill.id ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
                          {copied === skill.id ? 'Copied!' : 'Copy'}
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); startAddToProject({ ...skill, icon: <Github size={18} />, color: 'text-violet-700', bg: 'bg-violet-50 border-violet-200', repoUrl: skill.repoUrl, category: 'engineering' } as Skill); }}
                          className="flex items-center gap-1 px-2.5 py-1.5 bg-violet-600 hover:bg-violet-700 text-white text-[10px] font-medium rounded-lg transition-colors shadow-sm"
                        >
                          <Plus size={11} /> Add
                        </button>
                        <button onClick={e => { e.stopPropagation(); removeImportedSkill(skill.id); }} className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="Remove">
                          <X size={13} />
                        </button>
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="border-t border-slate-100 px-5 py-4 bg-slate-50/50">
                        <pre className="text-[11px] font-mono text-slate-600 whitespace-pre-wrap leading-relaxed bg-white border border-slate-200 rounded-xl p-3 max-h-64 overflow-y-auto">
                          {skill.promptTemplate}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 text-xs text-slate-400 mt-2">
          <Github size={12} />
          <span>Trending skills from the last 24h — prompt templates auto-translated to Vietnamese</span>
        </div>

      </div>

      {/* ─── Add to project modal ─────────────────────────────────────── */}
      {addState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">

            {/* Step: pick project */}
            {addState.step === 'pick-project' && (
              <>
                <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
                  <div className="flex items-center gap-2">
                    <div className={clsx('w-8 h-8 rounded-xl flex items-center justify-center', addState.skill.bg, addState.skill.color)}>
                      {addState.skill.icon}
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-slate-800">Add Skill to Project</h3>
                      <p className="text-[10px] text-slate-400">{addState.skill.name}</p>
                    </div>
                  </div>
                  <button onClick={() => setAddState(null)} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
                    <X size={14} />
                  </button>
                </div>
                <div className="px-5 py-4 space-y-3 max-h-[70vh] overflow-y-auto">
                  {projectList.length === 0 && (
                    <p className="text-xs text-slate-400 text-center py-6">No projects yet. Add one in the Projects section first.</p>
                  )}

                  {/* Per-project skill path config */}
                  {projectList.map(p => {
                    const skillCount = projectSkillCount[p.id] ?? 0;
                    const basePath = computeBasePath(reposRoot, p.name, p.repoPath);
                    const projectSuffix = skillPaths[p.id] ?? '/_skills';
                    return (
                      <div key={p.id} className="border border-border hover:border-violet-300 rounded-xl transition-colors overflow-hidden">
                        {/* Row header — click to confirm */}
                        <button
                          onClick={() => handleProjectClick(p)}
                          className="w-full flex items-center justify-between gap-3 px-4 pt-3 pb-2 hover:bg-violet-50/30 transition-colors text-left"
                        >
                          <div className="flex items-center gap-2.5">
                            <span className="w-3 h-3 rounded-full shrink-0" style={{ background: p.color }} />
                            <span className="text-xs font-semibold text-slate-800">{p.name}</span>
                          </div>
                          <div className="shrink-0 flex items-center gap-2">
                            {skillCount > 0 && (
                              <span className="text-[10px] text-violet-600 bg-violet-50 border border-violet-200 px-1.5 py-0.5 rounded">
                                {skillCount} skills
                              </span>
                            )}
                            <ChevronDown size={12} className="text-slate-300 -rotate-90" />
                          </div>
                        </button>
                        {/* Per-project path config */}
                        <div className="px-4 pb-3" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center rounded-lg border border-slate-200 overflow-hidden focus-within:border-violet-400 bg-white">
                            <span className="px-2 py-1 bg-slate-50 text-[9px] text-slate-400 font-mono border-r border-slate-200 whitespace-nowrap shrink-0 select-none truncate max-w-[160px]">
                              {basePath}
                            </span>
                            <input
                              type="text"
                              value={skillPaths[p.id] ?? '/_skills'}
                              onChange={e => {
                                const val = e.target.value;
                                saveSkillPath(p.id, val);
                                setSkillPaths(loadSkillPaths());
                              }}
                              placeholder="/_skills"
                              className="flex-1 px-2 py-1 text-[9px] font-mono text-slate-700 bg-white focus:outline-none min-w-0"
                            />
                          </div>
                          <p className="text-[9px] text-slate-400 mt-0.5">
                            Saves to: <span className="font-mono">{basePath}{projectSuffix}/</span>
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {/* Step: saving */}
            {addState.step === 'saving' && (
              <div className="px-5 py-10 text-center">
                <div className="w-10 h-10 bg-violet-50 rounded-2xl flex items-center justify-center mx-auto mb-3">
                  <Loader size={18} className="text-violet-500 animate-spin" />
                </div>
                <p className="text-sm font-medium text-slate-700">Adding skill to project...</p>
                <p className="text-xs text-slate-400 mt-1">
                  Creating <code className="font-mono bg-slate-100 px-1 rounded">{addState.customPathSuffix || '/_skills'}/</code>
                </p>
              </div>
            )}

            {/* Step: added */}
            {addState.step === 'added' && addState.selectedProject && (
              <>
                <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 bg-emerald-50 rounded-xl flex items-center justify-center">
                      <Check size={15} className="text-emerald-500" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-slate-800">Skill added!</h3>
                      <p className="text-[10px] text-slate-400">
                        {addState.skill.name} → {addState.selectedProject.name}
                      </p>
                    </div>
                  </div>
                  <button onClick={() => setAddState(null)} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
                    <X size={14} />
                  </button>
                </div>

                <div className="px-5 py-4 space-y-3">
                  {addState.savedToFile ? (
                    <div className="flex items-start gap-2 p-3 bg-emerald-50 border border-emerald-200 rounded-xl">
                      <Check size={13} className="text-emerald-600 mt-0.5 shrink-0" />
                      <div className="text-xs text-emerald-700">
                        <p className="font-semibold">File written to disk</p>
                        <p className="font-mono text-[10px] mt-0.5">
                          {computeBasePath(reposRoot, addState.selectedProject.name, addState.selectedProject.repoPath)}{addState.customPathSuffix || '/_skills'}/{addState.skill.id}.md
                        </p>
                        <p className="mt-0.5 text-emerald-600">CLAUDE.md updated — Claude Code will auto-read this skill.</p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl">
                        <p className="text-xs font-semibold text-amber-800 mb-2">No backend — save this file manually:</p>
                        <div className="space-y-1.5">
                          <div>
                            <p className="text-[10px] text-amber-700 font-medium mb-0.5">1. Download and place at:</p>
                            <p className="font-mono text-[10px] bg-amber-100 border border-amber-300 px-2 py-1 rounded break-all text-amber-900">
                              {computeBasePath(reposRoot, addState.selectedProject.name, addState.selectedProject.repoPath)}{addState.customPathSuffix || '/_skills'}/{addState.skill.id}.md
                            </p>
                          </div>
                          <div>
                            <p className="text-[10px] text-amber-700 font-medium mb-0.5">2. Add to your CLAUDE.md:</p>
                            <p className="font-mono text-[10px] bg-amber-100 border border-amber-300 px-2 py-1 rounded text-amber-900">
                              @{(addState.customPathSuffix || '/_skills').replace(/^\//, '')}/{addState.skill.id}.md
                            </p>
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => downloadSkillFile(addState.skill)}
                        className="w-full flex items-center justify-center gap-1.5 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium rounded-xl transition-colors"
                      >
                        <Download size={13} /> Download {addState.skill.id}.md
                      </button>
                    </div>
                  )}

                  {/* Optional: generate KNOWLEDGE.md */}
                  <div className="border-t border-slate-100 pt-3">
                    <button
                      onClick={() => setAddState(s => s ? { ...s, showKbPrompt: !s.showKbPrompt } : s)}
                      className="flex items-center gap-1.5 text-xs text-violet-600 hover:text-violet-800 transition-colors"
                    >
                      <FolderOpen size={12} />
                      {addState.showKbPrompt ? 'Hide KB generator' : 'Also generate project KNOWLEDGE.md?'}
                    </button>

                    {addState.showKbPrompt && (
                      <div className="mt-3 space-y-3">
                        <div className="flex items-start gap-2 p-3 bg-violet-50 border border-violet-200 rounded-xl">
                          <Zap size={12} className="text-violet-600 mt-0.5 shrink-0" />
                          <ol className="text-xs text-violet-700 space-y-1 list-decimal ml-2">
                            <li>Open terminal at the project directory</li>
                            <li>Run <code className="bg-violet-100 px-1 rounded font-mono">claude</code></li>
                            <li>Paste the prompt below into Claude Code</li>
                          </ol>
                        </div>
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">KB generation prompt</span>
                            <button onClick={copyKbPrompt} className="flex items-center gap-1 text-[10px] text-violet-600 hover:text-violet-800">
                              {copiedKb ? <Check size={10} className="text-emerald-500" /> : <Copy size={10} />}
                              {copiedKb ? 'Copied!' : 'Copy'}
                            </button>
                          </div>
                          <pre className="text-[10px] font-mono text-slate-600 bg-slate-50 border border-slate-200 rounded-xl p-3 max-h-36 overflow-y-auto whitespace-pre-wrap leading-relaxed">
                            {KB_GEN_PROMPT}
                          </pre>
                        </div>
                        <button
                          onClick={() => { setTerminalCwd(computeBasePath(reposRoot, addState.selectedProject!.name, addState.selectedProject!.repoPath)); setTerminalOpen(true); }}
                          className="flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white text-xs font-medium rounded-xl transition-colors"
                        >
                          <Github size={12} />
                          Open Terminal
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}

          </div>
        </div>
      )}

      <TerminalModal
        open={terminalOpen}
        onClose={() => setTerminalOpen(false)}
        title="Knowledge Base Generator"
        cwd={terminalCwd}
        prompt={KB_GEN_PROMPT}
        description="Runs claude in the project directory and feeds the KB generation prompt via stdin."
      />
    </div>
  );
}
