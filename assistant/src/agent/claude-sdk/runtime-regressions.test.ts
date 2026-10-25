import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  Options,
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultSuccess,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { assertNotLiveDb } from "../../__tests__/assert-not-live-db.js";
import { getConfig } from "../../config/loader.js";
import { getToolResultFilePath } from "../../context/post-turn-tool-result-truncation.js";
import type { Conversation } from "../../daemon/conversation.js";
import {
  registerPluginHooks,
  unregisterPluginHooks,
} from "../../hooks/registry.js";
import type {
  PostModelCallContext,
  PostToolUseContext,
} from "../../hooks/types.js";
import type { PluginHooks } from "../../plugins/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import type { AgentEvent, LoopToolExecutor } from "../loop.js";
import { type ClaudeSdkRunOptions, runClaudeSdkAgent } from "./runtime.js";

const uuid = "00000000-0000-4000-8000-000000000001";
const pluginName = "test-claude-runtime-regressions";
const initialUsage: SDKResultSuccess["usage"] = {
  input_tokens: 2,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: {
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 0,
  },
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: "standard",
  inference_geo: "not_available",
  iterations: [],
  speed: "standard",
};

function result(): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "Final answer",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: { ...initialUsage, input_tokens: 999, output_tokens: 999 },
    modelUsage: {},
    permission_denials: [],
    uuid,
    session_id: uuid,
  };
}

function partial(
  event: SDKPartialAssistantMessage["event"],
): SDKPartialAssistantMessage {
  return {
    type: "stream_event",
    event,
    uuid,
    session_id: uuid,
    parent_tool_use_id: null,
  };
}

function assistantFrame(
  id: string,
  content: SDKAssistantMessage["message"]["content"],
): SDKAssistantMessage {
  return {
    type: "assistant",
    uuid,
    session_id: uuid,
    parent_tool_use_id: null,
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-fixture",
      content,
      usage: initialUsage,
      stop_reason: null,
      stop_sequence: null,
      container: null,
      context_management: null,
      stop_details: null,
    },
  };
}

function messageStart(id: string): SDKPartialAssistantMessage {
  return partial({
    type: "message_start",
    message: assistantFrame(id, []).message,
  });
}

function* textBlocks(id: string, parts: string[]): Generator<SDKMessage> {
  yield messageStart(id);
  for (const [index, text] of parts.entries()) {
    yield partial({
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "", citations: [] },
    });
    yield partial({
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    });
    yield partial({ type: "content_block_stop", index });
    yield assistantFrame(id, [{ type: "text", text, citations: [] }]);
  }
  yield partial({
    type: "message_delta",
    context_management: null,
    delta: {
      stop_reason: "end_turn",
      stop_sequence: null,
      container: null,
      stop_details: null,
    },
    usage: {
      input_tokens: 7,
      output_tokens: 17,
      cache_creation_input_tokens: 11,
      cache_read_input_tokens: 13,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      iterations: [],
    },
  });
  yield partial({ type: "message_stop" });
}

function* toolFrames(
  id: string,
  name = "first_tool",
  args = { value: "original" },
): Generator<SDKMessage> {
  yield messageStart(`message-${id}`);
  yield partial({
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "tool_use",
      id,
      name: `mcp__vellum__${name}`,
      input: {},
    },
  });
  yield partial({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
  });
  yield partial({ type: "content_block_stop", index: 0 });
  yield partial({ type: "message_stop" });
}

function definition(name: string): ToolDefinition {
  return {
    name,
    description: `Fixture ${name}`,
    input_schema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];
let previousSdkConfig: ReturnType<typeof getConfig>["llm"]["claudeAgentSdk"];
beforeEach(() => {
  previousSdkConfig = getConfig().llm.claudeAgentSdk;
  getConfig().llm.claudeAgentSdk = {
    executablePath: "/tmp/claude-regression-fixture",
  };
});
afterEach(async () => {
  unregisterPluginHooks(pluginName);
  getConfig().llm.claudeAgentSdk = previousSdkConfig;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function registerHooks(hooks: PluginHooks): void {
  registerPluginHooks(pluginName, hooks);
}

interface TransportContext {
  options: Options;
  nextPrompt: () => Promise<IteratorResult<SDKUserMessage>>;
}

type ServerSet = Parameters<Query["setMcpServers"]>[0];
function transport(
  sequence: (context: TransportContext) => AsyncGenerator<SDKMessage>,
) {
  const events: AgentEvent[] = [];
  const prompts: SDKUserMessage[] = [];
  const sdkOptions: Options[] = [];
  const close = mock(() => {});
  const interrupt = mock<Query["interrupt"]>(async () => undefined);
  const refresh = mock(async (_servers: ServerSet) => ({
    added: [],
    removed: [],
    errors: {},
  }));
  const execute = mock<LoopToolExecutor>(async () => ({
    content: "Performed once",
    isError: false,
  }));
  const options: ClaudeSdkRunOptions = {
    run: {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Complete the requested task" }],
        },
      ],
      onEvent: (event) => {
        events.push(event);
      },
      requestId: "regression-request",
      callSite: "mainAgent",
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    },
    conversationId: "sdk-runtime-regression",
    conversationDir: null,
    systemPrompt: "Fixture instructions",
    tools: [definition("first_tool")],
    toolExecutor: execute,
    model: "sonnet",
    maxTokens: 4096,
    preflight: async ({ executablePath, env }) => ({
      ok: true,
      executablePath,
      env: env ?? {},
    }),
    query: ({ prompt, options }) => {
      sdkOptions.push(options);
      const iterator = prompt[Symbol.asyncIterator]();
      const nextPrompt = async () => {
        const next = await iterator.next();
        if (!next.done) {
          prompts.push(next.value);
        }
        return next;
      };
      return {
        close,
        interrupt,
        setMcpServers: refresh,
        async *[Symbol.asyncIterator]() {
          await nextPrompt();
          yield* sequence({ options, nextPrompt });
        },
      };
    },
  };
  return {
    options,
    events,
    prompts,
    sdkOptions,
    close,
    interrupt,
    refresh,
    execute,
  };
}

async function connect(
  server: NonNullable<Options["mcpServers"]>[string] | undefined,
) {
  if (!server || server.type !== "sdk") {
    throw new Error("Missing in-process server");
  }
  const client = new Client({ name: "runtime-regressions", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.instance.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  cleanups.push(() => client.close());
  return client;
}

async function authorize(
  options: Options,
  id: string,
  name = "first_tool",
  args = { value: "original" },
) {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
  if (!hook) {
    throw new Error("Missing PreToolUse hook");
  }
  return hook(
    {
      hook_event_name: "PreToolUse",
      session_id: uuid,
      transcript_path: "/tmp/fixture-not-read.jsonl",
      cwd: "/tmp",
      tool_name: `mcp__vellum__${name}`,
      tool_input: args,
      tool_use_id: id,
      mcp_server: { name: "vellum", source: "sdk" },
    },
    id,
    { signal: new AbortController().signal },
  );
}

function invoke(
  client: Client,
  id: string,
  name = "first_tool",
  args = { value: "original" },
) {
  return client.callTool({
    name,
    arguments: args,
    _meta: { "claudecode/toolUseId": id },
  });
}

async function checkpoint(options: Options) {
  const outputs: unknown[] = [];
  for (const matcher of options.hooks?.PostToolBatch ?? []) {
    for (const hook of matcher.hooks) {
      outputs.push(
        await hook(
          {
            hook_event_name: "PostToolBatch",
            tool_calls: [],
            session_id: uuid,
            transcript_path: "/tmp/fixture-not-read.jsonl",
            cwd: "/tmp",
          },
          undefined,
          { signal: new AbortController().signal },
        ),
      );
    }
  }
  return outputs;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function visibleText(events: AgentEvent[]): string {
  return events
    .flatMap((event) => (event.type === "text_delta" ? [event.text] : []))
    .join("");
}

describe("Claude SDK root runtime regressions", () => {
  test("partial assistant frames do not split multi-block canonical messages or duplicate usage", async () => {
    const f = transport(async function* () {
      yield* textBlocks("multi-block", [
        "First paragraph. ",
        "Second paragraph.",
      ]);
      yield result();
    });
    const output = await runClaudeSdkAgent(f.options);
    expect(output.error).toBeUndefined();
    expect(output.newMessages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "First paragraph. " },
          { type: "text", text: "Second paragraph." },
        ],
      },
    ]);
    expect(
      f.events.filter((event) => event.type === "message_complete"),
    ).toHaveLength(1);
    expect(
      f.events.filter((event) => event.type === "llm_call_started"),
    ).toHaveLength(1);
    const usage = f.events.filter((event) => event.type === "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      inputTokens: 31,
      outputTokens: 17,
      cacheCreationInputTokens: 11,
      cacheReadInputTokens: 13,
      actualProvider: "claude-agent-sdk",
    });
    expect(visibleText(f.events)).toBe("First paragraph. Second paragraph.");
  });

  test("private thinking stays out of streamed events and the final fallback is emitted once", async () => {
    const f = transport(async function* () {
      yield messageStart("private-thinking");
      yield partial({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      yield partial({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Private reasoning" },
      });
      yield partial({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "signed" },
      });
      yield partial({ type: "content_block_stop", index: 0 });
      yield assistantFrame("private-thinking", [
        {
          type: "thinking",
          thinking: "Private reasoning",
          signature: "signed",
        },
      ]);
      yield partial({
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "", citations: [] },
      });
      yield partial({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Public answer" },
      });
      yield partial({ type: "content_block_stop", index: 1 });
      yield assistantFrame("private-thinking", [
        { type: "text", text: "Public answer", citations: [] },
      ]);
      yield partial({ type: "message_stop" });
      yield result();
    });
    f.options.run.suppressAssistantText = true;
    const output = await runClaudeSdkAgent(f.options);
    expect(output.error).toBeUndefined();
    expect(f.events.some((event) => event.type === "thinking_delta")).toBe(
      false,
    );
    expect(visibleText(f.events)).toBe("Public answer");
    expect(output.newMessages[0]?.content).toEqual([
      { type: "text", text: "Public answer" },
    ]);
    expect(
      f.events.find((event) => event.type === "message_complete"),
    ).toMatchObject({ assistantTextVisibility: "visible" });
    expect(JSON.stringify(f.events)).not.toContain("Private reasoning");
  });

  test("duplicate MCP deliveries execute one action and emit one canonical result", async () => {
    const f = transport(async function* ({ options }) {
      yield* toolFrames("once");
      const client = await connect(options.mcpServers?.vellum);
      await authorize(options, "once");
      const [first, duplicate] = await Promise.all([
        invoke(client, "once"),
        invoke(client, "once"),
      ]);
      expect(duplicate).toEqual(first);
      yield* textBlocks("reply", ["Finished"]);
      yield result();
    });
    const output = await runClaudeSdkAgent(f.options);
    expect(output.error).toBeUndefined();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.events.filter((event) => event.type === "tool_use")).toHaveLength(
      1,
    );
    expect(
      f.events.filter((event) => event.type === "tool_result"),
    ).toHaveLength(1);
    expect(
      output.newMessages
        .flatMap((message) => message.content)
        .filter((block) => block.type === "tool_result"),
    ).toHaveLength(1);
  });

  test("successful oversized-result spooling passes the saved stub through hooks and history", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sdk-runtime-spool-success-"),
    );
    cleanups.push(async () => {
      assertNotLiveDb(directory);
      await rm(directory, { recursive: true, force: true });
    });
    const content = "Completed large result. ".repeat(1500);
    let hookContent: unknown;
    registerHooks({
      "post-tool-use": async (context: PostToolUseContext) => {
        hookContent = context.toolResponse.content;
      },
    });
    const f = transport(async function* ({ options }) {
      yield* toolFrames("spool-success");
      const client = await connect(options.mcpServers?.vellum);
      await authorize(options, "spool-success");
      const delivered = await invoke(client, "spool-success");
      expect(delivered.isError).toBe(false);
      expect(delivered.content).toEqual([{ type: "text", text: hookContent }]);
      yield* textBlocks("after-spool", ["Finished"]);
      yield result();
    });
    f.options.conversationDir = directory;
    f.execute.mockImplementation(async () => ({ content, isError: false }));
    const output = await runClaudeSdkAgent(f.options);
    expect(output.error).toBeUndefined();
    expect(typeof hookContent).toBe("string");
    expect((hookContent as string).length).toBeLessThan(content.length);
    expect(hookContent).toContain(".tool-results");
    expect(
      await readFile(getToolResultFilePath(directory, "spool-success"), "utf8"),
    ).toBe(content);
    expect(JSON.stringify(output.newMessages)).not.toContain(content);
    expect(f.events.filter((event) => event.type === "tool_result")).toEqual([
      expect.objectContaining({ content: hookContent, isError: false }),
    ]);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  test("a failed oversized-result spool preserves the completed result without repeating the tool", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sdk-runtime-spool-"));
    cleanups.push(async () => {
      assertNotLiveDb(directory);
      await rm(directory, { recursive: true, force: true });
    });
    // A file where the spool directory belongs deterministically rejects mkdir.
    await writeFile(join(directory, ".tool-results"), "not a directory");
    const content = "Completed side effect. ".repeat(1500);
    const f = transport(async function* ({ options }) {
      yield* toolFrames("spool-failure");
      const client = await connect(options.mcpServers?.vellum);
      await authorize(options, "spool-failure");
      const first = await invoke(client, "spool-failure");
      const repeated = await invoke(client, "spool-failure");
      expect(first.isError).toBe(false);
      expect(first.content).toEqual([{ type: "text", text: content }]);
      expect(repeated).toEqual(first);
      yield* textBlocks("after-tool", ["Finished"]);
      yield result();
    });
    f.options.conversationDir = directory;
    f.execute.mockImplementation(async () => ({ content, isError: false }));
    const output = await runClaudeSdkAgent(f.options);
    expect(output.error).toBeUndefined();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.events.filter((event) => event.type === "tool_result")).toEqual([
      expect.objectContaining({
        toolUseId: "spool-failure",
        content,
        isError: false,
      }),
    ]);
    expect(JSON.stringify(output.newMessages)).not.toContain(
      "may have taken effect",
    );
    expect(JSON.stringify(output.newMessages)).toContain(content);
  });

  test("a late executor result cannot rewrite an aborted turn or repeat its side effect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sdk-runtime-abort-"));
    cleanups.push(async () => {
      assertNotLiveDb(directory);
      await rm(directory, { recursive: true, force: true });
    });
    const started = deferred();
    const release = deferred();
    const executed = deferred();
    const abort = new AbortController();
    const deliveries: Promise<unknown>[] = [];
    const f = transport(async function* ({ options }) {
      yield* toolFrames("late");
      const client = await connect(options.mcpServers?.vellum);
      await authorize(options, "late");
      deliveries.push(
        invoke(client, "late").catch(() => undefined),
        invoke(client, "late").catch(() => undefined),
      );
      await started.promise;
      abort.abort();
      yield result();
    });
    f.options.conversationDir = directory;
    f.options.run.signal = abort.signal;
    f.execute.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      executed.resolve();
      return { content: "Late completed side effect", isError: false };
    });
    try {
      const output = await runClaudeSdkAgent(f.options);
      expect(output.reason).toBe("aborted_via_error");
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(
        f.events.filter((event) => event.type === "tool_result"),
      ).toHaveLength(1);
      expect(
        f.events.find((event) => event.type === "tool_result"),
      ).toMatchObject({ cancelled: true, isError: true, toolUseId: "late" });
      expect(JSON.stringify(output.newMessages)).toContain(
        "may have taken effect",
      );
      const recorded = JSON.stringify(output.newMessages);
      const eventCount = f.events.length;
      release.resolve();
      await executed.promise;
      await Promise.all(deliveries);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(JSON.stringify(output.newMessages)).toBe(recorded);
      expect(f.events).toHaveLength(eventCount);
      expect(f.execute).toHaveBeenCalledTimes(1);
      const state: unknown = JSON.parse(
        await readFile(join(directory, ".claude-sdk-session.json"), "utf8"),
      );
      expect(state).toMatchObject({ inFlight: true });
      const retry = transport(async function* () {
        yield* textBlocks("must-not-run", ["Repeated"]);
        yield result();
      });
      retry.options.conversationDir = directory;
      const retried = await runClaudeSdkAgent(retry.options);
      expect(retried.reason).toBe("error");
      expect(retried.error?.message).toContain(
        "cannot be replayed automatically",
      );
      expect(retry.sdkOptions).toHaveLength(0);
      expect(retry.execute).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
  }, 10_000);

  test("dynamic tools remove the previous server before adding and authorizing the replacement", async () => {
    const sent: string[][] = [];
    const f = transport(async function* ({ options }) {
      yield* toolFrames("first");
      const original = await connect(options.mcpServers?.vellum);
      await authorize(options, "first");
      await invoke(original, "first");
      await checkpoint(options);
      expect(f.refresh).toHaveBeenCalledTimes(2);
      expect(f.refresh.mock.calls[0]?.[0]).toEqual({});
      const replacement = f.refresh.mock.calls[1]?.[0]?.vellum;
      const current = await connect(replacement);
      expect(
        (await current.listTools()).tools.map((tool) => tool.name),
      ).toEqual(["second_tool"]);
      expect(await authorize(options, "removed", "first_tool")).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      yield* toolFrames("second", "second_tool");
      expect(await authorize(options, "second", "second_tool")).toMatchObject({
        hookSpecificOutput: { permissionDecision: "allow" },
      });
      await invoke(current, "second", "second_tool");
      yield* textBlocks("reply", ["Finished"]);
      yield result();
    });
    f.options.resolveTools = () => [definition("second_tool")];
    f.options.onToolsSent = (tools) => {
      sent.push(tools.map((tool) => tool.name));
    };
    const output = await runClaudeSdkAgent(f.options);
    expect(output.error).toBeUndefined();
    expect(f.execute.mock.calls.map((call) => call[0])).toEqual([
      "first_tool",
      "second_tool",
    ]);
    expect(sent).toEqual([["first_tool"], ["second_tool"]]);
  });

  test("post-model hooks transform deferred output before it becomes visible", async () => {
    registerHooks({
      "post-model-call": async (context: PostModelCallContext) => {
        context.content = context.content.map((block) =>
          block.type === "text"
            ? {
                ...block,
                text: block.text.replace("private value", "[redacted]"),
              }
            : block,
        );
      },
    });
    const f = transport(async function* () {
      yield* textBlocks("redact", ["The private value is hidden"]);
      yield result();
    });
    f.options.deferAssistantOutput = true;
    const output = await runClaudeSdkAgent(f.options);
    expect(output.error).toBeUndefined();
    expect(visibleText(f.events)).toBe("The [redacted] is hidden");
    expect(output.newMessages).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "The [redacted] is hidden" }],
      },
    ]);
  });

  test("post-model tool edits reach the executor while post-tool guidance remains model-only", async () => {
    registerHooks({
      "post-model-call": async (context: PostModelCallContext) => {
        for (const block of context.content) {
          if (block.type === "tool_use") {
            block.input = { value: "approved-by-hook" };
          }
        }
      },
      "post-tool-use": async (context: PostToolUseContext) => {
        context.toolResponse.content = "Hook-transformed result";
        context.additionalContext = "Hook context";
      },
    });
    const f = transport(async function* ({ options }) {
      yield* toolFrames("hooked");
      const client = await connect(options.mcpServers?.vellum);
      await authorize(options, "hooked");
      const response = await invoke(client, "hooked");
      expect(response.content).toEqual([
        { type: "text", text: "Hook-transformed result" },
      ]);
      expect(await checkpoint(options)).toEqual([
        {
          hookSpecificOutput: {
            hookEventName: "PostToolBatch",
            additionalContext: "Hook context",
          },
        },
      ]);
      expect(await checkpoint(options)).toEqual([{}]);
      yield* textBlocks("reply", ["Finished"]);
      yield result();
    });
    const output = await runClaudeSdkAgent(f.options);
    expect(output.error).toBeUndefined();
    expect(f.execute.mock.calls[0]?.[1]).toEqual({ value: "approved-by-hook" });
    expect(
      f.events.find((event) => event.type === "tool_result"),
    ).toMatchObject({ content: "Hook-transformed result" });
    expect(output.newMessages[1]?.content[0]).toMatchObject({
      type: "tool_result",
      content: "Hook-transformed result",
    });
    expect(JSON.stringify(output.newMessages)).not.toContain("Hook context");
    expect(JSON.stringify(f.events)).not.toContain("Hook context");
  });

  test("post-model continuation gets a second SDK input without leaking the discarded reply", async () => {
    let calls = 0;
    registerHooks({
      "post-model-call": async (context: PostModelCallContext) => {
        if (++calls === 1) {
          context.decision = "continue";
          context.messages.push({
            role: "user",
            content: [{ type: "text", text: "Check the answer again" }],
          });
        }
      },
    });
    const f = transport(async function* ({ nextPrompt }) {
      yield* textBlocks("discarded", ["Discarded answer"]);
      yield result();
      expect((await nextPrompt()).done).toBe(false);
      yield* textBlocks("final", ["Verified answer"]);
      yield result();
    });
    f.options.deferAssistantOutput = true;
    const output = await runClaudeSdkAgent(f.options);
    expect(output.error).toBeUndefined();
    expect(f.prompts).toHaveLength(2);
    expect(JSON.stringify(f.prompts[1])).toContain("Check the answer again");
    expect(visibleText(f.events)).toBe("Verified answer");
    expect(output.newMessages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Check the answer again" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Verified answer" }],
      },
    ]);
  });

  test("a restarted root runtime resumes from canonical history and sends only appended input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sdk-runtime-resume-"));
    cleanups.push(async () => {
      assertNotLiveDb(directory);
      await rm(directory, { recursive: true, force: true });
    });
    const first = transport(async function* () {
      yield* textBlocks("first-reply", ["First answer"]);
      yield result();
    });
    first.options.conversationDir = directory;
    first.options.canonicalMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "Original canonical request" }],
      },
    ];
    const initial = await runClaudeSdkAgent(first.options);
    expect(initial.error).toBeUndefined();
    expect(initial.history[0]).toEqual(first.options.canonicalMessages[0]);
    expect(JSON.stringify(first.prompts[0])).toContain(
      "Complete the requested task",
    );
    expect(first.sdkOptions[0]?.sessionId).toBeDefined();
    const second = transport(async function* () {
      yield* textBlocks("second-reply", ["Second answer"]);
      yield result();
    });
    second.options.conversationDir = directory;
    second.options.canonicalMessages = [
      ...initial.history,
      { role: "user", content: [{ type: "text", text: "New user request" }] },
    ];
    second.options.run.messages = second.options.canonicalMessages.map(
      (message, index) =>
        index === 0
          ? {
              role: "user",
              content: [
                { type: "text", text: "Different transport sanitization" },
              ],
            }
          : message,
    );
    const resumed = await runClaudeSdkAgent(second.options);
    expect(resumed.error).toBeUndefined();
    expect(second.sdkOptions[0]?.resume).toBe(first.sdkOptions[0]?.sessionId);
    expect(second.sdkOptions[0]?.sessionId).toBeUndefined();
    expect(JSON.stringify(second.prompts[0])).toContain("New user request");
    expect(JSON.stringify(second.prompts[0])).not.toContain(
      "Original canonical request",
    );
    expect(JSON.stringify(second.prompts[0])).not.toContain(
      "Different transport sanitization",
    );
    expect(JSON.stringify(second.prompts[0])).not.toContain("First answer");
    expect(resumed.history).toHaveLength(4);
  });

  test("foreground helper foreground keeps one native session with appended-only requests", async () => {
    const { createResolveToolsCallback } =
      await import("../../daemon/conversation-tool-setup.js");
    const { asConversation } =
      await import("../../__tests__/helpers/mock-conversation.js");
    const directory = await mkdtemp(join(tmpdir(), "sdk-presence-continuity-"));
    cleanups.push(async () => {
      assertNotLiveDb(directory);
      await rm(directory, { recursive: true, force: true });
    });
    const ctx: Conversation = asConversation({
      conversationId: "sdk-presence-fixture",
      transportInterface: "web",
      clientOs: "macos",
      currentTurnClientOs: "macos",
      currentTurnIsNonInteractive: false,
      toolsDisabledDepth: 0,
      skillProjectionState: new Map(),
      skillProjectionCache: { fingerprints: new Map() },
      getTurnActorPrincipalId: () => undefined,
    });
    Object.defineProperty(ctx, "hasNoClient", {
      get: () => ctx.currentTurnIsNonInteractive ?? true,
    });
    const resolve = createResolveToolsCallback(
      [
        definition("first_tool"),
        definition("ask_question"),
        definition("request_system_permission"),
      ],
      ctx,
    )!;
    const first = transport(async function* ({ options }) {
      yield* toolFrames("original-action");
      const client = await connect(options.mcpServers?.vellum);
      await authorize(options, "original-action");
      await invoke(client, "original-action");
      yield* textBlocks("first-reply", ["First complete"]);
      yield result();
    });
    first.options.tools = resolve([]);
    first.options.conversationDir = directory;
    const firstOutput = await runClaudeSdkAgent(first.options);
    expect(firstOutput.error).toBeUndefined();
    expect(first.execute).toHaveBeenCalledTimes(1);
    const sessionId = first.sdkOptions[0]?.sessionId;
    expect(sessionId).toBeDefined();
    let history = firstOutput.history;
    const firstPrefix = JSON.stringify(history);
    for (const [nonInteractive, text] of [
      [
        true,
        "Helper completed\n<non_interactive_context>Do not ask questions.</non_interactive_context>",
      ],
      [false, "Next foreground request"],
    ] as const) {
      ctx.currentTurnIsNonInteractive = nonInteractive;
      const next = transport(async function* () {
        yield* textBlocks("continuation-reply", ["Continued"]);
        yield result();
      });
      const prefix = JSON.stringify(history);
      next.options.tools = resolve(history);
      next.options.conversationDir = directory;
      next.options.canonicalMessages = [
        ...history,
        { role: "user", content: [{ type: "text", text }] },
      ];
      next.options.run.messages = next.options.canonicalMessages;
      const output = await runClaudeSdkAgent(next.options);
      expect(output.error).toBeUndefined();
      expect(next.sdkOptions[0]?.resume).toBe(sessionId);
      expect(next.sdkOptions[0]?.sessionId).toBeUndefined();
      expect(JSON.stringify(next.options.tools)).toBe(
        JSON.stringify(first.options.tools),
      );
      expect(JSON.stringify(next.prompts[0])).toContain(text.split("\n")[0]!);
      expect(JSON.stringify(next.prompts[0])).not.toContain("original-action");
      expect(JSON.stringify(next.prompts[0])).not.toContain(
        "Complete the requested task",
      );
      expect(JSON.stringify(history)).toBe(prefix);
      expect(next.execute).not.toHaveBeenCalled();
      history = output.history;
    }
    expect(JSON.stringify(history.slice(0, firstOutput.history.length))).toBe(
      firstPrefix,
    );
  });

  test.each([
    "ui-decoration",
    "same-role-regrouping",
    "changed-user-text",
    "changed-tool-result",
  ] as const)(
    "runtime history continuity handles %s without replaying old actions",
    async (mode) => {
      const { repairHistory } =
        await import("../history-repair/history-repair.js");
      const directory = await sessionDirectory("sdk-history-continuity-");
      const first = transport(async function* ({ options }) {
        yield* toolFrames("already-performed-action");
        const client = await connect(options.mcpServers?.vellum);
        await authorize(options, "already-performed-action");
        await invoke(client, "already-performed-action");
        yield* textBlocks("first-answer", ["First answer"]);
        yield* textBlocks("second-answer", ["Second answer"]);
        yield result();
      });
      first.options.conversationDir = directory;
      const initial = await runClaudeSdkAgent(first.options);
      expect(initial.error).toBeUndefined();
      expect(first.execute).toHaveBeenCalledTimes(1);
      const initialSnapshot = JSON.stringify(initial.history);
      let edited = structuredClone(initial.history);
      const shouldResume =
        mode === "ui-decoration" || mode === "same-role-regrouping";
      if (mode === "ui-decoration") {
        edited.at(-1)!.content.unshift({
          type: "ui_surface",
          surfaceId: "display-only-progress",
          surfaceType: "card",
          data: { status: "completed" },
        });
      } else if (mode === "same-role-regrouping") {
        const repaired = repairHistory(edited);
        expect(repaired.stats.consecutiveSameRoleMerged).toBeGreaterThan(0);
        edited = repaired.messages;
      } else if (mode === "changed-user-text") {
        edited[0]!.content = [
          { type: "text", text: "A genuinely different original request" },
        ];
      } else {
        const toolResult = edited
          .flatMap((message) => message.content)
          .find((block) => block.type === "tool_result");
        expect(toolResult).toBeDefined();
        if (!toolResult || toolResult.type !== "tool_result") {
          throw new Error("Missing fixture tool result");
        }
        toolResult.content = "A genuinely different result";
      }
      const second = transport(async function* () {
        yield* textBlocks("next-answer", ["Continued safely"]);
        yield result();
      });
      second.options.conversationDir = directory;
      second.options.canonicalMessages = [
        ...edited,
        { role: "user", content: [{ type: "text", text: "Next request" }] },
      ];
      second.options.run.messages = second.options.canonicalMessages;
      const output = await runClaudeSdkAgent(second.options);
      expect(output.error).toBeUndefined();
      expect(second.execute).not.toHaveBeenCalled();
      expect(JSON.stringify(second.prompts[0])).toContain("Next request");
      expect(JSON.stringify(initial.history)).toBe(initialSnapshot);
      if (shouldResume) {
        expect(second.sdkOptions[0]?.resume).toBe(
          first.sdkOptions[0]?.sessionId,
        );
        expect(second.sdkOptions[0]?.sessionId).toBeUndefined();
        expect(JSON.stringify(second.prompts[0])).not.toContain(
          "already-performed-action",
        );
        expect(JSON.stringify(second.prompts[0])).not.toContain("First answer");
      } else {
        expect(second.sdkOptions[0]?.resume).toBeUndefined();
        expect(second.sdkOptions[0]?.sessionId).toBeDefined();
        expect(second.sdkOptions[0]?.sessionId).not.toBe(
          first.sdkOptions[0]?.sessionId,
        );
        expect(JSON.stringify(second.prompts[0])).toContain(
          "Past conversation context",
        );
      }
    },
  );

  test.each(["dirty", "fingerprint"] as const)(
    "a %s rebuild preserves a merged historical/current request boundary",
    async (mode) => {
      const directory = await sessionDirectory("sdk-rebuild-frontier-");
      const first = transport(async function* () {
        if (mode === "fingerprint") {
          yield result();
        }
      });
      first.options.conversationDir = directory;
      first.options.run.messages = [
        {
          role: "user",
          content: [{ type: "text", text: "Old action request" }],
        },
      ];
      await runClaudeSdkAgent(first.options);
      const second = transport(async function* () {
        yield* textBlocks("frontier-reply", ["No replay"]);
        yield result();
      });
      second.options.conversationDir = directory;
      second.options.run.messages = [
        {
          role: "user",
          content: [
            { type: "text", text: "Old action request" },
            { type: "ui_surface", surfaceId: "card", surfaceType: "card" },
            { type: "text", text: "Check what happened, do not repeat it" },
          ],
        },
      ];
      second.options.canonicalMessages = second.options.run.messages;
      if (mode === "fingerprint") {
        second.options.systemPrompt = "Changed fixture instructions";
      }
      const output = await runClaudeSdkAgent(second.options);
      expect(output.error).toBeUndefined();
      expect(second.sdkOptions[0]?.resume).toBeUndefined();
      expect(second.sdkOptions[0]?.sessionId).not.toBe(
        first.sdkOptions[0]?.sessionId,
      );
      const prompt = JSON.stringify(second.prompts[0]);
      expect(prompt).toContain("Old action request");
      expect(prompt.slice(prompt.indexOf("Current request:"))).not.toContain(
        "Old action request",
      );
      expect(prompt).toContain("Check what happened, do not repeat it");
      expect(second.execute).not.toHaveBeenCalled();
    },
  );

  test("a reshaped rebuild still sanitizes historical provider-only blocks", async () => {
    const { preModelCallSanitize } =
      await import("../../context/outbound-sanitize.js");
    const directory = await sessionDirectory("sdk-rebuild-sanitized-");
    const first = transport(async function* () {
      yield result();
    });
    first.options.conversationDir = directory;
    first.options.canonicalMessages = [
      { role: "user", content: [{ type: "text", text: "Old request" }] },
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "search-old",
            name: "web_search",
            input: { query: "fixture" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "search-old",
            content: [
              {
                type: "web_search_result",
                title: "Example",
                url: "https://example.com",
                encrypted_content: "expired-provider-token",
              },
            ],
          },
        ],
      },
    ];
    first.options.run.messages = preModelCallSanitize(
      first.options.canonicalMessages,
    );
    await runClaudeSdkAgent(first.options);
    const second = transport(async function* () {
      yield* textBlocks("sanitized-reply", ["Done"]);
      yield result();
    });
    second.options.conversationDir = directory;
    second.options.systemPrompt = "Changed fixture instructions";
    const canonical = structuredClone(first.options.canonicalMessages);
    canonical[1]!.content.unshift({
      type: "ui_surface",
      surfaceId: "display",
      surfaceType: "card",
    });
    second.options.canonicalMessages = [
      ...canonical,
      { role: "user", content: [{ type: "text", text: "New request" }] },
    ];
    second.options.run.messages = preModelCallSanitize(
      second.options.canonicalMessages,
    );
    const output = await runClaudeSdkAgent(second.options);
    expect(output.error).toBeUndefined();
    expect(JSON.stringify(second.prompts[0])).toContain(
      "Prior web_search results",
    );
    expect(JSON.stringify(second.prompts[0])).not.toContain(
      "expired-provider-token",
    );
    expect(JSON.stringify(output.history)).toContain("expired-provider-token");
    expect(second.execute).not.toHaveBeenCalled();
  });

  test("a failed tool-surface removal stops before exposing the replacement", async () => {
    const f = transport(async function* ({ options }) {
      yield* toolFrames("refresh-failure");
      const client = await connect(options.mcpServers?.vellum);
      await authorize(options, "refresh-failure");
      await invoke(client, "refresh-failure");
      await checkpoint(options);
      yield result();
    });
    f.options.resolveTools = () => [definition("second_tool")];
    f.refresh.mockImplementation(async () => ({
      added: [],
      removed: [],
      errors: { vellum: "Fixture refresh error" },
    }));
    const output = await runClaudeSdkAgent(f.options);
    expect(output.reason).toBe("error");
    expect(output.error?.message).toContain(
      "release the previous tool surface",
    );
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  test("a hook cannot rewrite already-consumed history inside a live SDK session", async () => {
    registerHooks({
      "post-model-call": async (context: PostModelCallContext) => {
        context.decision = "continue";
        context.messages = [
          {
            role: "user",
            content: [{ type: "text", text: "Rewritten old request" }],
          },
        ];
      },
    });
    const f = transport(async function* () {
      yield* textBlocks("discarded", ["Do not display"]);
      yield result();
    });
    f.options.deferAssistantOutput = true;
    const output = await runClaudeSdkAgent(f.options);
    expect(output.reason).toBe("error");
    expect(output.error?.message).toContain("history rewrite");
    expect(f.prompts).toHaveLength(1);
    expect(visibleText(f.events)).toBe("");
  });

  test("synthetic tool continuation includes private post-tool guidance only in SDK input", async () => {
    let modelCalls = 0;
    registerHooks({
      "post-model-call": async (context: PostModelCallContext) => {
        if (++modelCalls === 1) {
          context.content.push({
            type: "tool_use",
            id: "synthetic-call",
            name: "first_tool",
            input: { value: "synthetic" },
          });
        }
      },
      "post-tool-use": async (context: PostToolUseContext) => {
        context.additionalContext =
          "Private instruction for the next model call";
      },
    });
    const f = transport(async function* ({ nextPrompt }) {
      yield* textBlocks("before-synthetic", ["Checking"]);
      yield result();
      expect((await nextPrompt()).done).toBe(false);
      yield* textBlocks("after-synthetic", ["Checked"]);
      yield result();
    });
    const output = await runClaudeSdkAgent(f.options);
    expect(output.error).toBeUndefined();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0]?.[1]).toEqual({ value: "synthetic" });
    expect(f.prompts).toHaveLength(2);
    expect(JSON.stringify(f.prompts[1])).toContain("Performed once");
    expect(JSON.stringify(f.prompts[1])).toContain(
      "Private instruction for the next model call",
    );
    expect(JSON.stringify(output.history)).not.toContain(
      "Private instruction for the next model call",
    );
    expect(JSON.stringify(f.events)).not.toContain(
      "Private instruction for the next model call",
    );
  });

  test("cancelling a hung synthetic tool returns after the grace window and ignores its late result", async () => {
    registerHooks({
      "post-model-call": async (context: PostModelCallContext) => {
        context.content.push({
          type: "tool_use",
          id: "hung-synthetic",
          name: "first_tool",
          input: { value: "synthetic" },
        });
      },
    });
    const started = deferred();
    const release = deferred();
    const executed = deferred();
    const abort = new AbortController();
    const f = transport(async function* () {
      yield* textBlocks("before-cancel", ["Checking"]);
      yield result();
    });
    f.options.run.signal = abort.signal;
    f.execute.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      executed.resolve();
      return { content: "Late synthetic side effect", isError: false };
    });
    try {
      const running = runClaudeSdkAgent(f.options);
      await started.promise;
      abort.abort();
      const output = await running;
      expect(output.reason).toBe("aborted_via_error");
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(
        f.events.filter((event) => event.type === "tool_result"),
      ).toHaveLength(1);
      expect(
        f.events.find((event) => event.type === "tool_result"),
      ).toMatchObject({
        toolUseId: "hung-synthetic",
        cancelled: true,
        isError: true,
      });
      const recorded = JSON.stringify(output.newMessages);
      const eventCount = f.events.length;
      release.resolve();
      await executed.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(JSON.stringify(output.newMessages)).toBe(recorded);
      expect(f.events).toHaveLength(eventCount);
      expect(f.prompts).toHaveLength(1);
    } finally {
      release.resolve();
    }
  }, 10_000);

  test.each(["checkpoint", "synthetic-yield"] as const)(
    "a rejected interrupt during %s shutdown closes the query without an unhandled rejection",
    async (mode) => {
      const f = transport(async function* ({ options }) {
        yield* toolFrames("shutdown-race");
        const client = await connect(options.mcpServers?.vellum);
        await authorize(options, "shutdown-race");
        await invoke(client, "shutdown-race");
        await checkpoint(options);
        yield result();
      });
      f.interrupt.mockImplementation(async () => {
        throw new Error("The fixture transport already closed");
      });
      if (mode === "checkpoint") {
        f.options.run.onCheckpoint = async () => "handoff" as const;
      } else {
        registerHooks({
          "post-model-call": async (context: PostModelCallContext) => {
            context.content.push({
              type: "tool_use",
              id: "synthetic-yield",
              name: "first_tool",
              input: { value: "synthetic" },
            });
          },
        });
        f.execute.mockImplementation(async (_name, _args, _output, id) => ({
          content: "Yielding",
          isError: false,
          yieldToUser: id === "synthetic-yield",
        }));
      }
      const output = await runClaudeSdkAgent(f.options);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(output.error).toBeUndefined();
      expect(output.reason).toBe(
        mode === "checkpoint" ? "checkpoint_handoff" : "yield_to_user",
      );
      expect(f.interrupt).toHaveBeenCalledTimes(1);
      expect(f.close).toHaveBeenCalledTimes(2);
      expect(f.execute).toHaveBeenCalledTimes(mode === "checkpoint" ? 1 : 2);
    },
  );

  test.each(["checkpoint", "synthetic-yield"] as const)(
    "the CLI's error exit after our own %s interrupt is a handoff, not a crash",
    async (mode) => {
      const f = transport(async function* ({ options }) {
        yield* toolFrames("handoff-exit");
        const client = await connect(options.mcpServers?.vellum);
        await authorize(options, "handoff-exit");
        await invoke(client, "handoff-exit");
        await checkpoint(options);
        // Real Claude Code exits non-zero after interrupt; the SDK rethrows it.
        throw new Error(
          "Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
        );
      });
      if (mode === "checkpoint") {
        f.options.run.onCheckpoint = async () => "handoff" as const;
      } else {
        registerHooks({
          "post-model-call": async (context: PostModelCallContext) => {
            context.content.push({
              type: "tool_use",
              id: "synthetic-yield",
              name: "first_tool",
              input: { value: "synthetic" },
            });
          },
        });
        f.execute.mockImplementation(async (_name, _args, _output, id) => ({
          content: "Yielding",
          isError: false,
          yieldToUser: id === "synthetic-yield",
        }));
      }
      const output = await runClaudeSdkAgent(f.options);
      expect(output.error).toBeUndefined();
      expect(output.reason).toBe(
        mode === "checkpoint" ? "checkpoint_handoff" : "yield_to_user",
      );
      expect(output.exitReason).toBe(mode === "checkpoint" ? "handoff" : null);
      expect(
        f.events.filter(
          (event) => event.type === "error" || event.type === "provider_error",
        ),
      ).toHaveLength(0);
      expect(f.execute).toHaveBeenCalledTimes(mode === "checkpoint" ? 1 : 2);
      const results = output.newMessages
        .flatMap((message) => message.content)
        .filter((block) => block.type === "tool_result");
      expect(results).toHaveLength(mode === "checkpoint" ? 1 : 2);
    },
  );

  test("an unrelated CLI error exit is still reported as a failure", async () => {
    const f = transport(async function* () {
      yield* textBlocks("partial", ["Working"]);
      throw new Error("Claude Code returned an error result: boom");
    });
    const output = await runClaudeSdkAgent(f.options);
    expect(output.reason).toBe("error");
    expect(output.error).toBeDefined();
  });

  test("parallel tool results are recorded in one user message after the batch", async () => {
    const f = transport(async function* ({ options }) {
      yield messageStart("message-parallel");
      for (const [index, id] of ["par-a", "par-b"].entries()) {
        yield partial({
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id,
            name: "mcp__vellum__first_tool",
            input: {},
          },
        });
        yield partial({
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({ value: id }),
          },
        });
        yield partial({ type: "content_block_stop", index });
      }
      yield partial({ type: "message_stop" });
      const client = await connect(options.mcpServers?.vellum);
      await authorize(options, "par-a", "first_tool", { value: "par-a" });
      await authorize(options, "par-b", "first_tool", { value: "par-b" });
      await Promise.all([
        invoke(client, "par-a", "first_tool", { value: "par-a" }),
        invoke(client, "par-b", "first_tool", { value: "par-b" }),
      ]);
      yield* textBlocks("reply", ["Both done"]);
      yield result();
    });
    const output = await runClaudeSdkAgent(f.options);
    expect(output.error).toBeUndefined();
    expect(f.execute).toHaveBeenCalledTimes(2);
    const roles = output.newMessages.map((message) => message.role);
    expect(roles).toEqual(["assistant", "user", "assistant"]);
    const resultIds = output.newMessages[1]!.content.map((block) =>
      block.type === "tool_result" ? block.tool_use_id : block.type,
    );
    expect(resultIds.sort()).toEqual(["par-a", "par-b"]);
  });
  // Native 2.1.296 PostToolBatch continue:false returns hook_stopped after
  // tool results, without another model request. Pinned native source evidence
  // is recorded in NATIVE-STOP-CONTRACT.md outside this test fixture.
  const yieldStopReason = "The assistant has yielded to the user.";
  const yieldResult = (): SDKResultSuccess => ({
    ...result(),
    result: "",
    stop_reason: "tool_use",
    terminal_reason: "hook_stopped",
  });

  test("clean explicit tool yield stops at the native batch and resumes next turn", async () => {
    const directory = await sessionDirectory("sdk-clean-yield-");
    let batchOutput: unknown;
    const first = transport(async function* ({ options, nextPrompt }) {
      yield* toolFrames("clean-yield");
      const client = await connect(options.mcpServers?.vellum);
      await authorize(options, "clean-yield");
      await invoke(client, "clean-yield");
      // Input must remain open until native acknowledges its graceful stop.
      let inputClosed = false;
      const tail = nextPrompt().then((value) => {
        inputClosed = !!value.done;
        return value;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(inputClosed).toBe(false);
      batchOutput = await checkpoint(options);
      yield yieldResult();
      expect((await tail).done).toBe(true);
    });
    first.options.conversationDir = directory;
    first.execute.mockImplementation(async () => ({
      content: "Memory saved",
      isError: false,
      yieldToUser: true,
    }));
    const completed = await runClaudeSdkAgent(first.options);
    expect(completed.error).toBeUndefined();
    expect(completed.reason).toBe("yield_to_user");
    expect(first.interrupt).not.toHaveBeenCalled();
    expect(batchOutput).toEqual([
      { continue: false, stopReason: yieldStopReason },
    ]);
    expect(first.execute).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(
        await readFile(join(directory, ".claude-sdk-session.json"), "utf8"),
      ).inFlight,
    ).toBe(false);
    const second = transport(async function* () {
      yield* textBlocks("after-clean-yield", ["Next turn"]);
      yield result();
    });
    second.options.conversationDir = directory;
    second.options.run.messages = [
      ...completed.history,
      { role: "user", content: [{ type: "text", text: "Next request" }] },
    ];
    const resumed = await runClaudeSdkAgent(second.options);
    expect(resumed.error).toBeUndefined();
    expect(second.sdkOptions[0]?.resume).toBe(first.sdkOptions[0]?.sessionId);
    expect(JSON.stringify(second.prompts[0])).not.toContain("Memory saved");
    expect(second.execute).not.toHaveBeenCalled();
  });

  test.each([
    "missing-hook",
    "wrong-terminal",
    "error-result",
    "success-is-error",
    "missing-result",
    "stream-error",
    "abort",
    "hook-abort",
    "late-hook-abort",
    "post-result-hook-abort",
    "continued-model",
    "guidance",
    "pending-tool",
    "changed-history",
    "changed-tools",
    "checkpoint",
  ] as const)("explicit tool yield cannot certify %s", async (mode) => {
    const directory = await sessionDirectory("sdk-unsafe-yield-");
    const abort = new AbortController();
    const hookAbort = new AbortController();
    if (mode === "guidance") {
      registerHooks({
        "post-tool-use": async (context: PostToolUseContext) => {
          context.additionalContext = "Still needs model continuation";
        },
      });
    }
    if (mode === "changed-history") {
      registerHooks({
        "post-model-call": async (context: PostModelCallContext) => {
          context.content.unshift({ type: "text", text: "Changed history" });
        },
      });
    }
    const f = transport(async function* ({ options }) {
      yield* toolFrames("unsafe-yield");
      const client = await connect(options.mcpServers?.vellum);
      await authorize(options, "unsafe-yield");
      await invoke(client, "unsafe-yield");
      if (mode === "pending-tool") {
        yield* toolFrames("unresolved-peer");
      }
      if (mode === "hook-abort") {
        hookAbort.abort();
      }
      if (mode !== "missing-hook") {
        await options.hooks!.PostToolBatch![0]!.hooks[0]!(
          {
            hook_event_name: "PostToolBatch",
            tool_calls: [],
            session_id: uuid,
            transcript_path: "/tmp/not-read",
            cwd: "/tmp",
          },
          undefined,
          { signal: hookAbort.signal },
        );
      }
      if (mode === "late-hook-abort") {
        hookAbort.abort();
      }
      if (mode === "abort") {
        abort.abort();
      }
      if (mode === "continued-model") {
        yield* textBlocks("unexpected-after-stop", ["Should not infer again"]);
      }
      if (mode === "stream-error") {
        throw new Error("Unrelated native stream failure");
      }
      if (mode !== "missing-result") {
        if (mode === "error-result") {
          const { result: _result, ...rest } = yieldResult();
          yield {
            ...rest,
            subtype: "error_during_execution" as const,
            is_error: true,
            errors: ["Native failure"],
          };
        } else {
          yield {
            ...yieldResult(),
            ...(mode === "wrong-terminal"
              ? { terminal_reason: "completed" as const }
              : {}),
            ...(mode === "success-is-error" ? { is_error: true } : {}),
          };
        }
      }
      if (mode === "post-result-hook-abort") {
        hookAbort.abort();
      }
    });
    f.options.conversationDir = directory;
    f.options.run.signal = abort.signal;
    f.execute.mockImplementation(async () => ({
      content: "Saved",
      isError: false,
      yieldToUser: true,
    }));
    if (mode === "changed-tools") {
      f.options.resolveTools = () => [definition("changed_tool")];
    }
    if (mode === "checkpoint") {
      f.options.run.onCheckpoint = async () => "handoff" as const;
    }
    const output = await runClaudeSdkAgent(f.options);
    await expectDirty(directory);
    if (
      [
        "missing-hook",
        "wrong-terminal",
        "error-result",
        "success-is-error",
        "missing-result",
        "stream-error",
        "hook-abort",
        "late-hook-abort",
        "continued-model",
      ].includes(mode)
    ) {
      expect(output.reason).toBe("error");
      expect(output.error).toBeDefined();
    }
    if (mode === "abort") {
      expect(output.reason).toBe("aborted_via_error");
    }
    if (mode === "checkpoint") {
      expect(output.reason).toBe("checkpoint_handoff");
      expect(f.interrupt).toHaveBeenCalledTimes(1);
    }
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  // Resume regressions use a fake native transport, the real in-memory MCP
  // bridge and temporary mapping files. They never start Claude or inference.

  test.each([true, false])(
    "native-delivered post-tool guidance preserves resume (tool error=%s)",
    async (isError) => {
      const directory = await mkdtemp(join(tmpdir(), "sdk-guidance-resume-"));
      cleanups.push(async () => {
        assertNotLiveDb(directory);
        await rm(directory, { recursive: true, force: true });
      });
      registerHooks({
        "post-tool-use": async (context: PostToolUseContext) => {
          context.additionalContext = "Private fixture guidance";
        },
      });
      const first = transport(async function* ({ options }) {
        yield* toolFrames("guidance-first");
        const client = await connect(options.mcpServers?.vellum);
        await authorize(options, "guidance-first");
        await invoke(client, "guidance-first");
        expect(await checkpoint(options)).toEqual([
          {
            hookSpecificOutput: {
              hookEventName: "PostToolBatch",
              additionalContext: "Private fixture guidance",
            },
          },
        ]);
        // A subsequent model frame and successful result establish that
        // the SDK continued after the hook returned its native context.
        yield* textBlocks("guidance-recovered", ["Recovered normally"]);
        yield result();
      });
      first.options.conversationDir = directory;
      first.execute.mockImplementation(async () => ({
        content: isError ? "Recoverable tool error" : "Tool succeeded",
        isError,
      }));
      const completed = await runClaudeSdkAgent(first.options);
      expect(completed.error).toBeUndefined();
      expect(JSON.stringify(completed.history)).not.toContain(
        "Private fixture guidance",
      );
      expect(JSON.stringify(first.events)).not.toContain(
        "Private fixture guidance",
      );
      const saved = JSON.parse(
        await readFile(join(directory, ".claude-sdk-session.json"), "utf8"),
      );
      expect(saved.inFlight).toBe(false);
      const second = transport(async function* () {
        yield* textBlocks("guidance-next", ["Continuing"]);
        yield result();
      });
      second.options.conversationDir = directory;
      second.options.run.messages = [
        ...completed.history,
        { role: "user", content: [{ type: "text", text: "Next request" }] },
      ];
      const next = await runClaudeSdkAgent(second.options);
      expect(next.error).toBeUndefined();
      expect(second.sdkOptions[0]?.resume).toBe(first.sdkOptions[0]?.sessionId);
      expect(JSON.stringify(second.prompts[0])).toContain("Next request");
      expect(JSON.stringify(second.prompts[0])).not.toContain(
        "Recovered normally",
      );
      expect(first.execute).toHaveBeenCalledTimes(1);
      expect(second.execute).toHaveBeenCalledTimes(0);
    },
  );

  test("undelivered post-tool guidance keeps the session dirty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sdk-pending-guidance-"));
    cleanups.push(async () => {
      assertNotLiveDb(directory);
      await rm(directory, { recursive: true, force: true });
    });
    registerHooks({
      "post-tool-use": async (context: PostToolUseContext) => {
        context.additionalContext = "Must not silently disappear";
      },
    });
    const f = transport(async function* ({ options }) {
      yield* toolFrames("pending-guidance");
      const client = await connect(options.mcpServers?.vellum);
      await authorize(options, "pending-guidance");
      await invoke(client, "pending-guidance");
      // Deliberately omit PostToolBatch, simulating an unexpected SDK exit.
      yield* textBlocks("pending-end", ["Finished"]);
      yield result();
    });
    f.options.conversationDir = directory;
    await runClaudeSdkAgent(f.options);
    const saved = JSON.parse(
      await readFile(join(directory, ".claude-sdk-session.json"), "utf8"),
    );
    expect(saved.inFlight).toBe(true);
  });

  test("real post-model content edits still force a rebuild", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sdk-edited-history-"));
    cleanups.push(async () => {
      assertNotLiveDb(directory);
      await rm(directory, { recursive: true, force: true });
    });
    registerHooks({
      "post-model-call": async (context: PostModelCallContext) => {
        context.content = context.content.map((block) =>
          block.type === "text" ? { ...block, text: "Changed by hook" } : block,
        );
      },
    });
    const f = transport(async function* () {
      yield* textBlocks("edited", ["Native answer"]);
      yield result();
    });
    f.options.conversationDir = directory;
    await runClaudeSdkAgent(f.options);
    const saved = JSON.parse(
      await readFile(join(directory, ".claude-sdk-session.json"), "utf8"),
    );
    expect(saved.inFlight).toBe(true);
  });

  async function sessionDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    cleanups.push(async () => {
      assertNotLiveDb(directory);
      await rm(directory, { recursive: true, force: true });
    });
    return directory;
  }

  async function expectDirty(directory: string): Promise<void> {
    expect(
      JSON.parse(
        await readFile(join(directory, ".claude-sdk-session.json"), "utf8"),
      ).inFlight,
    ).toBe(true);
  }

  test.each([
    "abort",
    "handoff",
    "yield",
    "provider-error",
    "missing-result",
    "no-model-after-hook",
  ] as const)(
    "delivered guidance does not bless %s termination",
    async (mode) => {
      const directory = await sessionDirectory("sdk-guidance-negative-");
      const abort = new AbortController();
      registerHooks({
        "post-tool-use": async (context: PostToolUseContext) => {
          context.additionalContext = "Private safety fixture";
        },
      });
      const f = transport(async function* ({ options }) {
        yield* toolFrames("guided-incomplete");
        const client = await connect(options.mcpServers?.vellum);
        await authorize(options, "guided-incomplete");
        await invoke(client, "guided-incomplete");
        await checkpoint(options);
        if (mode === "abort") {
          abort.abort();
        }
        if (mode === "provider-error") {
          throw new Error("Fixture stream failure");
        }
        if (mode !== "no-model-after-hook") {
          yield* textBlocks("guided-tail", ["Done"]);
        }
        if (mode !== "missing-result") {
          yield result();
        }
      });
      f.options.conversationDir = directory;
      f.options.run.signal = abort.signal;
      if (mode === "handoff") {
        f.options.run.onCheckpoint = async () => "handoff" as const;
      }
      if (mode === "yield") {
        f.execute.mockImplementation(async () => ({
          content: "User input needed",
          isError: false,
          yieldToUser: true,
        }));
      }
      await runClaudeSdkAgent(f.options);
      await expectDirty(directory);
    },
  );

  test("success with an unresolved admitted call stays dirty before abandoned-call repair", async () => {
    const directory = await sessionDirectory("sdk-unresolved-success-");
    const f = transport(async function* () {
      yield* toolFrames("never-invoked");
      yield result();
    });
    f.options.conversationDir = directory;
    const output = await runClaudeSdkAgent(f.options);
    expect(JSON.stringify(output.history)).toContain("may have taken effect");
    expect(f.execute).not.toHaveBeenCalled();
    await expectDirty(directory);
  });

  test("guidance drained into a failed checkpoint is not treated as delivered", async () => {
    const directory = await sessionDirectory("sdk-guidance-hook-failed-");
    registerHooks({
      "post-tool-use": async (context: PostToolUseContext) => {
        context.additionalContext = "Private failed-hook fixture";
      },
    });
    const f = transport(async function* ({ options }) {
      yield* toolFrames("failed-checkpoint");
      const client = await connect(options.mcpServers?.vellum);
      await authorize(options, "failed-checkpoint");
      await invoke(client, "failed-checkpoint");
      // Native hooks may report and swallow a callback failure, then continue.
      await checkpoint(options).catch(() => undefined);
      yield* textBlocks("after-failed-checkpoint", ["Done"]);
      yield result();
    });
    f.options.conversationDir = directory;
    f.options.run.onCheckpoint = async () => {
      throw new Error("Fixture checkpoint failure");
    };
    await runClaudeSdkAgent(f.options);
    await expectDirty(directory);
  });

  test("timed-out batch guidance is not treated as delivered", async () => {
    const directory = await sessionDirectory("sdk-guidance-hook-timeout-");
    registerHooks({
      "post-tool-use": async (context: PostToolUseContext) => {
        context.additionalContext = "Private timeout fixture";
      },
    });
    const hookAbort = new AbortController();
    const f = transport(async function* ({ options }) {
      yield* toolFrames("timed-out-checkpoint");
      const client = await connect(options.mcpServers?.vellum);
      await authorize(options, "timed-out-checkpoint");
      await invoke(client, "timed-out-checkpoint");
      const hook = options.hooks!.PostToolBatch![0]!.hooks[0]!;
      await hook(
        {
          hook_event_name: "PostToolBatch",
          tool_calls: [],
          session_id: uuid,
          transcript_path: "/tmp/not-read",
          cwd: "/tmp",
        },
        undefined,
        { signal: hookAbort.signal },
      );
      yield* textBlocks("after-hook-timeout", ["Done"]);
      yield result();
    });
    f.options.conversationDir = directory;
    f.options.run.onCheckpoint = async () => {
      hookAbort.abort();
      return "continue" as const;
    };
    await runClaudeSdkAgent(f.options);
    await expectDirty(directory);
  });

  test("a batch callback still active at stream end keeps its session dirty", async () => {
    const directory = await sessionDirectory("sdk-active-batch-");
    const entered = deferred();
    const release = deferred();
    let pending: Promise<unknown> | undefined;
    const f = transport(async function* ({ options }) {
      pending = checkpoint(options);
      await entered.promise;
      yield* textBlocks("active-hook-answer", ["Done"]);
      yield result();
    });
    f.options.conversationDir = directory;
    f.options.run.onCheckpoint = async () => {
      entered.resolve();
      await release.promise;
      return "continue" as const;
    };
    try {
      await runClaudeSdkAgent(f.options);
      await expectDirty(directory);
    } finally {
      release.resolve();
      await pending;
    }
  });

  test("hook cancellation after return but before next inference keeps guidance dirty", async () => {
    const directory = await sessionDirectory("sdk-late-hook-abort-");
    const hookAbort = new AbortController();
    registerHooks({
      "post-tool-use": async (context: PostToolUseContext) => {
        context.additionalContext = "Private late-abort fixture";
      },
    });
    const f = transport(async function* ({ options }) {
      yield* toolFrames("late-hook-abort");
      const client = await connect(options.mcpServers?.vellum);
      await authorize(options, "late-hook-abort");
      await invoke(client, "late-hook-abort");
      const output = await options.hooks!.PostToolBatch![0]!.hooks[0]!(
        {
          hook_event_name: "PostToolBatch",
          tool_calls: [],
          session_id: uuid,
          transcript_path: "/tmp/not-read",
          cwd: "/tmp",
        },
        undefined,
        { signal: hookAbort.signal },
      );
      expect(output).toHaveProperty("hookSpecificOutput.additionalContext");
      hookAbort.abort();
      yield* textBlocks("after-late-hook-abort", ["Done"]);
      yield result();
    });
    f.options.conversationDir = directory;
    await runClaudeSdkAgent(f.options);
    await expectDirty(directory);
  });
});
