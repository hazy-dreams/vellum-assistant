/**
 * Tests for the inference model-catalog route handler.
 *
 *   GET /v1/inference/models  — list all catalog models, optional ?provider=
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { z } from "zod";
const discovery = mock(
  async (_options: unknown): Promise<Record<string, unknown>> => ({
    ok: true,
    models: [
      {
        provider: "claude-agent-sdk",
        id: "new-model",
        displayName: "New Model",
        description: "SDK choice",
        supportsEffort: true,
        supportedEffortLevels: ["high"],
      },
    ],
    fetchedAt: "2026-10-11T00:00:00.000Z",
  }),
);
mock.module("../../../agent/claude-sdk/models.js", () => ({
  ClaudeSdkDiscoveredModelSchema: z.object({ id: z.string() }),
  discoverClaudeSdkModels: discovery,
}));
mock.module("../../../config/loader.js", () => ({
  getConfigReadOnly: () => ({
    llm: { claudeAgentSdk: { executablePath: "/test/claude" } },
  }),
}));
mock.module("../../../util/platform.js", () => ({
  getSandboxWorkingDir: () => "/test/workspace",
}));
beforeEach(() => {
  discovery.mockClear();
});

import { PROVIDER_CATALOG } from "../../../providers/model-catalog.js";
import { BadRequestError } from "../errors.js";
import { ROUTES } from "../inference-models-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

function handler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

function call(args: RouteHandlerArgs): {
  models: { provider: string; id: string }[];
} {
  return handler("inference_models_list")(args) as {
    models: { provider: string; id: string }[];
  };
}

describe("GET inference/models", () => {
  test("lists every catalog model tagged with its provider", () => {
    const { models } = call({});
    const expected = PROVIDER_CATALOG.reduce(
      (sum, p) => sum + p.models.length,
      0,
    );
    expect(models.length).toBe(expected);
    expect(models.every((m) => typeof m.provider === "string")).toBe(true);
    expect(models.every((m) => typeof m.id === "string")).toBe(true);
  });

  test("filters by provider", () => {
    const provider = PROVIDER_CATALOG[0]!.id;
    const { models } = call({ queryParams: { provider } });
    expect(models.length).toBe(PROVIDER_CATALOG[0]!.models.length);
    expect(models.every((m) => m.provider === provider)).toBe(true);
  });

  test("400s on an unknown provider filter", () => {
    expect(() => call({ queryParams: { provider: "not-a-provider" } })).toThrow(
      BadRequestError,
    );
  });
});

describe("POST inference/models/discover", () => {
  test("forwards runtime configuration and explicit refresh and returns SDK metadata", async () => {
    const result = await handler("inference_models_discover")({
      body: { provider: "claude-agent-sdk", refresh: true },
    });
    expect(discovery).toHaveBeenCalledWith({
      executablePath: "/test/claude",
      cwd: "/test/workspace",
      refresh: true,
    });
    expect(result).toMatchObject({
      models: [{ id: "new-model", supportedEffortLevels: ["high"] }],
      fetchedAt: "2026-10-11T00:00:00.000Z",
    });
  });
  test("ordinary catalog reads never invoke SDK discovery", () => {
    call({});
    call({ queryParams: { provider: "claude-agent-sdk" } });
    call({ queryParams: { provider: "anthropic" } });
    expect(discovery).not.toHaveBeenCalled();
  });
  test("rejects unsupported providers and malformed refresh without discovery", async () => {
    for (const body of [
      { provider: "anthropic" },
      { provider: "claude-agent-sdk", refresh: "yes" },
      {},
    ]) {
      await expect(
        handler("inference_models_discover")({ body }),
      ).rejects.toBeInstanceOf(BadRequestError);
    }
    expect(discovery).not.toHaveBeenCalled();
  });
  test("surfaces setup and initialization failures instead of returning static aliases", async () => {
    discovery.mockResolvedValueOnce({
      ok: false,
      reason: "subscription_required",
      message: "Sign in to Claude Code.",
    });
    await expect(
      handler("inference_models_discover")({
        body: { provider: "claude-agent-sdk" },
      }),
    ).rejects.toMatchObject({
      statusCode: 424,
      message: "Sign in to Claude Code.",
      details: { reason: "subscription_required" },
    });
  });
});
