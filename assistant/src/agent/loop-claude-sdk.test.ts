import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  createMockProvider,
  textResponse,
} from "../__tests__/helpers/mock-provider.js";
import { setConfig } from "../__tests__/helpers/set-config.js";
import { getConfig } from "../config/loader.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import {
  getRegisteredPlugins,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import * as providerSendMessage from "../providers/provider-send-message.js";
import type { Message, ToolDefinition } from "../providers/types.js";
import { ProviderError } from "../util/errors.js";
import type {
  ClaudeSdkRunOptions,
  ClaudeSdkRunResult,
} from "./claude-sdk/runtime.js";
import * as sdkRuntime from "./claude-sdk/runtime.js";
import { AgentLoop, type AgentLoopRunOptions } from "./loop.js";

const originalLlm = structuredClone(getConfig().llm);
const originalPlugins = [...getRegisteredPlugins()];
const tools: ToolDefinition[] = [
  {
    name: "example_tool",
    description: "Example assistant tool",
    input_schema: { type: "object", properties: { value: { type: "string" } } },
  },
];
const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "Do the task" }],
};
const sdkAnswer: Message = {
  role: "assistant",
  content: [{ type: "text", text: "SDK result" }],
};
const baseRun: AgentLoopRunOptions = {
  requestId: "request-sdk-dispatch",
  messages: [userMessage],
  callSite: "mainAgent",
  onEvent: () => {},
  trust: { sourceChannel: "vellum", trustClass: "unknown" },
};
const restore: Array<() => void> = [];

function mockRuntime(
  implementation?: (
    options: ClaudeSdkRunOptions,
  ) => Promise<ClaudeSdkRunResult>,
) {
  const runtime = spyOn(sdkRuntime, "runClaudeSdkAgent").mockImplementation(
    implementation ??
      (async (options) => ({
        history: [
          ...(options.canonicalMessages ?? options.run.messages),
          sdkAnswer,
        ],
        newMessages: [sdkAnswer],
        exitReason: null,
        reason: "no_tool_calls",
      })),
  );
  restore.push(() => runtime.mockRestore());
  return runtime;
}

beforeEach(() => {
  resetPluginRegistryAndRegisterDefaults();
  setConfig("llm", {
    defaultProvider: "anthropic",
    activeProfile: "native-profile",
    profiles: {
      "native-profile": {
        source: "user",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
      "subscription-profile": {
        source: "user",
        provider: "claude-agent-sdk",
        model: "claude-sonnet-4-6",
        maxTokens: 4096,
        effort: "high",
        thinking: { enabled: true, streamThinking: true },
      },
    },
  });
});
afterEach(() => {
  for (const cleanup of restore.splice(0).reverse()) {
    cleanup();
  }
  setConfig("llm", originalLlm);
  resetPluginRegistryForTests();
  for (const plugin of originalPlugins) {
    registerPlugin(plugin);
  }
});

describe("AgentLoop Claude SDK dispatch", () => {
  test("a selected subscription profile dispatches the complete runtime with Vellum tool execution", async () => {
    const sdk = mockRuntime();
    const { provider, calls } = createMockProvider(
      [textResponse("Must not use API")],
      "anthropic",
    );
    const executor = async () => ({ content: "tool result", isError: false });
    const resolveTools = () => tools;
    const onToolsSent = () => {};
    const controller = new AbortController();
    const loop = new AgentLoop({
      provider,
      systemPrompt: "Assistant system prompt",
      conversationId: "conversation-sdk",
      tools,
      toolExecutor: executor,
      resolveTools,
      onToolsSent,
    });
    const result = await loop.run({
      ...baseRun,
      overrideProfile: "subscription-profile",
      signal: controller.signal,
    });
    expect(sdk).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
    const dispatched = sdk.mock.calls[0]![0];
    expect(dispatched.run.callSite).toBe("mainAgent");
    expect(dispatched.run.overrideProfile).toBe("subscription-profile");
    expect(dispatched.run.signal).toBe(controller.signal);
    expect(dispatched.toolExecutor).toBe(executor);
    expect(dispatched.resolveTools).toBe(resolveTools);
    expect(dispatched.onToolsSent).toBe(onToolsSent);
    expect(dispatched.tools).toEqual(tools);
    expect(dispatched.model).toBe("claude-sonnet-4-6");
    expect(dispatched.maxTokens).toBe(4096);
    expect(dispatched.effort).toBe("high");
    expect(dispatched.systemPrompt).toContain("Assistant system prompt");
    expect(result.newMessages).toEqual([sdkAnswer]);
  });

  test("the main chat's active subscription profile selects the SDK without a per-turn override", async () => {
    setConfig("llm", {
      ...getConfig().llm,
      activeProfile: "subscription-profile",
    });
    const sdk = mockRuntime();
    const { provider, calls } = createMockProvider(
      [textResponse("Must not use API")],
      "anthropic",
    );
    const result = await new AgentLoop({
      provider,
      systemPrompt: "System",
      conversationId: "conversation-active-sdk",
    }).run(baseRun);
    expect(sdk).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
    expect(result.history.at(-1)).toEqual(sdkAnswer);
  });

  test("an Anthropic profile retains the native loop even if the provider object's name resembles the SDK", async () => {
    const sdk = mockRuntime();
    const { provider, calls } = createMockProvider(
      [textResponse("Native API result")],
      "claude-agent-sdk",
    );
    const result = await new AgentLoop({
      provider,
      systemPrompt: "System",
      conversationId: "conversation-native",
    }).run(baseRun);
    expect(sdk).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(result.history.at(-1)?.content).toEqual([
      { type: "text", text: "Native API result" },
    ]);
  });

  test("uses the SDK's canonical history changes without persisting the sanitized transport projection", async () => {
    const capabilities =
      "<channel_capabilities>\nexample capability\n</channel_capabilities>";
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: capabilities },
          { type: "text", text: "Earlier task" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Earlier answer" }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: capabilities },
          { type: "text", text: "Current task" },
        ],
      },
    ];
    const summary: Message = {
      role: "assistant",
      content: [{ type: "text", text: "SDK compacted summary" }],
    };
    let returnedHistory: Message[] = [];
    const sdk = mockRuntime(async (options) => {
      expect(options.canonicalMessages).toEqual(messages);
      expect(options.run.messages.at(-1)?.content).toEqual([
        { type: "text", text: "Current task" },
      ]);
      returnedHistory = [
        summary,
        options.canonicalMessages!.at(-1)!,
        sdkAnswer,
      ];
      return {
        history: returnedHistory,
        newMessages: [sdkAnswer],
        exitReason: null,
        reason: "no_tool_calls",
      };
    });
    const { provider, calls } = createMockProvider([
      textResponse("Must not use API"),
    ]);
    const result = await new AgentLoop({
      provider,
      systemPrompt: "System",
      conversationId: "conversation-canonical",
    }).run({
      ...baseRun,
      messages,
      overrideProfile: "subscription-profile",
    });
    expect(sdk).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
    expect(result.history).toEqual(returnedHistory);
    expect(result.history[0]).toEqual(summary);
    expect(result.history[1]?.content).toContainEqual({
      type: "text",
      text: capabilities,
    });
    expect(result.newMessages).toEqual([sdkAnswer]);
    expect(messages[0]?.content).toContainEqual({
      type: "text",
      text: "Earlier task",
    });
  });

  test("a subscription provider without a named call site fails before either inference path", async () => {
    const sdk = mockRuntime();
    const { provider, calls } = createMockProvider(
      [textResponse("Must not run an auxiliary SDK loop")],
      "claude-agent-sdk",
    );
    const errors: Error[] = [];
    await new AgentLoop({
      provider,
      systemPrompt: "System",
      conversationId: "conversation-missing-callsite",
    }).run({
      ...baseRun,
      callSite: undefined,
      onEvent: (event) => {
        if (event.type === "error") {
          errors.push(event.error);
        }
      },
    });
    expect(sdk).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ProviderError);
    expect(errors[0]?.message).toContain("require a named inference call site");
  });

  test("workflow tool leaves forward workflowLeaf so their subscription profile reaches the SDK", async () => {
    const sdk = mockRuntime();
    const { provider, calls } = createMockProvider([
      textResponse("Must not use API"),
    ]);
    const configured = spyOn(
      providerSendMessage,
      "getConfiguredProvider",
    ).mockResolvedValue(provider);
    restore.push(() => configured.mockRestore());
    const { runLeaf } = await import("../workflows/leaf-runner.js");
    const result = await runLeaf({
      prompt: "Complete the leaf task",
      tools: [],
      profile: "subscription-profile",
      trustContext: { sourceChannel: "vellum", trustClass: "unknown" },
    });
    expect(configured).toHaveBeenCalledWith("workflowLeaf", {
      overrideProfile: "subscription-profile",
    });
    expect(sdk).toHaveBeenCalledTimes(1);
    expect(sdk.mock.calls[0]![0].run.callSite).toBe("workflowLeaf");
    expect(sdk.mock.calls[0]![0].run.overrideProfile).toBe(
      "subscription-profile",
    );
    expect(calls).toHaveLength(0);
    expect(result.output).toBe("SDK result");
  });
});
