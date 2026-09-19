---
name: ai-readiness-audit
description: Result of the AI-First / multi-agent readiness audit and the chosen transformation direction
metadata:
  type: project
---

On 2026-06-08 ran a full AI-First / multi-agent readiness audit of agent-task-manager.

Key findings: backend (~60 /api routes) is embedded in `vite.config.ts` (~2.4k lines); execution is REAL (Claude CLI via /api/run-task + SSE), not simulation; `executeTask` in api.ts is a dead stub; god-files (ProjectSourcePage, TaskDetail, TaskDetailPanel >1k lines); 4 orphan files (ProjectsPage, JiraImportPage, BoardPage, mockData.ts ~2.4k dead lines); no tests/lint/CI; docs were badly stale.

User direction: **start with Quick Win docs**, focus **AI/Token efficiency**. Done so far: rewrote CLAUDE.md, AGENTS.md, README.md and created ARCHITECTURE.md to match reality.

**Why:** docs were the highest-leverage, lowest-risk fix for AI navigation/token cost.
**How to apply:** Next candidate steps (await user approval): delete the 4 orphan files, then split god-files, then extract `server/` from vite.config. See [[backend-lives-in-vite-config]].
