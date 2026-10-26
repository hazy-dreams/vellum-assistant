import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type {
  SDKMessage,
  SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";

import {
  createMockProvider,
  textResponse,
} from "../__tests__/helpers/mock-provider.js";
import { setConfig } from "../__tests__/helpers/set-config.js";
import type { AssistantEvent } from "../api/index.js";
import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { ProfileEntry } from "../config/schemas/llm.js";
import {
  getCorrection,
  resetCalibrations,
} from "../context/estimator-calibration.js";
import { estimatePromptTokensWithTools } from "../context/token-estimator.js";
import {
  createEventHandlerState,
  dispatchAgentEvent,
  type EventHandlerDeps,
} from "../daemon/conversation-agent-loop-handlers.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { HOOKS } from "../plugin-api/constants.js";
import type { PreModelCallContext } from "../plugin-api/types.js";
import * as compactModule from "../plugins/defaults/compaction/compact.js";
import { ContextWindowManager } from "../plugins/defaults/compaction/window-manager.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import {
  getRegisteredPlugins,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import {
  createConnection,
  deleteConnection,
} from "../providers/inference/connections.js";
import * as providerSendMessage from "../providers/provider-send-message.js";
import * as providerRegistry from "../providers/registry.js";
import { RetryProvider } from "../providers/retry.js";
import type { Message, ToolDefinition } from "../providers/types.js";
import { UsageTrackingProvider } from "../providers/usage-tracking.js";
import { ProviderError } from "../util/errors.js";
import type {
  ClaudeSdkRunOptions,
  ClaudeSdkRunResult,
} from "./claude-sdk/runtime.js";
import * as sdkRuntime from "./claude-sdk/runtime.js";
import { AgentLoop, type AgentLoopRunOptions } from "./loop.js";

const originalLlm = structuredClone(getConfig().llm);
const originalPlugins = [...getRegisteredPlugins()];
await initializeDb();
let subscriptionConnection: string;
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

function patchSubscriptionProfile(changes: Partial<ProfileEntry>): void {
  const llm = getConfig().llm;
  setConfig("llm", {
    ...llm,
    profiles: {
      ...llm.profiles,
      "subscription-profile": {
        ...llm.profiles["subscription-profile"],
        ...changes,
      },
    },
  });
}

async function runSubscriptionProfile() {
  const sdk = mockRuntime();
  const { provider, calls } = createMockProvider(
    [textResponse("Must not use the auxiliary adapter")],
    "claude-agent-sdk",
  );
  const errors: Error[] = [];
  const result = await new AgentLoop({
    provider,
    systemPrompt: "System",
    conversationId: "conversation-connection-routing",
  }).run({
    ...baseRun,
    overrideProfile: "subscription-profile",
    onEvent: (event) => {
      if (event.type === "error") {
        errors.push(event.error);
      }
    },
  });
  return { sdk, calls, errors, result };
}

beforeEach(() => {
  resetCalibrations();
  resetPluginRegistryAndRegisterDefaults();
  subscriptionConnection = `sdk-loop-${randomUUID()}`;
  expect(
    createConnection(getDb(), {
      name: subscriptionConnection,
      provider: "claude-agent-sdk",
      auth: { type: "none" },
    }).ok,
  ).toBe(true);
  const providers = spyOn(providerRegistry, "listProviders").mockReturnValue([
    "claude-agent-sdk",
  ]);
  restore.push(
    () => providers.mockRestore(),
    () => deleteConnection(getDb(), subscriptionConnection),
  );
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
        provider_connection: subscriptionConnection,
        model: "claude-sonnet-4-6",
        maxTokens: 4096,
        effort: "high",
        thinking: { enabled: true, streamThinking: true },
      },
    },
  });
});
afterEach(() => {
  resetCalibrations();
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
  test("SDK usage calibration triggers the existing next-turn compaction gate", async () => {
    const { provider, calls } = createMockProvider(
      [textResponse("Must not use API")],
      "claude-agent-sdk",
    );
    provider.tokenEstimationProvider = "anthropic";
    const conversationId = `calibration-${randomUUID()}`;
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "context ".repeat(90_000) }],
      },
      sdkAnswer,
      userMessage,
    ];
    const contextWindow = {
      enabled: true,
      maxInputTokens: 300_000,
      targetBudgetRatio: 0.3,
      compactThreshold: 0.8,
      summaryBudgetRatio: 0.05,
      overflowRecovery: {
        enabled: true,
        safetyMarginRatio: 0.05,
        maxAttempts: 3,
        interactiveLatestTurnCompression: "summarize" as const,
        nonInteractiveLatestTurnCompression: "truncate" as const,
      },
    };
    const manager = new ContextWindowManager({
      provider,
      config: contextWindow,
    });
    const baseline = estimatePromptTokensWithTools(
      messages,
      "System",
      tools,
      "anthropic",
    );
    expect(baseline).toBeLessThan(210_000);
    expect(manager.shouldCompact(messages).needed).toBe(false);
    const compacted: Message[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Condensed prior conversation" }],
      },
      userMessage,
    ];
    const compact = spyOn(compactModule, "defaultCompact").mockImplementation(
      async () => ({
        messages: compacted,
        compacted: true,
        previousEstimatedInputTokens: 324_000,
        estimatedInputTokens: 100,
        maxInputTokens: 300_000,
        thresholdTokens: 210_000,
        compactedMessages: 1,
        compactedPersistedMessages: 1,
        summaryCalls: 1,
        summaryInputTokens: 100,
        summaryOutputTokens: 20,
        summaryModel: "mock-summary",
        summaryText: "Condensed prior conversation",
      }),
    );
    restore.push(() => compact.mockRestore());
    registerPlugin({
      manifest: { name: "calibration-post-compact", version: "0.0.0" },
      hooks: {
        [HOOKS.POST_COMPACT]: async () => {},
      },
    });
    const state = createEventHandlerState();
    const deps = {
      ctx: { provider, conversationId },
      onEvent: (_event: AssistantEvent) => {},
      rlog: { warn: () => {} },
    } as unknown as EventHandlerDeps;
    const realSdk = sdkRuntime.runClaudeSdkAgent;
    const inputs: Message[][] = [];
    const sdkErrors: Error[] = [];
    let queries = 0;
    const runtime = mockRuntime(async (options) => {
      inputs.push(
        structuredClone(options.canonicalMessages ?? options.run.messages),
      );
      const output = await realSdk({
        ...options,
        conversationDir: null,
        preflight: async ({ executablePath, env }) => ({
          ok: true,
          executablePath,
          env: env ?? {},
        }),
        query: ({ prompt }) => ({
          close() {},
          interrupt: async () => undefined,
          setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
          async *[Symbol.asyncIterator]() {
            await prompt[Symbol.asyncIterator]().next();
            queries += 1;
            const uuid = "00000000-0000-4000-8000-000000000001";
            const usage: SDKResultSuccess["usage"] = {
              input_tokens: 20_000,
              output_tokens: 5,
              cache_creation_input_tokens: 4_000,
              cache_read_input_tokens: 300_000,
              cache_creation: {
                ephemeral_5m_input_tokens: 0,
                ephemeral_1h_input_tokens: 0,
              },
              server_tool_use: {
                web_search_requests: 0,
                web_fetch_requests: 0,
              },
              service_tier: "standard",
              inference_geo: "not_available",
              iterations: [],
              speed: "standard",
            };
            const stream = (
              event: Extract<SDKMessage, { type: "stream_event" }>["event"],
            ): SDKMessage => ({
              type: "stream_event",
              event,
              uuid,
              session_id: uuid,
              parent_tool_use_id: null,
            });
            yield stream({
              type: "message_start",
              message: {
                id: `sample-${queries}`,
                type: "message",
                role: "assistant",
                model: "sonnet",
                content: [],
                usage,
                stop_reason: null,
                stop_sequence: null,
                container: null,
                context_management: null,
                stop_details: null,
              },
            });
            yield stream({
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "text",
                text: "Offline answer",
                citations: [],
              },
            });
            yield stream({ type: "content_block_stop", index: 0 });
            yield stream({
              type: "message_delta",
              context_management: null,
              delta: {
                stop_reason: "end_turn",
                stop_sequence: null,
                container: null,
                stop_details: null,
              },
              usage,
            });
            yield stream({ type: "message_stop" });
            yield {
              type: "result",
              subtype: "success",
              duration_ms: 1,
              duration_api_ms: 1,
              is_error: false,
              num_turns: 1,
              result: "Offline answer",
              stop_reason: "end_turn",
              total_cost_usd: 0,
              usage,
              modelUsage: {},
              permission_denials: [],
              uuid,
              session_id: uuid,
            } satisfies SDKResultSuccess;
          },
        }),
      });
      if (output.error) {
        sdkErrors.push(output.error);
      }
      return output;
    });
    const loop = new AgentLoop({
      provider,
      systemPrompt: "System",
      conversationId,
      tools,
    });
    const events: string[] = [];
    const run = {
      ...baseRun,
      messages,
      overrideProfile: "subscription-profile",
      compactInPlace: true,
      modelProfileKey: "subscription-profile",
      resolveContextWindow: () => contextWindow,
      onEvent: async (event: Parameters<AgentLoopRunOptions["onEvent"]>[0]) => {
        events.push(event.type);
        if (event.type === "usage") {
          await dispatchAgentEvent(state, deps, event);
        }
      },
    };
    const first = await loop.run(run);
    expect(sdkErrors).toEqual([]);
    expect(runtime).toHaveBeenCalledTimes(1);
    expect(compact).not.toHaveBeenCalled();
    expect(state.exchangeInputTokens).toBe(324_000);
    expect(state.exchangeLlmCallCount).toBe(1);
    expect(state.exchangeCacheReadInputTokens).toBe(300_000);
    expect(getCorrection("anthropic", "")).toBeCloseTo(324_000 / baseline);
    const next = [...first.history, userMessage];
    expect(manager.shouldCompact(next).needed).toBe(true);
    await loop.run({
      ...run,
      messages: next,
      requestId: "next-calibrated-turn",
    });
    expect(sdkErrors).toEqual([]);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(runtime).toHaveBeenCalledTimes(2);
    expect(queries).toBe(2);
    expect(inputs[1]).toEqual(compacted);
    expect(
      events.filter((type) => type === "compaction_completed"),
    ).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  test("a missing explicit connection fails before either SDK inference path", async () => {
    const missing = `missing-sdk-${randomUUID()}`;
    patchSubscriptionProfile({ provider_connection: missing });
    const { sdk, calls, errors } = await runSubscriptionProfile();
    expect(sdk).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(errors).toMatchObject([
      {
        name: "ConnectionResolutionError",
        reason: "not_found",
        connectionName: missing,
      },
    ]);
  });

  test("a missing Any active connection fails before the auxiliary SDK adapter", async () => {
    patchSubscriptionProfile({ provider_connection: undefined });
    expect(deleteConnection(getDb(), subscriptionConnection).ok).toBe(true);
    const { sdk, calls, errors } = await runSubscriptionProfile();
    expect(sdk).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ProviderError);
    expect(errors[0]?.message).toContain("connection is unavailable");
  });

  test("Any active uses an existing subscription connection", async () => {
    patchSubscriptionProfile({ provider_connection: undefined });
    const { sdk, calls, errors } = await runSubscriptionProfile();
    expect(sdk).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  test.each([false, true])(
    "a mismatched connection follows canonical auto-resolution (SDK connection available: %s)",
    async (hasSdkConnection) => {
      const otherConnection = `other-loop-${randomUUID()}`;
      expect(
        createConnection(getDb(), {
          name: otherConnection,
          provider: "ollama",
          auth: { type: "none" },
        }).ok,
      ).toBe(true);
      restore.push(() => deleteConnection(getDb(), otherConnection));
      patchSubscriptionProfile({ provider_connection: otherConnection });
      if (!hasSdkConnection) {
        expect(deleteConnection(getDb(), subscriptionConnection).ok).toBe(true);
      }
      const { sdk, calls, errors } = await runSubscriptionProfile();
      expect(calls).toHaveLength(0);
      if (hasSdkConnection) {
        expect(sdk).toHaveBeenCalledTimes(1);
        expect(errors).toHaveLength(0);
      } else {
        expect(sdk).not.toHaveBeenCalled();
        expect(errors).toMatchObject([
          {
            name: "ConnectionResolutionError",
            reason: "provider_mismatch",
            connectionName: otherConnection,
          },
        ]);
      }
    },
  );

  test("an unavailable adapter fails before the auxiliary SDK adapter", async () => {
    const adapter = spyOn(
      providerRegistry,
      "resolveProviderFromConnection",
    ).mockResolvedValue(null);
    restore.push(() => adapter.mockRestore());
    const { sdk, calls, errors } = await runSubscriptionProfile();
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(sdk).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(errors[0]?.message).toContain("connection is unavailable");
  });

  test("a deleted entry profile falls back to the active SDK profile and its tuning", async () => {
    const llm = getConfig().llm;
    setConfig("llm", {
      ...llm,
      activeProfile: "subscription-profile",
      profiles: {
        ...llm.profiles,
        stale: {
          source: "user",
          provider: `deleted-entry-${randomUUID()}`,
          model: "claude-opus-4-7",
          maxTokens: 8000,
          effort: "low",
        },
      },
    });
    const sdk = mockRuntime();
    const { provider, calls } = createMockProvider([
      textResponse("Must not use API"),
    ]);
    await new AgentLoop({
      provider,
      systemPrompt: "System",
      conversationId: "conversation-stale-entry",
    }).run({
      ...baseRun,
      overrideProfile: "stale",
    });
    expect(sdk).toHaveBeenCalledTimes(1);
    expect(sdk.mock.calls[0]![0]).toMatchObject({
      model: "claude-sonnet-4-6",
      maxTokens: 4096,
      effort: "high",
    });
    expect(calls).toHaveLength(0);
  });

  test("an SDK entry alias still validates an explicit connection", async () => {
    const missing = `missing-sdk-${randomUUID()}`;
    patchSubscriptionProfile({
      provider: subscriptionConnection,
      provider_connection: missing,
    });
    const { sdk, calls, errors } = await runSubscriptionProfile();
    expect(sdk).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(errors).toMatchObject([
      { reason: "not_found", connectionName: missing },
    ]);
  });

  test("a mix keeps the selected SDK arm through connection validation", async () => {
    const llm = getConfig().llm;
    setConfig("llm", {
      ...llm,
      profiles: {
        ...llm.profiles,
        "other-subscription": {
          ...llm.profiles["subscription-profile"],
          model: "opus",
          maxTokens: 8192,
          effort: "low",
        },
        mixed: {
          source: "user",
          mix: [
            { profile: "subscription-profile", weight: 1 },
            { profile: "other-subscription", weight: 1 },
          ],
        },
      },
    });
    const conversationId = "conversation-sdk-mix";
    const expected = resolveCallSiteConfig("mainAgent", getConfig().llm, {
      overrideProfile: "mixed",
      selectionSeed: conversationId,
    });
    const sdk = mockRuntime();
    const { provider, calls } = createMockProvider([
      textResponse("Must not use the API adapter"),
    ]);
    await new AgentLoop({
      provider,
      systemPrompt: "System",
      conversationId,
    }).run({
      ...baseRun,
      overrideProfile: "mixed",
    });
    expect(sdk).toHaveBeenCalledTimes(1);
    expect(sdk.mock.calls[0]![0]).toMatchObject({
      model: expected.model,
      maxTokens: expected.maxTokens,
      effort: expected.effort,
    });
    expect(calls).toHaveLength(0);
  });

  test("a pre-model hook selects and validates the SDK after an API turn override", async () => {
    registerPlugin({
      manifest: { name: "test-sdk-route", version: "0.0.0" },
      hooks: {
        "pre-model-call": async (ctx: PreModelCallContext) => {
          ctx.modelProfile = "subscription-profile";
        },
      },
    });
    const sdk = mockRuntime();
    const { provider, calls } = createMockProvider([
      textResponse("Must not use API"),
    ]);
    await new AgentLoop({
      provider,
      systemPrompt: "System",
      conversationId: "conversation-hook-sdk",
    }).run({
      ...baseRun,
      overrideProfile: "native-profile",
    });
    expect(sdk).toHaveBeenCalledTimes(1);
    expect(sdk.mock.calls[0]![0].run.overrideProfile).toBe(
      "subscription-profile",
    );
    expect(sdk.mock.calls[0]![0].maxTokens).toBe(4096);
    expect(calls).toHaveLength(0);
  });

  test("an explicit API override keeps native routing without a second connection resolution", async () => {
    setConfig("llm", {
      ...getConfig().llm,
      activeProfile: "subscription-profile",
    });
    const sdk = mockRuntime();
    const configured = spyOn(providerSendMessage, "resolveConfiguredProvider");
    restore.push(() => configured.mockRestore());
    const { provider, calls } = createMockProvider(
      [textResponse("Native API result")],
      "anthropic",
    );
    const result = await new AgentLoop({
      provider: new RetryProvider(provider),
      systemPrompt: "System",
      conversationId: "conversation-api-override",
    }).run({
      ...baseRun,
      overrideProfile: "native-profile",
    });
    expect(configured).not.toHaveBeenCalled();
    expect(sdk).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options?.config?.model).toBe("claude-sonnet-4-6");
    expect(result.history.at(-1)?.content).toEqual([
      { type: "text", text: "Native API result" },
    ]);
  });

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
    expect(dispatched.tokenEstimation).toEqual({
      systemPrompt: "Assistant system prompt",
      providerName: "anthropic",
      model: provider.defaultModel,
    });
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
    const { provider, calls } = createMockProvider(
      [textResponse("Must not use API")],
      "claude-agent-sdk",
    );
    const wrapped = new providerSendMessage.CallSiteConfiguredProvider(
      new UsageTrackingProvider(new RetryProvider(provider)),
      "workflowLeaf",
      "subscription-profile",
    );
    const configured = spyOn(
      providerSendMessage,
      "getConfiguredProvider",
    ).mockResolvedValue(wrapped);
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
  test("existing API workflow leaves keep their semantic call site unset", async () => {
    const sdk = mockRuntime();
    const { provider, calls } = createMockProvider(
      [textResponse("Native leaf result")],
      "anthropic",
    );
    const wrapped = new providerSendMessage.CallSiteConfiguredProvider(
      new UsageTrackingProvider(new RetryProvider(provider)),
      "workflowLeaf",
      "native-profile",
    );
    const configured = spyOn(
      providerSendMessage,
      "getConfiguredProvider",
    ).mockResolvedValue(wrapped);
    const loopRun = spyOn(AgentLoop.prototype, "run");
    restore.push(
      () => configured.mockRestore(),
      () => loopRun.mockRestore(),
    );
    const { runLeaf } = await import("../workflows/leaf-runner.js");
    const result = await runLeaf({
      prompt: "Complete the API leaf task",
      tools: [],
      profile: "native-profile",
      trustContext: { sourceChannel: "vellum", trustClass: "unknown" },
    });
    expect(configured).toHaveBeenCalledWith("workflowLeaf", {
      overrideProfile: "native-profile",
    });
    expect(loopRun).toHaveBeenCalledTimes(1);
    expect(Object.hasOwn(loopRun.mock.calls[0]![0], "callSite")).toBe(false);
    expect(sdk).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(result.output).toBe("Native leaf result");
  });
});
