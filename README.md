# Agent Task Manager

A local-first, Kanban-style control plane for driving **real Claude Code agent runs** against your
local git repositories. Create tasks, assign a Claude model, link a repo, and watch the agent
stream its logs, token usage, and cost in real time.

> Single-user developer tool. It runs on `localhost` and talks to your local filesystem, git, and
> the Claude Code CLI. It is not a hosted/multi-tenant service.

## Features

- **Kanban task board** — backlog → in progress → done / failed, with priority, labels, tags, and
  parent/child subtasks.
- **Real agent execution** — spawns the Claude Code CLI and streams output over SSE into a live
  terminal (run / pause / stop).
- **Per-model cost & token tracking** — Opus / Sonnet / Haiku pricing, per-run sessions, and
  aggregate stats on the Agents page.
- **Project / repo management** — scan a root folder for git repos, view per-repo source and git
  status, branches, merges, and conflict resolution.
- **Integrations** — GitLab (MRs, pipelines), Jira import, MCP server management, GitHub skills.
- **Prompt & skills library** plus a project knowledge base.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5199
```

```bash
npm run build      # tsc -b && vite build
npm run preview    # preview the production build
```

### Requirements for full functionality

| Want to… | You need… |
|---|---|
| Run real agents | The Claude Code CLI (`@anthropic-ai/claude-code`) on PATH |
| Git / branch / merge features | `git` (and `gh` for PRs) on PATH |
| GitLab / Jira features | Tokens configured in `.mcp-servers.json` (encrypted at rest) |

Without these, task management and the simulator fallback still work.

## Tech stack

React 18 · TypeScript · Vite 5 · Tailwind CSS · Zustand · React Router v6 · lucide-react · date-fns.

> **Note:** the HTTP backend is implemented as Vite dev-server middlewares inside
> [`vite.config.ts`](vite.config.ts) — there is no separate server process. See
> [ARCHITECTURE.md](ARCHITECTURE.md).

## Documentation

| Doc | Purpose |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Canonical project facts, source map, routes, data flow |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Runtime architecture, endpoint catalog, known tech debt |
| [AGENTS.md](AGENTS.md) | Working rules and model-routing guidance for AI agents |

## Project status

Functional local tool with known structural debt (backend coupled to the Vite config; no test/CI
suite yet). See [ARCHITECTURE.md](ARCHITECTURE.md) §Known issues for the roadmap.
