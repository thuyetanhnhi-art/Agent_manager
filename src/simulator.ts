import { LogEntry, LogType, TaskLabel, TodoItem } from './types';

let _idCounter = 0;
function newId() { return `log-${++_idCounter}`; }

export function makeLog(type: LogType, content: string, extra?: Partial<LogEntry>): LogEntry {
  return { id: newId(), timestamp: new Date(), type, content, ...extra };
}

interface SimScript {
  delay: number;
  log: LogEntry;
  tokens?: { input?: number; output?: number; cacheRead?: number };
  progress?: number;
}

// ── Rich log helpers ──────────────────────────────────────────────────────────

function toolRead(filePath: string, lineRange?: string): LogEntry {
  return makeLog('tool_call', filePath, { toolName: 'Read', filePath, lineRange });
}
function toolEdit(filePath: string, linesAdded: number, diffPreview?: string[]): LogEntry {
  return makeLog('tool_call', filePath, { toolName: 'Edit', filePath, linesAdded, diffPreview });
}
function toolWrite(filePath: string, linesAdded: number): LogEntry {
  return makeLog('tool_call', filePath, { toolName: 'Write', filePath, linesAdded });
}
function toolBash(command: string): LogEntry {
  return makeLog('tool_call', command, { toolName: 'Bash' });
}
function toolGlob(pattern: string): LogEntry {
  return makeLog('tool_call', pattern, { toolName: 'Glob' });
}
function toolGrep(pattern: string, path: string): LogEntry {
  return makeLog('tool_call', `${pattern} in ${path}`, { toolName: 'Grep' });
}
function toolResult(content: string, duration: number): LogEntry {
  return makeLog('tool_result', content, { duration });
}
function thinking(content: string): LogEntry {
  return makeLog('thinking', content);
}
function info(content: string): LogEntry {
  return makeLog('info', content);
}
function success(content: string): LogEntry {
  return makeLog('success', content);
}
function err(content: string): LogEntry {
  return makeLog('error', content);
}

// Generic arg-style tool call (legacy path, kept for compat)
function toolCall(name: string, args: string): LogEntry {
  return makeLog('tool_call', args, { toolName: name });
}

export function buildScript(title: string, willFail: boolean, files: string[] = [], hasContext = false): SimScript[] {
  const lower = title.toLowerCase();
  const isBuild = /build|implement|create|develop/.test(lower);
  const isSearch = /search|find|query|lookup/.test(lower);
  const isAnalyze = /analy|audit|review|check/.test(lower);

  const srcFiles = files.filter(f => /\.(ts|tsx|js|jsx|py|go|cs|java|vue|svelte|rs|rb|php)$/.test(f));
  const cfgFiles = files.filter(f => /package\.json|tsconfig|vite\.config|webpack|\.env|Makefile|Dockerfile/.test(f));
  const anyFiles = [...srcFiles, ...cfgFiles, ...files.filter(f => !srcFiles.includes(f) && !cfgFiles.includes(f))];

  const pick = (arr: string[], fallback: string) => arr[Math.floor(Math.random() * Math.max(arr.length, 1))] ?? fallback;
  const f0 = pick(srcFiles, 'src/index.ts');
  const f1 = pick(srcFiles.filter(f => f !== f0), 'src/utils.ts');
  const f2 = pick(srcFiles.filter(f => f !== f0 && f !== f1), 'src/types.ts');
  const cfg = pick(cfgFiles, 'package.json');
  const totalFiles = anyFiles.length || 18;

  // When hasContext=true (subtask with parent analysis), skip project scan.
  // s = time saved vs full scan intro (3200ms); subsequent step delays are reduced by s.
  const s = hasContext ? 2600 : 0;

  const script: SimScript[] = hasContext ? [
    { delay: 0,   log: makeLog('system', `Task started`), tokens: { input: 120 } },
    { delay: 300, log: info(`Using cached project context — ${totalFiles} files indexed`), tokens: { cacheRead: 2400 } },
    { delay: 600, log: thinking(`Context loaded. Planning implementation for: "${title}"`), tokens: { input: 180, output: 80 } },
  ] : [
    { delay: 0,    log: makeLog('system', `Task started`), tokens: { input: 320 } },
    { delay: 400,  log: info(`Reading task context and requirements...`), tokens: { input: 180 } },
    { delay: 900,  log: thinking(`Understanding the task scope: "${title}"`), tokens: { input: 240, output: 80 } },
    { delay: 1400, log: thinking(`Identifying required tools and resources...`), tokens: { output: 120 } },
    { delay: 2000, log: toolRead(cfg, '1-30'), tokens: { cacheRead: 1200 } },
    { delay: 2400, log: toolResult(`Found ${totalFiles} source files`, 380) },
    { delay: 2800, log: toolRead(f0, `1-${40 + Math.floor(Math.random() * 200)}`), tokens: { cacheRead: 800 } },
    { delay: 3200, log: toolResult(`File read (${40 + Math.floor(Math.random() * 200)} lines)`, 290) },
  ];

  if (isSearch || isBuild || isAnalyze) {
    script.push(
      { delay: 3600 - s, log: toolGrep(title.slice(0, 30), 'src/'), tokens: { input: 300 } },
      { delay: 4200 - s, log: toolResult(`Found 6 matches across 4 files`, 580) },
      { delay: 4700 - s, log: thinking(`Planning implementation strategy based on search results...`), tokens: { output: 280, cacheRead: 800 } },
    );
  }

  if (isBuild) {
    const newFile = f1.replace(/\.(ts|tsx|js|jsx)$/, '') + '_new.' + (f1.split('.').pop() ?? 'ts');
    const testFile = f0.replace(/src\//, 'src/__tests__/').replace(/\.(ts|tsx)$/, '.test.$1').replace(/\.(js|jsx)$/, '.test.$1');
    const addedLines = 80 + Math.floor(Math.random() * 80);
    const newFileLines = 40 + Math.floor(Math.random() * 60);
    script.push(
      { delay: 5400 - s, log: info(`Drafting initial implementation...`), tokens: { input: 400, output: 600 } },
      { delay: 6000 - s, log: toolRead(f1, `1-${50 + Math.floor(Math.random() * 150)}`), tokens: { cacheRead: 900 } },
      { delay: 6400 - s, log: toolResult(`File read (${50 + Math.floor(Math.random() * 150)} lines)`, 320) },
      { delay: 6800 - s, log: thinking(`Applying changes to ${f0}...`), tokens: { output: 340, cacheRead: 2400 } },
      { delay: 7600 - s, log: toolEdit(f0, addedLines, [
          `+ export function ${title.replace(/\s+/g, '')}Handler() {`,
          `+   // Implementation`,
          `+   return result;`,
          `+ }`,
        ]), tokens: { input: 200 } },
      { delay: 8300 - s, log: toolResult(`File updated`, 680), progress: 20 },
      { delay: 8700 - s, log: toolWrite(newFile, newFileLines), tokens: { input: 160 } },
      { delay: 9400 - s, log: toolResult(`File created (${newFileLines} lines)`, 640), progress: 35 },
      { delay: 9800 - s, log: info(`Running type checks...`), tokens: { input: 280 } },
      { delay: 10300 - s, log: toolBash(`tsc --noEmit`), tokens: { input: 120 } },
    );
    if (willFail) {
      script.push(
        { delay: 11000 - s, log: toolResult(`TypeScript error in ${f0} line ${10 + Math.floor(Math.random() * 50)}: Type mismatch`, 680), progress: 35 },
        { delay: 11400 - s, log: err(`Compilation failed — aborting task`) },
      );
    } else {
      script.push(
        { delay: 11000 - s, log: toolResult(`No type errors found`, 680), progress: 50 },
        { delay: 11500 - s, log: thinking(`Writing unit tests...`), tokens: { output: 420, cacheRead: 1800 } },
        { delay: 12200 - s, log: toolWrite(testFile, 60 + Math.floor(Math.random() * 40)), tokens: { input: 180 } },
        { delay: 12900 - s, log: toolResult(`Test file created`, 640), progress: 65 },
        { delay: 13400 - s, log: toolBash(`npm test -- --passWithNoTests`), tokens: { input: 120 } },
        { delay: 14200 - s, log: toolResult(`Tests passed: ${8 + Math.floor(Math.random() * 10)}/${8 + Math.floor(Math.random() * 10)} (0 failures)`, 780), progress: 80 },
        { delay: 14700 - s, log: info(`Updating documentation...`), tokens: { input: 240, output: 380 } },
        { delay: 15500 - s, log: toolEdit('README.md', 48), tokens: { input: 100 } },
        { delay: 16100 - s, log: toolResult(`README updated`, 580), progress: 95 },
        { delay: 16600 - s, log: success(`Task completed successfully`), progress: 100 },
      );
    }
  } else if (isAnalyze) {
    script.push(
      { delay: 5200 - s, log: info(`Scanning codebase for patterns...`), tokens: { input: 380, cacheRead: 3200 } },
      { delay: 6000 - s, log: toolRead(f2, `1-${80 + Math.floor(Math.random() * 160)}`), tokens: { cacheRead: 1600 } },
      { delay: 6600 - s, log: toolResult(`File read (${80 + Math.floor(Math.random() * 160)} lines)`, 560), progress: 25 },
      { delay: 7100 - s, log: thinking(`Identifying issues and improvement areas...`), tokens: { output: 480 } },
      { delay: 7900 - s, log: toolRead(f1, `1-${60 + Math.floor(Math.random() * 120)}`), tokens: { cacheRead: 1400 } },
      { delay: 8400 - s, log: toolResult(`File read (${60 + Math.floor(Math.random() * 120)} lines)`, 480), progress: 45 },
    );
    if (willFail) {
      script.push(
        { delay: 9000 - s, log: err(`Access denied: cannot read config — missing credentials`) },
        { delay: 9400 - s, log: err(`Task aborted due to permission error`) },
      );
    } else {
      script.push(
        { delay: 9000 - s, log: thinking(`Generating audit report...`), tokens: { output: 640, cacheRead: 2000 } },
        { delay: 9800 - s, log: toolWrite('reports/audit.md', 120 + Math.floor(Math.random() * 60)), tokens: { input: 200 } },
        { delay: 10600 - s, log: toolResult(`Audit report written`, 780), progress: 85 },
        { delay: 11100 - s, log: success(`Analysis complete — see reports/audit.md`), progress: 100 },
      );
    }
  } else {
    script.push(
      { delay: 5100 - s, log: thinking(`Processing information and forming response...`), tokens: { output: 560, cacheRead: 1200 } },
      { delay: 6000 - s, log: info(`Executing primary task logic...`), tokens: { input: 320, output: 440 } },
      { delay: 6900 - s, log: success(`Task completed`), progress: 100 },
    );
  }

  return script;
}

export type SimCallback = {
  onLog: (entry: LogEntry) => void;
  onTokens: (delta: { input?: number; output?: number; cacheRead?: number }) => void;
  onProgress: (p: number) => void;
  onTick: (ms: number) => void;
  onComplete: (success: boolean) => void;
};

export function runSimulation(
  title: string,
  willFail: boolean,
  cb: SimCallback,
  files: string[] = [],
  hasContext = false,
): () => void {
  const script = buildScript(title, willFail, files, hasContext);
  const timers: ReturnType<typeof setTimeout>[] = [];
  const lastItem = script[script.length - 1];
  const totalMs = lastItem.delay + 800;
  const success = !willFail;

  script.forEach(item => {
    const t = setTimeout(() => {
      cb.onLog(item.log);
      if (item.tokens) cb.onTokens(item.tokens);
      if (item.progress !== undefined) cb.onProgress(item.progress);
    }, item.delay);
    timers.push(t);
  });

  const tickInterval = setInterval(() => cb.onTick(500), 500);

  const finalTimer = setTimeout(() => {
    cb.onComplete(success);
    clearInterval(tickInterval);
  }, totalMs);
  timers.push(finalTimer);

  return () => {
    timers.forEach(clearTimeout);
    clearInterval(tickInterval);
  };
}

export function runSubtasksSequentially(
  subtasks: Array<{ id: string; title: string }>,
  files: string[],
  cbs: {
    onStart: (id: string) => void;
    onLog: (id: string, entry: LogEntry) => void;
    onTokens: (id: string, delta: { input?: number; output?: number; cacheRead?: number }) => void;
    onTick: (id: string, ms: number) => void;
    onComplete: (id: string, success: boolean) => void;
    onAllDone: (allSuccess: boolean) => void;
  },
): () => void {
  let stopped = false;
  let currentStop: (() => void) | null = null;
  let idx = 0;

  function next() {
    if (stopped || idx >= subtasks.length) {
      if (!stopped) cbs.onAllDone(true);
      return;
    }
    const { id, title } = subtasks[idx];
    cbs.onStart(id);
    currentStop = runSimulation(title, false, {
      onLog: entry => cbs.onLog(id, entry),
      onTokens: delta => cbs.onTokens(id, delta),
      onProgress: () => {},
      onTick: ms => cbs.onTick(id, ms),
      onComplete: s => {
        cbs.onComplete(id, s);
        idx++;
        if (!stopped) {
          if (s) next();
          else cbs.onAllDone(false);
        }
      },
    }, files, true);
  }

  next();
  return () => { stopped = true; currentStop?.(); };
}

export type AnalysisCallback = {
  onLog: (log: { type: string; content: string; toolName?: string; filePath?: string; lineRange?: string; linesAdded?: number; diffPreview?: string[] }) => void;
  onTodos: (todos: Array<{ title: string; description: string; priority: string }>) => void;
  onComplete: () => void;
};

/**
 * Simulate the analysis phase: reads project files step-by-step, then emits a checklist.
 * Used as fallback when /api/analyze-stream is unavailable.
 */
export function simulateAnalysis(
  title: string,
  description: string,
  repoPath: string,
  cb: AnalysisCallback,
): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;

  const schedule = (delay: number, fn: () => void) => {
    const t = setTimeout(() => { if (!stopped) fn(); }, delay);
    timers.push(t);
  };

  const lower = (title + ' ' + description).toLowerCase();
  const hasRedis = /redis|cache/i.test(lower);
  const hasApi = /api|endpoint|controller/i.test(lower);
  const hasUi = /ui|component|page|screen/i.test(lower);

  const claudeMd = repoPath ? `${repoPath}/CLAUDE.md` : 'CLAUDE.md';
  const packageJson = repoPath ? `${repoPath}/package.json` : 'package.json';
  const srcDir = 'src/';

  schedule(0,    () => cb.onLog({ type: 'system', content: 'Analysis started' }));
  schedule(300,  () => cb.onLog({ type: 'tool_call', content: claudeMd, toolName: 'Read', filePath: claudeMd, lineRange: '1-80' }));
  schedule(700,  () => cb.onLog({ type: 'tool_result', content: 'Project conventions loaded (80 lines)' }));
  schedule(1100, () => cb.onLog({ type: 'tool_call', content: packageJson, toolName: 'Read', filePath: packageJson, lineRange: '1-40' }));
  schedule(1500, () => cb.onLog({ type: 'tool_result', content: 'Dependencies read' }));
  schedule(1900, () => cb.onLog({ type: 'thinking', content: `Understanding requirements: "${title}"` }));
  schedule(2400, () => cb.onLog({ type: 'tool_call', content: `**/*.ts in ${srcDir}`, toolName: 'Glob' }));
  schedule(2800, () => cb.onLog({ type: 'tool_result', content: `Found ${12 + Math.floor(Math.random() * 20)} source files` }));
  schedule(3200, () => {
    const pattern = hasRedis ? 'redis|cache' : hasApi ? 'Controller|Service' : hasUi ? 'Component|Page' : title.split(' ')[0];
    cb.onLog({ type: 'tool_call', content: `${pattern} in ${srcDir}`, toolName: 'Grep' });
  });
  schedule(3700, () => cb.onLog({ type: 'tool_result', content: 'Found 8 relevant references' }));
  schedule(4200, () => cb.onLog({ type: 'thinking', content: 'Mapping affected files and planning subtasks...' }));

  // Read 2-3 key source files
  const candidates = hasRedis
    ? ['src/common/redis/redis.service.ts', 'src/config/redis.config.ts']
    : hasApi
    ? ['src/app.module.ts', 'src/common/decorators/index.ts']
    : hasUi
    ? ['src/components/index.ts', 'src/hooks/index.ts']
    : ['src/app.module.ts', 'src/main.ts'];

  schedule(4700, () => cb.onLog({ type: 'tool_call', content: candidates[0], toolName: 'Read', filePath: candidates[0], lineRange: '1-60' }));
  schedule(5200, () => cb.onLog({ type: 'tool_result', content: `Read ${candidates[0].split('/').pop()} (60 lines)` }));
  schedule(5700, () => cb.onLog({ type: 'tool_call', content: candidates[1], toolName: 'Read', filePath: candidates[1], lineRange: '1-45' }));
  schedule(6100, () => cb.onLog({ type: 'tool_result', content: `Read ${candidates[1].split('/').pop()} (45 lines)` }));
  schedule(6500, () => cb.onLog({ type: 'thinking', content: 'Analysis complete. Building implementation plan...' }));

  // Emit todos and complete
  schedule(7000, () => {
    const subtasks = generateSubtasks(title, description);
    cb.onTodos(subtasks.map(s => ({ title: s.title, description: s.description, priority: s.priority })));
    cb.onComplete();
  });

  return () => { stopped = true; timers.forEach(clearTimeout); };
}

export function generateSubtasks(title: string, description: string, projectName?: string): Array<{
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  label: TaskLabel;
}> {
  // Fallback subtask generator (used when backend is offline).
  // Produces file-level implementation checklists, NOT analysis phases.
  const lower = (title + ' ' + description).toLowerCase();
  const p = projectName ?? 'project';

  // Infer a module/domain name from the title keywords
  const moduleMatch = lower.match(/\b(campaign|user|auth|order|product|payment|notification|redis|cache|email|report|workflow|task|job|queue|webhook)\b/);
  const mod = moduleMatch?.[1] ?? 'feature';
  const svc = `src/${mod}/${mod}`;


  if (/redis|cache|fallback|restore|sync/i.test(lower)) {
    return [
      { title: `Sửa \`${svc}.service.ts\` — thêm logic fallback khi cache miss`, description: `File: \`${svc}.service.ts\`\n\nChanges:\n- Bọc các lệnh redis.get/set trong try-catch\n- Nếu Redis lỗi/mất data: query từ DB rồi set lại vào Redis\n- Thêm method \`restoreFromDb(key: string)\`\n\nDone when: khi Redis mất data, service tự động lấy từ DB và restore.`, priority: 'critical', label: 'feature' },
      { title: `Sửa \`${svc}.module.ts\` — đăng ký RedisModule và provider`, description: `File: \`${svc}.module.ts\`\n\nChanges:\n- Import RedisModule vào imports[]\n- Đảm bảo CacheService/RedisService được inject đúng\n\nDone when: module compile không lỗi.`, priority: 'high', label: 'feature' },
      { title: `Tạo \`src/common/redis/redis-fallback.helper.ts\` — util helper`, description: `File: \`src/common/redis/redis-fallback.helper.ts\`\n\nChanges:\n- Export async function \`getOrRestoreCache<T>(redis, db, key, fetchFn)\`\n- fetchFn: () => Promise<T> — gọi DB nếu cache miss\n- Set TTL mặc định 300s\n\nDone when: helper có thể dùng trong bất kỳ service nào.`, priority: 'high', label: 'feature' },
      { title: `Sửa \`src/config/redis.config.ts\` — thêm timeout và retry`, description: `File: \`src/config/redis.config.ts\`\n\nChanges:\n- Thêm connectTimeout: 3000, commandTimeout: 2000\n- Thêm retryStrategy: 3 lần trước khi fallback\n\nDone when: config có timeout, không hang khi Redis down.`, priority: 'medium', label: 'chore' },
    ];
  }

  if (/api|endpoint|route|controller/i.test(lower)) {
    return [
      { title: `Tạo \`${svc}.dto.ts\` — định nghĩa request/response types`, description: `File: \`${svc}.dto.ts\`\n\nChanges:\n- Tạo CreateDto và ResponseDto với class-validator decorators\n- Export các interface cần thiết\n\nDone when: DTO compile và validate đúng.`, priority: 'high', label: 'feature' },
      { title: `Sửa \`${svc}.service.ts\` — implement business logic`, description: `File: \`${svc}.service.ts\`\n\nChanges:\n- Thêm method mới theo task description\n- Inject repository/dependencies cần thiết\n- Xử lý error và edge case\n\nDone when: service method trả về đúng data.`, priority: 'critical', label: 'feature' },
      { title: `Sửa \`${svc}.controller.ts\` — thêm route handler`, description: `File: \`${svc}.controller.ts\`\n\nChanges:\n- Thêm @Get/@Post/@Put endpoint mới\n- Gọi service method tương ứng\n- Thêm @ApiOperation và @ApiResponse decorators\n\nDone when: API trả về đúng HTTP status và response body.`, priority: 'critical', label: 'feature' },
      { title: `Sửa \`${svc}.module.ts\` — cập nhật imports/exports`, description: `File: \`${svc}.module.ts\`\n\nChanges:\n- Thêm providers/imports mới nếu cần\n- Đảm bảo module exports đúng\n\nDone when: module load không lỗi.`, priority: 'medium', label: 'chore' },
    ];
  }

  if (/ui|component|page|screen|frontend|view/i.test(lower)) {
    return [
      { title: `Tạo \`src/components/${mod}/${mod}.tsx\` — component chính`, description: `File: \`src/components/${mod}/${mod}.tsx\`\n\nChanges:\n- Tạo React component với props interface\n- Implement UI layout theo design\n- Handle loading/error states\n\nDone when: component render đúng dữ liệu.`, priority: 'critical', label: 'feature' },
      { title: `Sửa \`src/hooks/use${mod.charAt(0).toUpperCase() + mod.slice(1)}.ts\` — data fetching hook`, description: `File: \`src/hooks/use${mod.charAt(0).toUpperCase() + mod.slice(1)}.ts\`\n\nChanges:\n- Fetch data từ API\n- Quản lý loading/error state\n- Return typed data\n\nDone when: hook trả về data và handle errors.`, priority: 'high', label: 'feature' },
      { title: `Sửa \`src/pages/${mod}Page.tsx\` — integrate component vào page`, description: `File: \`src/pages/${mod}Page.tsx\`\n\nChanges:\n- Import và render component mới\n- Connect với routing\n- Pass đúng props\n\nDone when: page hiển thị component đúng.`, priority: 'high', label: 'feature' },
    ];
  }

  if (/deploy|ci|docker|infra|pipeline/i.test(lower)) {
    return [
      { title: `Sửa \`Dockerfile\` — optimize build layers`, description: `File: \`Dockerfile\`\n\nChanges:\n- Tách build stage và runtime stage\n- Copy chỉ những file cần thiết\n- Set đúng USER và WORKDIR\n\nDone when: docker build thành công, image size giảm.`, priority: 'critical', label: 'chore' },
      { title: `Sửa \`.github/workflows/ci.yml\` — thêm build/test step`, description: `File: \`.github/workflows/ci.yml\`\n\nChanges:\n- Thêm step chạy tests trước khi build\n- Cache node_modules\n- Thêm build artifact upload\n\nDone when: CI pipeline pass trên main branch.`, priority: 'high', label: 'chore' },
      { title: `Sửa \`docker-compose.yml\` — cập nhật service config`, description: `File: \`docker-compose.yml\`\n\nChanges:\n- Cập nhật environment variables\n- Thêm healthcheck cho service\n- Đảm bảo volumes mount đúng\n\nDone when: docker-compose up chạy không lỗi.`, priority: 'medium', label: 'chore' },
    ];
  }

  // Generic fallback — produce plausible file-level tasks
  return [
    { title: `Sửa \`${svc}.service.ts\` — implement core logic`, description: `File: \`${svc}.service.ts\`\n\nChanges theo task: ${title}\n\nRead file hiện tại để biết patterns, sau đó implement đúng convention.\n\nDone when: logic hoạt động đúng theo requirements.`, priority: 'critical', label: 'feature' },
    { title: `Sửa \`${svc}.module.ts\` — register dependencies`, description: `File: \`${svc}.module.ts\`\n\nChanges:\n- Thêm providers/imports mới cần cho feature trên\n- Đảm bảo DI đúng\n\nDone when: module compile không lỗi.`, priority: 'high', label: 'chore' },
    { title: `Sửa \`${svc}.controller.ts\` — expose endpoint hoặc event handler`, description: `File: \`${svc}.controller.ts\`\n\nChanges:\n- Thêm route/handler gọi service method mới\n- Validate input, trả về đúng response\n\nDone when: endpoint trả về kết quả đúng.`, priority: 'high', label: 'feature' },
  ];
}
