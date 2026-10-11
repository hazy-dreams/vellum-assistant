import { describe, expect, mock, test } from "bun:test";

import type {
  Options,
  SDKMessage,
  SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";

import { setConfig } from "../../__tests__/helpers/set-config.js";
import { RetryProvider } from "../retry.js";
import type { ContentBlock, Message } from "../types.js";
import { ClaudeAgentSdkProvider, type ClaudeSdkQuery } from "./client.js";

const messages: Message[] = [
  {
    role: "user",
    content: [{ type: "text", text: "Choose the relevant pages" }],
  },
];
const tool = {
  name: "select_pages",
  description: "Select page IDs",
  input_schema: {
    type: "object",
    properties: { ids: { type: "array", items: { type: "string" } } },
    required: ["ids"],
    additionalProperties: false,
  },
};

function success(overrides: Partial<SDKResultSuccess> = {}): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "A short title",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 2,
      output_tokens: 3,
      cache_creation_input_tokens: 4,
      cache_read_input_tokens: 5,
      cache_creation: {
        ephemeral_5m_input_tokens: 4,
        ephemeral_1h_input_tokens: 0,
      },
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: "standard",
      inference_geo: "not_available",
      iterations: [],
      speed: "standard",
    },
    modelUsage: {
      sonnet: {
        inputTokens: 2,
        outputTokens: 3,
        cacheCreationInputTokens: 4,
        cacheReadInputTokens: 5,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
    },
    permission_denials: [],
    uuid: "00000000-0000-0000-0000-000000000001",
    session_id: "session-123",
    ...overrides,
  };
}

function fixture(events: SDKMessage[] = [success()]) {
  const calls: { prompt: string; options: Options }[] = [];
  const close = mock(() => {});
  const query: ClaudeSdkQuery = (params) => {
    calls.push(params);
    return {
      close,
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    };
  };
  const preflight = mock(
    async ({
      executablePath,
      env,
    }: {
      executablePath: string;
      env?: NodeJS.ProcessEnv;
    }) => ({ ok: true as const, executablePath, env: { ...env } }),
  );
  const provider = new ClaudeAgentSdkProvider("sonnet", {
    query,
    preflight,
    executablePath: "/usr/local/bin/claude",
    cwd: "/tmp",
    streamTimeoutMs: 1000,
  });
  return { provider, calls, preflight, close };
}

describe("Claude subscription auxiliary provider", () => {
  test("uses verified executable/env and disables every tool source", async () => {
    const f = fixture();
    const events: string[] = [];
    const result = await f.provider.sendMessage(messages, {
      systemPrompt: "Write a title",
      config: { max_tokens: 128, effort: "high" },
      onEvent: (event) => {
        if (event.type === "text_delta") {
          events.push(event.text);
        }
      },
    });
    expect(result.content).toEqual([{ type: "text", text: "A short title" }]);
    expect(result.actualProvider).toBe("claude-agent-sdk");
    expect(result.usage).toEqual({
      inputTokens: 11,
      outputTokens: 3,
      cacheCreationInputTokens: 4,
      cacheReadInputTokens: 5,
    });
    expect(events).toEqual(["A short title"]);
    const options = f.calls[0].options;
    expect(options.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
    expect(options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("128");
    expect(options.tools).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settingSources).toEqual([]);
    expect(options.skills).toEqual([]);
    expect(options.plugins).toEqual([]);
    expect(options.persistSession).toBe(false);
    expect(options.verbatimPrompts).toBe(true);
    expect(options.settings).toEqual({
      disableAllHooks: true,
      autoMemoryEnabled: false,
    });
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.maxTurns).toBe(1);
    expect(options.effort).toBe("high");
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  test("returns forced tool input as data without registering a tool", async () => {
    const f = fixture([success({ structured_output: { ids: ["page-123"] } })]);
    const result = await f.provider.sendMessage(messages, {
      tools: [tool],
      config: { tool_choice: { type: "tool", name: tool.name } },
    });
    expect(result.content[0]).toMatchObject({
      type: "tool_use",
      name: tool.name,
      input: { ids: ["page-123"] },
    });
    expect(result.stopReason).toBe("tool_use");
    expect(f.calls[0].options.outputFormat).toEqual({
      type: "json_schema",
      schema: tool.input_schema,
    });
    expect(f.calls[0].options.tools).toEqual([]);
    expect(f.calls[0].options.maxTurns).toBe(3);
  });

  test("honors required and automatic tool decisions", async () => {
    const f = fixture([
      success({
        structured_output: {
          text: "Selected",
          tool_calls: [{ name: tool.name, input: { ids: [] } }],
        },
      }),
    ]);
    const result = await f.provider.sendMessage(messages, {
      tools: [tool],
      config: { tool_choice: "required" },
    });
    expect(result.content).toMatchObject([
      { type: "text", text: "Selected" },
      { type: "tool_use", name: tool.name },
    ]);
    const noCall = fixture([
      success({
        structured_output: { text: "No pages needed", tool_calls: [] },
      }),
    ]);
    expect(
      (await noCall.provider.sendMessage(messages, { tools: [tool] }))
        .stopReason,
    ).toBe("end_turn");
    const required = fixture([
      success({ structured_output: { text: "No pages", tool_calls: [] } }),
    ]);
    await expect(
      required.provider.sendMessage(messages, {
        tools: [tool],
        config: { tool_choice: { type: "any" } },
      }),
    ).rejects.toThrow("invalid structured tool decision");
  });

  test("rejects invalid structured output without falling back to prose", async () => {
    for (const output of [
      undefined,
      { ids: "bad" },
      { ids: [], unexpected: true },
    ]) {
      const f = fixture([success({ structured_output: output })]);
      await expect(
        f.provider.sendMessage(messages, {
          tools: [tool],
          config: { tool_choice: { type: "tool", name: tool.name } },
        }),
      ).rejects.toThrow("JSON schema");
      expect(f.close).toHaveBeenCalledTimes(1);
    }
  });

  test("rejects unknown tool calls and invalid requests before authentication", async () => {
    const f = fixture();
    await expect(
      f.provider.sendMessage(messages, {
        tools: [tool],
        config: { tool_choice: { type: "tool", name: "missing" } },
      }),
    ).rejects.toThrow("Unknown forced tool");
    expect(f.preflight).not.toHaveBeenCalled();
    const unknown = fixture([
      success({
        structured_output: {
          text: "",
          tool_calls: [{ name: "unknown", input: {} }],
        },
      }),
    ]);
    await expect(
      unknown.provider.sendMessage(messages, { tools: [tool] }),
    ).rejects.toThrow("unknown tool name");
  });

  test("supports explicit response schemas and tool_choice none", async () => {
    const f = fixture([success({ structured_output: { ids: [] } })]);
    const result = await f.provider.sendMessage(messages, {
      tools: [tool],
      config: {
        tool_choice: "none",
        response_format: {
          type: "json_schema",
          json_schema: { schema: tool.input_schema },
        },
      },
    });
    expect(result.content).toEqual([{ type: "text", text: '{"ids":[]}' }]);
  });

  test("normalizes unsupported tuning hints without pretending to send them", async () => {
    const f = fixture();
    await f.provider.sendMessage(messages, {
      config: {
        temperature: 0,
        top_p: 0.5,
        verbosity: "low",
        thinking: { enabled: false },
        effort: "none",
      },
    });
    expect(f.calls[0].options).not.toHaveProperty("temperature");
    expect(f.calls[0].options).not.toHaveProperty("top_p");
    expect(f.calls[0].options.thinking).toEqual({ type: "disabled" });
    expect(f.calls[0].options.effort).toBeUndefined();
  });

  test("rejects unknown request semantics and honors single-tool choices", async () => {
    const f = fixture();
    await expect(
      f.provider.sendMessage(messages, {
        config: { logprobs: true },
      }),
    ).rejects.toThrow("does not support option logprobs");
    expect(f.preflight).not.toHaveBeenCalled();
    const multiple = fixture([
      success({
        structured_output: {
          text: "",
          tool_calls: [
            { name: tool.name, input: { ids: [] } },
            { name: tool.name, input: { ids: [] } },
          ],
        },
      }),
    ]);
    await expect(
      multiple.provider.sendMessage(messages, {
        tools: [tool],
        config: { parallel_tool_calls: false },
      }),
    ).rejects.toThrow("invalid structured tool decision");
  });

  test("accepts real memory router and pool-selector cache hints through retry normalization", async () => {
    setConfig("llm", { defaultProvider: { provider: "claude-agent-sdk" } });
    const router = fixture([
      success({ structured_output: { ids: ["page-123"] } }),
    ]);
    await new RetryProvider(router.provider).sendMessage(messages, {
      tools: [tool],
      config: {
        callSite: "memoryRouter",
        conversationId: "conv-123",
        tool_choice: { type: "tool", name: tool.name },
        disableTurnStartCache: true,
        cacheTtl: "1h",
      },
    });
    expect(router.calls[0].options.model).toBe("haiku");
    expect(router.calls[0].options.thinking).toEqual({ type: "disabled" });
    const pool = fixture();
    await new RetryProvider(pool.provider).sendMessage(messages, {
      config: {
        callSite: "memoryV3SelectL2",
        conversationId: "conv-123",
        selectionSeed: "conv-123",
        disableTurnStartCache: true,
      },
    });
    expect(pool.calls[0].options.model).toBe("sonnet");
    expect(pool.calls[0].options.effort).toBe("low");
    expect(pool.calls[0].options.thinking).toEqual({ type: "disabled" });
    setConfig("llm", {});
  });

  test("enforces real reply-suggestion stop sequences before text events", async () => {
    const f = fixture([
      success({ result: "<reply>See you 🙂</reply>unwanted suffix" }),
    ]);
    const events: string[] = [];
    const response = await f.provider.sendMessage(messages, {
      tools: [],
      config: {
        callSite: "replySuggestion",
        conversationId: "conv-123",
        max_tokens: 60,
        stop_sequences: ["later", "</reply>"],
        temperature: 0.7,
        thinking: { type: "disabled" },
        effort: "none",
      },
      onEvent: (event) => {
        if (event.type === "text_delta") {
          events.push(event.text);
        }
      },
    });
    expect(response.content).toEqual([
      { type: "text", text: "<reply>See you 🙂" },
    ]);
    expect(response.stopReason).toBe("stop_sequence");
    expect(events).toEqual(["<reply>See you 🙂"]);
    expect(f.calls[0].options).not.toHaveProperty("stop_sequences");
    expect(f.calls[0].options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("60");
  });

  test("rejects malformed stop sequences and schema/stop combinations before a query", async () => {
    const f = fixture();
    await expect(
      f.provider.sendMessage(messages, { config: { stop_sequences: [""] } }),
    ).rejects.toThrow("nonempty strings");
    await expect(
      f.provider.sendMessage(messages, {
        tools: [tool],
        config: { stop_sequences: ["stop"] },
      }),
    ).rejects.toThrow("cannot combine");
    expect(f.preflight).not.toHaveBeenCalled();
  });

  test("fails closed when subscription preflight fails", async () => {
    const query = mock(() => {
      throw new Error("must not start");
    });
    const provider = new ClaudeAgentSdkProvider("sonnet", {
      executablePath: "/usr/local/bin/claude",
      query,
      preflight: async () => ({
        ok: false,
        reason: "subscription_required",
        message: "Sign in with a Claude subscription",
      }),
    });
    await expect(provider.sendMessage(messages)).rejects.toThrow(
      "Sign in with a Claude subscription",
    );
    expect(query).not.toHaveBeenCalled();
  });

  test("rejects abort before starting a process", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      f.provider.sendMessage(messages, { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(f.preflight).not.toHaveBeenCalled();
  });

  test("forwards cancellation to SDK and closes on failure", async () => {
    const controller = new AbortController();
    const f = fixture();
    const provider = new ClaudeAgentSdkProvider("sonnet", {
      executablePath: "/usr/local/bin/claude",
      preflight: f.preflight,
      query: ({ options }) => ({
        close: f.close,
        async *[Symbol.asyncIterator]() {
          controller.abort(new Error("cancelled during query"));
          expect(options.abortController?.signal.aborted).toBe(true);
          yield success();
        },
      }),
    });
    await expect(
      provider.sendMessage(messages, { signal: controller.signal }),
    ).rejects.toThrow("cancelled during query");
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  test("rejects SDK errors and missing terminal results", async () => {
    for (const events of [
      [],
      [success({ is_error: true, result: "API failed" })],
    ]) {
      const f = fixture(events);
      await expect(f.provider.sendMessage(messages)).rejects.toThrow(
        "Claude subscription",
      );
      expect(f.close).toHaveBeenCalledTimes(1);
    }
  });

  test("rejects unsupported attachments and never sends raw thinking", async () => {
    const f = fixture();
    const content: ContentBlock[] = [
      { type: "text", text: "Read history" },
      {
        type: "thinking",
        thinking: "private reasoning",
        signature: "signature",
      },
    ];
    await f.provider.sendMessage([{ role: "assistant", content }]);
    expect(f.calls[0].prompt).not.toContain("private reasoning");
    await expect(
      f.provider.sendMessage([
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image",
              },
            },
          ],
        },
      ]),
    ).rejects.toThrow("do not support image");
  });
});
