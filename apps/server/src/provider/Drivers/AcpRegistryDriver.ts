import {
  AcpRegistrySettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeGenericAcpAdapter } from "../Layers/GenericAcpAdapter.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const decodeAcpRegistrySettings = Schema.decodeSync(AcpRegistrySettings);

export type AcpRegistryDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

const unsupportedTextGeneration = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Generic ACP providers do not support git text generation yet.",
    }),
  );

const makeTextGeneration = () => ({
  generateCommitMessage: () => unsupportedTextGeneration("generateCommitMessage"),
  generatePrContent: () => unsupportedTextGeneration("generatePrContent"),
  generateBranchName: () => unsupportedTextGeneration("generateBranchName"),
  generateThreadTitle: () => unsupportedTextGeneration("generateThreadTitle"),
});

function withIdentity(input: {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly iconUrl: string | undefined;
  readonly continuationGroupKey: string;
}) {
  return (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    ...(input.iconUrl ? { iconUrl: input.iconUrl } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });
}

export function applyAcpModelDisplayNames(
  models: ReadonlyArray<ServerProviderModel>,
  modelNames: Readonly<Record<string, string>>,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    const name = modelNames[model.slug];
    return name !== undefined && name !== model.name ? { ...model, name } : model;
  });
}

function initialSnapshot(settings: AcpRegistrySettings, checkedAt: string): ServerProviderDraft {
  const command = settings.commandPath.trim();
  const enabled = settings.enabled && command.length > 0;
  const defaultModel = settings.defaultModel.trim() || "default";
  return buildServerProvider({
    presentation: {
      displayName: "ACP Registry",
      badgeLabel: "ACP",
      showInteractionModeToggle: true,
    },
    enabled,
    checkedAt,
    models: applyAcpModelDisplayNames(
      providerModelsFromSettings(
        [
          {
            slug: defaultModel,
            name: defaultModel === "default" ? "Default" : defaultModel,
            isCustom: false,
            isDefault: true,
            capabilities: null,
          },
        ],
        settings.customModels,
        { optionDescriptors: [] },
      ),
      settings.modelNames,
    ),
    probe: {
      installed: enabled,
      version: null,
      status: enabled ? "ready" : "warning",
      auth: { status: "unknown" },
      message: enabled ? "ACP provider configured." : "Configure a launch command to enable.",
    },
  });
}

export const AcpRegistryDriver: ProviderDriver<AcpRegistrySettings, AcpRegistryDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "ACP Registry",
    supportsMultipleInstances: true,
  },
  configSchema: AcpRegistrySettings,
  defaultConfig: (): AcpRegistrySettings => decodeAcpRegistrySettings({}),
  create: ({ instanceId, displayName, accentColor, iconUrl, environment, enabled, config }) =>
    Effect.gen(function* () {
      const eventLoggers = yield* ProviderEventLoggers;
      const effectiveConfig = { ...config, enabled: enabled && config.enabled };
      const effectiveIconUrl = iconUrl ?? (effectiveConfig.iconUrl || undefined);
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stamp = withIdentity({
        instanceId,
        displayName,
        accentColor,
        iconUrl: effectiveIconUrl,
        continuationGroupKey: continuationIdentity.continuationKey,
      });

      const adapter = yield* makeGenericAcpAdapter(
        {
          enabled: effectiveConfig.enabled,
          command: effectiveConfig.commandPath,
          args: effectiveConfig.args,
        },
        {
          provider: DRIVER_KIND,
          instanceId,
          environment: processEnv,
          readyReason: "ACP session ready",
          authMethodId: effectiveConfig.authMethodId,
          ...(effectiveConfig.agentId === "kimi"
            ? { sessionLoadNoActivityGrace: "5 seconds" }
            : {}),
          ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        },
      );
      const checkedAt = DateTime.formatIso(yield* DateTime.now);

      const snapshot = yield* makeManagedServerProvider<AcpRegistrySettings>({
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER_KIND,
          packageName: null,
        }),
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => Effect.succeed(stamp(initialSnapshot(settings, checkedAt))),
        checkProvider: Effect.succeed(stamp(initialSnapshot(effectiveConfig, checkedAt))),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build ACP Registry snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        iconUrl: effectiveIconUrl,
        enabled: effectiveConfig.enabled,
        snapshot,
        adapter,
        textGeneration: makeTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
