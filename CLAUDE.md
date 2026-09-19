# Agent Task Manager — Project Documentation

> **For AI agents:** This file is the canonical source of truth for how the project actually
> works *today*. If something here contradicts the code, the code wins — please flag the drift.
> Deeper structural detail lives in [ARCHITECTURE.md](ARCHITECTURE.md); agent working rules
> live in [AGENTS.md](AGENTS.md).

## Overview

`agent-task-manager` is a React/TypeScript single-page app — a Kanban-style control plane for
driving **real** Claude Code agent runs against local git repositories. Users create tasks, pick
a Claude model, link a repo, then watch the agent stream logs, token usage, and cost in real time.

It is a **single-user, local-first developer tool** (runs on `localhost`, talks to the local
filesystem, git, and the Claude CLI). It is *not* a hosted multi-tenant service.

**Dev server:** `npm run dev` → http://localhost:5199 (Vite, frontend **and** backend together).

---

## ⚠️ The one thing every agent must know first

**The backend lives inside [`vite.config.ts`](vite.config.ts) (~2,400 lines).** It is a set of Vite
dev-server middlewares implementing ~60 `/api/*` endpoints: task run/stream (SSE), git, GitLab,
Jira, MCP, file/dir scan, and data persistence. There is **no separate `server/` folder.** If you
are looking for "the API", it is in the Vite config. (This is known tech debt — see
[ARCHITECTURE.md](ARCHITECTURE.md) §Known Issues.)

Execution is **real, not simulated.** `src/simulator.ts` is only a fallback when the backend's
analyze stream is unavailable, and `executeTask` in `src/services/api.ts` is **dead legacy code**
(a no-op stub) — do not wire new work through it. Real runs go through `/api/run-task` +
`EventSource('/api/task-stream/:runId')`.

---

## Tech Stack

| Layer | Choice |
|---|---|
| UI framework | React 18 + TypeScript |
| Build tool / dev backend | Vite 5 (middlewares host the `/api/*` backend) |
| Styling | Tailwind CSS + PostCSS |
| State management | Zustand (5 separate stores) |
| Routing | React Router v6 |
| Icons | lucide-react |
| Date utilities | date-fns |
| Agent runtime | Claude Code CLI (`@anthropic-ai/claude-code`), spawned by the backend |

---

## Source Map (where things actually are)

```
agent-task-manager/
├── vite.config.ts          # ⚠️ THE BACKEND — ~60 /api/* routes, SSE, git/gitlab/jira/mcp, spawn
├── src/
│   ├── main.tsx            # Entry + router
│   ├── App.tsx             # Route table + always-mounted overlays; inline SettingsPage
│   ├── types.ts            # ★ Domain model: Task, AIModel, TerminalState, MODEL_INFO, calcCost
│   ├── store.ts            # ★ Main task store (CRUD, run lifecycle, token accumulation)
│   ├── projectStore.ts     # Projects/repos + reposRoot + repo-picker UI state
│   ├── promptStore.ts      # Prompt library
│   ├── knowledgeStore.ts   # Knowledge base entries (task/skill summaries)
│   ├── settingsStore.ts    # Misc settings
│   ├── simulator.ts        # Fallback fake-run engine (NOT the primary path)
│   ├── contextCache.ts     # Per-project analysis cache (token-saving)
│   ├── branchUtils.ts      # Branch name helpers
│   ├── kbConstants.ts      # Knowledge-base folder conventions (_skills/, _prompt/)
│   ├── utils.ts            # formatTokens, formatDuration, cronLabel, inferLabel…
│   ├── mockData.ts         # ⚠️ ORPHAN (no imports) — slated for removal
│   ├── pages/
│   │   ├── DashboardPage.tsx       # route /        — landing/overview
│   │   ├── TasksPage.tsx           # route /tasks   — task list (board lives here)
│   │   ├── TaskDetailPage.tsx      # route /tasks/:id
│   │   ├── AgentsPage.tsx          # route /agents  — model stats + planning guide
│   │   ├── McpPage.tsx             # route /mcp     — MCP server management
│   │   ├── PromptLibraryPage.tsx   # route /prompts — labeled "Agent Monitor" in the nav
│   │   ├── SkillsPage.tsx          # route /skills  — skills catalog
│   │   ├── ProjectSourcePage.tsx   # route /project/:id — per-repo source/git manager
│   │   ├── ProjectsPage.tsx        # ⚠️ ORPHAN (not routed) — superseded by ProjectSourcePage
│   │   ├── JiraImportPage.tsx      # ⚠️ ORPHAN (not routed)
│   │   └── BoardPage.tsx           # ⚠️ ORPHAN (not routed)
│   ├── components/
│   │   ├── Sidebar.tsx             # Nav + project list + repo sync
│   │   ├── Header.tsx              # Page header
│   │   ├── Terminal.tsx            # Docked streaming terminal (run/pause/stop)
│   │   ├── TerminalModal.tsx       # Full-screen terminal
│   │   ├── TaskDetail.tsx          # Task detail body (run + analyze streams)
│   │   ├── TaskDetailPanel.tsx     # Slide-over task detail (also runs streams)
│   │   ├── TaskCard.tsx  Board.tsx # Kanban card + columns
│   │   ├── CreateTaskModal.tsx  RepoPickerModal.tsx  BranchSelectionModal.tsx
│   └── services/
│       └── api.ts          # Typed fetch clients for /api/* (executeTask = dead stub)
```

`★` = read these first to understand the domain. `⚠️ ORPHAN` = confirmed unused; do not build on them.

---

## Routes (actual, from `App.tsx`)

`/` Dashboard · `/tasks` Tasks · `/tasks/:id` Task detail · `/agents` Agents ·
`/mcp` MCP Servers · `/prompts` Prompt library (nav label "Agent Monitor") ·
`/skills` Skills · `/project/:id` Project source manager · `/settings` Settings.

---

## Data flow (real execution)

1. **Create** — `CreateTaskModal` → `store.ts` → state updates.
2. **Persist (hybrid)** — every task mutation writes to `localStorage['agentmgr:tasks']` *and*
   debounce-saves to the backend file via `POST /api/data/tasks` (stored in `agent-tasks.json`).
   On load, the store hydrates from `GET /api/data/tasks`, falling back to localStorage if the
   backend is offline. `projectStore` mirrors this with `/api/data/projects` → `agent-projects.json`.
3. **Run** — `Terminal` / `TaskDetail` / `TaskDetailPanel` `POST /api/run-task`, then open
   `EventSource('/api/task-stream/:runId')`. The backend spawns the Claude Code CLI
   (`--dangerously-skip-permissions --output-format stream-json`) and relays its events as SSE.
4. **Stream → store** — each SSE event updates the task's `terminal` slice (logs, `tokenUsage`,
   `cost`, progress, `elapsedMs`). `/api/analyze-stream` does a pre-run repo analysis.
5. **Aggregate** — `AgentsPage` rolls store state up into per-model stats and recommendations.

---

## Supported Models

| Model ID (internal) | Label | Use when |
|---|---|---|
| `claude-opus-4-7` | Claude Opus 4.7 | Architecture, security audits, complex refactors |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | Feature work, API design, test generation |
| `claude-haiku-4-5` | Claude Haiku 4.5 | Docs, chores, boilerplate |

Pricing + labels live in `types.ts` (`MODEL_INFO`); cost is computed by `calcCost`. These are the
app's *internal catalog* values and may lag the latest released Claude models.

---

## Task lifecycle

```
backlog → in_progress → done
                     ↘  failed
        paused / stopped  (manual interrupts)
```

`TaskStatus = 'backlog' | 'in_progress' | 'paused' | 'stopped' | 'done' | 'failed'`.
Tasks support parent/child (`parentId`, `subtaskIds`) and per-run history (`sessions`).

---

## Config & secrets

- `.env.local` — local env (gitignored).
- `.mcp-servers.json` — MCP server definitions; secret values are **encrypted at rest**
  (`enc:v1:…`, AES via the crypto helpers in `vite.config.ts`). Gitignored.
- `agent-jira-config.json` — Jira import mapping (status/priority/label maps). Tracked.
- `agent-tasks.json` / `agent-projects.json` — backend data files. Gitignored.

Never commit decrypted secrets or the `.env.local` key material.

---

## Running locally

```bash
npm install
npm run dev        # http://localhost:5199  (frontend + backend middlewares)
npm run build      # tsc -b && vite build
```

Requires the **Claude Code CLI** and **git** on PATH for real runs; GitLab/Jira features need the
corresponding tokens configured in `.mcp-servers.json`. With nothing configured, task CRUD and the
simulator fallback still work.

---

## Current limitations (accurate)

1. **Backend is coupled to the Vite config** — frontend and backend cannot be developed or
   deployed independently. See [ARCHITECTURE.md](ARCHITECTURE.md) for the planned `server/` split.
2. **No tests, no linter, no CI** — there is no automated safety net; verify changes by running the app.
3. **God-files** — `vite.config.ts`, `ProjectSourcePage`, `TaskDetail(Panel)` are each >1k lines.
4. **Cron schedules are display-only** — `agentConfig.schedule` is stored/rendered but nothing fires it.
5. **Orphan code present** — `ProjectsPage`, `JiraImportPage`, `BoardPage`, `mockData.ts`.
6. **Single-user/local-only** — no auth, no multi-tenant, paths are Windows-absolute in places.

See [AGENTS.md](AGENTS.md) for how to work within these constraints and the model-routing guidance.
