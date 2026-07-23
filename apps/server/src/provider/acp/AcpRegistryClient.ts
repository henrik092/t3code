import {
  AcpRegistryIndex,
  DEFAULT_ACP_REGISTRY_URL,
  type AcpRegistryListResult,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const REGISTRY_TIMEOUT_MS = 5_000;

class AcpRegistryRequestError extends Data.TaggedError("AcpRegistryRequestError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export type AcpRegistryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function listAcpRegistryAgents(options?: {
  readonly registryUrl?: string;
  readonly fetch?: AcpRegistryFetch;
}): Effect.Effect<AcpRegistryListResult> {
  const registryUrl = options?.registryUrl?.trim() || DEFAULT_ACP_REGISTRY_URL;
  const fetchRegistry = options?.fetch ?? globalThis.fetch;

  return Effect.tryPromise({
    try: async () => {
      const response = await fetchRegistry(registryUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new AcpRegistryRequestError({
          detail: `Registry request failed with status ${response.status}.`,
        });
      }
      return response.json();
    },
    catch: (cause) =>
      cause instanceof AcpRegistryRequestError
        ? cause
        : new AcpRegistryRequestError({
            detail:
              cause instanceof Error && cause.message.trim()
                ? cause.message
                : "ACP Registry request failed.",
            cause,
          }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AcpRegistryIndex)),
    Effect.map(
      (registry): AcpRegistryListResult => ({
        status: "ready",
        registryVersion: registry.version,
        agents: registry.agents.toSorted((left, right) => left.name.localeCompare(right.name)),
      }),
    ),
    Effect.catch((cause) =>
      Effect.succeed({
        status: "unavailable" as const,
        registryVersion: null,
        agents: [],
        message:
          cause instanceof AcpRegistryRequestError
            ? cause.detail
            : "ACP Registry response is invalid.",
      }),
    ),
  );
}
