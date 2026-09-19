# Architecture — Agent Task Manager

This document describes the *runtime* architecture and the known structural debt. For the
day-to-day source map and routes see [CLAUDE.md](CLAUDE.md). For agent working rules see
[AGENTS.md](AGENTS.md).

---

## System shape

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (React SPA, port 5199)                             │
│                                                             │
│  Zustand stores ── components/pages ── services/api.ts      │
│   (task, project,        │                  (typed fetch)   │
│    prompt, knowledge,    │                        │         │
│    settings)             ▼                        ▼         │
└──────────────────────── localStorage ────────── /api/* ─────┘
                            (cache)                  │
                                                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Vite dev server middlewares  (vite.config.ts, ~2.4k lines) │
│   = THE BACKEND.  Each /api/* route is a connect middleware.│
│                                                             │
│   ├─ spawn: Claude Code CLI  (real agent runs, SSE)         │
│   ├─ spawn: git / gh         (status, branch, merge, clone) │
│   ├─ fetch: GitLab API, Jira (MCP), GitHub trending skills  │
│   ├─ crypto: AES enc/dec of MCP secrets                     │
│   └─ fs: data files, repo/dir scan, skills/prompt save      │
└─────────────────────────────────────────────────────────────┘
        │ spawn                 │ fs                  │ http
        ▼                       ▼                     ▼
   Claude Code CLI    agent-tasks.json /        GitLab / Jira / GitHub
   + local git repos  agent-projects.json
```

The frontend and backend ship as one Vite process. There is **no standalone server**; "deploy"
currently means "run the dev server".

---

## Backend endpoint catalog (in `vite.config.ts`)

| Group | Endpoints (representative) |
|---|---|
| Health / FS | `/api/health`, `/api/files`, `/api/dirs`, `/api/repos` |
| Data persistence | `/api/data/tasks`, `/api/data/projects` |
| Task execution (SSE) | `/api/analyze-task`, `/api/analyze-stream`, `/api/run-task`, `/api/task-stream/:id`, `/api/stop-task`, `/api/sessions` |
| Git | `/api/git/{pull-main,branch,scan,status,status-batch,clone,checkout,merge,abort-merge,conflicts,resolve-conflict,resolve-finalize}`, `/api/create-branch`, `/api/create-pr` |
| GitLab | `/api/gitlab`, `/api/gitlab/{repos,mrs,mrs-batch,pipeline,pipeline-retry}` |
| Jira | `/api/jira/{config,projects,sprints,statuses,preview,import}` |
| MCP | `/api/mcp` |
| Knowledge base | `/api/skill/save`, `/api/prompt/save` |
| GitHub skills | `/api/github/{trending-skills,skill-files,raw,all-skills}` |
| Terminal / exec | `/api/terminal/open`, `/api/exec/run` |

The typed client wrappers for these live in [`src/services/api.ts`](src/services/api.ts).

---

## State management

Five independent Zustand stores (no cross-store coupling beyond imports):

| Store | Owns | Persistence |
|---|---|---|
| `store.ts` | tasks, run lifecycle, terminal slice, token totals | localStorage `agentmgr:tasks` + `/api/data/tasks` |
| `projectStore.ts` | projects, `reposRoot`, repo-picker UI | localStorage `agentmgr:projects` + `/api/data/projects` |
| `promptStore.ts` | prompt library | localStorage |
| `knowledgeStore.ts` | KB entries | localStorage |
| `settingsStore.ts` | misc settings | localStorage |

Persistence pattern: localStorage is the synchronous cache; the backend file is the durable store,
written debounced and hydrated on load with localStorage as the offline fallback.

---

## Domain model

Centralized in [`src/types.ts`](src/types.ts) — the cleanest part of the codebase. Key types:
`Task`, `TaskStatus`, `Priority`, `TaskLabel`, `AIModel`, `AgentConfig`, `TerminalState`,
`TokenUsage`, `LogEntry`, `AgentSession`, `Project`, `KnowledgeEntry`, `PromptEntry`. Display
metadata (`STATUS_META`, `PRIORITY_META`, `LABEL_META`) and pricing (`MODEL_INFO`, `calcCost`)
also live here. **Treat `types.ts` as the contract** — change it deliberately and ripple outward.

---

## Known issues / tech debt (prioritized)

| ID | Issue | Impact |
|---|---|---|
| **A1** | Backend embedded in `vite.config.ts` (~2.4k lines) | Blocks frontend/backend separation, multi-agent parallelism, and any non-dev deployment |
| **A2** | `spawn(..., { shell: true })` with user-supplied paths/branch names; `/api/exec/run`; CLI run with `--dangerously-skip-permissions` | Command-injection / path-traversal / RCE surface (localhost-only, but should be hardened) |
| **A3** | God components: `ProjectSourcePage` (~1.3k), `TaskDetail` (~1.2k), `TaskDetailPanel` (~1.2k) | High token cost per edit; merge-conflict magnets |
| **A4** | `store.ts` is a god-store (~640 lines) | Single point of contention for parallel agents |
| **A5** | No tests / lint / CI | No automated safety net for AI-driven changes |
| **A6** | Orphan files: `ProjectsPage`, `JiraImportPage`, `BoardPage`, `mockData.ts` | ~2.4k dead lines polluting context |
| **A7** | `any` throughout the backend middlewares | Lost type safety where risk is highest |

---

## Target structure (north star — not yet implemented)

```
server/                          # extracted from vite.config.ts (A1)
├── index.ts
├── routes/{tasks,git,gitlab,jira,mcp,github,data}.ts
└── lib/{spawn,crypto,sse}.ts    # spawn hardened: no shell:true, validated paths (A2)

src/
├── domains/
│   ├── tasks/        # store slice, components, pages
│   ├── projects/     # project source + repo linking
│   ├── git/          # client-side git status/branch/merge UI
│   ├── knowledge/    # skills, prompts, KB
│   ├── integrations/ # jira, gitlab, mcp, github clients
│   └── agent-run/    # terminal, sessions, run streaming
├── shared/           # types, utils, ui primitives
└── app/              # router, layout, settings
```

Migration must be incremental and gated by a per-endpoint smoke test (see the rollback note in the
audit). `vite.config.ts` stays intact until `server/` passes the full endpoint checklist.
