import { useEffect, useRef, useState } from 'react';
import {
  X, Play, StopCircle, PauseCircle, Terminal as TerminalIcon, Cpu, Clock,
  DollarSign, Zap, Hash, Calendar, BookOpen, Check, AlertTriangle, RotateCcw,
} from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../store';
import { useProjectStore } from '../projectStore';
import { usePromptStore } from '../promptStore';
import { MODEL_INFO, LogType, LogEntry, TodoItem } from '../types';
import { makeLog } from '../simulator';
import { formatDuration, cronLabel } from '../utils';
import { getCachedContext, fetchProjectContext, buildSimulatedContext } from '../contextCache';

function fmtToolCall(name: string, input: unknown): string {
  if (!input) return '';
  const o = input as Record<string, unknown>;
  if (name === 'Read' || name === 'Write' || name === 'Edit') return String(o.file_path ?? '');
  if (name === 'Bash') return String(o.command ?? '').slice(0, 200);
  if (name === 'Glob') return String(o.pattern ?? '');
  if (name === 'Grep') return `${String(o.pattern ?? '')} in ${String(o.path ?? '.')}`;
  if (name === 'TodoWrite') {
    const todos = (o.todos as Array<{ status: string; content: string }> | undefined) ?? [];
    const done = todos.filter(t => t.status === 'completed').length;
    return `${done}/${todos.length} steps`;
  }
  return JSON.stringify(input).slice(0, 200);
}

const LOG_COLORS: Record<LogType, string> = {
  system:      'text-slate-500',
  info:        'text-slate-300',
  thinking:    'text-violet-300',
  tool_call:   'text-amber-300',
  tool_result: 'text-emerald-300',
  success:     'text-emerald-400',
  error:       'text-red-400',
};

const LOG_PREFIX: Record<LogType, string> = {
  system:      '──',
  info:        '▸ ',
  thinking:    '💭',
  tool_call:   '⚡',
  tool_result: '✓ ',
  success:     '✔ ',
  error:       '✖ ',
};

export function Terminal() {
  const {
    terminalTaskId, closeTerminal, tasks,
    startTask, pauseTask, stopTask, appendLog, updateTokens, updateTodos, tickElapsed, completeTask, captureUsageStart, captureUsageEnd,
    setAbortFn, abortFn, setTaskTodos,
  } = useStore();
  const logsRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const runIdRef = useRef('');

  const { projects } = useProjectStore();
  const { captureFromTerminal } = usePromptStore();
  const [savedPrompt, setSavedPrompt] = useState(false);
  const [awaitingInput, setAwaitingInput] = useState(false);
  const [replyText, setReplyText] = useState('');
  const task = terminalTaskId ? tasks[terminalTaskId] : null;

  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [task?.terminal.logs.length]);

  useEffect(() => { return () => { abortRef.current?.(); }; }, []);

  if (!task) return null;

  const { terminal, agentConfig } = task;
  const modelInfo = MODEL_INFO[agentConfig.model];

  function startExecution() {
    if (!task) return;
    startTask(task.id);
    setAwaitingInput(false);
    setReplyText('');

    let runId = '';
    let tick: ReturnType<typeof setInterval> | null = setInterval(() => tickElapsed(task.id, 500), 500);

    const cleanup = (success: boolean) => {
      if (tick) { clearInterval(tick); tick = null; }
      abortRef.current = null;
      setAbortFn(null);
      completeTask(task.id, success);
    };

    const abort = (es?: EventSource) => {
      if (tick) { clearInterval(tick); tick = null; }
      es?.close();
      if (runId) {
        fetch('/api/stop-task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId }) }).catch(() => {});
      }
    };
    abortRef.current = () => abort();
    setAbortFn(() => abort());

    const taskProject = task.projectId ? projects[task.projectId] : null;
    const parentTask = task.parentId ? tasks[task.parentId] : null;
    const handoff = task.handoffContext ? `${task.handoffContext}\n\n---\n\n` : '';

    // Load project context (with cache)
    const repoPath = taskProject?.repoPath ?? '';
    let projectContext = (parentTask?.projectAnalysis || task.projectAnalysis || '').slice(0, 8000);

    const cachedEntry = repoPath ? getCachedContext(repoPath) : null;
    if (cachedEntry) {
      projectContext = projectContext || cachedEntry.content;
      appendLog(task.id, makeLog('system',
        `Context loaded from cache${cachedEntry.source === 'simulated' ? ' (simulated)' : ''} — ${taskProject?.name ?? repoPath}`));
    } else if (repoPath) {
      // Fire-and-forget: try to fetch real context; fall back to simulated
      void fetchProjectContext(repoPath).then(ctx => {
        if (ctx) {
          appendLog(task.id, makeLog('system', `Context loaded from CLAUDE.md — ${taskProject?.name ?? repoPath}`));
        } else {
          buildSimulatedContext(repoPath, taskProject?.name ?? '');
          appendLog(task.id, makeLog('system', `Context cached (simulated) — ${taskProject?.name ?? repoPath}`));
        }
      });
    }

    fetch('/api/run-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId: task.id,
        title: task.title,
        description: `${handoff}${task.description}`,
        repoPath: taskProject?.repoPath ?? '',
        projectName: taskProject?.name ?? '',
        model: task.agentConfig.model,
        projectContext,
      }),
    })
      .then(r => r.json() as Promise<{ runId: string }>)
      .then(json => {
        runId = json.runId;
        runIdRef.current = json.runId;
        void captureUsageStart(task.id);
        const es = new EventSource(`/api/task-stream/${runId}`);
        abortRef.current = () => abort(es);
        setAbortFn(() => abort(es));

        es.onmessage = (ev: MessageEvent<string>) => {
          type Payload = { type: string; event?: Record<string, unknown>; content?: string; success?: boolean; question?: unknown };
          const msg = JSON.parse(ev.data) as Payload;

          if (msg.type === 'event' && msg.event) {
            const event = msg.event;
            const evType = event.type as string;

            if (evType === 'assistant') {
              type Block = { type: string; text?: string; name?: string; input?: unknown };
              const msgObj = event.message as { content?: Block[] };
              for (const block of msgObj?.content ?? []) {
                if (block.type === 'text' && block.text?.trim()) {
                  const text = (block.text as string).replace(/<\/?thinking>/g, '').trim();
                  if (text) {
                    const isThinking = /^I('ll| am| will)|^Let me |^First,|^Looking|^Now/i.test(text);
                    appendLog(task.id, makeLog(isThinking ? 'thinking' : 'info', text));
                  }
                } else if (block.type === 'tool_use') {
                  if (block.name === 'TodoWrite') {
                    const inp = block.input as { todos?: TodoItem[] };
                    if (Array.isArray(inp?.todos)) {
                      updateTodos(task.id, inp.todos);
                      setTaskTodos(task.id, inp.todos);
                    }
                  }
                  appendLog(task.id, makeLog('tool_call', fmtToolCall(block.name as string, block.input), { toolName: (block.name as string) ?? 'tool' }));
                }
              }
            } else if (evType === 'user') {
              type TRBlock = { type: string; content?: unknown };
              const msgObj = event.message as { content?: TRBlock[] };
              for (const block of msgObj?.content ?? []) {
                if (block.type === 'tool_result') {
                  const text = typeof block.content === 'string' ? block.content
                    : Array.isArray(block.content)
                      ? ((block.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '')
                      : '';
                  if (text.trim()) appendLog(task.id, makeLog('tool_result', text.slice(0, 400)));
                }
              }
            } else if (evType === 'result') {
              const sub = event.subtype as string;
              const result = (event.result as string) ?? '';
              appendLog(task.id, makeLog(sub === 'success' ? 'success' : 'error',
                result || (sub === 'success' ? 'Task completed' : 'Task failed')));
              const usage = event.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
              const costUsd = typeof event.total_cost_usd === 'number' ? event.total_cost_usd as number : undefined;
              if (usage) updateTokens(task.id, { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens }, costUsd);
              const nTurns = event.num_turns as number | undefined;
              const totalTok = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);
              appendLog(task.id, makeLog('system',
                `📊 Tokens: ${totalTok.toLocaleString()} (in ${usage?.input_tokens ?? 0} · out ${usage?.output_tokens ?? 0} · cacheR ${usage?.cache_read_input_tokens ?? 0} · cacheW ${usage?.cache_creation_input_tokens ?? 0})`
                + (nTurns != null ? ` · ${nTurns} turns` : '')
                + (costUsd != null ? ` · CLI cost $${costUsd.toFixed(4)}` : '')));
            } else if (evType === 'system' && event.subtype === 'init') {
              appendLog(task.id, makeLog('system', `Session · model: ${event.model as string ?? '?'}`));
            }
          } else if (msg.type === 'text' && msg.content?.trim()) {
            appendLog(task.id, makeLog('info', msg.content));
          } else if (msg.type === 'stderr' && msg.content?.trim()) {
            appendLog(task.id, makeLog('error', msg.content.trim()));
          } else if (msg.type === 'error' && msg.content) {
            appendLog(task.id, makeLog('error', msg.content));
          } else if (msg.type === 'awaiting-input') {
            // Agent is asking — render the question (if any) and open the reply box
            const q = msg.question as { questions?: { question?: string }[] } | undefined;
            const qText = q?.questions?.map(x => x.question).filter(Boolean).join(' · ');
            if (qText) appendLog(task.id, makeLog('thinking', `❓ ${qText}`));
            setAwaitingInput(true);
          } else if (msg.type === 'done') {
            es.close();
            setAwaitingInput(false);
            void captureUsageEnd(task.id);
            cleanup(msg.success ?? false);
          }
        };

        es.onerror = () => { es.close(); cleanup(false); };
      })
      .catch(err => {
        appendLog(task.id, makeLog('error', `Failed to start agent: ${String(err)}`));
        cleanup(false);
      });
  }

  function handleRun() {
    if (!task || terminal.isRunning) return;
    startExecution();
  }

  function handleResume() {
    if (!task || terminal.isRunning) return;
    startExecution();
  }

  function handlePause() {
    abortRef.current?.();
    abortRef.current = null;
    setAbortFn(null);
    pauseTask(task!.id);
  }

  function handleStop() {
    abortFn?.();           // closes real API connections (SSE + stop-task)
    abortRef.current?.();  // clears simulation timers
    abortRef.current = null;
    setAbortFn(null);
    setAwaitingInput(false);
    stopTask(task!.id);
  }

  function sendReply() {
    const content = replyText.trim();
    if (!content || !runIdRef.current || !task) return;
    fetch('/api/task-input', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: runIdRef.current, content }),
    }).catch(() => {});
    appendLog(task.id, makeLog('info', `▸ bạn: ${content}`));
    setReplyText('');
    setAwaitingInput(false);
  }

  const { input, output, cacheRead, total } = terminal.tokenUsage;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-3xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl shadow-black/70 flex flex-col overflow-hidden animate-slide-in max-h-[90vh]">

        {/* Header bar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-700 bg-slate-800">
          <TerminalIcon size={14} className="text-violet-400 shrink-0" />
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-xs font-mono text-slate-200 truncate">{task.title}</span>
            {terminal.isRunning && (
              <span className="flex items-center gap-1 text-[10px] text-violet-400 font-medium shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />RUNNING
              </span>
            )}
            {terminal.isPaused && !terminal.isRunning && (
              <span className="flex items-center gap-1 text-[10px] text-amber-400 font-medium shrink-0">
                <PauseCircle size={10} />PAUSED
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Schedule badge */}
            {agentConfig.schedule && (
              <div className="flex items-center gap-1 text-[10px] text-amber-400 border border-amber-700 bg-amber-950/40 px-2 py-0.5 rounded-full">
                <Calendar size={9} />
                {cronLabel(agentConfig.schedule)}
              </div>
            )}

            {/* Action buttons */}
            {!terminal.isRunning && !terminal.isPaused && task.status !== 'done' && (
              <button onClick={handleRun}
                className="flex items-center gap-1.5 px-2.5 py-1 bg-violet-600/30 border border-violet-500/40 text-violet-300 text-xs rounded-lg hover:bg-violet-600/50 transition-colors">
                <Play size={11} /> Run
              </button>
            )}
            {terminal.isPaused && !terminal.isRunning && (
              <button onClick={handleResume}
                className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-700/30 border border-amber-600/40 text-amber-300 text-xs rounded-lg hover:bg-amber-700/50 transition-colors">
                <Play size={11} /> Resume
              </button>
            )}
            {terminal.isRunning && (
              <>
                <button onClick={handlePause}
                  className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-800/40 border border-amber-600/40 text-amber-300 text-xs rounded-lg hover:bg-amber-800/60 transition-colors">
                  <PauseCircle size={11} /> Pause
                </button>
                <button onClick={handleStop}
                  className="flex items-center gap-1.5 px-2.5 py-1 bg-red-900/50 border border-red-700/40 text-red-400 text-xs rounded-lg hover:bg-red-900 transition-colors">
                  <StopCircle size={11} /> Stop
                </button>
              </>
            )}
            {terminal.logs.length > 0 && (
              <button
                onClick={() => {
                  if (!task) return;
                  captureFromTerminal(task, terminal.logs);
                  setSavedPrompt(true);
                  setTimeout(() => setSavedPrompt(false), 1500);
                }}
                title="Save as prompt"
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-slate-400 hover:text-violet-300 hover:bg-violet-900/30 border border-slate-700 rounded-lg transition-colors"
              >
                {savedPrompt ? <Check size={11} className="text-emerald-400" /> : <BookOpen size={11} />}
                {savedPrompt ? 'Saved' : 'Save Prompt'}
              </button>
            )}
            <button onClick={closeTerminal} className="p-1 text-slate-500 hover:text-slate-300 rounded transition-colors">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Token stats */}
        <div className="grid grid-cols-4 gap-px bg-slate-700/30">
          <StatBox icon={<Hash size={11} />}      label="Input"   value={input.toLocaleString()}          color="text-blue-400" />
          <StatBox icon={<Zap size={11} />}        label="Output"  value={output.toLocaleString()}         color="text-violet-400" />
          <StatBox icon={<Cpu size={11} />}        label="Cache"   value={cacheRead.toLocaleString()}      color="text-amber-400" />
          <StatBox icon={<DollarSign size={11} />} label="Cost"    value={`$${terminal.cost.toFixed(4)}`}  color="text-emerald-400" />
        </div>
        <div className="grid grid-cols-4 gap-px bg-slate-700/30 border-b border-slate-700/50">
          <StatBox icon={<Hash size={11} />}  label="Total"   value={total.toLocaleString()}              color="text-slate-300" />
          <StatBox icon={<Clock size={11} />} label="Elapsed" value={formatDuration(terminal.elapsedMs)}  color="text-slate-300" />
          <StatBox icon={<Cpu size={11} />}   label="Model"   value={modelInfo.label}                     color={modelInfo.color} small />
          <StatBox
            icon={<span className={clsx('w-1.5 h-1.5 rounded-full', terminal.isRunning ? 'bg-violet-400 animate-pulse' : terminal.isPaused ? 'bg-amber-400' : task.status === 'done' ? 'bg-emerald-500' : task.status === 'failed' ? 'bg-red-500' : 'bg-slate-500')} />}
            label="Status"
            value={terminal.isRunning ? 'Running' : terminal.isPaused ? 'Paused' : task.status === 'done' ? 'Done' : task.status === 'failed' ? 'Failed' : 'Idle'}
            color={terminal.isRunning ? 'text-violet-400' : terminal.isPaused ? 'text-amber-400' : task.status === 'done' ? 'text-emerald-400' : task.status === 'failed' ? 'text-red-400' : 'text-slate-400'}
          />
        </div>

        {/* Fail reason banner */}
        {task.status === 'failed' && task.failReason && (
          <div className="px-4 py-2.5 bg-red-950/60 border-b border-red-800/50 flex items-start gap-2">
            <AlertTriangle size={12} className="text-red-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="text-[10px] text-red-400 font-semibold uppercase tracking-wide">Fail Reason</span>
              <p className="text-[11px] text-red-300 font-mono mt-0.5 break-all leading-relaxed">{task.failReason.slice(0, 300)}</p>
            </div>
          </div>
        )}

        {/* Handoff context notice when paused/failed */}
        {(task.status === 'paused' || task.status === 'failed') && task.handoffContext && !terminal.isRunning && (
          <div className="px-4 py-2 bg-amber-950/40 border-b border-amber-800/40 flex items-center gap-2 text-[10px] text-amber-400">
            <RotateCcw size={10} />
            <span>Context handoff ready — khi Resume sẽ truyền context này cho phiên mới</span>
          </div>
        )}

        {/* Token budget bar — shown when tokenBudget is set */}
        {task.tokenBudget && task.tokenBudget > 0 && (() => {
          const pct = Math.min(100, Math.round((total / task.tokenBudget) * 100));
          const warn = pct >= 80;
          return (
            <div className="px-4 py-2 bg-slate-900 border-b border-slate-700/50">
              <div className="flex items-center justify-between text-[10px] mb-1">
                <span className="text-slate-500">Token Budget</span>
                <span className={warn ? 'text-amber-400 font-medium' : 'text-slate-500'}>
                  {total.toLocaleString()} / {task.tokenBudget.toLocaleString()} ({pct}%)
                  {warn && ' ⚠'}
                </span>
              </div>
              <div className="h-1 bg-slate-700 rounded-full overflow-hidden">
                <div
                  className={clsx('h-full rounded-full transition-all', pct >= 95 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-400' : 'bg-emerald-500')}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })()}

        {/* Live todo / plan panel — image-2 style */}
        {(task.terminal.todos ?? []).length > 0 && (
          <div className="px-4 py-2.5 bg-slate-900 border-b border-slate-700/50">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">Update Todos</span>
              <span className="text-[10px] font-mono text-slate-600">
                {(task.terminal.todos ?? []).filter(t => t.status === 'completed').length}/{(task.terminal.todos ?? []).length}
              </span>
            </div>
            <div className="space-y-[3px]">
              {(task.terminal.todos ?? []).map((todo, i) => (
                <div key={todo.id ?? i} className="flex items-start gap-2 text-[11px] font-mono">
                  {todo.status === 'completed'
                    ? <span className="shrink-0 text-emerald-400 mt-px select-none">✓</span>
                    : todo.status === 'in_progress'
                      ? <span className="shrink-0 text-amber-400 mt-px select-none animate-pulse">*</span>
                      : <span className="shrink-0 text-slate-600 mt-px select-none">□</span>
                  }
                  <span className={clsx(
                    'flex-1 leading-relaxed',
                    todo.status === 'completed' ? 'line-through text-slate-600' :
                    todo.status === 'in_progress' ? 'text-amber-300 font-medium' :
                    'text-slate-400',
                  )}>
                    {todo.content}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Logs */}
        <div ref={logsRef} className="flex-1 overflow-y-auto font-mono text-xs p-4 space-y-0.5 bg-slate-950 min-h-64 max-h-80">
          {terminal.logs.length === 0 ? (
            <div className="text-slate-500 text-center mt-8">
              {terminal.isPaused ? 'Task paused. Click Resume to start a new agent run.' : 'Click Run to start the agent.'}
            </div>
          ) : (
            terminal.logs.map(log => <RichLogRow key={log.id} log={log} />)
          )}
          {terminal.isRunning && <ThinkingRow logs={terminal.logs} />}
        </div>

        {/* Interactive reply box — shown when the agent asks a question */}
        {awaitingInput && terminal.isRunning && (
          <div className="px-4 py-3 bg-slate-900 border-t border-violet-700/50 space-y-2 animate-fade-in">
            <div className="flex items-center gap-1.5 text-[11px] text-violet-300 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
              Agent đang chờ trả lời của bạn
            </div>
            <div className="flex items-end gap-2">
              <textarea
                value={replyText}
                onChange={e => setReplyText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); } }}
                rows={2}
                autoFocus
                placeholder="Nhập câu trả lời rồi Enter để gửi (Shift+Enter xuống dòng)…"
                className="flex-1 bg-slate-950 border border-slate-700 focus:border-violet-500 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 outline-none resize-none"
              />
              <button
                onClick={sendReply}
                disabled={!replyText.trim()}
                className="flex items-center gap-1.5 px-3 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors shrink-0"
              >
                <Play size={11} /> Gửi
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Rich log renderer (image-1 style) ────────────────────────────────────────

function RichLogRow({ log }: { log: LogEntry }) {
  const time = log.timestamp.toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // File-aware tool calls: Read / Edit / Write / Glob / Grep / Bash
  if (log.type === 'tool_call' && (log.filePath || log.toolName)) {
    const isEdit  = log.toolName === 'Edit';
    const isWrite = log.toolName === 'Write';
    const isRead  = log.toolName === 'Read';
    const isBash  = log.toolName === 'Bash';
    const toolColor = isEdit ? 'text-amber-300' : isWrite ? 'text-violet-300' : isRead ? 'text-sky-300' : isBash ? 'text-emerald-300' : 'text-amber-300';

    return (
      <div className="space-y-0.5 my-0.5">
        <div className="flex gap-2 leading-relaxed items-baseline">
          <span className="text-slate-600 shrink-0 select-none tabular-nums">{time}</span>
          <span className="text-amber-400 shrink-0">●</span>
          <span className="flex-1 flex items-baseline gap-1.5 flex-wrap">
            <span className={clsx('font-semibold shrink-0', toolColor)}>{log.toolName}</span>
            {log.filePath
              ? <span className="text-blue-300 break-all">{log.filePath}</span>
              : <span className="text-slate-300 break-all">{log.content}</span>}
            {log.lineRange && (
              <span className="text-slate-500 text-[10px] shrink-0">({log.lineRange})</span>
            )}
          </span>
        </div>
        {(isEdit || isWrite) && log.linesAdded && (
          <div className="flex gap-2 pl-14">
            <span className="text-emerald-400 text-[10px]">Added {log.linesAdded} lines</span>
            {log.linesRemoved && <span className="text-red-400 text-[10px]">Removed {log.linesRemoved} lines</span>}
          </div>
        )}
        {log.diffPreview && log.diffPreview.length > 0 && (
          <div className="ml-14 bg-slate-900 border border-slate-800 rounded px-2 py-1 space-y-px">
            {log.diffPreview.map((line, i) => (
              <div key={i} className={clsx('text-[10px] leading-relaxed',
                line.startsWith('+') ? 'text-emerald-400' :
                line.startsWith('-') ? 'text-red-400' :
                'text-slate-600'
              )}>{line}</div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Default flat row
  return (
    <div className="flex gap-2 leading-relaxed">
      <span className="text-slate-600 shrink-0 select-none tabular-nums">{time}</span>
      <span className={clsx('shrink-0', LOG_COLORS[log.type])}>{LOG_PREFIX[log.type]}</span>
      <span className={clsx('flex-1 break-all', LOG_COLORS[log.type])}>
        {log.toolName && !log.filePath && <span className="text-amber-200 mr-1">[{log.toolName}]</span>}
        {log.content}
        {log.duration !== undefined && <span className="text-slate-600 ml-2">({log.duration}ms)</span>}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function StatBox({ icon, label, value, color, small }: { icon: React.ReactNode; label: string; value: string; color: string; small?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2 bg-slate-800">
      <div className="flex items-center gap-1 text-slate-500">
        {icon}
        <span className="text-[10px] uppercase tracking-wide">{label}</span>
      </div>
      <span className={clsx('font-mono font-medium', small ? 'text-[10px]' : 'text-xs', color)}>{value}</span>
    </div>
  );
}

const THINKING_PHRASES = [
  'Analyzing context',
  'Processing information',
  'Reasoning through steps',
  'Evaluating options',
  'Forming response',
  'Reading files',
  'Synthesizing results',
];

function ThinkingRow({ logs }: { logs: LogEntry[] }) {
  const [dots, setDots] = useState('');
  const [phraseIdx, setPhraseIdx] = useState(0);

  // Cycle dots: "" → "." → ".." → "..."
  useEffect(() => {
    const t = setInterval(() => {
      setDots(d => d.length >= 3 ? '' : d + '.');
    }, 400);
    return () => clearInterval(t);
  }, []);

  // Rotate phrase every 3s when there's no recent thinking log
  useEffect(() => {
    const t = setInterval(() => {
      setPhraseIdx(i => (i + 1) % THINKING_PHRASES.length);
    }, 3000);
    return () => clearInterval(t);
  }, []);

  // Use the last thinking/info log as context label if recent (< 2s ago)
  const lastThinking = [...logs].reverse().find(l => l.type === 'thinking' || l.type === 'info');
  const isRecent = lastThinking && (Date.now() - lastThinking.timestamp.getTime()) < 2000;
  const label = isRecent
    ? lastThinking!.content.slice(0, 60) + (lastThinking!.content.length > 60 ? '…' : '')
    : THINKING_PHRASES[phraseIdx];

  const now = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="flex gap-2 leading-relaxed items-center mt-1 pt-2 border-t border-slate-800/60 animate-fade-in">
      <span className="text-slate-600 shrink-0 select-none tabular-nums">{now}</span>
      {/* Animated bars */}
      <span className="flex gap-[3px] items-end h-3.5 shrink-0">
        <span className="inline-block w-[3px] bg-violet-400 rounded-sm" style={{ height: '10px', animation: 'thinking-bar 1.1s ease-in-out 0s infinite' }} />
        <span className="inline-block w-[3px] bg-violet-400 rounded-sm" style={{ height: '14px', animation: 'thinking-bar 1.1s ease-in-out 0.18s infinite' }} />
        <span className="inline-block w-[3px] bg-violet-400 rounded-sm" style={{ height: '10px', animation: 'thinking-bar 1.1s ease-in-out 0.36s infinite' }} />
      </span>
      {/* Thinking text with blinking cursor */}
      <span className="text-violet-300 text-[11px] font-mono flex-1 truncate">
        <span className="text-violet-400 font-semibold">thinking</span>
        {' — '}
        <span className="opacity-75">{label}</span>
        <span className="text-violet-400 font-bold ml-0.5 inline-block w-[6px]">{dots.length === 0 ? ' ' : dots}</span>
        <span className="animate-blink text-violet-500 ml-0.5">▌</span>
      </span>
    </div>
  );
}
