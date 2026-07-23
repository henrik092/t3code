/**
 * Optional read-only integration check against the locally authenticated Kimi CLI.
 * Enable with: T3_KIMI_ACP_PROBE=1 vp test KimiAcpCliProbe
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { describe, expect } from "vite-plus/test";

import { makeGenericAcpRuntime } from "./GenericAcpSupport.ts";

const KIMI_BINARY = "/home/rik/.kimi-code/bin/kimi";
const KIMI_PROBE_LOG = "/tmp/t3-kimi-acp-probe.log";

const makeProbeRuntime = (cwd: string, resumeSessionId?: string) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* makeGenericAcpRuntime({
      spawn: { command: KIMI_BINARY, args: ["acp"], cwd, env: process.env },
      childProcessSpawner,
      cwd,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      authMethodId: "login",
      sessionLoadNoActivityGrace: "5 seconds",
      clientInfo: { name: "t3-kimi-probe", version: "0.0.0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      requestLogger: (event) =>
        fileSystem
          .writeFileString(KIMI_PROBE_LOG, `${event.method}\t${event.status}\n`, { flag: "a" })
          .pipe(Effect.ignore),
    });
  });

const runReadOnlyPrompt = (
  cwd: string,
  promptText: string,
  resumeSessionId?: string,
  approvePermissions = true,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.remove(KIMI_PROBE_LOG).pipe(Effect.ignore);
      const runtime = yield* makeProbeRuntime(cwd, resumeSessionId);
      let permissionRequests = 0;
      yield* runtime.handleRequestPermission((request) => {
        const option =
          request.options.find((candidate) => candidate.kind === "allow_once") ??
          request.options.find((candidate) => candidate.kind === "allow_always");
        return Effect.sync(() => {
          permissionRequests += 1;
          return approvePermissions && option
            ? { outcome: { outcome: "selected" as const, optionId: option.optionId } }
            : { outcome: { outcome: "cancelled" as const } };
        });
      });
      const started = yield* runtime.start();
      const initialModeState = yield* runtime.getModeState;
      const planMode = initialModeState?.availableModes.find((mode) =>
        `${mode.id} ${mode.name}`.toLowerCase().includes("plan"),
      );
      if (planMode) {
        yield* runtime.setMode(planMode.id);
        if (initialModeState?.currentModeId && initialModeState.currentModeId !== planMode.id) {
          yield* runtime.setMode(initialModeState.currentModeId);
        }
      }
      const streamedText: string[] = [];
      const eventFiber = yield* runtime.getEvents().pipe(
        Stream.runForEach((event) =>
          event._tag === "EventStreamBarrier"
            ? Deferred.succeed(event.acknowledge, undefined)
            : Effect.sync(() => {
                if (event._tag === "ContentDelta") streamedText.push(event.text);
              }),
        ),
        Effect.forkScoped,
      );
      yield* runtime.setModel("kimi-code/k3");
      const result = yield* runtime.prompt({
        prompt: [
          {
            type: "text",
            text: promptText,
          },
        ],
      });
      yield* runtime.drainEvents;
      yield* Fiber.interrupt(eventFiber);
      return {
        sessionId: started.sessionId,
        stopReason: result.stopReason,
        text: streamedText.join(""),
        hasPlanMode: planMode !== undefined,
        permissionRequests,
      };
    }),
  );

describe.runIf(process.env.T3_KIMI_ACP_PROBE === "1")("Kimi ACP CLI probe", () => {
  it.effect("streams a K3 response and reloads the ACP session", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kimi-acp-probe-" });
      yield* fileSystem.writeFileString(
        `${cwd}/package.json`,
        '{"name":"t3-kimi-acp-probe","private":true}\n',
      );
      const first = yield* runReadOnlyPrompt(
        cwd,
        "Read package.json without changing files. Reply with only its package name.",
      );
      expect(first.sessionId).not.toBe("");
      expect(first.stopReason).not.toBe("cancelled");
      expect(first.text).toContain("t3-kimi-acp-probe");
      expect(first.hasPlanMode).toBe(true);

      const resumed = yield* runReadOnlyPrompt(
        cwd,
        "Reply with exactly: KIMI_RESUME_OK",
        first.sessionId,
      );
      expect(resumed.sessionId).toBe(first.sessionId);
      expect(resumed.stopReason).not.toBe("cancelled");
      expect(resumed.text).toContain("KIMI_RESUME_OK");

      const denied = yield* runReadOnlyPrompt(
        cwd,
        "Create a file named denied.txt containing test.",
        undefined,
        false,
      );
      expect(denied.permissionRequests).toBeGreaterThan(0);
      expect(yield* fileSystem.exists(`${cwd}/denied.txt`)).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.timeout("180 seconds"),
      Effect.provide(NodeServices.layer),
      TestClock.withLive,
    ),
  );

  it.effect("cancels an active K3 prompt", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kimi-acp-cancel-" });
      yield* fileSystem.writeFileString(
        `${cwd}/package.json`,
        '{"name":"t3-kimi-acp-cancel","private":true}\n',
      );
      const runtime = yield* makeProbeRuntime(cwd);
      yield* runtime.handleRequestPermission(() =>
        Effect.succeed({ outcome: { outcome: "cancelled" as const } }),
      );
      yield* runtime.start();
      yield* runtime.setModel("kimi-code/k3");
      const promptFiber = yield* runtime
        .prompt({
          prompt: [
            {
              type: "text",
              text: "Carefully analyze package.json and propose twenty possible improvements.",
            },
          ],
        })
        .pipe(Effect.forkScoped);
      yield* Effect.sleep("100 millis");
      yield* runtime.cancel;
      const result = yield* Fiber.join(promptFiber).pipe(Effect.timeout("20 seconds"));
      expect(result.stopReason).toBe("cancelled");
    }).pipe(
      Effect.scoped,
      Effect.timeout("40 seconds"),
      Effect.provide(NodeServices.layer),
      TestClock.withLive,
    ),
  );
});
