import { expect, test } from "bun:test";

import { claudeSdkTimeoutEnvironment } from "./timeout.js";

test("maps the configured milliseconds to native request and idle watchdogs", () => {
  expect(claudeSdkTimeoutEnvironment(30_000)).toEqual({
    API_TIMEOUT_MS: "30000",
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: "30000",
    CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "30000",
  });
});

test("bounds native timer values without changing the host environment", () => {
  const previous = process.env.API_TIMEOUT_MS;
  expect(claudeSdkTimeoutEnvironment(3_000_000_000).API_TIMEOUT_MS).toBe(
    "2147483647",
  );
  expect(claudeSdkTimeoutEnvironment(0.2).API_TIMEOUT_MS).toBe("1");
  expect(process.env.API_TIMEOUT_MS).toBe(previous);
});

test("rejects invalid timeout values", () => {
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => claudeSdkTimeoutEnvironment(value)).toThrow("positive finite");
  }
});
