import { create } from 'zustand';

/** One rate-limit window (5-hour session or 7-day weekly). */
export interface UsageWindow {
  utilization: number; // percent 0-100
  resetsAt: string;    // ISO timestamp
}

interface UsageState {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  loaded: boolean;
  error: string | null;
  fetchUsage: () => Promise<void>;
  startAutoRefresh: () => void;
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;
const REFRESH_MS = 60_000; // Claude usage moves slowly — once a minute is plenty.

export const useUsageStore = create<UsageState>((set, get) => ({
  fiveHour: null,
  sevenDay: null,
  loaded: false,
  error: null,

  fetchUsage: async () => {
    try {
      const res = await fetch('/api/usage', { signal: AbortSignal.timeout(8000) });
      const json = await res.json() as {
        ok?: boolean; error?: string;
        fiveHour?: UsageWindow | null; sevenDay?: UsageWindow | null;
      };
      if (!json.ok) { set({ error: json.error ?? 'usage unavailable', loaded: true }); return; }
      set({ fiveHour: json.fiveHour ?? null, sevenDay: json.sevenDay ?? null, loaded: true, error: null });
    } catch (e) {
      set({ error: String(e), loaded: true });
    }
  },

  startAutoRefresh: () => {
    void get().fetchUsage();
    if (refreshTimer) return; // already running — single shared interval
    refreshTimer = setInterval(() => { void get().fetchUsage(); }, REFRESH_MS);
  },
}));

/**
 * One-off fetch of the current utilization (%) for both windows, without touching
 * the shared store. Used to snapshot account usage at a task's run start/end so we
 * can attribute the delta to that task.
 */
export async function fetchUsageSnapshot(): Promise<{ fiveHour: number; sevenDay: number } | null> {
  try {
    const res = await fetch('/api/usage', { signal: AbortSignal.timeout(8000) });
    const json = await res.json() as { ok?: boolean; fiveHour?: UsageWindow | null; sevenDay?: UsageWindow | null };
    if (!json.ok) return null;
    return {
      fiveHour: json.fiveHour?.utilization ?? 0,
      sevenDay: json.sevenDay?.utilization ?? 0,
    };
  } catch {
    return null;
  }
}

/** "Resets in 3h" / "Resets in 3d" — compact countdown matching the Claude Code UI. */
export function formatResetIn(resetsAt: string): string {
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!isFinite(ms) || ms <= 0) return 'Resetting…';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `Resets in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `Resets in ${hours}h`;
  return `Resets in ${Math.round(hours / 24)}d`;
}
