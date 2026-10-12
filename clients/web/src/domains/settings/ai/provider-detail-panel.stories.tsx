import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactElement } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@vellumai/design-library/components/button";

import {
  configGetQueryKey,
  inferenceProviderconnectionsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { ProviderConnection } from "@/generated/daemon/types.gen";
import { useTranslation } from "@/i18n";
import { createStoryQueryClient } from "@/lib/story-query-cache";

import { ProviderDetailPanel } from "./provider-detail-panel";

const ASSISTANT_ID = "story-assistant";

// Casts mirror `profile-detail-panel.test.tsx`'s fixture: `auth`/`models`
// carry unions the story doesn't need to fully enumerate.
const CONNECTIONS: ProviderConnection[] = [
  {
    name: "claude-agent-sdk-personal",
    label: "Claude subscription",
    provider: "claude-agent-sdk",
    auth: { type: "none" },
    models: null,
    baseUrl: null,
    createdAt: 0,
    updatedAt: 0,
    isManaged: false,
  },
  {
    name: "anthropic-personal",
    label: null,
    provider: "anthropic",
    auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    models: null,
  } as unknown as ProviderConnection,
  {
    name: "openai-work",
    label: "My OpenAI",
    provider: "openai",
    auth: { type: "api_key", credential: "credential/openai/api_key" },
    models: null,
  } as unknown as ProviderConnection,
];

function seededClient() {
  return createStoryQueryClient((client) => {
    client.setQueryData(
      ["assistant-capability", "claudeAgentSdk", ASSISTANT_ID],
      true,
    );
    client.setQueryData(
      configGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
      {
        llm: { claudeAgentSdk: { executablePath: null } },
      },
    );
    client.setQueryData(
      inferenceProviderconnectionsGetQueryKey({
        path: { assistant_id: ASSISTANT_ID },
      }),
      { connections: CONNECTIONS },
    );
  });
}

function withClient(client: QueryClient) {
  return function Decorator(Story: () => ReactElement) {
    return (
      <QueryClientProvider client={client}>
        <div className="h-[640px] w-[420px]">
          <Story />
        </div>
      </QueryClientProvider>
    );
  };
}

const meta: Meta<typeof ProviderDetailPanel> = {
  title: "Settings/AI/ProviderDetailPanel",
  component: ProviderDetailPanel,
  parameters: { layout: "centered" },
  args: {
    assistantId: ASSISTANT_ID,
    onClose: () => {},
  },
  decorators: [withClient(seededClient())],
};

export default meta;
type Story = StoryObj<typeof ProviderDetailPanel>;

/** The add-provider flow: `connectionName: null` runs `ProviderCreateForm`. */
export const AddProvider: Story = {
  args: { connectionName: null },
};

/** Editing an existing connection's stored key and display fields. */
export const EditProvider: Story = {
  args: { connectionName: "anthropic-personal" },
};

export const ClaudeSubscription: Story = {
  args: { connectionName: "claude-agent-sdk-personal" },
  render: function ClaudeSubscriptionStory(args) {
    const [open, setOpen] = useState(true);
    const { t } = useTranslation("settings");
    return open ? (
      <ProviderDetailPanel {...args} onClose={() => setOpen(false)} />
    ) : (
      <Button variant="outlined" onClick={() => setOpen(true)}>
        {t("providerEditorContent.editProviderTitle")}
      </Button>
    );
  },
};
