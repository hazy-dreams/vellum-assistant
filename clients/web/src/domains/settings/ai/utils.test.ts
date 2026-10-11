import { describe, expect, test } from "bun:test";

import {
  allowsKeylessCustomWebProviderBase,
  resolveTokenBudgetStateForModel,
} from "@/domains/settings/ai/utils";

describe("allowsKeylessCustomWebProviderBase", () => {
  test("allows only fastCRW custom bases to run without a provider key", () => {
    expect(allowsKeylessCustomWebProviderBase("fastcrw", true)).toBe(true);
    expect(allowsKeylessCustomWebProviderBase("fastcrw", false)).toBe(false);
    expect(allowsKeylessCustomWebProviderBase("tinyfish", true)).toBe(false);
  });
});

test("subscription aliases do not invent model token caps", () => {
  const state = {
    maxOutputTokens: 12_000,
    maxOutputTouched: false,
    contextWindowTokens: 100_000,
    contextWindowTouched: false,
  };
  expect(
    resolveTokenBudgetStateForModel(
      {
        id: "sonnet",
        displayName: "Claude Sonnet (subscription)",
        defaultContextWindowTokens: 200_000,
      },
      state,
    ),
  ).toEqual(state);
});
