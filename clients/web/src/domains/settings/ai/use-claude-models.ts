import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";

import { inferenceModelsDiscoverPost } from "@/generated/daemon/sdk.gen";
import { assistantCapabilityOptions } from "@/hooks/use-assistant-capability";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useTranslation } from "@/i18n";
import { ApiError, badRequestMessage } from "@/utils/api-errors";

import { type ClaudeDiscoveredModel } from "./claude-model-options";

export const claudeModelsQueryKey = (assistantId: string) =>
  ["claude-agent-sdk-models", assistantId] as const;

/** Discovery starts a local process, so the cached read uses a POST. */
export function claudeModelsOptions(assistantId: string, refresh = false) {
  return queryOptions({
    queryKey: claudeModelsQueryKey(assistantId),
    queryFn: async ({ signal }) => {
      const { data } = await inferenceModelsDiscoverPost({
        path: { assistant_id: assistantId },
        body: { provider: "claude-agent-sdk", refresh },
        signal,
        throwOnError: true,
      });
      return data;
    },
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export interface ClaudeModelDiscovery {
  models: readonly ClaudeDiscoveredModel[];
  status: "disabled" | "loading" | "unsupported" | "error" | "ready";
  isRefreshing: boolean;
  isStale: boolean;
  fetchedAt: string | undefined;
  error: string | null;
  refresh: () => Promise<void>;
}

const NO_MODELS: readonly ClaudeDiscoveredModel[] = [];

export function useClaudeModels(
  assistantId: string,
  enabled: boolean,
): ClaudeModelDiscovery {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const isOrgReady = useIsOrgReady();
  const support = useQuery({
    ...assistantCapabilityOptions("claudeAgentSdkModelDiscovery", assistantId),
    enabled: enabled && isOrgReady,
  });
  const query = useQuery({
    ...claudeModelsOptions(assistantId),
    enabled: enabled && isOrgReady && support.data === true && !support.isError,
  });
  const status = !enabled
    ? "disabled"
    : support.isPending
      ? "loading"
      : support.isError
        ? "error"
        : support.data !== true
          ? "unsupported"
          : query.isError
            ? "error"
            : query.isPending
              ? "loading"
              : "ready";
  const error =
    status !== "error"
      ? null
      : support.isError
        ? t("claudeModelDiscovery.supportFailed")
        : ((query.error instanceof ApiError && query.error.status === 424
            ? query.error.message
            : badRequestMessage(query.error)) ??
          t("claudeModelDiscovery.loadFailed"));

  async function refresh() {
    if (!enabled || !isOrgReady) {
      return;
    }
    if (support.data !== true || support.isError) {
      const result = await support.refetch();
      if (result.data !== true || result.isError) {
        return;
      }
    }
    const options = claudeModelsOptions(assistantId, true);
    // A slow older request must not overwrite the explicitly refreshed list.
    await queryClient.cancelQueries({
      queryKey: options.queryKey,
      exact: true,
    });
    try {
      await queryClient.fetchQuery({ ...options, staleTime: 0 });
    } catch {
      // The query owns the error and retains its last successful result.
    }
  }

  return {
    models: query.data?.models ?? NO_MODELS,
    status,
    isRefreshing: query.isFetching || support.isFetching,
    isStale: query.data !== undefined && (query.isStale || status === "error"),
    fetchedAt: query.data?.fetchedAt,
    error,
    refresh,
  };
}
