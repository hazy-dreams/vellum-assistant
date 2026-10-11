import { mkdtemp, readFile, rm } from "node:fs/promises";
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

  test.each(["checkpoint", "yield"] as const)(
    "a rejected interrupt during %s shutdown closes the query without an unhandled rejection",
    async (mode) => {
      const f = transport(async function* ({ options }) {
        yield* toolFrames("shutdown-race");
        const client = await connect(options.mcpServers?.vellum);
        await authorize(options, "shutdown-race");
        await invoke(client, "shutdown-race");
        if (mode === "checkpoint") {
          await checkpoint(options);
        }
        yield result();
      });
      f.interrupt.mockImplementation(async () => {
        throw new Error("The fixture transport already closed");
      });
      if (mode === "checkpoint") {
        f.options.run.onCheckpoint = async () => "handoff" as const;
      } else {
        f.execute.mockImplementation(async () => ({
          content: "Yielding",
          isError: false,
          yieldToUser: true,
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
      expect(f.execute).toHaveBeenCalledTimes(1);
    },
  );
});
