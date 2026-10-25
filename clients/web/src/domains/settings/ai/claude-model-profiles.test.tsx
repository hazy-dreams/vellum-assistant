import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
} from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { client } from "@/generated/daemon/client.gen";
import type {
  InferenceModelsDiscoverPostResponse,
  ProviderConnection,
} from "@/generated/daemon/types.gen";
import type * as CapabilityHooks from "@/hooks/use-assistant-capability";
import type * as OrgHooks from "@/hooks/use-is-org-ready";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { ApiError } from "@/utils/api-errors";

import type { ProfileWithName } from "./utils";
import type { UseProfileEditorArgs } from "./use-profile-editor";

mock.module(
  "@/hooks/use-is-org-ready",
  (): Partial<typeof OrgHooks> => ({ useIsOrgReady: () => true }),
);
mock.module(
  "@/hooks/use-assistant-capability",
  (): Partial<typeof CapabilityHooks> => ({
    assistantCapabilityOptions: (capability, assistantId) =>
      queryOptions({
        queryKey: ["assistant-capability", capability, assistantId],
        queryFn: async () => true,
        retry: false,
      }),
  }),
);
const { useProfileEditor } = await import("./use-profile-editor");
const { ProfileEditorFields } = await import("./profile-editor-fields");

const CONNECTION: ProviderConnection = {
  name: "claude-agent-sdk",
  provider: "claude-agent-sdk",
  auth: { type: "none" },
  label: null,
  baseUrl: null,
  models: null,
  createdAt: 0,
  updatedAt: 0,
  isManaged: false,
};
const initialLifecycle = useAssistantLifecycleStore.getState();
const post = spyOn(client, "post");
const saved = mock<UseProfileEditorArgs["onSave"]>(async () => {});
let queryClient: QueryClient;
const model = {
  provider: "claude-agent-sdk" as const,
  id: "claude-future",
  displayName: "Future Claude",
  description: "New SDK model",
  supportsEffort: true,
  supportedEffortLevels: ["low", "high"] as ("low" | "high")[],
};
function response(models: InferenceModelsDiscoverPostResponse["models"]) {
  const data = { models, fetchedAt: "2026-01-01T00:00:00Z" };
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
function Editor({
  initialValues,
  connections = [CONNECTION],
}: {
  initialValues?: ProfileWithName;
  connections?: ProviderConnection[];
}) {
  const editor = useProfileEditor({
    assistantId: "assistant-1",
    mode: initialValues ? "edit" : "create",
    profileName: initialValues?.name,
    initialValues,
    existingNames: [],
    connections,
    onSave: saved,
  });
  return (
    <>
      <ProfileEditorFields
        assistantId="assistant-1"
        editor={editor}
        connections={connections}
        variant="panel"
      />
      <button
        onClick={() => void editor.handleSave()}
        disabled={editor.isInvalid}
      >
        Save profile
      </button>
    </>
  );
}
function modelField() {
  return screen.getByLabelText<HTMLInputElement>("Model");
}
async function selectDiscoveredModel() {
  await waitFor(() =>
    expect(
      screen.getByText("Models discovered from local Claude Code."),
    ).toBeTruthy(),
  );
  fireEvent.focus(modelField());
  fireEvent.click(screen.getByRole("option", { name: "Future Claude" }));
  await waitFor(() => expect(modelField().value).toBe("Future Claude"));
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  useAssistantLifecycleStore.setState({
    assistantState: { kind: "self_hosted" },
  });
  useClientFeatureFlagStore.setState({ modelFirstProfileCreate: true });
  useAssistantIdentityStore
    .getState()
    .setIdentity("Assistant", "0.10.11", "assistant-1");
  saved.mockClear();
  post.mockClear();
  post.mockResolvedValue(response([model]));
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  useAssistantIdentityStore.getState().clearIdentity();
  useAssistantLifecycleStore.setState(initialLifecycle);
  useClientFeatureFlagStore.setState({ modelFirstProfileCreate: false });
});

test("model-first selects a runtime-only model and uses the same discovered effort levels", async () => {
  render(<Editor />, { wrapper: Wrapper });
  await selectDiscoveredModel();
  expect(screen.getByRole("radio", { name: "low" })).toBeTruthy();
  expect(screen.getByRole("radio", { name: "high" })).toBeTruthy();
  expect(screen.queryByRole("radio", { name: "max" })).toBeNull();
  expect(screen.queryByRole("radio", { name: "none" })).toBeNull();
  expect(screen.queryByRole("slider")).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "high" }));
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(saved.mock.calls[0]?.[1]).toMatchObject({
    provider: "claude-agent-sdk",
    model: "claude-future",
    effort: "high",
  });
  expect(post).toHaveBeenCalledTimes(1);
});

test("model-first keeps the selected wire ID after refresh removes it", async () => {
  render(<Editor />, { wrapper: Wrapper });
  await selectDiscoveredModel();
  post.mockResolvedValue(response([]));
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh Claude models" }),
  );
  await waitFor(() =>
    expect(screen.getByText(/Your selection is preserved/)).toBeTruthy(),
  );
  expect(modelField().value).toBe("Future Claude");
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(saved.mock.calls[0]?.[1]).toMatchObject({
    provider: "claude-agent-sdk",
    model: "claude-future",
  });
});

test("model-first follows a refreshed display name without changing its saved ID", async () => {
  render(<Editor />, { wrapper: Wrapper });
  await selectDiscoveredModel();
  post.mockResolvedValue(
    response([{ ...model, displayName: "Renamed Claude" }]),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh Claude models" }),
  );
  await waitFor(() => expect(modelField().value).toBe("Renamed Claude"));
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(saved.mock.calls[0]?.[1]).toMatchObject({ model: "claude-future" });
});

test("an unavailable saved model and untouched effort survive editing after login failure", async () => {
  post.mockRejectedValue(new ApiError(424, "Sign in to local Claude Code."));
  render(
    <Editor
      initialValues={{
        name: "saved",
        label: "Saved",
        provider: "claude-agent-sdk",
        model: "retired-model",
        effort: "high",
      }}
    />,
    { wrapper: Wrapper },
  );
  await waitFor(() =>
    expect(screen.getByText("Sign in to local Claude Code.")).toBeTruthy(),
  );
  expect(modelField().value).toBe("retired-model");
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(saved.mock.calls[0]?.[1]).toMatchObject({
    provider: "claude-agent-sdk",
    model: "retired-model",
    effort: "high",
  });
});

test("model-first API-only users do not start Claude discovery", () => {
  render(<Editor connections={[]} />, { wrapper: Wrapper });
  expect(post).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Refresh Claude models" }),
  ).toBeNull();
});

for (const removed of [false, true]) {
  test(`model-first preserves identity when a ${removed ? "removed" : "renamed"} model's old label is reused`, async () => {
    render(<Editor />, { wrapper: Wrapper });
    await selectDiscoveredModel();
    post.mockResolvedValue(
      response([
        ...(removed ? [] : [{ ...model, displayName: "Renamed Claude" }]),
        { ...model, id: "different-claude" },
      ]),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh Claude models" }),
    );
    await waitFor(() =>
      expect(modelField().value).toBe(
        removed ? "claude-future" : "Renamed Claude",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(saved.mock.calls[0]?.[1]).toMatchObject({ model: "claude-future" });
    fireEvent.focus(modelField());
    fireEvent.change(modelField(), { target: { value: "Future Claude" } });
    fireEvent.click(screen.getByRole("option", { name: "Future Claude" }));
    await waitFor(() => expect(modelField().value).toBe("Future Claude"));
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
    expect(saved.mock.calls[1]?.[1]).toMatchObject({
      model: "different-claude",
    });
  });
}

test("a saved resolved SDK model keeps its ID and receives alias capabilities", async () => {
  post.mockResolvedValue(
    response([{ ...model, id: "sonnet", resolvedModel: "claude-pinned" }]),
  );
  render(
    <Editor
      initialValues={{
        name: "saved",
        label: "Saved",
        provider: "claude-agent-sdk",
        model: "claude-pinned",
      }}
    />,
    { wrapper: Wrapper },
  );
  await waitFor(() =>
    expect(screen.getByRole("radio", { name: "high" })).toBeTruthy(),
  );
  expect(screen.queryByText(/Your selection is preserved/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(saved.mock.calls[0]?.[1]).toMatchObject({ model: "claude-pinned" });
});

test("switching routes after a refreshed Claude label keeps the displayed model group", async () => {
  const anthropic: ProviderConnection = {
    ...CONNECTION,
    name: "anthropic",
    provider: "anthropic",
    auth: { type: "api_key", credential: "credential/anthropic/api_key" },
  };
  render(<Editor connections={[CONNECTION, anthropic]} />, {
    wrapper: Wrapper,
  });
  await selectDiscoveredModel();
  post.mockResolvedValue(
    response([{ ...model, displayName: "Claude Sonnet 4.6" }]),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh Claude models" }),
  );
  await waitFor(() => expect(modelField().value).toBe("Claude Sonnet 4.6"));
  fireEvent.click(screen.getByRole("radio", { name: /^Anthropic/ }));
  await waitFor(() => expect(modelField().value).toBe("Claude Sonnet 4.6"));
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(saved.mock.calls[0]?.[1]).toMatchObject({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
  });
});
