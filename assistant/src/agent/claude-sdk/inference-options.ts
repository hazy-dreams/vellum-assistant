import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { ProviderError } from "../../util/errors.js";

const effortLevels = ["low", "medium", "high", "xhigh", "max"] as const;
const effortSchema = z.enum(["none", ...effortLevels]);
const thinkingSchema = z.union([
  z.object({ type: z.literal("disabled") }),
  z.object({ type: z.literal("adaptive") }),
  z.object({
    type: z.literal("enabled"),
    budget_tokens: z.number().int().positive(),
  }),
  z.object({ enabled: z.boolean() }),
]);

export function resolveClaudeSdkInferenceOptions(config: {
  effort?: unknown;
  thinking?: unknown;
}): Pick<Options, "effort" | "thinking"> {
  const effort = effortSchema.optional().safeParse(config.effort);
  const thinking = thinkingSchema.optional().safeParse(config.thinking);
  if (!effort.success || !thinking.success) {
    throw new ProviderError(
      "Unsupported Claude subscription effort or thinking configuration",
      "claude-agent-sdk",
      400,
    );
  }

  const disabled =
    thinking.data !== undefined &&
    ("enabled" in thinking.data
      ? !thinking.data.enabled
      : thinking.data.type === "disabled");
  const requestedEffort = effort.data ?? (disabled ? "none" : undefined);
  const options: Pick<Options, "effort" | "thinking"> = {};
  if (requestedEffort !== undefined) {
    // Vellum's legacy opt-out is a latency hint, not a no-thinking guarantee.
    // The native CLI applies model-specific effort fallbacks:
    // https://code.claude.com/docs/en/model-config#adjust-effort-level
    options.effort = requestedEffort === "none" ? "low" : requestedEffort;
  }

  // Generic on/off and adaptive hints use the CLI's model-specific default.
  // Only an explicit fixed budget requests a native thinking override.
  if (
    thinking.data &&
    "type" in thinking.data &&
    thinking.data.type === "enabled"
  ) {
    options.thinking = {
      type: "enabled",
      budgetTokens: thinking.data.budget_tokens,
    };
  }
  return options;
}
