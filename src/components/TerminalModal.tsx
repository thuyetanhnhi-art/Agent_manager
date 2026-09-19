import { useState, useEffect, useRef } from 'react';
import { X, Play, Square, Terminal as TerminalIcon, Copy, Check, RefreshCw } from 'lucide-react';
import clsx from 'clsx';

interface LogLine {
  type: 'stdout' | 'stderr' | 'info';
  text: string;
}

interface TerminalModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  cwd: string;
  prompt?: string;
  description?: string;
}

export function TerminalModal({ open, onClose, title, cwd, prompt, description }: TerminalModalProps) {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      setLogs([]);
      setRunning(false);
      setDone(false);
      setExitCode(null);
    }
  }, [open]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  async function startRun() {
    setLogs([
      { type: 'info', text: `$ claude` },
      { type: 'info', text: `cwd: ${cwd}` },
      { type: 'info', text: '─'.repeat(48) },
    ]);
    setRunning(true);
    setDone(false);
    setExitCode(null);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const resp = await fetch('/api/exec/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, prompt: prompt ?? '' }),
        signal: ctrl.signal,
      });

      if (!resp.ok || !resp.body) {
        const errText = await resp.text().catch(() => 'Request failed');
        setLogs(prev => [...prev, { type: 'stderr', text: errText }]);
        setRunning(false);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done: d, value } = await reader.read();
        if (d) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          if (!part.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(part.slice(6)) as { type: string; text?: string; code?: number };
            if (ev.type === 'stdout' || ev.type === 'stderr') {
              const lines = (ev.text ?? '').split('\n').filter(l => l.trim());
              if (lines.length > 0) {
                setLogs(prev => [...prev, ...lines.map(l => ({ type: ev.type as 'stdout' | 'stderr', text: l }))]);
              }
            } else if (ev.type === 'exit') {
              setExitCode(ev.code ?? 0);
              setRunning(false);
              setDone(true);
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setLogs(prev => [...prev, { type: 'stderr', text: String(e) }]);
      }
      setRunning(false);
    }
  }

  function stopRun() {
    abortRef.current?.abort();
    setRunning(false);
    setLogs(prev => [...prev, { type: 'info', text: '— stopped by user —' }]);
  }

  function copyPrompt() {
    if (!prompt) return;
    navigator.clipboard.writeText(prompt).catch(() => {});
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 1500);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 backdrop-blur-sm">
      <div
        className="w-full max-w-2xl mx-4 flex flex-col bg-slate-900 rounded-2xl shadow-2xl border border-slate-700 overflow-hidden"
        style={{ maxHeight: '82vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <TerminalIcon size={14} className="text-emerald-400 shrink-0" />
            <span className="text-sm font-semibold text-slate-100 truncate">{title}</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 ml-3">
            {prompt && (
              <button
                onClick={copyPrompt}
                className="flex items-center gap-1 px-2 py-1 text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg transition-colors"
              >
                {copiedPrompt ? <Check size={9} className="text-emerald-400" /> : <Copy size={9} />}
                {copiedPrompt ? 'Copied!' : 'Copy Prompt'}
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded-lg transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Info bar */}
        <div className="px-4 py-2 border-b border-slate-700 bg-slate-800 shrink-0">
          <p className="text-[10px] text-slate-400 font-mono truncate">cwd: {cwd}</p>
          {description && <p className="text-[10px] text-slate-500 mt-0.5">{description}</p>}
        </div>

        {/* Log area */}
        <div className="flex-1 overflow-y-auto px-4 py-3 font-mono text-[11px] leading-relaxed min-h-0">
          {logs.length === 0 && !running && (
            <p className="text-slate-500 text-center py-8 text-xs">Click Run to start the process in this directory.</p>
          )}
          {logs.map((log, i) => (
            <div
              key={i}
              className={clsx(
                log.type === 'info' && 'text-slate-400',
                log.type === 'stdout' && 'text-emerald-300',
                log.type === 'stderr' && 'text-red-400',
              )}
            >
              {log.text}
            </div>
          ))}
          {done && exitCode !== null && (
            <div className={clsx('mt-2 font-semibold text-[10px]', exitCode === 0 ? 'text-emerald-400' : 'text-red-400')}>
              ✓ Exited with code {exitCode}
            </div>
          )}
          <div ref={logsEndRef} />
        </div>

        {/* Controls */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 bg-slate-800 shrink-0">
          <div className="flex items-center gap-1.5">
            <div className={clsx(
              'w-2 h-2 rounded-full transition-colors',
              running ? 'bg-emerald-400 animate-pulse'
                : done ? (exitCode === 0 ? 'bg-emerald-500' : 'bg-red-500')
                : 'bg-slate-500',
            )} />
            <span className="text-[10px] text-slate-400">
              {running ? 'Running…' : done ? (exitCode === 0 ? 'Completed' : 'Failed') : 'Ready'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {done && !running && (
              <button
                onClick={() => { setLogs([]); setDone(false); setExitCode(null); startRun(); }}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-medium rounded-lg transition-colors"
              >
                <RefreshCw size={11} /> Rerun
              </button>
            )}
            {running ? (
              <button
                onClick={stopRun}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-lg transition-colors"
              >
                <Square size={11} fill="currentColor" /> Stop
              </button>
            ) : !done ? (
              <button
                onClick={startRun}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium rounded-lg transition-colors"
              >
                <Play size={11} fill="currentColor" /> Run
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
