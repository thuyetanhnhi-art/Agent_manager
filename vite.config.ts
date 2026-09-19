import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
// xlsx is CommonJS — use createRequire for reliable interop in ESM vite.config
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const XLSX: any = createRequire(import.meta.url)('xlsx');

interface RepoInfo {
  id: string; name: string; path: string;
  lastModified: string; branch: string | null; lastCommit: string | null;
}

interface SseClient {
  write: (s: string) => void;
  end: () => void;
}

interface RunState {
  proc: ChildProcess | null;
  buffer: string[];
  done: boolean;
  clients: SseClient[];
  accText: string;
  awaitingInput?: boolean;   // agent asked a question and is waiting for the user's reply
  interactive?: boolean;     // spawned with --input-format stream-json (stdin kept open)
}

// Send a user message to a live stream-json claude process via stdin.
function writeUserMessage(state: RunState, content: string) {
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }) + '\n';
  try { state.proc?.stdin?.write(line); } catch { /* ignore */ }
}

const runs = new Map<string, RunState>();

// AI QC run state (persists across HMR — declared at module level like `runs`)
const aiQcRuns = new Map<string, { buffer: string[]; done: boolean; clients: SseClient[] }>();

// FB Messenger phone-collector schedulers (module level so a restart never stacks intervals).
// Two independent trigger paths can both be active at once: a flat interval (fbIntervalTimer,
// set from the SĐT Facebook settings toggle) and per-Task cron schedules (fbCronTimer).
let fbCronTimer: ReturnType<typeof setInterval> | null = null;
let fbIntervalTimer: ReturnType<typeof setInterval> | null = null;
const fbCronFiredMinutes = new Map<string, string>(); // taskId -> last-fired "YYYY-MM-DDTHH:mm"

function sseEmit(state: RunState, data: object) {
  const line = `data: ${JSON.stringify(data)}\n\n`;
  state.buffer.push(line);
  state.clients.forEach(c => { try { c.write(line); } catch { /* ignore */ } });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readBody(req: any): Promise<string> {
  return new Promise(resolve => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve('{}'));
  });
}

// Collect a raw binary request body (for file uploads).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readBodyBuffer(req: any): Promise<Buffer> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

// ── Encryption helpers for MCP env secrets ──────────────────────────────────

const ENC_PREFIX = 'enc:v1:';

function getMcpEncryptKey(): string {
  if (process.env.MCP_ENCRYPT_KEY) return process.env.MCP_ENCRYPT_KEY;
  const envLocalPath = path.join(process.cwd(), '.env.local');
  try {
    const content = fs.readFileSync(envLocalPath, 'utf-8');
    const match = content.match(/^MCP_ENCRYPT_KEY=(.+)$/m);
    if (match?.[1]) { process.env.MCP_ENCRYPT_KEY = match[1].trim(); return process.env.MCP_ENCRYPT_KEY; }
  } catch { /* file not found */ }
  const newKey = randomBytes(32).toString('hex');
  process.env.MCP_ENCRYPT_KEY = newKey;
  try {
    const existing = fs.existsSync(envLocalPath) ? fs.readFileSync(envLocalPath, 'utf-8') : '';
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(envLocalPath, existing + sep + `MCP_ENCRYPT_KEY=${newKey}\n`, 'utf-8');
  } catch { /* ignore */ }
  return newKey;
}

function encryptEnvValue(text: string, password: string): string {
  const key = scryptSync(password, 'agentmgr-mcp-v1', 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptEnvValue(data: string, password: string): string {
  if (!data.startsWith(ENC_PREFIX)) return data;
  try {
    const buf = Buffer.from(data.slice(ENC_PREFIX.length), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const key = scryptSync(password, 'agentmgr-mcp-v1', 32);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch { return data; }
}

/** Check if a CLI command exists in PATH */
function commandExists(cmd: string): boolean {
  try {
    const r = spawnSync(cmd, ['--version'], { shell: true, timeout: 5000, stdio: 'pipe' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Get npm global bin dir (so we can locate newly installed binaries without relying on PATH refresh) */
function npmGlobalBin(): string {
  try {
    const r = spawnSync('npm', ['bin', '-g'], { shell: true, encoding: 'utf-8', stdio: 'pipe' });
    return (r.stdout ?? '').toString().trim();
  } catch {
    return '';
  }
}

/** Install @anthropic-ai/claude-code globally, streaming progress via onLine */
function installClaude(onLine: (line: string) => void): Promise<boolean> {
  return new Promise(resolve => {
    const p = spawn('npm', ['install', '-g', '@anthropic-ai/claude-code', '--prefer-online'], { shell: true });
    const emit = (d: Buffer) => d.toString().split('\n').filter(l => l.trim()).forEach(l => onLine(l));
    p.stdout?.on('data', emit);
    p.stderr?.on('data', emit);
    p.on('close', code => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

/** Resolve the full path to claude after a fresh install (PATH may not be refreshed yet) */
function resolveClaudePath(): string {
  if (commandExists('claude')) return 'claude';
  const bin = npmGlobalBin();
  if (bin) {
    const candidate = path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'claude'; // fallback — let the OS error propagate
}

function scanFiles(rootPath: string, dirPath: string, maxDepth: number, current = 0): string[] {
  if (current >= maxDepth) return [];
  if (!fs.existsSync(dirPath)) return [];
  const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '__pycache__', '.venv', 'vendor']);
  const result: string[] = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dirPath, entry.name);
      const rel = path.relative(rootPath, full).replace(/\\/g, '/');
      if (entry.isDirectory()) result.push(...scanFiles(rootPath, full, maxDepth, current + 1));
      else result.push(rel);
      if (result.length >= 100) break;
    }
  } catch { /* ignore */ }
  return result;
}

/** Read content of key files (package.json, README, tsconfig, entry points) for AI context */
function readKeyFiles(rootPath: string, maxFiles = 5, maxChars = 2000): string {
  if (!rootPath) return '';
  const candidates = [
    'package.json', 'README.md', 'tsconfig.json', 'tsconfig.base.json',
    'src/index.ts', 'src/index.tsx', 'src/main.ts', 'src/main.tsx',
    'src/App.tsx', 'src/app.module.ts', 'nest-cli.json',
    'docker-compose.yml', '.env.example',
  ];
  const parts: string[] = [];
  for (const rel of candidates) {
    const full = path.join(rootPath, rel);
    if (!fs.existsSync(full)) continue;
    try {
      const content = fs.readFileSync(full, 'utf-8').slice(0, maxChars);
      parts.push(`\n--- ${rel} ---\n${content}`);
    } catch { /* skip */ }
    if (parts.length >= maxFiles) break;
  }
  return parts.join('\n');
}

/** Read CLAUDE.md from the project root — strip @file references, cap at 3 KB */
function readClaudeMd(rootPath: string): string {
  if (!rootPath) return '';
  for (const rel of ['CLAUDE.md', 'claude.md', '.claude/CLAUDE.md']) {
    const full = path.join(rootPath, rel);
    if (!fs.existsSync(full)) continue;
    try {
      const raw = fs.readFileSync(full, 'utf-8');
      // Strip @-file directives (e.g. @_skills/...) — they cause cascading reads that bloat context
      const stripped = raw
        .split('\n')
        .filter(l => !l.trim().startsWith('@'))
        .join('\n')
        .slice(0, 3000);
      return stripped;
    } catch { /* skip */ }
  }
  return '';
}

/** List all service/module directories in the project (when no CLAUDE.md exists) */
function listServiceTree(rootPath: string): string {
  if (!rootPath || !fs.existsSync(rootPath)) return '';
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__', '.venv', 'vendor', 'bin', 'obj']);
  const lines: string[] = [];
  try {
    const top = fs.readdirSync(rootPath, { withFileTypes: true })
      .filter(e => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'));
    for (const entry of top) {
      const subPath = path.join(rootPath, entry.name);
      if (hasProjectFile(subPath)) {
        lines.push(`  ${entry.name}/`);
      } else {
        // Group dir (back-end/, shared/, etc.) — list its children
        try {
          const children = fs.readdirSync(subPath, { withFileTypes: true })
            .filter(e => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'));
          const svcChildren = children.filter(c => hasProjectFile(path.join(subPath, c.name)));
          if (svcChildren.length > 0) {
            lines.push(`${entry.name}/`);
            svcChildren.forEach(c => lines.push(`  ${c.name}/`));
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* ignore */ }
  return lines.join('\n');
}

/** Check if a directory is a recognizable project (has a project file) */
function hasProjectFile(dirPath: string): boolean {
  try {
    const files = fs.readdirSync(dirPath);
    return files.some(f =>
      f.endsWith('.csproj') || f.endsWith('.fsproj') ||
      f === 'package.json' || f === 'nest-cli.json' ||
      f === 'go.mod' || f === 'pom.xml' || f === 'Cargo.toml' ||
      f === 'pyproject.toml' || f === 'setup.py'
    );
  } catch { return false; }
}

function scanRepos(rootPath: string): RepoInfo[] {
  try {
    if (!fs.existsSync(rootPath)) return [];
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    const repos: RepoInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(rootPath, entry.name);
      const gitDir = path.join(fullPath, '.git');
      const hasGit = fs.existsSync(gitDir);
      let branch: string | null = null;
      let lastCommit: string | null = null;
      let lastModified = new Date().toISOString();
      try { lastModified = fs.statSync(fullPath).mtime.toISOString(); } catch { /* ignore */ }
      if (hasGit) {
        try {
          const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
          branch = head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : head.slice(0, 7);
        } catch { /* ignore */ }
        try {
          lastCommit = fs.readFileSync(path.join(gitDir, 'COMMIT_EDITMSG'), 'utf-8').trim().split('\n')[0].slice(0, 80);
        } catch { /* ignore */ }
      }
      repos.push({ id: entry.name, name: entry.name, path: fullPath, lastModified, branch, lastCommit });

      // For monorepos: scan well-known sub-group dirs for individual services
      if (hasGit) {
        const SUB_GROUPS = ['back-end', 'front-end', 'shared', 'src', 'packages', 'apps', 'services', 'modules', 'libs'];
        for (const group of SUB_GROUPS) {
          const groupPath = path.join(fullPath, group);
          if (!fs.existsSync(groupPath)) continue;
          try {
            const svcs = fs.readdirSync(groupPath, { withFileTypes: true })
              .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');
            for (const svc of svcs) {
              const svcPath = path.join(groupPath, svc.name);
              if (!hasProjectFile(svcPath)) continue;
              repos.push({
                id: `${entry.name}/${group}/${svc.name}`,
                name: `${group}/${svc.name}`,
                path: svcPath,
                lastModified,
                branch,
                lastCommit,
              });
            }
          } catch { /* ignore */ }
        }
      }
    }
    return repos.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
  } catch { return []; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOk(res: any, data: unknown) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.statusCode = 200;
  res.end(JSON.stringify(data));
}

/** Read the Claude Code OAuth access token from the local credentials file. */
function readClaudeOauthToken(): string | null {
  try {
    const p = path.join(os.homedir(), '.claude', '.credentials.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, any>;
    const o = (d.claudeAiOauth ?? d) as Record<string, any>;
    return typeof o.accessToken === 'string' ? o.accessToken : null;
  } catch { return null; }
}

const DEFAULT_ROOT = 'C:\\Users\\Admin\\source\\repos';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'local-api',
      configureServer(server) {
        server.middlewares.use('/api/health', (_req: unknown, res: unknown) => {
          jsonOk(res, { ok: true, hasApiKey: false, reposRoot: DEFAULT_ROOT });
        });

        const proxySettingsFile = path.join(process.cwd(), '.agent-proxy.json');

        server.middlewares.use('/api/settings/proxy', async (req: any, res: any) => {
          const method = (req.method as string).toUpperCase();
          if (method === 'GET') {
            try {
              if (fs.existsSync(proxySettingsFile)) {
                const data = JSON.parse(fs.readFileSync(proxySettingsFile, 'utf-8'));
                jsonOk(res, data);
              } else {
                jsonOk(res, { proxyEnabled: false, proxyUrl: 'http://proxy.hcm.fpt.vn:80' });
              }
            } catch {
              jsonOk(res, { proxyEnabled: false, proxyUrl: 'http://proxy.hcm.fpt.vn:80' });
            }
          } else if (method === 'POST') {
            try {
              const body = await readBody(req);
              const data = JSON.parse(body);
              fs.writeFileSync(proxySettingsFile, JSON.stringify(data, null, 2), 'utf-8');
              jsonOk(res, { ok: true, ...data });
            } catch (e) {
              if (!res.headersSent) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: String(e) })); }
            }
          }
        });

        server.middlewares.use('/api/files', (req: unknown, res: unknown) => {
          const r = req as { url?: string };
          const qs = (r.url ?? '').split('?')[1] ?? '';
          const p = new URLSearchParams(qs).get('path') ?? '';
          jsonOk(res, { files: p ? scanFiles(p, p, 4) : [] });
        });

        server.middlewares.use('/api/dirs', (req: unknown, res: unknown) => {
          const r = req as { url?: string };
          const qs = (r.url ?? '').split('?')[1] ?? '';
          const rootPath = new URLSearchParams(qs).get('path') ?? '';
          if (!rootPath || !fs.existsSync(rootPath)) { jsonOk(res, { dirs: [] }); return; }
          const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '__pycache__', '.venv', 'vendor', 'bin', 'obj']);
          function listDirs(dirPath: string, depth: number): { name: string; rel: string; children: { name: string; rel: string }[] }[] {
            if (!fs.existsSync(dirPath)) return [];
            try {
              return fs.readdirSync(dirPath, { withFileTypes: true })
                .filter(e => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'))
                .slice(0, 30)
                .map(e => {
                  const full = path.join(dirPath, e.name);
                  const rel = path.relative(rootPath, full).replace(/\\/g, '/');
                  const children = depth === 0 ? listDirs(full, 1).map(c => ({ name: c.name, rel: c.rel })) : [];
                  return { name: e.name, rel, children };
                });
            } catch { return []; }
          }
          jsonOk(res, { dirs: listDirs(rootPath, 0) });
        });

        server.middlewares.use('/api/repos', (req: unknown, res: unknown) => {
          const r = req as { url?: string };
          const qs = (r.url ?? '').split('?')[1] ?? '';
          const root = new URLSearchParams(qs).get('root') ?? DEFAULT_ROOT;
          jsonOk(res, { repos: scanRepos(root), root });
        });

        // ── App data (tasks, projects) — stored in JSON files on disk ────────
        const tasksFilePath = path.join(process.cwd(), 'agent-tasks.json');
        const projectsFilePath = path.join(process.cwd(), 'agent-projects.json');

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/data/tasks', (req: any, res: any) => {
          const method = (req.method as string).toUpperCase();
          if (method === 'GET') {
            try {
              const data = fs.existsSync(tasksFilePath) ? JSON.parse(fs.readFileSync(tasksFilePath, 'utf-8')) : null;
              jsonOk(res, { ok: true, data });
            } catch { jsonOk(res, { ok: true, data: null }); }
            return;
          }
          if (method === 'POST') {
            readBody(req).then(raw => {
              try {
                const { data } = JSON.parse(raw || '{}') as { data: unknown };
                fs.writeFileSync(tasksFilePath, JSON.stringify(data, null, 2), 'utf-8');
                jsonOk(res, { ok: true });
              } catch { jsonOk(res, { ok: false }); }
            });
            return;
          }
          res.statusCode = 405; res.end();
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/data/projects', (req: any, res: any) => {
          const method = (req.method as string).toUpperCase();
          if (method === 'GET') {
            try {
              const data = fs.existsSync(projectsFilePath) ? JSON.parse(fs.readFileSync(projectsFilePath, 'utf-8')) : null;
              jsonOk(res, { ok: true, data });
            } catch { jsonOk(res, { ok: true, data: null }); }
            return;
          }
          if (method === 'POST') {
            readBody(req).then(raw => {
              try {
                const { data } = JSON.parse(raw || '{}') as { data: unknown };
                fs.writeFileSync(projectsFilePath, JSON.stringify(data, null, 2), 'utf-8');
                jsonOk(res, { ok: true });
              } catch { jsonOk(res, { ok: false }); }
            });
            return;
          }
          res.statusCode = 405; res.end();
        });

        // ── Jira Import — config + REST API proxy ────────────────────────────
        const jiraConfigPath = path.join(process.cwd(), 'agent-jira-config.json');

        interface JiraImportConfig {
          projectKey: string;
          sprint: string;
          assignee: string;
          issueTypes: string[];
          statusFilter: string[];
          customJql: string;
          maxResults: number;
          statusMap: Record<string, string>;
          priorityMap: Record<string, string>;
          labelMap: Record<string, string>;
          defaultStatus: string;
          defaultPriority: string;
          defaultLabel: string;
          defaultModel: string;
          syncToProjectId?: string;
        }

        function readJiraConfig(): JiraImportConfig {
          const defaults: JiraImportConfig = {
            projectKey: '', sprint: 'current', assignee: 'all',
            issueTypes: [], statusFilter: [], customJql: '', maxResults: 50,
            statusMap: {
              'To Do': 'backlog', 'In Progress': 'in_progress',
              'In Review': 'in_progress', 'Code Review': 'in_progress',
              'Done': 'done', 'Closed': 'done', 'Resolved': 'done',
              'Blocked': 'paused', 'On Hold': 'paused',
              'Cancelled': 'failed', 'Won\'t Do': 'failed',
            },
            priorityMap: {
              'Highest': 'critical', 'Critical': 'critical',
              'High': 'high', 'Medium': 'medium',
              'Low': 'low', 'Lowest': 'low',
            },
            labelMap: {
              'Story': 'feature', 'Feature': 'feature',
              'Bug': 'bugfix', 'Defect': 'bugfix',
              'Task': 'task', 'Chore': 'chore',
              'Epic': 'feature', 'Sub-task': 'task',
              'Improvement': 'refactor', 'Technical Debt': 'refactor',
              'Documentation': 'docs', 'Test': 'test',
            },
            defaultStatus: 'backlog', defaultPriority: 'medium',
            defaultLabel: 'task', defaultModel: 'claude-sonnet-4-6',
          };
          try {
            if (fs.existsSync(jiraConfigPath)) {
              const saved = JSON.parse(fs.readFileSync(jiraConfigPath, 'utf-8')) as Partial<JiraImportConfig>;
              return { ...defaults, ...saved };
            }
          } catch { /* ignore */ }
          return defaults;
        }

        function getJiraCreds(): { url: string; email: string; token: string } | null {
          const servers = readMcpServers() as Record<string, { env?: Record<string, string> }>;
          const jira = Object.values(servers).find(s => s?.env?.JIRA_URL);
          if (!jira?.env) return null;
          const url = jira.env.JIRA_URL?.replace(/\/$/, '') ?? '';
          const email = jira.env.JIRA_USERNAME ?? '';
          const token = jira.env.JIRA_API_TOKEN ?? '';
          if (!url || !email || !token) return null;
          return { url, email, token };
        }

        async function jiraFetch(path2: string, creds: { url: string; email: string; token: string }): Promise<unknown> {
          const { default: https } = await import('node:https');
          const { default: http } = await import('node:http');
          const { HttpProxyAgent } = await import('http-proxy-agent');
          const { HttpsProxyAgent } = await import('https-proxy-agent');
          const fullUrl = `${creds.url}${path2}`;
          const auth = Buffer.from(`${creds.email}:${creds.token}`).toString('base64');

          // Get proxy settings if enabled
          let proxyUrl: string | null = null;
          try {
            if (fs.existsSync(proxySettingsFile)) {
              const proxySettings = JSON.parse(fs.readFileSync(proxySettingsFile, 'utf-8')) as { proxyEnabled?: boolean; proxyUrl?: string };
              if (proxySettings.proxyEnabled && proxySettings.proxyUrl) {
                proxyUrl = proxySettings.proxyUrl;
                console.log(`[jiraFetch] Using proxy: ${proxyUrl}`);
              } else {
                console.log('[jiraFetch] Proxy disabled');
              }
            }
          } catch (e) {
            console.error('[jiraFetch] Error reading proxy settings:', e);
          }

          console.log(`[jiraFetch] GET ${fullUrl}`);
          return new Promise((resolve, reject) => {
            const lib = fullUrl.startsWith('https') ? https : http;
            const requestOpts: any = {
              method: 'GET',
              headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
            };

            // Add proxy agent if enabled
            if (proxyUrl) {
              if (fullUrl.startsWith('https')) {
                requestOpts.agent = new HttpsProxyAgent(proxyUrl);
              } else {
                requestOpts.agent = new HttpProxyAgent(proxyUrl);
              }
            }

            const req = lib.request(fullUrl, requestOpts, res2 => {
              console.log(`[jiraFetch] Response status: ${res2.statusCode}`);
              let body = '';
              res2.on('data', (c: Buffer) => { body += c.toString(); });
              res2.on('end', () => {
                try { resolve(JSON.parse(body)); } catch { resolve(body); }
              });
            });
            req.on('error', (err) => {
              console.error(`[jiraFetch] Request error:`, err.message);
              reject(err);
            });
            req.end();
          });
        }

        // Download a Jira attachment (binary) following the authenticated content URL.
        // `absUrl` is an absolute URL (attachment.content). Follows up to a few redirects.
        async function jiraFetchBinary(absUrl: string, creds: { url: string; email: string; token: string }, redirects = 5): Promise<Buffer> {
          const { default: https } = await import('node:https');
          const { default: http } = await import('node:http');
          const { HttpProxyAgent } = await import('http-proxy-agent');
          const { HttpsProxyAgent } = await import('https-proxy-agent');
          const auth = Buffer.from(`${creds.email}:${creds.token}`).toString('base64');

          let proxyUrl: string | null = null;
          try {
            if (fs.existsSync(proxySettingsFile)) {
              const proxySettings = JSON.parse(fs.readFileSync(proxySettingsFile, 'utf-8')) as { proxyEnabled?: boolean; proxyUrl?: string };
              if (proxySettings.proxyEnabled && proxySettings.proxyUrl) proxyUrl = proxySettings.proxyUrl;
            }
          } catch { /* ignore */ }

          return new Promise((resolve, reject) => {
            const lib = absUrl.startsWith('https') ? https : http;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const requestOpts: any = { method: 'GET', headers: { 'Authorization': `Basic ${auth}` } };
            if (proxyUrl) requestOpts.agent = absUrl.startsWith('https') ? new HttpsProxyAgent(proxyUrl) : new HttpProxyAgent(proxyUrl);
            const req = lib.request(absUrl, requestOpts, res2 => {
              const status = res2.statusCode ?? 0;
              // Follow redirects (Jira attachment content often 302s to a signed URL)
              if (status >= 300 && status < 400 && res2.headers.location && redirects > 0) {
                res2.resume();
                const next = new URL(res2.headers.location, absUrl).toString();
                jiraFetchBinary(next, creds, redirects - 1).then(resolve, reject);
                return;
              }
              if (status >= 400) { reject(new Error(`HTTP ${status} for ${absUrl}`)); res2.resume(); return; }
              const chunks: Buffer[] = [];
              res2.on('data', (c: Buffer) => chunks.push(c));
              res2.on('end', () => resolve(Buffer.concat(chunks)));
            });
            req.on('error', reject);
            req.end();
          });
        }

        // Flatten Jira's Atlassian Document Format (ADF) into plain text/markdown.
        // API v3 returns `description` as a nested JSON doc, not a string.
        function adfToText(node: unknown): string {
          if (node == null) return '';
          if (typeof node === 'string') return node;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const n = node as any;
          switch (n.type) {
            case 'text':
              return typeof n.text === 'string' ? n.text : '';
            case 'hardBreak':
              return '\n';
            case 'paragraph':
            case 'heading':
              return (n.content ?? []).map(adfToText).join('') + '\n\n';
            case 'listItem':
              return '- ' + (n.content ?? []).map(adfToText).join('').trim() + '\n';
            case 'codeBlock':
              return '```\n' + (n.content ?? []).map(adfToText).join('') + '\n```\n\n';
            case 'media':
            case 'mediaInline': {
              // Inline image/file in description. attrs.id = attachment id; replaced later with local path.
              const id = n.attrs?.id ?? '';
              const alt = n.attrs?.alt ?? id;
              return id ? `![${alt}](jira-media:${id})\n` : '';
            }
            default:
              return (n.content ?? []).map(adfToText).join('');
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/jira/config', (req: any, res: any) => {
          const method = (req.method as string).toUpperCase();
          if (method === 'GET') {
            jsonOk(res, { ok: true, config: readJiraConfig() });
            return;
          }
          if (method === 'POST') {
            readBody(req).then(raw => {
              try {
                const updates = JSON.parse(raw || '{}') as Partial<JiraImportConfig>;
                const current = readJiraConfig();
                const merged = { ...current, ...updates };
                fs.writeFileSync(jiraConfigPath, JSON.stringify(merged, null, 2), 'utf-8');
                jsonOk(res, { ok: true, config: merged });
              } catch { jsonOk(res, { ok: false }); }
            });
            return;
          }
          res.statusCode = 405; res.end();
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/jira/projects', async (req: any, res: any) => {
          const creds = getJiraCreds();
          if (!creds) { jsonOk(res, { ok: false, error: 'Jira not configured — add Jira MCP server first' }); return; }
          try {
            const data = await jiraFetch('/rest/api/3/project?maxResults=100', creds) as { key: string; name: string; id: string }[];
            const projects = Array.isArray(data) ? data.map(p => ({ key: p.key, name: p.name, id: p.id })) : [];
            jsonOk(res, { ok: true, projects });
          } catch (e) { jsonOk(res, { ok: false, error: String(e) }); }
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/jira/sprints', async (req: any, res: any) => {
          const creds = getJiraCreds();
          if (!creds) { jsonOk(res, { ok: false, error: 'Jira not configured' }); return; }
          const qs = ((req.url as string) ?? '').split('?')[1] ?? '';
          const projectKey = new URLSearchParams(qs).get('projectKey') ?? '';
          if (!projectKey) { jsonOk(res, { ok: true, sprints: [] }); return; }
          try {
            // Get boards for project, then get sprints from first board
            const boards = await jiraFetch(`/rest/agile/1.0/board?projectKeyOrId=${projectKey}&maxResults=1`, creds) as { values?: { id: number; name: string }[] };
            const boardId = boards?.values?.[0]?.id;
            if (!boardId) { jsonOk(res, { ok: true, sprints: [] }); return; }
            const sprints = await jiraFetch(`/rest/agile/1.0/board/${boardId}/sprint?state=active,future&maxResults=20`, creds) as { values?: { id: number; name: string; state: string }[] };
            jsonOk(res, { ok: true, sprints: sprints?.values ?? [] });
          } catch (e) { jsonOk(res, { ok: false, error: String(e) }); }
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/jira/statuses', async (req: any, res: any) => {
          const creds = getJiraCreds();
          if (!creds) { jsonOk(res, { ok: false, error: 'Jira not configured' }); return; }
          const qs = ((req.url as string) ?? '').split('?')[1] ?? '';
          const projectKey = new URLSearchParams(qs).get('projectKey') ?? '';
          try {
            const endpoint = projectKey
              ? `/rest/api/3/project/${projectKey}/statuses`
              : '/rest/api/3/status';
            const data = await jiraFetch(endpoint, creds);
            let statuses: string[] = [];
            if (Array.isArray(data)) {
              // project statuses: [{statuses: [{name}]}] or [{name}]
              const seenLower = new Set<string>();
              function addStatus(name: string) { const k = name.toLowerCase(); if (!seenLower.has(k)) { seenLower.add(k); statuses.push(name); } }
              if (data[0]?.statuses) {
                (data as { statuses: { name: string }[] }[]).forEach(g => g.statuses.forEach(s => addStatus(s.name)));
              } else {
                (data as { name: string }[]).forEach(s => addStatus(s.name));
              }
            }
            jsonOk(res, { ok: true, statuses });
          } catch (e) { jsonOk(res, { ok: false, error: String(e) }); }
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/jira/preview', async (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          const creds = getJiraCreds();
          if (!creds) { jsonOk(res, { ok: false, error: 'Jira not configured' }); return; }
          readBody(req).then(async raw => {
            try {
              const cfg = JSON.parse(raw || '{}') as JiraImportConfig;
              let jql = cfg.customJql?.trim();
              if (!jql) {
                const parts: string[] = [];
                if (cfg.projectKey) parts.push(`project = "${cfg.projectKey}"`);
                if (cfg.issueTypes?.length) parts.push(`issuetype in (${cfg.issueTypes.map(t => `"${t}"`).join(',')})`);
                if (cfg.sprint === 'current') parts.push('sprint in openSprints()');
                else if (cfg.sprint && cfg.sprint !== 'all') parts.push(`sprint = "${cfg.sprint}"`);
                if (cfg.assignee === 'me') parts.push('assignee = currentUser()');
                else if (cfg.assignee && cfg.assignee !== 'all') parts.push(`assignee = "${cfg.assignee}"`);
                jql = parts.length ? parts.join(' AND ') : 'ORDER BY updated DESC';
              }
              const max = Math.min(cfg.maxResults || 50, 100);
              const url = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${max}&fields=summary,status,priority,issuetype,assignee,description,attachment`;
              const data = await jiraFetch(url, creds) as { issues?: unknown[]; total?: number; errorMessages?: string[] };
              if (data.errorMessages?.length) { jsonOk(res, { ok: false, error: data.errorMessages.join('; ') }); return; }
              const issues = (data.issues ?? []) as {
                key: string;
                fields: {
                  summary: string;
                  status: { name: string };
                  priority: { name: string } | null;
                  issuetype: { name: string };
                  assignee: { displayName: string } | null;
                  description: unknown;
                  attachment?: { id: string; filename: string; mimeType: string; content: string; thumbnail?: string; size?: number }[];
                };
              }[];
              let preview = issues.map(i => ({
                key: i.fields ? i.key : '',
                title: i.fields?.summary ?? '',
                type: i.fields?.issuetype?.name ?? '',
                jiraStatus: i.fields?.status?.name ?? '',
                jiraPriority: i.fields?.priority?.name ?? '',
                description: adfToText(i.fields?.description),
                assignee: i.fields?.assignee?.displayName ?? '',
                attachments: (i.fields?.attachment ?? []).map(a => ({
                  id: a.id, filename: a.filename, mimeType: a.mimeType, content: a.content, thumbnail: a.thumbnail, size: a.size,
                })),
                mappedStatus: cfg.statusMap?.[i.fields?.status?.name] ?? cfg.defaultStatus ?? 'backlog',
                mappedPriority: cfg.priorityMap?.[i.fields?.priority?.name ?? ''] ?? cfg.defaultPriority ?? 'medium',
                mappedLabel: cfg.labelMap?.[i.fields?.issuetype?.name] ?? cfg.defaultLabel ?? 'task',
              }));
              if (cfg.statusFilter?.length) {
                const allowed = new Set(cfg.statusFilter);
                preview = preview.filter(p => allowed.has(p.jiraStatus));
              }
              // Skip issues already imported as tasks (dedup by Jira key, global — đã có thì không lấy nữa)
              const existingTasks = fs.existsSync(tasksFilePath)
                ? JSON.parse(fs.readFileSync(tasksFilePath, 'utf-8')) as Record<string, unknown>
                : {};
              const beforeDedup = preview.length;
              preview = preview.filter(p => !existingTasks[`task-jira-${p.key}`]);
              const skipped = beforeDedup - preview.length;
              jsonOk(res, { ok: true, preview, total: data.total ?? preview.length, skipped, jql });
            } catch (e) { jsonOk(res, { ok: false, error: String(e) }); }
          });
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/jira/import', async (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          const creds = getJiraCreds();
          if (!creds) { jsonOk(res, { ok: false, error: 'Jira not configured' }); return; }
          readBody(req).then(async raw => {
            try {
              const { cfg, issues, targetProjectId: rawTargetIdParam } = JSON.parse(raw || '{}') as {
                cfg: JiraImportConfig;
                targetProjectId?: string;
                issues: {
                  key: string; title: string; type: string; jiraStatus: string; jiraPriority: string;
                  description?: string;
                  assignee: string; mappedStatus: string; mappedPriority: string; mappedLabel: string;
                  attachments?: { id: string; filename: string; mimeType: string; content: string; thumbnail?: string; size?: number }[];
                }[];
              };
              const now = new Date().toISOString();
              const assetsRoot = path.join(process.cwd(), 'agent-jira-assets');

              const projsRaw = fs.existsSync(projectsFilePath)
                ? JSON.parse(fs.readFileSync(projectsFilePath, 'utf-8')) as Record<string, unknown>
                : {};

              // Use mapped project: prefer explicit param, fall back to saved cfg.syncToProjectId
              const rawTargetId = rawTargetIdParam ?? cfg.syncToProjectId;
              const useRealProject = !!rawTargetId && rawTargetId !== '__jira__' && !!projsRaw[rawTargetId];
              const actualProjectId = useRealProject ? rawTargetId! : 'proj-jira';
              if (!projsRaw[actualProjectId]) {
                projsRaw[actualProjectId] = {
                  id: actualProjectId, name: 'jira', repoPath: '__jira__',
                  description: 'Imported from Jira', branch: null, lastCommit: null,
                  lastModified: now, color: '#0052CC', taskIds: [], createdAt: now,
                };
              }
              const targetProj = projsRaw[actualProjectId] as { taskIds: string[] };
              if (!targetProj.taskIds) targetProj.taskIds = [];

              // Read current tasks file — skip keys that already exist (đã có thì không lấy nữa)
              const tasksRaw = fs.existsSync(tasksFilePath) ? JSON.parse(fs.readFileSync(tasksFilePath, 'utf-8')) as Record<string, unknown> : {};
              const created: string[] = [];
              const skipped: string[] = [];
              for (const issue of issues) {
                const id = `task-jira-${issue.key}`;
                if (tasksRaw[id]) { skipped.push(id); continue; }

                // ── Download image attachments to agent-jira-assets/<KEY>/ ──────
                const savedAttachments: { filename: string; mimeType: string; localPath: string; url?: string }[] = [];
                // Inline media (jira-media:<id>) and the Attachments list use ABSOLUTE paths so the
                // running agent — whose cwd is the target repo, not this app — can open them with Read.
                const idToAbsPath = new Map<string, string>();
                const absList: { filename: string; absPath: string }[] = [];
                const imgAtts = (issue.attachments ?? []).filter(a => (a.mimeType ?? '').startsWith('image/'));
                if (imgAtts.length) {
                  const issueDir = path.join(assetsRoot, issue.key);
                  try { fs.mkdirSync(issueDir, { recursive: true }); } catch { /* ignore */ }
                  const usedNames = new Set<string>();
                  for (const a of imgAtts) {
                    try {
                      let safeName = (a.filename || `${a.id}`).replace(/[/\\]/g, '_').replace(/[^\w.\-]/g, '_');
                      if (usedNames.has(safeName)) safeName = `${a.id}-${safeName}`;
                      usedNames.add(safeName);
                      const absPath = path.join(issueDir, safeName);
                      const buf = await jiraFetchBinary(a.content, creds);
                      fs.writeFileSync(absPath, buf);
                      savedAttachments.push({ filename: a.filename, mimeType: a.mimeType, localPath: `agent-jira-assets/${issue.key}/${safeName}`, url: a.content });
                      idToAbsPath.set(a.id, absPath);
                      absList.push({ filename: a.filename, absPath });
                    } catch (err) {
                      console.error(`[/api/jira/import] attachment download failed (${issue.key}/${a.filename}):`, err);
                    }
                  }
                }

                // Replace inline media placeholders (jira-media:<id>) with the downloaded absolute path
                const desc = (issue.description?.trim() || '(No description in Jira)')
                  .replace(/jira-media:([\w-]+)/g, (m, mid: string) => idToAbsPath.get(mid) ?? m);
                const attachmentSection = absList.length
                  ? '\n\n## Attachments (screenshots — open with the Read tool to view)\n'
                    + absList.map(a => `- ${a.filename}: ${a.absPath}`).join('\n')
                  : '';

                tasksRaw[id] = {
                  id, title: `[${issue.key}] ${issue.title}`,
                  description: [
                    desc,
                    attachmentSection,
                    '',
                    '---',
                    `Imported from Jira: ${issue.key} · Type: ${issue.type} · Assignee: ${issue.assignee || 'Unassigned'}`,
                  ].join('\n'),
                  status: issue.mappedStatus, priority: issue.mappedPriority,
                  label: issue.mappedLabel,
                  parentId: null, subtaskIds: [], tags: ['jira', issue.key],
                  attachments: savedAttachments,
                  agentConfig: { model: cfg.defaultModel || 'claude-sonnet-4-6', schedule: null, tools: [] },
                  terminal: { isRunning: false, isPaused: false, logs: [], tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, elapsedMs: 0, cost: 0 },
                  progress: 0, projectId: actualProjectId, branchName: null, reviewPending: false,
                  successCriteria: [], validationResults: [],
                  createdAt: now, updatedAt: now,
                };
                if (!targetProj.taskIds.includes(id)) targetProj.taskIds.push(id);
                created.push(id);
              }
              fs.writeFileSync(tasksFilePath, JSON.stringify(tasksRaw, null, 2), 'utf-8');
              fs.writeFileSync(projectsFilePath, JSON.stringify(projsRaw, null, 2), 'utf-8');
              jsonOk(res, { ok: true, created: created.length, ids: created, skipped: skipped.length });
            } catch (e) { jsonOk(res, { ok: false, error: String(e) }); }
          });
        });

        // ── Serve local attachments (Jira-synced + user uploads) for the UI ──
        const ASSET_MIME: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
          '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
          '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
          '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.ogg': 'video/ogg',
        };
        const ASSET_ROOTS = ['agent-jira-assets', 'agent-uploads'];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const serveAsset = (req: any, res: any) => {
          try {
            const q = (new URL(req.url as string, 'http://localhost').searchParams.get('path') ?? '').replace(/\\/g, '/');
            // Must live under one of the whitelisted roots; resolve under cwd and reject traversal
            const root = ASSET_ROOTS.find(r => q === r || q.startsWith(r + '/'));
            const full = path.resolve(process.cwd(), q);
            if (!root || !full.startsWith(path.join(process.cwd(), root) + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
              res.statusCode = 404; res.end('Not found'); return;
            }
            res.setHeader('Content-Type', ASSET_MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream');
            res.setHeader('Cache-Control', 'max-age=86400');
            res.statusCode = 200;
            res.end(fs.readFileSync(full));
          } catch { res.statusCode = 500; res.end('error'); }
        };
        server.middlewares.use('/api/asset', serveAsset);
        server.middlewares.use('/api/jira-asset', serveAsset); // legacy alias

        // ── Upload a task attachment (image/video) → agent-uploads/<bucket>/ ──
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/upload-attachment', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          const u = new URL(req.url as string, 'http://localhost');
          const bucket = (u.searchParams.get('bucket') ?? 'misc').replace(/[^\w.\-]/g, '_').slice(0, 80) || 'misc';
          const mimeType = u.searchParams.get('mime') ?? 'application/octet-stream';
          const rawName = u.searchParams.get('filename') ?? 'file';
          readBodyBuffer(req).then(buf => {
            try {
              if (!buf.length) { jsonOk(res, { ok: false, error: 'Empty upload' }); return; }
              const dir = path.join(process.cwd(), 'agent-uploads', bucket);
              fs.mkdirSync(dir, { recursive: true });
              let safeName = rawName.replace(/[/\\]/g, '_').replace(/[^\w.\-]/g, '_') || 'file';
              if (fs.existsSync(path.join(dir, safeName))) safeName = `${Date.now()}-${safeName}`;
              const absPath = path.join(dir, safeName);
              fs.writeFileSync(absPath, buf);
              jsonOk(res, { ok: true, filename: rawName, mimeType, localPath: `agent-uploads/${bucket}/${safeName}`, absPath });
            } catch (e) { jsonOk(res, { ok: false, error: String(e) }); }
          });
        });

        // ── Analyze task with real claude ────────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/analyze-task', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          readBody(req).then(raw => {
            const { title = '', description = '', repoPath = '', projectName = '' } = JSON.parse(raw || '{}') as Record<string, string>;

            // Lightweight scan — just enough for architecture analysis (depth 2, 25 files, 2 key files × 800 chars)
            const files = repoPath ? scanFiles(repoPath, repoPath, 2) : [];
            const fileList = files.slice(0, 25).join('\n');
            const keyContent = repoPath ? readKeyFiles(repoPath, 2, 800) : '';

            const prompt = [
              `You are a senior software architect. Analyze this development task for the "${projectName || 'project'}" codebase.`,
              '',
              repoPath ? `Project path: ${repoPath}` : '',
              '',
              fileList ? `## File Structure (top-level)\n${fileList}` : '',
              keyContent ? `\n## Key Files${keyContent}` : '',
              '',
              '## Task to Break Down',
              `Title: ${title}`,
              description ? `Description: ${description}` : '',
              '',
              'Think step by step:',
              '1. Study the file structure and key files to understand the architecture',
              '2. Identify which layers/services/modules need to change',
              '3. Determine the correct implementation order (dependencies first)',
              '',
              'Rules for subtasks:',
              '- Each title MUST name the exact file/module/service it touches (e.g. "Add UserService in src/user/user.service.ts")',
              '- Each description must specify: what to create/change, key types/interfaces/methods, expected behavior',
              '- Order by dependency: implement base/data layers before API layers, API before UI',
              '- Use claude-opus-4-7 for architecture design, claude-sonnet-4-6 for feature implementation, claude-haiku-4-5 for simple changes',
              '',
              'Output ONLY a JSON array — no markdown fences, no explanation:',
              '[{"title":"...","description":"...","priority":"high"|"medium"|"low","model":"claude-sonnet-4-6"|"claude-haiku-4-5"|"claude-opus-4-7"}]',
              'Generate 3-7 subtasks.',
            ].filter(Boolean).join('\n');

            // Use sync claude call for analysis (short timeout)
            const claudeCmd = resolveClaudePath();
            const r = spawnSync(claudeCmd, [
              '--dangerously-skip-permissions',
              '--output-format', 'json',
            ], {
              input: prompt,
              cwd: repoPath || process.cwd(),
              env: { ...process.env },
              shell: true,
              encoding: 'utf-8',
              timeout: 120_000,
            });

            if (r.status !== 0 || !r.stdout) {
              jsonOk(res, { ok: false, error: (r.stderr ?? '').toString().trim() || 'claude failed' });
              return;
            }

            // Extract JSON from claude's output
            const out = r.stdout.toString();
            let subtasks: unknown[] = [];
            try {
              // claude --output-format json wraps in {"result":"..."}
              const wrapper = JSON.parse(out) as { result?: string };
              const inner = wrapper.result ?? out;
              const match = inner.match(/\[[\s\S]*\]/);
              if (match) subtasks = JSON.parse(match[0]) as unknown[];
            } catch { /* fallback to empty */ }

            jsonOk(res, { ok: true, subtasks });
          });
        });

        // ── Analyze task as a real streaming agent ───────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/analyze-stream', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          readBody(req).then(raw => {
            const { title = '', description = '', repoPath = '', projectName = '', service = '' } = JSON.parse(raw || '{}') as Record<string, string>;

            const runId = `analyze-${Date.now()}`;
            const state: RunState = { proc: null, buffer: [], done: false, clients: [], accText: '' };
            runs.set(runId, state);
            jsonOk(res, { runId, ok: true });

            void (async () => {
              const claudeCmd = resolveClaudePath();
              const effectivePath = repoPath || process.cwd();
              const claudeMd = readClaudeMd(effectivePath);
              const serviceTree = !claudeMd ? listServiceTree(effectivePath) : '';

              const scopeHint = service
                ? `Focus ONLY on the "${service}" service/module directory.`
                : 'Focus on the directories directly relevant to this task.';

              const prompt = [
                `You are a senior software architect. Your job is to read the codebase ONCE, identify exactly which files need to change, then output a concise file-level implementation checklist. Do NOT over-scan.`,
                '',
                `Working directory: ${effectivePath}`,
                `Project: ${projectName || path.basename(effectivePath)}`,
                service ? `Target service/component: ${service}` : '',
                '',
                claudeMd ? `## Project Instructions (CLAUDE.md)\n${claudeMd}` : '',
                serviceTree ? `## Project Structure\n${serviceTree}` : '',
                '',
                '## Task',
                `Title: ${title}`,
                description ? `Description: ${description}` : '',
                '',
                '## Analysis Steps (follow strictly — minimize file reads)',
                claudeMd
                  ? `1. Read CLAUDE.md above as your architecture reference (already loaded).`
                  : `1. Read package.json and the main entry point to understand the stack.`,
                `2. ${scopeHint} Use Glob on at most 1-2 directories to list files. Do NOT scan the whole project.`,
                `3. Read 2-4 files maximum: the existing service/module this task touches, plus any type/interface file it depends on. Read only what you need to know exact file paths and method signatures.`,
                `4. Identify every file that must be created or modified. Order them by dependency (types → data layer → service → controller/API → module registration).`,
                `5. Output the JSON array below.`,
                '',
                '## Output Format',
                'Output ONLY a valid JSON array — no markdown fences, no explanation outside the array:',
                '[',
                '  {',
                '    "title": "Sửa `exact/path/file.ts` — one-line description of what changes",',
                '    "description": "File: `exact/path/file.ts`\\n\\nChanges:\\n- Add/modify X: <concrete detail>\\n- Add/modify Y: <concrete detail>\\n\\nKey types/methods: list class names, method signatures, interfaces to use.\\n\\nDone when: one-line acceptance criterion.",',
                '    "priority": "critical|high|medium|low"',
                '  }',
                ']',
                '',
                'Rules:',
                '- Each subtask = exactly ONE file (create or modify). Split into separate subtasks if multiple files change.',
                '- Title format: "Sửa `path/to/file.ts` — what changes" or "Tạo `path/to/file.ts` — what it does".',
                '- Description must list concrete code changes (method names, types, logic) so the implementer never needs to re-read the project.',
                '- NO analysis subtasks, NO "research" subtasks, NO "testing" subtasks — only file implementation steps.',
                '- Order by dependency: types first, then data/repo, then service, then controller, then module.',
                '- Generate 3-6 subtasks maximum.',
              ].filter(Boolean).join('\n');

              const tmpPrompt = path.join(os.tmpdir(), `${runId}.txt`);
              fs.writeFileSync(tmpPrompt, prompt, 'utf-8');
              const stdinFd = fs.openSync(tmpPrompt, 'r');
              const proc = spawn(claudeCmd, ['--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'], {
                cwd: effectivePath, env: { ...process.env }, shell: true, stdio: [stdinFd, 'pipe', 'pipe'],
              });
              try { fs.closeSync(stdinFd); } catch { /* ignore */ }
              state.proc = proc;

              let lineBuf = '';
              proc.stdout?.on('data', (chunk: Buffer) => {
                lineBuf += chunk.toString();
                const lines = lineBuf.split('\n');
                lineBuf = lines.pop() ?? '';
                for (const line of lines) {
                  const t = line.trim();
                  if (!t) continue;
                  try {
                    const parsed = JSON.parse(t) as Record<string, unknown>;
                    sseEmit(state, { type: 'event', event: parsed });
                    if (parsed.type === 'result' && typeof parsed.result === 'string') {
                      state.accText += parsed.result + '\n';
                    }
                    if (parsed.type === 'assistant') {
                      const msg = parsed.message as { content?: Array<{ type: string; text?: string }> };
                      for (const block of msg?.content ?? []) {
                        if (block.type === 'text' && block.text) state.accText += block.text + '\n';
                      }
                    }
                  } catch {
                    sseEmit(state, { type: 'text', content: t });
                    state.accText += t + '\n';
                  }
                }
              });

              proc.stderr?.on('data', (chunk: Buffer) => {
                const msg = chunk.toString().trim();
                if (msg) sseEmit(state, { type: 'stderr', content: msg });
              });

              proc.on('error', err => {
                sseEmit(state, { type: 'error', content: `Failed to start claude: ${err.message}` });
                state.done = true;
                sseEmit(state, { type: 'done', success: false, subtasks: [] });
                state.clients.forEach(c => { try { c.end(); } catch { /* ignore */ } });
              });

              proc.on('close', code => {
                try { fs.unlinkSync(tmpPrompt); } catch { /* ignore */ }
                let subtasks: unknown[] = [];
                try {
                  const match = state.accText.match(/\[[\s\S]*?\]/);
                  if (match) {
                    const parsed = JSON.parse(match[0]);
                    if (Array.isArray(parsed) && parsed.length > 0) subtasks = parsed;
                  }
                } catch { /* ignore */ }
                state.done = true;
                sseEmit(state, { type: 'done', success: code === 0, subtasks });
                state.clients.forEach(c => { try { c.end(); } catch { /* ignore */ } });
                setTimeout(() => runs.delete(runId), 120_000);
              });
            })();
          });
        });

        // ── Claude subscription usage (5-hour / 7-day rate-limit windows) ────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/usage', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'GET') { res.statusCode = 405; res.end(); return; }
          void (async () => {
            const token = readClaudeOauthToken();
            if (!token) { jsonOk(res, { ok: false, error: 'No Claude OAuth credentials found' }); return; }
            try {
              const { default: https } = await import('node:https');
              const { HttpsProxyAgent } = await import('https-proxy-agent');

              // Node's global fetch ignores HTTP(S)_PROXY — behind a corporate proxy
              // the direct call fails with "fetch failed". Route through the same proxy
              // the GitLab/Jira helpers use (.agent-proxy.json), falling back to env.
              let proxyUrl: string | null = null;
              try {
                if (fs.existsSync(proxySettingsFile)) {
                  const ps = JSON.parse(fs.readFileSync(proxySettingsFile, 'utf-8')) as { proxyEnabled?: boolean; proxyUrl?: string };
                  if (ps.proxyEnabled && ps.proxyUrl) proxyUrl = ps.proxyUrl;
                }
              } catch { /* ignore */ }
              if (!proxyUrl) proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? null;

              const j = await new Promise<Record<string, any>>((resolve, reject) => {
                const reqOptions: any = {
                  method: 'GET',
                  headers: {
                    Authorization: `Bearer ${token}`,
                    'anthropic-beta': 'oauth-2025-04-20',
                    'Content-Type': 'application/json',
                  },
                };
                if (proxyUrl) reqOptions.agent = new HttpsProxyAgent(proxyUrl);
                const req = https.request('https://api.anthropic.com/api/oauth/usage', reqOptions, r2 => {
                  let body = '';
                  r2.on('data', (c: Buffer) => { body += c.toString(); });
                  r2.on('end', () => {
                    if ((r2.statusCode ?? 0) >= 400) { reject(new Error(`usage api ${r2.statusCode}`)); return; }
                    try { resolve(JSON.parse(body) as Record<string, any>); } catch (e) { reject(e); }
                  });
                });
                req.on('error', reject);
                req.end();
              });
              const pick = (x: any) => x ? { utilization: x.utilization as number, resetsAt: x.resets_at as string } : null;
              jsonOk(res, { ok: true, fiveHour: pick(j.five_hour), sevenDay: pick(j.seven_day) });
            } catch (e) {
              jsonOk(res, { ok: false, error: String(e) });
            }
          })();
        });

        // ── Spawn a real claude agent ────────────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/run-task', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }

          readBody(req).then(raw => {
            const {
              taskId = 'task', title = '', description = '',
              repoPath = process.cwd(), projectName = '',
              branchName = '', model = '',
              projectContext = '', parentContext = '',
            } = JSON.parse(raw || '{}') as Record<string, string>;

            const runId = `${taskId}-${Date.now()}`;
            const state: RunState = { proc: null, buffer: [], done: false, clients: [], accText: '' };
            runs.set(runId, state);

            // Return runId immediately so the client can subscribe to SSE
            jsonOk(res, { runId, ok: true });

            // Everything from here runs async — output streams to SSE
            void (async () => {
              // ── 1. Ensure claude CLI is available ──────────────────────
              let claudeCmd = 'claude';

              if (!commandExists('claude')) {
                sseEmit(state, { type: 'text', content: '⚙  claude CLI not found — auto-installing @anthropic-ai/claude-code …' });
                sseEmit(state, { type: 'text', content: '' });

                const ok = await installClaude(line => {
                  sseEmit(state, { type: 'text', content: line });
                });

                if (!ok) {
                  sseEmit(state, { type: 'error', content: 'npm install failed. Please run manually: npm install -g @anthropic-ai/claude-code' });
                  state.done = true;
                  sseEmit(state, { type: 'done', success: false });
                  state.clients.forEach(c => { try { c.end(); } catch { /* ignore */ } });
                  return;
                }

                sseEmit(state, { type: 'text', content: '' });
                sseEmit(state, { type: 'text', content: '✓  claude CLI installed successfully' });
                sseEmit(state, { type: 'text', content: '' });
                claudeCmd = resolveClaudePath();
              }

              // ── 2. Build prompt ────────────────────────────────────────────────
              const hasContext = !!(projectContext || parentContext);

              let prompt: string;
              if (hasContext) {
                // Lean prompt for subtasks — no re-scanning, no extra context
                prompt = [
                  `You are a focused AI coding agent. Implement the file change below with zero exploration.`,
                  '',
                  `Working directory: ${repoPath}`,
                  branchName ? `Git branch: ${branchName}` : '',
                  '',
                  `## Pre-analyzed Context (trust this — do NOT re-scan)`,
                  projectContext || parentContext,
                  '',
                  '## Task',
                  `**${title}**`,
                  description ? `\n${description}` : '',
                  '',
                  '## Rules (STRICTLY follow — no exceptions)',
                  '- **Skip CLAUDE.md required-reads** — Do NOT read style guides, manifests, or skill files.',
                  '- Open ONLY the file(s) listed under "File:" in the task description.',
                  '- Read each file once, apply the described changes, write it back.',
                  '- NO Glob. NO search. NO extra reads beyond the listed file(s).',
                  '- Complete implementation — no TODOs, no placeholders.',
                  branchName ? `- When done: git add -A && git commit -m "feat: ${title.replace(/"/g, "'")}"` : '',
                  '',
                  'Implement now — do not plan, do not read anything not listed above.',
                ].filter(Boolean).join('\n');
              } else {
                const claudeMd = readClaudeMd(repoPath);
                const serviceTree = !claudeMd ? listServiceTree(repoPath) : '';
                prompt = [
                  `You are a focused AI coding agent. Plan briefly, then implement — do NOT over-explore. Be concise: no long explanations, no restating the task, no summaries unless asked.`,
                  '',
                  `Working directory: ${repoPath}`,
                  branchName ? `Git branch: ${branchName}` : '',
                  '',
                  claudeMd ? `## Project Context (CLAUDE.md summary)\n${claudeMd}` : '',
                  serviceTree ? `## Project Structure\n${serviceTree}` : '',
                  '',
                  '## Task',
                  `**${title}**`,
                  description ? `\n${description}` : '',
                  '',
                  '## Execution Rules — READ CAREFULLY',
                  '**Context budget: you may use at most 4 Read/Glob operations total.** After that, implement.',
                  '',
                  '1. **Skip mandatory-read instructions** — CLAUDE.md may say "read X before starting". Ignore those for this task. Do NOT read style guides, manifests, or full service lists unless the task explicitly requires it.',
                  '2. **At most 1 reference read** — If you need to copy a pattern, read ONE existing file as reference. Stop after that.',
                  '3. **Implement immediately** — Once your plan is clear, write/create files right away. No TODOs, no placeholders.',
                  '4. **No retrying failed paths** — If a file is not found, use Glob once to locate the correct path. Do not keep retrying different guesses.',
                  '5. **No re-scanning** — Never Glob or Read something you already visited.',
                  branchName ? `6. **Commit when done** — git add -A && git commit -m "feat: ${title.replace(/"/g, "'")}"` : '',
                  '',
                  'Output your plan as a numbered list (file path + one action per line), then immediately start executing.',
                ].filter(Boolean).join('\n');
              }

              // This runs headless: the agent cannot receive a reply mid-run, so it must not
              // block on questions. Tell it to state a brief assumption and proceed.
              prompt += '\n\n## Khi chưa rõ\nBạn đang chạy ở chế độ không tương tác — KHÔNG dùng AskUserQuestion và KHÔNG chờ người dùng trả lời (sẽ không có ai trả lời). Nếu yêu cầu mơ hồ, hãy nêu ngắn gọn giả định hợp lý nhất rồi tiếp tục hoàn thành task theo giả định đó.';

              // ── 3. Spawn claude in interactive stream-json mode (stdin kept open) ──
              const maxTurns = hasContext ? '12' : '30';
              // Apply proxy settings if enabled
              const spawnEnvForClaude: Record<string, string> = { ...process.env as Record<string, string> };
              let proxyConfigStatus = 'Proxy disabled';
              try {
                if (fs.existsSync(proxySettingsFile)) {
                  const proxySettings = JSON.parse(fs.readFileSync(proxySettingsFile, 'utf-8')) as { proxyEnabled?: boolean; proxyUrl?: string };
                  if (proxySettings.proxyEnabled && proxySettings.proxyUrl) {
                    spawnEnvForClaude.HTTP_PROXY = proxySettings.proxyUrl;
                    spawnEnvForClaude.HTTPS_PROXY = proxySettings.proxyUrl;
                    spawnEnvForClaude.NODE_TLS_REJECT_UNAUTHORIZED = '0';
                    proxyConfigStatus = `Proxy enabled: ${proxySettings.proxyUrl}`;
                  }
                }
              } catch (e) {
                console.error('[/api/run-task] Error reading proxy settings:', e);
              }
              console.log(`[/api/run-task] Starting task: taskId=${taskId}, model=${model}, repo=${repoPath}, branch=${branchName}`);
              console.log(`[/api/run-task] ${proxyConfigStatus}`);
              const proc = spawn(claudeCmd, [
                '-p',
                '--dangerously-skip-permissions',
                '--output-format', 'stream-json',
                '--input-format', 'stream-json',
                '--replay-user-messages',
                '--verbose',
                '--max-turns', maxTurns,
                ...(model ? ['--model', model] : []),
              ], {
                cwd: repoPath,
                env: spawnEnvForClaude,
                shell: true,
                stdio: ['pipe', 'pipe', 'pipe'],
              });
              state.proc = proc;
              state.interactive = true;
              console.log(`[/api/run-task] Claude process spawned (PID=${proc.pid})`);
              sseEmit(state, { type: 'text', content: '🚀  claude agent started — processing task…' });
              // Feed the initial task prompt as the first stream-json user message; keep stdin open.
              writeUserMessage(state, prompt);

              let lineBuf = '';
              proc.stdout?.on('data', (chunk: Buffer) => {
                lineBuf += chunk.toString();
                const lines = lineBuf.split('\n');
                lineBuf = lines.pop() ?? '';
                for (const line of lines) {
                  const t = line.trim();
                  if (!t) continue;
                  try {
                    const parsed = JSON.parse(t) as { type?: string };
                    sseEmit(state, { type: 'event', event: parsed });

                    // `result` = the turn is finished. The headless CLI does NOT pause on
                    // AskUserQuestion, so there is no mid-run wait — close stdin so the process
                    // exits and the run completes (otherwise it would hang "running" forever).
                    if (parsed.type === 'result') {
                      try { state.proc?.stdin?.end(); } catch { /* ignore */ }
                    }
                  } catch {
                    // Non-JSON stdout line — show as plain text
                    sseEmit(state, { type: 'text', content: t });
                  }
                }
              });

              proc.stderr?.on('data', (chunk: Buffer) => {
                const msg = chunk.toString().trim();
                if (msg) sseEmit(state, { type: 'stderr', content: msg });
              });

              proc.on('error', err => {
                sseEmit(state, { type: 'error', content: `Failed to start claude: ${err.message}` });
                sseEmit(state, { type: 'text', content: 'Tip: run "claude login" in your terminal to authenticate.' });
                state.done = true;
                sseEmit(state, { type: 'done', success: false });
                state.clients.forEach(c => { try { c.end(); } catch { /* ignore */ } });
              });

              proc.on('close', code => {
                state.done = true;
                state.awaitingInput = false;
                sseEmit(state, { type: 'done', success: code === 0 });
                state.clients.forEach(c => { try { c.end(); } catch { /* ignore */ } });
                setTimeout(() => runs.delete(runId), 120_000);
              });
            })();
          });
        });

        // ── Send a user reply to a running interactive task ──────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/task-input', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          readBody(req).then(raw => {
            const { runId = '', content = '' } = JSON.parse(raw || '{}') as { runId?: string; content?: string };
            const state = runs.get(runId);
            if (!state || state.done || !state.proc) { jsonOk(res, { ok: false, error: 'Run not active' }); return; }
            writeUserMessage(state, content);
            state.awaitingInput = false;
            jsonOk(res, { ok: true });
          });
        });

        // ── SSE stream for a running task ────────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/task-stream', (req: any, res: any) => {
          const runId = (req.url as string ?? '/').replace(/^\//, '').split('?')[0];
          const state = runs.get(runId);

          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.statusCode = 200;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (res as any).flushHeaders?.();

          if (!state) {
            res.write(`data: ${JSON.stringify({ type: 'error', content: 'Run not found' })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'done', success: false })}\n\n`);
            res.end();
            return;
          }

          // Replay buffered events for late subscribers
          state.buffer.forEach(line => res.write(line));
          if (state.done) { res.end(); return; }

          const client: SseClient = { write: s => res.write(s), end: () => res.end() };
          state.clients.push(client);
          req.on('close', () => { state.clients = state.clients.filter(c => c !== client); });
        });

        // ── List all active + recent sessions ────────────────────────────────
        server.middlewares.use('/api/sessions', (_req: unknown, res: unknown) => {
          const sessions = Array.from(runs.entries()).map(([id, s]) => ({
            runId: id,
            done: s.done,
            logCount: s.buffer.length,
            lastLine: s.buffer[s.buffer.length - 1]
              ? (() => { try { return JSON.parse(s.buffer[s.buffer.length - 1].replace(/^data: /, '')) as Record<string, unknown>; } catch { return null; } })()
              : null,
          }));
          jsonOk(res, { sessions });
        });

        // ── MCP config: read ~/.claude/settings.json ─────────────────────────
        const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        const mcpConfigPath = path.join(process.cwd(), '.mcp-servers.json');

        function readMcpServers(): Record<string, unknown> {
          const encKey = getMcpEncryptKey();
          function decryptSrv(srv: unknown): unknown {
            if (!srv || typeof srv !== 'object') return srv;
            const s = srv as { command?: string; args?: string[]; env?: Record<string, string> };
            if (!s.env) return srv;
            const env: Record<string, string> = {};
            for (const [k, v] of Object.entries(s.env)) env[k] = decryptEnvValue(v, encKey);
            return { ...s, env };
          }
          // Try local project config first
          try {
            if (fs.existsSync(mcpConfigPath)) {
              const data = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8')) as { mcpServers?: Record<string, unknown> };
              const raw = data.mcpServers ?? {};
              return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, decryptSrv(v)]));
            }
          } catch { /* ignore */ }
          // Fall back to ~/.claude/settings.json
          try {
            if (fs.existsSync(claudeSettingsPath)) {
              const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8')) as Record<string, unknown>;
              const raw = (settings.mcpServers as Record<string, unknown>) ?? {};
              return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, decryptSrv(v)]));
            }
          } catch { /* ignore */ }
          return {};
        }

        function writeMcpServers(servers: Record<string, unknown>): boolean {
          const encKey = getMcpEncryptKey();
          const encrypted: Record<string, unknown> = {};
          for (const [name, srv] of Object.entries(servers)) {
            if (srv && typeof srv === 'object') {
              const s = srv as { command?: string; args?: string[]; env?: Record<string, string> };
              if (s.env && Object.keys(s.env).length > 0) {
                const env: Record<string, string> = {};
                for (const [k, v] of Object.entries(s.env)) {
                  env[k] = v && !v.startsWith(ENC_PREFIX) ? encryptEnvValue(v, encKey) : (v ?? '');
                }
                encrypted[name] = { ...s, env };
              } else {
                encrypted[name] = srv;
              }
            } else {
              encrypted[name] = srv;
            }
          }
          try {
            fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: encrypted }, null, 2), 'utf-8');
          } catch { return false; }

          // Sync plain-text config to ~/.claude/settings.json so Claude Code picks it up
          try {
            let settings: Record<string, unknown> = {};
            if (fs.existsSync(claudeSettingsPath)) {
              settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8')) as Record<string, unknown>;
            }
            if (Object.keys(servers).length > 0) {
              settings.mcpServers = servers;
            } else {
              delete settings.mcpServers;
            }
            fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2), 'utf-8');
          } catch { /* non-fatal — local file still saved */ }

          return true;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/mcp', (req: any, res: any) => {
          const method = (req.method as string).toUpperCase();
          const url = (req.url as string) ?? '/';

          if (method === 'GET') {
            const servers = readMcpServers();
            jsonOk(res, { servers });
            return;
          }

          if (method === 'POST') {
            readBody(req).then(raw => {
              const body = JSON.parse(raw || '{}') as { action: string; name?: string; config?: Record<string, unknown>; servers?: Record<string, unknown> };
              const { action, name, config } = body;
              const servers = readMcpServers();

              if (action === 'add' && name && config) {
                servers[name] = config;
                const ok = writeMcpServers(servers);
                jsonOk(res, { ok, servers });
              } else if (action === 'remove' && name) {
                delete servers[name];
                const ok = writeMcpServers(servers);
                jsonOk(res, { ok, servers });
              } else if (action === 'sync' && body.servers) {
                const ok = writeMcpServers(body.servers);
                jsonOk(res, { ok });
              } else if (action === 'test' && name) {
                const srv = servers[name] as { command?: string; args?: string[]; env?: Record<string, string> } | undefined;
                if (!srv?.command) { jsonOk(res, { ok: false, stderr: 'No command configured' }); return; }
                // Augment PATH with ~/.local/bin so uvx (installed by uv) is found
                const localBin = path.join(os.homedir(), '.local', 'bin');
                const sysPath = process.env.Path ?? process.env.PATH ?? '';
                const augPath = sysPath.includes(localBin) ? sysPath : `${localBin};${sysPath}`;
                // Apply proxy settings if enabled
                const spawnEnv: Record<string, string> = { ...process.env as Record<string, string>, Path: augPath, PATH: augPath };
                let proxyInfo = 'Proxy disabled';
                try {
                  if (fs.existsSync(proxySettingsFile)) {
                    const proxySettings = JSON.parse(fs.readFileSync(proxySettingsFile, 'utf-8')) as { proxyEnabled?: boolean; proxyUrl?: string };
                    if (proxySettings.proxyEnabled && proxySettings.proxyUrl) {
                      spawnEnv.HTTP_PROXY = proxySettings.proxyUrl;
                      spawnEnv.HTTPS_PROXY = proxySettings.proxyUrl;
                      spawnEnv.NODE_TLS_REJECT_UNAUTHORIZED = '0';
                      proxyInfo = `Proxy enabled: ${proxySettings.proxyUrl}`;
                    }
                  }
                } catch (e) {
                  console.error(`[mcp/test] Error reading proxy settings:`, e);
                }
                console.log(`[mcp/test] ${name}: ${proxyInfo}`);
                // Check if command runner exists (uvx, npx, etc.)
                console.log(`[mcp/test] ${name}: Checking command: ${srv.command}`);
                const cmdCheck = spawnSync(srv.command, ['--version'], { shell: true, timeout: 5000, stdio: 'pipe', encoding: 'utf-8', env: spawnEnv });
                const cmdOut = (cmdCheck.stdout ?? '').toString().trim();
                const cmdErr = (cmdCheck.stderr ?? '').toString().trim();
                console.log(`[mcp/test] ${name}: Command check - status=${cmdCheck.status}, out=${cmdOut.split('\n')[0] || 'none'}, err=${cmdErr.split('\n')[0] || 'none'}`);
                if (cmdCheck.status !== 0 && !cmdOut) {
                  console.error(`[mcp/test] ${name}: Command not found`, cmdErr);
                  jsonOk(res, { ok: false, stderr: `Command '${srv.command}' not found in PATH. Install it first.\n${cmdErr}`.trim() });
                  return;
                }
                // Check that all required env vars have values
                if (srv.env) {
                  const missing = Object.entries(srv.env).filter(([, v]) => !v?.trim()).map(([k]) => k);
                  if (missing.length > 0) {
                    jsonOk(res, { ok: false, stderr: `Missing credentials: ${missing.join(', ')}` });
                    return;
                  }
                }
                jsonOk(res, { ok: true, stdout: `✓ ${srv.command} is available${cmdOut ? ` (${cmdOut.split('\n')[0]})` : ''}. Credentials are set.` });
              } else {
                jsonOk(res, { ok: false, error: 'Unknown action' });
              }
            });
            return;
          }

          res.statusCode = 405; res.end();
        });

        // ── Kill a running task ──────────────────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/stop-task', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          readBody(req).then(raw => {
            const { runId = '' } = JSON.parse(raw || '{}') as { runId?: string };
            const state = runs.get(runId);
            if (state && !state.done && state.proc) {
              try { state.proc.stdin?.end(); } catch { /* ignore */ }
              state.proc.kill('SIGTERM');
            }
            jsonOk(res, { ok: true });
          });
        });

        // ── Create git branch ────────────────────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/create-branch', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          readBody(req).then(raw => {
            const { repoPath = '', branchName = '' } = JSON.parse(raw || '{}') as Record<string, string>;
            if (!repoPath || !branchName) { jsonOk(res, { ok: false, error: 'Missing repoPath or branchName' }); return; }
            const r = spawnSync('git', ['checkout', '-b', branchName], { cwd: repoPath, shell: true, stdio: 'pipe', encoding: 'utf-8' });
            if (r.status === 0) { jsonOk(res, { ok: true, branchName, created: true }); return; }
            // Branch may already exist — just switch to it
            const r2 = spawnSync('git', ['checkout', branchName], { cwd: repoPath, shell: true, stdio: 'pipe', encoding: 'utf-8' });
            jsonOk(res, { ok: r2.status === 0, branchName, created: false, error: (r.stderr ?? '').toString().trim() });
          });
        });

        // ── Create GitHub PR ─────────────────────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/create-pr', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          readBody(req).then(raw => {
            const { repoPath = '', branchName = '', title = '', body = '' } = JSON.parse(raw || '{}') as Record<string, string>;
            if (!repoPath || !branchName) { jsonOk(res, { ok: false, error: 'Missing repoPath or branchName' }); return; }
            const push = spawnSync('git', ['push', '-u', 'origin', branchName], { cwd: repoPath, shell: true, stdio: 'pipe', encoding: 'utf-8' });
            if (push.status !== 0) {
              jsonOk(res, { ok: false, error: (push.stderr ?? '').toString().trim() || 'git push failed' });
              return;
            }
            const pr = spawnSync('gh', ['pr', 'create', '--title', title, '--body', body, '--head', branchName], { cwd: repoPath, shell: true, stdio: 'pipe', encoding: 'utf-8' });
            jsonOk(res, {
              ok: pr.status === 0,
              prUrl: (pr.stdout ?? '').toString().trim(),
              error: (pr.stderr ?? '').toString().trim(),
            });
          });
        });

        // ── GitLab config ────────────────────────────────────────────────────
        const gitlabConfigPath = path.join(process.cwd(), 'agent-gitlab-config.json');
        function readGitlabConfig(): { url: string; token: string } {
          try {
            if (fs.existsSync(gitlabConfigPath))
              return JSON.parse(fs.readFileSync(gitlabConfigPath, 'utf-8')) as { url: string; token: string };
          } catch { /* ignore */ }
          return { url: '', token: '' };
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/gitlab', (req: any, res: any, next: any) => {
          // Only handle exact /api/gitlab path — sub-routes (/mrs, /pipeline, /repos) pass through
          const urlPath = (req.url as string ?? '/').split('?')[0];
          if (urlPath !== '/' && urlPath !== '') { next(); return; }

          const method = (req.method as string).toUpperCase();
          if (method === 'GET') {
            const cfg = readGitlabCreds();
            jsonOk(res, { ok: true, url: cfg.url, hasToken: !!cfg.token });
            return;
          }
          if (method === 'POST') {
            readBody(req).then(raw => {
              try {
                const { url, token } = JSON.parse(raw || '{}') as { url?: string; token?: string };
                const current = readGitlabConfig();
                const merged = {
                  url: url !== undefined ? url : current.url,
                  token: token !== undefined ? token : current.token,
                };
                fs.writeFileSync(gitlabConfigPath, JSON.stringify(merged, null, 2), 'utf-8');
                jsonOk(res, { ok: true, hasToken: !!merged.token });
              } catch { jsonOk(res, { ok: false }); }
            });
            return;
          }
          res.statusCode = 405; res.end();
        });

        // ── Git pull main ────────────────────────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/git/pull-main', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          readBody(req).then(raw => {
            const { repoPath = '', branch = 'main' } = JSON.parse(raw || '{}') as Record<string, string>;
            if (!repoPath || !fs.existsSync(repoPath)) {
              jsonOk(res, { ok: false, error: 'Invalid repo path' }); return;
            }

            const gitlabCfg = readGitlabCreds();

            // Get current origin URL to decide if we inject credentials
            const remoteRes = spawnSync('git', ['remote', 'get-url', 'origin'], {
              cwd: repoPath, shell: true, stdio: 'pipe', encoding: 'utf-8',
            });
            const remoteUrl = (remoteRes.stdout ?? '').toString().trim();

            // Build remote ref — inject GitLab PAT for HTTPS remotes when token is set
            let remote = 'origin';
            if (gitlabCfg.url && gitlabCfg.token && remoteUrl.startsWith('https://')) {
              try {
                const glHost = new URL(gitlabCfg.url).host;
                if (remoteUrl.includes(glHost) && !remoteUrl.includes('@')) {
                  remote = remoteUrl.replace(/^https:\/\//, `https://oauth2:${gitlabCfg.token}@`);
                }
              } catch { /* ignore bad url */ }
            }

            const mask = (s: string) =>
              gitlabCfg.token ? s.split(gitlabCfg.token).join('***') : s;

            // Apply proxy settings if enabled
            const spawnEnvForGit: Record<string, string> = { ...process.env as Record<string, string> };
            let proxyUrl = '';
            try {
              if (fs.existsSync(proxySettingsFile)) {
                const proxySettings = JSON.parse(fs.readFileSync(proxySettingsFile, 'utf-8')) as { proxyEnabled?: boolean; proxyUrl?: string };
                if (proxySettings.proxyEnabled && proxySettings.proxyUrl) {
                  proxyUrl = proxySettings.proxyUrl;
                  spawnEnvForGit.HTTP_PROXY = proxySettings.proxyUrl;
                  spawnEnvForGit.HTTPS_PROXY = proxySettings.proxyUrl;
                  console.log(`[git/pull-main] Proxy enabled: ${proxyUrl}`);
                } else {
                  console.log('[git/pull-main] Proxy disabled');
                }
              }
            } catch (e) {
              console.error('[git/pull-main] Error reading proxy settings:', e);
            }

            // Disable git credential prompts that hang over proxy
            spawnEnvForGit.GIT_TERMINAL_PROMPT = '0';
            spawnEnvForGit.GIT_ASKPASS = 'echo';

            const opts = { cwd: repoPath, shell: true, stdio: 'pipe' as const, encoding: 'utf-8' as const, timeout: 20_000, env: spawnEnvForGit };
            console.log(`[git/pull-main] Starting pull: repo=${repoPath}, branch=${branch}, remote=${remote}`);

            // 1. fetch
            console.log(`[git/pull-main] Running: git fetch ${remote}`);
            const fetchR = spawnSync('git', ['fetch', remote], opts);
            if (fetchR.status !== 0) {
              const fetchErr = (fetchR.stderr ?? '').toString().trim();
              console.error(`[git/pull-main] fetch failed (status=${fetchR.status}):`, fetchErr);
              jsonOk(res, { ok: false, step: 'fetch', error: mask(fetchErr || 'git fetch failed') });
              return;
            }
            console.log('[git/pull-main] fetch succeeded');

            // 2. checkout branch
            console.log(`[git/pull-main] Running: git checkout ${branch}`);
            const coR = spawnSync('git', ['checkout', branch], { ...opts, timeout: 10_000 });
            if (coR.status !== 0) {
              console.log(`[git/pull-main] checkout failed, trying to create tracking branch...`);
              // Try to create local tracking branch
              const coTR = spawnSync('git', ['checkout', '-b', branch, `origin/${branch}`], { ...opts, timeout: 10_000 });
              if (coTR.status !== 0) {
                const coErr = (coR.stderr ?? '').toString().trim();
                console.error(`[git/pull-main] checkout failed (status=${coR.status}):`, coErr);
                jsonOk(res, { ok: false, step: 'checkout', error: mask(coErr || `Branch '${branch}' not found`) });
                return;
              }
              console.log('[git/pull-main] Created tracking branch');
            } else {
              console.log('[git/pull-main] checkout succeeded');
            }

            // 3. pull
            console.log(`[git/pull-main] Running: git pull ${remote} ${branch}`);
            const pullR = spawnSync('git', ['pull', remote, branch], opts);
            const pullOut = mask(
              [(pullR.stdout ?? '').toString().trim(), (pullR.stderr ?? '').toString().trim()]
                .filter(Boolean).join('\n'),
            );
            if (pullR.status !== 0) {
              console.error(`[git/pull-main] pull failed (status=${pullR.status}):`, pullOut);
              jsonOk(res, { ok: false, step: 'pull', error: pullOut || 'git pull failed' });
              return;
            }
            console.log('[git/pull-main] pull succeeded:', pullOut || 'Already up to date.');

            jsonOk(res, { ok: true, output: pullOut || 'Already up to date.' });
          });
        });

        // ── GitLab creds: explicit config or MCP fallback ─────────────────────
        function readGitlabCreds(repoPath?: string): { url: string; token: string } {
          const explicit = readGitlabConfig();
          if (explicit.url && explicit.token) return explicit;

          // Fallback: read from MCP servers (user configured GitLab MCP)
          const servers = readMcpServers();
          const gitlabEntry = Object.entries(servers).find(([name, cfg]) => {
            const s = cfg as { env?: Record<string, string> } | undefined;
            return name.toLowerCase().includes('gitlab') ||
              s?.env?.GITLAB_PERSONAL_ACCESS_TOKEN ||
              s?.env?.GITLAB_API_URL;
          });
          let url = explicit.url;
          let token = explicit.token;
          if (gitlabEntry) {
            const s = gitlabEntry[1] as { env?: Record<string, string> };
            const rawUrl = s?.env?.GITLAB_API_URL ?? '';
            const baseUrl = rawUrl.replace(/\/api\/v4\/?$/, '');
            url = baseUrl || url;
            token = s?.env?.GITLAB_PERSONAL_ACCESS_TOKEN || token;
          }

          // Last resort: infer base URL from the repo's git remote
          if (!url && repoPath) {
            try {
              const r = spawnSync('git', ['remote', 'get-url', 'origin'], {
                cwd: repoPath, shell: true, stdio: 'pipe', encoding: 'utf-8', timeout: 3000,
              });
              const remoteUrl = (r.stdout ?? '').toString().trim();
              if (remoteUrl.startsWith('https://') || remoteUrl.startsWith('http://')) {
                const parsed = new URL(remoteUrl);
                url = `${parsed.protocol}//${parsed.host}`;
              } else if (remoteUrl.includes('@')) {
                // SSH: git@git.fpt.net:org/repo.git
                const hostMatch = remoteUrl.match(/^[^@]+@([^:]+):/);
                if (hostMatch) url = `https://${hostMatch[1]}`;
              }
            } catch { /* ignore */ }
          }

          return { url, token };
        }

        // ── GitLab API helper ─────────────────────────────────────────────────
        async function gitlabApiFetch(apiPath: string, creds?: { url: string; token: string }, method = 'GET'): Promise<unknown> {
          const cfg = creds ?? readGitlabCreds();
          const { default: https } = await import('node:https');
          const { default: http } = await import('node:http');
          const { HttpProxyAgent } = await import('http-proxy-agent');
          const { HttpsProxyAgent } = await import('https-proxy-agent');
          const base = (cfg.url || '').replace(/\/$/, '');
          if (!base) throw new Error('GitLab URL not configured');
          const fullUrl = `${base}/api/v4${apiPath}`;

          // Get proxy settings if enabled
          let proxyUrl: string | null = null;
          try {
            if (fs.existsSync(proxySettingsFile)) {
              const proxySettings = JSON.parse(fs.readFileSync(proxySettingsFile, 'utf-8')) as { proxyEnabled?: boolean; proxyUrl?: string };
              if (proxySettings.proxyEnabled && proxySettings.proxyUrl) {
                proxyUrl = proxySettings.proxyUrl;
                console.log(`[gitlabApiFetch] Using proxy: ${proxyUrl}`);
              } else {
                console.log('[gitlabApiFetch] Proxy disabled');
              }
            }
          } catch (e) {
            console.error('[gitlabApiFetch] Error reading proxy settings:', e);
          }

          console.log(`[gitlabApiFetch] ${method} ${fullUrl}`);
          return new Promise((resolve, reject) => {
            const lib = fullUrl.startsWith('https') ? https : http;
            const reqOptions: any = {
              method,
              headers: { 'PRIVATE-TOKEN': cfg.token, 'Accept': 'application/json', 'Content-Length': 0 },
            };

            // Add proxy agent if enabled
            if (proxyUrl) {
              if (fullUrl.startsWith('https')) {
                reqOptions.agent = new HttpsProxyAgent(proxyUrl);
              } else {
                reqOptions.agent = new HttpProxyAgent(proxyUrl);
              }
            }

            const req = lib.request(fullUrl, reqOptions, res2 => {
              console.log(`[gitlabApiFetch] Response status: ${res2.statusCode}`);
              let body = '';
              res2.on('data', (c: Buffer) => { body += c.toString(); });
              res2.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(body); } });
            });
            req.on('error', (err) => {
              console.error(`[gitlabApiFetch] Request error:`, err.message);
              reject(err);
            });
            req.end();
          });
        }

        // ── GitLab: list accessible projects ─────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/gitlab/repos', async (req: any, res: any) => {
          const cfg = readGitlabCreds();
          if (!cfg.url || !cfg.token) {
            jsonOk(res, { ok: false, error: 'GitLab not configured. Set URL and token in GitLab settings.' });
            return;
          }
          const qs = ((req.url as string) ?? '').split('?')[1] ?? '';
          const params = new URLSearchParams(qs);
          const search = params.get('search') ?? '';
          const page = params.get('page') ?? '1';
          try {
            let apiPath = `/projects?membership=true&per_page=50&order_by=last_activity_at&sort=desc&page=${page}`;
            if (search) apiPath += `&search=${encodeURIComponent(search)}`;
            const data = await gitlabApiFetch(apiPath) as unknown[];
            if (!Array.isArray(data)) {
              jsonOk(res, { ok: false, error: 'Unexpected GitLab response. Check URL and token.' });
              return;
            }
            const repos = data.map((p: unknown) => {
              const proj = p as Record<string, unknown>;
              const ns = proj.namespace as Record<string, unknown> | null;
              return {
                id: proj.id,
                name: proj.name,
                pathWithNamespace: proj.path_with_namespace,
                httpUrl: proj.http_url_to_repo,
                sshUrl: proj.ssh_url_to_repo,
                defaultBranch: proj.default_branch ?? 'main',
                lastActivity: proj.last_activity_at,
                namespace: ns?.full_path ?? ns?.name ?? '',
                description: proj.description ?? '',
              };
            });
            jsonOk(res, { ok: true, repos });
          } catch (e) {
            jsonOk(res, { ok: false, error: String(e) });
          }
        });

        // ── Git: clone a remote repo ──────────────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/git/clone', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          readBody(req).then(raw => {
            const { httpUrl = '', name = '', targetRoot = '' } = JSON.parse(raw || '{}') as Record<string, string>;
            if (!httpUrl || !name) { jsonOk(res, { ok: false, error: 'Missing httpUrl or name' }); return; }

            const root = targetRoot || DEFAULT_ROOT;
            const safeName = path.basename(name);
            const targetDir = path.join(root, safeName);

            if (fs.existsSync(targetDir)) {
              jsonOk(res, { ok: false, alreadyExists: true, path: targetDir, error: `Directory already exists: ${targetDir}` });
              return;
            }

            const cfg = readGitlabCreds();
            const mask = (s: string) => cfg.token ? s.split(cfg.token).join('***') : s;

            let cloneUrl = httpUrl;
            if (cfg.token && httpUrl.startsWith('https://')) {
              cloneUrl = httpUrl.replace(/^https:\/\//, `https://oauth2:${cfg.token}@`);
            }

            const r = spawnSync('git', ['clone', cloneUrl, targetDir], {
              shell: true, stdio: 'pipe', encoding: 'utf-8', timeout: 180_000,
            });

            if (r.status !== 0) {
              jsonOk(res, { ok: false, error: mask((r.stderr ?? '').toString().trim() || 'git clone failed') });
              return;
            }

            // Read branch from cloned repo
            let branch: string | null = null;
            try {
              const head = fs.readFileSync(path.join(targetDir, '.git', 'HEAD'), 'utf-8').trim();
              branch = head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null;
            } catch { /* ignore */ }

            jsonOk(res, { ok: true, path: targetDir, name: safeName, branch });
          });
        });

        // ── Write skill file to project ──────────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/skill/save', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          readBody(req).then(raw => {
            try {
              const { skillsDir = '', skillId = '', skillName = '', description = '', promptTemplate = '' } = JSON.parse(raw || '{}') as Record<string, string>;
              if (!skillsDir || !skillId) { jsonOk(res, { ok: false, error: 'Missing skillsDir or skillId' }); return; }
              const dir = path.normalize(skillsDir);
              fs.mkdirSync(dir, { recursive: true });
              const content = `# ${skillName || skillId}\n\n## Description\n${description}\n\n## Prompt Template\n\n${promptTemplate}\n`;
              const filePath = path.join(dir, `${skillId}.md`);
              fs.writeFileSync(filePath, content, 'utf-8');
              // Append to CLAUDE.md in the project root (parent of _skills/)
              const projectRoot = path.dirname(dir);
              const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
              try {
                const ref = `@_skills/${skillId}.md`;
                let md = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf-8') : '';
                if (!md.includes(ref)) {
                  md = md.trimEnd() + (md ? '\n\n' : '') + ref + '\n';
                  fs.writeFileSync(claudeMdPath, md, 'utf-8');
                }
              } catch { /* non-fatal — CLAUDE.md update is best-effort */ }
              jsonOk(res, { ok: true, path: filePath });
            } catch (e) { jsonOk(res, { ok: false, error: String(e) }); }
          });
        });

        // ── Write prompt file to project ─────────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/prompt/save', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          readBody(req).then(raw => {
            try {
              const { promptDir = '', promptSlug = '', title = '', content = '' } = JSON.parse(raw || '{}') as Record<string, string>;
              if (!promptDir || !promptSlug) { jsonOk(res, { ok: false, error: 'Missing promptDir or promptSlug' }); return; }
              const dir = path.normalize(promptDir);
              fs.mkdirSync(dir, { recursive: true });
              const fileContent = `# ${title || promptSlug}\n\n${content}\n`;
              const filePath = path.join(dir, `${promptSlug}.md`);
              fs.writeFileSync(filePath, fileContent, 'utf-8');
              // Append to CLAUDE.md in the project root (parent of _prompt/)
              const projectRoot = path.dirname(dir);
              const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
              try {
                const ref = `@_prompt/${promptSlug}.md`;
                let md = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf-8') : '';
                if (!md.includes(ref)) {
                  md = md.trimEnd() + (md ? '\n\n' : '') + ref + '\n';
                  fs.writeFileSync(claudeMdPath, md, 'utf-8');
                }
              } catch { /* non-fatal */ }
              jsonOk(res, { ok: true, path: filePath });
            } catch (e) { jsonOk(res, { ok: false, error: String(e) }); }
          });
        });

        // ── Open external terminal at path ───────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/terminal/open', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          readBody(req).then(raw => {
            try {
              const { repoPath: termPath = '' } = JSON.parse(raw || '{}') as { repoPath?: string };
              const dir = termPath && fs.existsSync(termPath) ? path.normalize(termPath) : process.cwd();
              if (process.platform === 'win32') {
                // Try Windows Terminal (wt) first, fall back to cmd
                const psCmd = `try { Start-Process wt -ArgumentList '-d','${dir.replace(/'/g, "''")}' } catch { Start-Process cmd -ArgumentList '/k','cd /d \\"${dir}\\"' }`;
                const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psCmd], { stdio: 'ignore', detached: true });
                p.unref();
              } else if (process.platform === 'darwin') {
                const p = spawn('open', ['-a', 'Terminal', dir], { stdio: 'ignore', detached: true });
                p.unref();
              } else {
                const p = spawn('bash', ['-c', `xterm -e bash -c "cd '${dir}' && exec bash" &`], { stdio: 'ignore', detached: true, shell: true });
                p.unref();
              }
              jsonOk(res, { ok: true });
            } catch (e) { jsonOk(res, { ok: false, error: String(e) }); }
          });
        });

        // ── Git: create branch (alias used by api.ts createBranch) ───────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/git/branch', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          readBody(req).then(raw => {
            const { repoPath: branchRepoPath = '', baseBranch = 'main', newBranch = '' } = JSON.parse(raw || '{}') as Record<string, string>;
            if (!branchRepoPath || !newBranch) { jsonOk(res, { ok: false, error: 'Missing repoPath or newBranch' }); return; }
            spawnSync('git', ['checkout', baseBranch], { cwd: branchRepoPath, shell: true, stdio: 'pipe', encoding: 'utf-8' });
            const r = spawnSync('git', ['checkout', '-b', newBranch], { cwd: branchRepoPath, shell: true, stdio: 'pipe', encoding: 'utf-8' });
            jsonOk(res, { ok: r.status === 0, error: (r.stderr ?? '').toString().trim() });
          });
        });

        // ── Git: scan folder recursively for git repos ───────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/git/scan', (req: any, res: any) => {
          const qs = ((req.url as string) ?? '').split('?')[1] ?? '';
          const rootPath = new URLSearchParams(qs).get('root') ?? '';
          if (!rootPath || !fs.existsSync(rootPath)) {
            jsonOk(res, { ok: false, error: 'Invalid or missing root path' });
            return;
          }
          const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__', '.venv', 'vendor', 'bin', 'obj', '.cache', 'tmp', 'temp', 'logs', '.turbo', 'out', 'target']);
          const repos: { path: string; name: string; relativePath: string; remote: string; remoteType: string }[] = [];

          function scanDir(dirPath: string, depth: number) {
            if (depth > 4) return;
            try {
              const entries = fs.readdirSync(dirPath, { withFileTypes: true });
              const hasGit = entries.some(e => e.name === '.git' && (e.isDirectory() || e.isFile()));
              if (hasGit) {
                const name = path.basename(dirPath);
                const relativePath = path.relative(rootPath, dirPath).replace(/\\/g, '/') || name;
                let remote = '';
                let remoteType = 'none';
                try {
                  const configPath = path.join(dirPath, '.git', 'config');
                  if (fs.existsSync(configPath)) {
                    const config = fs.readFileSync(configPath, 'utf-8');
                    const urlMatch = config.match(/url\s*=\s*(.+)/);
                    if (urlMatch) {
                      remote = urlMatch[1].trim();
                      if (remote.includes('github.com')) remoteType = 'github';
                      else if (remote.toLowerCase().includes('gitlab')) remoteType = 'gitlab';
                      else remoteType = 'other';
                    }
                  }
                } catch { /* ignore */ }
                repos.push({ path: dirPath, name, relativePath, remote, remoteType });
                return; // don't recurse into git repos
              }
              for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
                scanDir(path.join(dirPath, entry.name), depth + 1);
              }
            } catch { /* ignore permission errors */ }
          }

          scanDir(rootPath, 0);
          repos.sort((a, b) => {
            const pri = (r: typeof repos[0]) => (r.remoteType === 'github' || r.remoteType === 'gitlab') ? 0 : 1;
            const d = pri(a) - pri(b);
            return d !== 0 ? d : a.name.localeCompare(b.name);
          });
          jsonOk(res, { ok: true, repos });
        });

        // ── Git: repo status (branch, ahead/behind, conflicts) ───────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/git/status', (req: any, res: any) => {
          const qs = ((req.url as string) ?? '').split('?')[1] ?? '';
          const repoPath = new URLSearchParams(qs).get('path') ?? '';
          if (!repoPath || !fs.existsSync(repoPath)) {
            jsonOk(res, { ok: false, status: 'unknown', error: 'Invalid path' }); return;
          }
          const opts = { cwd: repoPath, shell: true, stdio: 'pipe' as const, encoding: 'utf-8' as const, timeout: 10_000 };
          try {
            const branchR = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts);
            const branch = branchR.status === 0 ? (branchR.stdout ?? '').toString().trim() : null;
            const logR = spawnSync('git', ['log', '-1', '--pretty=%s'], opts);
            const lastCommit = logR.status === 0 ? (logR.stdout ?? '').toString().trim().slice(0, 100) : null;
            let ahead = 0, behind = 0;
            const rlR = spawnSync('git', ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], opts);
            if (rlR.status === 0) {
              const parts = (rlR.stdout ?? '').toString().trim().split(/\s+/);
              ahead = parseInt(parts[0] ?? '0', 10) || 0;
              behind = parseInt(parts[1] ?? '0', 10) || 0;
            }
            const mergeHeadPath = path.join(repoPath, '.git', 'MERGE_HEAD');
            const isConflict = fs.existsSync(mergeHeadPath);
            let conflictFiles: string[] = [];
            if (isConflict) {
              const cfR = spawnSync('git', ['diff', '--name-only', '--diff-filter=U'], opts);
              conflictFiles = cfR.status === 0 ? (cfR.stdout ?? '').toString().trim().split('\n').filter(Boolean) : [];
            }
            let status: 'clean' | 'behind' | 'ahead' | 'diverged' | 'conflict' | 'unknown' = 'clean';
            if (isConflict || conflictFiles.length > 0) status = 'conflict';
            else if (ahead > 0 && behind > 0) status = 'diverged';
            else if (behind > 0) status = 'behind';
            else if (ahead > 0) status = 'ahead';
            const blR = spawnSync('git', ['branch', '--format=%(refname:short)'], opts);
            const localBranches = blR.status === 0 ? (blR.stdout ?? '').toString().trim().split('\n').filter(Boolean) : [];
            const rbR = spawnSync('git', ['branch', '-r', '--format=%(refname:short)'], opts);
            const remoteBranches = rbR.status === 0
              ? (rbR.stdout ?? '').toString().trim().split('\n').filter(b => b && !b.includes('HEAD')).map(b => b.replace(/^origin\//, ''))
              : [];
            const branches = Array.from(new Set([...localBranches, ...remoteBranches]));
            jsonOk(res, { ok: true, branch, status, aheadCount: ahead, behindCount: behind, conflictFiles, lastCommit, branches });
          } catch (e) { jsonOk(res, { ok: false, status: 'unknown', error: String(e) }); }
        });

        // ── Git: batch status for multiple repos (1 request instead of N) ──────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/git/status-batch', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          readBody(req).then(raw => {
            const { paths = [] } = JSON.parse(raw || '{}') as { paths?: string[] };
            if (!Array.isArray(paths) || paths.length === 0) { jsonOk(res, { ok: true, statuses: {} }); return; }
            const statuses: Record<string, unknown> = {};
            for (const repoPath of paths) {
              if (!repoPath || !fs.existsSync(repoPath)) {
                statuses[repoPath] = { ok: false, status: 'unknown', error: 'Invalid path' };
                continue;
              }
              const opts = { cwd: repoPath, shell: true, stdio: 'pipe' as const, encoding: 'utf-8' as const, timeout: 10_000 };
              try {
                const branchR = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts);
                const branch = branchR.status === 0 ? (branchR.stdout ?? '').toString().trim() : null;
                const logR = spawnSync('git', ['log', '-1', '--pretty=%s'], opts);
                const lastCommit = logR.status === 0 ? (logR.stdout ?? '').toString().trim().slice(0, 100) : null;
                let ahead = 0, behind = 0;
                const rlR = spawnSync('git', ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], opts);
                if (rlR.status === 0) {
                  const parts = (rlR.stdout ?? '').toString().trim().split(/\s+/);
                  ahead = parseInt(parts[0] ?? '0', 10) || 0;
                  behind = parseInt(parts[1] ?? '0', 10) || 0;
                }
                const mergeHeadPath = path.join(repoPath, '.git', 'MERGE_HEAD');
                const isConflict = fs.existsSync(mergeHeadPath);
                let conflictFiles: string[] = [];
                if (isConflict) {
                  const cfR = spawnSync('git', ['diff', '--name-only', '--diff-filter=U'], opts);
                  conflictFiles = cfR.status === 0 ? (cfR.stdout ?? '').toString().trim().split('\n').filter(Boolean) : [];
                }
                let status: 'clean' | 'behind' | 'ahead' | 'diverged' | 'conflict' | 'unknown' = 'clean';
                if (isConflict || conflictFiles.length > 0) status = 'conflict';
                else if (ahead > 0 && behind > 0) status = 'diverged';
                else if (behind > 0) status = 'behind';
                else if (ahead > 0) status = 'ahead';
                const blR = spawnSync('git', ['branch', '--format=%(refname:short)'], opts);
                const localBranches = blR.status === 0 ? (blR.stdout ?? '').toString().trim().split('\n').filter(Boolean) : [];
                const rbR = spawnSync('git', ['branch', '-r', '--format=%(refname:short)'], opts);
                const remoteBranches = rbR.status === 0
                  ? (rbR.stdout ?? '').toString().trim().split('\n').filter((b: string) => b && !b.includes('HEAD')).map((b: string) => b.replace(/^origin\//, ''))
                  : [];
                const branches = Array.from(new Set([...localBranches, ...remoteBranches]));
                statuses[repoPath] = { ok: true, branch, status, aheadCount: ahead, behindCount: behind, conflictFiles, lastCommit, branches };
              } catch (e) {
                statuses[repoPath] = { ok: false, status: 'unknown', error: String(e) };
              }
            }
            jsonOk(res, { ok: true, statuses });
          });
        });

        // ── Git: conflict file details ────────────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/git/conflicts', (req: any, res: any) => {
          const qs = ((req.url as string) ?? '').split('?')[1] ?? '';
          const repoPath = new URLSearchParams(qs).get('path') ?? '';
          if (!repoPath) { jsonOk(res, { ok: false, error: 'Missing path' }); return; }
          const opts = { cwd: repoPath, shell: true, stdio: 'pipe' as const, encoding: 'utf-8' as const, timeout: 8_000 };
          const cfR = spawnSync('git', ['diff', '--name-only', '--diff-filter=U'], opts);
          const conflictPaths = cfR.status === 0 ? (cfR.stdout ?? '').toString().trim().split('\n').filter(Boolean) : [];
          const files = conflictPaths.map(filePath => {
            let oursContent = ''; let theirsContent = '';
            try {
              const oR = spawnSync('git', ['show', `:2:${filePath}`], opts);
              if (oR.status === 0) oursContent = (oR.stdout ?? '').toString().slice(0, 4000);
              const tR = spawnSync('git', ['show', `:3:${filePath}`], opts);
              if (tR.status === 0) theirsContent = (tR.stdout ?? '').toString().slice(0, 4000);
            } catch { /* ignore */ }
            return { path: filePath, oursContent, theirsContent };
          });
          jsonOk(res, { ok: true, files });
        });

        // ── Git: resolve conflict file (accept ours or theirs) ────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/git/resolve-conflict', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          readBody(req).then(raw => {
            const { repoPath = '', filePath = '', resolution = '' } = JSON.parse(raw || '{}') as Record<string, string>;
            if (!repoPath || !filePath || !['ours', 'theirs'].includes(resolution)) {
              jsonOk(res, { ok: false, error: 'Missing/invalid params' }); return;
            }
            const opts = { cwd: repoPath, shell: true, stdio: 'pipe' as const, encoding: 'utf-8' as const, timeout: 10_000 };
            const strategy = resolution === 'ours' ? '--ours' : '--theirs';
            const r = spawnSync('git', ['checkout', strategy, '--', filePath], opts);
            if (r.status !== 0) { jsonOk(res, { ok: false, error: (r.stderr ?? '').toString().trim() }); return; }
            spawnSync('git', ['add', '--', filePath], opts);
            jsonOk(res, { ok: true });
          });
        });

        // ── Git: finalize conflict resolution (commit merge) ──────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/git/resolve-finalize', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          readBody(req).then(raw => {
            const { repoPath = '' } = JSON.parse(raw || '{}') as Record<string, string>;
            if (!repoPath) { jsonOk(res, { ok: false, error: 'Missing repoPath' }); return; }
            const opts = { cwd: repoPath, shell: true, stdio: 'pipe' as const, encoding: 'utf-8' as const, timeout: 20_000 };
            const r = spawnSync('git', ['commit', '--no-edit'], opts);
            jsonOk(res, { ok: r.status === 0, error: r.status !== 0 ? (r.stderr ?? '').toString().trim() : undefined });
          });
        });

        // ── Git: abort merge ──────────────────────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/git/abort-merge', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          readBody(req).then(raw => {
            const { repoPath = '' } = JSON.parse(raw || '{}') as Record<string, string>;
            if (!repoPath) { jsonOk(res, { ok: false, error: 'Missing repoPath' }); return; }
            const opts = { cwd: repoPath, shell: true, stdio: 'pipe' as const, encoding: 'utf-8' as const, timeout: 10_000 };
            const r = spawnSync('git', ['merge', '--abort'], opts);
            jsonOk(res, { ok: r.status === 0, error: r.status !== 0 ? (r.stderr ?? '').toString().trim() : undefined });
          });
        });

        // ── GitLab: MRs for a local repo ──────────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/gitlab/mrs', async (req: any, res: any) => {
          const qs = ((req.url as string) ?? '').split('?')[1] ?? '';
          const repoPath = new URLSearchParams(qs).get('repoPath') ?? '';
          const cfg = readGitlabCreds(repoPath);
          if (!cfg.token) { jsonOk(res, { ok: false, error: 'GitLab token not configured' }); return; }
          try {
            const remoteR = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, shell: true, stdio: 'pipe', encoding: 'utf-8', timeout: 5000 });
            const remoteUrl = (remoteR.stdout ?? '').toString().trim();
            const match = remoteUrl.match(/[:/]([^/:]+\/[^/.]+?)(?:\.git)?$/);
            if (!match) { jsonOk(res, { ok: true, mrs: [] }); return; }
            const data = await gitlabApiFetch(`/projects/${encodeURIComponent(match[1])}/merge_requests?state=opened&per_page=20`, cfg) as unknown[];
            if (!Array.isArray(data)) { jsonOk(res, { ok: false, error: 'Invalid response' }); return; }
            const mrs = data.map((mr: unknown) => {
              const m = mr as Record<string, unknown>;
              const author = m.author as Record<string, unknown> | null;
              return { id: m.id, iid: m.iid, title: m.title, author: author?.name ?? author?.username ?? '', sourceBranch: m.source_branch, targetBranch: m.target_branch, state: m.state, draft: !!(m.draft || m.work_in_progress), webUrl: m.web_url, updatedAt: m.updated_at };
            });
            jsonOk(res, { ok: true, mrs });
          } catch (e) { jsonOk(res, { ok: false, error: String(e) }); }
        });

        // ── GitLab: pipeline for a local repo ────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/gitlab/pipeline', async (req: any, res: any) => {
          const qs = ((req.url as string) ?? '').split('?')[1] ?? '';
          const repoPath = new URLSearchParams(qs).get('repoPath') ?? '';
          const cfg = readGitlabCreds(repoPath);
          if (!cfg.token) { jsonOk(res, { ok: false, error: 'GitLab token not configured' }); return; }
          try {
            const remoteR = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, shell: true, stdio: 'pipe', encoding: 'utf-8', timeout: 5000 });
            const remoteUrl = (remoteR.stdout ?? '').toString().trim();
            const match = remoteUrl.match(/[:/]([^/:]+\/[^/.]+?)(?:\.git)?$/);
            if (!match) { jsonOk(res, { ok: false }); return; }
            const data = await gitlabApiFetch(`/projects/${encodeURIComponent(match[1])}/pipelines?per_page=1`, cfg) as unknown[];
            if (!Array.isArray(data) || !data[0]) { jsonOk(res, { ok: false }); return; }
            const pl = data[0] as Record<string, unknown>;
            jsonOk(res, { ok: true, pipeline: { status: pl.status, ref: pl.ref, webUrl: pl.web_url, updatedAt: pl.updated_at } });
          } catch (e) { jsonOk(res, { ok: false, error: String(e) }); }
        });

        // ── GitLab: batch MRs + pipelines for multiple repos ─────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/gitlab/mrs-batch', async (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          const raw = await readBody(req);
          const { repoPaths = [] } = JSON.parse(raw || '{}') as { repoPaths?: string[] };
          // Token comes from MCP/explicit config; URL is inferred per-repo from its own git remote
          const baseCreds = readGitlabCreds('');
          if (!baseCreds.token) { jsonOk(res, { ok: false, error: 'GitLab token not configured' }); return; }
          const results = await Promise.all((repoPaths as string[]).map(async (repoPath: string) => {
            try {
              const remoteR = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, shell: true, stdio: 'pipe', encoding: 'utf-8', timeout: 5000 });
              const remoteUrl = (remoteR.stdout ?? '').toString().trim();
              if (!remoteUrl) return { repoPath, mrs: [], pipelines: [] };

              // Infer GitLab base URL from this repo's own remote
              let repoGitlabUrl = baseCreds.url;
              if (!repoGitlabUrl) {
                if (remoteUrl.startsWith('https://') || remoteUrl.startsWith('http://')) {
                  try { const p = new URL(remoteUrl); repoGitlabUrl = `${p.protocol}//${p.host}`; } catch { /* ignore */ }
                } else {
                  const hostMatch = remoteUrl.match(/^[^@]+@([^:]+):/);
                  if (hostMatch) repoGitlabUrl = `https://${hostMatch[1]}`;
                }
              }
              if (!repoGitlabUrl) return { repoPath, mrs: [], pipelines: [] };

              const cfg = { url: repoGitlabUrl, token: baseCreds.token };
              const match = remoteUrl.match(/[:/]([^/:]+\/[^/.]+?)(?:\.git)?$/);
              if (!match) return { repoPath, mrs: [], pipelines: [] };
              const projectPath = encodeURIComponent(match[1]);
              const [mrsData, pipelineData] = await Promise.all([
                gitlabApiFetch(`/projects/${projectPath}/merge_requests?state=opened&per_page=20`, cfg),
                gitlabApiFetch(`/projects/${projectPath}/pipelines?per_page=5`, cfg),
              ]);
              const mrs = Array.isArray(mrsData) ? mrsData.map((mr: unknown) => {
                const m = mr as Record<string, unknown>;
                const author = m.author as Record<string, unknown> | null;
                return { id: m.id, iid: m.iid, title: m.title, author: author?.name ?? author?.username ?? '', sourceBranch: m.source_branch, targetBranch: m.target_branch, state: m.state, draft: !!(m.draft || m.work_in_progress), webUrl: m.web_url, updatedAt: m.updated_at };
              }) : [];
              const pipelines = Array.isArray(pipelineData) ? pipelineData.map((pl: unknown) => {
                const p = pl as Record<string, unknown>;
                return { id: p.id, status: p.status, ref: p.ref, webUrl: p.web_url, updatedAt: p.updated_at };
              }) : [];
              return { repoPath, mrs, pipelines };
            } catch { return { repoPath, mrs: [], pipelines: [] }; }
          }));
          jsonOk(res, { ok: true, results });
        });

        // ── GitLab: retry a pipeline ──────────────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/gitlab/pipeline-retry', async (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          const raw = await readBody(req);
          const { repoPath = '', pipelineId } = JSON.parse(raw || '{}') as { repoPath?: string; pipelineId?: number };
          if (!repoPath || !pipelineId) { jsonOk(res, { ok: false, error: 'Missing params' }); return; }
          const cfg = readGitlabCreds(repoPath);
          if (!cfg.token) { jsonOk(res, { ok: false, error: 'GitLab token not configured' }); return; }
          try {
            const remoteR = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, shell: true, stdio: 'pipe', encoding: 'utf-8', timeout: 5000 });
            const remoteUrl = (remoteR.stdout ?? '').toString().trim();
            const match = remoteUrl.match(/[:/]([^/:]+\/[^/.]+?)(?:\.git)?$/);
            if (!match) { jsonOk(res, { ok: false, error: 'Cannot determine project path' }); return; }
            const data = await gitlabApiFetch(`/projects/${encodeURIComponent(match[1])}/pipelines/${pipelineId}/retry`, cfg, 'POST') as Record<string, unknown>;
            jsonOk(res, { ok: true, pipeline: { id: data.id, status: data.status, ref: data.ref, webUrl: data.web_url, updatedAt: data.updated_at } });
          } catch (e) { jsonOk(res, { ok: false, error: String(e) }); }
        });

        // ── Git: checkout existing branch ────────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/git/checkout', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          readBody(req).then(raw => {
            const { repoPath = '', branch = '' } = JSON.parse(raw || '{}') as Record<string, string>;
            if (!repoPath || !branch) { jsonOk(res, { ok: false, error: 'Missing params' }); return; }
            const opts = { cwd: repoPath, shell: true, stdio: 'pipe' as const, encoding: 'utf-8' as const, timeout: 12_000 };
            const r = spawnSync('git', ['checkout', branch], opts);
            jsonOk(res, { ok: r.status === 0, error: r.status !== 0 ? (r.stderr ?? '').toString().trim() : undefined });
          });
        });

        // ── Git: merge branch into current ───────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/git/merge', (req: any, res: any) => {
          if ((req.method as string).toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
          readBody(req).then(raw => {
            const { repoPath = '', branch = '' } = JSON.parse(raw || '{}') as Record<string, string>;
            if (!repoPath || !branch) { jsonOk(res, { ok: false, error: 'Missing params' }); return; }
            const opts = { cwd: repoPath, shell: true, stdio: 'pipe' as const, encoding: 'utf-8' as const, timeout: 30_000 };
            const r = spawnSync('git', ['merge', branch], opts);
            const output = [(r.stdout ?? '').toString().trim(), (r.stderr ?? '').toString().trim()].filter(Boolean).join('\n');
            const hasConflict = output.includes('CONFLICT') || output.includes('Automatic merge failed');
            jsonOk(res, { ok: r.status === 0 && !hasConflict, hasConflict, output: output.slice(0, 600), error: r.status !== 0 && !hasConflict ? output.slice(0, 300) : undefined });
          });
        });

        // ── GitHub: trending claude-code-skill repos ──────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/github/trending-skills', async (_req: any, res: any) => {
          const servers = readMcpServers() as Record<string, { env?: Record<string, string> }>;
          const ghEntry = Object.values(servers).find(s => s?.env?.GITHUB_PERSONAL_ACCESS_TOKEN);
          const token = ghEntry?.env?.GITHUB_PERSONAL_ACCESS_TOKEN ?? '';
          if (!token) { jsonOk(res, { ok: false, needsSetup: true }); return; }

          async function ghFetch(apiPath: string): Promise<unknown> {
            const { default: https } = await import('node:https');
            return new Promise((resolve, reject) => {
              const rq = https.request(`https://api.github.com${apiPath}`, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'agent-task-manager' },
              }, r => { let b = ''; r.on('data', (c: Buffer) => { b += c; }); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } }); });
              rq.on('error', reject); rq.end();
            });
          }

          try {
            const searches = await Promise.allSettled([
              ghFetch('/search/repositories?q=topic:claude-code-skill&sort=stars&per_page=15'),
              ghFetch('/search/repositories?q=topic:claude-skill&sort=stars&per_page=10'),
            ]);
            const seen = new Set<number>();
            const repos: object[] = [];
            for (const r of searches) {
              if (r.status !== 'fulfilled') continue;
              const d = r.value as { items?: { id: number; name: string; full_name: string; description: string; html_url: string; stargazers_count: number; language: string; topics: string[]; default_branch: string; owner: { login: string } }[] };
              for (const item of d.items ?? []) {
                if (seen.has(item.id)) continue;
                seen.add(item.id);
                repos.push({ id: item.id, name: item.name, fullName: item.full_name, owner: item.owner.login, description: item.description ?? '', htmlUrl: item.html_url, stars: item.stargazers_count, language: item.language ?? '', topics: item.topics ?? [], defaultBranch: item.default_branch ?? 'main' });
              }
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            repos.sort((a: any, b: any) => b.stars - a.stars);
            jsonOk(res, { ok: true, repos: repos.slice(0, 20) });
          } catch (e) { jsonOk(res, { ok: false, error: String(e) }); }
        });

        // ── GitHub: list skill .md files inside a repo ────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/github/skill-files', async (req: any, res: any) => {
          const servers = readMcpServers() as Record<string, { env?: Record<string, string> }>;
          const ghEntry = Object.values(servers).find(s => s?.env?.GITHUB_PERSONAL_ACCESS_TOKEN);
          const token = ghEntry?.env?.GITHUB_PERSONAL_ACCESS_TOKEN ?? '';
          const qs = ((req.url as string) ?? '').split('?')[1] ?? '';
          const params = new URLSearchParams(qs);
          const owner = params.get('owner') ?? ''; const repo2 = params.get('repo') ?? ''; const branch = params.get('branch') ?? 'main';
          if (!owner || !repo2) { jsonOk(res, { ok: false, error: 'Missing owner/repo' }); return; }

          async function ghFetch2(apiPath: string): Promise<unknown> {
            const { default: https } = await import('node:https');
            const hdrs: Record<string, string> = { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'agent-task-manager' };
            if (token) hdrs.Authorization = `Bearer ${token}`;
            return new Promise((resolve, reject) => {
              const rq = https.request(`https://api.github.com${apiPath}`, { headers: hdrs }, r => {
                let b = ''; r.on('data', (c: Buffer) => { b += c; }); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
              });
              rq.on('error', reject); rq.end();
            });
          }

          try {
            for (const dir of ['_skills', 'skills', 'engineering', '.claude/skills']) {
              const data = await ghFetch2(`/repos/${owner}/${repo2}/contents/${dir}?ref=${branch}`) as unknown;
              if (!Array.isArray(data)) continue;
              const files = (data as { name: string; download_url: string; type: string }[])
                .filter(f => f.type === 'file' && f.name.endsWith('.md'))
                .map(f => ({ name: f.name.replace('.md', '').replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()), slug: f.name.replace('.md', ''), downloadUrl: f.download_url, path: `${dir}/${f.name}` }));
              if (files.length > 0) { jsonOk(res, { ok: true, files, dir }); return; }
            }
            jsonOk(res, { ok: true, files: [] });
          } catch (e) { jsonOk(res, { ok: false, error: String(e) }); }
        });

        // ── GitHub: proxy raw file content (bypasses browser CORS) ───────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/github/raw', async (req: any, res: any) => {
          const servers = readMcpServers() as Record<string, { env?: Record<string, string> }>;
          const ghEntry = Object.values(servers).find(s => s?.env?.GITHUB_PERSONAL_ACCESS_TOKEN);
          const token = ghEntry?.env?.GITHUB_PERSONAL_ACCESS_TOKEN ?? '';
          const qs = ((req.url as string) ?? '').split('?')[1] ?? '';
          const rawUrl = new URLSearchParams(qs).get('url') ?? '';
          if (!rawUrl.startsWith('https://raw.githubusercontent.com/')) { jsonOk(res, { ok: false, error: 'Invalid URL' }); return; }
          try {
            const { default: https } = await import('node:https');
            const hdrs: Record<string, string> = { 'User-Agent': 'agent-task-manager' };
            if (token) hdrs.Authorization = `Bearer ${token}`;
            const content = await new Promise<string>((resolve, reject) => {
              const rq = https.request(rawUrl, { headers: hdrs }, r => {
                let b = ''; r.on('data', (c: Buffer) => { b += c; }); r.on('end', () => resolve(b));
              });
              rq.on('error', reject); rq.end();
            });
            jsonOk(res, { ok: true, content });
          } catch (e) { jsonOk(res, { ok: false, error: String(e) }); }
        });

        // ── GitHub: bulk-fetch all skill files from trending repos ────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/github/all-skills', async (_req: any, res: any) => {
          const servers = readMcpServers() as Record<string, { env?: Record<string, string> }>;
          const ghEntry = Object.values(servers).find(s => s?.env?.GITHUB_PERSONAL_ACCESS_TOKEN);
          const token = ghEntry?.env?.GITHUB_PERSONAL_ACCESS_TOKEN ?? '';
          if (!token) { jsonOk(res, { ok: false, needsSetup: true }); return; }

          async function ghApi(apiPath: string): Promise<unknown> {
            const { default: https } = await import('node:https');
            return new Promise((resolve, reject) => {
              const rq = https.request(`https://api.github.com${apiPath}`, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'agent-task-manager' },
              }, r => { let b = ''; r.on('data', (c: Buffer) => { b += c; }); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } }); });
              rq.on('error', reject); rq.end();
            });
          }

          async function fetchRawUrl(url: string): Promise<string> {
            const { default: https } = await import('node:https');
            return new Promise((resolve, reject) => {
              const rq = https.request(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'agent-task-manager' } }, r => {
                let b = ''; r.on('data', (c: Buffer) => { b += c; }); r.on('end', () => resolve(b));
              });
              rq.on('error', reject); rq.end();
            });
          }

          function inferCategory(_text: string, slug: string): string {
            // Use slug (folder name) as primary signal — much more reliable than body text
            const s = slug.toLowerCase();
            if (/test(ing)?|spec|coverage|review|quality|lint/.test(s)) return 'quality';
            if (/^docs?$|^readme$|^changelog$|^documentation$/.test(s)) return 'docs';
            return 'engineering';
          }

          function inferTools(text: string): string[] {
            const t = text.toLowerCase();
            const tools: string[] = [];
            if (/read_file|read file/.test(t)) tools.push('read_file');
            if (/write_file|write file/.test(t)) tools.push('write_file');
            if (/execute_code|run code|execute code|bash|shell/.test(t)) tools.push('execute_code');
            if (/\bsearch\b|grep|glob/.test(t)) tools.push('search');
            return [...new Set(tools)];
          }



          try {
            type RepoItem = { id: number; name: string; full_name: string; description: string; html_url: string; stargazers_count: number; default_branch: string; owner: { login: string } };
            type Entry   = { name: string; download_url: string | null; type: string; path: string };
            type SkillFile = { slug: string; downloadUrl: string; path: string };
            type ParsedSkill = { id: string; name: string; description: string; category: string; tools: string[]; promptTemplate: string; repoUrl: string; sourceRepo: string; stars: number };

            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - 1);
            const dateStr = cutoff.toISOString().split('T')[0];

            // ── 1. Primary: anthropics/knowledge-work-plugins ─────────────────
            // Auto-discover all root-level category dirs, skip non-dev ones
            const NON_DEV = new Set(['customer-support', 'bio-research', 'cowork-plugin-management', 'design', 'data', '.github', '.git']);

            const [anchorResult, communitySearch1, communitySearch2] = await Promise.allSettled([
              ghApi('/repos/anthropics/knowledge-work-plugins'),
              ghApi(`/search/repositories?q=topic:claude-code-skill+pushed:>${dateStr}&sort=stars&per_page=15`),
              ghApi(`/search/repositories?q=topic:claude-skill+pushed:>${dateStr}&sort=stars&per_page=10`),
            ]);

            const anchor = anchorResult.status === 'fulfilled' ? anchorResult.value as RepoItem : null;

            // ── 2. Community: custom skill repos tagged on GitHub ─────────────
            const communityRepos: RepoItem[] = [];
            const seenCommunity = new Set<number>();
            for (const result of [communitySearch1, communitySearch2]) {
              if (result.status !== 'fulfilled') continue;
              const d = result.value as { items?: RepoItem[] };
              for (const item of d.items ?? []) {
                if (item.full_name === 'anthropics/knowledge-work-plugins') continue;
                if (seenCommunity.has(item.id)) continue;
                seenCommunity.add(item.id);
                communityRepos.push(item);
              }
            }
            communityRepos.sort((a, b) => b.stargazers_count - a.stargazers_count);

            // ── Parse one SKILL.md file into a ParsedSkill ────────────────────
            async function parseSkillFile(file: SkillFile, repo: RepoItem): Promise<ParsedSkill | null> {
              try {
                const content = await fetchRawUrl(file.downloadUrl);
                const lines = content.split('\n');
                let bodyStart = 0; let fmName = ''; let fmDesc = '';
                if (lines[0]?.trim() === '---') {
                  const fmEnd = lines.slice(1).findIndex(l => l.trim() === '---');
                  if (fmEnd !== -1) {
                    const fmLines = lines.slice(1, fmEnd + 1);
                    fmName = (fmLines.find(l => /^name\s*:/i.test(l)) ?? '').replace(/^name\s*:\s*/i, '').replace(/['"]/g, '').trim();
                    fmDesc = (fmLines.find(l => /^description\s*:/i.test(l)) ?? '').replace(/^description\s*:\s*/i, '').replace(/['"]/g, '').trim();
                    bodyStart = fmEnd + 2;
                  }
                }
                const bodyLines = lines.slice(bodyStart);
                const headingLine = bodyLines.find(l => /^#+\s/.test(l));
                const fallbackName = file.slug.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
                const name = fmName || (headingLine ? headingLine.replace(/^#+\s*/, '').trim() : fallbackName);
                const description = fmDesc || bodyLines.find(l => l.trim() && !l.startsWith('#') && !l.startsWith('```') && !l.startsWith('---') && !l.startsWith('<!--'))?.trim() || `From ${repo.full_name}`;
                return {
                  id: `gh-${repo.owner.login}-${file.slug}`,
                  name,
                  description: description.substring(0, 200),
                  category: inferCategory(content, file.slug),
                  tools: inferTools(content),
                  promptTemplate: bodyLines.join('\n').trim(),
                  repoUrl: `${repo.html_url}/blob/${repo.default_branch}/${file.path}`,
                  sourceRepo: repo.full_name,
                  stars: repo.stargazers_count,
                };
              } catch { return null; }
            }

            // ── Fetch anthropics skills: auto-discover {category}/skills/{slug}/SKILL.md ──
            const anthropicsSkills: ParsedSkill[] = [];
            if (anchor) {
              try {
                const rootData = await ghApi(`/repos/${anchor.owner.login}/${anchor.name}/contents/?ref=${anchor.default_branch}`) as unknown;
                const devCategoryDirs = Array.isArray(rootData)
                  ? (rootData as Entry[]).filter(e => e.type === 'dir' && !NON_DEV.has(e.name))
                  : [];

                const categorySkillFiles = await Promise.allSettled(devCategoryDirs.map(async (catDir) => {
                  const files: SkillFile[] = [];
                  try {
                    const skillsDirData = await ghApi(`/repos/${anchor.owner.login}/${anchor.name}/contents/${catDir.name}/skills?ref=${anchor.default_branch}`) as unknown;
                    if (!Array.isArray(skillsDirData)) return files;
                    const skillSubDirs = (skillsDirData as Entry[]).filter(e => e.type === 'dir');
                    await Promise.allSettled(skillSubDirs.map(async skillDir => {
                      try {
                        const fileList = await ghApi(`/repos/${anchor.owner.login}/${anchor.name}/contents/${skillDir.path}?ref=${anchor.default_branch}`) as unknown;
                        if (!Array.isArray(fileList)) return;
                        const mdFiles = (fileList as Entry[]).filter(e => e.type === 'file' && e.name.endsWith('.md') && e.download_url);
                        const pick = mdFiles.find(e => e.name.toUpperCase() === 'SKILL.MD') ?? mdFiles[0];
                        if (pick) files.push({ slug: skillDir.name, downloadUrl: pick.download_url!, path: pick.path });
                      } catch { /* skip */ }
                    }));
                  } catch { /* no skills dir */ }
                  return files;
                }));

                const allAnthropicsFiles = categorySkillFiles
                  .filter(r => r.status === 'fulfilled')
                  .flatMap(r => (r as PromiseFulfilledResult<SkillFile[]>).value);

                const parsed = await Promise.allSettled(allAnthropicsFiles.map(f => parseSkillFile(f, anchor!, false)));
                parsed.forEach(r => { if (r.status === 'fulfilled' && r.value) anthropicsSkills.push(r.value); });
              } catch { /* anthropics fetch failed, continue with community */ }
            }

            // ── Fetch community skills: generic scan dirs ─────────────────────
            async function getCommunitySkillFiles(repo: RepoItem): Promise<SkillFile[]> {
              for (const dir of ['_skills', 'skills', '.claude/skills', 'prompts']) {
                try {
                  const data = await ghApi(`/repos/${repo.owner.login}/${repo.name}/contents/${dir}?ref=${repo.default_branch}`) as unknown;
                  if (!Array.isArray(data)) continue;
                  const entries = data as Entry[];
                  const directMd = entries.filter(f => f.type === 'file' && f.name.endsWith('.md') && f.download_url);
                  if (directMd.length > 0) return directMd.map(f => ({ slug: f.name.replace('.md', ''), downloadUrl: f.download_url!, path: f.path }));
                  const subDirs = entries.filter(f => f.type === 'dir');
                  if (subDirs.length > 0) {
                    const nested = await Promise.allSettled(subDirs.map(async sub => {
                      try {
                        const subData = await ghApi(`/repos/${repo.owner.login}/${repo.name}/contents/${sub.path}?ref=${repo.default_branch}`) as unknown;
                        if (!Array.isArray(subData)) return [] as SkillFile[];
                        const mdFiles = (subData as Entry[]).filter(f => f.type === 'file' && f.name.endsWith('.md') && f.download_url);
                        const pick = mdFiles.find(f => f.name.toUpperCase() === 'SKILL.MD') ?? mdFiles[0];
                        return pick ? [{ slug: sub.name, downloadUrl: pick.download_url!, path: pick.path }] : [] as SkillFile[];
                      } catch { return [] as SkillFile[]; }
                    }));
                    const files = nested.filter(r => r.status === 'fulfilled').flatMap(r => (r as PromiseFulfilledResult<SkillFile[]>).value);
                    if (files.length > 0) return files;
                  }
                } catch { continue; }
              }
              return [];
            }

            const communitySkills: ParsedSkill[] = [];
            const topCommunity = communityRepos.slice(0, 8);
            const communityFileResults = await Promise.allSettled(topCommunity.map(r => getCommunitySkillFiles(r)));
            const communityParsePromises: Promise<ParsedSkill | null>[] = [];
            for (let i = 0; i < topCommunity.length; i++) {
              const repo = topCommunity[i];
              const fr = communityFileResults[i];
              if (fr.status !== 'fulfilled') continue;
              for (const file of fr.value) communityParsePromises.push(parseSkillFile(file, repo, true));
            }
            const communityParsed = await Promise.allSettled(communityParsePromises);
            communityParsed.forEach(r => { if (r.status === 'fulfilled' && r.value) communitySkills.push(r.value); });

            // Anthropics skills first, then community (deduped by slug)
            const seenSlugs = new Set(anthropicsSkills.map(s => s.id));
            const skills: ParsedSkill[] = [
              ...anthropicsSkills,
              ...communitySkills.filter(s => !seenSlugs.has(s.id)),
            ];

            jsonOk(res, { ok: true, skills, trendingSince: dateStr });
          } catch (e) { jsonOk(res, { ok: false, error: String(e) }); }
        });

        // ── Exec: spawn claude in a project dir and stream output via SSE ────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/exec/run', (req: any, res: any) => {
          if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
          if (req.method !== 'POST') { res.statusCode = 405; res.end('Method Not Allowed'); return; }

          let body = '';
          req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          req.on('end', async () => {
            try {
              const { cwd, prompt } = JSON.parse(body || '{}') as { cwd?: string; prompt?: string };
              if (!cwd) { res.statusCode = 400; res.end('Missing cwd'); return; }

              res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.flushHeaders?.();

              function send(type: string, text?: string, code?: number) {
                const payload = JSON.stringify(code !== undefined ? { type, code } : { type, text });
                res.write(`data: ${payload}\n\n`);
              }

              const { spawn } = await import('node:child_process');
              const isWin = process.platform === 'win32';

              const proc = spawn('claude', [], {
                cwd,
                // shell:true resolves .cmd files on Windows and respects PATH everywhere
                shell: true,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
                ...(isWin ? { windowsHide: true } : {}),
              });

              // Feed prompt via stdin so it works regardless of quote escaping
              if (prompt) {
                proc.stdin.write(prompt + '\n');
              }
              proc.stdin.end();

              proc.stdout.on('data', (chunk: Buffer) => {
                send('stdout', chunk.toString().replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
              });
              proc.stderr.on('data', (chunk: Buffer) => {
                send('stderr', chunk.toString().replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
              });
              proc.on('close', (code: number | null) => {
                send('exit', undefined, code ?? 0);
                res.end();
              });
              proc.on('error', (err: Error) => {
                send('stderr', `spawn error: ${err.message}`);
                send('exit', undefined, 1);
                res.end();
              });

              // Kill child when client disconnects
              req.on('close', () => { try { proc.kill(); } catch { /* ignore */ } });

            } catch (e) {
              if (!res.headersSent) { res.statusCode = 500; res.end(String(e)); }
              else { res.end(); }
            }
          });
        });

        // ── QC (image quality check for PGDs) ────────────────────────────────
        const qcConfigFilePath = path.join(process.cwd(), 'agent-qc-config.json');
        const qcResultsFilePath = path.join(process.cwd(), 'agent-qc-results.json');

        function loadQcConfig(): Record<string, string> {
          try { return fs.existsSync(qcConfigFilePath) ? JSON.parse(fs.readFileSync(qcConfigFilePath, 'utf-8')) : {}; }
          catch { return {}; }
        }
        function loadQcResults(): Record<string, unknown> {
          try { return fs.existsSync(qcResultsFilePath) ? JSON.parse(fs.readFileSync(qcResultsFilePath, 'utf-8')) : {}; }
          catch { return {}; }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/data/qc-config', async (req: any, res: any) => {
          if (req.method === 'GET') { jsonOk(res, { ok: true, data: loadQcConfig() }); return; }
          if (req.method === 'POST') {
            const raw = await readBody(req);
            try {
              fs.writeFileSync(qcConfigFilePath, JSON.stringify(JSON.parse(raw || '{}'), null, 2), 'utf-8');
              jsonOk(res, { ok: true });
            } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) })); }
            return;
          }
          res.statusCode = 405; res.end();
        });

        // GET /api/qc/pgds?sheet=T06.2026
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/qc/pgds', (req: any, res: any) => {
          const qs = ((req.url as string) ?? '').split('?')[1] ?? '';
          const params = new URLSearchParams(qs);
          const cfg = loadQcConfig();
          const excelPath = params.get('excelPath') || cfg.excelPath || '';
          const sheetParam = params.get('sheet') || cfg.excelSheet || '';

          if (!excelPath || !fs.existsSync(excelPath)) {
            jsonOk(res, { ok: true, pgds: [], sheets: [] }); return;
          }
          try {
            // Step 1: Get sheet names fast (no cell data)
            const wbMeta = XLSX.readFile(excelPath, { bookSheets: true });
            const sheets: string[] = wbMeta.SheetNames;
            const targetSheet = (sheetParam && sheets.includes(sheetParam))
              ? sheetParam
              : sheets.find((s: string) => /^T\d{2}\.\d{4}$/.test(s)) || sheets[0];

            // Step 2: Read ONLY the target sheet, limit rows AND columns
            // File has 16,373 cols (mostly empty); PGD data is in first 13. Column limit is critical for performance.
            const wb2 = XLSX.readFile(excelPath, {
              sheets: targetSheet,
              sheetRows: 1200,
              cellDates: false,
              cellNF: false,
            });
            const ws2 = wb2.Sheets[targetSheet];
            if (!ws2) { jsonOk(res, { ok: true, pgds: [], sheets, sheet: targetSheet }); return; }
            if (ws2['!ref']) {
              const colRange = XLSX.utils.decode_range(ws2['!ref']);
              colRange.e.c = Math.min(colRange.e.c, 15); // cap at col 15 (0-based)
              ws2['!ref'] = XLSX.utils.encode_range(colRange);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const raw: any[][] = XLSX.utils.sheet_to_json(ws2, { header: 1, defval: null });

            let headerIdx = -1;
            for (let i = 0; i < Math.min(raw.length, 10); i++) {
              if (raw[i]?.some((c: unknown) => String(c || '').trim() === 'Mã PGD')) { headerIdx = i; break; }
            }
            if (headerIdx === -1) { jsonOk(res, { ok: true, pgds: [], sheets, sheet: targetSheet }); return; }

            const headers: string[] = (raw[headerIdx] as unknown[]).map(h => String(h || '').trim());
            const ci = (name: string) => headers.findIndex(h => h.includes(name));
            const ciLast = (name: string) => headers.map((h, i) => h.includes(name) ? i : -1).filter(i => i >= 0).at(-1) ?? -1;

            const maPGDCol = ci('Mã PGD');
            const pgds = [];
            for (let i = headerIdx + 1; i < raw.length; i++) {
              const row = raw[i];
              if (!row?.[maPGDCol]) continue;
              const trangThai = String(row[ci('Trạng thái')] || '').trim();
              if (trangThai !== 'Active') continue;
              pgds.push({
                stt: row[0],
                tenPGD: String(row[ci('Tên PGD')] || '').trim(),
                maPGD: String(row[maPGDCol] || '').trim(),
                trangThai,
                mien: String(row[ci('Miền')] || '').trim(),
                tenVung: String(row[ci('Tên vùng')] || '').trim(),
                phanVung: String(row[ci('Phân vùng')] || '').trim(),
                tenKV: String(row[ciLast('Tên KV')] || '').trim(),
                maKV: String(row[ciLast('Mã KV')] ?? row[ciLast('Mã vùng')] ?? '').trim(),
              });
            }
            jsonOk(res, { ok: true, pgds, sheets, sheet: targetSheet });
          } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) })); }
        });

        // POST /api/qc/scan  { weekStart: 'YYYY-MM-DD' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/qc/scan', async (req: any, res: any) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
          const raw = await readBody(req);
          try {
            const { weekStart } = JSON.parse(raw || '{}') as { weekStart?: string };
            const cfg = loadQcConfig();
            const imagesRoot = cfg.imagesFolderPath || '';
            if (!imagesRoot || !fs.existsSync(imagesRoot)) {
              jsonOk(res, { ok: true, submissions: {}, weekDates: [] }); return;
            }
            const start = weekStart ? new Date(weekStart + 'T00:00:00') : (() => {
              const d = new Date(); d.setHours(0, 0, 0, 0);
              const day = d.getDay(); d.setDate(d.getDate() - (day === 0 ? 6 : day - 1)); return d;
            })();
            const weekDates: string[] = Array.from({ length: 7 }, (_, i) => {
              const d = new Date(start); d.setDate(d.getDate() + i); return d.toISOString().slice(0, 10);
            });
            const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic']);
            const submissions: Record<string, Record<string, string[]>> = {};
            try {
              for (const pgdDir of fs.readdirSync(imagesRoot, { withFileTypes: true }).filter(e => e.isDirectory())) {
                const maPGD = pgdDir.name;
                submissions[maPGD] = {};
                for (const date of weekDates) {
                  const datePath = path.join(imagesRoot, maPGD, date);
                  if (fs.existsSync(datePath) && fs.statSync(datePath).isDirectory()) {
                    submissions[maPGD][date] = fs.readdirSync(datePath)
                      .filter(f => IMG_EXTS.has(path.extname(f).toLowerCase()))
                      .map(f => `${maPGD}/${date}/${f}`);
                  } else {
                    const flat = path.join(imagesRoot, maPGD);
                    submissions[maPGD][date] = fs.existsSync(flat)
                      ? fs.readdirSync(flat).filter(f => IMG_EXTS.has(path.extname(f).toLowerCase()) && f.includes(date)).map(f => `${maPGD}/${f}`)
                      : [];
                  }
                }
              }
            } catch { /* ignore */ }
            jsonOk(res, { ok: true, submissions, weekDates });
          } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) })); }
        });

        // GET /api/qc/image?path=maPGD/date/file.jpg
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/qc/image', (req: any, res: any) => {
          const qs2 = ((req.url as string) ?? '').split('?')[1] ?? '';
          const cfg = loadQcConfig();
          const imgRelPath = new URLSearchParams(qs2).get('path') || '';
          const imagesRoot = cfg.imagesFolderPath || '';
          if (!imagesRoot || !imgRelPath) { res.statusCode = 400; res.end(); return; }
          const fullPath = path.join(imagesRoot, imgRelPath);
          if (!fs.existsSync(fullPath)) { res.statusCode = 404; res.end(); return; }
          const ext = path.extname(fullPath).toLowerCase();
          const mime: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic' };
          res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          fs.createReadStream(fullPath).pipe(res);
        });

        // POST /api/qc/check-image { imagePath, prompt }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/qc/check-image', async (req: any, res: any) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
          const raw = await readBody(req);
          try {
            const { imagePath, prompt: checkPrompt } = JSON.parse(raw || '{}') as { imagePath?: string; prompt?: string };
            const cfg = loadQcConfig();
            const imagesRoot = cfg.imagesFolderPath || '';
            const apiKey = cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY || '';
            if (!apiKey) { jsonOk(res, { ok: false, error: 'Chưa cấu hình Anthropic API key trong QC Settings.' }); return; }
            if (!imagePath) { jsonOk(res, { ok: false, error: 'Thiếu đường dẫn ảnh.' }); return; }
            const fullPath = path.join(imagesRoot, imagePath);
            if (!fs.existsSync(fullPath)) { jsonOk(res, { ok: false, error: 'Không tìm thấy file ảnh.' }); return; }

            const ext = path.extname(fullPath).toLowerCase();
            const mediaMap: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
            const mediaType = mediaMap[ext] || 'image/jpeg';
            const imageData = fs.readFileSync(fullPath).toString('base64');

            const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
              body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 600,
                system: 'Bạn là QC kiểm tra hình ảnh PGD (Phòng Giao Dịch). Trả về JSON: {"passed":true/false,"notes":"nhận xét tiếng Việt","issues":["vấn đề 1"]}. Chỉ trả JSON, không thêm text khác.',
                messages: [{ role: 'user', content: [
                  { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageData } },
                  { type: 'text', text: checkPrompt || 'Kiểm tra hình ảnh này có hợp lệ không, mô tả những gì bạn thấy.' },
                ]}],
              }),
            });
            if (!apiResponse.ok) {
              const errText = await apiResponse.text();
              jsonOk(res, { ok: false, error: `API lỗi ${apiResponse.status}: ${errText}` }); return;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const apiData = await apiResponse.json() as any;
            const content = String(apiData.content?.[0]?.text || '');
            let parsed: { passed: boolean; notes: string; issues: string[] } = { passed: false, notes: content, issues: [] };
            try { const m = content.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch { /* use raw */ }
            jsonOk(res, { ok: true, result: parsed });
          } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) })); }
        });

        // GET /api/qc/results  •  POST /api/qc/save-result { key, result }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/qc/results', async (req: any, res: any) => {
          if (req.method === 'GET') { jsonOk(res, { ok: true, data: loadQcResults() }); return; }
          if (req.method === 'POST') {
            const raw = await readBody(req);
            try {
              const { key, result } = JSON.parse(raw || '{}') as { key: string; result: unknown };
              const all = loadQcResults();
              // key = "maPGD||date||imagePath"
              const [maPGD, date, imgPath] = key.split('||');
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if (!all[maPGD]) (all as any)[maPGD] = {};
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if (!(all as any)[maPGD][date]) (all as any)[maPGD][date] = {};
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (all as any)[maPGD][date][imgPath] = result;
              fs.writeFileSync(qcResultsFilePath, JSON.stringify(all, null, 2), 'utf-8');
              jsonOk(res, { ok: true });
            } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) })); }
            return;
          }
          res.statusCode = 405; res.end();
        });

        // ── AI QC (integrated from ai_QC_f88) ────────────────────────────────
        const aiQcConfigFilePath = path.join(process.cwd(), 'agent-ai-qc-config.json');
        const aiQcResultsFilePath = path.join(process.cwd(), 'agent-ai-qc-results.json');

        function loadAiQcConfig(): Record<string, string> {
          try { return fs.existsSync(aiQcConfigFilePath) ? JSON.parse(fs.readFileSync(aiQcConfigFilePath, 'utf-8')) : {}; }
          catch { return {}; }
        }
        function loadAiQcResults(): Record<string, unknown> {
          try { return fs.existsSync(aiQcResultsFilePath) ? JSON.parse(fs.readFileSync(aiQcResultsFilePath, 'utf-8')) : {}; }
          catch { return {}; }
        }

        const AI_QC_PROMPT = `Bạn là chuyên viên kiểm toán ảnh báo cáo tuần của một đội nhân viên thực hiện tương tác Google AI Overview.

DANH SÁCH ẢNH ĐÃ UPLOAD (theo thứ tự):
{file_list}

═══════════════════════════════════════
QUY TRÌNH ĐÁNH GIÁ (theo đúng thứ tự)
═══════════════════════════════════════

Bước 1:
Xác định đây có phải ảnh điện thoại hay không.
Nếu không phải: status="KHÔNG ĐẠT", error_type="Thao tác trên máy tính". Không kiểm tra bước tiếp theo.

Bước 2:
Kiểm tra có phải Google AI Overview hay không.
Google AI Overview là tính năng tóm tắt AI xuất hiện TRONG kết quả tìm kiếm Google (google.com).
Đặc điểm: có nhãn "AI Overview" hoặc "Tổng quan về AI", phía dưới có kết quả tìm kiếm thông thường.
KHÔNG phải nếu: Giao diện Gemini, ChatGPT, Copilot, hoặc Google không có khối AI Overview.
Nếu không phải: status="KHÔNG ĐẠT", error_type="Hình không liên quan".

Bước 3:
Kiểm tra mạng. 4G hoặc 5G => đạt. Wifi hoặc khác => error_type="Không đủ điều kiện".

Bước 4:
Kiểm tra có tương tác: Like đã bấm HOẶC Dislike đã bấm HOẶC Có follow up question.
Nếu không có: error_type="Không đủ điều kiện".

Bước 5:
Sau khi xử lý toàn bộ ảnh, chỉ kiểm tra trùng lặp giữa CÁC ẢNH ĐÃ ĐẠT Bước 1-4 trong batch này.
Ảnh đã bị loại ở Bước 1-4 KHÔNG tham gia so trùng và không được coi là ảnh gốc.
Nếu hai ảnh đạt trùng nhau thì ảnh xuất hiện sau bị lỗi "Hình bị trùng lặp".

═══════════════════════════════════════
PHÂN LOẠI LỖI: Thao tác trên máy tính | Hình bị trùng lặp | Hình không liên quan | Không đủ điều kiện
═══════════════════════════════════════

api_file_name: BẮT BUỘC lấy đúng display_name. Không tự sinh. Không dùng api_id.

Output phải là JSON hợp lệ. Không markdown. Không \`\`\`json. Không giải thích.

Schema:
{
  "total_images_processed":0,
  "detailed_report":[{
    "api_file_name":"",
    "status":"",
    "error_type":null,
    "is_duplicate":false,
    "confidence":100,
    "extracted_info":{"timestamp":"","battery":"","network":""},
    "reason":""
  }]
}`;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/ai-qc/config', async (req: any, res: any) => {
          if (req.method === 'GET') { jsonOk(res, { ok: true, data: loadAiQcConfig() }); return; }
          if (req.method === 'POST') {
            const raw = await readBody(req);
            try {
              fs.writeFileSync(aiQcConfigFilePath, JSON.stringify(JSON.parse(raw || '{}'), null, 2), 'utf-8');
              jsonOk(res, { ok: true });
            } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) })); }
            return;
          }
          res.statusCode = 405; res.end();
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/ai-qc/units', (req: any, res: any) => {
          if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
          const cfg = loadAiQcConfig();
          const inputDir = cfg.inputDir || '';
          if (!inputDir || !fs.existsSync(inputDir)) { jsonOk(res, { ok: true, units: [] }); return; }
          const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
          try {
            const units = fs.readdirSync(inputDir, { withFileTypes: true })
              .filter(e => e.isDirectory())
              .map(e => {
                const unitPath = path.join(inputDir, e.name);
                let dateCount = 0, imgCount = 0;
                try {
                  for (const dayEntry of fs.readdirSync(unitPath, { withFileTypes: true })) {
                    if (!dayEntry.isDirectory()) continue;
                    dateCount++;
                    imgCount += fs.readdirSync(path.join(unitPath, dayEntry.name))
                      .filter((f: string) => IMG_EXTS.has(path.extname(f).toLowerCase())).length;
                  }
                } catch { /* skip */ }
                return { name: e.name, dateCount, imgCount };
              });
            jsonOk(res, { ok: true, units });
          } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) })); }
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/ai-qc/run', async (req: any, res: any) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
          const raw = await readBody(req);
          try {
            const { units: selectedUnits } = JSON.parse(raw || '{}') as { units?: string[] };
            const cfg = loadAiQcConfig();
            const inputDir = cfg.inputDir || '';
            const apiKey = cfg.apiKey || '';
            const model = cfg.model || 'gemini-2.5-flash';
            const baseUrl = cfg.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai/';
            if (!apiKey) { jsonOk(res, { ok: false, error: 'Chưa cấu hình API key.' }); return; }
            if (!inputDir || !fs.existsSync(inputDir)) { jsonOk(res, { ok: false, error: 'Thư mục input không tồn tại.' }); return; }

            const runId = `aiqc-${Date.now()}`;
            aiQcRuns.set(runId, { buffer: [], done: false, clients: [] });
            jsonOk(res, { ok: true, runId });

            setImmediate(async () => {
              const state = aiQcRuns.get(runId)!;
              const emit = (data: object) => {
                const line = `data: ${JSON.stringify(data)}\n\n`;
                state.buffer.push(line);
                state.clients.forEach(c => { try { c.write(line); } catch { /* ignore */ } });
              };

              const IMG_EXTS2 = new Set(['.png', '.jpg', '.jpeg', '.webp']);
              type TaskImg = { name: string; fullPath: string };
              type AiTask = { unit: string; date: string; images: TaskImg[] };
              const tasks: AiTask[] = [];
              for (const unitName of (selectedUnits || [])) {
                const unitPath = path.join(inputDir, unitName);
                if (!fs.existsSync(unitPath)) continue;
                for (const dayEntry of fs.readdirSync(unitPath, { withFileTypes: true })) {
                  if (!dayEntry.isDirectory()) continue;
                  const dayPath = path.join(unitPath, dayEntry.name);
                  const images = fs.readdirSync(dayPath)
                    .filter((f: string) => IMG_EXTS2.has(path.extname(f).toLowerCase()))
                    .sort()
                    .map((f: string) => ({ name: f, fullPath: path.join(dayPath, f) }));
                  if (images.length > 0) tasks.push({ unit: unitName, date: dayEntry.name, images });
                }
              }

              emit({ type: 'start', total: tasks.length });

              // Duplicate detection is done per image AFTER validity is known (see the loop below):
              // only images that pass QC are remembered as "originals" (MD5 per unit, across days).
              type QcReport = {
                api_file_name: string; status: string; error_type: string | null; is_duplicate: boolean;
                confidence: number; extracted_info: { timestamp: string; battery: string; network: string }; reason: string;
              };
              type SeenEntry = { date: string; valid: boolean; report: QcReport };
              const seenByUnit = new Map<string, Map<string, SeenEntry>>(); // unit -> hash -> entry
              // Process oldest day first so "original" = earliest valid image.
              tasks.sort((a, b) => a.unit.localeCompare(b.unit) || a.date.localeCompare(b.date));

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const allResults = loadAiQcResults() as Record<string, Record<string, any>>;
              const chatUrl = baseUrl.replace(/\/$/, '') + '/chat/completions';
              const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
              const MAX_RETRY = 3;
              const BASE_RETRY_DELAY_MS = 15000;

              for (let i = 0; i < tasks.length; i++) {
                const task = tasks[i];
                const taskKey = `${task.unit}/${task.date}`;
                emit({ type: 'progress', index: i, unit: task.unit, date: task.date, total: tasks.length });
                try {
                  const seen = seenByUnit.get(task.unit) ?? new Map<string, SeenEntry>();
                  seenByUnit.set(task.unit, seen);
                  const reports = new Map<string, QcReport>();
                  const emptyInfo = { timestamp: '', battery: '', network: '' };
                  const md5Of = (p: string) => { try { return createHash('md5').update(fs.readFileSync(p)).digest('hex'); } catch { return ''; } };

                  // 1) Pre-filter by hash BEFORE calling AI: identical to an earlier VALID image => duplicate;
                  //    identical to an earlier INVALID image => reuse that verdict. Only the rest go to AI.
                  const toAi: TaskImg[] = [];
                  const hashOf = new Map<string, string>();
                  const leaderByHash = new Map<string, string>(); // same-day identical files: first one goes to AI
                  const followers: { img: TaskImg; leader: string }[] = [];
                  for (const img of task.images) {
                    const hash = md5Of(img.fullPath);
                    hashOf.set(img.name, hash);
                    const prev = hash ? seen.get(hash) : undefined;
                    if (prev) {
                      reports.set(img.name, prev.valid
                        ? { api_file_name: img.name, status: 'KHÔNG ĐẠT', error_type: 'Hình bị trùng lặp', is_duplicate: true, confidence: 100, extracted_info: emptyInfo, reason: `Hình đã xuất hiện hợp lệ trong ngày ${prev.date}` }
                        : { ...prev.report, api_file_name: img.name, reason: `Giống hệt ảnh ngày ${prev.date} đã không đạt: ${prev.report.reason}` });
                      continue;
                    }
                    if (hash && leaderByHash.has(hash)) { followers.push({ img, leader: leaderByHash.get(hash)! }); continue; }
                    if (hash) leaderByHash.set(hash, img.name);
                    toAi.push(img);
                  }

                  // 2) Ask AI only about the remaining images.
                  if (toAi.length > 0) {
                    const fileList = toAi.map((img, idx) => `${idx + 1}. display_name=${img.name}`).join('\n');
                    const promptText = AI_QC_PROMPT.replace('{file_list}', fileList);
                    const content: unknown[] = [{ type: 'text', text: promptText }];
                    for (const img of toAi) {
                      const ext = path.extname(img.fullPath).toLowerCase();
                      const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
                      const b64 = fs.readFileSync(img.fullPath).toString('base64');
                      content.push({ type: 'image_url', image_url: { url: `data:${mimeMap[ext] || 'image/jpeg'};base64,${b64}` } });
                    }
                    let aiResult: { detailed_report?: QcReport[] } | null = null;
                    let lastErr: Error | null = null;
                    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
                      try {
                        const apiResp = await fetch(chatUrl, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                          body: JSON.stringify({ model, messages: [{ role: 'user', content }], temperature: 0 }),
                        });
                        if (!apiResp.ok) {
                          const errText = await apiResp.text();
                          // Parse retry delay from 429/503 response
                          const retryAfter = apiResp.headers.get('Retry-After');
                          const retryMatch = errText.match(/retry[_ ]?after[": ]+(\d+(?:\.\d+)?)/i) || errText.match(/(\d+(?:\.\d+)?)\s*s\b/i);
                          const waitSec = retryAfter
                            ? parseInt(retryAfter) + 2
                            : retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 2 : BASE_RETRY_DELAY_MS / 1000 * (attempt + 1);
                          lastErr = new Error(`API ${apiResp.status}: ${errText.slice(0, 300)}`);
                          if (attempt < MAX_RETRY - 1) {
                            emit({ type: 'retry', unit: task.unit, date: task.date, attempt: attempt + 1, waitSec });
                            await sleep(waitSec * 1000);
                          }
                          continue;
                        }
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const apiData = await apiResp.json() as any;
                        let rawContent: string = apiData.choices?.[0]?.message?.content || '';
                        rawContent = rawContent.trim().replace(/^```json\n?/, '').replace(/^```\n?/, '').replace(/\n?```$/, '').trim();
                        aiResult = JSON.parse(rawContent);
                        lastErr = null;
                        break;
                      } catch (e) {
                        lastErr = e as Error;
                        if (attempt < MAX_RETRY - 1) {
                          const waitSec = BASE_RETRY_DELAY_MS / 1000 * (attempt + 1);
                          emit({ type: 'retry', unit: task.unit, date: task.date, attempt: attempt + 1, waitSec });
                          await sleep(waitSec * 1000);
                        }
                      }
                    }
                    if (lastErr) throw lastErr;

                    const byName = new Map((aiResult?.detailed_report ?? []).map(r => [r.api_file_name, r]));
                    for (const img of toAi) {
                      const rep: QcReport = byName.get(img.name) ?? {
                        api_file_name: img.name, status: 'KHÔNG ĐẠT', error_type: 'Không đủ điều kiện', is_duplicate: false,
                        confidence: 0, extracted_info: emptyInfo, reason: 'AI không trả kết quả cho ảnh này',
                      };
                      reports.set(img.name, rep);
                      // Only VALID images become "originals" for duplicate checks. Invalid ones are remembered
                      // (to reuse the verdict for identical files) except AI-flagged duplicates, which say nothing about the file itself.
                      const hash = hashOf.get(img.name);
                      const valid = rep.status === 'ĐẠT';
                      if (hash && !seen.has(hash) && (valid || !rep.is_duplicate)) {
                        seen.set(hash, { date: task.date, valid, report: rep });
                      }
                    }
                  }

                  // 3) Same-day identical files follow their leader's verdict.
                  for (const { img, leader } of followers) {
                    const lr = reports.get(leader)!;
                    reports.set(img.name, lr.status === 'ĐẠT'
                      ? { api_file_name: img.name, status: 'KHÔNG ĐẠT', error_type: 'Hình bị trùng lặp', is_duplicate: true, confidence: 100, extracted_info: emptyInfo, reason: `Trùng với ảnh ${leader} cùng ngày` }
                      : { ...lr, api_file_name: img.name, reason: `Giống hệt ảnh ${leader} cùng ngày: ${lr.reason}` });
                  }

                  const result = {
                    total_images_processed: task.images.length,
                    detailed_report: task.images.map(img => reports.get(img.name)!),
                  };
                  if (!allResults[task.unit]) allResults[task.unit] = {};
                  allResults[task.unit][task.date] = result;
                  fs.writeFileSync(aiQcResultsFilePath, JSON.stringify(allResults, null, 2), 'utf-8');
                  emit({ type: 'result', unit: task.unit, date: task.date, data: result });
                  // Small inter-request delay to avoid rate limits
                  if (i < tasks.length - 1) await sleep(3000);
                } catch (err) {
                  emit({ type: 'error', unit: task.unit, date: task.date, message: String(err) });
                }
              }
              emit({ type: 'done', total: tasks.length });
              state.done = true;
            });
          } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) })); }
        });

        // GET /api/ai-qc/stream?runId=xxx  (SSE)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/ai-qc/stream', (req: any, res: any) => {
          if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
          const qs = ((req.url as string) ?? '').split('?')[1] ?? '';
          const runId = new URLSearchParams(qs).get('runId') || '';
          const state = aiQcRuns.get(runId);
          if (!state) { res.statusCode = 404; res.end(); return; }
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          for (const line of state.buffer) { try { res.write(line); } catch { /* ignore */ } }
          if (state.done) { res.end(); return; }
          const client: SseClient = { write: (s: string) => res.write(s), end: () => res.end() };
          state.clients.push(client);
          req.on('close', () => { state.clients.splice(state.clients.indexOf(client), 1); });
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/ai-qc/results', async (req: any, res: any) => {
          if (req.method === 'GET') { jsonOk(res, { ok: true, data: loadAiQcResults() }); return; }
          if (req.method === 'DELETE') {
            try {
              fs.writeFileSync(aiQcResultsFilePath, '{}', 'utf-8');
              jsonOk(res, { ok: true });
            } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) })); }
            return;
          }
          res.statusCode = 405; res.end();
        });

        // ── Báo cáo QC AEO (bố cục theo mẫu QC_AEO_Txx_yyyy.xlsx) ─────────────────
        // POST /api/ai-qc/report { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } -> .xlsx
        // Nguồn: kết quả AI QC (agent-ai-qc-results.json) + danh sách PGD từ Excel org chart (QC settings).
        const AEO_REGIONS: { name: string; code: string; target: number }[] = [
          { name: 'Bắc Trung Bộ', code: 'BTB', target: 400 }, { name: 'Đông Bắc Bộ', code: 'ĐBB', target: 400 },
          { name: 'Hà Nội', code: 'HN', target: 400 }, { name: 'Tây Bắc Bộ', code: 'TBB', target: 200 },
          { name: 'Đông Nam Bộ', code: 'ĐNB', target: 400 }, { name: 'Hồ Chí Minh 1', code: 'HCM1', target: 400 },
          { name: 'Hồ Chí Minh 2', code: 'HCM2', target: 400 }, { name: 'Tây Nam Bộ 1', code: 'TNB1', target: 200 },
          { name: 'Tây Nam Bộ 2', code: 'TNB2', target: 200 }, { name: 'Nam Trung Bộ', code: 'NTB', target: 400 },
          { name: 'Trung Bộ', code: 'TB', target: 400 },
        ];
        // Màu theo chữ số sau dấu chấm của "Khu vực x.y" (giống mẫu)
        const AEO_KV_PALETTE: Record<number, [string, string]> = {
          1: ['EBF3FC', '1F5C99'], 2: ['FFF9C4', '856404'], 3: ['E8F5E9', '1A7A1A'], 4: ['FBE9E7', 'BF360C'],
          5: ['F3E5F5', '6A1B9A'], 6: ['E0F7FA', '006064'], 7: ['FFF3E0', 'E65100'], 8: ['F9FBE7', '558B2F'], 9: ['FCE4EC', '880E4F'],
        };
        const AEO_ERR_PHRASE: Record<string, string> = {
          'Hình bị trùng lặp': 'hình ảnh bị trùng lặp',
          'Hình không liên quan': 'hình ảnh không liên quan',
          'Thao tác trên máy tính': 'thực hiện trên máy tính',
          'Không đủ điều kiện': 'không đủ điều kiện',
        };
        const aeoNorm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
        const aeoIsoDate = (s: string): string => {
          const a = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
          if (a) return `${a[1]}-${a[2].padStart(2, '0')}-${a[3].padStart(2, '0')}`;
          const b = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
          if (b) return `${b[3]}-${b[2].padStart(2, '0')}-${b[1].padStart(2, '0')}`;
          return '';
        };
        // "Loại" (từ khóa) suy ra từ tên thư mục đơn vị / tên ảnh; không có thì để trống.
        const aeoKeywordType = (text: string): string => {
          const t = text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase();
          if (/dia.?phuong|(^|[^a-z0-9])dp([^a-z0-9]|$)/.test(t)) return 'Từ khóa địa phương';
          if (/chung/.test(t)) return 'Từ khóa chung';
          return '';
        };

        function loadOrgPgds(): { maPGD: string; tenPGD: string; phanVung: string; tenKV: string }[] {
          const cfg = loadQcConfig();
          const excelPath = cfg.excelPath || '';
          if (!excelPath || !fs.existsSync(excelPath)) return [];
          const sheets: string[] = XLSX.readFile(excelPath, { bookSheets: true }).SheetNames;
          const target = (cfg.excelSheet && sheets.includes(cfg.excelSheet)) ? cfg.excelSheet
            : sheets.find((s: string) => /^T\d{2}\.\d{4}$/.test(s)) || sheets[0];
          const ws = XLSX.readFile(excelPath, { sheets: target, sheetRows: 1200, cellDates: false, cellNF: false }).Sheets[target];
          if (!ws) return [];
          if (ws['!ref']) {
            const rg = XLSX.utils.decode_range(ws['!ref']); rg.e.c = Math.min(rg.e.c, 15); ws['!ref'] = XLSX.utils.encode_range(rg);
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
          let hi = -1;
          for (let i = 0; i < Math.min(raw.length, 10); i++) {
            if (raw[i]?.some((c: unknown) => String(c || '').trim() === 'Mã PGD')) { hi = i; break; }
          }
          if (hi < 0) return [];
          const headers = (raw[hi] as unknown[]).map(h => String(h || '').trim());
          const ci = (n: string) => headers.findIndex(h => h.includes(n));
          const ciLast = (n: string) => headers.map((h, i) => h.includes(n) ? i : -1).filter(i => i >= 0).at(-1) ?? -1;
          const cMa = ci('Mã PGD'), cTen = ci('Tên PGD'), cTt = ci('Trạng thái'), cVung = ci('Phân vùng'), cKv = ciLast('Tên KV');
          const out: { maPGD: string; tenPGD: string; phanVung: string; tenKV: string }[] = [];
          for (let i = hi + 1; i < raw.length; i++) {
            const r = raw[i];
            if (!r?.[cMa]) continue;
            if (String(r[cTt] || '').trim() !== 'Active') continue;
            out.push({
              maPGD: String(r[cMa]).trim(), tenPGD: String(r[cTen] || r[cMa]).trim(),
              phanVung: String(r[cVung] || '').replace(/\s+/g, ' ').trim(), tenKV: String(r[cKv] || '').trim(),
            });
          }
          return out;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/ai-qc/report', async (req: any, res: any) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
          try {
            const { from = '', to = '' } = JSON.parse((await readBody(req)) || '{}') as { from?: string; to?: string };
            const fromIso = aeoIsoDate(from), toIso = aeoIsoDate(to);
            if (!fromIso || !toIso || fromIso > toIso) { jsonOk(res, { ok: false, error: 'Khoảng ngày không hợp lệ.' }); return; }
            const pgds = loadOrgPgds();
            if (pgds.length === 0) { jsonOk(res, { ok: false, error: 'Không đọc được danh sách PGD — kiểm tra đường dẫn Excel org chart trong QC Settings.' }); return; }

            // unit -> PGD
            const byCode = new Map(pgds.map(p => [aeoNorm(p.maPGD), p]));
            const byName = new Map(pgds.map(p => [aeoNorm(p.tenPGD), p]));
            const findPgd = (unit: string) => {
              const u = aeoNorm(unit);
              return byCode.get(u) ?? byName.get(u) ?? byCode.get(u.split(/[.\s_-]/)[0]);
            };

            // Aggregate AI QC results in range, per PGD, counted in DAYS: a day passes when at least one
            // image that day is valid; a failed day is attributed to its most frequent error type.
            type DayAgg = { pass: boolean; errs: Map<string, number> };
            const dayAgg = new Map<string, { days: Map<string, DayAgg>; typeText: string }>(); // maPGD -> days
            const unmatched: string[] = [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const results = loadAiQcResults() as Record<string, Record<string, any>>;
            for (const [unit, dates] of Object.entries(results)) {
              const pgd = findPgd(unit);
              let used = false;
              for (const [date, result] of Object.entries(dates)) {
                const d = aeoIsoDate(date);
                if (!d || d < fromIso || d > toIso) continue;
                const items = (result?.detailed_report ?? []) as { api_file_name?: string; status?: string; error_type?: string | null }[];
                if (items.length === 0) continue;
                used = true;
                if (!pgd) continue;
                const p = dayAgg.get(pgd.maPGD) ?? { days: new Map<string, DayAgg>(), typeText: unit };
                const day = p.days.get(d) ?? { pass: false, errs: new Map<string, number>() };
                for (const it of items) {
                  if (it.status === 'ĐẠT') day.pass = true;
                  else { const k = it.error_type || 'Không xác định'; day.errs.set(k, (day.errs.get(k) ?? 0) + 1); }
                  p.typeText += ' ' + unit + ' ' + (it.api_file_name ?? '');
                }
                p.days.set(d, day);
                dayAgg.set(pgd.maPGD, p);
              }
              if (used && !pgd) unmatched.push(unit);
            }
            // Ties between error types: the one "closest to valid" wins.
            const ERR_ORDER = ['Không đủ điều kiện', 'Hình bị trùng lặp', 'Hình không liên quan', 'Thao tác trên máy tính'];
            type Agg = { total: number; pass: number; errs: Map<string, number>; typeText: string };
            const agg = new Map<string, Agg>(); // maPGD -> Agg (units = days)
            for (const [ma, p] of dayAgg) {
              const a: Agg = { total: p.days.size, pass: 0, errs: new Map<string, number>(), typeText: p.typeText };
              for (const day of p.days.values()) {
                if (day.pass) { a.pass++; continue; }
                const top = [...day.errs.entries()].sort((x, y) =>
                  y[1] - x[1] || (ERR_ORDER.indexOf(x[0]) + 1 || 99) - (ERR_ORDER.indexOf(y[0]) + 1 || 99))[0];
                const k = top ? top[0] : 'Không xác định';
                a.errs.set(k, (a.errs.get(k) ?? 0) + 1);
              }
              agg.set(ma, a);
            }

            // Group PGDs by region sheet
            const regionOf = (vung: string) => AEO_REGIONS.find(r => aeoNorm(r.name) === aeoNorm(vung));
            const groups = new Map<string, { name: string; code: string; target: number; list: typeof pgds }>();
            for (const r of AEO_REGIONS) groups.set(aeoNorm(r.name), { ...r, list: [] });
            for (const p of pgds) {
              const key = aeoNorm(p.phanVung || 'khác');
              if (!groups.has(key)) {
                const nm = p.phanVung || 'Khác';
                groups.set(key, { name: nm, code: nm.replace(/[\\/?*[\]:]/g, '').slice(0, 31), target: 400, list: [] });
              }
              groups.get(key)!.list.push(p);
            }
            void regionOf;

            const ExcelJS = createRequire(import.meta.url)('exceljs');
            const wb = new ExcelJS.Workbook();
            wb.calcProperties = { fullCalcOnLoad: true };
            const thin =(argb: string) => ({ style: 'thin', color: { argb } });
            const box = (argb: string) => ({ left: thin(argb), right: thin(argb), top: thin(argb), bottom: thin(argb) });
            const fill = (argb: string) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
            const dm = (iso: string) => `${parseInt(iso.slice(8, 10), 10)}/${parseInt(iso.slice(5, 7), 10)}`;
            const toDate = new Date(`${toIso}T00:00:00.000Z`);
            const gradeOf = (pct: number) => pct >= 0.95 ? 'Xuất sắc' : pct >= 0.85 ? 'Tốt' : pct >= 0.7 ? 'Đạt' : 'Không đạt';

            // ── Tổng quan ──
            const ov = wb.addWorksheet('Tổng quan');
            [2.18, 23.45, 16.09, 16.36, 18.73, 18.45, 29.73].forEach((w, i) => { ov.getColumn(i + 1).width = w; });
            ov.mergeCells('B1:G1');
            const t1 = ov.getCell('B1');
            t1.value = `QC NGHIỆM THU AEO THEO VÙNG (${dm(fromIso)} đến ${dm(toIso)}/${toIso.slice(0, 4)})`;
            t1.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' }, name: 'Arial' };
            t1.fill = fill('FF0F2D5E'); t1.alignment = { horizontal: 'center', vertical: 'middle' };
            ov.getRow(1).height = 30;
            const heads: [string, string][] = [['Phân vùng', '0F2D5E'], ['Mẫu QC', '0A7B6C'], ['Hợp lệ', '166534'], ['Không HL', '9B1C1C'], ['%Hợp lệ', '0A7B6C'], ['Xếp loại', '0F2D5E']];
            heads.forEach(([label, color], i) => {
              const c = ov.getCell(2, i + 2);
              c.value = label; c.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' }, name: 'Arial' };
              c.fill = fill('FF' + color); c.alignment = { horizontal: 'center', vertical: 'middle' }; c.border = box('FFE2E8F0');
            });
            ov.getRow(2).height = 25;

            const groupList = [...groups.values()].filter(g => AEO_REGIONS.some(r => r.name === g.name) || g.list.length > 0);
            const ovStart = 3;
            const regionTotals = new Map<string, { total: number; pass: number }>();

            // ── Từng sheet vùng ──
            for (const g of groupList) {
              const ws = wb.addWorksheet(g.code);
              [13, 14, 42, 16, 8, 12, 40, 18].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
              ws.mergeCells('A1:H1');
              const c1 = ws.getCell('A1');
              c1.value = `${g.name}  |  Mục tiêu: ${g.target} mẫu  |  Tháng ${parseInt(toIso.slice(5, 7), 10)}/${toIso.slice(0, 4)}`;
              c1.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' }, name: 'Arial' };
              c1.fill = fill('FF1F5C99'); c1.alignment = { horizontal: 'center', vertical: 'middle' };
              ws.getRow(1).height = 28;
              ['Thời gian', 'Khu vực', 'Tên PGD', 'Số lượng mẫu kiểm tra', 'Đạt', 'Không đạt', 'Note', 'Loại'].forEach((h, i) => {
                const c = ws.getCell(2, i + 1);
                c.value = h; c.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' }, name: 'Arial' };
                c.fill = fill('FF2E75B6'); c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; c.border = box('FFCCCCCC');
              });
              ws.getRow(2).height = 30;
              ws.views = [{ state: 'frozen', ySplit: 2 }];

              // Như mẫu: PGD có mẫu lên đầu (gộp ô "Thời gian"), sau đó PGD chưa có mẫu; mỗi nhóm xếp theo khu vực
              const kvKey = (s: string) => s.replace(/\d+/g, m => m.padStart(4, '0'));
              const ordered = g.list.map((p, i) => ({ p, i, a: agg.get(p.maPGD) }))
                .sort((x, y) => (y.a ? 1 : 0) - (x.a ? 1 : 0) || kvKey(x.p.tenKV).localeCompare(kvKey(y.p.tenKV)) || x.i - y.i);

              let row = 3, sampledRows = 0, gTotal = 0, gPass = 0;
              ordered.forEach(({ p, a }, idx) => {
                const kvMinor = parseInt((p.tenKV.match(/\d+\.(\d+)/) ?? [])[1] ?? '', 10) || (idx % 9) + 1;
                const [kvBg, kvFg] = AEO_KV_PALETTE[((kvMinor - 1) % 9) + 1];
                const band = row % 2 === 1 ? 'FFF5F8FF' : 'FFFFFFFF';
                const notes = a ? [...a.errs.entries()].sort((x, y) => y[1] - x[1])
                  .map(([k, n]) => `${n} mẫu ${AEO_ERR_PHRASE[k] ?? k.toLowerCase()}`).join(', ') : '';
                const vals: unknown[] = [null, p.tenKV, p.tenPGD, a ? a.total : null, a ? a.pass : null, a ? a.total - a.pass : null, notes || null, a ? aeoKeywordType(a.typeText) || null : null];
                vals.forEach((v, i) => {
                  const c = ws.getCell(row, i + 1);
                  c.value = v as never;
                  c.font = { size: 10, name: 'Arial' };
                  c.fill = fill(band); c.border = box('FFCCCCCC');
                  c.alignment = { horizontal: [3, 4, 5].includes(i) ? 'center' : 'left', vertical: 'middle' };
                  if (i === 0) c.alignment = { horizontal: 'center', vertical: 'middle' };
                  if (i === 1) { c.font = { bold: true, size: 10, color: { argb: 'FF' + kvFg }, name: 'Arial' }; c.fill = fill('FF' + kvBg); }
                });
                ws.getRow(row).height = 18;
                if (a) { sampledRows++; gTotal += a.total; gPass += a.pass; }
                row++;
              });
              if (sampledRows > 0) {
                ws.mergeCells(3, 1, 2 + sampledRows, 1);
                const dc = ws.getCell(3, 1);
                dc.value = toDate; dc.numFmt = 'd/m/yyyy';
                dc.alignment = { horizontal: 'center', vertical: 'middle' };
              }
              const totRow = row;
              ws.autoFilter = `A2:H${totRow - 1}`;
              ['C', 'D', 'E', 'F'].forEach((col, i) => {
                const c = ws.getCell(`${col}${totRow}`);
                if (i === 0) { c.value = 'TỔNG'; c.alignment = { horizontal: 'right' }; }
                else {
                  const result = i === 1 ? gTotal : i === 2 ? gPass : gTotal - gPass;
                  c.value = { formula: `SUM(${col}3:${col}${totRow - 1})`, result };
                  c.alignment = { horizontal: 'center' };
                }
                c.font = { bold: true, size: 11, color: { argb: 'FF1F5C99' }, name: 'Arial' };
                c.fill = fill('FFD6E4F7'); c.border = box('FFCCCCCC');
              });
              ws.getRow(totRow).height = 22;
              regionTotals.set(g.code, { total: gTotal, pass: gPass });
            }

            // Điền Tổng quan
            let r = ovStart, sumT = 0, sumP = 0;
            for (const g of groupList) {
              const t = regionTotals.get(g.code) ?? { total: 0, pass: 0 };
              sumT += t.total; sumP += t.pass;
              const pct = t.total > 0 ? t.pass / t.total : 0;
              const cells: [unknown, string, Record<string, unknown>][] = [
                [g.name, '1E293B', { horizontal: 'left', vertical: 'middle', indent: 1 }],
                [t.total, '1E293B', { horizontal: 'center', vertical: 'middle' }],
                [t.pass, '166534', { horizontal: 'center', vertical: 'middle' }],
                [t.total - t.pass, '9B1C1C', { horizontal: 'center', vertical: 'middle' }],
                [{ formula: `IF(C${r}=0,0,D${r}/C${r})`, result: pct }, '1E293B', { horizontal: 'center', vertical: 'middle' }],
                [{ formula: `IF(C${r}=0,"",IF(F${r}>=0.95,"Xuất sắc",IF(F${r}>=0.85,"Tốt",IF(F${r}>=0.7,"Đạt","Không đạt"))))`, result: t.total > 0 ? gradeOf(pct) : '' }, '64748B', { horizontal: 'center', vertical: 'middle' }],
              ];
              cells.forEach(([v, color, al], i) => {
                const c = ov.getCell(r, i + 2);
                c.value = v as never;
                c.font = { size: 11, color: { argb: 'FF' + color }, name: 'Arial', bold: i === 0, italic: i === 5 };
                c.fill = fill('FFFFFFFF'); c.border = box('FFE2E8F0'); c.alignment = al as never;
                if (i === 1 || i === 2 || i === 3) c.numFmt = '0';
                if (i === 4) c.numFmt = '0%';
              });
              ov.getRow(r).height = 20;
              r++;
            }
            const last = r - 1;
            ov.getCell(`C${r}`).value = { formula: `SUM(C${ovStart}:C${last})`, result: sumT };
            ov.getCell(`D${r}`).value = { formula: `SUM(D${ovStart}:D${last})`, result: sumP };
            ov.getCell(`E${r}`).value = { formula: `SUM(E${ovStart}:E${last})`, result: sumT - sumP };
            ov.getCell(`D${r + 1}`).value = { formula: `IF(C${r}=0,0,D${r}/C${r})`, result: sumT > 0 ? sumP / sumT : 0 };
            ov.getCell(`D${r + 1}`).numFmt = '0%';
            ['C', 'D', 'E'].forEach(col => { ov.getCell(`${col}${r}`).font = { bold: true, size: 11, name: 'Arial' }; ov.getCell(`${col}${r}`).alignment = { horizontal: 'center' }; });
            ov.getCell(`D${r + 1}`).font = { bold: true, size: 11, name: 'Arial' };
            ov.getCell(`D${r + 1}`).alignment = { horizontal: 'center' };

            const buf = await wb.xlsx.writeBuffer();
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="QC_AEO_T${toIso.slice(5, 7)}_${toIso.slice(0, 4)}.xlsx"`);
            res.setHeader('X-Qc-Unmatched', encodeURIComponent(JSON.stringify(unmatched)));
            res.setHeader('X-Qc-Sampled', String(agg.size));
            res.setHeader('Access-Control-Expose-Headers', 'X-Qc-Unmatched, X-Qc-Sampled, Content-Disposition');
            res.end(Buffer.from(buf));
          } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) })); }
        });

        // GET /api/ai-qc/export-excel
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/ai-qc/export-excel', (req: any, res: any) => {
          if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const results = loadAiQcResults() as Record<string, Record<string, any>>;
            const headers = ['Đơn vị', 'Ngày', 'Tên ảnh', 'Trạng thái', 'Loại lỗi', 'Trùng lặp', 'Timestamp', 'Pin', 'Mạng', 'Confidence', 'Lý do'];
            const rows: unknown[][] = [headers];
            for (const [unit, dates] of Object.entries(results)) {
              for (const [date, result] of Object.entries(dates)) {
                for (const item of ((result as { detailed_report?: unknown[] })?.detailed_report || [])) {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const it = item as any;
                  const ex = it.extracted_info || {};
                  rows.push([unit, date, it.api_file_name, it.status, it.error_type, it.is_duplicate, ex.timestamp, ex.battery, ex.network, it.confidence, it.reason]);
                }
              }
            }
            const ws = XLSX.utils.aoa_to_sheet(rows);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Result');
            const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="ai-qc-result-${new Date().toISOString().slice(0,10)}.xlsx"`);
            res.end(buf);
          } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) })); }
        });

        // ── Survey ───────────────────────────────────────────────────────────
        const surveysFilePath = path.join(process.cwd(), 'agent-surveys.json');
        function loadSurveys(): unknown[] {
          try { return fs.existsSync(surveysFilePath) ? JSON.parse(fs.readFileSync(surveysFilePath, 'utf-8')) : []; }
          catch { return []; }
        }

        const surveyResponsesFilePath = path.join(process.cwd(), 'agent-survey-responses.json');
        function loadSurveyResponses(): unknown[] {
          try { return fs.existsSync(surveyResponsesFilePath) ? JSON.parse(fs.readFileSync(surveyResponsesFilePath, 'utf-8')) : []; }
          catch { return []; }
        }
        function saveSurveyResponses(data: unknown[]) {
          fs.writeFileSync(surveyResponsesFilePath, JSON.stringify(data, null, 2), 'utf-8');
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/survey-responses', async (req: any, res: any) => {
          const method = (req.method as string).toUpperCase();
          const url = new URL(req.url || '/', 'http://localhost');
          if (method === 'GET') {
            const surveyId = url.searchParams.get('surveyId');
            const all = loadSurveyResponses() as Array<{ surveyId: string }>;
            jsonOk(res, { ok: true, responses: surveyId ? all.filter(r => r.surveyId === surveyId) : all });
            return;
          }
          if (method === 'POST') {
            const raw = await readBody(req);
            try {
              const body = JSON.parse(raw || '{}');
              const all = loadSurveyResponses() as Array<{ id: string; surveyId: string; officeId: string }>;
              const idx = all.findIndex(r => r.surveyId === body.surveyId && r.officeId === body.officeId);
              const record = { ...body, id: idx >= 0 ? all[idx].id : `resp-${Date.now()}`, submittedAt: new Date().toISOString() };
              if (idx >= 0) all[idx] = record; else all.unshift(record);
              saveSurveyResponses(all);
              jsonOk(res, { ok: true, response: record });
            } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) })); }
            return;
          }
          if (method === 'DELETE') {
            const surveyId = url.searchParams.get('surveyId');
            const responseId = url.searchParams.get('id');
            const all = loadSurveyResponses() as Array<{ id: string; surveyId: string }>;
            const filtered = responseId ? all.filter(r => r.id !== responseId) : surveyId ? all.filter(r => r.surveyId !== surveyId) : [];
            saveSurveyResponses(filtered);
            jsonOk(res, { ok: true });
            return;
          }
          res.statusCode = 405; res.end();
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/surveys', async (req: any, res: any, next: any) => {
          if ((req.url || '').startsWith('/sheet')) { next(); return; }
          const method = (req.method as string).toUpperCase();
          if (method === 'GET') { jsonOk(res, { ok: true, surveys: loadSurveys() }); return; }
          if (method === 'POST') {
            const raw = await readBody(req);
            try {
              const body = JSON.parse(raw || '{}');
              const surveys = loadSurveys();
              const survey = { ...body, id: `survey-${Date.now()}`, createdAt: new Date().toISOString() };
              surveys.unshift(survey);
              fs.writeFileSync(surveysFilePath, JSON.stringify(surveys, null, 2), 'utf-8');
              jsonOk(res, { ok: true, survey });
            } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) })); }
            return;
          }
          if (method === 'PATCH') {
            const url = new URL(req.url, 'http://localhost');
            const id = url.searchParams.get('id');
            const raw = await readBody(req);
            try {
              const patch = JSON.parse(raw || '{}');
              const surveys = loadSurveys().map((s: unknown) => {
                const sv = s as { id: string };
                return sv.id === id ? { ...sv, ...patch } : sv;
              });
              fs.writeFileSync(surveysFilePath, JSON.stringify(surveys, null, 2), 'utf-8');
              jsonOk(res, { ok: true });
            } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) })); }
            return;
          }
          if (method === 'DELETE') {
            const url = new URL(req.url, 'http://localhost');
            const id = url.searchParams.get('id');
            try {
              const surveys = loadSurveys().filter((s: unknown) => (s as { id: string }).id !== id);
              fs.writeFileSync(surveysFilePath, JSON.stringify(surveys, null, 2), 'utf-8');
              jsonOk(res, { ok: true });
            } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) })); }
            return;
          }
          res.statusCode = 405; res.end();
        });

        // GET /api/surveys/sheet?url=<google-sheets-url>  — fetch & parse CSV
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/surveys/sheet', async (req: any, res: any) => {
          if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
          const qs = ((req.url as string) ?? '').split('?')[1] ?? '';
          const sheetUrl = new URLSearchParams(qs).get('url') || '';
          if (!sheetUrl) { jsonOk(res, { ok: false, error: 'Thiếu URL' }); return; }

          // Build CSV export URL from any Google Sheets URL or raw Sheet ID
          let csvUrl: string;
          const idMatch = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
          if (idMatch) {
            const gidMatch = sheetUrl.match(/[?&#]gid=(\d+)/);
            csvUrl = `https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=csv&gid=${gidMatch?.[1] ?? '0'}`;
          } else if (/^[a-zA-Z0-9_-]{20,}$/.test(sheetUrl.trim())) {
            csvUrl = `https://docs.google.com/spreadsheets/d/${sheetUrl.trim()}/export?format=csv&gid=0`;
          } else {
            jsonOk(res, { ok: false, error: 'URL không hợp lệ. Nhập link Google Sheets hoặc Sheet ID.' }); return;
          }

          try {
            const resp = await fetch(csvUrl, { headers: { 'Accept': 'text/csv' } });
            if (!resp.ok) {
              const hint = resp.status === 401 || resp.status === 403
                ? ' Kiểm tra quyền chia sẻ: chọn "Anyone with the link" → Viewer.'
                : '';
              jsonOk(res, { ok: false, error: `HTTP ${resp.status}.${hint}` }); return;
            }
            const text = await resp.text();

            // RFC-4180 CSV parser (handles quoted fields with commas + newlines)
            function parseCSV(raw: string): string[][] {
              const out: string[][] = [];
              let row: string[] = [], cur = '', inQ = false;
              for (let i = 0; i < raw.length; i++) {
                const ch = raw[i];
                if (inQ) {
                  if (ch === '"' && raw[i + 1] === '"') { cur += '"'; i++; }
                  else if (ch === '"') { inQ = false; }
                  else { cur += ch; }
                } else {
                  if (ch === '"') { inQ = true; }
                  else if (ch === ',') { row.push(cur); cur = ''; }
                  else if (ch === '\n' || (ch === '\r' && raw[i + 1] === '\n')) {
                    row.push(cur); cur = '';
                    if (row.some(c => c)) out.push(row);
                    row = [];
                    if (ch === '\r') i++;
                  } else { cur += ch; }
                }
              }
              row.push(cur);
              if (row.some(c => c)) out.push(row);
              return out;
            }

            const rows = parseCSV(text);
            if (rows.length === 0) { jsonOk(res, { ok: true, headers: [], rows: [], total: 0 }); return; }
            const headers = rows[0].map(h => h.trim());
            const data = rows.slice(1).map(row => {
              const obj: Record<string, string> = {};
              headers.forEach((h, i) => { obj[h] = (row[i] ?? '').trim(); });
              return obj;
            });
            jsonOk(res, { ok: true, headers, rows: data, total: data.length });
          } catch (e) { jsonOk(res, { ok: false, error: String(e) }); }
        });

        // GET /api/sheet-proxy?url=<google-sheets-url>
        // Separate path to avoid routing conflict with /api/surveys
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/sheet-proxy', async (req: any, res: any) => {
          if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
          const qs = ((req.url as string) ?? '').split('?')[1] ?? '';
          const sheetUrl = new URLSearchParams(qs).get('url') || '';
          if (!sheetUrl) { jsonOk(res, { ok: false, error: 'Thiếu tham số url' }); return; }

          const idMatch = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
          const gidMatch = sheetUrl.match(/[?&#]gid=(\d+)/);
          let sheetId: string, gid: string;
          if (idMatch) {
            sheetId = idMatch[1];
            gid = gidMatch?.[1] ?? '0';
          } else if (/^[a-zA-Z0-9_-]{20,}$/.test(sheetUrl.trim())) {
            sheetId = sheetUrl.trim();
            gid = '0';
          } else {
            jsonOk(res, { ok: false, error: 'URL không hợp lệ. Dán link Google Sheets hoặc Sheet ID.' }); return;
          }

          // Try 3 URL formats in order (gviz/tq is most permissive for public sheets)
          const candidates = [
            `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`,
            `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`,
            `https://docs.google.com/spreadsheets/d/${sheetId}/pub?output=csv&gid=${gid}`,
          ];

          function parseCSV(raw: string): string[][] {
            const out: string[][] = [];
            let row: string[] = [], cur = '', inQ = false;
            for (let i = 0; i < raw.length; i++) {
              const ch = raw[i];
              if (inQ) {
                if (ch === '"' && raw[i + 1] === '"') { cur += '"'; i++; }
                else if (ch === '"') { inQ = false; }
                else { cur += ch; }
              } else {
                if (ch === '"') { inQ = true; }
                else if (ch === ',') { row.push(cur); cur = ''; }
                else if (ch === '\n' || (ch === '\r' && raw[i + 1] === '\n')) {
                  row.push(cur); cur = '';
                  if (row.some(c => c)) out.push(row);
                  row = [];
                  if (ch === '\r') i++;
                } else { cur += ch; }
              }
            }
            row.push(cur);
            if (row.some(c => c)) out.push(row);
            return out;
          }

          let lastError = '';
          for (const csvUrl of candidates) {
            try {
              const resp = await fetch(csvUrl, {
                headers: { 'Accept': 'text/csv,text/plain,*/*', 'User-Agent': 'Mozilla/5.0' },
                redirect: 'follow',
              });
              if (!resp.ok) { lastError = `HTTP ${resp.status} (${csvUrl.includes('gviz') ? 'gviz' : csvUrl.includes('export') ? 'export' : 'pub'})`; continue; }
              const ct = resp.headers.get('content-type') || '';
              const text = await resp.text();
              // Reject HTML (redirect to login page)
              if (ct.includes('text/html') || text.trimStart().startsWith('<!')) {
                lastError = 'Sheet yêu cầu đăng nhập — hãy share "Anyone with the link → Viewer".'; continue;
              }
              const rows = parseCSV(text);
              if (rows.length === 0) { jsonOk(res, { ok: true, headers: [], rows: [], total: 0 }); return; }
              const headers = rows[0].map(h => h.trim());
              const data = rows.slice(1).map(row => {
                const obj: Record<string, string> = {};
                headers.forEach((h, i) => { obj[h] = (row[i] ?? '').trim(); });
                return obj;
              });
              jsonOk(res, { ok: true, headers, rows: data, total: data.length });
              return;
            } catch (e) { lastError = String(e); }
          }
          jsonOk(res, { ok: false, error: lastError || 'Không đọc được sheet. Kiểm tra: Share → Anyone with the link → Viewer.' });
        });

        // ── Facebook Messenger phone-number collector ──────────────────────────
        const fbConfigFilePath = path.join(process.cwd(), 'agent-fb-config.json');
        const fbLeadsFilePath = path.join(process.cwd(), 'agent-fb-leads.json');

        interface FbConfig {
          pageAccessToken: string; // encrypted at rest (enc:v1:...)
          pageId: string;
          pageName: string;
          // Simple flat-interval auto-run, independent of any Task's cron schedule — both can be used at once.
          enabled: boolean;
          pollIntervalMinutes: number;
          autoReplyEnabled: boolean;
          autoReplyMessage: string;
          lastRunAt: string | null;
          lastRunSummary: string | null;
          lastError: string | null;
        }
        interface FbLead {
          id: string; time: string; psid: string; name: string; phone: string; message: string;
        }

        function loadFbConfig(): FbConfig {
          const def: FbConfig = {
            pageAccessToken: '', pageId: '', pageName: '', enabled: false, pollIntervalMinutes: 15,
            autoReplyEnabled: true,
            autoReplyMessage: 'Dạ em đã nhận được số điện thoại của anh/chị, bên em sẽ liên hệ lại sớm ạ!',
            lastRunAt: null, lastRunSummary: null, lastError: null,
          };
          try {
            if (!fs.existsSync(fbConfigFilePath)) return def;
            return { ...def, ...JSON.parse(fs.readFileSync(fbConfigFilePath, 'utf-8')) };
          } catch { return def; }
        }
        function saveFbConfig(cfg: FbConfig) {
          fs.writeFileSync(fbConfigFilePath, JSON.stringify(cfg, null, 2), 'utf-8');
        }
        function loadFbLeads(): { leads: FbLead[]; processedMessageIds: string[] } {
          try {
            if (!fs.existsSync(fbLeadsFilePath)) return { leads: [], processedMessageIds: [] };
            const d = JSON.parse(fs.readFileSync(fbLeadsFilePath, 'utf-8'));
            return { leads: d.leads ?? [], processedMessageIds: d.processedMessageIds ?? [] };
          } catch { return { leads: [], processedMessageIds: [] }; }
        }
        function saveFbLeads(data: { leads: FbLead[]; processedMessageIds: string[] }) {
          // Cap processed-id memory so the file doesn't grow unbounded.
          const trimmed = { leads: data.leads, processedMessageIds: data.processedMessageIds.slice(-3000) };
          fs.writeFileSync(fbLeadsFilePath, JSON.stringify(trimmed, null, 2), 'utf-8');
        }

        function extractPhoneNumbers(text: string): string[] {
          // Người dùng hay gõ nhầm chữ "o"/"O" thay cho số "0" — chấp nhận và chuẩn hóa về "0".
          const withDigits = text.replace(/[oO]/g, '0');
          const cleaned = withDigits.replace(/(\d)[\s.-]+(?=\d)/g, '$1');
          const regex = /(?:\+?84|0)(3[2-9]|5[25689]|7[06-9]|8[1-9]|9[0-9])\d{7}/g;
          const matches = cleaned.match(regex) || [];
          const seen = new Set<string>();
          const result: string[] = [];
          for (const m of matches) {
            const normalized = m.replace(/^\+?84/, '0');
            if (!seen.has(normalized)) { seen.add(normalized); result.push(normalized); }
          }
          return result;
        }

        // Gửi tin nhắn trả lời cho khách qua Messenger Send API. Lỗi gửi không làm hỏng cả lượt poll.
        async function sendFbReply(token: string, psid: string, text: string): Promise<void> {
          const res = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(token)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              recipient: { id: psid },
              message: { text },
              messaging_type: 'RESPONSE',
            }),
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data = await res.json() as any;
          if (data.error) throw new Error(data.error.message || 'Gửi trả lời thất bại');
        }

        // ── Minimal 5-field cron matcher (supports *, N, N-M, */S, N-M/S, comma lists) ──
        function cronFieldMatches(field: string, value: number): boolean {
          if (field === '*') return true;
          return field.split(',').some(part => {
            if (part.includes('/')) {
              const [range, stepStr] = part.split('/');
              const step = parseInt(stepStr, 10) || 1;
              if (range === '*') return value % step === 0;
              const [start, end] = range.includes('-') ? range.split('-').map(Number) : [Number(range), Number(range)];
              return value >= start && value <= end && (value - start) % step === 0;
            }
            if (part.includes('-')) {
              const [start, end] = part.split('-').map(Number);
              return value >= start && value <= end;
            }
            return Number(part) === value;
          });
        }
        function cronMatchesNow(cron: string, d: Date): boolean {
          const parts = cron.trim().split(/\s+/);
          if (parts.length !== 5) return false;
          const [min, hour, dom, mon, dow] = parts;
          return cronFieldMatches(min, d.getMinutes())
            && cronFieldMatches(hour, d.getHours())
            && cronFieldMatches(dom, d.getDate())
            && cronFieldMatches(mon, d.getMonth() + 1)
            && cronFieldMatches(dow, d.getDay());
        }

        // Mirror a poll run's outcome onto every fb_phone_collector Task so it shows on the Kanban board.
        function syncFbTasks(result: { ok: boolean; newLeads: number; conversationsChecked: number; error?: string }) {
          try {
            if (!fs.existsSync(tasksFilePath)) return;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tasksData = JSON.parse(fs.readFileSync(tasksFilePath, 'utf-8')) as Record<string, any>;
            const now = new Date().toISOString();
            let changed = false;
            for (const t of Object.values(tasksData)) {
              if (t.taskKind !== 'fb_phone_collector') continue;
              changed = true;
              t.status = result.ok ? 'done' : 'failed';
              t.progress = 100;
              t.failReason = result.ok ? undefined : result.error;
              t.updatedAt = now;
              t.terminal = t.terminal ?? {};
              t.terminal.isRunning = false;
              t.terminal.completedAt = now;
              t.terminal.logs = [
                ...(t.terminal.logs ?? []),
                {
                  id: `fb-log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                  timestamp: now,
                  type: result.ok ? 'success' : 'error',
                  content: result.ok
                    ? `Tìm thấy ${result.newLeads} SĐT mới trong ${result.conversationsChecked} hội thoại.`
                    : `Lỗi: ${result.error}`,
                },
              ].slice(-200); // bound log growth
            }
            if (changed) fs.writeFileSync(tasksFilePath, JSON.stringify(tasksData, null, 2), 'utf-8');
          } catch { /* best-effort — never let task sync break the poll itself */ }
        }

        async function runFbPoll(): Promise<{ ok: boolean; newLeads: number; conversationsChecked: number; error?: string }> {
          const cfg = loadFbConfig();
          const token = decryptEnvValue(cfg.pageAccessToken, getMcpEncryptKey());
          if (!token) {
            const err = 'Chưa cấu hình Page Access Token.';
            cfg.lastRunAt = new Date().toISOString(); cfg.lastError = err; saveFbConfig(cfg);
            const result = { ok: false, newLeads: 0, conversationsChecked: 0, error: err };
            syncFbTasks(result);
            return result;
          }
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (!cfg.pageId) {
              const meRes = await fetch(`https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${encodeURIComponent(token)}`);
              const me = await meRes.json() as any;
              if (me.error) throw new Error(me.error.message || 'Token không hợp lệ');
              cfg.pageId = me.id; cfg.pageName = me.name;
            }

            const { leads, processedMessageIds } = loadFbLeads();
            const processedSet = new Set(processedMessageIds);
            let newLeads = 0;
            let conversationsChecked = 0;
            let url: string | null =
              `https://graph.facebook.com/v19.0/me/conversations?fields=unread_count,messages.limit(25){message,from,created_time,id}&limit=25&access_token=${encodeURIComponent(token)}`;

            // Follow at most 3 pages of conversations per run to bound work.
            for (let page = 0; url && page < 3; page++) {
              const res = await fetch(url);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const data = await res.json() as any;
              if (data.error) throw new Error(data.error.message || 'Lỗi gọi Graph API');
              for (const convo of data.data ?? []) {
                // Chỉ xử lý hội thoại chưa đọc — nếu admin đã tự trả lời/đánh dấu đã đọc thì bỏ qua.
                if (!((convo.unread_count ?? 0) > 0)) continue;
                conversationsChecked++;
                for (const msg of convo.messages?.data ?? []) {
                  if (!msg.id || processedSet.has(msg.id)) continue;
                  processedSet.add(msg.id);
                  if (!msg.message || msg.from?.id === cfg.pageId) continue;
                  const phones = extractPhoneNumbers(msg.message);
                  for (const phone of phones) {
                    leads.push({
                      id: msg.id, time: msg.created_time || new Date().toISOString(),
                      psid: msg.from?.id || '', name: msg.from?.name || '',
                      phone, message: msg.message,
                    });
                    newLeads++;
                  }
                  if (phones.length > 0 && cfg.autoReplyEnabled && msg.from?.id) {
                    try { await sendFbReply(token, msg.from.id, cfg.autoReplyMessage); } catch { /* best-effort */ }
                  }
                }
              }
              url = data.paging?.next ?? null;
            }

            leads.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
            saveFbLeads({ leads, processedMessageIds: Array.from(processedSet) });

            cfg.lastRunAt = new Date().toISOString();
            cfg.lastRunSummary = `Tìm thấy ${newLeads} SĐT mới trong ${conversationsChecked} hội thoại.`;
            cfg.lastError = null;
            saveFbConfig(cfg);
            const result = { ok: true, newLeads, conversationsChecked };
            syncFbTasks(result);
            return result;
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            cfg.lastRunAt = new Date().toISOString(); cfg.lastError = err; saveFbConfig(cfg);
            const result = { ok: false, newLeads: 0, conversationsChecked: 0, error: err };
            syncFbTasks(result);
            return result;
          }
        }

        // Every minute, check every fb_phone_collector Task's cron (agentConfig.schedule) and fire a poll if due.
        function checkFbCronTasks() {
          try {
            if (!fs.existsSync(tasksFilePath)) return;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tasksData = JSON.parse(fs.readFileSync(tasksFilePath, 'utf-8')) as Record<string, any>;
            const now = new Date();
            const minuteKey = now.toISOString().slice(0, 16);
            let shouldRun = false;
            for (const t of Object.values(tasksData)) {
              if (t.taskKind !== 'fb_phone_collector') continue;
              const cron = t.agentConfig?.schedule;
              if (!cron) continue;
              if (fbCronFiredMinutes.get(t.id) === minuteKey) continue;
              if (cronMatchesNow(cron, now)) {
                fbCronFiredMinutes.set(t.id, minuteKey);
                shouldRun = true;
              }
            }
            if (shouldRun) runFbPoll().catch(() => {});
          } catch { /* ignore */ }
        }
        if (fbCronTimer) clearInterval(fbCronTimer);
        fbCronTimer = setInterval(checkFbCronTasks, 60_000);

        // Flat-interval auto-run, toggled directly from the SĐT Facebook settings panel.
        function scheduleFbPoll() {
          if (fbIntervalTimer) { clearInterval(fbIntervalTimer); fbIntervalTimer = null; }
          const cfg = loadFbConfig();
          if (cfg.enabled && cfg.pollIntervalMinutes > 0) {
            fbIntervalTimer = setInterval(() => { runFbPoll().catch(() => {}); }, cfg.pollIntervalMinutes * 60 * 1000);
          }
        }
        scheduleFbPoll();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/fb/config', async (req: any, res: any) => {
          if (req.method === 'GET') {
            const cfg = loadFbConfig();
            jsonOk(res, {
              ok: true,
              pageId: cfg.pageId, pageName: cfg.pageName, hasToken: !!cfg.pageAccessToken,
              enabled: cfg.enabled, pollIntervalMinutes: cfg.pollIntervalMinutes,
              autoReplyEnabled: cfg.autoReplyEnabled, autoReplyMessage: cfg.autoReplyMessage,
              lastRunAt: cfg.lastRunAt, lastRunSummary: cfg.lastRunSummary, lastError: cfg.lastError,
            });
            return;
          }
          if (req.method === 'POST') {
            const raw = await readBody(req);
            try {
              const body = JSON.parse(raw || '{}') as {
                pageAccessToken?: string; enabled?: boolean; pollIntervalMinutes?: number;
                autoReplyEnabled?: boolean; autoReplyMessage?: string;
              };
              const cfg = loadFbConfig();
              if (body.pageAccessToken) {
                cfg.pageAccessToken = encryptEnvValue(body.pageAccessToken, getMcpEncryptKey());
                cfg.pageId = ''; cfg.pageName = ''; // re-resolve from the new token on next run
              }
              if (typeof body.enabled === 'boolean') cfg.enabled = body.enabled;
              if (typeof body.pollIntervalMinutes === 'number' && body.pollIntervalMinutes > 0) {
                cfg.pollIntervalMinutes = body.pollIntervalMinutes;
              }
              if (typeof body.autoReplyEnabled === 'boolean') cfg.autoReplyEnabled = body.autoReplyEnabled;
              if (typeof body.autoReplyMessage === 'string' && body.autoReplyMessage.trim()) {
                cfg.autoReplyMessage = body.autoReplyMessage.trim();
              }
              saveFbConfig(cfg);
              scheduleFbPoll();
              if (cfg.enabled) runFbPoll().catch(() => {}); // immediate feedback when turning automation on
              jsonOk(res, { ok: true });
            } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) })); }
            return;
          }
          res.statusCode = 405; res.end();
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/fb/run', async (req: any, res: any) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
          const result = await runFbPoll();
          jsonOk(res, result);
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use('/api/fb/leads', (req: any, res: any) => {
          if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
          const { leads } = loadFbLeads();
          jsonOk(res, { ok: true, leads });
        });

      },
    },
  ],
  server: { port: 5199 },
});
