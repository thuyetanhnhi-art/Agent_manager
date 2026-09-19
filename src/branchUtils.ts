import { TaskLabel } from './types';

const LABEL_PREFIX: Record<TaskLabel, string> = {
  feature:  'feature',
  bugfix:   'bugfix',
  hotfix:   'hotfix',
  chore:    'chore',
  refactor: 'refactor',
  docs:     'docs',
  test:     'test',
  task:     'task',
  OT:       'task',
  upcode:   'task',
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i').replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u').replace(/[ýÿ]/g, 'y')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 50)
    .replace(/-+$/, '');
}

export function generateBranchName(
  label: TaskLabel,
  title: string,
  jiraKey?: string | null,
): string {
  const prefix = LABEL_PREFIX[label] ?? 'task';
  const slug = slugify(title);
  if (jiraKey) return `${prefix}/${jiraKey.toLowerCase()}-${slug}`;
  return `${prefix}/${slug}`;
}

export function validateBranchName(name: string): string | null {
  if (!name) return 'Tên branch không được để trống';
  if (/\s/.test(name)) return 'Không được có khoảng trắng';
  if (/[~^:?*[\\\s]|\.\./.test(name)) return 'Chứa ký tự không hợp lệ';
  if (name.startsWith('/') || name.endsWith('/')) return 'Không được bắt đầu/kết thúc bằng /';
  if (name.endsWith('.lock')) return 'Không được kết thúc bằng .lock';
  return null;
}
