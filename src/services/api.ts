export interface RepoInfo {
  id: string;
  name: string;
  path: string;
  lastModified: string;
  branch: string | null;
  lastCommit: string | null;
}

export async function checkHealth(): Promise<{ ok: boolean; hasApiKey: boolean; reposRoot: string }> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error('Offline');
  return res.json();
}

export async function fetchRepos(root?: string): Promise<{ repos: RepoInfo[]; root: string }> {
  const url = root ? `/api/repos?root=${encodeURIComponent(root)}` : '/api/repos';
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch repos');
  return res.json();
}

// Execution params kept for type compatibility but not used (simulation mode only)
export interface ExecuteParams {
  taskId: string; title: string; description: string;
  model: string; tools: string[]; repoPath: string; maxTokens: number;
}

export type SSEEvent =
  | { type: 'log'; entry: { id: string; timestamp: string; type: string; content: string; toolName?: string; duration?: number } }
  | { type: 'tokens'; delta: { input?: number; output?: number; cacheRead?: number } }
  | { type: 'progress'; value: number }
  | { type: 'complete'; success: boolean; error?: string };

// Stub — real execution requires an API key. Use simulation mode instead.
export function executeTask(_params: ExecuteParams, _onEvent: (e: SSEEvent) => void): () => void {
  return () => {};
}

// ── GitLab integration ───────────────────────────────────────────────────────

export interface GitlabConfig {
  url: string;
  hasToken: boolean;
}

export async function fetchGitlabConfig(): Promise<GitlabConfig> {
  // 1. Try explicit GitLab config first
  try {
    const res = await fetch('/api/gitlab');
    if (res.ok) {
      const cfg = await res.json() as GitlabConfig;
      if (cfg.hasToken) return cfg;
    }
  } catch { /* fallthrough */ }

  // 2. Fallback: read from MCP servers config (user may have GitLab MCP connected)
  try {
    const mcp = await fetch('/api/mcp', { signal: AbortSignal.timeout(2000) });
    if (mcp.ok) {
      // Backend returns { servers: Record<string, {command, env}> } — convert to array
      const data = await mcp.json() as { servers?: Record<string, { env?: Record<string, string> }> };
      const entries = Object.entries(data.servers ?? {});
      const gitlabEntry = entries.find(([name, cfg]) =>
        name.toLowerCase().includes('gitlab') ||
        cfg?.env?.GITLAB_PERSONAL_ACCESS_TOKEN ||
        cfg?.env?.GITLAB_API_URL,
      );
      if (gitlabEntry) {
        const cfg = gitlabEntry[1];
        if (cfg?.env?.GITLAB_API_URL || cfg?.env?.GITLAB_PERSONAL_ACCESS_TOKEN) {
          const rawUrl = cfg.env?.GITLAB_API_URL ?? '';
          const baseUrl = rawUrl.replace(/\/api\/v4\/?$/, '');
          return { url: baseUrl, hasToken: true };
        }
      }
    }
  } catch { /* fallthrough */ }

  return { url: '', hasToken: false };
}

export async function saveGitlabConfig(url: string, token: string): Promise<{ ok: boolean }> {
  const res = await fetch('/api/gitlab', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, token }),
  });
  if (!res.ok) return { ok: false };
  return res.json() as Promise<{ ok: boolean }>;
}

export async function pullMain(
  repoPath: string,
  branch = 'main',
): Promise<{ ok: boolean; output?: string; error?: string; step?: string }> {
  const res = await fetch('/api/git/pull-main', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath, branch }),
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  return res.json() as Promise<{ ok: boolean; output?: string; error?: string; step?: string }>;
}

export interface GitlabRepo {
  id: number;
  name: string;
  pathWithNamespace: string;
  httpUrl: string;
  sshUrl: string;
  defaultBranch: string;
  lastActivity: string;
  namespace: string;
  description: string;
}

export async function fetchGitlabRepos(
  search = '',
  page = 1,
): Promise<{ ok: boolean; repos?: GitlabRepo[]; error?: string }> {
  const qs = new URLSearchParams({ page: String(page) });
  if (search) qs.set('search', search);
  const res = await fetch(`/api/gitlab/repos?${qs}`);
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  return res.json() as Promise<{ ok: boolean; repos?: GitlabRepo[]; error?: string }>;
}

export async function createBranch(
  repoPath: string,
  baseBranch: string,
  newBranch: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/git/branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath, baseBranch, newBranch }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function saveSkillToProject(params: {
  skillsDir: string;  // full path: {kbRoot}/{project}/_skills
  skillId: string;
  skillName: string;
  description: string;
  promptTemplate: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/skill/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function savePromptToProject(params: {
  promptDir: string;  // full path: {kbRoot}/{project}/_prompt
  promptSlug: string;
  title: string;
  content: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/prompt/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function openExternalTerminal(
  repoPath: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/terminal/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function cloneRepo(
  httpUrl: string,
  name: string,
  targetRoot: string,
): Promise<{ ok: boolean; path?: string; name?: string; branch?: string | null; alreadyExists?: boolean; error?: string }> {
  const res = await fetch('/api/git/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ httpUrl, name, targetRoot }),
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  return res.json() as Promise<{ ok: boolean; path?: string; name?: string; branch?: string | null; alreadyExists?: boolean; error?: string }>;
}

// ── Git status & conflict management ─────────────────────────────────────────

export interface RepoGitStatusResult {
  ok: boolean;
  branch?: string;
  status?: 'clean' | 'behind' | 'ahead' | 'diverged' | 'conflict' | 'unknown';
  aheadCount?: number;
  behindCount?: number;
  conflictFiles?: string[];
  lastCommit?: string;
  branches?: string[];
  error?: string;
}

export async function fetchRepoGitStatusBatch(
  paths: string[],
): Promise<{ ok: boolean; statuses?: Record<string, RepoGitStatusResult>; error?: string }> {
  try {
    const res = await fetch('/api/git/status-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return res.json() as Promise<{ ok: boolean; statuses?: Record<string, RepoGitStatusResult>; error?: string }>;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function fetchRepoGitStatus(
  repoPath: string,
): Promise<RepoGitStatusResult> {
  try {
    const res = await fetch(`/api/git/status?path=${encodeURIComponent(repoPath)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, status: 'unknown', error: `HTTP ${res.status}` };
    return res.json() as Promise<RepoGitStatusResult>;
  } catch (e) {
    return { ok: false, status: 'unknown', error: String(e) };
  }
}

export interface ConflictFile {
  path: string;
  oursContent: string;
  theirsContent: string;
}

export async function fetchConflictDetails(
  repoPath: string,
): Promise<{ ok: boolean; files?: ConflictFile[]; error?: string }> {
  try {
    const res = await fetch(`/api/git/conflicts?path=${encodeURIComponent(repoPath)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return res.json() as Promise<{ ok: boolean; files?: ConflictFile[]; error?: string }>;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function resolveConflictFile(
  repoPath: string,
  filePath: string,
  resolution: 'ours' | 'theirs',
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/git/resolve-conflict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath, filePath, resolution }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function finalizeConflictResolution(
  repoPath: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/git/resolve-finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function checkoutBranch(
  repoPath: string,
  branch: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/git/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath, branch }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function mergeBranch(
  repoPath: string,
  branch: string,
): Promise<{ ok: boolean; hasConflict?: boolean; output?: string; error?: string }> {
  try {
    const res = await fetch('/api/git/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath, branch }),
      signal: AbortSignal.timeout(35000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return res.json() as Promise<{ ok: boolean; hasConflict?: boolean; output?: string; error?: string }>;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function abortMerge(
  repoPath: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/git/abort-merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Git repo scanner ─────────────────────────────────────────────────────────

export interface ScannedRepo {
  path: string;
  name: string;
  relativePath: string;
}

export async function scanGitRepos(
  rootPath: string,
): Promise<{ ok: boolean; repos?: ScannedRepo[]; error?: string }> {
  try {
    const res = await fetch(`/api/git/scan?root=${encodeURIComponent(rootPath)}`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return res.json() as Promise<{ ok: boolean; repos?: ScannedRepo[]; error?: string }>;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── GitLab MR & Pipeline ─────────────────────────────────────────────────────

export interface GitlabMRInfo {
  id: number;
  iid: number;
  title: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  state: 'opened' | 'closed' | 'merged';
  draft: boolean;
  webUrl: string;
  updatedAt: string;
}

export async function fetchProjectMRs(
  repoPath: string,
): Promise<{ ok: boolean; mrs?: GitlabMRInfo[]; error?: string }> {
  try {
    const res = await fetch(`/api/gitlab/mrs?repoPath=${encodeURIComponent(repoPath)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return res.json() as Promise<{ ok: boolean; mrs?: GitlabMRInfo[]; error?: string }>;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export interface PipelineInfo {
  id: number;
  status: 'success' | 'failed' | 'running' | 'pending' | 'canceled';
  ref: string;
  webUrl: string;
  updatedAt: string;
}

export async function fetchProjectPipeline(
  repoPath: string,
): Promise<{ ok: boolean; pipeline?: PipelineInfo; error?: string }> {
  try {
    const res = await fetch(`/api/gitlab/pipeline?repoPath=${encodeURIComponent(repoPath)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return res.json() as Promise<{ ok: boolean; pipeline?: PipelineInfo; error?: string }>;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export interface MRBatchResult {
  repoPath: string;
  mrs: GitlabMRInfo[];
  pipelines: PipelineInfo[];
}

export async function fetchProjectMRsBatch(
  repoPaths: string[],
): Promise<{ ok: boolean; results?: MRBatchResult[]; error?: string }> {
  try {
    const res = await fetch('/api/gitlab/mrs-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPaths }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return res.json() as Promise<{ ok: boolean; results?: MRBatchResult[]; error?: string }>;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function retryPipeline(
  repoPath: string,
  pipelineId: number,
): Promise<{ ok: boolean; pipeline?: PipelineInfo; error?: string }> {
  try {
    const res = await fetch('/api/gitlab/pipeline-retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath, pipelineId }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return res.json() as Promise<{ ok: boolean; pipeline?: PipelineInfo; error?: string }>;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
