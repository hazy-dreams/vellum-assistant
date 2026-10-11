import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

let supported = true;
let supportFails = false;
let configFails = false;
let saveFails = false;
let savedPath: string | null = "/opt/claude";
let supportReads = 0;
let configReads = 0;
let writes: unknown[] = [];

mock.module("@/hooks/use-is-org-ready", () => ({ useIsOrgReady: () => true }));
mock.module("@/hooks/use-assistant-capability", () => ({
  assistantCapabilityOptions: (capability: string, assistantId: string) =>
    queryOptions({
      queryKey: ["assistant-capability", capability, assistantId],
      queryFn: async () => {
        supportReads += 1;
        if (supportFails) {
          throw new Error("offline");
        }
        return supported;
      },
      retry: false,
    }),
}));
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetOptions: ({ path }: { path: { assistant_id: string } }) =>
    queryOptions({
      queryKey: ["config", path.assistant_id],
      queryFn: async () => {
        configReads += 1;
        if (configFails) {
          throw new Error("offline");
        }
        return { llm: { claudeAgentSdk: { executablePath: savedPath } } };
      },
      retry: false,
    }),
  configLlmDefaultproviderGetQueryKey: () => ["default-provider"],
}));
mock.module("@/domains/settings/ai/use-llm-config-patch", () => ({
  useLlmConfigPatch: () => ({
    mutateAsync: async (input: unknown) => {
      writes.push(input);
      if (saveFails) {
        throw new Error("offline");
      }
    },
  }),
}));

const { useClaudeAgentSdkSettings } =
  await import("./use-claude-agent-sdk-settings");
let queryClient: QueryClient;
function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  supported = true;
  supportFails = false;
  configFails = false;
  saveFails = false;
  savedPath = "/opt/claude";
  supportReads = 0;
  configReads = 0;
  writes = [];
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

test("other providers do not read or write Claude settings", async () => {
  const { result } = renderHook(
    () => useClaudeAgentSdkSettings("assistant-1", false),
    { wrapper: Wrapper },
  );
  expect(result.current.canSave).toBe(true);
  await result.current.savePath();
  expect(supportReads).toBe(0);
  expect(configReads).toBe(0);
  expect(writes).toEqual([]);
});

test("reads existing path and never writes an untouched setting", async () => {
  const { result } = renderHook(
    () => useClaudeAgentSdkSettings("assistant-1", true),
    { wrapper: Wrapper },
  );
  await waitFor(() => expect(result.current.canSave).toBe(true));
  expect(result.current.executablePath).toBe("/opt/claude");
  await result.current.savePath();
  expect(writes).toEqual([]);
});

test("saves only the edited executable path and clears it with null", async () => {
  const { result } = renderHook(
    () => useClaudeAgentSdkSettings("assistant-1", true),
    { wrapper: Wrapper },
  );
  await waitFor(() => expect(result.current.canSave).toBe(true));
  act(() => result.current.onExecutablePathChange("  /usr/local/bin/claude  "));
  await result.current.savePath();
  expect(writes[0]).toEqual({
    path: { assistant_id: "assistant-1" },
    body: {
      llm: { claudeAgentSdk: { executablePath: "/usr/local/bin/claude" } },
    },
  });
  act(() => result.current.onExecutablePathChange(""));
  await result.current.savePath();
  expect(writes[1]).toEqual({
    path: { assistant_id: "assistant-1" },
    body: { llm: { claudeAgentSdk: { executablePath: null } } },
  });
});

test("relative paths block saving with actionable copy", async () => {
  const { result } = renderHook(
    () => useClaudeAgentSdkSettings("assistant-1", true),
    { wrapper: Wrapper },
  );
  await waitFor(() => expect(result.current.canSave).toBe(true));
  act(() => result.current.onExecutablePathChange("./claude"));
  expect(result.current.canSave).toBe(false);
  await expect(result.current.savePath()).rejects.toThrow(
    "absolute executable path",
  );
  expect(writes).toEqual([]);
});

test("older assistants cannot save unsupported settings", async () => {
  supported = false;
  const { result } = renderHook(
    () => useClaudeAgentSdkSettings("assistant-1", true),
    { wrapper: Wrapper },
  );
  await waitFor(() =>
    expect(result.current.error).toBe(
      "Update this assistant to use Claude subscription.",
    ),
  );
  await expect(result.current.savePath()).rejects.toThrow(
    "Update this assistant",
  );
  expect(configReads).toBe(0);
  expect(writes).toEqual([]);
});

test("failed capability checks can retry without leaving settings", async () => {
  supportFails = true;
  const { result } = renderHook(
    () => useClaudeAgentSdkSettings("assistant-1", true),
    { wrapper: Wrapper },
  );
  await waitFor(() => expect(result.current.onRetry).toBeDefined());
  expect(result.current.canSave).toBe(false);
  supportFails = false;
  act(() => result.current.onRetry?.());
  await waitFor(() => expect(result.current.canSave).toBe(true));
});

test("a failed config load blocks saving and can retry", async () => {
  configFails = true;
  const { result } = renderHook(
    () => useClaudeAgentSdkSettings("assistant-1", true),
    { wrapper: Wrapper },
  );
  await waitFor(() => expect(result.current.error).toContain("Could not load"));
  expect(result.current.canSave).toBe(false);
  configFails = false;
  act(() => result.current.onRetry?.());
  await waitFor(() => expect(result.current.canSave).toBe(true));
});

test("failed path writes remain retryable and retain the draft", async () => {
  const { result } = renderHook(
    () => useClaudeAgentSdkSettings("assistant-1", true),
    { wrapper: Wrapper },
  );
  await waitFor(() => expect(result.current.canSave).toBe(true));
  act(() => result.current.onExecutablePathChange("/new/claude"));
  saveFails = true;
  await expect(result.current.savePath()).rejects.toThrow(
    "provider has not been saved",
  );
  expect(result.current.executablePath).toBe("/new/claude");
  saveFails = false;
  await result.current.savePath();
  expect(writes).toHaveLength(2);
});

test("server refreshes preserve dirty edits and assistant switches discard them", async () => {
  const { result, rerender } = renderHook(
    ({ assistantId }) => useClaudeAgentSdkSettings(assistantId, true),
    { wrapper: Wrapper, initialProps: { assistantId: "assistant-1" } },
  );
  await waitFor(() => expect(result.current.canSave).toBe(true));
  act(() => result.current.onExecutablePathChange("/draft/claude"));
  act(() =>
    queryClient.setQueryData(["config", "assistant-1"], {
      llm: { claudeAgentSdk: { executablePath: "/remote/claude" } },
    }),
  );
  expect(result.current.executablePath).toBe("/draft/claude");
  rerender({ assistantId: "assistant-2" });
  await waitFor(() => expect(result.current.canSave).toBe(true));
  expect(result.current.executablePath).toBe("/opt/claude");
});

test("switching to an API provider neither saves nor validates the subscription draft", async () => {
  const { result, rerender } = renderHook(
    ({ enabled }) => useClaudeAgentSdkSettings("assistant-1", enabled),
    { wrapper: Wrapper, initialProps: { enabled: true } },
  );
  await waitFor(() => expect(result.current.canSave).toBe(true));
  act(() => result.current.onExecutablePathChange("./claude"));
  expect(result.current.canSave).toBe(false);
  rerender({ enabled: false });
  expect(result.current.canSave).toBe(true);
  await result.current.savePath();
  expect(writes).toEqual([]);
});
