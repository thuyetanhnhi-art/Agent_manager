import { useState, useEffect, useRef } from 'react';
import { X, ChevronRight, CheckCircle2, Sparkles, Cpu, Calendar, FolderGit2, Plus, Trash2, Layers, BookOpen, Paperclip, Film, Loader2, Bot, Phone } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../store';
import { useProjectStore } from '../projectStore';
import { usePromptStore } from '../promptStore';
import { AIModel, Priority, AgentConfig, TaskKind, MODEL_INFO, PRIORITY_META, LABEL_META } from '../types';
import { inferLabel } from '../utils';

type Step = 1 | 2;

const MODELS: AIModel[] = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'critical'];
const SCHEDULES = [
  { label: 'No schedule',         value: '' },
  { label: 'Every day at 9am',    value: '0 9 * * *' },
  { label: 'Every weekday 9am',   value: '0 9 * * 1-5' },
  { label: 'Every hour',          value: '0 * * * *' },
  { label: 'Every 30 minutes',    value: '*/30 * * * *' },
  { label: 'Every 15 minutes',    value: '*/15 * * * *' },
  { label: 'Custom cron...',      value: '__custom__' },
];
const TOOLS = ['read_file', 'write_file', 'search', 'execute_code', 'web_fetch', 'database_query'];

function svcKey(projectId: string) { return `agentmgr:svc:${projectId}`; }
function loadServices(projectId: string): string[] {
  try { return JSON.parse(localStorage.getItem(svcKey(projectId)) ?? '[]') as string[]; } catch { return []; }
}
function saveServices(projectId: string, list: string[]) {
  try { localStorage.setItem(svcKey(projectId), JSON.stringify(list)); } catch {}
}

export function CreateTaskModal() {
  const { isCreateModalOpen, closeCreateModal, createParentId, createTask, tasks } = useStore();
  const { projects, activeProjectId } = useProjectStore();
  const { prompts, incrementUsage } = usePromptStore();
  const [showPromptPicker, setShowPromptPicker] = useState(false);

  const [step, setStep] = useState<Step>(1);
  const [taskKind, setTaskKind] = useState<TaskKind>('agent');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [model, setModel] = useState<AIModel>('claude-opus-4-7');
  const [schedule, setSchedule] = useState('');
  const [customCron, setCustomCron] = useState('');
  const [showCustomCron, setShowCustomCron] = useState(false);
  const [tools, setTools] = useState<string[]>(['read_file', 'write_file', 'search', 'execute_code']);
  // Jira virtual projects should never be the default for new tasks
  const nonJiraActiveId = activeProjectId && projects[activeProjectId]?.repoPath !== '__jira__' ? activeProjectId : null;
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(nonJiraActiveId);
  const [criteria, setCriteria] = useState<string[]>([]);
  const [criteriaInput, setCriteriaInput] = useState('');
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [serviceList, setServiceList] = useState<string[]>([]);
  const [newServiceInput, setNewServiceInput] = useState('');

  type UploadItem = { filename: string; mimeType: string; localPath: string; absPath: string };
  const [attachments, setAttachments] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const bucketRef = useRef('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB per file

  const parentTask = createParentId ? tasks[createParentId] : null;

  const promptList = Object.values(prompts).sort((a, b) => b.usageCount - a.usageCount).slice(0, 20);

  function resetAll() {
    setStep(1); setTaskKind('agent'); setTitle(''); setDescription(''); setPriority('medium'); setShowPromptPicker(false);
    setModel('claude-opus-4-7');
    setSchedule(''); setCustomCron(''); setShowCustomCron(false);
    setTools(['read_file', 'write_file', 'search', 'execute_code']);
    setSelectedProjectId(activeProjectId);
    setCriteria([]); setCriteriaInput('');
    setSelectedService(null); setNewServiceInput('');
    setAttachments([]); setUploadError(''); setUploading(false);
    bucketRef.current = '';
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploadError('');
    if (!bucketRef.current) bucketRef.current = `up-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const isMedia = file.type.startsWith('image/') || file.type.startsWith('video/');
        if (!isMedia) { setUploadError(`Bỏ qua ${file.name} (chỉ nhận ảnh/video)`); continue; }
        if (file.size > MAX_UPLOAD_BYTES) { setUploadError(`${file.name} quá lớn (>100MB)`); continue; }
        const buf = await file.arrayBuffer();
        const qs = new URLSearchParams({ bucket: bucketRef.current, filename: file.name, mime: file.type || 'application/octet-stream' });
        const r = await fetch(`/api/upload-attachment?${qs.toString()}`, { method: 'POST', body: buf });
        const j = await r.json() as { ok: boolean; filename?: string; mimeType?: string; localPath?: string; absPath?: string; error?: string };
        if (j.ok && j.localPath && j.absPath) {
          setAttachments(prev => [...prev, { filename: j.filename ?? file.name, mimeType: j.mimeType ?? file.type, localPath: j.localPath!, absPath: j.absPath! }]);
        } else {
          setUploadError(j.error ?? `Upload ${file.name} thất bại`);
        }
      }
    } catch (e) {
      setUploadError(String(e));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function removeAttachment(localPath: string) {
    setAttachments(prev => prev.filter(a => a.localPath !== localPath));
  }

  useEffect(() => {
    if (selectedProjectId) {
      setServiceList(loadServices(selectedProjectId));
    } else {
      setServiceList([]);
    }
    setSelectedService(null);
  }, [selectedProjectId]);

  function addService() {
    const svc = newServiceInput.trim();
    if (!svc || serviceList.includes(svc)) return;
    const updated = [...serviceList, svc];
    setServiceList(updated);
    if (selectedProjectId) saveServices(selectedProjectId, updated);
    setSelectedService(svc);
    setNewServiceInput('');
  }

  function removeService(svc: string) {
    const updated = serviceList.filter(s => s !== svc);
    setServiceList(updated);
    if (selectedProjectId) saveServices(selectedProjectId, updated);
    if (selectedService === svc) setSelectedService(null);
  }

  function addCriterion() {
    const trimmed = criteriaInput.trim();
    if (!trimmed || criteria.includes(trimmed) || criteria.length >= 10) return;
    setCriteria(prev => [...prev, trimmed]);
    setCriteriaInput('');
  }

  function removeCriterion(index: number) {
    setCriteria(prev => prev.filter((_, i) => i !== index));
  }

  function handleClose() {
    closeCreateModal();
    resetAll();
  }

  const effectiveSchedule = showCustomCron ? customCron : schedule;
  const activeProject = selectedProjectId ? projects[selectedProjectId] : null;

  function handleCreate() {
    const config: AgentConfig = { model, schedule: effectiveSchedule || null, tools };
    const images = attachments.filter(a => a.mimeType.startsWith('image/'));
    const videos = attachments.filter(a => a.mimeType.startsWith('video/'));
    const attachSection = [
      images.length
        ? '## Attachments (screenshots — open with the Read tool to view)\n'
          + images.map(a => `- ${a.filename}: ${a.absPath}`).join('\n')
        : '',
      videos.length
        ? '## Video attachments (agent cannot view video content — for human review only)\n'
          + videos.map(a => `- ${a.filename}: ${a.absPath}`).join('\n')
        : '',
    ].filter(Boolean).join('\n\n');
    const baseDescription = selectedService
      ? `[Component: ${selectedService}]\n\n${description}`
      : description;
    const scopedDescription = attachSection ? `${baseDescription}\n\n${attachSection}` : baseDescription;
    const taskTags = selectedService ? [`service:${selectedService}`] : [];
    createTask({
      title, description: scopedDescription, priority, agentConfig: config,
      parentId: createParentId ?? undefined,
      projectId: taskKind === 'agent' ? (selectedProjectId ?? undefined) : undefined,
      taskKind: taskKind === 'agent' ? undefined : taskKind,
      successCriteria: criteria.length > 0 ? criteria : undefined,
      tags: taskTags,
      attachments: attachments.length
        ? attachments.map(a => ({ filename: a.filename, mimeType: a.mimeType, localPath: a.localPath }))
        : undefined,
    });
    handleClose();
  }

  function toggleTool(tool: string) {
    setTools(prev => prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]);
  }

  // Sync project selection when modal opens — skip Jira virtual projects
  useEffect(() => {
    if (isCreateModalOpen) {
      const isJira = activeProjectId && projects[activeProjectId]?.repoPath === '__jira__';
      setSelectedProjectId(isJira ? null : activeProjectId);
    }
  }, [isCreateModalOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isCreateModalOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30 backdrop-blur-sm" onClick={handleClose} />
      <div className="w-[48vw] min-w-[540px] max-w-full h-full bg-white shadow-2xl flex flex-col animate-slide-in-right border-l border-slate-200">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100">
          <Sparkles size={16} className="text-primary" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-slate-800">New Task</div>
            {parentTask && <div className="text-xs text-slate-500">Subtask of: {parentTask.title}</div>}
          </div>
          <button onClick={handleClose} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center px-5 py-3 border-b border-slate-100 bg-slate-50/60">
          {([1, 2] as Step[]).map((s, idx) => {
            const labels = ['Task Info', 'Agent Config'];
            const active = s === step, done = s < step;
            return (
              <div key={s} className="flex items-center">
                <div className="flex items-center gap-1.5">
                  <div className={clsx(
                    'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors',
                    done ? 'bg-primary text-white' : active ? 'ring-2 ring-primary/30 bg-primary/10 text-primary' : 'bg-slate-100 text-slate-400',
                  )}>{done ? '✓' : s}</div>
                  <span className={clsx('text-[10px] hidden sm:block', active ? 'text-slate-800 font-medium' : done ? 'text-slate-500' : 'text-slate-400')}>
                    {labels[idx]}
                  </span>
                </div>
                {idx < 1 && <ChevronRight size={12} className="text-slate-300 mx-1" />}
              </div>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Step 1 — Task Info */}
          {step === 1 && (
            <div className="space-y-4 animate-fade-in">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Loại task</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setTaskKind('agent')}
                    className={clsx('flex items-center gap-2 p-2.5 rounded-xl border text-left transition-colors',
                      taskKind === 'agent' ? 'border-violet-400 bg-violet-50 shadow-sm' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50')}>
                    <Bot size={14} className="text-violet-500 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-slate-800">Agent Task</div>
                      <div className="text-[10px] text-slate-400 truncate">Chạy Claude Code trên 1 repo</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setTaskKind('fb_phone_collector'); if (!title.trim()) setTitle('Thu SĐT Facebook'); }}
                    className={clsx('flex items-center gap-2 p-2.5 rounded-xl border text-left transition-colors',
                      taskKind === 'fb_phone_collector' ? 'border-violet-400 bg-violet-50 shadow-sm' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50')}>
                    <Phone size={14} className="text-primary shrink-0" />
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-slate-800">Thu SĐT Facebook</div>
                      <div className="text-[10px] text-slate-400 truncate">Không dùng Claude — chỉ theo lịch</div>
                    </div>
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Task Title <span className="text-red-400">*</span></label>
                <input
                  autoFocus value={title} onChange={e => setTitle(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && title.trim()) setStep(2); }}
                  placeholder="e.g. Build semantic search system"
                  className="w-full bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-3 py-2.5 text-sm text-slate-800 placeholder-slate-400 outline-none transition-colors shadow-sm"
                />
                {title.trim() && (() => {
                  const lm = LABEL_META[inferLabel(title, description)];
                  return (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <span className="text-[10px] text-slate-400">Auto-label:</span>
                      <span className={clsx('text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded-md border', lm.color, lm.bg, lm.border)}>
                        {inferLabel(title, description)}
                      </span>
                    </div>
                  );
                })()}
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-slate-600">Description</label>
                  {promptList.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowPromptPicker(v => !v)}
                      className="flex items-center gap-1 text-[10px] text-violet-600 hover:text-violet-800 transition-colors"
                    >
                      <BookOpen size={10} /> Insert from library
                    </button>
                  )}
                </div>
                {showPromptPicker && (
                  <div className="mb-2 bg-slate-50 border border-slate-200 rounded-xl overflow-hidden shadow-sm max-h-48 overflow-y-auto">
                    {promptList.map(p => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setDescription(prev => prev ? `${prev}\n\n${p.content}` : p.content);
                          incrementUsage(p.id);
                          setShowPromptPicker(false);
                        }}
                        className="w-full text-left px-3 py-2.5 hover:bg-violet-50 transition-colors border-b border-slate-100 last:border-0"
                      >
                        <div className="text-xs font-medium text-slate-700 truncate">{p.title}</div>
                        <div className="text-[10px] text-slate-400 truncate mt-0.5">{p.content.slice(0, 80)}…</div>
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  value={description} onChange={e => setDescription(e.target.value)}
                  placeholder="Describe the task in detail for the AI agent..."
                  rows={4}
                  className="w-full bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-3 py-2.5 text-sm text-slate-800 placeholder-slate-400 outline-none resize-none transition-colors shadow-sm"
                />
              </div>

              {/* Attachments — images & videos */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-slate-600 flex items-center gap-1.5">
                    <Paperclip size={11} /> Attachments <span className="font-normal text-slate-400">(ảnh / video)</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="flex items-center gap-1 text-[10px] text-violet-600 hover:text-violet-800 disabled:opacity-50 transition-colors"
                  >
                    {uploading ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                    {uploading ? 'Đang tải…' : 'Thêm ảnh/video'}
                  </button>
                  <input
                    ref={fileInputRef} type="file" accept="image/*,video/*" multiple hidden
                    onChange={e => void handleFiles(e.target.files)}
                  />
                </div>
                {attachments.length > 0 && (
                  <div className="grid grid-cols-4 gap-2 mb-1.5">
                    {attachments.map(a => (
                      <div key={a.localPath} className="group relative aspect-square rounded-lg overflow-hidden border border-slate-200 bg-slate-50">
                        {a.mimeType.startsWith('image/') ? (
                          <img src={`/api/asset?path=${encodeURIComponent(a.localPath)}`} alt={a.filename} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-slate-400">
                            <Film size={18} />
                            <span className="text-[8px] px-1 truncate max-w-full">{a.filename}</span>
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => removeAttachment(a.localPath)}
                          title="Remove"
                          className="absolute top-0.5 right-0.5 p-0.5 rounded-md bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                        ><X size={10} /></button>
                      </div>
                    ))}
                  </div>
                )}
                {uploadError && <p className="text-[10px] text-red-500">{uploadError}</p>}
                <p className="text-[10px] text-slate-400">
                  Ảnh: agent mở bằng công cụ Read để xem. Video: chỉ để người xem — agent không phân tích được nội dung video.
                </p>
              </div>
              {taskKind === 'agent' && Object.keys(projects).length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5 flex items-center gap-1.5">
                    <FolderGit2 size={11} /> Project (optional)
                  </label>
                  <div className="flex gap-2 flex-wrap">
                    <button
                      onClick={() => setSelectedProjectId(null)}
                      className={clsx('text-xs px-2.5 py-1.5 rounded-xl border transition-colors', !selectedProjectId ? 'border-violet-400 bg-violet-50 text-violet-700 font-medium' : 'border-slate-200 text-slate-500 hover:bg-slate-50')}
                    >No project</button>
                    {Object.values(projects).filter(p => p.repoPath !== '__jira__').map(p => (
                      <button key={p.id} onClick={() => setSelectedProjectId(p.id)}
                        className={clsx('flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-xl border transition-colors', selectedProjectId === p.id ? 'border-violet-400 bg-violet-50 text-violet-700 font-medium' : 'border-slate-200 text-slate-500 hover:bg-slate-50')}>
                        <div className="w-2 h-2 rounded-full" style={{ background: p.color }} />
                        {p.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {taskKind === 'agent' && selectedProjectId && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5 flex items-center gap-1.5">
                    <Layers size={11} className="text-violet-400" />
                    Service / Component
                    <span className="font-normal text-slate-400">(optional)</span>
                  </label>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {serviceList.map(svc => (
                      <div key={svc} className="flex items-center">
                        <button
                          onClick={() => setSelectedService(selectedService === svc ? null : svc)}
                          className={clsx(
                            'text-xs px-2.5 py-1 rounded-l-lg border transition-colors font-mono',
                            selectedService === svc
                              ? 'border-violet-400 bg-violet-600 text-white font-semibold'
                              : 'border-slate-200 text-slate-600 hover:border-violet-300 hover:bg-violet-50',
                          )}
                        >{svc}</button>
                        <button
                          onClick={() => removeService(svc)}
                          className={clsx(
                            'px-1.5 py-1 border-y border-r rounded-r-lg text-slate-400 hover:text-red-500 hover:border-red-300 transition-colors',
                            selectedService === svc ? 'border-violet-400 bg-violet-600 hover:bg-red-50' : 'border-slate-200',
                          )}
                          title="Remove"
                        ><X size={9} /></button>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      value={newServiceInput}
                      onChange={e => setNewServiceInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addService(); } }}
                      placeholder="e.g. api, frontend, auth-service…"
                      className="flex-1 bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-800 placeholder-slate-400 outline-none transition-colors shadow-sm"
                    />
                    <button
                      onClick={addService}
                      disabled={!newServiceInput.trim() || serviceList.includes(newServiceInput.trim())}
                      className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 text-slate-600 text-xs rounded-lg transition-colors border border-slate-200 shrink-0"
                    >
                      <Plus size={11} /> Add
                    </button>
                  </div>
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Priority</label>
                <div className="flex gap-2">
                  {PRIORITIES.map(p => {
                    const meta = PRIORITY_META[p];
                    return (
                      <button key={p} onClick={() => setPriority(p)}
                        className={clsx('flex-1 py-2 rounded-lg text-xs font-medium border transition-colors',
                          priority === p ? `${meta.color} ${meta.border} bg-white shadow-sm` : 'border-slate-200 text-slate-400 hover:text-slate-600 hover:bg-slate-50')}>
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">
                  Success Criteria
                  <span className="ml-1.5 text-[10px] font-normal text-slate-400">(optional)</span>
                </label>
                {criteria.length > 0 && (
                  <div className="space-y-1.5 mb-2">
                    {criteria.map((c, i) => (
                      <div key={i} className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1.5">
                        <span className="text-emerald-500 text-[10px] font-bold shrink-0">{i + 1}</span>
                        <span className="flex-1 text-xs text-slate-700">{c}</span>
                        <button onClick={() => removeCriterion(i)} className="text-slate-400 hover:text-red-500 transition-colors shrink-0">
                          <Trash2 size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {criteria.length < 10 && (
                  <div className="flex gap-2">
                    <input
                      value={criteriaInput}
                      onChange={e => setCriteriaInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCriterion(); } }}
                      placeholder="e.g. All unit tests pass with ≥80% coverage"
                      className="flex-1 bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-3 py-2 text-xs text-slate-800 placeholder-slate-400 outline-none transition-colors shadow-sm"
                    />
                    <button
                      onClick={addCriterion}
                      disabled={!criteriaInput.trim()}
                      className="flex items-center gap-1 px-3 py-2 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed text-slate-600 text-xs rounded-lg transition-colors border border-slate-200 shrink-0"
                    >
                      <Plus size={11} />Add
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 2 — Agent Config */}
          {step === 2 && (
            <div className="space-y-4 animate-fade-in">
              {/* Summary row */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-xs text-slate-600 space-y-1">
                <div className="font-semibold text-slate-800 truncate">{title}</div>
                {activeProject && <div className="text-slate-400 flex items-center gap-1"><FolderGit2 size={10} />{activeProject.name}{selectedService ? ` / ${selectedService}` : ''}</div>}
              </div>

              {taskKind === 'fb_phone_collector' && (
                <div className="flex items-start gap-2 bg-violet-50 border border-violet-200 rounded-xl p-3 text-xs text-violet-700">
                  <Phone size={13} className="shrink-0 mt-0.5" />
                  <span>
                    Task này gọi thẳng Facebook Graph API theo lịch bên dưới — không dùng Claude Code, không tốn token.
                    Cần cấu hình Page Access Token trong trang <strong>SĐT Facebook</strong> trước khi lịch chạy được.
                  </span>
                </div>
              )}

              {taskKind === 'agent' && (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">AI Model</label>
                <div className="grid grid-cols-1 gap-2">
                  {MODELS.map(m => {
                    const info = MODEL_INFO[m];
                    return (
                      <button key={m} onClick={() => setModel(m)}
                        className={clsx('flex items-center gap-3 p-3 rounded-xl border text-left transition-colors',
                          model === m ? 'border-violet-400 bg-violet-50 shadow-sm' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50')}>
                        <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: `${info.color}18` }}>
                          <Cpu size={14} style={{ color: info.color }} />
                        </div>
                        <div className="flex-1">
                          <div className="text-sm font-medium text-slate-800">{info.label}</div>
                          <div className="text-[10px] text-slate-500">${info.inputPer1M}/1M in · ${info.outputPer1M}/1M out</div>
                        </div>
                        {model === m && <CheckCircle2 size={14} className="text-primary ml-auto shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5 flex items-center gap-1.5">
                  <Calendar size={11} className="text-amber-500" /> Schedule (optional)
                </label>
                <select value={showCustomCron ? '__custom__' : schedule}
                  onChange={e => {
                    if (e.target.value === '__custom__') { setShowCustomCron(true); }
                    else { setShowCustomCron(false); setSchedule(e.target.value); }
                  }}
                  className="w-full bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-3 py-2 text-xs text-slate-700 outline-none shadow-sm mb-2">
                  {SCHEDULES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
                {showCustomCron && (
                  <input value={customCron} onChange={e => setCustomCron(e.target.value)}
                    placeholder="Cron expression: e.g. 0 14 * * 1-5"
                    className="w-full bg-white border border-slate-200 focus:border-violet-400 rounded-lg px-3 py-2 text-xs text-slate-700 font-mono placeholder-slate-400 outline-none shadow-sm" />
                )}
                {effectiveSchedule && (
                  <div className="mt-1.5 text-[10px] text-amber-600 flex items-center gap-1">
                    <Calendar size={9} /> Scheduled: <span className="font-mono">{effectiveSchedule}</span>
                  </div>
                )}
              </div>

              {taskKind === 'agent' && (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Tools</label>
                <div className="flex flex-wrap gap-1.5">
                  {TOOLS.map(tool => (
                    <button key={tool} onClick={() => toggleTool(tool)}
                      className={clsx('text-[10px] px-2.5 py-1 rounded-lg border font-mono transition-colors',
                        tools.includes(tool) ? 'border-amber-400 bg-amber-50 text-amber-700' : 'border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50')}>
                      {tool}
                    </button>
                  ))}
                </div>
              </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-slate-100 bg-slate-50/50">
          <button onClick={step === 1 ? handleClose : () => setStep(1)}
            className="px-4 py-2 text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
            {step === 1 ? 'Cancel' : '← Back'}
          </button>
          {step === 1 ? (
            <button onClick={() => setStep(2)} disabled={!title.trim()}
              className="flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg transition-colors shadow-sm">
              Next <ChevronRight size={12} />
            </button>
          ) : (
            <button onClick={handleCreate}
              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg transition-colors shadow-sm">
              <CheckCircle2 size={12} /> Create Task
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

