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
ACP agents (upstream ACP support is still in flight, so this lives only in the fork):

- Server: `apps/server/src/provider/Drivers/AcpRegistryDriver.ts`,
  `apps/server/src/provider/Layers/GenericAcpAdapter.ts`, `apps/server/src/provider/acp/`
- Contracts: `AcpRegistrySettings` in `packages/contracts/src/settings.ts` (includes `modelNames`, a
  hidden map from model slug to picker display name) and `packages/contracts/src/acp.ts`
- Web: `AddProviderInstanceDialog*` and `ProviderSettingsForm*` under
  `apps/web/src/components/settings/`; instance-only drivers must never assume a legacy
  `settings.providers` slot (see `deriveProviderSettingsInstanceRows` in `SettingsPanels.logic.ts`)

Henrik's live instance is the Kimi CLI (`agentId: "kimi"`, `kimi acp`, auth method `login`) stored in
`~/.t3/userdata/settings.json` as `providerInstances.kimi`. Official nightlies do not know the driver;
they parse it as an open slug, show the provider as unavailable, and leave the config untouched, so
switching between nightly and fork builds is safe.

### Desktop builds and launcher

The desktop launcher `~/Applications/t3code` is a symlink to the active AppImage in `~/Applications`.
The official nightly updater rewrites that symlink on update. Local fork builds are produced and
activated with `~/Applications/update-t3code.sh` (wraps `scripts/update-local-fork.sh`):

- `stage`: fetch/merge `upstream/main` on a throwaway candidate branch, run check/typecheck/tests,
  build the AppImage, then fast-forward `main`. Aborts cleanly (main and launcher untouched) on merge
  conflicts or failing gates. Requires a clean worktree on `main` and a local Node 24 runtime.
- `activate`: atomically points the launcher at the last staged, checksum-verified build.
- There is intentionally no `rollback` command; switch to the nightly by re-pointing the symlink or
  letting the nightly updater do it.

## Local Environment

- User: `rik`
- Working directory: `/home/rik/Schreibtisch/t3code`
- Runtime/package manager: follow the current upstream package manager in `package.json`
- Communication with Rik is usually German; code, commits, and project docs stay English unless a file
  is already German.
