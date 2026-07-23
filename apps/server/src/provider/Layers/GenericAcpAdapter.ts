import {
  ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  EventId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import { type AcpSessionRuntime } from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  type AcpSessionMode,
  type AcpSessionModeState,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { makeGenericAcpRuntime } from "../acp/GenericAcpSupport.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { type ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const GENERIC_ACP_RESUME_VERSION = 1 as const;
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  for (const alias of aliases) {
    const normalizedAlias = alias.toLowerCase();
    const exact = modes.find(
      (mode) =>
        mode.id.toLowerCase() === normalizedAlias || mode.name.toLowerCase() === normalizedAlias,
    );
    if (exact) return exact;
  }
  for (const alias of aliases) {
    const partial = modes.find((mode) =>
      normalizeModeSearchText(mode).includes(alias.toLowerCase()),
    );
    if (partial) return partial;
  }
  return undefined;
}

function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  if (!input.modeState) return undefined;
  if (input.interactionMode === "plan") {
    return findModeByAliases(input.modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }
  const aliases =
    input.runtimeMode === "approval-required"
      ? [...ACP_APPROVAL_MODE_ALIASES, ...ACP_IMPLEMENT_MODE_ALIASES]
      : [...ACP_IMPLEMENT_MODE_ALIASES, ...ACP_APPROVAL_MODE_ALIASES];
  return (
    findModeByAliases(input.modeState.availableModes, aliases)?.id ?? input.modeState.currentModeId
  );
}

export interface GenericAcpAdapterSettings {
  readonly enabled: boolean;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface GenericAcpAdapterOptions {
  readonly provider: ProviderDriverKind;
  readonly instanceId: ProviderSession["providerInstanceId"];
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly readyReason?: string;
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly authMethodId?: string | undefined;
  readonly sessionLoadNoActivityGrace?: Duration.Input;
  readonly normalizeModel?: (model: string | null | undefined) => string;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface GenericAcpSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly usesSessionModelApi: boolean;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathIsWithinRoot(pathService: Path.Path, root: string, target: string): boolean {
  const relative = pathService.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${pathService.sep}`) &&
      relative !== ".." &&
      !pathService.isAbsolute(relative))
  );
}

function parseGenericResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== GENERIC_ACP_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    pendingApprovals.values(),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    pendingUserInputs.values(),
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}

export function makeGenericAcpAdapter(
  settings: GenericAcpAdapterSettings,
  options: GenericAcpAdapterOptions,
) {
  return Effect.gen(function* () {
    const providerKind = options.provider;
    const readyReason = options.readyReason ?? "ACP session ready";
    const normalizeModel = options.normalizeModel ?? ((model) => model?.trim() || "default");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cryptoService = yield* Crypto.Crypto;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const nativeEventLogger =
      options.nativeEventLogger ??
      (options.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, GenericAcpSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = cryptoService.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: providerKind,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate ACP runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<GenericAcpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: providerKind, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: GenericAcpSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: providerKind,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== providerKind) {
            return yield* new ProviderAdapterValidationError({
              provider: providerKind,
              operation: "startSession",
              issue: `Expected provider '${providerKind}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: providerKind,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const command = settings.command.trim();
          if (!settings.enabled || command.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: providerKind,
              operation: "startSession",
              issue: "ACP command is not configured.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const canonicalCwd = yield* fileSystem.realPath(cwd).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterValidationError({
                  provider: providerKind,
                  operation: "startSession",
                  issue: `Workspace path is not accessible: ${cause.message}`,
                }),
            ),
          );
          const acpFilePathError = (method: string, requestedPath: string, detail: string) =>
            new EffectAcpErrors.AcpTransportError({
              operation: "call-rpc",
              method,
              detail: `${detail}: ${requestedPath}`,
              cause: undefined,
            });
          const resolveLexicalAcpPath = Effect.fn("resolveLexicalAcpPath")(function* (
            method: string,
            requestedPath: string,
          ) {
            const absolutePath = path.resolve(cwd, requestedPath);
            if (!pathIsWithinRoot(path, cwd, absolutePath)) {
              return yield* acpFilePathError(
                method,
                requestedPath,
                "Path resolves outside the workspace",
              );
            }
            return absolutePath;
          });
          const resolveReadableAcpPath = (requestedPath: string) =>
            resolveLexicalAcpPath("fs/read_text_file", requestedPath).pipe(
              Effect.flatMap((absolutePath) =>
                fileSystem
                  .realPath(absolutePath)
                  .pipe(
                    Effect.mapError((cause) =>
                      acpFilePathError("fs/read_text_file", requestedPath, cause.message),
                    ),
                  ),
              ),
              Effect.filterOrFail(
                (canonicalPath) => pathIsWithinRoot(path, canonicalCwd, canonicalPath),
                () =>
                  acpFilePathError(
                    "fs/read_text_file",
                    requestedPath,
                    "Canonical path resolves outside the workspace",
                  ),
              ),
            );
          const resolveWritableAcpPath = (requestedPath: string) =>
            resolveLexicalAcpPath("fs/write_text_file", requestedPath).pipe(
              Effect.flatMap((absolutePath) =>
                fileSystem.realPath(path.dirname(absolutePath)).pipe(
                  Effect.mapError((cause) =>
                    acpFilePathError("fs/write_text_file", requestedPath, cause.message),
                  ),
                  Effect.flatMap((canonicalParent) =>
                    pathIsWithinRoot(path, canonicalCwd, canonicalParent)
                      ? Effect.succeed(path.join(canonicalParent, path.basename(absolutePath)))
                      : Effect.fail(
                          acpFilePathError(
                            "fs/write_text_file",
                            requestedPath,
                            "Canonical parent resolves outside the workspace",
                          ),
                        ),
                  ),
                ),
              ),
            );
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: GenericAcpSessionContext;

          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: providerKind,
            threadId: input.threadId,
          });
          const resumeSessionId = parseGenericResume(input.resumeCursor)?.sessionId;
          const acp = yield* makeGenericAcpRuntime({
            spawn: {
              command,
              args: settings.args,
              cwd,
              ...(options.environment ? { env: options.environment } : {}),
            },
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            authMethodId: options.authMethodId?.trim() || "login",
            ...(options.sessionLoadNoActivityGrace
              ? { sessionLoadNoActivityGrace: options.sessionLoadNoActivityGrace }
              : {}),
            clientCapabilities: {
              ...options.clientCapabilities,
              fs: {
                readTextFile: true,
                writeTextFile: true,
                ...options.clientCapabilities?.fs,
              },
            },
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, cryptoService),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: providerKind,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          const started = yield* Effect.gen(function* () {
            yield* acp.handleReadTextFile((params) =>
              resolveReadableAcpPath(params.path).pipe(
                Effect.flatMap(fileSystem.readFileString),
                Effect.map((content) => {
                  if (params.line == null && params.limit == null) return { content };
                  const lines = content.split("\n");
                  const start = Math.max(0, (params.line ?? 1) - 1);
                  const end = params.limit == null ? undefined : start + params.limit;
                  return { content: lines.slice(start, end).join("\n") };
                }),
                Effect.mapError(
                  (cause) =>
                    new EffectAcpErrors.AcpTransportError({
                      operation: "call-rpc",
                      method: "fs/read_text_file",
                      detail: cause.message,
                      cause,
                    }),
                ),
              ),
            );
            yield* acp.handleWriteTextFile((params) =>
              resolveWritableAcpPath(params.path).pipe(
                Effect.flatMap((targetPath) =>
                  fileSystem.writeFileString(targetPath, params.content),
                ),
                Effect.mapError(
                  (cause) =>
                    new EffectAcpErrors.AcpTransportError({
                      operation: "call-rpc",
                      method: "fs/write_text_file",
                      detail: cause.message,
                      cause,
                    }),
                ),
              ),
            );
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                if (input.runtimeMode === "full-access") {
                  const autoApprovedOptionId =
                    params.options.find((option) => option.kind === "allow_always")?.optionId ??
                    params.options.find((option) => option.kind === "allow_once")?.optionId;
                  if (typeof autoApprovedOptionId === "string" && autoApprovedOptionId.trim()) {
                    return {
                      outcome: {
                        outcome: "selected" as const,
                        optionId: autoApprovedOptionId.trim(),
                      },
                    };
                  }
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, { decision });
                yield* offerRuntimeEvent(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: providerKind,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail:
                      permissionRequest.detail ??
                      encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                      "[unserializable params]",
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: providerKind,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                return {
                  outcome:
                    resolved === "cancel"
                      ? ({ outcome: "cancelled" } as const)
                      : {
                          outcome: "selected" as const,
                          optionId: acpPermissionOutcome(resolved),
                        },
                };
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new EffectAcpErrors.AcpTransportError({
                      detail: "Failed to process ACP permission request.",
                      cause,
                    }),
                ),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(providerKind, input.threadId, "session/start", error),
            ),
          );

          const initialModelSelection =
            input.modelSelection?.instanceId === options.instanceId
              ? input.modelSelection
              : undefined;
          if (initialModelSelection?.model) {
            const model = normalizeModel(initialModelSelection.model);
            if (model !== "default") {
              const usesSessionModelApi = started.sessionSetupResult.models !== undefined;
              yield* acp[usesSessionModelApi ? "setSessionModel" : "setModel"](model).pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(
                    providerKind,
                    input.threadId,
                    "session/set_config_option",
                    error,
                  ),
                ),
              );
            }
          }

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: providerKind,
            providerInstanceId: options.instanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: initialModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: GENERIC_ACP_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            usesSessionModelApi: started.sessionSetupResult.models !== undefined,
            activeTurnId: undefined,
            stopped: false,
          };

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: providerKind,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: providerKind,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* offerRuntimeEvent(
                      makeAcpPlanUpdatedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: providerKind,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        payload: event.payload,
                        source: "acp.jsonrpc",
                        method: "session/update",
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: providerKind,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: providerKind,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process generic ACP runtime notification.", { cause }),
            ),
            Effect.forkChild,
          );

          ctx.notificationFiber = notificationFiber;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: providerKind,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: providerKind,
            threadId: input.threadId,
            payload: { state: "ready", reason: readyReason },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: providerKind,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turnId = TurnId.make(yield* randomUUIDv4);
        const turnModelSelection =
          input.modelSelection?.instanceId === options.instanceId
            ? input.modelSelection
            : undefined;
        const model = turnModelSelection?.model ?? ctx.session.model;
        const resolvedModel = normalizeModel(model);
        if (model !== undefined && resolvedModel !== "default") {
          yield* ctx.acp[ctx.usesSessionModelApi ? "setSessionModel" : "setModel"](
            resolvedModel,
          ).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(
                providerKind,
                input.threadId,
                "session/set_config_option",
                error,
              ),
            ),
          );
        }
        const requestedModeId = resolveRequestedModeId({
          interactionMode: input.interactionMode,
          runtimeMode: ctx.session.runtimeMode,
          modeState: yield* ctx.acp.getModeState,
        });
        if (requestedModeId) {
          yield* ctx.acp
            .setMode(requestedModeId)
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(providerKind, input.threadId, "session/set_mode", error),
              ),
            );
        }

        ctx.activeTurnId = turnId;
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: providerKind,
          threadId: input.threadId,
          turnId,
          payload: { model: resolvedModel },
        });

        const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
        if (input.input?.trim()) {
          promptParts.push({ type: "text", text: input.input.trim() });
        }
        if (input.attachments && input.attachments.length > 0) {
          for (const attachment of input.attachments) {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: providerKind,
                method: "session/prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: providerKind,
                    method: "session/prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            promptParts.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
        }

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: providerKind,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        const result = yield* ctx.acp
          .prompt({ prompt: promptParts })
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(providerKind, input.threadId, "session/prompt", error),
            ),
          );

        ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
          model: resolvedModel,
        };

        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: providerKind,
          threadId: input.threadId,
          turnId,
          payload: {
            state: result.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: result.stopReason ?? null,
          },
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(providerKind, threadId, "session/cancel", error),
            ),
          ),
        );
      });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: providerKind,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: providerKind,
            method: "elicitation/create",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: providerKind,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
      });

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));
    const hasSession = (threadId: ThreadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });
    const stopAll = () => Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.ignore,
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: providerKind,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
