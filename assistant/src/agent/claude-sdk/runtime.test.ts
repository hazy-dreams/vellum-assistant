import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  Options,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { AgentEvent } from "../loop.js";
import { type ClaudeSdkRunOptions, runClaudeSdkAgent } from "./runtime.js";

const uuid = "00000000-0000-4000-8000-000000000001";
const usage = {
  input_tokens: 2,
  output_tokens: 3,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: {
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 0,
  },
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: "standard" as const,
  inference_geo: "not_available",
  iterations: [],
  speed: "standard" as const,
};
function success(): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "Done",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage,
    modelUsage: {},
    permission_denials: [],
    uuid,
    session_id: uuid,
  };
}
function frame(
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
function start(id = "message-1"): SDKPartialAssistantMessage {
  return frame({
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-sonnet",
      stop_reason: null,
      stop_sequence: null,
      usage,
      container: null,
      context_management: null,
      stop_details: null,
    },
  });
}
function text(text = "Done"): SDKMessage[] {
  return [
    start(),
    frame({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: [] },
    }),
    frame({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    frame({ type: "content_block_stop", index: 0 }),
    frame({ type: "message_stop" }),
    success(),
  ];
}
function fixture(sequence: (options: Options) => AsyncGenerator<SDKMessage>) {
  const events: AgentEvent[] = [];
  const close = mock(() => {});
  const interrupt = mock(async () => undefined);
  const params: Options[] = [];
  const execute = mock(
    async (_name: string, _input: Record<string, unknown>) => ({
      content: "completed",
      isError: false,
    }),
  );
  const options: ClaudeSdkRunOptions = {
    run: {
      messages: [
        { role: "user", content: [{ type: "text", text: "Do the task" }] },
      ],
      onEvent: (event) => {
        events.push(event);
      },
      requestId: "request-1",
      callSite: "mainAgent",
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    },
    conversationId: "conversation-1",
    conversationDir: null,
    systemPrompt: "Assistant instructions",
    tools: [
      {
        name: "example_tool",
        description: "Example",
        input_schema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    ],
    toolExecutor: execute,
    model: "sonnet",
    maxTokens: 8192,
    preflight: async ({ executablePath, env }) => ({
      ok: true,
      executablePath,
      env: env ?? {},
    }),
    query: ({ options }) => {
      params.push(options);
      return {
        close,
        interrupt,
        setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
        [Symbol.asyncIterator]: () => sequence(options),
      };
    },
  };
  // Preflight is mocked; an absolute fake executable does not launch any process.
  return { options, events, params, execute, close, interrupt };
}

async function* plain(): AsyncGenerator<SDKMessage> {
  yield* text();
}

async function* withTool(options: Options): AsyncGenerator<SDKMessage> {
  yield start();
  yield frame({
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "tool_use",
      id: "call-1",
      name: "mcp__vellum__example_tool",
      input: {},
    },
  });
  yield frame({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"value":"example"}' },
  });
  yield frame({ type: "content_block_stop", index: 0 });
  yield frame({ type: "message_stop" });
  const server = options.mcpServers?.vellum;
  if (!server || server.type !== "sdk") {
    throw new Error("Missing SDK MCP bridge");
  }
  const client = new Client({ name: "runtime-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.instance.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!hook) {
      throw new Error("Missing tool hook");
    }
    await hook(
      {
        hook_event_name: "PreToolUse",
        session_id: uuid,
        transcript_path: "/tmp/example.jsonl",
        cwd: "/tmp",
        tool_name: "mcp__vellum__example_tool",
        tool_input: { value: "example" },
        tool_use_id: "call-1",
        mcp_server: { name: "vellum", source: "sdk" },
      },
      "call-1",
      { signal: new AbortController().signal },
    );
    await client.callTool({
      name: "example_tool",
      arguments: { value: "example" },
      _meta: { "claudecode/toolUseId": "call-1" },
    });
    for (const matcher of options.hooks?.PostToolBatch ?? []) {
      for (const batch of matcher.hooks) {
        await batch(
          {
            hook_event_name: "PostToolBatch",
            tool_calls: [],
            session_id: uuid,
            transcript_path: "/tmp/example.jsonl",
            cwd: "/tmp",
          },
          undefined,
          { signal: new AbortController().signal },
        );
      }
    }
  } finally {
    await client.close();
  }
  yield* text("Finished");
}

// Isolate executable discovery without changing environment or credentials.
import { getConfig } from "../../config/loader.js";
function prepare() {
  getConfig().llm.claudeAgentSdk = {
    executablePath: "/tmp/claude-runtime-fixture",
  };
}

describe("Claude SDK root runtime", () => {
  let previousSettings: ReturnType<typeof getConfig>["llm"]["claudeAgentSdk"];
  beforeEach(() => {
    previousSettings = getConfig().llm.claudeAgentSdk;
  });
  afterEach(() => {
    getConfig().llm.claudeAgentSdk = previousSettings;
  });
  test("uses SDK with only the assistant MCP tools and streams a canonical reply", async () => {
    prepare();
    const f = fixture(plain);
    const result = await runClaudeSdkAgent(f.options);
    expect(result.error).toBeUndefined();
    expect(result.reason).toBe("no_tool_calls");
    expect(f.params[0]).toMatchObject({
      tools: [],
      strictMcpConfig: true,
      settings: { disableAllHooks: true, autoMemoryEnabled: false },
      settingSources: [],
      plugins: [],
      skills: [],
      model: "sonnet",
    });
    expect(f.events.map((event) => event.type)).toEqual([
      "llm_call_started",
      "text_delta",
      "usage",
      "message_complete",
    ]);
    expect(result.newMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Done" }] },
    ]);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  test("preserves tool ID, normal executor and ordered conversation events", async () => {
    prepare();
    const f = fixture(withTool);
    const result = await runClaudeSdkAgent(f.options);
    expect(result.error).toBeUndefined();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0]?.[0]).toBe("example_tool");
    const types = f.events.map((event) => event.type);
    expect(types.indexOf("message_complete")).toBeLessThan(
      types.indexOf("tool_use"),
    );
    expect(types.indexOf("tool_use")).toBeLessThan(
      types.indexOf("tool_result"),
    );
    expect(result.newMessages[0]?.content[0]).toMatchObject({
      type: "tool_use",
      id: "call-1",
      name: "example_tool",
    });
    expect(result.newMessages[1]?.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-1",
      content: "completed",
    });
  });
  test("auth failure never invokes SDK or falls back to an API", async () => {
    prepare();
    const f = fixture(plain);
    f.options.preflight = async () => ({
      ok: false,
      reason: "subscription_required",
      message: "Sign in directly with Claude Code",
    });
    const result = await runClaudeSdkAgent(f.options);
    expect(result.reason).toBe("error");
    expect(f.params).toHaveLength(0);
    expect(result.error?.message).toContain("Sign in directly");
  });
  test("abort before execution makes no request", async () => {
    prepare();
    const f = fixture(plain);
    const abort = new AbortController();
    abort.abort();
    f.options.run.signal = abort.signal;
    const result = await runClaudeSdkAgent(f.options);
    expect(result.reason).toBe("aborted_pre_call");
    expect(f.params).toHaveLength(0);
  });
  test("a disconnected SDK without a terminal result is an explicit error", async () => {
    prepare();
    const f = fixture(async function* () {
      yield start();
    });
    const result = await runClaudeSdkAgent(f.options);
    expect(result.reason).toBe("error");
    expect(result.error?.message).toContain("before a result");
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  test("checkpoint yields to the normal conversation queue", async () => {
    prepare();
    const f = fixture(withTool);
    f.options.run.onCheckpoint = async () => "handoff" as const;
    const result = await runClaudeSdkAgent(f.options);
    expect(result.reason).toBe("checkpoint_handoff");
    expect(result.exitReason).toBe("handoff");
    expect(f.interrupt).toHaveBeenCalledTimes(1);
  });
  test("tool-gated replies get a visible final fallback without duplicate streaming", async () => {
    prepare();
    const f = fixture(plain);
    f.options.run.suppressAssistantText = true;
    const result = await runClaudeSdkAgent(f.options);
    expect(result.reason).toBe("no_tool_calls");
    expect(f.events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "Done" },
    ]);
  });
});
