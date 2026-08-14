import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  resolveCodexLaunchArgs,
  T3_CODEX_DEFAULT_APP_SERVER_ARGS,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses T3CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when T3CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { T3CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("enables interactive questions in default mode without machine-local config", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), [
      "app-server",
      ...T3_CODEX_DEFAULT_APP_SERVER_ARGS,
    ]);
  });

  it("appends parsed launch args after portable T3 defaults", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      ...T3_CODEX_DEFAULT_APP_SERVER_ARGS,
      "--strict-config",
      "--enable",
      "foo",
    ]);
  });

  it("keeps an explicit user override after the portable default", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--disable default_mode_request_user_input"), [
      "app-server",
      ...T3_CODEX_DEFAULT_APP_SERVER_ARGS,
      "--disable",
      "default_mode_request_user_input",
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});
