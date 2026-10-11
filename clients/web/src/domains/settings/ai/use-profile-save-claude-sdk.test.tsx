import { afterEach, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { configGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import * as sdkGen from "@/generated/daemon/sdk.gen";

let probes = 0;
const writes: unknown[] = [];
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  inferenceProfilesByNameValidatePost: async () => {
    probes += 1;
    return { data: { check: { ok: true } } };
  },
}));
mock.module("@/domains/settings/ai/use-llm-config-patch", () => ({
  useLlmConfigPatch: () => ({
    isPending: false,
    mutateAsync: async (value: unknown) => {
      writes.push(value);
    },
  }),
}));
const { useProfileSave } = await import("./use-profile-save");

afterEach(cleanup);

test("saving a subscription profile never runs a model probe, while API profiles retain validation", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    configGetQueryKey({ path: { assistant_id: "assistant-1" } }),
    { llm: { profiles: {}, profileOrder: [] } },
  );
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }
  const { result } = renderHook(() => useProfileSave("assistant-1"), {
    wrapper: Wrapper,
  });
  await result.current.saveProfile("claude-subscription", {
    provider: "claude-agent-sdk",
    model: "sonnet",
  });
  expect(probes).toBe(0);
  await result.current.saveProfile("claude-api", {
    provider: "anthropic",
    model: "claude-sonnet-4.6",
  });
  expect(probes).toBe(1);
  expect(writes).toHaveLength(2);
  queryClient.clear();
});
