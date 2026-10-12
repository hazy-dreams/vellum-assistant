import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import type { AssistantEvent } from "../api/index.js";
import {
  createEventHandlerState,
  dispatchAgentEvent,
  type EventHandlerDeps,
} from "../daemon/conversation-agent-loop-handlers.js";

function usageFixture() {
  const sent: AssistantEvent[] = [];
  const deps = {
    ctx: {
      conversationId: "conversation-usage-count",
      provider: { name: "claude-agent-sdk" },
    },
    onEvent: (event: AssistantEvent) => sent.push(event),
    rlog: { warn: () => {} },
  } as unknown as EventHandlerDeps;
  const event: Extract<AgentEvent, { type: "usage" }> = {
    type: "usage",
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationInputTokens: 7,
    cacheReadInputTokens: 11,
    model: "sonnet",
    actualProvider: "claude-agent-sdk",
    providerDurationMs: 10,
  };
  return { state: createEventHandlerState(), deps, event, sent };
}

describe("agent loop usage call counts", () => {
  test("an ordinary usage event defaults to one LLM call", async () => {
    const { state, deps, event, sent } = usageFixture();
    await dispatchAgentEvent(state, deps, event);
    expect(state.exchangeLlmCallCount).toBe(1);
    expect(state.exchangeInputTokens).toBe(100);
    expect(state.lastCallInputTokens).toBe(100);
    expect(state.exchangeOutputTokens).toBe(20);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe("usage_progress");
  });

  test("aggregate SDK usage preserves its call count without multiplying tokens", async () => {
    const { state, deps, event } = usageFixture();
    await dispatchAgentEvent(state, deps, { ...event, llmCallCount: 2 });
    expect(state.exchangeLlmCallCount).toBe(2);
    expect(state.exchangeInputTokens).toBe(100);
    expect(state.exchangeOutputTokens).toBe(20);
    expect(state.exchangeCacheCreationInputTokens).toBe(7);
    expect(state.exchangeCacheReadInputTokens).toBe(11);
  });

  test("ordinary and aggregate usage events add their represented calls", async () => {
    const { state, deps, event } = usageFixture();
    await dispatchAgentEvent(state, deps, event);
    await dispatchAgentEvent(state, deps, { ...event, llmCallCount: 2 });
    expect(state.exchangeLlmCallCount).toBe(3);
    expect(state.exchangeInputTokens).toBe(200);
    expect(state.exchangeOutputTokens).toBe(40);
  });

  test("aggregate usage keeps the latest context size separate from total input tokens", async () => {
    const { state, deps, event } = usageFixture();
    await dispatchAgentEvent(state, deps, {
      ...event,
      inputTokens: 22,
      lastCallInputTokens: 11,
      llmCallCount: 2,
    });
    expect(state.exchangeLlmCallCount).toBe(2);
    expect(state.exchangeInputTokens).toBe(22);
    expect(state.lastCallInputTokens).toBe(11);
  });
});
