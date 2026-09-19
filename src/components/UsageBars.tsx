import { useUsageStore, formatResetIn, type UsageWindow } from '../usageStore';

interface UsageBarsProps {
  /** compact = smaller text/bars, for task cards; default = roomier, for detail panels */
  compact?: boolean;
}

function barColor(pct: number): string {
  if (pct >= 90) return 'bg-red-500';
  if (pct >= 70) return 'bg-amber-500';
  return 'bg-emerald-500';
}

function UsageRow({ label, win, compact }: { label: string; win: UsageWindow | null; compact: boolean }) {
  const pct = win ? Math.min(100, Math.round(win.utilization)) : 0;
  return (
    <div>
      <div className={`flex items-center justify-between ${compact ? 'text-[9px]' : 'text-xs'}`}>
        <span className="text-slate-500 font-medium">{label}</span>
        <span className="text-slate-700 font-semibold tabular-nums">{win ? `${pct}%` : '—'}</span>
      </div>
      <div className={`mt-0.5 w-full rounded-full bg-slate-200 overflow-hidden ${compact ? 'h-1' : 'h-1.5'}`}>
        <div className={`h-full rounded-full transition-all ${barColor(pct)}`} style={{ width: `${pct}%` }} />
      </div>
      {win && !compact && (
        <div className="mt-0.5 text-[10px] text-slate-400">{formatResetIn(win.resetsAt)}</div>
      )}
    </div>
  );
}

/** Account-level Claude usage (5-hour session + 7-day weekly) from /api/usage. */
export function UsageBars({ compact = false }: UsageBarsProps) {
  const { fiveHour, sevenDay, loaded, error } = useUsageStore();

  if (loaded && error && !fiveHour && !sevenDay) return null; // no credentials / unavailable — stay quiet

  return (
    <div className={compact ? 'mt-2 pt-2 border-t border-slate-100 space-y-1.5' : 'space-y-2.5'}>
      <UsageRow label="Session (5hr)" win={fiveHour} compact={compact} />
      <UsageRow label="Weekly (7 day)" win={sevenDay} compact={compact} />
    </div>
  );
}
