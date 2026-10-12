import { useId } from "react";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";
import { Typography } from "@vellumai/design-library/components/typography";

import { useTranslation } from "@/i18n";

export function isClaudeExecutablePathValid(value: string): boolean {
  const path = value.trim();
  return (
    path.length === 0 ||
    (!Array.from(path).some((character) => character.charCodeAt(0) < 32) &&
      (/^\//.test(path) ||
        /^[a-z]:[\\/]/i.test(path) ||
        /^\\\\[^\\]+\\[^\\]+/.test(path)))
  );
}

interface ClaudeAgentSdkSettingsProps {
  executablePath: string;
  onExecutablePathChange: (value: string) => void;
  error: string | null;
  disabled?: boolean;
  onRetry?: () => void;
}

export function ClaudeAgentSdkSettings({
  executablePath,
  onExecutablePathChange,
  error,
  disabled = false,
  onRetry,
}: ClaudeAgentSdkSettingsProps) {
  const { t } = useTranslation("settings");
  const id = useId();
  return (
    <div className="space-y-4">
      <Notice tone="info">{t("claudeAgentSdkSettings.description")}</Notice>
      <Typography
        variant="body-small-default"
        as="p"
        className="text-[var(--content-tertiary)]"
      >
        {t("claudeAgentSdkSettings.billing")}
      </Typography>
      <div className="space-y-1">
        <label
          htmlFor={id}
          className="block text-body-small-default text-[var(--content-tertiary)]"
        >
          {t("claudeAgentSdkSettings.pathLabel")}
        </label>
        <Input
          id={id}
          value={executablePath}
          onChange={(event) => onExecutablePathChange(event.target.value)}
          placeholder={t("claudeAgentSdkSettings.pathPlaceholder")}
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
          aria-invalid={error && !disabled ? true : undefined}
          disabled={disabled}
          autoComplete="off"
          fullWidth
        />
        <Typography
          id={`${id}-hint`}
          variant="body-small-default"
          as="p"
          className="text-[var(--content-tertiary)]"
        >
          {t("claudeAgentSdkSettings.pathHint")}
        </Typography>
        {error && (
          <Typography
            id={`${id}-error`}
            role={disabled ? "status" : "alert"}
            variant="body-small-default"
            as="p"
            className={
              disabled
                ? "text-[var(--content-tertiary)]"
                : "text-(--system-negative-strong)"
            }
          >
            {error}
          </Typography>
        )}
      </div>
      {onRetry && (
        <Button variant="outlined" onClick={onRetry}>
          {t("claudeAgentSdkSettings.retry")}
        </Button>
      )}
    </div>
  );
}
