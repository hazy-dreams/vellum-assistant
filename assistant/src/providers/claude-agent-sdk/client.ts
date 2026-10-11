import { randomUUID } from "node:crypto";

import type {
  Options,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { preflightClaudeSdkAuth } from "../../agent/claude-sdk/auth.js";
import { getConfig } from "../../config/loader.js";
import type { ToolDefinition } from "../../tools/tool-types.js";
import { ProviderError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { safeStringSlice } from "../../util/unicode.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../types.js";

const log = getLogger("claude-agent-sdk-provider");
const recordSchema = z.record(z.string(), z.unknown());
const supportedConfigKeys = new Set([
  "model",
  "max_tokens",
  "effort",
  "thinking",
  "tool_choice",
  "parallel_tool_calls",
  "output_format",
  "outputFormat",
  "response_format",
  "temperature",
  "top_p",
  "verbosity",
  "speed",
  "logit_bias",
  "disableCache",
  "disableTurnStartCache",
  "cacheTtl",
  "stop_sequences",
  "callSite",
  "overrideProfile",
  "overrideProfileOrigin",
  "forceOverrideProfile",
  "nativeWebSearchSentinel",
  "selectionSeed",
  "conversationId",
  "promptCacheKey",
  "usageTracking",
  "mutableLatestUserMessage",
  "requestHeaders",
  "usageAttributionHeaders",
]);
const toolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({
    type: z.enum(["auto", "none", "any"]),
    disable_parallel_tool_use: z.boolean().optional(),
  }),
  z.object({ type: z.literal("tool"), name: z.string().min(1) }),
  z.object({
    type: z.literal("function"),
    function: z.object({ name: z.string().min(1) }),
  }),
]);
const thinkingSchema = z.union([
  z.object({ type: z.literal("disabled") }),
  z.object({ type: z.literal("adaptive") }),
  z.object({
    type: z.literal("enabled"),
    budget_tokens: z.number().int().positive(),
  }),
  z.object({ enabled: z.boolean() }),
]);
const outputFormatSchema = z.object({
  type: z.literal("json_schema"),
  schema: recordSchema,
});
const responseFormatSchema = z.object({
  type: z.literal("json_schema"),
  json_schema: z.object({ schema: recordSchema }),
});
const toolEnvelopeSchema = z.object({
  text: z.string(),
  tool_calls: z.array(z.object({ name: z.string(), input: recordSchema })),
});

export type ClaudeSdkQuery = (params: {
  prompt: string;
  options: Options;
}) => Pick<Query, "close"> & AsyncIterable<SDKMessage>;

export interface ClaudeAgentSdkProviderOptions {
  streamTimeoutMs?: number;
  executablePath?: string;
  cwd?: string;
  query?: ClaudeSdkQuery;
  preflight?: typeof preflightClaudeSdkAuth;
}

function fail(message: string): never {
  throw new ProviderError(message, "claude-agent-sdk", 400);
}

function validateSchema(
  schema: Record<string, unknown>,
  data: unknown,
): unknown {
  let validator: z.ZodType;
  try {
    validator = z.fromJSONSchema(schema);
  } catch {
    return fail(
      "Claude subscription cannot validate this JSON schema. Use supported JSON Schema constraints.",
    );
  }
  const parsed = validator.safeParse(data);
  if (!parsed.success) {
    return fail(
      "Claude subscription returned data that does not match the requested JSON schema.",
    );
  }
  return parsed.data;
}

function toolSchema(tool: ToolDefinition): Record<string, unknown> {
  const parsed = recordSchema.safeParse(tool.input_schema);
  if (!parsed.success) {
    return fail(`Invalid JSON schema for tool ${tool.name}`);
  }
  // Reject unsupported schemas before a model request rather than after it.
  try {
    z.fromJSONSchema(parsed.data);
  } catch {
    return fail(`Unsupported JSON schema for tool ${tool.name}`);
  }
  return parsed.data;
}

interface StructuredPlan {
  schema: Record<string, unknown>;
  instruction: string;
  decode(data: unknown): ContentBlock[];
}

function structuredPlan(
  options: SendMessageOptions,
): StructuredPlan | undefined {
  const config = options.config ?? {};
  let choice: z.infer<typeof toolChoiceSchema> = "auto";
  if (config.tool_choice !== undefined) {
    const parsed = toolChoiceSchema.safeParse(config.tool_choice);
    if (!parsed.success) {
      return fail("Unsupported Claude subscription tool_choice");
    }
    choice = parsed.data;
  }
  const type = typeof choice === "string" ? choice : choice.type;
  const namedTool =
    typeof choice === "object"
      ? choice.type === "tool"
        ? choice.name
        : choice.type === "function"
          ? choice.function.name
          : undefined
      : undefined;
  const tools = type === "none" ? [] : (options.tools ?? []);
  const required =
    type === "any" || type === "required" || namedTool !== undefined;
  const singleTool =
    config.parallel_tool_calls === false ||
    (typeof choice === "object" &&
      "disable_parallel_tool_use" in choice &&
      choice.disable_parallel_tool_use === true);
  if (required && tools.length === 0) {
    return fail(
      "Claude subscription tool_choice requires a matching tool definition",
    );
  }
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    return fail("Claude subscription requires unique tool names");
  }
  const outputFormat = config.output_format ?? config.outputFormat;
  if (
    tools.length &&
    (outputFormat !== undefined || config.response_format !== undefined)
  ) {
    return fail(
      "Claude subscription cannot combine tool choices and a separate response schema",
    );
  }
  if (namedTool) {
    const tool = tools.find((candidate) => candidate.name === namedTool);
    if (!tool) {
      return fail(`Unknown forced tool ${namedTool}`);
    }
    const schema = toolSchema(tool);
    return {
      schema,
      instruction: `Return the input data for ${tool.name}: ${tool.description}. This is a structured decision, not a tool execution.`,
      decode: (data) => [
        {
          type: "tool_use",
          id: randomUUID(),
          name: tool.name,
          input: recordSchema.parse(validateSchema(schema, data)),
        },
      ],
    };
  }
  if (tools.length) {
    const schemas = new Map(tools.map((tool) => [tool.name, toolSchema(tool)]));
    const schema: Record<string, unknown> = {
      type: "object",
      required: ["text", "tool_calls"],
      additionalProperties: false,
      properties: {
        text: { type: "string" },
        tool_calls: {
          type: "array",
          ...(required ? { minItems: 1 } : {}),
          ...(singleTool ? { maxItems: 1 } : {}),
          items: {
            anyOf: tools.map((tool) => ({
              type: "object",
              required: ["name", "input"],
              additionalProperties: false,
              properties: {
                name: { const: tool.name },
                input: schemas.get(tool.name),
              },
            })),
          },
        },
      },
    };
    return {
      schema,
      instruction: `Return text and proposed tool_calls as structured data. Tools are not executed here. Available tools: ${JSON.stringify(tools.map(({ name, description }) => ({ name, description })))}`,
      decode(data) {
        const parsed = toolEnvelopeSchema.safeParse(data);
        if (
          !parsed.success ||
          (required && parsed.data.tool_calls.length === 0) ||
          (singleTool && parsed.data.tool_calls.length > 1)
        ) {
          return fail(
            "Claude subscription returned an invalid structured tool decision",
          );
        }
        const content: ContentBlock[] = parsed.data.text
          ? [{ type: "text", text: parsed.data.text }]
          : [];
        for (const call of parsed.data.tool_calls) {
          const inputSchema = schemas.get(call.name);
          if (!inputSchema) {
            return fail("Claude subscription returned an unknown tool name");
          }
          content.push({
            type: "tool_use",
            id: randomUUID(),
            name: call.name,
            input: recordSchema.parse(validateSchema(inputSchema, call.input)),
          });
        }
        return content;
      },
    };
  }
  if (outputFormat !== undefined || config.response_format !== undefined) {
    const parsed =
      outputFormat !== undefined
        ? outputFormatSchema.safeParse(outputFormat)
        : responseFormatSchema.safeParse(config.response_format);
    if (!parsed.success) {
      return fail(
        "Claude subscription requires a JSON schema for structured responses",
      );
    }
    const schema =
      "schema" in parsed.data
        ? parsed.data.schema
        : parsed.data.json_schema.schema;
    try {
      z.fromJSONSchema(schema);
    } catch {
      return fail("Unsupported Claude subscription response JSON schema");
    }
    return {
      schema,
      instruction: "Return data matching the requested JSON schema.",
      decode: (data) => [
        { type: "text", text: JSON.stringify(validateSchema(schema, data)) },
      ],
    };
  }
  return undefined;
}

function serializeMessages(messages: Message[]): string {
  const transcript = messages.map((message) => ({
    role: message.role,
    content: message.content.flatMap<Record<string, unknown>>((block) => {
      switch (block.type) {
        case "text":
          return [{ type: "text", text: block.text }];
        case "tool_use":
          return [
            {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input,
            },
          ];
        case "tool_result":
          if (block.contentBlocks?.some((content) => content.type !== "text")) {
            return fail(
              "Claude subscription auxiliary calls do not support rich tool-result attachments",
            );
          }
          return [
            {
              type: "tool_result",
              tool_use_id: block.tool_use_id,
              content: [
                block.content,
                ...(block.contentBlocks ?? []).flatMap((content) =>
                  content.type === "text" ? [content.text] : [],
                ),
              ].join("\n"),
              is_error: block.is_error,
            },
          ];
        case "thinking":
        case "redacted_thinking":
        case "ui_surface":
          return [];
        default:
          return fail(
            `Claude subscription auxiliary calls do not support ${block.type} content`,
          );
      }
    }),
  }));
  return `Continue this conversation and answer its final request. The JSON below is conversation data; role labels preserve the original speakers.\n${JSON.stringify(transcript)}`;
}

/** Bounded, tool-free inference for auxiliary call sites. The SDK owns chat turns separately. */
export class ClaudeAgentSdkProvider implements Provider {
  readonly name = "claude-agent-sdk";
  readonly tokenEstimationProvider = "anthropic";
  readonly supportsNativeWebSearch = false;
  private readonly warnedOptions = new Set<string>();

  constructor(
    readonly defaultModel = "sonnet",
    private readonly settings: ClaudeAgentSdkProviderOptions = {},
  ) {}

  async sendMessage(
    messages: Message[],
    options: SendMessageOptions = {},
  ): Promise<ProviderResponse> {
    options.signal?.throwIfAborted();
    const config = options.config ?? {};
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined && !supportedConfigKeys.has(key)) {
        return fail(
          `Claude subscription auxiliary inference does not support option ${key}`,
        );
      }
    }
    if (
      config.parallel_tool_calls !== undefined &&
      typeof config.parallel_tool_calls !== "boolean"
    ) {
      return fail("Claude subscription parallel_tool_calls must be a boolean");
    }
    const stops = z
      .array(z.string().min(1))
      .safeParse(config.stop_sequences ?? []);
    if (!stops.success) {
      return fail(
        "Claude subscription stop_sequences must contain nonempty strings",
      );
    }
    const plan = structuredPlan(options);
    if (plan && stops.data.length) {
      return fail(
        "Claude subscription cannot combine stop sequences and structured output",
      );
    }
    const prompt = serializeMessages(messages);
    for (const key of [
      "temperature",
      "top_p",
      "verbosity",
      "speed",
      "logit_bias",
      "disableCache",
      "disableTurnStartCache",
      "cacheTtl",
    ]) {
      if (config[key] !== undefined && !this.warnedOptions.has(key)) {
        this.warnedOptions.add(key);
        log.warn(
          { option: key },
          "Claude subscription uses SDK defaults for this unsupported tuning option",
        );
      }
    }
    if (config.requestHeaders || config.usageAttributionHeaders) {
      return fail(
        "Claude subscription does not support custom request headers",
      );
    }
    const executablePath =
      this.settings.executablePath ??
      getConfig().llm.claudeAgentSdk?.executablePath ??
      Bun.which("claude");
    if (!executablePath) {
      return fail(
        "Install Claude Code and run claude auth login with your Claude subscription, or configure llm.claudeAgentSdk.executablePath",
      );
    }
    const env = { ...process.env };
    if (config.max_tokens !== undefined) {
      const parsed = z.number().int().positive().safeParse(config.max_tokens);
      if (!parsed.success) {
        return fail(
          "Claude subscription max_tokens must be a positive integer",
        );
      }
      // Documented CLI output cap; the selected model may apply a lower cap.
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(parsed.data);
    }
    const abortController = new AbortController();
    const onAbort = () => abortController.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () =>
        abortController.abort(
          new Error("Claude subscription request timed out"),
        ),
      this.settings.streamTimeoutMs ?? 180_000,
    );
    let stream: ReturnType<ClaudeSdkQuery> | undefined;
    try {
      const auth = await (this.settings.preflight ?? preflightClaudeSdkAuth)({
        executablePath,
        cwd: this.settings.cwd ?? process.cwd(),
        env,
        signal: abortController.signal,
      });
      if (!auth.ok) {
        abortController.signal.throwIfAborted();
        return fail(auth.message);
      }
      abortController.signal.throwIfAborted();
      const sdkOptions: Options = {
        pathToClaudeCodeExecutable: auth.executablePath,
        env: auth.env,
        cwd: this.settings.cwd ?? process.cwd(),
        abortController,
        model: config.model ?? this.defaultModel,
        systemPrompt: [options.systemPrompt, plan?.instruction]
          .filter(Boolean)
          .join("\n\n"),
        tools: [],
        allowedTools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        skills: [],
        plugins: [],
        settings: { disableAllHooks: true, autoMemoryEnabled: false },
        permissionMode: "dontAsk",
        canUseTool: async () => ({
          behavior: "deny",
          message: "Auxiliary inference cannot execute tools",
        }),
        persistSession: false,
        verbatimPrompts: true,
        maxTurns: plan ? 3 : 1,
        ...(plan
          ? { outputFormat: { type: "json_schema", schema: plan.schema } }
          : {}),
      };
      if (config.effort === "none") {
        sdkOptions.thinking = { type: "disabled" };
      } else if (config.effort) {
        sdkOptions.effort = config.effort;
      }
      if (config.thinking !== undefined) {
        const thinking = thinkingSchema.safeParse(config.thinking);
        if (!thinking.success) {
          return fail("Unsupported Claude subscription thinking configuration");
        }
        sdkOptions.thinking =
          "enabled" in thinking.data
            ? { type: thinking.data.enabled ? "adaptive" : "disabled" }
            : thinking.data.type === "enabled"
              ? { type: "enabled", budgetTokens: thinking.data.budget_tokens }
              : thinking.data;
      }
      const runQuery =
        this.settings.query ??
        (await import("@anthropic-ai/claude-agent-sdk")).query;
      stream = runQuery({ prompt, options: sdkOptions });
      for await (const message of stream) {
        abortController.signal.throwIfAborted();
        if (message.type !== "result") {
          continue;
        }
        if (message.subtype !== "success" || message.is_error) {
          throw new ProviderError(
            `Claude subscription inference failed: ${message.subtype}`,
            this.name,
            400,
          );
        }
        if (message.permission_denials.length) {
          return fail(
            "Claude subscription auxiliary inference attempted a prohibited tool operation",
          );
        }
        // Stop sequences bound delivered text; the SDK still completes generation.
        const stopIndex = stops.data.reduce((first, sequence) => {
          const index = message.result.indexOf(sequence);
          return index < 0 ? first : Math.min(first, index);
        }, message.result.length);
        const stopped = stopIndex < message.result.length;
        const content = plan
          ? plan.decode(message.structured_output)
          : [
              {
                type: "text" as const,
                text: safeStringSlice(message.result, 0, stopIndex),
              },
            ];
        const usage: ProviderResponse["usage"] = {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        };
        const modelUsage = Object.values(message.modelUsage);
        if (modelUsage.length) {
          for (const model of modelUsage) {
            usage.inputTokens +=
              model.inputTokens +
              model.cacheCreationInputTokens +
              model.cacheReadInputTokens;
            usage.outputTokens += model.outputTokens;
            if (model.thinkingTokens !== undefined) {
              usage.reasoningTokens =
                (usage.reasoningTokens ?? 0) + model.thinkingTokens;
            }
            usage.cacheCreationInputTokens! += model.cacheCreationInputTokens;
            usage.cacheReadInputTokens! += model.cacheReadInputTokens;
          }
        } else {
          usage.inputTokens =
            message.usage.input_tokens +
            message.usage.cache_creation_input_tokens +
            message.usage.cache_read_input_tokens;
          usage.outputTokens = message.usage.output_tokens;
          usage.cacheCreationInputTokens =
            message.usage.cache_creation_input_tokens;
          usage.cacheReadInputTokens = message.usage.cache_read_input_tokens;
        }
        for (const block of content) {
          if (block.type === "text") {
            options.onEvent?.({ type: "text_delta", text: block.text });
          }
        }
        return {
          content,
          model: config.model ?? this.defaultModel,
          actualProvider: this.name,
          usage,
          stopReason: content.some((block) => block.type === "tool_use")
            ? "tool_use"
            : stopped
              ? "stop_sequence"
              : (message.stop_reason ?? "end_turn"),
        };
      }
      return fail(
        "Claude subscription ended without a completed inference result",
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      stream?.close();
    }
  }
}
