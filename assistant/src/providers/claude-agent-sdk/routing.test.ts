import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";
import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { ProviderError } from "../../util/errors.js";
import { CallSiteRoutingProvider } from "../call-site-routing.js";
import { createConnection } from "../inference/connections.js";
import type { Provider, ProviderResponse } from "../types.js";

await initializeDb();
const messages = [
  {
    role: "user" as const,
    content: [{ type: "text" as const, text: "Example request" }],
  },
];

function fakeProvider(name: string) {
  const sendMessage = mock(
    async (): Promise<ProviderResponse> => ({
      content: [{ type: "text", text: "ok" }],
      model: name,
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  );
  return { name, sendMessage } satisfies Provider;
}

beforeEach(() => setConfig("llm", {}));

describe("Claude subscription transport routing", () => {
  test("an unavailable SDK connection never falls back to a paid default", async () => {
    setConfig("llm", {
      defaultProvider: {
        provider: "claude-agent-sdk",
        connectionName: "sdk-connection",
      },
    });
    const paid = fakeProvider("anthropic");
    const resolver = mock(async () => null);
    const routing = new CallSiteRoutingProvider(paid, resolver);
    await expect(
      routing.sendMessage(messages, { config: { callSite: "memoryRouter" } }),
    ).rejects.toThrow("No fallback provider was used");
    expect(resolver).toHaveBeenCalledWith(
      "sdk-connection",
      "claude-agent-sdk",
      "haiku",
    );
    expect(paid.sendMessage).not.toHaveBeenCalled();
  });

  test("an SDK entry alias also fails closed when its adapter is unavailable", async () => {
    const alias = `sdk-alias-${randomUUID()}`;
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
        subscription: { provider: alias, model: "opus", source: "user" },
      },
      callSites: { memoryRouter: { profile: "subscription" } },
    });
    const paid = fakeProvider("anthropic");
    const resolver = mock(async () => null);
    const routing = new CallSiteRoutingProvider(paid, resolver);
    await expect(
      routing.sendMessage(messages, { config: { callSite: "memoryRouter" } }),
    ).rejects.toThrow("No fallback provider was used");
    expect(resolver).toHaveBeenCalledWith(alias, "claude-agent-sdk", "opus");
    expect(paid.sendMessage).not.toHaveBeenCalled();
  });

  test("successful SDK auxiliary routing and failed inference never hit the paid default", async () => {
    setConfig("llm", {
      defaultProvider: {
        provider: "claude-agent-sdk",
        connectionName: "sdk-connection",
      },
    });
    const paid = fakeProvider("anthropic");
    const sdk = fakeProvider("claude-agent-sdk");
    const routing = new CallSiteRoutingProvider(paid, async () => sdk);
    expect(
      (
        await routing.sendMessage(messages, {
          config: { callSite: "conversationTitle" },
        })
      ).actualProvider,
    ).toBe("claude-agent-sdk");
    sdk.sendMessage.mockImplementationOnce(async () => {
      throw new ProviderError(
        "Subscription unavailable",
        "claude-agent-sdk",
        400,
      );
    });
    await expect(
      routing.sendMessage(messages, {
        config: { callSite: "memoryV3SelectL2" },
      }),
    ).rejects.toThrow("Subscription unavailable");
    expect(paid.sendMessage).not.toHaveBeenCalled();
    expect(sdk.sendMessage).toHaveBeenCalledTimes(2);
  });

  test("an unavailable explicit API choice never silently uses the SDK default", async () => {
    setConfig("llm", {
      defaultProvider: {
        provider: "claude-agent-sdk",
        connectionName: "sdk-connection",
      },
      profiles: {
        api: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          provider_connection: "api-connection",
          source: "user",
        },
      },
      callSites: { memoryRouter: { profile: "api" } },
    });
    const sdk = fakeProvider("claude-agent-sdk");
    const routing = new CallSiteRoutingProvider(sdk, async () => null);
    await expect(
      routing.sendMessage(messages, { config: { callSite: "memoryRouter" } }),
    ).rejects.toThrow("No fallback provider was used");
    expect(sdk.sendMessage).not.toHaveBeenCalled();
  });

  test("explicit API call-site and per-request profile pins remain authoritative", async () => {
    setConfig("llm", {
      defaultProvider: {
        provider: "claude-agent-sdk",
        connectionName: "sdk-connection",
      },
      profiles: {
        api: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          provider_connection: "api-connection",
          source: "user",
        },
        subscription: {
          provider: "claude-agent-sdk",
          model: "opus",
          provider_connection: "sdk-connection",
          source: "user",
        },
      },
      callSites: { memoryRouter: { profile: "api" } },
    });
    const sdk = fakeProvider("claude-agent-sdk");
    const api = fakeProvider("anthropic");
    const resolve = mock(
      async (
        name: string,
        _expectedProvider: string | undefined,
        _model: string | undefined,
      ) => (name === "api-connection" ? api : sdk),
    );
    const routing = new CallSiteRoutingProvider(sdk, resolve);
    expect(
      (
        await routing.sendMessage(messages, {
          config: { callSite: "memoryRouter" },
        })
      ).actualProvider,
    ).toBe("anthropic");
    await routing.sendMessage(messages, {
      config: { callSite: "memoryRouter", overrideProfile: "subscription" },
    });
    expect(resolve.mock.calls[1]).toEqual([
      "sdk-connection",
      "claude-agent-sdk",
      "opus",
    ]);
    await routing.sendMessage(messages, {
      config: { callSite: "conversationTitle", overrideProfile: "api" },
    });
    expect(resolve.mock.calls[2]).toEqual([
      "api-connection",
      "anthropic",
      "claude-sonnet-4-6",
    ]);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(sdk.sendMessage).toHaveBeenCalledTimes(1);
  });
});
