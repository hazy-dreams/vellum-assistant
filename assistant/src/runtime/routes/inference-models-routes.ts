/**
 * Offline inference catalog and explicit runtime model discovery.
 *
 * GET lists code-owned catalog entries for existing clients. POST initializes
 * Claude's SDK without a generation prompt to discover its model choices.
 * SDK-owned IDs are not constrained by the offline catalog.
 */

import { z } from "zod";

import {
  ClaudeSdkDiscoveredModelSchema,
  discoverClaudeSdkModels,
} from "../../agent/claude-sdk/models.js";
import { getConfigReadOnly } from "../../config/loader.js";
import { PROVIDER_CATALOG } from "../../providers/model-catalog.js";
import { getSandboxWorkingDir } from "../../util/platform.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, FailedDependencyError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const catalogModelSchema = z
  .object({
    provider: z.string(),
    id: z.string(),
    displayName: z.string(),
    contextWindowTokens: z.number().optional(),
    maxOutputTokens: z.number().optional(),
    supportsThinking: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
    supportsToolUse: z.boolean().optional(),
    /** When set, the model is only visible while the named flag is enabled. */
    featureFlag: z.string().optional(),
  })
  .meta({ id: "CatalogModel" });

function handleListModels({ queryParams = {} }: RouteHandlerArgs) {
  const providerFilter = queryParams.provider?.trim();
  if (providerFilter) {
    const known = PROVIDER_CATALOG.some((p) => p.id === providerFilter);
    if (!known) {
      throw new BadRequestError(
        `Unknown provider "${providerFilter}". Known providers: ${PROVIDER_CATALOG.map(
          (p) => p.id,
        ).join(", ")}.`,
      );
    }
  }

  const models = PROVIDER_CATALOG.filter(
    (entry) => !providerFilter || entry.id === providerFilter,
  ).flatMap((entry) =>
    entry.models.map((model) => ({
      provider: entry.id,
      id: model.id,
      displayName: model.displayName,
      ...(model.contextWindowTokens !== undefined
        ? { contextWindowTokens: model.contextWindowTokens }
        : {}),
      ...(model.maxOutputTokens !== undefined
        ? { maxOutputTokens: model.maxOutputTokens }
        : {}),
      ...(model.supportsThinking !== undefined
        ? { supportsThinking: model.supportsThinking }
        : {}),
      ...(model.supportsVision !== undefined
        ? { supportsVision: model.supportsVision }
        : {}),
      ...(model.supportsToolUse !== undefined
        ? { supportsToolUse: model.supportsToolUse }
        : {}),
      ...(model.featureFlag !== undefined
        ? { featureFlag: model.featureFlag }
        : {}),
    })),
  );

  return { models };
}

const discoverModelsRequestSchema = z.object({
  provider: z.literal("claude-agent-sdk"),
  refresh: z.boolean().optional(),
});

async function handleDiscoverModels({ body }: RouteHandlerArgs) {
  const request = discoverModelsRequestSchema.safeParse(body);
  if (!request.success) {
    throw new BadRequestError(
      "Model discovery requires provider claude-agent-sdk and an optional boolean refresh.",
    );
  }
  const executablePath =
    getConfigReadOnly().llm.claudeAgentSdk?.executablePath ??
    Bun.which("claude");
  if (!executablePath) {
    throw new FailedDependencyError(
      "Install Claude Code and sign in on the computer running this assistant to discover Claude subscription models.",
      { reason: "invalid_executable" },
    );
  }
  const result = await discoverClaudeSdkModels({
    executablePath,
    cwd: getSandboxWorkingDir(),
    refresh: request.data.refresh,
  });
  if (!result.ok) {
    throw new FailedDependencyError(result.message, { reason: result.reason });
  }
  return { models: result.models, fetchedAt: result.fetchedAt };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "inference_models_discover",
    endpoint: "inference/models/discover",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Discover Claude subscription models",
    description:
      "Initialize the installed Claude Agent SDK to read its supported model choices without sending a generation prompt. Refresh bypasses cached metadata; concurrent requests share initialization. Ordinary requests may reuse a short-lived result. Availability and quotas are checked by Claude when a model is used.",
    tags: ["inference"],
    requestBody: discoverModelsRequestSchema,
    responseBody: z.object({
      models: z.array(ClaudeSdkDiscoveredModelSchema),
      fetchedAt: z.string(),
    }),
    additionalResponses: {
      "400": { description: "Invalid discovery request" },
      "424": {
        description: "Claude setup, authentication, or model discovery failed",
      },
    },
    handler: handleDiscoverModels,
  },
  {
    operationId: "inference_models_list",
    endpoint: "inference/models",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List inference catalog models",
    description:
      "Return every model in the code-owned provider catalog, each tagged with its provider. Optionally filter by provider with ?provider=<id>.",
    tags: ["inference"],
    queryParams: [
      {
        name: "provider",
        schema: { type: "string" },
        description: `Filter by provider id. One of: ${PROVIDER_CATALOG.map(
          (p) => p.id,
        ).join(", ")}`,
      },
    ],
    responseBody: z.object({ models: z.array(catalogModelSchema) }),
    additionalResponses: { "400": { description: "Unknown provider filter" } },
    handler: handleListModels,
  },
];
