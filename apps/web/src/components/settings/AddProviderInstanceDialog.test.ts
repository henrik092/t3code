import { describe, expect, it } from "vite-plus/test";

import {
  acpRegistryAgentSelection,
  filterAcpRegistryAgents,
  resolveWizardNavigation,
} from "./AddProviderInstanceDialog.logic";

const registryAgents = [
  {
    id: "kimi",
    name: "Kimi CLI",
    version: "1.49.0",
    description: "Kimi coding agent",
    icon: "https://example.test/kimi.svg",
    distribution: {},
  },
  {
    id: "other",
    name: "Another Agent",
    version: "1.0.0",
    description: "Independent ACP implementation",
    distribution: {},
  },
] as const;

describe("resolveWizardNavigation", () => {
  const invalidId = { instanceIdError: "Instance ID is required." };
  const validId = { instanceIdError: null };

  it("allows moving from Driver to Identity before the instance id is valid", () => {
    expect(resolveWizardNavigation(0, 1, 3, invalidId)).toEqual({ kind: "navigate", step: 1 });
  });

  it("blocks Next from Identity to Config while the instance id is invalid", () => {
    expect(resolveWizardNavigation(1, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("stops a direct Driver-to-Config skip at Identity and surfaces its error", () => {
    expect(resolveWizardNavigation(0, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("allows advancing and skipping forward once the instance id is valid", () => {
    expect(resolveWizardNavigation(1, 2, 3, validId)).toEqual({ kind: "navigate", step: 2 });
    expect(resolveWizardNavigation(0, 2, 3, validId)).toEqual({ kind: "navigate", step: 2 });
  });

  it("always preserves backward Driver and Identity navigation", () => {
    expect(resolveWizardNavigation(2, 1, 3, invalidId)).toEqual({ kind: "navigate", step: 1 });
    expect(resolveWizardNavigation(2, 0, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
    expect(resolveWizardNavigation(1, 0, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
  });

  it("clamps requested steps to the wizard bounds", () => {
    expect(resolveWizardNavigation(2, 8, 3, validId)).toEqual({ kind: "navigate", step: 2 });
    expect(resolveWizardNavigation(0, -1, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
  });

  it("searches ACP Registry agents by id, name, and description", () => {
    expect(filterAcpRegistryAgents(registryAgents, "KIMI").map((agent) => agent.id)).toEqual([
      "kimi",
    ]);
    expect(filterAcpRegistryAgents(registryAgents, "independent").map((agent) => agent.id)).toEqual(
      ["other"],
    );
    expect(filterAcpRegistryAgents(registryAgents, "")).toHaveLength(2);
  });

  it("builds the local Kimi K3 preset without duplicating its default model", () => {
    expect(acpRegistryAgentSelection(registryAgents[0]!)).toEqual({
      label: "Kimi K3",
      instanceId: "kimi",
      config: {
        agentId: "kimi",
        commandPath: "/home/rik/.kimi-code/bin/kimi",
        args: ["acp"],
        authMethodId: "login",
        defaultModel: "kimi-code/k3",
        customModels: ["kimi-code/kimi-for-coding", "kimi-code/kimi-for-coding-highspeed"],
        iconUrl: "https://example.test/kimi.svg",
      },
    });
  });
});
