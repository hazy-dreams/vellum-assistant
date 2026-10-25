import { afterEach, describe, expect, test } from "bun:test";

import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import type { ToolDefinition } from "../../providers/types.js";
import {
  type ClaudeSdkToolBridge,
  type ClaudeSdkToolBridgeOptions,
  createClaudeSdkToolBridge,
} from "./tools.js";

const definitions: ToolDefinition[] = [
  {
    name: "example_tool",
    description: "Run a Vellum tool",
    input_schema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
async function setup(options: Partial<ClaudeSdkToolBridgeOptions> = {}) {
  const bridge = createClaudeSdkToolBridge({
    tools: definitions,
    toolExecutor: async () => ({ content: "done", isError: false }),
    ...options,
  });
  const client = new Client({ name: "bridge-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    bridge.server.instance.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  cleanup.push(async () => {
    await client.close();
    await bridge.dispose();
  });
  return { bridge, client };
}
function hookInput(
  id: string,
  input: Record<string, unknown>,
  extra: Partial<PreToolUseHookInput>,
): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: "session-123",
    transcript_path: "/tmp/example-transcript.jsonl",
    cwd: "/tmp",
    tool_name: "mcp__vellum__example_tool",
    tool_input: input,
    tool_use_id: id,
    mcp_server: { name: "vellum", source: "sdk" },
    ...extra,
  };
}
function authorize(
  bridge: ClaudeSdkToolBridge,
  id = "tool-123",
  input: Record<string, unknown> = { value: "example" },
  extra: Partial<PreToolUseHookInput> = {},
  signal = new AbortController().signal,
) {
  return bridge.preToolUse(hookInput(id, input, extra), id, { signal });
}
function invoke(
  client: Client,
  id = "tool-123",
  input: Record<string, unknown> = { value: "example" },
  name = "example_tool",
) {
  return client.callTool({
    name,
    arguments: input,
    _meta: { "claudecode/toolUseId": id },
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const denied = { hookSpecificOutput: { permissionDecision: "deny" } };

describe("Claude SDK Vellum tool bridge", () => {
  test("disables SDK auto-backgrounding so Vellum owns tool completion", async () => {
    const { bridge } = await setup();
    expect(bridge.server.disableAutoBackground).toBe(true);
  });

  test("does not release the MCP result while tool finalization is pending", async () => {
    const finalizing = deferred();
    const gate = deferred();
    let returned = false;
    const { bridge, client } = await setup({
      finalizeToolResult: async (_call, result) => {
        finalizing.resolve();
        await gate.promise;
        return result;
      },
    });
    expect(bridge.isSettled()).toBe(true);
    await authorize(bridge);
    expect(bridge.isSettled()).toBe(false);
    const result = invoke(client).then((value) => {
      returned = true;
      return value;
    });
    await finalizing.promise;
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(bridge.isSettled()).toBe(false);
    gate.resolve();
    expect((await result).isError).toBe(false);
    expect(bridge.isSettled()).toBe(true);
  });

  test("a rejected finalization never certifies its admitted call as settled", async () => {
    let executions = 0;
    const { bridge, client } = await setup({
      toolExecutor: async () => {
        executions++;
        return { content: "Side effect completed", isError: false };
      },
      onToolResult: async () => {
        throw new Error("Fixture result observer failed");
      },
    });
    await authorize(bridge);
    await invoke(client).catch(() => undefined);
    await bridge.settle();
    expect(bridge.isSettled()).toBe(false);
    await invoke(client).catch(() => undefined);
    expect(executions).toBe(1);
    expect(bridge.isSettled()).toBe(false);
  });

  test("preserves arbitrary JSON schemas without a lossy Zod round trip", async () => {
    const input_schema = {
      type: "object" as const,
      $defs: { item: { type: "integer", minimum: 1 } },
      properties: {
        values: { type: "array", items: { $ref: "#/$defs/item" } },
        mode: { enum: ["first", "last"] },
      },
      oneOf: [{ required: ["values"] }, { required: ["mode"] }],
      additionalProperties: false,
      "x-example-annotation": "preserved",
    };
    const { client } = await setup({
      tools: [{ ...definitions[0]!, input_schema }],
    });
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]?.inputSchema).toEqual(input_schema);
    expect(listed.tools[0]?._meta?.["anthropic/alwaysLoad"]).toBe(true);
  });
  test("maps names reversibly and isolates the Vellum namespace", async () => {
    const name = "plugin.example/read document";
    const { bridge } = await setup({
      tools: [...definitions, { ...definitions[0]!, name }],
    });
    expect(bridge.toSdkName("example_tool")).toBe("mcp__vellum__example_tool");
    const sdkName = bridge.toSdkName(name)!;
    expect(sdkName).toMatch(/^mcp__vellum__tool_[a-f0-9]+$/);
    expect(bridge.toVellumName(sdkName)).toBe(name);
    expect(bridge.toVellumName("example_tool")).toBeUndefined();
    expect(bridge.toVellumName("mcp__other__example_tool")).toBeUndefined();
    expect(bridge.toSdkName("missing")).toBeUndefined();
  });
  test("rejects duplicate definitions", () => {
    expect(() =>
      createClaudeSdkToolBridge({
        tools: [...definitions, ...definitions],
        toolExecutor: async () => ({ content: "", isError: false }),
      }),
    ).toThrow("Duplicate or invalid Vellum tool name");
  });
  test("uses the existing executor and passes original name, input, ID, and lifecycle callbacks", async () => {
    const observed: unknown[] = [];
    const { bridge, client } = await setup({
      toolExecutor: async (name, input, output, id) => {
        observed.push({ name, input, id });
        output?.("working");
        return { content: "done", isError: false };
      },
      onToolStart: (call) => {
        observed.push(["start", call.id]);
      },
      onToolOutput: (call, chunk) => {
        observed.push(["output", call.id, chunk]);
      },
      finalizeToolResult: async (call, result) => {
        observed.push(["finalize", call.id]);
        return { ...result, content: "finalized" };
      },
      onToolResult: (call, result) => {
        observed.push(["result", call.id, result.content]);
      },
    });
    await authorize(bridge);
    expect((await invoke(client)).content).toEqual([
      { type: "text", text: "finalized" },
    ]);
    expect(observed).toEqual([
      ["start", "tool-123"],
      { name: "example_tool", input: { value: "example" }, id: "tool-123" },
      ["output", "tool-123", "working"],
      ["finalize", "tool-123"],
      ["result", "tool-123", "finalized"],
    ]);
  });
  test("waits for the runtime assistant-frame barrier before execution", async () => {
    const started = deferred();
    const barrier = deferred();
    let executions = 0;
    const { bridge, client } = await setup({
      onToolStart: async () => {
        started.resolve();
        await barrier.promise;
      },
      toolExecutor: async () => {
        executions += 1;
        return { content: "done", isError: false };
      },
    });
    await authorize(bridge);
    const result = invoke(client);
    await started.promise;
    expect(executions).toBe(0);
    barrier.resolve();
    await result;
    expect(executions).toBe(1);
  });
  test("correlates concurrent identical inputs by actual SDK IDs even out of order", async () => {
    const calls: string[] = [];
    const { bridge, client } = await setup({
      toolExecutor: async (_name, _input, _output, id) => {
        calls.push(id!);
        return { content: id!, isError: false };
      },
    });
    await authorize(bridge, "tool-first");
    await authorize(bridge, "tool-second");
    const [second, first] = await Promise.all([
      invoke(client, "tool-second"),
      invoke(client, "tool-first"),
    ]);
    expect(calls).toEqual(["tool-second", "tool-first"]);
    expect(second.content).toEqual([{ type: "text", text: "tool-second" }]);
    expect(first.content).toEqual([{ type: "text", text: "tool-first" }]);
  });
  test("coalesces in-flight retries and finished replays exactly once", async () => {
    const gate = deferred();
    let executions = 0;
    let finalizations = 0;
    let resultEvents = 0;
    const { bridge, client } = await setup({
      toolExecutor: async () => {
        executions += 1;
        await gate.promise;
        return { content: "once", isError: false };
      },
      finalizeToolResult: async (_call, result) => {
        finalizations += 1;
        return result;
      },
      onToolResult: () => {
        resultEvents += 1;
      },
    });
    await authorize(bridge);
    await authorize(bridge);
    const first = invoke(client);
    const second = invoke(client);
    gate.resolve();
    expect(await first).toEqual(await second);
    expect(await invoke(client)).toEqual(await first);
    expect([executions, finalizations, resultEvents]).toEqual([1, 1, 1]);
  });
  test("rejects builtins and lookalike configured MCP provenance", async () => {
    const { bridge } = await setup();
    for (const extra of [
      { tool_name: "Bash" },
      { mcp_server: { name: "vellum", source: "project" } },
      { mcp_server: undefined },
      { mcp_server: { name: "other", source: "sdk" } },
      { tool_name: "mcp__vellum__missing" },
    ]) {
      expect(await authorize(bridge, "tool-123", {}, extra)).toMatchObject(
        denied,
      );
    }
  });
  test("rejects missing registration, metadata, changed inputs, and changed names", async () => {
    let executions = 0;
    const { bridge, client } = await setup({
      toolExecutor: async () => {
        executions += 1;
        return { content: "bad", isError: false };
      },
    });
    expect((await invoke(client)).isError).toBe(true);
    await authorize(bridge);
    expect(
      (
        await client.callTool({
          name: "example_tool",
          arguments: { value: "example" },
        })
      ).isError,
    ).toBe(true);
    expect(
      (await invoke(client, "tool-123", { value: "changed" })).isError,
    ).toBe(true);
    expect(
      (await invoke(client, "tool-123", { value: "example" }, "unknown"))
        .isError,
    ).toBe(true);
    expect(executions).toBe(0);
  });
  test("rejects non-JSON inputs and conflicting IDs at the hook boundary", async () => {
    const { bridge } = await setup();
    expect(
      await authorize(bridge, "tool-123", { value: undefined }),
    ).toMatchObject(denied);
    await authorize(bridge);
    expect(
      await authorize(bridge, "tool-123", { value: "changed" }),
    ).toMatchObject(denied);
    expect(
      await authorize(
        bridge,
        "tool-123",
        { value: "example" },
        { tool_use_id: "different" },
      ),
    ).toMatchObject(denied);
  });
  test("cancellation during the runtime barrier never starts side effects", async () => {
    const started = deferred();
    const barrier = deferred();
    const controller = new AbortController();
    let executions = 0;
    const { bridge, client } = await setup({
      signal: controller.signal,
      onToolStart: async () => {
        started.resolve();
        await barrier.promise;
      },
      toolExecutor: async () => {
        executions += 1;
        return { content: "bad", isError: false };
      },
    });
    await authorize(bridge);
    const result = invoke(client);
    await started.promise;
    controller.abort();
    barrier.resolve();
    expect((await result).isError).toBe(true);
    expect(executions).toBe(0);
    expect(await authorize(bridge, "another-id")).toMatchObject(denied);
  });
  test("cancelled hook authorization cannot execute later", async () => {
    const controller = new AbortController();
    let executions = 0;
    const { bridge, client } = await setup({
      toolExecutor: async () => {
        executions += 1;
        return { content: "bad", isError: false };
      },
    });
    await authorize(
      bridge,
      "tool-123",
      { value: "example" },
      {},
      controller.signal,
    );
    controller.abort();
    expect((await invoke(client)).isError).toBe(true);
    expect(executions).toBe(0);
  });
  test("aborting a pending runtime barrier emits one cancellation result without waiting", async () => {
    const started = deferred();
    const controller = new AbortController();
    let finalized = 0;
    let resultEvents = 0;
    const { bridge, client } = await setup({
      signal: controller.signal,
      onToolStart: async () => {
        started.resolve();
        await new Promise(() => {});
      },
      finalizeToolResult: async (_call, result) => {
        finalized += 1;
        return result;
      },
      onToolResult: (_call, result) => {
        resultEvents += 1;
        expect(result.isError).toBe(true);
      },
      toolExecutor: async () => {
        throw new Error("must not execute");
      },
    });
    await authorize(bridge);
    const result = invoke(client);
    await started.promise;
    controller.abort();
    expect((await result).isError).toBe(true);
    await bridge.settle();
    expect([finalized, resultEvents]).toEqual([1, 1]);
  });

  test("settle waits for dispatched work and retains genuine results after cancellation", async () => {
    const started = deferred();
    const gate = deferred();
    const controller = new AbortController();
    let completed = false;
    let settled = false;
    const { bridge, client } = await setup({
      signal: controller.signal,
      toolExecutor: async () => {
        started.resolve();
        await gate.promise;
        return { content: "actually completed", isError: false };
      },
      onToolResult: (_call, result) => {
        completed = true;
        expect(result.content).toBe("actually completed");
      },
    });
    await authorize(bridge);
    const result = invoke(client);
    await started.promise;
    controller.abort();
    const draining = bridge.settle().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await draining;
    expect(completed).toBe(true);
    expect((await result).isError).toBe(false);
  });

  test("executor input repairs do not change the authorized replay identity", async () => {
    let executions = 0;
    const { bridge, client } = await setup({
      toolExecutor: async (_name, input) => {
        executions += 1;
        input.value = "repaired";
        return { content: "done", isError: false };
      },
    });
    await authorize(bridge);
    const result = await invoke(client);
    await authorize(bridge);
    expect(await invoke(client)).toEqual(result);
    expect(executions).toBe(1);
  });

  test("tool errors are memoized without exposing thrown secrets", async () => {
    let executions = 0;
    const { bridge, client } = await setup({
      toolExecutor: async () => {
        executions += 1;
        throw new Error("sensitive executor details");
      },
    });
    await authorize(bridge);
    const result = await invoke(client);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sensitive executor details");
    expect(await invoke(client)).toEqual(result);
    expect(executions).toBe(1);
  });
  test("preserves text, images, and file resources without exposing internal blocks", async () => {
    const { bridge, client } = await setup({
      toolExecutor: async () => ({
        content: "Summary",
        isError: false,
        sensitiveBindings: [
          {
            kind: "invite_code",
            placeholder: "PLACEHOLDER",
            value: "private-value",
          },
        ],
        contentBlocks: [
          { type: "text", text: "Details" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "YWJj" },
          },
          {
            type: "file",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "YWJj",
            },
          },
          {
            type: "file",
            source: { type: "base64", media_type: "text/plain", data: "YWJj" },
            extracted_text: "Document text",
          },
          {
            type: "thinking",
            thinking: "private reasoning",
            signature: "example-signature",
          },
          {
            type: "ui_surface",
            surfaceId: "surface-123",
            surfaceType: "example",
            data: { secret: "private UI state" },
          },
        ],
      }),
    });
    await authorize(bridge);
    const result = CallToolResultSchema.parse(await invoke(client));
    expect(result.content).toEqual([
      { type: "text", text: "Summary" },
      { type: "text", text: "Details" },
      { type: "image", data: "YWJj", mimeType: "image/png" },
      {
        type: "resource",
        resource: {
          uri: "vellum-tool-result:///tool-123/2",
          mimeType: "application/pdf",
          blob: "YWJj",
        },
      },
      {
        type: "resource",
        resource: {
          uri: "vellum-tool-result:///tool-123/3",
          mimeType: "text/plain",
          text: "Document text",
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("private");
  });
  test("retains structured executor metadata for runtime callbacks only", async () => {
    let seen = false;
    const { bridge, client } = await setup({
      toolExecutor: async () => ({
        content: "done",
        isError: true,
        yieldToUser: true,
        riskLevel: "high",
      }),
      onToolResult: (call, result) => {
        seen = true;
        expect(call.id).toBe("tool-123");
        expect(result.yieldToUser).toBe(true);
        expect(result.riskLevel).toBe("high");
      },
    });
    await authorize(bridge);
    expect(await invoke(client)).toEqual({
      content: [{ type: "text", text: "done" }],
      isError: true,
    });
    expect(seen).toBe(true);
  });
});
