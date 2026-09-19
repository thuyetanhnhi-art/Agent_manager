import type { Task, TaskLabel } from './types';

const LABEL_RULES: Array<[RegExp, TaskLabel]> = [
  [/hotfix|urgent.*fix|critical.*fix|emergency/i, 'hotfix'],
  [/\b(bug|fix|error|crash|broken|defect|regression)\b/i, 'bugfix'],
  [/\b(test|spec|unit.?test|integration.?test|e2e|coverage)\b/i, 'test'],
  [/\b(doc|docs|readme|documentation|wiki|jsdoc)\b/i, 'docs'],
  [/\b(ci|cd|config|setup|deploy|infra|pipeline|dependency|dependencies|npm|yarn)\b/i, 'chore'],
  [/\b(refactor|cleanup|clean.?up|optimize|restructure|simplify)\b/i, 'refactor'],
  [/\b(feature|add|implement|create|build|new|integrate|develop)\b/i, 'feature'],
];

export function inferLabel(title: string, description = ''): TaskLabel {
  const text = `${title} ${description}`;
  for (const [regex, label] of LABEL_RULES) {
    if (regex.test(text)) return label;
  }
  return 'task';
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '');
}

export function makeBranchName(label: TaskLabel, taskId: string, title: string, projectName = ''): string {
  const prefix = projectName
    ? projectName.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) || 'ATM'
    : 'ATM';
  const num = taskId.replace(/\D/g, '').slice(-4).padStart(4, '0');
  const slug = slugify(title).slice(0, 35).replace(/-$/, '');
  return `${label}/${prefix}-${num}-${slug}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

export function formatRelative(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const CRON_LABELS: Record<string, string> = {
  '0 9 * * *':    'Daily 9am',
  '0 9 * * 1-5':  'Weekdays 9am',
  '0 * * * *':    'Every hour',
  '*/30 * * * *': 'Every 30 min',
  '*/15 * * * *': 'Every 15 min',
  '0 0 * * *':    'Midnight daily',
  '0 0 * * 1':    'Weekly Monday',
};

export function cronLabel(cron: string): string {
  return CRON_LABELS[cron] ?? cron;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

export function generateHandoffContext(task: Task): string {
  const { todos, logs } = task.terminal;
  const completed = todos.filter(t => t.status === 'completed').map(t => t.content);
  const inProgress = todos.filter(t => t.status === 'in_progress').map(t => t.content);
  const pending = todos.filter(t => t.status === 'pending').map(t => t.content);

  const lastError = [...logs].reverse().find(l => l.type === 'error');
  const lastSuccess = [...logs].reverse().find(l => l.type === 'success');
  const filesModified = [...new Set(
    logs
      .filter(l => l.type === 'tool_call' && l.toolName && ['Write', 'Edit'].includes(l.toolName))
      .map(l => l.content)
      .filter(Boolean),
  )].slice(-8);

  const lines: string[] = [
    `## Handoff Context — ${task.title}`,
    `Phiên làm việc trước đã bị dừng. Hãy tiếp tục từ đây, KHÔNG làm lại những gì đã hoàn thành.`,
    '',
  ];

  if (completed.length > 0) {
    lines.push('### ✓ Đã hoàn thành');
    completed.forEach(c => lines.push(`- ${c}`));
    lines.push('');
  }

  if (inProgress.length > 0) {
    lines.push('### ▸ Đang dở dang (bắt đầu lại từ đây)');
    inProgress.forEach(c => lines.push(`- ${c}`));
    lines.push('');
  }

  if (pending.length > 0) {
    lines.push('### ○ Còn lại cần làm');
    pending.forEach(c => lines.push(`- ${c}`));
    lines.push('');
  }

  if (lastError) {
    lines.push('### ✗ Lỗi cuối cùng');
    lines.push(lastError.content.slice(0, 600));
    lines.push('');
  } else if (lastSuccess) {
    lines.push('### Kết quả cuối');
    lines.push(lastSuccess.content.slice(0, 400));
    lines.push('');
  }

  if (filesModified.length > 0) {
    lines.push('### Files đã chỉnh sửa');
    filesModified.forEach(f => lines.push(`- ${f}`));
    lines.push('');
  }

  lines.push('---');
  lines.push('Tiếp tục từ chỗ bỏ dở. Đừng đọc lại toàn bộ codebase nếu không cần thiết.');

  return lines.join('\n');
}
