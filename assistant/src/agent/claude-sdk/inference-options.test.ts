import { describe, expect, test } from "bun:test";

import { resolveClaudeSdkInferenceOptions } from "./inference-options.js";

describe("Claude SDK inference options", () => {
  test.each(["low", "medium", "high", "xhigh", "max"])(
    "preserves native effort %s without imposing a thinking mode",
    (effort) => {
      expect(resolveClaudeSdkInferenceOptions({ effort })).toEqual({ effort });
    },
  );

  test("leaves unspecified effort and thinking to the native CLI", () => {
    expect(resolveClaudeSdkInferenceOptions({})).toEqual({});
  });

  test.each([
    { effort: "none" },
    { thinking: { enabled: false, streamThinking: false } },
    { thinking: { type: "disabled" } },
    { effort: "none", thinking: { enabled: false } },
  ])("maps legacy low-latency intent to low: %j", (config) => {
    expect(resolveClaudeSdkInferenceOptions(config)).toEqual({ effort: "low" });
  });

  test.each([{ enabled: false }, { type: "disabled" }])(
    "preserves explicit effort when legacy thinking is disabled: %j",
    (thinking) => {
      expect(
        resolveClaudeSdkInferenceOptions({ effort: "high", thinking }),
      ).toEqual({ effort: "high" });
    },
  );

  test.each([{ enabled: true }, { type: "adaptive" }])(
    "lets the CLI choose a model-compatible thinking mode: %j",
    (thinking) => {
      expect(resolveClaudeSdkInferenceOptions({ thinking })).toEqual({});
    },
  );

  test("preserves an explicit fixed thinking budget", () => {
    expect(
      resolveClaudeSdkInferenceOptions({
        effort: "medium",
        thinking: { type: "enabled", budget_tokens: 2048 },
      }),
    ).toEqual({
      effort: "medium",
      thinking: { type: "enabled", budgetTokens: 2048 },
    });
  });

  test.each([
    { effort: "extreme" },
    { effort: "" },
    { thinking: true },
    { thinking: { enabled: "false" } },
    { thinking: { type: "enabled", budget_tokens: -1 } },
    { thinking: { type: "enabled" } },
  ])("rejects invalid inference options: %j", (config) => {
    expect(() => resolveClaudeSdkInferenceOptions(config)).toThrow(
      "Unsupported Claude subscription effort or thinking configuration",
    );
  });
});
