import { describe, expect, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { AcpRegistryDriver } from "./AcpRegistryDriver.ts";

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
    });
  });
});
