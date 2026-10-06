import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../lib/assistant-config.js";
import * as local from "../lib/local.js";
import * as configUtils from "../lib/config-utils.js";
import * as logs from "../lib/xdg-log.js";
import * as hatchLock from "../lib/local-hatch-lock.js";
import * as provider from "../lib/api-key-check.js";
import * as processLib from "../lib/process.js";
import * as http from "../lib/http-client.js";
import * as tunnel from "../lib/tunnel-edge.js";
import { loadGuardianToken } from "../lib/guardian-token.js";
import type { LifecycleReporter } from "../lib/lifecycle-reporter.js";

const real = {
  config: { ...config },
  local: { ...local },
  configUtils: { ...configUtils },
  logs: { ...logs },
  hatchLock: { ...hatchLock },
  provider: { ...provider },
  processLib: { ...processLib },
  http: { ...http },
  tunnel: { ...tunnel },
};
const allocate = mock<typeof config.allocateLocalResources>();
const save = mock<typeof config.saveAssistantEntry>();
const launch = mock<typeof local.startLocalDaemon>();
const ces = mock<typeof local.startCes>();
const gateway = mock<typeof local.startGateway>();
const stop = mock<typeof local.stopLocalProcesses>(async () => {});
mock.module("../lib/assistant-config.js", () => ({
  ...real.config,
  allocateLocalResources: allocate,
  saveAssistantEntry: save,
}));
mock.module("../lib/local.js", () => ({
  ...real.local,
  startLocalDaemon: launch,
  startCes: ces,
  startGateway: gateway,
  stopLocalProcesses: stop,
}));
mock.module("../lib/config-utils.js", () => ({
  ...real.configUtils,
  writeInitialConfig: () => "/synthetic/config.json",
}));
mock.module("../lib/xdg-log.js", () => ({
  ...real.logs,
  archiveLogFile: () => {},
  resetLogFile: () => {},
}));
mock.module("../lib/local-hatch-lock.js", () => ({
  ...real.hatchLock,
  withLocalHatchLock: async (fn: () => Promise<unknown>) => fn(),
}));
mock.module("../lib/api-key-check.js", () => ({
  ...real.provider,
  checkProviderApiKey: () => ({ hasKey: true }),
}));
mock.module("../lib/process.js", () => ({
  ...real.processLib,
  resolveProcessState: mock<typeof processLib.resolveProcessState>(
    async () => ({ status: "needs_start", pid: null }),
  ),
  isProcessAlive: () => ({ alive: true, pid: 123 }),
}));
mock.module("../lib/http-client.js", () => ({
  ...real.http,
  probeDaemonReadinessWithRetry: async () => "ready",
}));
mock.module("../lib/tunnel-edge.js", () => ({
  ...real.tunnel,
  restoreTunnelEdgeAndAutoTunnel: async () => null,
}));
const { wake } = await import("../commands/wake.js");
const { use } = await import("../commands/use.js");
const { setup } = await import("../commands/setup.js");
const { hatchLocal } = await import("../lib/hatch-local.js");
const reporter: LifecycleReporter = {
  log() {},
  warn() {},
  error() {},
  progress() {},
};
let dir: string;
let savedLockDir: string | undefined;
let savedAppVersion: string | undefined;
let savedEnv: Partial<NodeJS.ProcessEnv>;
const isolatedEnvKeys = [
  "XDG_CONFIG_HOME",
  "APPDATA",
  "VELLUM_ENVIRONMENT",
  "OPENAI_API_KEY",
] as const;
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hatch-auth-"));
  savedLockDir = process.env.VELLUM_LOCKFILE_DIR;
  savedAppVersion = process.env.APP_VERSION;
  process.env.VELLUM_LOCKFILE_DIR = dir;
  savedEnv = Object.fromEntries(
    isolatedEnvKeys.map((key) => [key, process.env[key]]),
  );
  process.env.XDG_CONFIG_HOME = dir;
  process.env.APPDATA = dir;
  process.env.VELLUM_ENVIRONMENT = "production";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.exitCode = 0;
  allocate.mockReset();
  allocate.mockResolvedValue({
    instanceDir: dir,
    gatewayPort: 7830,
    daemonPort: 7831,
    cesPort: 7832,
    qdrantPort: 7833,
  });
  save.mockReset();
  save.mockImplementation(real.config.saveAssistantEntry);
  launch.mockReset();
  ces.mockReset();
  gateway.mockReset();
  gateway.mockResolvedValue("http://127.0.0.1:7830");
  stop.mockClear();
  // Stop the test at first launch, before any gateway, token lease or shell setup.
  launch.mockImplementation(async (_watch, resources, options) => {
    const entry = real.config.findAssistantByName("example");
    expect(entry?.resources?.signingKey).toBe(options!.signingKey);
    expect(entry?.guardianBootstrapSecret).toHaveLength(64);
    expect(resources!.instanceDir).toBe(dir);
    throw new Error("synthetic launch boundary");
  });
  ces.mockResolvedValue(undefined);
});
afterEach(() => {
  mock.restore();
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  for (const key of isolatedEnvKeys) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  if (savedLockDir === undefined) {
    delete process.env.VELLUM_LOCKFILE_DIR;
  } else {
    process.env.VELLUM_LOCKFILE_DIR = savedLockDir;
  }
  if (savedAppVersion === undefined) {
    delete process.env.APP_VERSION;
  } else {
    process.env.APP_VERSION = savedAppVersion;
  }
  rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  mock.module("../lib/assistant-config.js", () => real.config);
  mock.module("../lib/local.js", () => real.local);
  mock.module("../lib/config-utils.js", () => real.configUtils);
  mock.module("../lib/xdg-log.js", () => real.logs);
  mock.module("../lib/local-hatch-lock.js", () => real.hatchLock);
  mock.module("../lib/api-key-check.js", () => real.provider);
  mock.module("../lib/process.js", () => real.processLib);
  mock.module("../lib/http-client.js", () => real.http);
  mock.module("../lib/tunnel-edge.js", () => real.tunnel);
});
test("hatch persists signing identity before first launch", async () => {
  await expect(
    hatchLocal(
      "vellum",
      "example",
      false,
      false,
      {},
      {},
      { setupProviderCredentials: false, reporter },
    ),
  ).rejects.toThrow("synthetic launch boundary");
  expect(launch).toHaveBeenCalledTimes(1);
});
test("failed persistence prevents every service launch", async () => {
  save.mockImplementation(() => {
    throw new Error("synthetic storage failure");
  });
  await expect(
    hatchLocal(
      "vellum",
      "example",
      false,
      false,
      {},
      {},
      { setupProviderCredentials: false, reporter },
    ),
  ).rejects.toThrow("synthetic storage failure");
  expect(launch).not.toHaveBeenCalled();
  expect(ces).not.toHaveBeenCalled();
});

test("failed first startup can follow recovery guidance without replacing its identity", async () => {
  real.config.saveAssistantEntry({
    assistantId: "other-assistant",
    cloud: "local",
    runtimeUrl: "http://127.0.0.1:9999",
  });
  real.config.setActiveAssistant("other-assistant");
  const hatch = () =>
    hatchLocal(
      "vellum",
      "example",
      false,
      false,
      { "llm.default.provider": "openai" },
      {},
      { reporter },
    );
  const failure = await hatch().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) {
    throw new Error("Expected hatch to fail");
  }
  expect(failure.message).toContain("synthetic launch boundary");
  expect(failure.cause).toMatchObject({ message: "synthetic launch boundary" });
  expect(failure.message).toContain("revokes existing device tokens");
  const commands = [...failure.message.matchAll(/`(vellum [^`]+)`/g)].map(
    (match) => match[1],
  );
  expect(commands).toEqual([
    "vellum wake example --repair-guardian",
    "vellum use example",
    "vellum setup --provider openai",
  ]);
  expect(stop).toHaveBeenCalledTimes(1);
  const saved = real.config.findAssistantByName("example")!;
  expect(saved.resources?.signingKey).toHaveLength(64);
  expect(loadGuardianToken("example")).toBeNull();
  await expect(hatch()).rejects.toThrow(
    "vellum wake example --repair-guardian",
  );
  expect(allocate).toHaveBeenCalledTimes(1);
  expect(real.config.getActiveAssistant()).toBe("other-assistant");

  launch.mockResolvedValue(undefined);
  spyOn(console, "log").mockImplementation(() => {});

  const requests: string[] = [];
  const fakeFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = new URL(String(input));
    expect(url.origin).toBe(saved.localUrl!);
    requests.push(url.pathname);
    const headers = new Headers(init?.headers);
    if (url.pathname.startsWith("/v1/guardian/")) {
      expect(headers.get("x-bootstrap-secret")).toBe(
        saved.guardianBootstrapSecret!,
      );
      if (url.pathname.endsWith("/reset-bootstrap")) {
        return Response.json({ success: true });
      }
      if (url.pathname.endsWith("/init")) {
        return Response.json({
          guardianPrincipalId: "guardian-123",
          accessToken: "test-guardian-token",
          accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          refreshToken: "test-refresh-token",
          refreshTokenExpiresAt: new Date(Date.now() + 120_000).toISOString(),
          refreshAfter: new Date(Date.now() + 30_000).toISOString(),
          isNew: true,
        });
      }
    }
    expect(headers.get("authorization")).toBe("Bearer test-guardian-token");
    if (url.pathname === "/v1/secrets/read") {
      return Response.json({ found: false });
    }
    if (url.pathname === "/v1/secrets") {
      expect(init?.body).toBe(
        JSON.stringify({
          type: "api_key",
          name: "openai",
          value: "test-openai-key",
        }),
      );
      return Response.json({ success: true });
    }
    throw new Error(`Unexpected test request: ${url.pathname}`);
  };
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(fakeFetch, { preconnect: fetch.preconnect }),
  );
  for (const command of commands) {
    const [, name, ...args] = command!.split(" ");
    process.argv = ["bun", "vellum", name!, ...args];
    if (name === "wake") {
      await wake();
    } else if (name === "use") {
      await use();
    } else if (name === "setup") {
      await setup();
    } else {
      throw new Error(`Unexpected recovery command: ${name}`);
    }
  }
  expect(process.exitCode).toBe(0);
  expect(requests).toEqual([
    "/v1/guardian/reset-bootstrap",
    "/v1/guardian/init",
    "/v1/secrets/read",
    "/v1/secrets",
  ]);
  expect(loadGuardianToken("example")?.accessToken).toBe("test-guardian-token");
  expect(real.config.getActiveAssistant()).toBe("example");
  expect(real.config.findAssistantByName("example")).toMatchObject({
    resources: { signingKey: saved.resources!.signingKey },
    guardianBootstrapSecret: saved.guardianBootstrapSecret,
  });
  expect(launch).toHaveBeenLastCalledWith(
    false,
    expect.anything(),
    expect.objectContaining({ signingKey: saved.resources!.signingKey }),
  );
  expect(gateway).toHaveBeenCalledWith(false, expect.anything(), {
    signingKey: saved.resources!.signingKey,
    bootstrapSecret: saved.guardianBootstrapSecret,
  });
});
