# AGENTS.md — Working Rules for AI Agents

Operating guide for AI agents (Claude Code, Gemini CLI / Antigravity) working in this repo.
Project facts: [CLAUDE.md](CLAUDE.md). Runtime architecture: [ARCHITECTURE.md](ARCHITECTURE.md).
This file is about *how to work*, not *what the project is*.

---

## Golden rules

1. **The backend is in `vite.config.ts`.** When a task touches an `/api/*` endpoint, edit the
   middleware there — there is no `server/` folder yet. Confirm via the typed client in
   `src/services/api.ts`.
2. **Execution is real.** Runs spawn the Claude Code CLI and touch real git repos. Do **not**
   route new work through `executeTask` (dead stub) or assume `simulator.ts` is the live path.
3. **`types.ts` is the contract.** Change domain types deliberately; expect ripple effects.
4. **No safety net exists** (no tests/lint/CI). Verify behavior by running the app
   (`npm run dev`, port 5199). State what you verified and what you did not.
5. **Don't build on orphans.** `ProjectsPage`, `JiraImportPage`, `BoardPage`, `mockData.ts` are
   unused and slated for removal — never extend them.
6. **Respect token efficiency.** Files here are large; read only the slice you need, and prefer
   editing the smallest relevant unit over re-reading whole god-files.

---

## Security rules (high priority)

The backend spawns shells and the Claude CLI with elevated permissions. When working in
`vite.config.ts`:

- Never introduce new `shell: true` spawns; pass args as an array, validate/normalize any path or
  branch name that comes from a request body or query string.
- Don't widen the `/api/exec/run` surface or remove existing timeouts.
- Never log, echo, or commit decrypted MCP secrets, tokens, or `.env.local` contents.
- Treat anything reachable from a request as untrusted even though the server is localhost-only.

---

## Scope & change discipline

- Do not change business logic unless asked. Do not refactor outside the approved scope.
- **Never delete files directly** — propose deletions for human review first.
- Reuse existing components/stores before creating new ones.
- For large/risky changes, include a rollback checklist.
- Standardize architecture, docs, and workflow *before* large refactors.
- Keep these docs in sync: if you change structure, update CLAUDE.md / ARCHITECTURE.md in the
  same change.

---

## Model routing (which model for which task)

Start with the smallest capable model; escalate only when justified.

| Task | Model | Tool | Why |
|---|---|---|---|
| Extract/split backend from `vite.config.ts` | Claude Opus | Claude Code | Large, cross-module, high risk |
| Security review of spawn/exec/path handling | Claude Opus | Claude Code | Deep reasoning, accuracy critical |
| Split god components (`TaskDetail`, `ProjectSource`) | Claude Sonnet | Claude Code | Medium refactor, clear logic |
| Feature work / bug fix in one domain | Claude Sonnet | Claude Code | Best quality/speed balance |
| Update these docs to match code | Claude Sonnet | Claude Code | Needs real code understanding |
| Unit tests for pure logic (`utils`, `calcCost`, `branchUtils`) | Gemini Flash | Antigravity | Repetitive, low cost |
| API endpoint documentation | Gemini Pro | Antigravity | Volume + good structure |
| Repo cleanup / orphan removal | Haiku / Flash | either | Mechanical, low risk |

**Escalation:** Level 1 Haiku/Flash (explore, summarize, boilerplate) → Level 2 Sonnet/Pro
(features, fixes, medium refactor, tests) → Level 3 Opus (architecture, security, large refactor,
high-risk decisions only). Don't use Opus for boilerplate or simple tests.

---

## Multi-agent parallelism

Until the backend split lands, three files are contention magnets: `vite.config.ts`, `store.ts`,
`src/services/api.ts`. Avoid assigning two parallel agents work that both edit the same one. Safe
parallel lanes today: docs (read-mostly), one orphan-cleanup agent, one per *page* under
`src/pages/` (they rarely overlap). After the `domains/` split (see ARCHITECTURE.md), assign one
agent per domain folder.

---

## Token optimization

- Use Haiku/Flash for first-pass repo exploration; switch to Sonnet/Pro only to edit.
- Reserve Opus for the two things that need it here: backend extraction and security hardening.
- Scope file ranges before handing a task to a large model — never "read the whole god-file".
- Reuse CLAUDE.md / ARCHITECTURE.md / this file instead of re-deriving structure each session.
