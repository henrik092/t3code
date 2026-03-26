# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Codex App Server (Important)

T3 Code is currently Codex-first. The server starts `codex app-server` (JSON-RPC over stdio) per provider session, then streams structured events to the browser through WebSocket push messages.

How we use it in this codebase:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent` (provider runtime activity is projected into orchestration events server-side).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Fork & Git Workflow

This is a **fork** of `pingdotgg/t3code`. The git remotes are configured as:

- `origin` → `git@github.com:henrik092/t3code.git` (our fork, push here)
- `upstream` → `git@github.com:pingdotgg/t3code.git` (original repo, pull updates from here)

### Syncing with upstream

To pull in new changes from the original repo:

```bash
git fetch upstream && git merge upstream/main
```

When resolving merge conflicts, **our custom changes take priority** unless the upstream change is clearly a bugfix we need. Key areas where we have custom logic:

- `apps/server/src/main.ts` — custom `cwd` resolution via `resolveCwd()`
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` — `effectiveModel` + `providerOptions?.binaryPath` fallback
- `scripts/dev-runner.ts` — early `cwd` resolution with `T3CODE_CWD`

After resolving conflicts, commit and push to `origin main`.

## Development Environment

- **User**: rik (Henrik)
- **Machine**: MS-7C35 (Ubuntu/Linux)
- **Working directory**: `/home/rik/Schreibtisch/t3code`
- **Claude Code**: Runs both im Terminal und in VS Code, mit Claude Max (Opus 4.6, 1M context)
- **Permissions**: `defaultMode: "dontAsk"` + `skipDangerousModePermissionPrompt: true` (bypass permissions)
- **Language**: Deutsch bevorzugt für Kommunikation, Englisch für Code/Commits/Docs
- **Runtime**: Bun (nicht npm/yarn)
- **Plugins**: Playwright, Ralph Loop, Superpowers
