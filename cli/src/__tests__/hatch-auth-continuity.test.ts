import { resolveLockfilePaths } from "@vellumai/local-mode";
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../lib/assistant-config.js";
import * as local from "../lib/local.js";
import * as configUtils from "../lib/config-utils.js";
import * as logs from "../lib/xdg-log.js";
import * as hatchLock from "../lib/local-hatch-lock.js";
import * as provider from "../lib/api-key-check.js";
import type { LifecycleReporter } from "../lib/lifecycle-reporter.js";

const real = {
  config: { ...config },
  local: { ...local },
  configUtils: { ...configUtils },
  logs: { ...logs },
  hatchLock: { ...hatchLock },
  provider: { ...provider },
};
const allocate = mock<typeof config.allocateLocalResources>();
const save = mock<typeof config.saveAssistantEntry>();
const launch = mock<typeof local.startLocalDaemon>();
const ces = mock<typeof local.startCes>();
const stop = mock<typeof local.stopLocalProcesses>(async () => {});
mock.module("../lib/assistant-config.js", () => ({
  ...real.config,
  allocateLocalResources: allocate,
  findAssistantByName: () => null,
  saveAssistantEntry: save,
}));
mock.module("../lib/local.js", () => ({
  ...real.local,
  startLocalDaemon: launch,
  startCes: ces,
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
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hatch-auth-"));
  savedLockDir = process.env.VELLUM_LOCKFILE_DIR;
  savedAppVersion = process.env.APP_VERSION;
  process.env.VELLUM_LOCKFILE_DIR = dir;
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
  stop.mockClear();
  // Stop the test at first launch, before any gateway, token lease or shell setup.
  launch.mockImplementation(async (_watch, resources, options) => {
    const registry = JSON.parse(
      readFileSync(resolveLockfilePaths(process.env)[0]!, "utf8"),
    );
    expect(registry.assistants[0].resources.signingKey).toBe(
      options!.signingKey,
    );
    expect(registry.assistants[0].guardianBootstrapSecret).toHaveLength(64);
    expect(resources!.instanceDir).toBe(dir);
    throw new Error("synthetic launch boundary");
  });
  ces.mockResolvedValue(undefined);
});
afterEach(() => {
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
