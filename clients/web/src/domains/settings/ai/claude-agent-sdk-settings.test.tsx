import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  ClaudeAgentSdkSettings,
  isClaudeExecutablePathValid,
} from "./claude-agent-sdk-settings";

afterEach(cleanup);

describe("Claude Code executable path", () => {
  test.each([
    "",
    "  ",
    "/usr/local/bin/claude",
    "/opt/Claude Code/claude",
    "C:\\Tools\\claude.exe",
    "C:/Tools/claude.exe",
    "\\\\server\\tools\\claude.exe",
  ])("accepts automatic or absolute path %s", (path) => {
    expect(isClaudeExecutablePathValid(path)).toBe(true);
  });
  test.each([
    "claude",
    "./claude",
    "~/bin/claude",
    "C:claude.exe",
    "https://example.com/claude",
    "/bin/claude\u0000bad",
    "/bin/claude\nbad",
  ])("rejects non-executable path %s", (path) => {
    expect(isClaudeExecutablePathValid(path)).toBe(false);
  });
});

test("explains subscription setup without token, API key, or login controls", () => {
  let value = "";
  render(
    <ClaudeAgentSdkSettings
      executablePath=""
      onExecutablePathChange={(next) => {
        value = next;
      }}
      error={null}
    />,
  );
  expect(
    screen.getByText(/same computer that runs this assistant/),
  ).toBeTruthy();
  expect(
    screen.getByText(/Uses your Claude subscription limits and ordinary retries/),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /sign in|log in/i })).toBeNull();
  expect(screen.queryByLabelText(/API key|token/i)).toBeNull();
  fireEvent.change(
    screen.getByLabelText("Claude Code executable path (optional)"),
    { target: { value: "/opt/claude" } },
  );
  expect(value).toBe("/opt/claude");
});

test("discloses fallback and separate service charges while preserving override guidance", () => {
  render(
    <ClaudeAgentSdkSettings
      executablePath=""
      onExecutablePathChange={() => {}}
      error={null}
    />,
  );
  const billing = screen.getByText(/Claude Agent SDK does not provide embeddings/);
  expect(billing.textContent).toContain(
    "Check your profile and fallback settings; separate services and API overrides may incur charges.",
  );
  expect(billing.textContent).not.toContain("will not switch to paid API credits");
  expect(billing.textContent).toContain(
    "Memory embeddings keep their separately configured backend and may incur API or managed-service charges.",
  );
  expect(billing.textContent).toContain(
    "Existing chat-profile and background-task overrides keep their selected providers.",
  );
});

test("shows an accessible inline error and retries without clearing the path", () => {
  let retried = false;
  render(
    <ClaudeAgentSdkSettings
      executablePath="./claude"
      onExecutablePathChange={() => {}}
      error="Path is invalid"
      onRetry={() => {
        retried = true;
      }}
    />,
  );
  const path = screen.getByLabelText("Claude Code executable path (optional)");
  expect(path.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByRole("alert").textContent).toBe("Path is invalid");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(retried).toBe(true);
  expect((path as HTMLInputElement).value).toBe("./claude");
});

test("loading is a status rather than an invalid executable path", () => {
  render(
    <ClaudeAgentSdkSettings
      executablePath=""
      onExecutablePathChange={() => {}}
      error="Checking assistant support…"
      disabled
    />,
  );
  expect(screen.getByText("Checking assistant support…").getAttribute("role")).toBe("status");
  expect(
    screen
      .getByLabelText("Claude Code executable path (optional)")
      .getAttribute("aria-invalid"),
  ).toBeNull();
});
