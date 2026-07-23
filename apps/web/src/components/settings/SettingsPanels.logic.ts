import {
  defaultInstanceIdForDriver,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerSettings,
  type SidebarProjectGroupingMode,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import * as Equal from "effect/Equal";

export interface ProviderSettingsInstanceRow {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly isDirty?: boolean;
}

/**
 * Build the provider cards shown in settings without assuming every driver
 * has a legacy `settings.providers` slot. Package-style drivers such as ACP
 * Registry only exist as provider instances, while the original built-ins
 * still synthesize a default card from their legacy settings.
 */
export function deriveProviderSettingsInstanceRows(input: {
  readonly settings: Pick<UnifiedSettings, "providers" | "providerInstances">;
  readonly visibleDrivers: ReadonlyArray<ProviderDriverKind>;
}): ReadonlyArray<ProviderSettingsInstanceRow> {
  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(input.settings.providerInstances ?? {})) {
    const list = instancesByDriver.get(instance.driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(instance.driver, list);
  }

  type LegacyProviderSettings = UnifiedSettings["providers"][keyof UnifiedSettings["providers"]];
  const legacyProviders = input.settings.providers as Record<
    string,
    LegacyProviderSettings | undefined
  >;
  const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
    string,
    LegacyProviderSettings | undefined
  >;
  const visibleDriverSet = new Set(input.visibleDrivers);
  const defaultSlotIds = new Set(
    input.visibleDrivers.map((driver) => String(defaultInstanceIdForDriver(driver))),
  );
  const rows: ProviderSettingsInstanceRow[] = [];

  for (const driver of input.visibleDrivers) {
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = input.settings.providerInstances?.[defaultInstanceId];
    const legacyConfig = legacyProviders[driver];
    const defaultLegacyConfig = defaultLegacyProviders[driver];

    if (explicitInstance !== undefined) {
      rows.push({
        instanceId: defaultInstanceId,
        instance: explicitInstance,
        driver,
        // Only legacy-backed defaults are non-deletable/resettable. An
        // instance-only driver may legitimately use its driver kind as an ID.
        isDefault: defaultLegacyConfig !== undefined,
        isDirty: true,
      });
    } else if (legacyConfig !== undefined && defaultLegacyConfig !== undefined) {
      rows.push({
        instanceId: defaultInstanceId,
        instance: {
          driver,
          enabled: legacyConfig.enabled,
          config: legacyConfig,
        },
        driver,
        isDefault: true,
        isDirty: !Equal.equals(legacyConfig, defaultLegacyConfig),
      });
    }

    for (const [instanceId, instance] of instancesByDriver.get(driver) ?? []) {
      if (instanceId === defaultInstanceId) continue;
      rows.push({ instanceId, instance, driver: instance.driver, isDefault: false });
    }
  }

  for (const [driver, instances] of instancesByDriver) {
    if (visibleDriverSet.has(driver)) continue;
    for (const [instanceId, instance] of instances) {
      rows.push({
        instanceId,
        instance,
        driver: instance.driver,
        isDefault: defaultSlotIds.has(String(instanceId)),
      });
    }
  }

  return rows;
}

export function isProjectGroupingEnabled(mode: SidebarProjectGroupingMode): boolean {
  return mode !== "separate";
}

export function projectGroupingModeFromToggle(
  enabled: boolean,
  lastEnabledMode: SidebarProjectGroupingMode = "repository",
): SidebarProjectGroupingMode {
  if (!enabled) return "separate";
  return lastEnabledMode === "repository_path" ? "repository_path" : "repository";
}

const LAST_ENABLED_PROJECT_GROUPING_MODE_KEY = "t3code:last-enabled-project-grouping-mode";

export function readLastEnabledProjectGroupingMode(): SidebarProjectGroupingMode {
  try {
    return localStorage.getItem(LAST_ENABLED_PROJECT_GROUPING_MODE_KEY) === "repository_path"
      ? "repository_path"
      : "repository";
  } catch {
    return "repository";
  }
}

export function rememberEnabledProjectGroupingMode(mode: SidebarProjectGroupingMode): void {
  if (mode === "separate") return;
  try {
    localStorage.setItem(LAST_ENABLED_PROJECT_GROUPING_MODE_KEY, mode);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function collapseOtelSignalsUrl(input: {
  readonly tracesUrl: string;
  readonly metricsUrl: string;
}): string | null {
  const tracesSuffix = "/traces";
  const metricsSuffix = "/metrics";
  if (!input.tracesUrl.endsWith(tracesSuffix) || !input.metricsUrl.endsWith(metricsSuffix)) {
    return null;
  }

  const tracesBase = input.tracesUrl.slice(0, -tracesSuffix.length);
  const metricsBase = input.metricsUrl.slice(0, -metricsSuffix.length);
  if (tracesBase !== metricsBase) {
    return null;
  }

  return `${tracesBase}/{traces,metrics}`;
}

export function formatDiagnosticsDescription(input: {
  readonly localTracingEnabled: boolean;
  readonly otlpTracesEnabled: boolean;
  readonly otlpTracesUrl?: string | undefined;
  readonly otlpMetricsEnabled: boolean;
  readonly otlpMetricsUrl?: string | undefined;
}): string {
  const mode = input.localTracingEnabled ? "Local trace file" : "Terminal logs only";
  const tracesUrl = input.otlpTracesEnabled ? input.otlpTracesUrl : undefined;
  const metricsUrl = input.otlpMetricsEnabled ? input.otlpMetricsUrl : undefined;

  if (tracesUrl && metricsUrl) {
    const collapsedUrl = collapseOtelSignalsUrl({ tracesUrl, metricsUrl });
    return collapsedUrl
      ? `${mode}. Exporting OTEL to ${collapsedUrl}.`
      : `${mode}. Exporting OTEL traces to ${tracesUrl} and metrics to ${metricsUrl}.`;
  }

  if (tracesUrl) {
    return `${mode}. Exporting OTEL traces to ${tracesUrl}.`;
  }

  if (metricsUrl) {
    return `${mode}. Exporting OTEL metrics to ${metricsUrl}.`;
  }

  return `${mode}.`;
}

export function buildProviderInstanceUpdatePatch(input: {
  readonly settings: Pick<ServerSettings, "providers" | "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly textGenerationModelSelection?:
    | ServerSettings["textGenerationModelSelection"]
    | undefined;
}): Partial<UnifiedSettings> {
  type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];
  const legacyProviderDefaults = DEFAULT_UNIFIED_SETTINGS.providers as Record<
    string,
    LegacyProviderSettings | undefined
  >;
  const legacyProviderDefault = input.isDefault ? legacyProviderDefaults[input.driver] : undefined;
  return {
    ...(legacyProviderDefault !== undefined
      ? {
          providers: {
            ...input.settings.providers,
            [input.driver]: legacyProviderDefault,
          } as ServerSettings["providers"],
        }
      : {}),
    providerInstances: {
      ...input.settings.providerInstances,
      [input.instanceId]: input.instance,
    },
    ...(input.textGenerationModelSelection !== undefined
      ? { textGenerationModelSelection: input.textGenerationModelSelection }
      : {}),
  };
}
