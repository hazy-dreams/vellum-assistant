import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { isClaudeExecutablePathValid } from "@/domains/settings/ai/claude-agent-sdk-settings";
import { useLlmConfigPatch } from "@/domains/settings/ai/use-llm-config-patch";
import {
  configGetOptions,
  configLlmDefaultproviderGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { assistantCapabilityOptions } from "@/hooks/use-assistant-capability";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useTranslation } from "@/i18n";
import { badRequestMessage } from "@/utils/api-errors";

export function useClaudeAgentSdkSettings(
  assistantId: string,
  enabled: boolean,
) {
  const { t } = useTranslation("settings");
  const isOrgReady = useIsOrgReady();
  const queryClient = useQueryClient();
  const configMutation = useLlmConfigPatch();
  const support = useQuery({
    ...assistantCapabilityOptions("claudeAgentSdk", assistantId),
    enabled: enabled && isOrgReady,
  });
  const config = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: enabled && isOrgReady && support.data === true,
    staleTime: 30_000,
  });
  const [draft, setDraft] = useState<{
    assistantId: string;
    value: string;
  } | null>(null);
  const savedPath = config.data?.llm?.claudeAgentSdk?.executablePath ?? "";
  const executablePath =
    draft?.assistantId === assistantId ? draft.value : savedPath;
  const isLoading =
    enabled &&
    (support.isPending || (support.data === true && config.isPending));
  const error = !enabled
    ? null
    : isLoading
      ? t("claudeAgentSdkSettings.checkingSupport")
      : support.data !== true
        ? t(
            support.isError
              ? "claudeAgentSdkSettings.supportUnavailable"
              : "claudeAgentSdkSettings.updateRequired",
          )
        : config.isError
          ? t("claudeAgentSdkSettings.loadFailed")
          : !isClaudeExecutablePathValid(executablePath)
            ? t("claudeAgentSdkSettings.pathInvalid")
            : null;

  async function savePath(): Promise<void> {
    if (!enabled) {
      return;
    }
    if (error) {
      throw new Error(error);
    }
    if (executablePath.trim() === savedPath) {
      return;
    }
    try {
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: {
          llm: {
            claudeAgentSdk: { executablePath: executablePath.trim() || null },
          },
        },
      });
      void queryClient.invalidateQueries({
        queryKey: configLlmDefaultproviderGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      });
    } catch (cause) {
      throw new Error(
        badRequestMessage(cause) ?? t("claudeAgentSdkSettings.saveFailed"),
        { cause },
      );
    }
  }

  return {
    executablePath,
    onExecutablePathChange: (value: string) => setDraft({ assistantId, value }),
    error,
    isLoading,
    canSave: !enabled || error === null,
    savePath,
    onRetry:
      support.isError || config.isError
        ? () => {
            void support.refetch();
            if (support.data === true) {
              void config.refetch();
            }
          }
        : undefined,
  };
}
