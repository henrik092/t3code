import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildProviderInstanceUpdatePatch,
  deriveProviderSettingsInstanceRows,
  formatDiagnosticsDescription,
} from "./SettingsPanels.logic";

describe("deriveProviderSettingsInstanceRows", () => {
  it("does not synthesize a legacy card for an instance-only provider", () => {
    const rows = deriveProviderSettingsInstanceRows({
      settings: DEFAULT_SERVER_SETTINGS,
      visibleDrivers: [ProviderDriverKind.make("acpRegistry")],
    });

    expect(rows).toEqual([]);
  });

  it("includes configured ACP instances alongside synthesized legacy providers", () => {
    const kimiInstanceId = ProviderInstanceId.make("kimi");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [kimiInstanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          displayName: "Kimi K3",
          enabled: true,
          config: { commandPath: "/opt/kimi", args: ["acp"] },
        },
      },
    };

    const rows = deriveProviderSettingsInstanceRows({
      settings,
      visibleDrivers: [ProviderDriverKind.make("codex"), ProviderDriverKind.make("acpRegistry")],
    });

    expect(rows.map((row) => row.instanceId)).toEqual([
      ProviderInstanceId.make("codex"),
      kimiInstanceId,
    ]);
    expect(rows[1]).toMatchObject({
      instance: settings.providerInstances[kimiInstanceId],
      driver: ProviderDriverKind.make("acpRegistry"),
      isDefault: false,
    });
  });

  it("renders an explicit canonical ACP instance without treating it as a legacy default", () => {
    const instanceId = ProviderInstanceId.make("acpRegistry");
    const instance = {
      driver: ProviderDriverKind.make("acpRegistry"),
      enabled: true,
      config: { commandPath: "/opt/acp-agent" },
    } satisfies ProviderInstanceConfig;

    const rows = deriveProviderSettingsInstanceRows({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: { [instanceId]: instance },
      },
      visibleDrivers: [ProviderDriverKind.make("acpRegistry")],
    });

    expect(rows).toEqual([
      {
        instanceId,
        instance,
        driver: ProviderDriverKind.make("acpRegistry"),
        isDefault: false,
        isDirty: true,
      },
    ]);
  });
});

describe("formatDiagnosticsDescription", () => {
  it("collapses trace and metric URLs that share the same OTEL base path", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      }),
    ).toBe("Local trace file. Exporting OTEL to http://localhost:4318/v1/{traces,metrics}.");
  });

  it("keeps separate trace and metric URLs when their base paths differ", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:9000/v1/metrics",
      }),
    ).toBe(
      "Local trace file. Exporting OTEL traces to http://localhost:4318/v1/traces and metrics to http://localhost:9000/v1/metrics.",
    );
  });

  it("omits OTEL text when no exporter is enabled", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      }),
    ).toBe("Local trace file.");
  });
});

describe("buildProviderInstanceUpdatePatch", () => {
  it("promotes an edited default provider into providerInstances and resets the legacy provider", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        binaryPath: "/opt/t3/codex",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            binaryPath: "/legacy/codex",
          },
        },
      },
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: true,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("updates custom instances without touching legacy provider settings", () => {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        homePath: "/Users/example/.codex-personal",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: false,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers).toBeUndefined();
  });
});
