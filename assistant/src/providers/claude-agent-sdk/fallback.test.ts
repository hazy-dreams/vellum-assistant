import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";
import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { ProviderError } from "../../util/errors.js";
import { CallSiteRoutingProvider } from "../call-site-routing.js";
import {
  recordFallbackServed,
  resetFallbackBreaker,
  shouldSkipPrimary,
} from "../fallback-breaker.js";
import { createConnection } from "../inference/connections.js";
import { RetryProvider } from "../retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../types.js";
import { ClaudeAgentSdkProvider, type ClaudeSdkQuery } from "./client.js";

await initializeDb();

const messages: Message[] = [
  { role: "user", content: [{ type: "text", text: "Example request" }] },
];
const response: ProviderResponse = {
  content: [{ type: "text", text: "API response" }],
  model: "claude-sonnet-4-6",
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: "end_turn",
};

beforeEach(() => {
  resetFallbackBreaker();
  setConfig("llm", {
    defaultProvider: {
      provider: "claude-agent-sdk",
      connectionName: "subscription",
    },
    profiles: {
      "api-primary": {
        provider: "openai",
        model: "gpt-5.6-luna",
        provider_connection: "api-primary",
        source: "user",
      },
      "paid-backup": {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        provider_connection: "paid-backup",
        source: "user",
      },
    },
  });
});
afterEach(() => resetFallbackBreaker());

function fixture(error: Error, failAtLaunch = false) {
  const close = mock(() => {});
  const query = mock<ClaudeSdkQuery>(() => {
    if (failAtLaunch) {
      throw error;
    }
    return {
      close,
      async *[Symbol.asyncIterator]() {
        yield* [];
        throw error;
      },
    };
  });
  const sdk = new ClaudeAgentSdkProvider("sonnet", {
    executablePath: "/usr/local/bin/claude",
    query,
    preflight: async ({ executablePath }) => ({
      ok: true,
      executablePath,
      env: {},
    }),
  });
  const paidSend = mock(async () => response);
  const paid: Provider = { name: "anthropic", sendMessage: paidSend };
  const fallback = mock(async () => ({
    provider: paid,
    overrideProfile: "paid-backup",
    forwardUsageAttributionHeaders: false,
  }));
  const retry = new RetryProvider(sdk, { resolveFallbackRoute: fallback });
  return { retry, query, close, fallback, paidSend };
}

describe("Claude subscription retry boundary", () => {
  for (const [name, error, failAtLaunch] of [
    ["SDK launch", new Error("Failed to start Claude Code"), true],
    ["SDK iterator", new Error("stream terminated prematurely"), false],
    [
      "SDK rate limit",
      new ProviderError("Rate limited", "claude-agent-sdk", 429),
      false,
    ],
    [
      "SDK unavailable",
      new ProviderError("Service unavailable", "claude-agent-sdk", 503),
      false,
    ],
  ] as const) {
    test(`${name} failure never resolves or invokes a paid backup`, async () => {
      const f = fixture(error, failAtLaunch);
      await expect(
        f.retry.sendMessage(messages, {
          config: { callSite: "conversationTitle" },
        }),
      ).rejects.toBe(error);
      expect(f.query).toHaveBeenCalledTimes(1);
      expect(f.fallback).not.toHaveBeenCalled();
      expect(f.paidSend).not.toHaveBeenCalled();
      expect(f.close).toHaveBeenCalledTimes(failAtLaunch ? 0 : 1);
    });
  }

  test("an open fallback breaker cannot bypass the selected SDK route", async () => {
    recordFallbackServed({ upstream: "claude-agent-sdk" });
    expect(
      shouldSkipPrimary({ upstream: "claude-agent-sdk", model: "haiku" }),
    ).toBe(true);
    const error = new ProviderError("Rate limited", "claude-agent-sdk", 429);
    const f = fixture(error);
    await expect(
      f.retry.sendMessage(messages, {
        config: { callSite: "conversationTitle" },
      }),
    ).rejects.toBe(error);
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.fallback).not.toHaveBeenCalled();
    expect(f.paidSend).not.toHaveBeenCalled();
  });

  test("an API default routes an SDK entry alias without any paid fallback", async () => {
    const alias = `sdk-retry-alias-${randomUUID()}`;
    expect(
      createConnection(getDb(), {
        name: alias,
        provider: "claude-agent-sdk",
        auth: { type: "none" },
      }).ok,
    ).toBe(true);
    setConfig("llm", {
      defaultProvider: { provider: "anthropic" },
      profiles: {
        subscription: { provider: alias, model: "haiku", source: "user" },
        "paid-backup": {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          source: "user",
        },
      },
      callSites: { conversationTitle: { profile: "subscription" } },
    });
    const primarySend = mock(async () => response);
    const primary: Provider = { name: "anthropic", sendMessage: primarySend };
    const error = new ProviderError("Rate limited", "claude-agent-sdk", 429);
    const f = fixture(error);
    const routing = new CallSiteRoutingProvider(primary, async () => f.retry);
    recordFallbackServed({ upstream: "claude-agent-sdk" });
    await expect(
      routing.sendMessage(messages, {
        config: { callSite: "conversationTitle" },
      }),
    ).rejects.toBe(error);
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(primarySend).not.toHaveBeenCalled();
    expect(f.fallback).not.toHaveBeenCalled();
    expect(f.paidSend).not.toHaveBeenCalled();
  });

  test("an API-bound retry wrapper fails closed when the effective request selects SDK", async () => {
    const primarySend = mock(async () => response);
    const primary: Provider = { name: "anthropic", sendMessage: primarySend };
    const f = fixture(new Error("SDK unavailable"));
    const retry = new RetryProvider(primary, {
      resolveFallbackRoute: f.fallback,
    });
    recordFallbackServed({ upstream: "anthropic" });
    await expect(
      retry.sendMessage(messages, {
        config: { callSite: "conversationTitle" },
      }),
    ).rejects.toThrow("No API provider was used");
    expect(primarySend).not.toHaveBeenCalled();
    expect(f.fallback).not.toHaveBeenCalled();
    expect(f.paidSend).not.toHaveBeenCalled();
  });

  test("an explicit API override retains ordinary API breaker and backup behavior", async () => {
    const sdkSend = mock(async () => response);
    const sdk: Provider = { name: "claude-agent-sdk", sendMessage: sdkSend };
    const apiSend = mock(async () => response);
    const api: Provider = { name: "openai", sendMessage: apiSend };
    const paidSend = mock(async () => response);
    const paid: Provider = { name: "anthropic", sendMessage: paidSend };
    const fallback = mock(async (_options: SendMessageOptions | undefined) => ({
      provider: paid,
      overrideProfile: "paid-backup",
      forwardUsageAttributionHeaders: false,
    }));
    const apiRetry = new RetryProvider(api, { resolveFallbackRoute: fallback });
    const routing = new CallSiteRoutingProvider(
      new RetryProvider(sdk),
      async () => apiRetry,
    );
    recordFallbackServed({ upstream: "openai" });
    const result = await routing.sendMessage(messages, {
      config: { callSite: "conversationTitle", overrideProfile: "api-primary" },
    });
    expect(result.actualProvider).toBe("anthropic");
    expect(sdkSend).not.toHaveBeenCalled();
    expect(apiSend).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(paidSend).toHaveBeenCalledTimes(1);
  });
});
