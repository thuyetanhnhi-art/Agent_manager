---
name: backend-lives-in-vite-config
description: The HTTP backend is inside vite.config.ts, not a separate server folder
metadata:
  type: project
---

The entire HTTP backend (~60 `/api/*` routes: task run/SSE, git, gitlab, jira, mcp, data persistence) is implemented as Vite dev-server middlewares inside `vite.config.ts` (~2.4k lines). There is no `server/` folder. Typed clients are in `src/services/api.ts`.

**Why:** Highly non-obvious — agents look for a server folder and miss it, wasting context.
**How to apply:** To edit any `/api/*` endpoint, edit the middleware in `vite.config.ts`. This is documented in CLAUDE.md/ARCHITECTURE.md. Planned refactor: extract into `server/`. See [[ai-readiness-audit]].
