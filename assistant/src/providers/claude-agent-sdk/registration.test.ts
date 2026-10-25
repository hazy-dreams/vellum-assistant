import { describe, expect, test } from "bun:test";

import { resolveDefaultProfileForProvider } from "../../config/default-profile-catalog.js";
import { resolveCallSiteConfig } from "../../config/llm-resolver.js";
import {
  DEFAULT_PROVIDER_CHOICES,
  LLMSchema,
  unknownLlmProviderIssue,
} from "../../config/schemas/llm.js";
import {
  buildProviderAdapter,
  createAdapterFromConnection,
} from "../inference/adapter-factory.js";
import {
  deriveAuthForProvider,
  type ProviderConnection,
} from "../inference/auth.js";
import { PROVIDER_CATALOG } from "../model-catalog.js";
import { API_KEY_PROVIDERS } from "../provider-secret-catalog.js";
import { ClaudeAgentSdkProvider } from "./client.js";

const provider = "claude-agent-sdk";
const connection: ProviderConnection = {
  name: "claude-subscription",
  provider,
  auth: { type: "none" },
  label: null,
  baseUrl: null,
  models: null,
  createdAt: 1,
  updatedAt: 1,
  isManaged: false,
};

describe("Claude subscription registration", () => {
  test("is a native default-provider choice with subscription aliases", () => {
    expect(DEFAULT_PROVIDER_CHOICES).toContain(provider);
    expect(unknownLlmProviderIssue(provider)).toBeNull();
    expect(
      PROVIDER_CATALOG.find((entry) => entry.id === provider),
    ).toMatchObject({
      displayName: "Claude subscription",
      setupMode: "keyless",
      defaultModel: "sonnet",
    });
    expect(deriveAuthForProvider(provider)).toEqual({ type: "none" });
    expect(API_KEY_PROVIDERS).not.toContain(provider);
  });

  test("default profiles resolve all auxiliary calls through the subscription", () => {
    const config = LLMSchema.parse({
      defaultProvider: { provider, connectionName: connection.name },
    });
    for (const [name, model] of [
      ["balanced", "sonnet"],
      ["quality-optimized", "opus"],
      ["cost-optimized", "haiku"],
      ["latency-optimized", "haiku"],
    ]) {
      const profile = resolveDefaultProfileForProvider(
        {},
        name,
        config.defaultProvider ?? null,
      );
      expect(profile).toMatchObject({
        provider,
        model,
        provider_connection: connection.name,
      });
      expect(profile?.fallbackProfile).toBeUndefined();
    }
    for (const site of [
      "mainAgent",
      "conversationTitle",
      "memoryV3SelectL2",
    ] as const) {
      expect(resolveCallSiteConfig(site, config).provider).toBe(provider);
    }
  });

  test("explicit API profile selection stays on its chosen provider", () => {
    const config = LLMSchema.parse({
      defaultProvider: { provider },
      profiles: {
        "api-model": {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          provider_connection: "anthropic-personal",
          source: "user",
        },
      },
    });
    expect(
      resolveCallSiteConfig("mainAgent", config, {
        overrideProfile: "api-model",
      }),
    ).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  test("API active profile affects chat while auxiliary defaults remain subscription-backed", () => {
    const config = LLMSchema.parse({
      defaultProvider: { provider, connectionName: connection.name },
      activeProfile: "api-model",
      profiles: {
        "api-model": {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          provider_connection: "anthropic-personal",
          source: "user",
        },
      },
    });
    expect(resolveCallSiteConfig("mainAgent", config)).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      provider_connection: "anthropic-personal",
    });
    expect(resolveCallSiteConfig("conversationTitle", config)).toMatchObject({
      provider,
      model: "haiku",
      provider_connection: connection.name,
    });
  });

  test("explicit API call-site model pins replace SDK identity and connection", () => {
    const config = LLMSchema.parse({
      defaultProvider: { provider, connectionName: connection.name },
      callSites: { conversationTitle: { model: "claude-sonnet-4-6" } },
    });
    const resolved = resolveCallSiteConfig("conversationTitle", config);
    expect(resolved).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(resolved.provider_connection).toBeUndefined();
  });

  test("SDK auxiliary profile pins override an API default without inheriting fallback routes", () => {
    const config = LLMSchema.parse({
      defaultProvider: {
        provider: "anthropic",
        connectionName: "anthropic-personal",
      },
      profiles: {
        subscription: {
          provider,
          model: "opus",
          provider_connection: connection.name,
          source: "user",
        },
        api: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          provider_connection: "anthropic-personal",
          source: "user",
        },
      },
      callSites: {
        memoryRouter: { profile: "api" },
        memoryRetrospective: { profile: "subscription" },
      },
    });
    expect(resolveCallSiteConfig("memoryRetrospective", config)).toMatchObject({
      provider,
      model: "opus",
      provider_connection: connection.name,
    });
    expect(resolveCallSiteConfig("memoryRouter", config)).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(
      resolveCallSiteConfig("memoryRouter", config, {
        overrideProfile: "subscription",
        forceOverrideProfile: true,
      }),
    ).toMatchObject({
      provider,
      model: "opus",
      provider_connection: connection.name,
    });
    expect(config.profiles.subscription.fallbackProfile).toBeUndefined();
  });

  test("builds an SDK adapter and preserves identity through wrappers", () => {
    expect(
      buildProviderAdapter(provider, {
        apiKey: "",
        model: "sonnet",
        streamTimeoutMs: 1000,
        useNativeWebSearch: false,
      }),
    ).toBeInstanceOf(ClaudeAgentSdkProvider);
    expect(
      createAdapterFromConnection(
        connection,
        { kind: "none" },
        { model: "opus" },
      )?.name,
    ).toBe(provider);
  });

  test("rejects API auth and custom endpoints for the subscription route", () => {
    expect(
      createAdapterFromConnection(
        connection,
        { kind: "header", headers: { Authorization: "Bearer example-token" } },
        { model: "sonnet" },
      ),
    ).toBeNull();
    expect(
      createAdapterFromConnection(
        connection,
        { kind: "none", baseUrl: "https://api.example.com" },
        { model: "sonnet" },
      ),
    ).toBeNull();
    expect(() =>
      buildProviderAdapter(provider, {
        apiKey: "example-token",
        model: "sonnet",
        streamTimeoutMs: 1000,
        useNativeWebSearch: false,
      }),
    ).toThrow("does not accept API keys");
  });

  test("validates optional absolute executable path and supports clearing it", () => {
    expect(
      LLMSchema.parse({
        claudeAgentSdk: { executablePath: "/usr/local/bin/claude" },
      }).claudeAgentSdk?.executablePath,
    ).toBe("/usr/local/bin/claude");
    expect(
      LLMSchema.parse({ claudeAgentSdk: { executablePath: null } })
        .claudeAgentSdk?.executablePath,
    ).toBeNull();
    expect(
      LLMSchema.safeParse({ claudeAgentSdk: { executablePath: "claude" } })
        .success,
    ).toBe(false);
  });
});
