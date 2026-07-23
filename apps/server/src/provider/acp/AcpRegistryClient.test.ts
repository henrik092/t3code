import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import { listAcpRegistryAgents, type AcpRegistryFetch } from "./AcpRegistryClient.ts";

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("listAcpRegistryAgents", () => {
  it.effect("validates and sorts registry agents", () =>
    Effect.gen(function* () {
      const fetch: AcpRegistryFetch = async () =>
        response({
          version: "1.0.0",
          agents: [
            {
              id: "zed",
              name: "Zed",
              version: "1.0.0",
              description: "Zed agent",
              distribution: {},
            },
            {
              id: "kimi",
              name: "Kimi CLI",
              version: "1.49.0",
              description: "Moonshot AI coding assistant",
              distribution: {
                binary: {
                  "linux-x86_64": {
                    archive: "https://example.test/kimi.tar.gz",
                    cmd: "./kimi",
                    args: ["acp"],
                    sha256: "abc123",
                  },
                },
              },
            },
          ],
        });

      const result = yield* listAcpRegistryAgents({ fetch });

      expect(result.status).toBe("ready");
      expect(result.agents.map((agent) => agent.id)).toEqual(["kimi", "zed"]);
    }),
  );

  it.effect("returns an unavailable result for invalid payloads", () =>
    Effect.gen(function* () {
      const fetch: AcpRegistryFetch = async () => response({ version: "1", agents: [{ id: 1 }] });

      const result = yield* listAcpRegistryAgents({ fetch });

      expect(result.status).toBe("unavailable");
      expect(result.agents).toEqual([]);
    }),
  );

  it.effect("returns an unavailable result when the registry is offline", () =>
    Effect.gen(function* () {
      const fetch: AcpRegistryFetch = async () => {
        throw new Error("offline");
      };

      const result = yield* listAcpRegistryAgents({ fetch });

      expect(result.status).toBe("unavailable");
      expect(result.message).toContain("offline");
    }),
  );
});
