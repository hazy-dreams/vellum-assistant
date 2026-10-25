import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { client } from "@/generated/daemon/client.gen";
import type { InferenceModelsDiscoverPostResponse } from "@/generated/daemon/types.gen";
import type * as CapabilityHooks from "@/hooks/use-assistant-capability";
import type * as OrgHooks from "@/hooks/use-is-org-ready";
import { ApiError } from "@/utils/api-errors";

let supported = true;
let orgReady = true;
mock.module(
  "@/hooks/use-is-org-ready",
  (): Partial<typeof OrgHooks> => ({ useIsOrgReady: () => orgReady }),
);
mock.module(
  "@/hooks/use-assistant-capability",
  (): Partial<typeof CapabilityHooks> => ({
    assistantCapabilityOptions: (capability, assistantId) =>
      queryOptions({
        queryKey: ["assistant-capability", capability, assistantId],
        queryFn: async () => supported,
        retry: false,
      }),
  }),
);

const { useClaudeModels } = await import("./use-claude-models");
const post = spyOn(client, "post");
let queryClient: QueryClient;
const clients: QueryClient[] = [];
const discovered = (id: string): InferenceModelsDiscoverPostResponse => ({
  models: [
    {
      provider: "claude-agent-sdk",
      id,
      displayName: id,
      description: "",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
    },
  ],
  fetchedAt: "2026-01-01T00:00:00Z",
});
function response(data: InferenceModelsDiscoverPostResponse) {
  return {
    data,
    request: new Request("https://example.com/discover"),
    response: Response.json(data),
  };
}
function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
beforeEach(() => {
  supported = true;
  orgReady = true;
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(queryClient);
  post.mockClear();
  post.mockResolvedValue(response(discovered("claude-future")));
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

test("shares one discovered list between consumers without a generation call", async () => {
  const { result } = renderHook(
    () => ({
      first: useClaudeModels("assistant-1", true),
      second: useClaudeModels("assistant-1", true),
    }),
    { wrapper: Wrapper },
  );
  await waitFor(() => expect(result.current.first.status).toBe("ready"));
  expect(result.current.second.models).toEqual(result.current.first.models);
  expect(result.current.first.models[0]?.id).toBe("claude-future");
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0]?.[0]).toMatchObject({
    url: "/v1/assistants/{assistant_id}/inference/models/discover",
    body: { provider: "claude-agent-sdk", refresh: false },
  });
});

test("disabled ordinary providers and old assistants never start discovery", async () => {
  const disabled = renderHook(() => useClaudeModels("assistant-1", false), {
    wrapper: Wrapper,
  });
  expect(disabled.result.current.status).toBe("disabled");
  await disabled.result.current.refresh();
  expect(post).not.toHaveBeenCalled();
  supported = false;
  const unsupported = renderHook(() => useClaudeModels("assistant-2", true), {
    wrapper: Wrapper,
  });
  await waitFor(() =>
    expect(unsupported.result.current.status).toBe("unsupported"),
  );
  expect(post).not.toHaveBeenCalled();
});

test("waits for organization readiness", () => {
  orgReady = false;
  renderHook(() => useClaudeModels("assistant-1", true), { wrapper: Wrapper });
  expect(post).not.toHaveBeenCalled();
});

test("shows the local sign-in error without automatic retries and recovers on explicit retry", async () => {
  post.mockRejectedValue(
    new ApiError(424, "Sign in to Claude Code on the assistant computer."),
  );
  const { result } = renderHook(() => useClaudeModels("assistant-1", true), {
    wrapper: Wrapper,
  });
  await waitFor(() => expect(result.current.status).toBe("error"));
  expect(result.current.error).toBe(
    "Sign in to Claude Code on the assistant computer.",
  );
  expect(result.current.models).toEqual([]);
  expect(post).toHaveBeenCalledTimes(1);
  post.mockResolvedValue(response(discovered("new-model")));
  await act(() => result.current.refresh());
  await waitFor(() => expect(result.current.status).toBe("ready"));
  expect(result.current.error).toBeNull();
  expect(result.current.models[0]?.id).toBe("new-model");
  expect(post.mock.calls[1]?.[0]).toMatchObject({ body: { refresh: true } });
});

test("a failed refresh retains the last list and marks it stale", async () => {
  const { result } = renderHook(() => useClaudeModels("assistant-1", true), {
    wrapper: Wrapper,
  });
  await waitFor(() => expect(result.current.status).toBe("ready"));
  post.mockRejectedValue(new Error("offline"));
  await act(() => result.current.refresh());
  await waitFor(() => expect(result.current.status).toBe("error"));
  expect(result.current.models[0]?.id).toBe("claude-future");
  expect(result.current.isStale).toBe(true);
  expect(result.current.error).toContain("Could not discover Claude models");
});

test("explicit refresh wins over an older in-flight response", async () => {
  let finishOld: ((value: ReturnType<typeof response>) => void) | undefined;
  const olderResponse = new Promise<ReturnType<typeof response>>((resolve) => {
    finishOld = resolve;
  });
  post.mockReturnValueOnce(olderResponse);
  const { result } = renderHook(() => useClaudeModels("assistant-1", true), {
    wrapper: Wrapper,
  });
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  post.mockResolvedValue(response(discovered("new-model")));
  await act(() => result.current.refresh());
  await waitFor(() => expect(result.current.models[0]?.id).toBe("new-model"));
  await act(async () => {
    finishOld?.(response(discovered("old-model")));
    await Promise.resolve();
  });
  expect(result.current.models[0]?.id).toBe("new-model");
});

test("switching assistants does not reuse the previous assistant's choices", async () => {
  const { result, rerender } = renderHook(
    ({ assistantId }) => useClaudeModels(assistantId, true),
    { initialProps: { assistantId: "assistant-1" }, wrapper: Wrapper },
  );
  await waitFor(() => expect(result.current.status).toBe("ready"));
  post.mockRejectedValue(new Error("offline"));
  rerender({ assistantId: "assistant-2" });
  await waitFor(() => expect(result.current.status).toBe("error"));
  expect(result.current.models).toEqual([]);
});
