import { Button } from "@vellumai/design-library/components/button";
import { Typography } from "@vellumai/design-library/components/typography";

import { useTranslation } from "@/i18n";

import { findClaudeModel } from "./claude-model-options";
import type { ClaudeModelDiscovery } from "./use-claude-models";

interface ClaudeModelDiscoveryStatusProps {
  discovery: ClaudeModelDiscovery;
  selectedModel?: string;
}

export function ClaudeModelDiscoveryStatus({
  discovery,
  selectedModel,
}: ClaudeModelDiscoveryStatusProps) {
  const { t, i18n } = useTranslation("settings");
  if (discovery.status === "disabled") {
    return null;
  }
  const missingSelection =
    selectedModel &&
    discovery.fetchedAt &&
    !findClaudeModel(discovery.models, selectedModel);
  const updatedAt = discovery.fetchedAt ? new Date(discovery.fetchedAt) : null;
  const message =
    discovery.error ??
    (discovery.status === "unsupported"
      ? t("claudeModelDiscovery.updateRequired")
      : discovery.status === "loading"
        ? t("claudeModelDiscovery.loading")
        : discovery.isStale
          ? t("claudeModelDiscovery.stale")
          : discovery.models.length === 0
            ? t("claudeModelDiscovery.empty")
            : t("claudeModelDiscovery.ready"));
  return (
    <div className="space-y-1">
      <Typography variant="body-small-default" as="p" role="status">
        {message}
      </Typography>
      {discovery.error && discovery.fetchedAt ? (
        <Typography variant="body-small-default" as="p">
          {t("claudeModelDiscovery.stale")}
        </Typography>
      ) : null}
      {updatedAt && Number.isFinite(updatedAt.getTime()) ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--content-tertiary)]"
        >
          {t("claudeModelDiscovery.updatedAt", {
            time: updatedAt.toLocaleString(i18n.language),
          })}
        </Typography>
      ) : null}
      {missingSelection ? (
        <Typography variant="body-small-default" as="p">
          {t("claudeModelDiscovery.selectionUnavailable", {
            model: selectedModel,
          })}
        </Typography>
      ) : null}
      <Button
        variant="link"
        size="compact"
        loading={discovery.isRefreshing}
        onClick={() => void discovery.refresh()}
      >
        {t(
          discovery.status === "error"
            ? "claudeModelDiscovery.retry"
            : "claudeModelDiscovery.refresh",
        )}
      </Button>
    </div>
  );
}
