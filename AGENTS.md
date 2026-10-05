# AGENTS.md

## Task Completion Requirements

- Keep local verification focused on the files and packages changed. Run the smallest relevant test set; do not run the full workspace test suite as a routine completion step.
  - Use `vp test run <test-files>` for focused built-in Vite+ tests. Use `vp run test` only when the affected package specifically requires its `test` script.
  - Backend changes must include and run focused tests for the changed behavior.
  - Run targeted formatting, lint, and type checks for the affected scope when available.
- Do not run repo-wide `vp check`, `vp run typecheck`, `vp run test`, or equivalent full-suite commands locally unless the user explicitly requests them. CI is responsible for the full verification suite.
- After frontend feature development or any user-visible frontend behavior change, the primary agent must run one integrated verification pass for each affected client surface after integrating the work:
  - Web: use the `test-t3-app` skill. Launch one isolated environment, authenticate through the printed pairing URL, and verify the affected flow in the controlled browser.
  - Mobile: use the `test-t3-mobile` skill. Connect one representative iOS Simulator or Android Emulator available on the host to one isolated environment and verify the affected flow. On compatible macOS hosts, prefer iOS for cross-platform changes and stream it through serve-sim in the T3 Code in-app browser or another available agent browser; use Android when it is the affected or viable platform.
  - Subagents must not independently launch dev servers or repeat integrated client verification unless their delegated task explicitly requires it.
  - Stop dev servers, watchers, and other long-running verification processes when the focused verification is complete.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `vpr sync:repos`; use `vpr sync:repos --repo <id>` to sync one configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.

## Local Fork Workflow

This checkout is Henrik's fork of `pingdotgg/t3code`.

- `origin` -> `git@github.com:henrik092/t3code.git`
- `upstream` -> `git@github.com:pingdotgg/t3code.git`

Pull upstream updates with `git fetch upstream` and `git merge upstream/main`. Preserve local deployment
fixes for the Proxmox T3 Code instance unless upstream has replaced them with equivalent behavior.

### ACP Registry provider (Kimi)

The fork adds a generic multi-instance `acpRegistry` provider driver that launches locally installed
ACP agents (upstream ACP support is still in flight, so this lives only in the fork and is not
available in the official nightly):

- Server: `apps/server/src/provider/Drivers/AcpRegistryDriver.ts`,
  `apps/server/src/provider/Layers/GenericAcpAdapter.ts`, `apps/server/src/provider/acp/`
- Contracts: `AcpRegistrySettings` in `packages/contracts/src/settings.ts` (includes `modelNames`, a
  hidden map from model slug to picker display name) and `packages/contracts/src/acp.ts`
- Web: `AddProviderInstanceDialog*` and `ProviderSettingsForm*` under
  `apps/web/src/components/settings/`; instance-only drivers must never assume a legacy
  `settings.providers` slot (see `deriveProviderSettingsInstanceRows` in `SettingsPanels.logic.ts`)

The Kimi CLI instance (`agentId: "kimi"`, `kimi acp`, auth method `login`) was an experiment and is no
longer configured. Official nightlies do not know the driver; they parse it as an open slug, show the
provider as unavailable, and leave the config untouched.

### Desktop builds and launcher

Since 2026-10-05 the **official upstream T3 Code Nightly is the daily driver** on both of Henrik's
machines (main PC and `t3-box`), not a fork build. The fork does not contain Orchestration V2
(upstream PR #2829, merged 2026-10-02) and is no longer merged with upstream on a schedule.

- Main PC: the desktop launcher `~/Applications/t3code` is a symlink to
  `~/Applications/T3-Code-auto-current-x86_64.AppImage`, which the built-in nightly updater replaces;
  `T3-Code-auto-previous-x86_64.AppImage` is the fallback. The app profile lives in
  `~/.config/t3code-v2`; the old V1 profiles under `~/.config` are kept because V2 imports drafts and
  stashed prompts from them.
- `t3-box`: `t3-code-desktop.service` starts `~/Applications/t3-code`, which runs the same
  `T3-Code-auto-current-x86_64.AppImage`. `t3-code-stage-nightly.timer` stages the latest verified
  nightly every three hours; `t3-code-update-restart.service` is the Home Assistant update trigger.
  `t3code-interactive-questions-guard.timer` only maintains a Codex `AGENTS.md` policy block and feature
  flag and is unrelated to the fork.
- `scripts/update-local-fork.sh` (`stage`/`activate`) still exists in the repo but is no longer wired
  up: the `~/Applications/update-t3code.sh` wrapper and the `t3code-fork-update.timer` are gone. Fork
  builds, the old `t3code.service` and stale runtime versions were removed on both machines.

## Local Environment

- User: `rik`
- Working directory: `/home/rik/Schreibtisch/t3code`
- Runtime/package manager: follow the current upstream package manager in `package.json`
- Communication with Rik is usually German; code, commits, and project docs stay English unless a file
  is already German.
