import { describe, expect, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { AcpRegistryDriver, applyAcpModelDisplayNames } from "./AcpRegistryDriver.ts";

describe("AcpRegistryDriver", () => {
  it("is registered as a multi-instance built-in provider", () => {
    expect(AcpRegistryDriver.driverKind).toBe("acpRegistry");
    expect(AcpRegistryDriver.metadata.supportsMultipleInstances).toBe(true);
    expect(BUILT_IN_DRIVERS).toContain(AcpRegistryDriver);
  });

  it("uses safe manual-launch defaults", () => {
    expect(AcpRegistryDriver.defaultConfig()).toMatchObject({
      enabled: true,
      commandPath: "",
      args: [],
      authMethodId: "login",
      defaultModel: "default",
      customModels: [],
      modelNames: {},
    });
  });

  it("applies configured display names without touching slugs or unnamed models", () => {
    const models = [
      { slug: "kimi-code/k3", name: "kimi-code/k3", isCustom: false, capabilities: null },
      {
        slug: "kimi-code/kimi-for-coding",
        name: "kimi-code/kimi-for-coding",
        isCustom: true,
        capabilities: null,
      },
      { slug: "other/model", name: "other/model", isCustom: true, capabilities: null },
    ];

    const renamed = applyAcpModelDisplayNames(models, {
      "kimi-code/k3": "K3",
      "kimi-code/kimi-for-coding": "K2.7 Coding",
    });

    expect(renamed.map((model) => model.slug)).toEqual([
      "kimi-code/k3",
      "kimi-code/kimi-for-coding",
      "other/model",
    ]);
    expect(renamed.map((model) => model.name)).toEqual(["K3", "K2.7 Coding", "other/model"]);
  });
});
