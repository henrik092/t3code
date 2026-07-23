// @effect-diagnostics nodeBuiltinImport:off - This integration test exercises a Bash/Git boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

const SCRIPT_PATH = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "update-local-fork.sh",
);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    NodeFS.rmSync(root, { recursive: true, force: true });
});

function command(
  cwd: string,
  executable: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
) {
  return NodeChildProcess.spawnSync(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function git(cwd: string, ...args: string[]) {
  const result = command(cwd, "git", args);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function writeCommit(repo: string, filename: string, contents: string, message: string) {
  NodeFS.writeFileSync(NodePath.join(repo, filename), contents);
  git(repo, "add", filename);
  git(repo, "commit", "-m", message);
}

function makeFixture(options?: { readonly conflict?: boolean }) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-local-update-test-"));
  temporaryRoots.push(root);
  const work = NodePath.join(root, "work");
  const upstreamWork = NodePath.join(root, "upstream-work");
  const origin = NodePath.join(root, "henrik092", "t3code-origin.git");
  const upstream = NodePath.join(root, "pingdotgg", "t3code-upstream.git");
  const install = NodePath.join(root, "Applications");
  const fakeBin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(NodePath.dirname(origin), { recursive: true });
  NodeFS.mkdirSync(NodePath.dirname(upstream), { recursive: true });
  NodeFS.mkdirSync(work);
  NodeFS.mkdirSync(install);
  NodeFS.mkdirSync(fakeBin);
  git(root, "init", "--bare", "--initial-branch=main", origin);
  git(root, "init", "--bare", "--initial-branch=main", upstream);
  git(work, "init", "--initial-branch=main");
  git(work, "config", "user.email", "test@example.test");
  git(work, "config", "user.name", "T3 Test");
  writeCommit(work, "shared.txt", "base\n", "base");
  git(work, "remote", "add", "origin", origin);
  git(work, "remote", "add", "upstream", upstream);
  git(work, "push", "origin", "main");
  git(work, "push", "upstream", "main");

  git(root, "clone", upstream, upstreamWork);
  git(upstreamWork, "config", "user.email", "test@example.test");
  git(upstreamWork, "config", "user.name", "T3 Test");
  if (options?.conflict) {
    writeCommit(work, "shared.txt", "local\n", "local change");
    writeCommit(upstreamWork, "shared.txt", "upstream\n", "upstream change");
  } else {
    writeCommit(upstreamWork, "upstream.txt", "new upstream\n", "upstream change");
  }
  git(upstreamWork, "push", "origin", "main");

  const oldBuild = NodePath.join(install, "old.AppImage");
  NodeFS.writeFileSync(oldBuild, "old");
  const launcher = NodePath.join(install, "t3code");
  NodeFS.symlinkSync(oldBuild, launcher);
  const corepack = NodePath.join(fakeBin, "corepack");
  NodeFS.writeFileSync(corepack, "#!/usr/bin/env sh\nexit 0\n", { mode: 0o755 });

  const env: NodeJS.ProcessEnv = {
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    T3CODE_UPDATE_SKIP_NODE_SELECTION: "1",
    T3CODE_UPDATE_REPO_DIR: work,
    T3CODE_UPDATE_INSTALL_DIR: install,
    T3CODE_UPDATE_CHECK_COMMAND: "true",
    T3CODE_UPDATE_TYPECHECK_COMMAND: "true",
    T3CODE_UPDATE_TEST_COMMAND: "true",
    T3CODE_UPDATE_BUILD_COMMAND: 'touch "$T3CODE_DESKTOP_OUTPUT_DIR/T3-Code-test-x86_64.AppImage"',
  };
  return { work, install, launcher, oldBuild, env };
}

function runUpdate(fixture: ReturnType<typeof makeFixture>, action: string, env = fixture.env) {
  return command(fixture.work, SCRIPT_PATH, [action], env);
}

describe("local T3 Code fork updater", () => {
  it("rejects a dirty worktree without changing main or the launcher", () => {
    const fixture = makeFixture();
    const before = git(fixture.work, "rev-parse", "main");
    NodeFS.writeFileSync(NodePath.join(fixture.work, "dirty.txt"), "dirty");
    const result = runUpdate(fixture, "stage");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("nicht sauber");
    expect(git(fixture.work, "rev-parse", "main")).toBe(before);
    expect(NodeFS.realpathSync(fixture.launcher)).toBe(fixture.oldBuild);
  });

  it("aborts a merge conflict and preserves the active build", () => {
    const fixture = makeFixture({ conflict: true });
    const before = git(fixture.work, "rev-parse", "main");
    const result = runUpdate(fixture, "stage");
    expect(result.status).not.toBe(0);
    expect(git(fixture.work, "branch", "--show-current")).toBe("main");
    expect(git(fixture.work, "rev-parse", "main")).toBe(before);
    expect(NodeFS.realpathSync(fixture.launcher)).toBe(fixture.oldBuild);
  });

  it("does not advance main when a required check fails", () => {
    const fixture = makeFixture();
    const before = git(fixture.work, "rev-parse", "main");
    const result = runUpdate(fixture, "stage", {
      ...fixture.env,
      T3CODE_UPDATE_CHECK_COMMAND: "false",
    });
    expect(result.status).not.toBe(0);
    expect(git(fixture.work, "rev-parse", "main")).toBe(before);
    expect(NodeFS.realpathSync(fixture.launcher)).toBe(fixture.oldBuild);
  });

  it("stages, atomically activates, and rolls back a verified AppImage", () => {
    const fixture = makeFixture();
    const stage = runUpdate(fixture, "stage");
    expect(stage.status, stage.stderr).toBe(0);
    expect(NodeFS.realpathSync(fixture.launcher)).toBe(fixture.oldBuild);

    const statusPath = NodePath.join(fixture.install, ".t3code-local-update-status");
    const candidate = NodeFS.readFileSync(statusPath, "utf8")
      .split("\n")
      .find((line) => line.startsWith("candidate\t"))
      ?.slice("candidate\t".length);
    expect(candidate).toBeTruthy();
    expect(NodeFS.existsSync(candidate!)).toBe(true);

    expect(runUpdate(fixture, "activate").status).toBe(0);
    expect(NodeFS.realpathSync(fixture.launcher)).toBe(candidate);
    expect(runUpdate(fixture, "rollback").status).toBe(0);
    expect(NodeFS.realpathSync(fixture.launcher)).toBe(fixture.oldBuild);
  });

  it("never overwrites an existing active build for the same commit", () => {
    const fixture = makeFixture();
    expect(runUpdate(fixture, "stage").status).toBe(0);
    expect(runUpdate(fixture, "activate").status).toBe(0);
    const activeBuild = NodeFS.realpathSync(fixture.launcher);
    const before = NodeFS.readFileSync(activeBuild);

    const restage = runUpdate(fixture, "stage", {
      ...fixture.env,
      T3CODE_UPDATE_BUILD_COMMAND:
        'printf changed > "$T3CODE_DESKTOP_OUTPUT_DIR/T3-Code-test-x86_64.AppImage"',
    });

    expect(restage.status).not.toBe(0);
    expect(restage.stderr).toContain("abweichendem Inhalt");
    expect(NodeFS.readFileSync(activeBuild)).toEqual(before);
    expect(NodeFS.realpathSync(fixture.launcher)).toBe(activeBuild);
  });

  it("refuses rollback when the previous build checksum changed", () => {
    const fixture = makeFixture();
    expect(runUpdate(fixture, "stage").status).toBe(0);
    expect(runUpdate(fixture, "activate").status).toBe(0);
    const activeBuild = NodeFS.realpathSync(fixture.launcher);
    NodeFS.writeFileSync(fixture.oldBuild, "tampered");

    const rollback = runUpdate(fixture, "rollback");

    expect(rollback.status).not.toBe(0);
    expect(rollback.stderr).toContain("Prüfsumme des vorherigen Builds stimmt nicht");
    expect(NodeFS.realpathSync(fixture.launcher)).toBe(activeBuild);
  });
});
