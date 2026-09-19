interface CacheEntry {
  content: string;
  loadedAt: number;
  source: 'api' | 'simulated';
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

export function getCachedContext(repoPath: string): CacheEntry | null {
  const entry = cache.get(repoPath);
  if (!entry) return null;
  if (Date.now() - entry.loadedAt > TTL_MS) {
    cache.delete(repoPath);
    return null;
  }
  return entry;
}

export function setCachedContext(repoPath: string, content: string, source: 'api' | 'simulated' = 'api'): void {
  cache.set(repoPath, { content, loadedAt: Date.now(), source });
}

export function clearCachedContext(repoPath: string): void {
  cache.delete(repoPath);
}

/**
 * Try to load project context from backend API.
 * Returns null if backend is unreachable or repo has no CLAUDE.md.
 */
export async function fetchProjectContext(repoPath: string): Promise<string | null> {
  const cached = getCachedContext(repoPath);
  if (cached) return cached.content;

  try {
    const res = await fetch(`/api/context?path=${encodeURIComponent(repoPath)}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const json = await res.json() as { content?: string };
    if (!json.content) return null;
    setCachedContext(repoPath, json.content, 'api');
    return json.content;
  } catch {
    return null;
  }
}

/**
 * Build a lightweight simulated context string for offline/simulation mode.
 * Stored in cache so subsequent runs show "(cached)" in the terminal.
 */
export function buildSimulatedContext(repoPath: string, projectName: string): string {
  const cached = getCachedContext(repoPath);
  if (cached) return cached.content;

  const ctx = [
    `# Project: ${projectName || repoPath}`,
    `Repo: ${repoPath}`,
    '',
    '## Key conventions',
    '- Follow existing code style and naming patterns',
    '- Run type-check after changes',
    '- Keep modules small and single-responsibility',
    '',
    '## Context loaded from CLAUDE.md (simulated)',
  ].join('\n');

  setCachedContext(repoPath, ctx, 'simulated');
  return ctx;
}
