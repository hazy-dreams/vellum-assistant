import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  createSdkMcpServer,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { MediaSource, ToolDefinition } from "../../providers/types.js";
import type { LoopToolExecutor } from "../loop.js";

export const CLAUDE_SDK_MCP_SERVER_NAME = "vellum";
const SDK_TOOL_PREFIX = `mcp__${CLAUDE_SDK_MCP_SERVER_NAME}__`;
// The pinned SDK carries this ID on MCP calls; a matching host hook must vouch for it.
const TOOL_USE_ID_META_KEY = "claudecode/toolUseId";
const jsonInputSchema = z.record(z.string(), z.json());
const preToolUseSchema = z.object({
  hook_event_name: z.literal("PreToolUse"),
  tool_name: z.string(),
  tool_input: jsonInputSchema,
  tool_use_id: z.string().min(1),
  mcp_server: z.object({
    name: z.literal(CLAUDE_SDK_MCP_SERVER_NAME),
    source: z.literal("sdk"),
  }),
});
const toolUseMetadataSchema = z.object({
  [TOOL_USE_ID_META_KEY]: z.string().min(1),
});

export interface ClaudeSdkToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ClaudeSdkToolResult = Awaited<ReturnType<LoopToolExecutor>>;

export interface ClaudeSdkToolBridgeOptions {
  tools: readonly ToolDefinition[];
  toolExecutor: LoopToolExecutor;
  signal?: AbortSignal;
  onToolStart?: (call: ClaudeSdkToolCall) => void | Promise<void>;
  onToolOutput?: (call: ClaudeSdkToolCall, chunk: string) => void;
  finalizeToolResult?: (
    call: ClaudeSdkToolCall,
    result: ClaudeSdkToolResult,
  ) => Promise<ClaudeSdkToolResult>;
  onToolResult?: (
    call: ClaudeSdkToolCall,
    result: ClaudeSdkToolResult,
  ) => void | Promise<void>;
}

// SDK 0.3.296 forwards this setting on initialize and setMcpServers, but omits it
// from its public type. Tool results must stay foreground until Vellum settles them.
type ForegroundSdkMcpServer = McpSdkServerConfigWithInstance & {
  disableAutoBackground: true;
};

export interface ClaudeSdkToolBridge {
  server: ForegroundSdkMcpServer;
  preToolUse: HookCallback;
  toSdkName: (name: string) => string | undefined;
  toVellumName: (name: string) => string | undefined;
  settle: () => Promise<void>;
  /** Every admitted MCP result has finished conversion without failure. */
  isSettled: () => boolean;
  dispose: () => Promise<void>;
}

interface RegisteredCall {
  call: ClaudeSdkToolCall;
  signal: AbortSignal;
  result?: Promise<CallToolResult>;
  completed?: boolean;
}

function failedResult(content: string): CallToolResult {
  return { content: [{ type: "text", text: content }], isError: true };
}

function denyTool(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
}

function serverToolName(name: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    return name;
  }
  return `tool_${createHash("sha256").update(name).digest("hex").slice(0, 40)}`;
}

async function inlineMedia(source: MediaSource) {
  if (source.type === "base64") {
    return { data: source.data, media_type: source.media_type };
  }
  const { resolveMediaSourceData } =
    await import("../../providers/media-resolve.js");
  return resolveMediaSourceData(source);
}

async function toMcpResult(
  call: ClaudeSdkToolCall,
  result: ClaudeSdkToolResult,
): Promise<CallToolResult> {
  const content: CallToolResult["content"] = [
    { type: "text", text: result.content },
  ];
  for (const [index, block] of (result.contentBlocks ?? []).entries()) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "image" || block.type === "file") {
      const uri = `vellum-tool-result:///${encodeURIComponent(call.id)}/${index}`;
      if (block.type === "file" && block.extracted_text !== undefined) {
        content.push({
          type: "resource",
          resource: {
            uri,
            mimeType: block.source.media_type,
            text: block.extracted_text,
          },
        });
        continue;
      }
      const media = await inlineMedia(block.source);
      if (!media) {
        content.push({ type: "text", text: "[Attachment is unavailable]" });
        continue;
      }
      if (block.type === "image") {
        content.push({
          type: "image",
          data: media.data,
          mimeType: media.media_type,
        });
      } else {
        content.push({
          type: "resource",
          resource: {
            uri,
            mimeType: media.media_type,
            blob: media.data,
          },
        });
      }
    }
  }
  return { content, isError: result.isError };
}

/**
 * The SDK owns model turns; every tool still enters Vellum's executor, which
 * owns input validation, permissions, audit records, and tool side effects.
 */
export function createClaudeSdkToolBridge(
  options: ClaudeSdkToolBridgeOptions,
): ClaudeSdkToolBridge {
  const names = new Map<string, string>();
  const originalNames = new Map<string, string>();
  const definitions = options.tools.map((definition) => {
    const name = serverToolName(definition.name);
    if (
      !definition.name ||
      names.has(definition.name) ||
      originalNames.has(name)
    ) {
      throw new Error(
        `Duplicate or invalid Vellum tool name: ${definition.name}`,
      );
    }
    names.set(definition.name, name);
    originalNames.set(name, definition.name);
    const schema = ToolSchema.parse({
      name,
      description: definition.description,
      inputSchema: structuredClone(definition.input_schema),
      _meta: { "anthropic/alwaysLoad": true },
    });
    return schema;
  });
  const server: ForegroundSdkMcpServer = {
    ...createSdkMcpServer({
      name: CLAUDE_SDK_MCP_SERVER_NAME,
      tools: [],
    }),
    disableAutoBackground: true,
  };
  const disposed = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, disposed.signal])
    : disposed.signal;
  const calls = new Map<string, RegisteredCall>();
  const toSdkName = (name: string) => {
    const alias = names.get(name);
    return alias === undefined ? undefined : `${SDK_TOOL_PREFIX}${alias}`;
  };
  const toVellumName = (name: string) =>
    name.startsWith(SDK_TOOL_PREFIX)
      ? originalNames.get(name.slice(SDK_TOOL_PREFIX.length))
      : undefined;

  const preToolUse: HookCallback = async (input, toolUseId, hookOptions) => {
    if (signal.aborted || hookOptions.signal.aborted) {
      return denyTool("The Vellum turn was cancelled");
    }
    const parsed = preToolUseSchema.safeParse(input);
    if (!parsed.success) {
      return denyTool("Only Vellum's in-process tools are permitted");
    }
    const name = toVellumName(parsed.data.tool_name);
    if (
      !name ||
      (toolUseId !== undefined && toolUseId !== parsed.data.tool_use_id)
    ) {
      return denyTool("Unknown Vellum tool or mismatched tool call ID");
    }
    const call = {
      id: parsed.data.tool_use_id,
      name,
      input: parsed.data.tool_input,
    };
    const existing = calls.get(call.id);
    if (existing && !isDeepStrictEqual(existing.call, call)) {
      return denyTool(
        "A tool call ID cannot be reused with different arguments",
      );
    }
    if (!existing) {
      calls.set(call.id, { call, signal: hookOptions.signal });
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    };
  };

  server.instance.server.setRequestHandler(
    ListToolsRequestSchema,
    async () => ({
      tools: definitions,
    }),
  );
  server.instance.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) => {
      const metadata = toolUseMetadataSchema.safeParse(request.params._meta);
      const input = jsonInputSchema.safeParse(request.params.arguments ?? {});
      if (!metadata.success || !input.success) {
        return failedResult(
          "Missing SDK tool call ID or invalid JSON tool input",
        );
      }
      const registered = calls.get(metadata.data[TOOL_USE_ID_META_KEY]);
      const name = originalNames.get(request.params.name);
      if (
        !registered ||
        name !== registered.call.name ||
        !isDeepStrictEqual(input.data, registered.call.input)
      ) {
        return failedResult(
          "Tool call does not match an authorized SDK invocation",
        );
      }
      if (registered.result) {
        return registered.result;
      }
      const callSignal = AbortSignal.any([
        signal,
        extra.signal,
        registered.signal,
      ]);
      // Cache before awaiting any observer so concurrent retries share one call.
      registered.result = Promise.resolve()
        .then(async () => {
          const { call } = registered;
          const finish = async (result: ClaudeSdkToolResult) => {
            if (options.finalizeToolResult) {
              result = await options.finalizeToolResult(call, result);
            }
            await options.onToolResult?.(call, result);
            return toMcpResult(call, result);
          };
          const cancelled = () =>
            finish({
              content: "The Vellum tool call was cancelled before execution",
              isError: true,
            });
          if (callSignal.aborted) {
            return cancelled();
          }
          let onAbort = () => {};
          const aborted = new Promise<void>((resolve) => {
            onAbort = resolve;
            callSignal.addEventListener("abort", onAbort, { once: true });
          });
          try {
            await Promise.race([options.onToolStart?.(call), aborted]);
          } finally {
            callSignal.removeEventListener("abort", onAbort);
          }
          if (callSignal.aborted) {
            return cancelled();
          }
          let result: ClaudeSdkToolResult;
          try {
            result = await options.toolExecutor(
              call.name,
              structuredClone(call.input),
              options.onToolOutput
                ? (chunk) => options.onToolOutput?.(call, chunk)
                : undefined,
              call.id,
            );
          } catch {
            result = { content: "Vellum tool execution failed", isError: true };
          }
          return finish(result);
        })
        .then((result) => {
          registered.completed = true;
          return result;
        });
      return registered.result;
    },
  );

  return {
    server,
    preToolUse,
    toSdkName,
    toVellumName,
    settle: async () => {
      await Promise.allSettled(
        Array.from(calls.values(), (registered) => registered.result),
      );
    },
    isSettled: () =>
      Array.from(calls.values()).every(
        (registered) => registered.completed === true,
      ),
    dispose: async () => {
      disposed.abort();
      await server.instance.close();
    },
  };
}
