# Trip Optimizer — Project Wiki

Persistent, agent-readable project documentation. This directory is the source of truth for project background, today's state, known issues, conventions, and verification workflow.

## Start here

- [`handoff.md`](handoff.md) — most recent state-of-the-world snapshot. Read this first when picking up the project.
- [`index.md`](index.md) — full catalog of wiki pages.

## Layout

```
docs/wiki/
├── handoff.md                          ← read first
├── index.md                            ← catalog
├── projects/trip-optimizer.md          ← current status, today's merges, next steps
├── entities/repo-and-deploy.md         ← repo, hosting, env vars, scripts, CI
├── concepts/architecture.md            ← routing, src/ modules, API surface
├── concepts/api-endpoints.md           ← all 16 /api/* endpoints
├── concepts/conventions.md             ← maintenance mode, soft-fail, PR norms
├── concepts/verification-workflow.md   ← how to live-verify PRs
├── concepts/known-issues.md            ← infra gaps and friction points
├── learnings/2026-06-27.md             ← single-day work log
└── project-status-2024-06-27.md       ← original full snapshot
```

## How agents should use this

When starting a new conversation that picks up Trip Optimizer work:

1. `gh repo clone jhwiv/trip-optimizer` (or pull latest)
2. Read `docs/wiki/handoff.md` for the most recent state
3. Cross-reference long-term memory for any user preferences
4. Confirm orientation with the user before writing code

Updates: when something meaningful changes (PR merged, infra fixed, bug discovered, decision made), update the relevant wiki page in the same PR that ships the change. Keep the wiki current.
