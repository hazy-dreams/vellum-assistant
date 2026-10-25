import { describe, expect, mock, test } from "bun:test";

const privateEntry = "/private-fixture/runtime/cli/src/index.ts";
(globalThis as Record<string, unknown>).__VELLUM_PRIVATE_CLI_ENTRY__ =
  privateEntry;
Object.defineProperty(process, "resourcesPath", {
  value: "/private-fixture/resources",
  configurable: true,
});
let present = new Set([privateEntry, "/private-fixture/resources/bun"]);
const forbidden = mock(() => {
  throw new Error("Unexpected shared-state mutation");
});
const actualFs = await import("node:fs");
mock.module("node:fs", () => ({
  ...actualFs,
  existsSync: (p: string) => present.has(p),
  chmodSync: forbidden,
  copyFileSync: forbidden,
  mkdirSync: forbidden,
  readdirSync: forbidden,
  readFileSync: forbidden,
  renameSync: forbidden,
  rmSync: forbidden,
  writeFileSync: forbidden,
  lstatSync: forbidden,
  realpathSync: forbidden,
}));
mock.module("electron", () => ({
  app: {
    isPackaged: true,
    getPath: () => "/private-fixture/userData",
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: forbidden,
    moveToApplicationsFolder: forbidden,
  },
  BrowserWindow: class {},
  dialog: { showMessageBox: forbidden },
  shell: { showItemInFolder: forbidden },
}));
mock.module("./logger", () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} },
}));
mock.module("./shell-path", () => ({
  findExecutablesInPath: forbidden,
  resolveShellPath: forbidden,
  splitPathEntries: forbidden,
}));
mock.module("./install-location", () => ({
  getInstallLocation: forbidden,
  isStrandedOutsideApplications: forbidden,
  recordInstallLocation: forbidden,
}));
mock.module("@vellumai/electron-desktop/settings", () => ({
  readSetting: forbidden,
  writeSetting: forbidden,
}));
const handlers = new Map<string, (...args: unknown[]) => unknown>();
mock.module("./ipc", () => ({
  handle: (
    name: string,
    _schema: unknown,
    fn: (...args: unknown[]) => unknown,
  ) => handlers.set(name, fn),
}));
const cli = await import("./cli-installer");
const wrapper = await import("./cli-path-installer");
const relocation = await import("./move-to-applications");
const updates = await import("./auto-update.client");
const login = await import("./login-item.client");

describe("private desktop guards", () => {
  test("fixed CLI validates existing files without installation", async () => {
    expect(cli.getCliBinPath()).toBe(privateEntry);
    await cli.ensureCliInstalled();
    present = new Set();
    await expect(cli.ensureCliInstalled()).rejects.toThrow(
      "Refusing public CLI fallback",
    );
    present = new Set([privateEntry, "/private-fixture/resources/bun"]);
  });
  test("locator, migration, cleanup and wrapper management cannot mutate shared state", async () => {
    cli.writeCliLocator();
    cli.migrateStaleInstallDir();
    cli.cleanupOldVersions();
    expect(await wrapper.provisionCliForWrapper()).toBe(false);
    expect(() => wrapper.installWrapper({ overwriteForeign: true })).toThrow(
      "Private builds",
    );
    expect(() => wrapper.uninstallWrapper()).toThrow("Private builds");
  });
  test("both relocation paths are inert", async () => {
    expect(await relocation.relocateToApplicationsFolder()).toBe(false);
    await relocation.promptToRelocateIfStranded();
  });
  test("update IPC cannot check, download or install", () => {
    updates.installAutoUpdate();
    updates.checkForUpdates();
    expect(handlers.get("vellum:update:getState")?.()).toEqual({
      status: "idle",
    });
    handlers.get("vellum:update:check")?.();
    handlers.get("vellum:update:install")?.();
  });
  test("login-item reads remain available but writes are rejected", () => {
    login.installLoginItem();
    login.installLoginItemIpc();
    expect(handlers.get("vellum:launchAtLogin:get")?.()).toBe(false);
    expect(() => handlers.get("vellum:launchAtLogin:set")?.(true)).toThrow(
      "Manage login items",
    );
    expect(forbidden).not.toHaveBeenCalled();
  });
});
