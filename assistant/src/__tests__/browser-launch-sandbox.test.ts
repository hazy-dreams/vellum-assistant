import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

type LaunchCall = { kind: "persistent" | "launch"; options: unknown };

const calls: LaunchCall[] = [];
let failFirstPersistentLaunch = false;

const page = {
  isClosed: () => false,
  on: () => {},
  close: async () => {},
  route: async () => {},
  setContent: async () => {},
  pdf: async () => Buffer.from("%PDF-"),
};
const context = {
  newPage: async () => page,
  close: async () => {},
  on: () => {},
  off: () => {},
};

const fakePlaywright = {
  chromium: {
    // An existing path, so the on-demand browser install paths never run.
    executablePath: () => "/bin/sh",
    launchPersistentContext: async (_dir: string, options: unknown) => {
      calls.push({ kind: "persistent", options });
      if (failFirstPersistentLaunch && calls.length === 1) {
        throw new Error("simulated system Chrome launch failure");
      }
      return context;
    },
    launch: async (options: unknown) => {
      calls.push({ kind: "launch", options });
      return { newContext: async () => context, close: async () => {} };
    },
  },
};

mock.module("../tools/browser/runtime-check.js", () => ({
  importPlaywright: async () => fakePlaywright,
  ensureChromiumHeadlessShell: async () => {},
  checkBrowserRuntime: async () => ({
    playwrightAvailable: true,
    chromiumInstalled: true,
    chromiumPath: "/bin/sh",
    error: null,
  }),
}));

const { browserManager, setLaunchFn } =
  await import("../tools/browser/browser-manager.js");
const { renderMarkdownToPDF } =
  await import("../runtime/routes/document-pdf-renderer.js");

function expectAllSandboxed(kind: LaunchCall["kind"], minimum: number) {
  const matching = calls.filter((call) => call.kind === kind);
  expect(matching.length).toBeGreaterThanOrEqual(minimum);
  for (const call of matching) {
    expect(call.options).toMatchObject({ chromiumSandbox: true });
  }
}

describe("browser launch sandbox", () => {
  beforeEach(async () => {
    await browserManager.closeAllPages();
    setLaunchFn(null);
    calls.length = 0;
    failFirstPersistentLaunch = false;
  });

  afterAll(async () => {
    await browserManager.closeAllPages();
  });

  test("the local browser launches with the sandbox on", async () => {
    await browserManager.getOrCreateSessionPage("sandbox-primary");
    expectAllSandboxed("persistent", 1);
  });

  test("the fallback launch keeps the sandbox on", async () => {
    failFirstPersistentLaunch = true;
    await browserManager.getOrCreateSessionPage("sandbox-fallback");
    // Hosts without system Chrome fail on their only launch path instead.
    expectAllSandboxed("persistent", 1);
  });

  test("the injected launcher receives the sandbox option", async () => {
    const injected: unknown[] = [];
    setLaunchFn(async (_dir, options) => {
      injected.push(options);
      return context as never;
    });
    await browserManager.getOrCreateSessionPage("sandbox-injected");
    expect(injected).toHaveLength(1);
    expect(injected[0]).toMatchObject({ chromiumSandbox: true });
  });

  test("the PDF renderer launches with the sandbox on", async () => {
    const pdf = await renderMarkdownToPDF("Title", "# Heading");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expectAllSandboxed("launch", 1);
  });
});
