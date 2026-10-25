import * as childProcess from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { gte, valid } from "semver";
import { z } from "zod";

const AUTH_TIMEOUT_MS = 10_000;
const AUTH_MAX_OUTPUT_BYTES = 64 * 1024;
const MIN_CLAUDE_CODE_VERSION = "2.1.296";

const CONFLICTING_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_HELPER",
  "CLAUDE_CODE_API_BASE_URL",
  "CLAUDE_CODE_CUSTOM_OAUTH_URL",
  "CLAUDE_CODE_OAUTH_CLIENT_ID",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
]);

const PROVIDER_SELECTORS = new Set([
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
]);

const PASSTHROUGH_ENV = new Set([
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "MAX_STRUCTURED_OUTPUT_RETRIES",
  "ANTHROPIC_CONFIG_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

const AuthStatusSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string(),
  apiProvider: z.string(),
  subscriptionType: z.string().nullable().optional(),
});

const SUBSCRIPTIONS = new Set(["pro", "max", "team", "enterprise"]);

export type ClaudeSdkAuthResult =
  | { ok: true; executablePath: string; env: NodeJS.ProcessEnv }
  | {
      ok: false;
      reason:
        | "environment_conflict"
        | "invalid_executable"
        | "unsupported_version"
        | "auth_check_failed"
        | "invalid_auth_status"
        | "subscription_required"
        | "aborted";
      message: string;
    };

function runClaudeCommand(
  executablePath: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<{ error: childProcess.ExecFileException | null; stdout: string }> {
  return new Promise((resolve) => {
    childProcess.execFile(
      executablePath,
      args,
      {
        ...options,
        encoding: "utf8",
        timeout: AUTH_TIMEOUT_MS,
        maxBuffer: AUTH_MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout) => resolve({ error, stdout }),
    );
  });
}

/** Check the installed CLI's selected auth source without accessing credentials. */
export async function preflightClaudeSdkAuth(options: {
  executablePath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<ClaudeSdkAuthResult> {
  if (options.signal?.aborted) {
    return {
      ok: false,
      reason: "aborted",
      message: "Claude auth check cancelled.",
    };
  }

  const sourceEnv = options.env ?? process.env;
  const conflicts = Object.keys(sourceEnv).filter((key) => {
    const name = key.toUpperCase();
    const value = sourceEnv[key];
    return (
      value !== undefined &&
      value !== "" &&
      (CONFLICTING_ENV.has(name) ||
        (PROVIDER_SELECTORS.has(name) && !/^(0|false|no|off)$/i.test(value)))
    );
  });
  if (conflicts.length > 0) {
    return {
      ok: false,
      reason: "environment_conflict",
      message: `Claude subscription auth conflicts with these environment variables: ${conflicts.sort().join(", ")}. Review them before using the Claude Agent runtime.`,
    };
  }

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (PASSTHROUGH_ENV.has(key.toUpperCase()) && value !== undefined) {
      env[key] = value;
    }
  }

  let executablePath: string;
  try {
    if (!isAbsolute(options.executablePath)) {
      return {
        ok: false,
        reason: "invalid_executable",
        message:
          "Claude Agent requires an absolute path to your installed Claude Code executable.",
      };
    }
    executablePath = await realpath(options.executablePath);
    if (!(await stat(executablePath)).isFile()) {
      return {
        ok: false,
        reason: "invalid_executable",
        message: "The configured Claude Code executable is not a file.",
      };
    }
    await access(executablePath, constants.X_OK);
  } catch {
    return {
      ok: false,
      reason: "invalid_executable",
      message:
        "The installed Claude Code executable could not be found or executed. Check its configured path.",
    };
  }

  let result: {
    error: childProcess.ExecFileException | null;
    stdout: string;
  };
  const commandOptions = { cwd: options.cwd, env, signal: options.signal };
  try {
    result = await runClaudeCommand(
      executablePath,
      ["--version"],
      commandOptions,
    );
  } catch {
    return {
      ok: false,
      reason: "unsupported_version",
      message: `Could not verify the installed Claude Code version. Vellum's Claude Agent runtime requires version ${MIN_CLAUDE_CODE_VERSION} or later. Check that installation's --version command.`,
    };
  }
  if (options.signal?.aborted) {
    return {
      ok: false,
      reason: "aborted",
      message: "Claude auth check cancelled.",
    };
  }
  const version = /^(\d+\.\d+\.\d+)(?: \(Claude Code\))?$/.exec(
    result.stdout.trim(),
  )?.[1];
  if (
    result.error ||
    !version ||
    !valid(version) ||
    !gte(version, MIN_CLAUDE_CODE_VERSION)
  ) {
    return {
      ok: false,
      reason: "unsupported_version",
      message: `Vellum's Claude Agent runtime requires Claude Code ${MIN_CLAUDE_CODE_VERSION} or later, and could not confirm a compatible version. Check or update your installed Claude Code, then try again.`,
    };
  }

  try {
    result = await runClaudeCommand(
      executablePath,
      ["auth", "status"],
      commandOptions,
    );
  } catch {
    return {
      ok: false,
      reason: "auth_check_failed",
      message:
        "Claude Code auth status could not be started. Check the installed executable and its environment.",
    };
  }
  if (options.signal?.aborted) {
    return {
      ok: false,
      reason: "aborted",
      message: "Claude auth check cancelled.",
    };
  }
  if (result.error && result.error.code !== 1) {
    return {
      ok: false,
      reason: "auth_check_failed",
      message:
        "Claude Code auth status could not be checked. Run the installed Claude Code's auth status command to diagnose it.",
    };
  }

  let rawStatus: unknown;
  try {
    rawStatus = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      reason: "invalid_auth_status",
      message:
        "Claude Code returned unreadable auth status. Update your installed Claude Code and check its auth status command.",
    };
  }
  const parsed = AuthStatusSchema.safeParse(rawStatus);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_auth_status",
      message:
        "Claude Code returned an unsupported auth status format. Update your installed Claude Code and check its auth status command.",
    };
  }

  const status = parsed.data;
  if (
    result.error ||
    !status.loggedIn ||
    status.authMethod !== "claude.ai" ||
    status.apiProvider !== "firstParty" ||
    !status.subscriptionType ||
    !SUBSCRIPTIONS.has(status.subscriptionType)
  ) {
    return {
      ok: false,
      reason: "subscription_required",
      message:
        "Claude Agent requires an existing Claude Code login with a recognized Claude subscription. Check auth status in that installation; API keys, credential helpers, external tokens, and cloud providers are not supported by this runtime.",
    };
  }

  return { ok: true, executablePath, env };
}
