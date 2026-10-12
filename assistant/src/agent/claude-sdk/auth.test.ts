import * as childProcess from "node:child_process";
import { realpath } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { preflightClaudeSdkAuth } from "./auth.js";

const subscriptionStatus = {
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  subscriptionType: "max",
};
const options = {
  executablePath: process.execPath,
  cwd: process.cwd(),
  env: {},
};

let stdout: string;
let commandError: childProcess.ExecFileException | null;
let versionStdout: string;
let versionError: childProcess.ExecFileException | null;
let execFile: ReturnType<typeof spyOn<typeof childProcess, "execFile">>;

function commandMock(
  implementation: (...args: any[]) => childProcess.ChildProcess,
) {
  return Object.assign(implementation, {
    __promisify__: childProcess.execFile.__promisify__,
  });
}

beforeEach(() => {
  stdout = JSON.stringify(subscriptionStatus);
  commandError = null;
  versionStdout = "2.1.296 (Claude Code)\n";
  versionError = null;
  execFile = spyOn(childProcess, "execFile").mockImplementation(
    commandMock((...args: any[]) => {
      const isVersion = args[1][0] === "--version";
      args[3](
        isVersion ? versionError : commandError,
        isVersion ? versionStdout : stdout,
        "private stderr must not escape",
      );
      return new childProcess.ChildProcess();
    }),
  );
});

afterEach(() => {
  execFile.mockRestore();
});

describe("Claude Agent auth preflight", () => {
  test.each(["pro", "max", "team", "enterprise"])(
    "accepts an existing %s subscription login",
    async (subscriptionType) => {
      stdout = JSON.stringify({ ...subscriptionStatus, subscriptionType });

      const result = await preflightClaudeSdkAuth(options);

      expect(result).toEqual({
        ok: true,
        executablePath: await realpath(process.execPath),
        env: {},
      });
      expect(execFile.mock.calls.map((call) => call[1])).toEqual([
        ["--version"],
        ["auth", "status"],
      ]);
      expect(execFile).toHaveBeenCalledWith(
        await realpath(process.execPath),
        ["auth", "status"],
        expect.objectContaining({
          cwd: options.cwd,
          env: {},
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        }),
        expect.any(Function),
      );
    },
  );

  test.each([
    "2.1.296",
    "2.1.297 (Claude Code)",
    "2.1.1000 (Claude Code)",
    "2.2.0 (Claude Code)",
    "3.0.0 (Claude Code)",
  ])(
    "accepts a numeric version meeting Vellum's minimum: %s",
    async (version) => {
      versionStdout = version;

      expect(await preflightClaudeSdkAuth(options)).toMatchObject({ ok: true });
      expect(execFile).toHaveBeenCalledTimes(2);
    },
  );

  test.each([
    "2.1.295 (Claude Code)",
    "2.1.99 (Claude Code)",
    "2.0.999 (Claude Code)",
    "1.99.999 (Claude Code)",
    "2.1.296-beta.1 (Claude Code)",
    "unreadable private output",
    "2.1.296 (unrecognized executable)",
    "2.1.296 (Claude Code)\nprivate output",
    "999999999999999999999999999.1.1",
    "",
  ])(
    "blocks older or unreadable versions before auth status: %s",
    async (version) => {
      versionStdout = version;

      const result = await preflightClaudeSdkAuth(options);

      expect(result).toMatchObject({
        ok: false,
        reason: "unsupported_version",
      });
      expect(JSON.stringify(result)).toContain("2.1.296");
      expect(JSON.stringify(result)).not.toContain("private");
      expect(execFile.mock.calls.map((call) => call[1])).toEqual([
        ["--version"],
      ]);
    },
  );

  test("rejects a failed version command even with valid version output", async () => {
    versionError = Object.assign(new Error("private installation details"), {
      code: 1,
    });

    expect(await preflightClaudeSdkAuth(options)).toMatchObject({
      ok: false,
      reason: "unsupported_version",
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  test("sanitizes errors starting the version command", async () => {
    execFile.mockImplementation(
      commandMock(() => {
        throw new Error("private installation details");
      }),
    );

    const result = await preflightClaudeSdkAuth(options);

    expect(result).toMatchObject({ ok: false, reason: "unsupported_version" });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  test("passes the same narrow environment to preflight and the SDK caller", async () => {
    const env = {
      HOME: "/home/user",
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/home/user/claude-profile",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4096",
      MAX_STRUCTURED_OUTPUT_RETRIES: "2",
      XDG_CONFIG_HOME: "/home/user/config",
      ANTHROPIC_CONFIG_DIR: "/home/user/anthropic-profile",
      SystemRoot: "C:\\Windows",
      https_proxy: "https://proxy.example.com",
      NODE_EXTRA_CA_CERTS: "/home/user/ca.pem",
      APP_SECRET: "private-app-credential",
      NODE_OPTIONS: "--require /tmp/unrelated-hook.js",
    };
    const result = await preflightClaudeSdkAuth({ ...options, env });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.env).toEqual({
      HOME: env.HOME,
      PATH: env.PATH,
      CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
      MAX_STRUCTURED_OUTPUT_RETRIES: env.MAX_STRUCTURED_OUTPUT_RETRIES,
      XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
      ANTHROPIC_CONFIG_DIR: env.ANTHROPIC_CONFIG_DIR,
      SystemRoot: env.SystemRoot,
      https_proxy: env.https_proxy,
      NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS,
    });
    expect(execFile.mock.calls[0]?.[2]).toMatchObject({ env: result.env });
    expect(execFile.mock.calls[1]?.[2]).toMatchObject({ env: result.env });
    expect(env.APP_SECRET).toBe("private-app-credential");
    expect(result.env).not.toBe(env);
  });

  test.each([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "ANTHROPIC_AWS_API_KEY",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_API_KEY_HELPER",
    "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "anthropic_api_key",
  ])("reports %s instead of silently removing it", async (key) => {
    const result = await preflightClaudeSdkAuth({
      ...options,
      env: { [key]: "private-value-must-not-escape" },
    });

    expect(result).toMatchObject({ ok: false, reason: "environment_conflict" });
    if (!result.ok) {
      expect(result.message).toContain(key);
      expect(result.message).not.toContain("private-value-must-not-escape");
    }
    expect(execFile).not.toHaveBeenCalled();
  });

  test("allows empty auth variables without mutating the caller's environment", async () => {
    const env = { ANTHROPIC_API_KEY: "", CLAUDE_CODE_USE_BEDROCK: undefined };

    expect(await preflightClaudeSdkAuth({ ...options, env })).toMatchObject({
      ok: true,
      env: {},
    });
    expect(env.ANTHROPIC_API_KEY).toBe("");
  });

  test.each(["0", "false", "no", "OFF"])(
    "does not mistake an explicitly disabled cloud provider for a conflict: %s",
    async (value) => {
      expect(
        await preflightClaudeSdkAuth({
          ...options,
          env: { CLAUDE_CODE_USE_BEDROCK: value },
        }),
      ).toMatchObject({ ok: true });
    },
  );

  test("does not treat unrelated CLI tool preferences as auth overrides", async () => {
    expect(
      await preflightClaudeSdkAuth({
        ...options,
        env: { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" },
      }),
    ).toMatchObject({ ok: true });
  });

  test.each([
    { loggedIn: false, authMethod: "none" },
    { authMethod: "api_key" },
    { authMethod: "api_key_helper" },
    { authMethod: "oauth_token" },
    { authMethod: "third_party" },
    { apiProvider: "bedrock" },
    { apiProvider: "gateway" },
    { subscriptionType: null },
    { subscriptionType: undefined },
    { subscriptionType: "unknown" },
  ])("fails closed for a non-subscription status: %j", async (status) => {
    stdout = JSON.stringify({ ...subscriptionStatus, ...status });

    expect(await preflightClaudeSdkAuth(options)).toMatchObject({
      ok: false,
      reason: "subscription_required",
    });
  });

  test.each([
    "not JSON",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...subscriptionStatus, loggedIn: "true" }),
    JSON.stringify({ ...subscriptionStatus, apiProvider: 1 }),
    JSON.stringify({ ...subscriptionStatus, subscriptionType: {} }),
  ])(
    "rejects malformed auth output without exposing it: %s",
    async (output) => {
      stdout = output;

      expect(await preflightClaudeSdkAuth(options)).toMatchObject({
        ok: false,
        reason: "invalid_auth_status",
      });
    },
  );

  test("does not return account metadata or credential-like fields", async () => {
    stdout = JSON.stringify({
      ...subscriptionStatus,
      email: "user@example.com",
      orgId: "org-abc",
      token: "private-value-must-not-escape",
    });

    expect(await preflightClaudeSdkAuth(options)).toEqual({
      ok: true,
      executablePath: await realpath(process.execPath),
      env: {},
    });
  });

  test("handles the CLI's signed-out exit code", async () => {
    commandError = Object.assign(new Error("private account details"), {
      code: 1,
    });
    stdout = JSON.stringify({
      loggedIn: false,
      authMethod: "none",
      apiProvider: "firstParty",
    });

    expect(await preflightClaudeSdkAuth(options)).toMatchObject({
      ok: false,
      reason: "subscription_required",
    });
  });

  test("never accepts success-shaped JSON from a failed command", async () => {
    commandError = Object.assign(new Error("private account details"), {
      code: 1,
    });

    expect(await preflightClaudeSdkAuth(options)).toMatchObject({
      ok: false,
      reason: "subscription_required",
    });
  });

  test.each(["ENOENT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "ETIMEDOUT", 2])(
    "sanitizes subprocess failure %s",
    async (code) => {
      commandError = Object.assign(new Error("private account details"), {
        code,
      });

      const result = await preflightClaudeSdkAuth(options);

      expect(result).toMatchObject({ ok: false, reason: "auth_check_failed" });
      expect(JSON.stringify(result)).not.toContain("private");
    },
  );

  test("sanitizes synchronous process launch errors", async () => {
    execFile.mockImplementation(
      commandMock((...args: any[]) => {
        if (args[1][0] === "--version") {
          args[3](null, versionStdout, "");
          return new childProcess.ChildProcess();
        }
        throw new Error("private environment details");
      }),
    );

    const result = await preflightClaudeSdkAuth(options);

    expect(result).toMatchObject({ ok: false, reason: "auth_check_failed" });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  test.each(["claude", "./claude", "/missing-claude-executable"])(
    "rejects an unresolved or missing executable: %s",
    async (executablePath) => {
      expect(
        await preflightClaudeSdkAuth({ ...options, executablePath }),
      ).toMatchObject({ ok: false, reason: "invalid_executable" });
      expect(execFile).not.toHaveBeenCalled();
    },
  );

  test("rejects a directory as the executable", async () => {
    expect(
      await preflightClaudeSdkAuth({
        ...options,
        executablePath: process.cwd(),
      }),
    ).toMatchObject({ ok: false, reason: "invalid_executable" });
    expect(execFile).not.toHaveBeenCalled();
  });

  test("cancels before spawning", async () => {
    expect(
      await preflightClaudeSdkAuth({ ...options, signal: AbortSignal.abort() }),
    ).toMatchObject({ ok: false, reason: "aborted" });
    expect(execFile).not.toHaveBeenCalled();
  });

  test("forwards cancellation and rejects late successful output", async () => {
    const controller = new AbortController();
    execFile.mockImplementation(
      commandMock((...args: any[]) => {
        controller.abort();
        args[3](null, stdout, "");
        return new childProcess.ChildProcess();
      }),
    );

    expect(
      await preflightClaudeSdkAuth({ ...options, signal: controller.signal }),
    ).toMatchObject({ ok: false, reason: "aborted" });
    expect(execFile.mock.calls[0]?.[2]).toMatchObject({
      signal: controller.signal,
    });
  });
});
