import type { AcpRegistryAgent } from "@t3tools/contracts";

export type WizardNavigation =
  | { readonly kind: "navigate"; readonly step: number }
  | { readonly kind: "blocked"; readonly step: number; readonly error: string };

const IDENTITY_STEP = 1;

export const ADD_PROVIDER_WIZARD_STEPS = ["Driver", "Identity", "Config"] as const;

export function filterAcpRegistryAgents(
  agents: ReadonlyArray<AcpRegistryAgent>,
  search: string,
): ReadonlyArray<AcpRegistryAgent> {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return agents;
  return agents.filter((agent) =>
    [agent.id, agent.name, agent.description].some((value) =>
      value.toLocaleLowerCase().includes(query),
    ),
  );
}

export function acpRegistryAgentSelection(agent: AcpRegistryAgent): {
  readonly label?: string;
  readonly instanceId?: string;
  readonly config: Record<string, unknown>;
} {
  const isKimi = agent.id === "kimi";
  return {
    ...(isKimi ? { label: "Kimi K3", instanceId: "kimi" } : {}),
    config: {
      agentId: agent.id,
      commandPath: isKimi ? "/home/rik/.kimi-code/bin/kimi" : "",
      args: isKimi ? ["acp"] : [],
      authMethodId: isKimi ? "login" : "",
      defaultModel: isKimi ? "kimi-code/k3" : "default",
      customModels: isKimi
        ? ["kimi-code/kimi-for-coding", "kimi-code/kimi-for-coding-highspeed"]
        : [],
      ...(agent.icon ? { iconUrl: agent.icon } : {}),
    },
  };
}

/**
 * Resolve navigation within the add-provider wizard.
 *
 * Moving forward past Identity requires a valid instance id, whether the user
 * advances one step at a time or skips directly to Config from a step header.
 * A blocked skip lands on Identity so its existing inline validation is
 * visible. Backward navigation is always preserved.
 */
export function resolveWizardNavigation(
  currentStep: number,
  requestedStep: number,
  stepCount: number,
  validation: { readonly instanceIdError: string | null },
): WizardNavigation {
  const lastStep = Math.max(0, stepCount - 1);
  const targetStep = Math.max(0, Math.min(lastStep, requestedStep));
  const movesForwardPastIdentity = currentStep <= IDENTITY_STEP && targetStep > IDENTITY_STEP;

  if (movesForwardPastIdentity && validation.instanceIdError !== null) {
    return {
      kind: "blocked",
      step: Math.min(IDENTITY_STEP, lastStep),
      error: validation.instanceIdError,
    };
  }

  return { kind: "navigate", step: targetStep };
}
