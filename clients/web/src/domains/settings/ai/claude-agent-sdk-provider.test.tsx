import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";

import * as sdkGen from "@/generated/daemon/sdk.gen";
import { configGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { ProviderConnection } from "@/generated/daemon/types.gen";

const ASSISTANT_ID = "assistant-1";
const connection: ProviderConnection = {
  name: "claude-agent-sdk-personal",
  label: "Claude subscription",
  provider: "claude-agent-sdk",
  auth: { type: "none" },
  models: null,
  baseUrl: null,
  createdAt: 0,
  updatedAt: 0,
  isManaged: false,
};
let writes: Array<{ kind: string; body: unknown }> = [];
let secretsCalls = 0;
let createFails = false;
let saveFails = false;
let finished = false;
let cancelled = false;
let queryClient: QueryClient;

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "full",
  useActiveAssistantIsSelfHosted: () => true,
}));
mock.module("@/hooks/use-is-org-ready", () => ({ useIsOrgReady: () => true }));
mock.module("@/domains/settings/ai/use-stored-credential-presence", () => ({
  credentialPresenceQueryKey: () => ["credential-presence"],
  useStoredCredentialPresence: () => ({
    hasStoredCredential: false,
    isLoading: false,
  }),
}));
mock.module("@/domains/settings/ai/use-provider-credentials-list", () => ({
  useProviderCredentialsList: () => ({ credentials: [], isLoading: false }),
}));
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  secretsPost: async () => {
    secretsCalls += 1;
  },
  configPatch: async ({ body }: { body: unknown }) => {
    writes.push({ kind: "path", body });
    if (saveFails) {
      throw new Error("offline");
    }
    return {
      data: { llm: { claudeAgentSdk: { executablePath: "/new/claude" } } },
      response: { ok: true },
    };
  },
  inferenceProviderconnectionsPost: async ({ body }: { body: unknown }) => {
    writes.push({ kind: "create", body });
    return createFails
      ? {
          response: { ok: false, status: 400 },
          error: {
            error: {
              message: "Claude Code is not installed on this computer.",
            },
          },
        }
      : { response: { ok: true }, data: connection };
  },
  inferenceProviderconnectionsByNamePatch: async ({
    body,
  }: {
    body: unknown;
  }) => {
    writes.push({ kind: "edit", body });
    return { response: { ok: true }, data: connection };
  },
}));

const { ProviderCreateForm } = await import("./provider-create-form");
const { ProviderEditorContent } = await import("./provider-editor-content");

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
function renderCreate() {
  return render(
    <ProviderCreateForm
      variant="inline"
      assistantId={ASSISTANT_ID}
      defaultProviderType="claude-agent-sdk"
      existingNames={[]}
      onCreated={() => {
        finished = true;
      }}
      onCancel={() => {
        cancelled = true;
      }}
    />,
    { wrapper: Wrapper },
  );
}

beforeEach(() => {
  writes = [];
  secretsCalls = 0;
  createFails = false;
  saveFails = false;
  finished = false;
  cancelled = false;
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(
    ["assistant-capability", "claudeAgentSdk", ASSISTANT_ID],
    true,
  );
  queryClient.setQueryData(
    configGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
    { llm: { claudeAgentSdk: { executablePath: null } } },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

test("creates a separate keyless subscription connection without credentials or login", async () => {
  renderCreate();
  expect(
    screen.getByRole("combobox", { name: "Provider" }).textContent,
  ).toContain("Claude subscription");
  expect(screen.queryByPlaceholderText("sk-ant-...")).toBeNull();
  expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(finished).toBe(true));
  expect(writes).toEqual([
    {
      kind: "create",
      body: {
        name: "claude-agent-sdk-personal",
        label: "Claude subscription",
        provider: "claude-agent-sdk",
        auth: { type: "none" },
      },
    },
  ]);
  expect(secretsCalls).toBe(0);
});

test("saves the executable path before creating the provider", async () => {
  renderCreate();
  fireEvent.change(
    screen.getByLabelText("Claude Code executable path (optional)"),
    { target: { value: "/new/claude" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(finished).toBe(true));
  expect(writes.map((write) => write.kind)).toEqual(["path", "create"]);
  expect(writes[0].body).toEqual({
    llm: { claudeAgentSdk: { executablePath: "/new/claude" } },
  });
});

test("does not create a connection after a path write fails", async () => {
  saveFails = true;
  renderCreate();
  fireEvent.change(
    screen.getByLabelText("Claude Code executable path (optional)"),
    { target: { value: "/new/claude" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() =>
    expect(
      screen.getByText(/Could not save the Claude Code path/),
    ).toBeTruthy(),
  );
  expect(writes.map((write) => write.kind)).toEqual(["path"]);
  expect(finished).toBe(false);
});

test("surfaces actionable provider setup errors without switching to Anthropic", async () => {
  createFails = true;
  renderCreate();
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() =>
    expect(
      screen.getByText("Claude Code is not installed on this computer."),
    ).toBeTruthy(),
  );
  expect(writes).toHaveLength(1);
  expect(secretsCalls).toBe(0);
  expect(finished).toBe(false);
});

test("invalid paths block save and cancelling never writes", () => {
  renderCreate();
  fireEvent.change(
    screen.getByLabelText("Claude Code executable path (optional)"),
    { target: { value: "./claude" } },
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Add",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(cancelled).toBe(true);
  expect(writes).toEqual([]);
});

test("clearing a saved path restores automatic discovery when saving", async () => {
  queryClient.setQueryData(
    configGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
    { llm: { claudeAgentSdk: { executablePath: "/saved/claude" } } },
  );
  renderCreate();
  fireEvent.change(
    screen.getByLabelText("Claude Code executable path (optional)"),
    { target: { value: "" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(finished).toBe(true));
  expect(writes[0]).toEqual({
    kind: "path",
    body: { llm: { claudeAgentSdk: { executablePath: null } } },
  });
});

test("cancel and reopen discard unsaved paths without writing configuration", () => {
  queryClient.setQueryData(
    configGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
    { llm: { claudeAgentSdk: { executablePath: "/saved/claude" } } },
  );
  const first = renderCreate();
  fireEvent.change(
    screen.getByLabelText("Claude Code executable path (optional)"),
    { target: { value: "/unsaved/claude" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(cancelled).toBe(true);
  first.unmount();

  renderCreate();
  expect(screen.getByDisplayValue("/saved/claude")).toBeTruthy();
  expect(screen.queryByDisplayValue("/unsaved/claude")).toBeNull();
  expect(writes).toEqual([]);
});

test("edit keeps subscription auth and the native provider save flow", async () => {
  render(
    <ProviderEditorContent
      mode="edit"
      variant="panel"
      connection={connection}
      assistantId={ASSISTANT_ID}
      existingNames={[connection.name]}
      onSave={() => {
        finished = true;
      }}
      onCancel={() => {}}
    />,
    { wrapper: Wrapper },
  );
  expect(
    screen.getByLabelText("Claude Code executable path (optional)"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(finished).toBe(true));
  expect(writes).toEqual([
    {
      kind: "edit",
      body: { auth: { type: "none" }, label: "Claude subscription" },
    },
  ]);
  expect(secretsCalls).toBe(0);
});
