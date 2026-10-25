import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  asConversation,
  mockChannelCapabilities,
} from "../../__tests__/helpers/mock-conversation.js";
import { assertNotLiveDb } from "../../__tests__/assert-not-live-db.js";
import { getConfig } from "../../config/loader.js";
import type { Message, ToolDefinition } from "../../providers/types.js";
import type { Conversation } from "../conversation.js";
import type { SkillProjectionCache } from "../conversation-skill-tools.js";

const realSkillProjection = await import("../conversation-skill-tools.js");
mock.module("../conversation-skill-tools.js", () => ({
  ...realSkillProjection,
  projectSkillTools: () => ({
    allowedToolNames: new Set<string>(),
    toolDefinitions: [],
  }),
}));

const {
  createResolveToolsCallback,
  createToolExecutor,
  isToolActiveForContext,
} = await import("../conversation-tool-setup.js");
const { __clearRegistryForTesting, registerTool, registerPluginTools } =
  await import("../../tools/registry.js");
const { ToolApprovalHandler } =
  await import("../../tools/tool-approval-handler.js");
const { ClaudeSdkSessionStore, createSdkSessionFingerprint, prepareSdkPrompt } =
  await import("../../agent/claude-sdk/session.js");
import type { ToolExecutor } from "../../tools/executor.js";
import type { PermissionPrompter } from "../../permissions/prompter.js";
import type { SecretPrompter } from "../../permissions/secret-prompter.js";
import type { ToolContext } from "../../tools/types.js";

const names = [
  "file_read",
  "ask_question",
  "request_system_permission",
  "ui_show",
  "host_bash",
  "skill_execute",
];
const definitions = names.map(
  (name): ToolDefinition => ({
    name,
    description: `Fixture ${name}`,
    input_schema: { type: "object", properties: { value: { type: "string" } } },
  }),
);
function makeCtx(overrides: Partial<Conversation> = {}): Conversation {
  const ctx = asConversation({
    conversationId: "continuity-fixture",
    workingDir: process.env.VELLUM_WORKSPACE_DIR!,
    transportInterface: "web",
    clientOs: "macos",
    currentTurnClientOs: "macos",
    currentTurnIsNonInteractive: false,
    currentRequestId: "request-fixture",
    currentCallSite: "mainAgent",
    trustContext: { trustClass: "guardian", sourceChannel: "vellum" },
    getTurnActorPrincipalId: () => undefined,
    skillProjectionState: new Map(),
    skillProjectionCache: { fingerprints: new Map() } as SkillProjectionCache,
    toolsDisabledDepth: 0,
    emit: mock(() => {}),
    currentTurnSurfaces: [],
    ...overrides,
  });
  Object.defineProperty(ctx, "hasNoClient", {
    get: () => ctx.currentTurnIsNonInteractive ?? true,
  });
  return ctx;
}
const user = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});
const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
let previousExclude: string[];
const directories: string[] = [];
beforeEach(() => {
  __clearRegistryForTesting();
  previousExclude = getConfig().tools.exclude;
  getConfig().tools.exclude = [];
  for (const def of definitions) {
    registerTool(def);
  }
});
afterEach(async () => {
  getConfig().tools.exclude = previousExclude;
  __clearRegistryForTesting();
  for (const dir of directories.splice(0)) {
    assertNotLiveDb(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

describe("presence-stable tool schemas", () => {
  test("owner foreground/helper/foreground has identical definitions and execution eligibility", () => {
    const ctx = makeCtx();
    const resolve = createResolveToolsCallback(definitions, ctx)!;
    const foreground = JSON.stringify(resolve([]));
    expect(ctx.allowedToolNames).toEqual(new Set(names));
    ctx.currentTurnIsNonInteractive = true;
    const background = JSON.stringify(resolve([]));
    expect(ctx.allowedToolNames).toEqual(new Set(names));
    expect(
      ctx.registeredToolDefinitions?.map((def) => def.name).sort(),
    ).toEqual([...ctx.allowedToolNames!].sort());
    expect(isToolActiveForContext("ask_question", ctx)).toBe(true);
    expect(isToolActiveForContext("request_system_permission", ctx)).toBe(true);
    expect(background).toBe(foreground);
    ctx.currentTurnIsNonInteractive = false;
    expect(JSON.stringify(resolve([]))).toBe(foreground);
    expect(ctx.allowedToolNames).toEqual(new Set(names));
  });

  test("activity stripping stays byte-stable with owner execution parity", () => {
    const ctx = makeCtx({ currentTurnSendUserMessageActive: true });
    const resolve = createResolveToolsCallback(definitions, ctx)!;
    const foreground = JSON.stringify(resolve([]));
    expect(foreground).not.toContain('"activity"');
    ctx.currentTurnIsNonInteractive = true;
    expect(JSON.stringify(resolve([]))).toBe(foreground);
    expect(ctx.allowedToolNames?.has("ask_question")).toBe(true);
    expect(ctx.allowedToolNames?.has("request_system_permission")).toBe(true);
    ctx.currentTurnIsNonInteractive = false;
    expect(JSON.stringify(resolve([]))).toBe(foreground);
  });

  test("execution-mode role gates deny human-only tools even with a foreground context pin", async () => {
    const ctx = makeCtx({
      currentTurnIsNonInteractive: true,
      subagentToolGateMode: "execution",
      subagentAllowedTools: new Set(["file_read"]),
      toolContextPin: {
        hasNoClient: false,
        transportInterface: "web",
        clientOs: "macos",
      },
    });
    const wire = createResolveToolsCallback(definitions, ctx)!([]);
    const execute = mock(async () => ({ content: "unexpected execution" }));
    const tool = createToolExecutor(
      { execute } as unknown as ToolExecutor,
      {} as PermissionPrompter,
      {} as SecretPrompter,
      ctx,
    );
    for (const name of ["ask_question", "request_system_permission"]) {
      expect(wire.map((def) => def.name)).toContain(name);
      expect((await tool(name, {})).isError).toBe(true);
      expect(
        (await tool("skill_execute", { tool: name, input: {} })).isError,
      ).toBe(true);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  test("resolver output preserves a clean native session across both presence transitions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tool-schema-continuity-"));
    directories.push(directory);
    const ctx = makeCtx();
    const resolve = createResolveToolsCallback(definitions, ctx)!;
    const fingerprint = () =>
      createSdkSessionFingerprint({
        model: "sonnet",
        systemPrompt: "Fixture instructions",
        tools: resolve([]),
        executablePath: "/fixture/claude",
      });
    const store = new ClaudeSdkSessionStore(directory);
    const firstInput = [user("First request")];
    const first = await store.begin({
      messages: firstInput,
      fingerprint: fingerprint(),
    });
    const completed: Message[] = [
      ...firstInput,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "historical-action",
            name: "file_read",
            input: { value: "once" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "historical-action",
            content: "Already completed",
          },
        ],
      },
      assistant("Finished first turn"),
    ];
    expect(await store.complete(first, completed)).toBe(true);
    const prefix = JSON.stringify(completed);
    ctx.currentTurnIsNonInteractive = true;
    const notification = user(
      "Helper completed\n<non_interactive_context>Do not ask questions.</non_interactive_context>",
    );
    const second = await new ClaudeSdkSessionStore(directory).begin({
      messages: [...completed, notification],
      fingerprint: fingerprint(),
    });
    expect(second.resume).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.messages).toEqual([notification]);
    expect(
      JSON.stringify(
        await prepareSdkPrompt(
          second.messages,
          second.sessionId,
          second.currentTurnStart,
        ),
      ),
    ).not.toContain("historical-action");
    const secondHistory = [
      ...completed,
      notification,
      assistant("Used helper result"),
    ];
    expect(await store.complete(second, secondHistory)).toBe(true);
    ctx.currentTurnIsNonInteractive = false;
    const thirdInput = user("Continue here");
    const third = await new ClaudeSdkSessionStore(directory).begin({
      messages: [...secondHistory, thirdInput],
      fingerprint: fingerprint(),
    });
    expect(third.resume).toBe(true);
    expect(third.sessionId).toBe(first.sessionId);
    expect(third.messages).toEqual([thirdInput]);
    expect(JSON.stringify(completed)).toBe(prefix);
  });

  test("owner background UI requests pass availability through direct and skill dispatch without faking interactivity", async () => {
    const ctx = makeCtx({ currentTurnIsNonInteractive: true });
    createResolveToolsCallback(definitions, ctx)!([]);
    const handler = new ToolApprovalHandler();
    const performed = mock(() => {});
    const executor = {
      execute: async (
        name: string,
        input: Record<string, unknown>,
        context: ToolContext,
      ) => {
        const gate = await handler.checkPreExecutionGates(
          name,
          input,
          context,
          "high",
          Date.now(),
        );
        if (!gate.allowed) {
          return gate.result;
        }
        expect(context.isInteractive).toBe(false);
        expect(context.trustClass).toBe("guardian");
        performed();
        return {
          content: "available for normal approval and execution",
          isError: false,
        };
      },
    } as unknown as ToolExecutor;
    const tool = createToolExecutor(
      executor,
      {} as PermissionPrompter,
      {} as SecretPrompter,
      ctx,
    );
    for (const name of ["ask_question", "request_system_permission"]) {
      const input =
        name === "ask_question"
          ? {
              questions: [
                {
                  question: "Continue?",
                  options: [
                    { id: "yes", label: "Yes" },
                    { id: "no", label: "No" },
                  ],
                },
              ],
            }
          : { permission_type: "microphone" };
      expect((await tool(name, input)).isError).toBe(false);
      expect((await tool("skill_execute", { tool: name, input })).isError).toBe(
        false,
      );
    }
    expect(performed).toHaveBeenCalledTimes(4);
    expect(ctx.emit).not.toHaveBeenCalled();
  });

  test("non-owner background and frozen non-owner trust retain UI execution restrictions", () => {
    for (const trustClass of ["unknown", "trusted_contact"] as const) {
      const ctx = makeCtx({
        currentTurnIsNonInteractive: true,
        currentTurnTrustContext: { sourceChannel: "vellum", trustClass },
      });
      createResolveToolsCallback(definitions, ctx)!([]);
      for (const name of ["ask_question", "request_system_permission"]) {
        expect(isToolActiveForContext(name, ctx)).toBe(false);
        expect(ctx.allowedToolNames?.has(name)).toBe(false);
      }
    }
  });

  test("platform, role, read-only, exclusions and disabled-tool boundaries remain restrictive", () => {
    const cases: Array<{ overrides: Partial<Conversation>; absent: string[] }> =
      [
        {
          overrides: {
            channelCapabilities: mockChannelCapabilities({
              channel: "test",
              supportsDynamicUi: true,
              clientOS: "macos",
            }),
          },
          absent: ["ask_question"],
        },
        {
          overrides: { currentTurnClientOs: "ios", clientOs: "ios" },
          absent: ["request_system_permission"],
        },
        {
          overrides: {
            transportInterface: "chrome-extension",
            currentTurnClientOs: undefined,
            clientOs: undefined,
          },
          absent: ["request_system_permission", "host_bash"],
        },
        {
          overrides: { subagentAllowedTools: new Set(["file_read"]) },
          absent: ["ask_question", "request_system_permission"],
        },
        {
          overrides: { subagentDenySideEffects: true },
          absent: ["ask_question", "request_system_permission"],
        },
        { overrides: { toolsDisabledDepth: 1 }, absent: names },
        {
          overrides: { diskPressureCleanupModeActive: true },
          absent: ["ask_question", "request_system_permission"],
        },
      ];
    for (const { overrides, absent } of cases) {
      const ctx = makeCtx({ ...overrides, currentTurnIsNonInteractive: true });
      const wireNames = createResolveToolsCallback(definitions, ctx)!([]).map(
        (def) => def.name,
      );
      for (const name of absent) {
        expect(wireNames).not.toContain(name);
        expect(ctx.allowedToolNames?.has(name)).toBe(false);
      }
    }
    getConfig().tools.exclude = ["ask_question", "request_system_permission"];
    const ctx = makeCtx({ currentTurnIsNonInteractive: true });
    const result = createResolveToolsCallback(definitions, ctx)!([]);
    expect(result.map((def) => def.name)).not.toContain("ask_question");
    expect(result.map((def) => def.name)).not.toContain(
      "request_system_permission",
    );
  });

  test("plugin definitions obey chat scope and owner background execution parity", () => {
    __clearRegistryForTesting();
    registerTool(definitions[0]!);
    registerPluginTools(
      "fixture-plugin",
      definitions.slice(1, 3) as Parameters<typeof registerPluginTools>[1],
    );
    const ctx = makeCtx({ enabledPlugins: ["fixture-plugin"] });
    const resolve = createResolveToolsCallback([definitions[0]!], ctx)!;
    const before = JSON.stringify(resolve([]));
    ctx.currentTurnIsNonInteractive = true;
    expect(JSON.stringify(resolve([]))).toBe(before);
    expect(ctx.allowedToolNames).toEqual(
      new Set(["file_read", "ask_question", "request_system_permission"]),
    );
    ctx.enabledPlugins = [];
    expect(resolve([]).map((def) => def.name)).toEqual(["file_read"]);
  });
});
