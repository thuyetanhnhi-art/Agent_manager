export type TaskStatus = 'backlog' | 'in_progress' | 'paused' | 'stopped' | 'done' | 'failed';
export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type TaskLabel = 'feature' | 'bugfix' | 'hotfix' | 'chore' | 'refactor' | 'docs' | 'test' | 'task' | 'OT' | 'upcode';
export type PromptSource = 'terminal' | 'task' | 'manual';
export type AIModel =
  | 'claude-opus-4-7'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5';

export type LogType = 'info' | 'tool_call' | 'tool_result' | 'thinking' | 'error' | 'success' | 'system';

export interface LogEntry {
  id: string;
  timestamp: Date;
  type: LogType;
  content: string;
  toolName?: string;
  duration?: number;
  // Rich display metadata for Read / Edit / Write tool calls
  filePath?: string;
  lineRange?: string;
  linesAdded?: number;
  linesRemoved?: number;
  diffPreview?: string[];
  stepIndex?: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: string;
}

export interface TerminalState {
  isRunning: boolean;
  isPaused: boolean;
  logs: LogEntry[];
  tokenUsage: TokenUsage;
  liveTokens: { input: number; output: number };
  todos: TodoItem[];
  startedAt?: Date;
  completedAt?: Date;
  elapsedMs: number;
  cost: number;
  /** Account-level rate-limit utilization (%) snapshotted when this run started. */
  usageStart?: { fiveHour: number; sevenDay: number; at: number };
  /** Percentage points of each rate-limit window this run consumed (after − before). */
  usageConsumed?: { fiveHour: number; sevenDay: number };
}

export interface AgentConfig {
  model: AIModel;
  schedule: string | null;
  tools: string[];
}

export interface ValidationResult {
  passed: boolean | null;
  notes: string;
}

export type TaskKind = 'agent' | 'fb_phone_collector';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  /** Absent/'agent' = normal Claude Code agent task. Other kinds run through a dedicated, non-Claude backend job instead of spawning the CLI. */
  taskKind?: TaskKind;
  priority: Priority;
  label: TaskLabel;
  parentId: string | null;
  subtaskIds: string[];
  agentConfig: AgentConfig;
  terminal: TerminalState;
  progress: number;
  tags: string[];
  projectId: string | null;
  branchName: string | null;
  reviewPending: boolean;
  successCriteria: string[];
  validationResults: ValidationResult[];
  createdAt: Date;
  updatedAt: Date;
  estimatedTokens?: number;
  tokenBudget?: number;
  projectAnalysis?: string;
  taskTodos?: TodoItem[];
  failReason?: string;
  handoffContext?: string;
  sessions?: AgentSession[];
  attachments?: TaskAttachment[];
}

// Image/file pulled from Jira and stored under agent-jira-assets/<KEY>/
export interface TaskAttachment {
  filename: string;
  mimeType: string;
  localPath: string;   // relative path, served via /api/jira-asset?path=
  url?: string;        // original Jira content URL
}

// cacheWritePer1M = cache-creation price (Anthropic bills these at 1.25× base input).
export const MODEL_INFO: Record<AIModel, { label: string; inputPer1M: number; outputPer1M: number; cacheReadPer1M: number; cacheWritePer1M: number; color: string }> = {
  'claude-opus-4-7':   { label: 'Claude Opus 4.7',   inputPer1M: 15,  outputPer1M: 75, cacheReadPer1M: 1.5,  cacheWritePer1M: 18.75, color: '#A78BFA' },
  'claude-sonnet-4-6': { label: 'Claude Sonnet 4.6', inputPer1M: 3,   outputPer1M: 15, cacheReadPer1M: 0.3,  cacheWritePer1M: 3.75,  color: '#60A5FA' },
  'claude-haiku-4-5':  { label: 'Claude Haiku 4.5',  inputPer1M: 0.8, outputPer1M: 4,  cacheReadPer1M: 0.08, cacheWritePer1M: 1.0,   color: '#34D399' },
};

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  description: string;
  taskIds: string[];
  branch: string | null;
  lastCommit: string | null;
  lastModified: string;
  color: string;
  createdAt: Date;
  jiraProjectKey?: string | null;
}

export const STATUS_META: Record<TaskStatus, { label: string; color: string; bg: string; dot: string }> = {
  backlog:     { label: 'Backlog',     color: 'text-slate-500',  bg: 'bg-slate-100',   dot: 'bg-slate-400' },
  in_progress: { label: 'In Progress', color: 'text-violet-600', bg: 'bg-violet-50',   dot: 'bg-violet-500' },
  paused:      { label: 'Paused',      color: 'text-amber-600',  bg: 'bg-amber-50',    dot: 'bg-amber-500' },
  stopped:     { label: 'Stopped',     color: 'text-red-500',    bg: 'bg-red-50',      dot: 'bg-red-400' },
  done:        { label: 'Done',        color: 'text-emerald-600',bg: 'bg-emerald-50',  dot: 'bg-emerald-500' },
  failed:      { label: 'Failed',      color: 'text-red-600',    bg: 'bg-red-50',      dot: 'bg-red-600' },
};

export const PRIORITY_META: Record<Priority, { label: string; color: string; border: string }> = {
  low:      { label: 'Low',      color: 'text-slate-500',   border: 'border-slate-300' },
  medium:   { label: 'Medium',   color: 'text-amber-600',   border: 'border-amber-300' },
  high:     { label: 'High',     color: 'text-orange-600',  border: 'border-orange-300' },
  critical: { label: 'Critical', color: 'text-red-600',     border: 'border-red-300' },
};

export const LABEL_META: Record<TaskLabel, { label: string; color: string; bg: string; border: string }> = {
  feature:  { label: 'feature',  color: 'text-blue-700',   bg: 'bg-blue-50',    border: 'border-blue-200' },
  bugfix:   { label: 'bugfix',   color: 'text-red-700',    bg: 'bg-red-50',     border: 'border-red-200' },
  hotfix:   { label: 'hotfix',   color: 'text-orange-700', bg: 'bg-orange-50',  border: 'border-orange-200' },
  chore:    { label: 'chore',    color: 'text-slate-600',  bg: 'bg-slate-100',  border: 'border-slate-300' },
  refactor: { label: 'refactor', color: 'text-violet-700', bg: 'bg-violet-50',  border: 'border-violet-200' },
  docs:     { label: 'docs',     color: 'text-teal-700',   bg: 'bg-teal-50',    border: 'border-teal-200' },
  test:     { label: 'test',     color: 'text-green-700',  bg: 'bg-green-50',   border: 'border-green-200' },
  task:     { label: 'task',     color: 'text-amber-700',  bg: 'bg-amber-50',   border: 'border-amber-200' },
  OT:       { label: 'OT',       color: 'text-pink-700',   bg: 'bg-pink-50',    border: 'border-pink-200' },
  upcode:   { label: 'upcode',   color: 'text-indigo-700', bg: 'bg-indigo-50',  border: 'border-indigo-200' },
};

export interface AgentSession {
  id: string;
  startedAt: Date;
  completedAt?: Date;
  success?: boolean;
  tokenUsage: TokenUsage;
  cost: number;
  elapsedMs: number;
  failReason?: string;
}

export interface KnowledgeEntry {
  id: string;
  projectId: string;
  taskId: string;
  title: string;
  summary: string;
  keyPoints: string[];
  createdAt: Date;
  entryType?: 'task' | 'skill';
  skillId?: string;
}

export interface PromptEntry {
  id: string;
  title: string;
  content: string;
  source: PromptSource;
  taskId?: string;
  projectId?: string | null;
  tags: string[];
  usageCount: number;
  promoted?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeSkillRef {
  skillId: string;
  skillName: string;
}

export function calcCost(usage: TokenUsage, model: AIModel): number {
  const info = MODEL_INFO[model];
  const inputCost = (usage.input / 1_000_000) * info.inputPer1M;
  const outputCost = (usage.output / 1_000_000) * info.outputPer1M;
  const cacheReadCost = (usage.cacheRead / 1_000_000) * info.cacheReadPer1M;
  const cacheWriteCost = (usage.cacheWrite / 1_000_000) * info.cacheWritePer1M;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
