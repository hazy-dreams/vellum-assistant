import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { z } from "zod";

import { setConfig } from "../../__tests__/helpers/set-config.js";
import { initializeDb } from "../../persistence/db-init.js";
import { ProviderError } from "../../util/errors.js";
import { DEFAULT_MAX_RETRIES } from "../../util/retry.js";
import {
  recordFallbackServed,
  resetFallbackBreaker,
} from "../fallback-breaker.js";
import { createAdapterFromConnection } from "../inference/adapter-factory.js";
import type { ProviderConnection } from "../inference/auth.js";
import { RetryProvider } from "../retry.js";
import type { Message, ProviderResponse } from "../types.js";
import { UsageTrackingProvider } from "../usage-tracking.js";
import { ClaudeAgentSdkProvider } from "./client.js";

await initializeDb();

const connection: ProviderConnection = {
  name: "claude-subscription",
  provider: "claude-agent-sdk",
  auth: { type: "none" },
  label: null,
  baseUrl: null,
  models: null,
  createdAt: 1,
  updatedAt: 1,
  isManaged: false,
};
const messages: Message[] = [
  { role: "user", content: [{ type: "text", text: "Example request" }] },
];
const response: ProviderResponse = {
  content: [{ type: "text", text: "Example response" }],
  model: "haiku",
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: "end_turn",
};
let restoreSend = () => {};

beforeEach(() => {
  resetFallbackBreaker();
  setConfig("llm", {
    defaultProvider: {
      provider: "claude-agent-sdk",
      connectionName: connection.name,
    },
  });
});
afterEach(() => {
  restoreSend();
  resetFallbackBreaker();
});

function fixture() {
  // Stub the leaf only: adapter construction and retry/usage wrappers are real.
  const send = spyOn(ClaudeAgentSdkProvider.prototype, "sendMessage");
  restoreSend = () => send.mockRestore();
  send.mockResolvedValue(response);
  const adapter = createAdapterFromConnection(
    connection,
    { kind: "none" },
    { model: "haiku" },
  );
  if (!adapter) {
    throw new Error("Expected a Claude subscription adapter");
  }
  return { adapter, send };
}

describe("Claude subscription no-auth retry wiring", () => {
  test("uses ordinary retry and usage wrappers without managed escalation hooks", () => {
    const { adapter } = fixture();
    expect(adapter).toBeInstanceOf(UsageTrackingProvider);
    const { inner: retry } = z
      .object({ inner: z.instanceof(RetryProvider) })
      .parse(adapter);
    expect(
      z
        .object({
          inner: z.instanceof(ClaudeAgentSdkProvider),
          options: z.object({
            credentialSource: z.literal("no-auth"),
            connectionName: z.literal(connection.name),
            forwardUsageAttributionHeaders: z.literal(false),
            refreshCredentialProvider: z.undefined(),
            resolveFallbackRoute: z.undefined(),
          }),
        })
        .safeParse(retry).success,
    ).toBe(true);
  });

  test("retries a transient subscription failure on the same adapter", async () => {
    const { adapter, send } = fixture();
    send.mockRejectedValueOnce(
      new ProviderError("Rate limited", "claude-agent-sdk", 429, {
        retryAfterMs: 0,
      }),
    );
    expect(
      await adapter.sendMessage(messages, {
        config: { callSite: "conversationTitle" },
      }),
    ).toEqual(response);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[1]?.config?.model).toBe("haiku");
    expect(send.mock.calls[1]?.[1]?.config?.model).toBe("haiku");
  });

  test("exhausts ordinary retries without consulting a managed backup breaker", async () => {
    const { adapter, send } = fixture();
    const error = new ProviderError(
      "Service unavailable",
      "claude-agent-sdk",
      503,
      {
        retryAfterMs: 0,
      },
    );
    send.mockRejectedValue(error);
    recordFallbackServed({ upstream: "claude-agent-sdk" });
    await expect(
      adapter.sendMessage(messages, {
        config: { callSite: "conversationTitle" },
      }),
    ).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(DEFAULT_MAX_RETRIES + 1);
  });

  test("surfaces subscription authentication failures without retrying", async () => {
    const { adapter, send } = fixture();
    const error = new ProviderError(
      "Sign in to Claude Code",
      "claude-agent-sdk",
      401,
    );
    send.mockRejectedValue(error);
    await expect(
      adapter.sendMessage(messages, {
        config: { callSite: "conversationTitle" },
      }),
    ).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
