import { randomUUID } from "node:crypto";

import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { SEND_USER_MESSAGE_TOOL_NAME } from "../../config/send-user-message-constants.js";
import { preModelCallSanitize } from "../../context/outbound-sanitize.js";
import {
  estimatePromptTokensRaw,
  estimateToolsTokens,
} from "../../context/token-estimator.js";
import { spoolAndStubOversizedToolResults } from "../../context/tool-result-spool.js";
import type { AgentLoopExitReason } from "../../hooks/types.js";
import { HOOKS } from "../../plugin-api/constants.js";
import { runHook } from "../../plugins/pipeline.js";
import type {
  ContentBlock,
  Message,
  ToolDefinition,
  ToolResultContent,
  ToolUseContent,
} from "../../providers/types.js";
import { getTool } from "../../tools/registry.js";
import {
  applyStreamingSubstitution,
  applySubstitutions,
} from "../../tools/sensitive-output-placeholders.js";
import { ProviderError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { getSandboxWorkingDir } from "../../util/platform.js";
import { joinDeliveredMessages } from "../../util/text-spacing.js";
import type {
  AgentLoopRunOptions,
  AgentLoopRunResult,
  LoopToolExecutor,
} from "../loop.js";
import {
  deliveredUserMessage,
  reportsOutcomeToUser,
} from "../user-message-outcome.js";
import { preflightClaudeSdkAuth } from "./auth.js";
import { resolveClaudeSdkInferenceOptions } from "./inference-options.js";
import {
  ClaudeSdkSessionStore,
  createSdkSessionFingerprint,
  prepareSdkPrompt,
} from "./session.js";
import { claudeSdkTimeoutEnvironment } from "./timeout.js";
import {
  type ClaudeSdkToolCall,
  type ClaudeSdkToolResult,
  createClaudeSdkToolBridge,
} from "./tools.js";

const log = getLogger("claude-sdk-runtime");
const objectSchema = z.record(z.string(), z.unknown());

export interface ClaudeSdkRunOptions {
  run: AgentLoopRunOptions;
  /** Unsanitized canonical history; prompt messages remain transport-safe. */
  canonicalMessages?: Message[];
  conversationId: string;
  conversationDir: string | null;
  systemPrompt: string;
  /** Raw estimator scope shared with the caller's canonical budget gates. */
  tokenEstimation?: {
    systemPrompt: string;
    providerName?: string;
    model?: string;
  };
  tools: ToolDefinition[];
  toolExecutor: LoopToolExecutor | null;
  model: string;
  effort?: string;
  thinking?: { enabled: boolean; streamThinking: boolean };
  maxTokens: number;
  deferAssistantOutput?: boolean;
  resolveTools?: (history: Message[]) => ToolDefinition[];
  onToolsSent?: (tools: ToolDefinition[]) => void;
  /** Injectable transport for lifecycle tests; production uses the pinned SDK. */
  query?: (params: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: Options;
  }) => Pick<Query, "close" | "interrupt" | "setMcpServers"> &
    AsyncIterable<SDKMessage>;
  preflight?: typeof preflightClaudeSdkAuth;
}

export interface ClaudeSdkRunResult extends AgentLoopRunResult {
  reason: AgentLoopExitReason;
  error?: Error;
}

/** Streaming input stays open for hook-requested continuations, then drains. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private closed = false;
  push(value: SDKUserMessage): void {
    if (this.closed) {
      throw new Error("Claude SDK input is closed");
    }
    this.values.push(value);
    this.wake?.();
  }
  end(): void {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const value = this.values.shift();
      if (value) {
        yield value;
        continue;
      }
      if (this.closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

/**
 * Claude owns inference/tool iteration. Vellum retains its tool policy, hooks,
 * canonical history and event sink; no second model/tool loop runs underneath.
 */
export async function runClaudeSdkAgent(
  options: ClaudeSdkRunOptions,
): Promise<ClaudeSdkRunResult> {
  const { run, conversationId, conversationDir } = options;
  const history = [...(options.canonicalMessages ?? run.messages)];
  const newMessages: Message[] = [];
  let reason: AgentLoopExitReason = "no_tool_calls";
  const getReason = (): AgentLoopExitReason => reason;
  let error: Error | undefined;
  let query: ReturnType<NonNullable<ClaudeSdkRunOptions["query"]>> | undefined;
  const input = new InputQueue();
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort(run.signal?.reason);
    input.end();
  };
  run.signal?.addEventListener("abort", cancel, { once: true });
  if (run.signal?.aborted) {
    cancel();
  }
  const substitutions = new Map<string, string>();
  let streamingPending = "";
  let userToldOutcome = false;
  let streamed = false;
  let toolCount = 0;
  let turnIndex = 0;
  let continuationCount = 0;
  let continueMessages: Message[] | undefined;
  let sessionDiverged = false;
  let sawSuccess = false;
  let nativeYieldRequested = false;
  let yieldInterrupted = false;
  let yieldStopSignal: AbortSignal | undefined;
  let yieldStopContinued = false;
  const cleanNativeYield = (): boolean =>
    getReason() === "yield_to_user" &&
    nativeYieldRequested &&
    !yieldInterrupted &&
    !!yieldStopSignal &&
    !yieldStopSignal.aborted &&
    !yieldStopContinued;
  const approvedCalls = new Map<string, ToolUseContent>();
  const pendingStarts = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  const observedCalls = new Set<string>();
  const terminalError = (message: string): ProviderError =>
    new ProviderError(message, "claude-agent-sdk");
  const emit = run.onEvent;
  const append = (message: Message): void => {
    history.push(message);
    newMessages.push(message);
  };
  // Parallel tool results belong in ONE user message after the assistant
  // batch, like the native loop. Separate messages read as orphans to
  // history repair and break SDK session resume on the next turn.
  const appendToolResult = (block: ToolResultContent): void => {
    const last = newMessages[newMessages.length - 1];
    if (
      last &&
      last === history[history.length - 1] &&
      last.role === "user" &&
      Array.isArray(last.content) &&
      last.content.length > 0 &&
      last.content.every((item) => item.type === "tool_result")
    ) {
      last.content.push(block);
      return;
    }
    append({ role: "user", content: [block] });
  };
  let model = options.model;
  let pendingContent: ContentBlock[] = [];
  let inputJson = new Map<number, string>();
  let lastResponseText = "";
  let startedMessage = false;
  // SDK assistant frames can duplicate the streamed message or arrive alone.
  // Identity, not a turn-wide streaming flag, determines whether to account it.
  const streamedMessageIds = new Set<string>();
  const assistantFrameIds = new Set<string>();
  const fallbackUsage = new Map<
    string,
    {
      model: string;
      inputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
    }
  >();
  let streamedOutputTokens = 0;
  let streamedCallCount = 0;
  let lastCallInputTokens = 0;
  let streamingMessageId: string | undefined;
  let pendingStopReason: string | null = null;
  let pendingUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  let messageStartedAt = 0;
  let estimatedInputTokens: number | undefined;
  const flushFallbackUsage = async (
    outputTokens?: number,
    durationMs = 0,
  ): Promise<void> => {
    if (fallbackUsage.size === 0) {
      return;
    }
    const records = [...fallbackUsage.values()];
    const models = new Set(records.map((record) => record.model));
    // Assistant-only frames contain per-step input/cache usage but placeholder
    // output counts. The result supplies the turn total; do not invent per-step
    // or mixed-model output attribution. Streaming calls were counted already.
    await emit({
      type: "usage",
      llmCallCount: records.length,
      lastCallInputTokens,
      inputTokens: records.reduce(
        (sum, record) =>
          sum +
          record.inputTokens +
          record.cacheCreationInputTokens +
          record.cacheReadInputTokens,
        0,
      ),
      outputTokens:
        outputTokens === undefined
          ? 0
          : Math.max(0, outputTokens - streamedOutputTokens),
      cacheCreationInputTokens: records.reduce(
        (sum, record) => sum + record.cacheCreationInputTokens,
        0,
      ),
      cacheReadInputTokens: records.reduce(
        (sum, record) => sum + record.cacheReadInputTokens,
        0,
      ),
      model: models.size === 1 ? records[0]!.model : "unknown",
      actualProvider: "claude-agent-sdk",
      providerDurationMs: streamedCallCount === 0 ? durationMs : 0,
    });
    fallbackUsage.clear();
  };
  let closed = false;
  const completedCalls = new Set<string>();
  const executionResults = new Map<string, Promise<ClaudeSdkToolResult>>();
  const syntheticTasks = new Set<Promise<unknown>>();
  const deferredCalls = new Set<string>();
  let syntheticCalls: ToolUseContent[] = [];
  let syntheticContext: string | undefined;
  const modelOnlyContext: string[] = [];
  let guidanceAwaitingModel = false;
  const guidanceSignals: AbortSignal[] = [];
  const observeGuidanceContinuation = (): void => {
    // A cooperative batch stop must not be followed by another model request.
    yieldStopContinued ||= !!yieldStopSignal;
    // A callback can be cancelled after it returns but before native inference
    // consumes its response. Never certify that context as delivered.
    batchHookFailed ||= guidanceSignals.some((signal) => signal.aborted);
    guidanceSignals.length = 0;
    guidanceAwaitingModel = false;
  };
  let batchHookFailed = false;
  let activeBatchHooks = 0;
  let deferredCompletion: Message | undefined;
  let toolSet = options.tools;
  const bridges: ReturnType<typeof createClaudeSdkToolBridge>[] = [];
  let lastToolsKey = JSON.stringify(toolSet);

  const emitText = async (text: string, force = false): Promise<void> => {
    if (!force && (run.suppressAssistantText || options.deferAssistantOutput)) {
      return;
    }
    const combined = streamingPending + text;
    const substitution = applyStreamingSubstitution(combined, substitutions);
    streamingPending = substitution.pending;
    if (substitution.emit) {
      streamed = true;
      run.latencyTracker?.markFirstToken("text");
      await emit({ type: "text_delta", text: substitution.emit });
    }
  };
  const flushText = async (): Promise<void> => {
    if (streamingPending) {
      const text = applySubstitutions(streamingPending, substitutions);
      streamingPending = "";
      if (text) {
        await emit({ type: "text_delta", text });
      }
    }
  };

  const execute: LoopToolExecutor = async (_name, _args, onOutput, id) => {
    const approved = id ? approvedCalls.get(id) : undefined;
    if (
      !approved ||
      !id ||
      !options.toolExecutor ||
      controller.signal.aborted
    ) {
      return {
        content:
          "Tool execution was cancelled or not admitted by the assistant.",
        isError: true,
      };
    }
    const previous = executionResults.get(id);
    if (previous) {
      return previous;
    }
    const task = deferredCalls.has(id)
      ? Promise.resolve({
          content:
            "Another tool in this batch must run alone. Read its result before requesting this action again.",
          isError: false,
        })
      : Promise.resolve().then(() =>
          options.toolExecutor!(
            approved.name,
            structuredClone(approved.input),
            onOutput,
            id,
          ),
        );
    executionResults.set(id, task);
    return task;
  };

  const finalizeToolResult = async (
    call: ClaudeSdkToolCall,
    result: ClaudeSdkToolResult,
  ): Promise<ClaudeSdkToolResult> => {
    if (closed) {
      return result;
    }
    for (const binding of result.sensitiveBindings ?? []) {
      substitutions.set(binding.placeholder, binding.value);
    }
    let block: ContentBlock = {
      type: "tool_result",
      tool_use_id: call.id,
      content: result.content,
      is_error: result.isError,
      ...(result.contentBlocks ? { contentBlocks: result.contentBlocks } : {}),
    };
    if (conversationDir) {
      try {
        const blocks = [block];
        spoolAndStubOversizedToolResults(blocks, {
          conversationDir,
          toolCallById: (id) =>
            id === call.id ? { name: call.name, input: call.input } : undefined,
        });
        block = blocks[0] ?? block;
      } catch (err) {
        log.warn(
          { err, conversationId, toolUseId: call.id },
          "Spooling oversized tool results to disk failed (non-fatal)",
        );
      }
    }
    const post = await runHook(HOOKS.POST_TOOL_USE, {
      conversationId,
      toolResponse: block,
      messages: history,
      additionalContext: null,
      model,
      maxInputTokens: run.resolveContextWindow?.().maxInputTokens ?? 200000,
      callSite: run.callSite ?? null,
      supportsDynamicUi: run.supportsDynamicUi ?? true,
    });
    if (post.additionalContext) {
      // Advisory context is delivered through Claude's native batch hook and
      // retained by its transcript. It is not a rewrite of canonical history.
      // Pending/failed delivery still prevents session completion below.
      modelOnlyContext.push(post.additionalContext);
    }
    const content = post.toolResponse.content;
    return {
      ...result,
      content,
      isError: post.toolResponse.is_error ?? false,
      contentBlocks: post.toolResponse.contentBlocks,
    };
  };

  const onToolStart = async (call: ClaudeSdkToolCall): Promise<void> => {
    if (closed || completedCalls.has(call.id)) {
      return;
    }
    if (!observedCalls.has(call.id)) {
      await new Promise<void>((resolve, reject) => {
        pendingStarts.set(call.id, { resolve, reject });
        if (controller.signal.aborted) {
          reject(terminalError("Claude subscription turn cancelled"));
        }
      });
    }
    const approved = approvedCalls.get(call.id);
    if (!approved) {
      throw terminalError("A conversation hook removed this tool call");
    }
    await emit({
      type: "tool_use",
      id: call.id,
      name: approved.name,
      input: approved.input,
    });
  };
  const onToolOutput = (call: ClaudeSdkToolCall, chunk: string): void => {
    if (!closed && !controller.signal.aborted) {
      void emit({ type: "tool_output_chunk", toolUseId: call.id, chunk });
    }
  };
  const onToolResult = async (
    call: ClaudeSdkToolCall,
    result: ClaudeSdkToolResult,
    synthetic = false,
  ): Promise<void> => {
    if (closed || completedCalls.has(call.id)) {
      return;
    }
    completedCalls.add(call.id);
    toolCount++;
    appendToolResult({
      type: "tool_result",
      tool_use_id: call.id,
      content: result.content,
      is_error: result.isError,
      ...(result.contentBlocks ? { contentBlocks: result.contentBlocks } : {}),
    });
    const { sensitiveBindings: _bindings, yieldToUser, ...visible } = result;
    await emit({ type: "tool_result", toolUseId: call.id, ...visible });
    const admitted = approvedCalls.get(call.id);
    if (result.isError && admitted?.name === SEND_USER_MESSAGE_TOOL_NAME) {
      userToldOutcome = false;
    }
    if (yieldToUser && getReason() !== "checkpoint_handoff") {
      reason = "yield_to_user";
      if (synthetic) {
        // Hook-inserted tools are not native calls; preserve their existing
        // interrupted, non-resumable boundary rather than certifying delivery.
        yieldInterrupted = true;
        void query?.interrupt().catch(() => query?.close());
        input.end();
      } else {
        // Let the MCP result finish delivery before stopping at PostToolBatch.
        // Interrupting here races that delivery and dirties a completed turn.
        nativeYieldRequested = true;
      }
    }
  };
  const runSyntheticTools = async (): Promise<string | undefined> => {
    if (!syntheticCalls.length) {
      return undefined;
    }
    const calls = syntheticCalls;
    syntheticCalls = [];
    const task = Promise.all(
      calls.map(async (call) => {
        observedCalls.add(call.id);
        await onToolStart(call);
        let result: ClaudeSdkToolResult;
        try {
          result = await execute(
            call.name,
            call.input,
            (chunk) => onToolOutput(call, chunk),
            call.id,
          );
        } catch {
          result = {
            content: "Assistant tool execution failed",
            isError: true,
          };
        }
        result = await finalizeToolResult(call, result);
        await onToolResult(call, result, true);
        return {
          name: call.name,
          input: call.input,
          result: result.content,
          isError: result.isError,
        };
      }),
    );
    syntheticTasks.add(task);
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(terminalError("Claude subscription turn cancelled"));
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) {
        abort();
      }
    });
    let results: Awaited<typeof task>;
    try {
      results = await Promise.race([task, cancelled]);
    } finally {
      if (abort) {
        controller.signal.removeEventListener("abort", abort);
      }
      void task.finally(() => syntheticTasks.delete(task)).catch(() => {});
    }
    return `The assistant's conversation hooks requested these additional tools. These are completed results, not requests to execute them again:\n${JSON.stringify(results)}`;
  };
  const makeBridge = (tools: ToolDefinition[]) => {
    const bridge = createClaudeSdkToolBridge({
      tools,
      toolExecutor: execute,
      signal: controller.signal,
      onToolStart,
      onToolOutput,
      finalizeToolResult,
      onToolResult,
    });
    bridges.push(bridge);
    return bridge;
  };

  let bridge = makeBridge(toolSet);

  const finalizeMessage = async (stopReason: string | null): Promise<void> => {
    if (!startedMessage) {
      return;
    }
    startedMessage = false;
    for (const [index, json] of inputJson) {
      const block = pendingContent[index];
      if (block?.type === "tool_use") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(json || "{}");
        } catch {
          throw terminalError("Claude returned malformed tool arguments");
        }
        const validated = objectSchema.safeParse(parsed);
        if (!validated.success) {
          throw terminalError("Claude returned invalid tool arguments");
        }
        block.input = validated.data;
      }
    }
    inputJson = new Map();
    const original = pendingContent.filter(Boolean);
    const native = original.map(
      (block): ContentBlock =>
        block.type === "tool_use"
          ? { ...block, name: bridge.toVellumName(block.name) ?? block.name }
          : block,
    );
    const post = await runHook(HOOKS.POST_MODEL_CALL, {
      conversationId,
      callSite: run.callSite ?? null,
      content: structuredClone(native),
      messages: [...history],
      stopReason,
      assistantTextSuppressed: run.suppressAssistantText,
      userToldOutcome:
        reportsOutcomeToUser(
          native.filter((block) => block.type === "tool_use"),
        ) ?? userToldOutcome,
      decision: "stop",
    });
    sessionDiverged ||= JSON.stringify(post.content) !== JSON.stringify(native);
    const message: Message = {
      role: "assistant",
      content: run.suppressAssistantText
        ? post.content.filter((block) => block.type !== "thinking")
        : post.content,
    };
    if (
      post.decision === "continue" &&
      !streamed &&
      continuationCount < 5 &&
      !message.content.some((block) => block.type === "tool_use")
    ) {
      continueMessages = post.messages;
      sessionDiverged = true;
      pendingContent = [];
      lastResponseText = "";
      streamingPending = "";
      return;
    }
    lastResponseText = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const nativeIds = new Set(
      native
        .filter((block) => block.type === "tool_use")
        .map((block) => block.id),
    );
    const seenIds = new Set<string>();
    const batch = message.content.filter((block) => block.type === "tool_use");
    for (const block of batch) {
      if (!block.id || seenIds.has(block.id) || approvedCalls.has(block.id)) {
        if (nativeIds.has(block.id)) {
          throw terminalError("Claude repeated an existing tool invocation ID");
        }
        block.id = randomUUID();
      }
      seenIds.add(block.id);
      approvedCalls.set(block.id, block);
      if (!nativeIds.has(block.id)) {
        syntheticCalls.push(block);
        sessionDiverged = true;
      }
    }
    const exclusive = batch.find(
      (block) => getTool(block.name)?.exclusive === true,
    );
    if (exclusive) {
      for (const call of batch) {
        if (call.id !== exclusive.id) {
          deferredCalls.add(call.id);
        }
      }
    }
    userToldOutcome = reportsOutcomeToUser(batch) ?? userToldOutcome;
    append(message);
    await flushText();
    if (
      options.deferAssistantOutput &&
      !run.suppressAssistantText &&
      lastResponseText
    ) {
      await emitText(lastResponseText, true);
      await flushText();
    }
    const delivered = batch
      .map(deliveredUserMessage)
      .filter((text): text is string => text !== null);
    if (run.suppressAssistantText && delivered.length) {
      await emitText(joinDeliveredMessages(delivered), true);
      await flushText();
    }
    if (run.suppressAssistantText && !batch.length) {
      deferredCompletion = message;
    } else {
      await emit({
        type: "message_complete",
        message,
        model,
        ...(run.suppressAssistantText
          ? { assistantTextVisibility: "private" as const }
          : {}),
      });
    }
    for (const block of native) {
      if (block.type === "tool_use") {
        observedCalls.add(block.id);
        pendingStarts.get(block.id)?.resolve();
        pendingStarts.delete(block.id);
      }
    }
    pendingContent = [];
    if (
      post.decision === "continue" &&
      !streamed &&
      continuationCount < 5 &&
      !message.content.some((block) => block.type === "tool_use")
    ) {
      continueMessages = post.messages;
    }
  };

  try {
    if (controller.signal.aborted) {
      reason = "aborted_pre_call";
      return { history, newMessages, exitReason: null, reason };
    }
    const cwd = getSandboxWorkingDir();
    const executablePath =
      getConfig().llm.claudeAgentSdk?.executablePath ?? Bun.which("claude");
    if (!executablePath) {
      throw terminalError(
        "Install Claude Code and sign in on the computer running this assistant, then select Claude subscription again.",
      );
    }
    const auth = await (options.preflight ?? preflightClaudeSdkAuth)({
      executablePath,
      cwd,
      signal: controller.signal,
      env: {
        ...process.env,
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(options.maxTokens),
      },
    });
    if (!auth.ok) {
      throw terminalError(auth.message);
    }
    const store = conversationDir
      ? new ClaudeSdkSessionStore(conversationDir)
      : undefined;
    const fingerprint = createSdkSessionFingerprint({
      model: options.model,
      systemPrompt: options.systemPrompt,
      tools: toolSet,
      executablePath: auth.executablePath,
    });
    const session = await store?.begin({ messages: history, fingerprint });
    // A saved frontier can split a canonical message after role repair. Its
    // boundary indexes that split, not the caller's unsplit outbound copy.
    // Reapply the shared sanitizer only when the store has reshaped history;
    // otherwise preserve the caller's prepared transport representation.
    const promptMessages = session?.resume
      ? preModelCallSanitize(session.messages)
      : session && JSON.stringify(session.messages) !== JSON.stringify(history)
        ? preModelCallSanitize(session.messages)
        : run.messages;
    input.push(
      await prepareSdkPrompt(
        promptMessages,
        session?.sessionId,
        session?.resume ? 0 : session?.currentTurnStart,
      ),
    );
    const sdk =
      options.query ?? (await import("@anthropic-ai/claude-agent-sdk")).query;
    query = sdk({
      prompt: input,
      options: {
        pathToClaudeCodeExecutable: auth.executablePath,
        cwd,
        env: {
          ...auth.env,
          ...claudeSdkTimeoutEnvironment(
            getConfig().timeouts.providerStreamTimeoutSec * 1000,
          ),
        },
        abortController: controller,
        model: options.model,
        ...resolveClaudeSdkInferenceOptions({
          effort: options.effort,
          thinking: options.thinking,
        }),
        systemPrompt: {
          type: "custom",
          prompt: options.systemPrompt,
          snapshot: false,
        },
        tools: [],
        toolAliases: Object.fromEntries(
          toolSet.flatMap((tool) => {
            const name = bridge.toSdkName(tool.name);
            return name ? [[tool.name, name]] : [];
          }),
        ),
        mcpServers: { vellum: bridge.server },
        strictMcpConfig: true,
        settingSources: [],
        settings: { disableAllHooks: true, autoMemoryEnabled: false },
        verbatimPrompts: true,
        skills: [],
        plugins: [],
        permissionMode: "default",
        canUseTool: async () => ({
          behavior: "deny",
          message:
            "Only assistant-managed tools are available in this conversation.",
        }),
        hooks: {
          PreToolUse: [
            { hooks: [async (...args) => bridge.preToolUse(...args)] },
          ],
          PostToolBatch: [
            {
              hooks: [
                async (_input, _toolUseId, hookOptions) => {
                  activeBatchHooks++;
                  try {
                    const synthetic = await runSyntheticTools();
                    const guidance = modelOnlyContext.slice();
                    const additionalContext = [synthetic, ...guidance]
                      .filter(Boolean)
                      .join("\n");
                    if (options.resolveTools) {
                      const next = options.resolveTools(history);
                      const key = JSON.stringify(next);
                      if (key !== lastToolsKey) {
                        toolSet = next;
                        lastToolsKey = key;
                        sessionDiverged = true;
                        const removed = await query?.setMcpServers({});
                        if (removed && Object.keys(removed.errors).length) {
                          throw terminalError(
                            "Claude could not release the previous tool surface",
                          );
                        }
                        const nextBridge = makeBridge(toolSet);
                        const result = await query?.setMcpServers({
                          vellum: nextBridge.server,
                        });
                        bridge = nextBridge;
                        if (result && Object.keys(result.errors).length) {
                          throw terminalError(
                            "Claude could not refresh the assistant's tools",
                          );
                        }
                        options.onToolsSent?.(toolSet);
                      }
                    }
                    const decision = await run.onCheckpoint?.({
                      turnIndex: ++turnIndex,
                      toolCount,
                      hasToolUse: toolCount > 0,
                      history,
                    });
                    if (decision === "handoff") {
                      reason = "checkpoint_handoff";
                      void query?.interrupt().catch(() => {
                        // The subprocess can close before its interrupt acknowledgement.
                        query?.close();
                      });
                      input.end();
                    }
                    // Do not discard queued guidance on a failed/timed-out hook.
                    // A later model frame proves native inference continued after
                    // this callback; the supported SDK retains delivered context.
                    if (
                      hookOptions.signal.aborted ||
                      controller.signal.aborted
                    ) {
                      batchHookFailed = true;
                      return {};
                    }
                    if (
                      getReason() === "yield_to_user" &&
                      nativeYieldRequested &&
                      !yieldInterrupted
                    ) {
                      // The native terminal result must acknowledge this stop.
                      // No next model frame means queued guidance stays pending;
                      // do not silently discard it to make a session reusable.
                      yieldStopSignal = hookOptions.signal;
                      return {
                        continue: false,
                        stopReason: "The assistant has yielded to the user.",
                      };
                    }
                    if (getReason() !== "no_tool_calls") {
                      batchHookFailed = true;
                      return {};
                    }
                    modelOnlyContext.splice(0, guidance.length);
                    guidanceAwaitingModel ||= !!additionalContext;
                    if (additionalContext) {
                      guidanceSignals.push(hookOptions.signal);
                    }
                    return additionalContext
                      ? {
                          hookSpecificOutput: {
                            hookEventName: "PostToolBatch" as const,
                            additionalContext,
                          },
                        }
                      : {};
                  } catch (cause) {
                    batchHookFailed = true;
                    throw cause;
                  } finally {
                    activeBatchHooks--;
                  }
                },
              ],
            },
          ],
        },
        includePartialMessages: true,
        persistSession: !!store,
        title: "Assistant conversation",
        ...(session?.resume
          ? { resume: session.sessionId }
          : session
            ? { sessionId: session.sessionId }
            : {}),
      },
    });
    options.onToolsSent?.(toolSet);
    for await (const event of query) {
      if (event.type === "assistant" && event.error) {
        throw terminalError(
          `Claude subscription request failed (${event.error}). No API fallback was attempted.`,
        );
      }
      if (event.type === "stream_event" && !event.parent_tool_use_id) {
        const frame = event.event;
        if (frame.type === "message_start") {
          observeGuidanceContinuation();
          await finalizeMessage(null);
          // Match the canonical budget gates, before this call adds output.
          estimatedInputTokens = estimatePromptTokensRaw(
            history,
            options.tokenEstimation?.systemPrompt ?? options.systemPrompt,
            {
              providerName:
                options.tokenEstimation?.providerName ?? "anthropic",
              model: options.tokenEstimation
                ? options.tokenEstimation.model
                : options.model,
              toolTokenBudget: estimateToolsTokens(toolSet),
            },
          );
          streamingMessageId = frame.message.id;
          model = frame.message.model;
          pendingStopReason = null;
          messageStartedAt = Date.now();
          pendingUsage = {
            inputTokens: frame.message.usage.input_tokens,
            outputTokens: frame.message.usage.output_tokens,
            cacheCreationInputTokens:
              frame.message.usage.cache_creation_input_tokens ?? 0,
            cacheReadInputTokens:
              frame.message.usage.cache_read_input_tokens ?? 0,
          };
          pendingContent = [];
          startedMessage = true;
          streamed = false;
          await emit({ type: "llm_call_started", callSite: run.callSite });
          run.latencyTracker?.mark("request_sent");
        } else if (frame.type === "content_block_start") {
          const block = frame.content_block;
          if (block.type === "text") {
            pendingContent[frame.index] = { type: "text", text: block.text };
          } else if (block.type === "thinking") {
            pendingContent[frame.index] = {
              type: "thinking",
              thinking: block.thinking,
              signature: block.signature,
            };
          } else if (block.type === "tool_use") {
            pendingContent[frame.index] = {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: {},
            };
            inputJson.set(frame.index, "");
            await emit({
              type: "tool_use_preview_start",
              toolUseId: block.id,
              toolName: bridge.toVellumName(block.name) ?? block.name,
            });
          }
        } else if (frame.type === "content_block_delta") {
          const block = pendingContent[frame.index];
          const delta = frame.delta;
          if (delta.type === "text_delta" && block?.type === "text") {
            block.text += delta.text;
            await emitText(delta.text);
          } else if (
            delta.type === "thinking_delta" &&
            block?.type === "thinking"
          ) {
            block.thinking += delta.thinking;
            run.latencyTracker?.markFirstToken("thinking");
            if (
              !run.suppressAssistantText &&
              options.thinking?.streamThinking !== false
            ) {
              await emit({ type: "thinking_delta", thinking: delta.thinking });
            }
          } else if (
            delta.type === "signature_delta" &&
            block?.type === "thinking"
          ) {
            block.signature += delta.signature;
          } else if (
            delta.type === "input_json_delta" &&
            block?.type === "tool_use"
          ) {
            const json =
              (inputJson.get(frame.index) ?? "") + delta.partial_json;
            inputJson.set(frame.index, json);
            await emit({
              type: "input_json_delta",
              toolUseId: block.id,
              toolName: bridge.toVellumName(block.name) ?? block.name,
              accumulatedJson: json,
            });
          }
        } else if (frame.type === "message_delta") {
          pendingStopReason = frame.delta.stop_reason;
          pendingUsage.outputTokens = frame.usage.output_tokens;
          if (frame.usage.input_tokens != null) {
            pendingUsage.inputTokens = frame.usage.input_tokens;
          }
          if (frame.usage.cache_creation_input_tokens != null) {
            pendingUsage.cacheCreationInputTokens =
              frame.usage.cache_creation_input_tokens;
          }
          if (frame.usage.cache_read_input_tokens != null) {
            pendingUsage.cacheReadInputTokens =
              frame.usage.cache_read_input_tokens;
          }
        } else if (frame.type === "message_stop") {
          lastCallInputTokens =
            pendingUsage.inputTokens +
            pendingUsage.cacheCreationInputTokens +
            pendingUsage.cacheReadInputTokens;
          await emit({
            type: "usage",
            ...pendingUsage,
            estimatedInputTokens,
            inputTokens:
              pendingUsage.inputTokens +
              pendingUsage.cacheCreationInputTokens +
              pendingUsage.cacheReadInputTokens,
            model,
            actualProvider: "claude-agent-sdk",
            providerDurationMs: Date.now() - messageStartedAt,
          });
          estimatedInputTokens = undefined;
          streamedOutputTokens += pendingUsage.outputTokens;
          streamedCallCount += 1;
          if (streamingMessageId) {
            streamedMessageIds.add(streamingMessageId);
          }
          await finalizeMessage(pendingStopReason);
          streamingMessageId = undefined;
        }
      } else if (event.type === "assistant" && !event.parent_tool_use_id) {
        // Partial assistant frames share a message ID and non-final usage.
        // The streaming message_stop is the authoritative completion boundary.
        if (
          !streamedMessageIds.has(event.message.id) &&
          streamingMessageId !== event.message.id &&
          !assistantFrameIds.has(event.uuid)
        ) {
          observeGuidanceContinuation();
          assistantFrameIds.add(event.uuid);
          streamed = false;
          model = event.message.model;
          messageStartedAt = Date.now();
          pendingUsage = {
            inputTokens: event.message.usage.input_tokens,
            outputTokens: event.message.usage.output_tokens,
            cacheCreationInputTokens:
              event.message.usage.cache_creation_input_tokens ?? 0,
            cacheReadInputTokens:
              event.message.usage.cache_read_input_tokens ?? 0,
          };
          startedMessage = true;
          pendingContent = event.message.content.flatMap(
            (block): ContentBlock[] => {
              if (block.type === "text") {
                return [{ type: "text", text: block.text }];
              }
              if (block.type === "thinking") {
                return [
                  {
                    type: "thinking",
                    thinking: block.thinking,
                    signature: block.signature,
                  },
                ];
              }
              if (block.type === "tool_use") {
                const parsed = objectSchema.safeParse(block.input);
                if (!parsed.success) {
                  throw terminalError("Claude returned invalid tool input");
                }
                return [
                  {
                    type: "tool_use",
                    id: block.id,
                    name: block.name,
                    input: parsed.data,
                  },
                ];
              }
              return [];
            },
          );
          if (!fallbackUsage.has(event.message.id)) {
            await emit({ type: "llm_call_started", callSite: run.callSite });
          }
          lastCallInputTokens =
            pendingUsage.inputTokens +
            pendingUsage.cacheCreationInputTokens +
            pendingUsage.cacheReadInputTokens;
          fallbackUsage.set(event.message.id, { model, ...pendingUsage });
          await finalizeMessage(event.message.stop_reason);
        }
      } else if (event.type === "result") {
        await flushFallbackUsage(
          event.usage.output_tokens,
          event.duration_api_ms,
        );
        streamedOutputTokens = 0;
        streamedCallCount = 0;
        await finalizeMessage(event.stop_reason);
        if (
          controller.signal.aborted ||
          getReason() === "checkpoint_handoff" ||
          yieldInterrupted
        ) {
          input.end();
          continue;
        }
        if (event.subtype !== "success" || event.is_error) {
          throw terminalError(
            `Claude subscription ended without completing the turn (${event.subtype}). No API fallback was attempted.`,
          );
        }
        if (getReason() === "yield_to_user") {
          if (!cleanNativeYield() || event.terminal_reason !== "hook_stopped") {
            throw terminalError(
              "Claude did not acknowledge the requested tool-batch stop. The session will be rebuilt safely.",
            );
          }
          sawSuccess = true;
          input.end();
          continue;
        }
        syntheticContext = await runSyntheticTools();
        if (getReason() !== "no_tool_calls") {
          input.end();
          continue;
        }
        if (
          syntheticContext &&
          !controller.signal.aborted &&
          getReason() === "no_tool_calls"
        ) {
          const message: Message = {
            role: "user",
            content: [{ type: "text", text: syntheticContext }],
          };
          append(message);
          const guidance = modelOnlyContext.splice(0).join("\n");
          input.push(
            await prepareSdkPrompt([
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: [syntheticContext, guidance]
                      .filter(Boolean)
                      .join("\n"),
                  },
                ],
              },
            ]),
          );
          continue;
        }
        if (continueMessages && ++continuationCount <= 5) {
          sessionDiverged = true;
          const continuation = continueMessages;
          continueMessages = undefined;
          const prefix = continuation.slice(0, history.length);
          if (JSON.stringify(prefix) !== JSON.stringify(history)) {
            throw terminalError(
              "A conversation hook requested a history rewrite that cannot be applied to an active Claude subscription session. Start a new turn to rebuild context safely.",
            );
          }
          const added = continuation.slice(history.length);
          if (!added.length) {
            throw terminalError(
              "A conversation hook requested continuation without adding context",
            );
          }
          for (const message of added) {
            append(message);
          }
          input.push(await prepareSdkPrompt(added));
          continue;
        }
        sawSuccess = true;
        if (
          (!streamed || run.suppressAssistantText) &&
          !userToldOutcome &&
          lastResponseText
        ) {
          await emitText(lastResponseText, true);
          await flushText();
        }
        if (deferredCompletion) {
          await emit({
            type: "message_complete",
            message: deferredCompletion,
            model,
            assistantTextVisibility:
              !userToldOutcome && !!lastResponseText ? "visible" : "private",
          });
          deferredCompletion = undefined;
        }
        input.end();
      }
    }
    if (controller.signal.aborted) {
      reason = "aborted_via_error";
    } else if (
      !sawSuccess &&
      (getReason() === "no_tool_calls" ||
        (nativeYieldRequested &&
          !yieldInterrupted &&
          getReason() === "yield_to_user"))
    ) {
      throw terminalError(
        "Claude subscription connection closed before a result was received",
      );
    }
    // Complete only an append-only, fully delivered turn. In particular,
    // finally's grace wait / abandoned-call repair must not mutate a session
    // that has already been marked resumable.
    const pendingToolCalls = [...approvedCalls.keys()].filter(
      (id) => !completedCalls.has(id),
    ).length;
    const toolsSettled = bridges.every((item) => item.isSettled());
    if (
      sawSuccess &&
      !sessionDiverged &&
      modelOnlyContext.length === 0 &&
      !guidanceAwaitingModel &&
      !batchHookFailed &&
      activeBatchHooks === 0 &&
      pendingStarts.size === 0 &&
      pendingToolCalls === 0 &&
      toolsSettled &&
      syntheticCalls.length === 0 &&
      syntheticTasks.size === 0 &&
      session &&
      store &&
      (getReason() === "no_tool_calls" || cleanNativeYield())
    ) {
      const completed = await store.complete(session, history);
      log.info(
        { conversationId, completed },
        "Claude SDK session completion attempted",
      );
    } else if (session && store) {
      log.info(
        {
          conversationId,
          sawSuccess,
          sessionDiverged,
          reason,
          pendingGuidance: modelOnlyContext.length,
          guidanceAwaitingModel,
          nativeYieldRequested,
          yieldStopAcknowledged: cleanNativeYield() && sawSuccess,
          batchHookFailed,
          activeBatchHooks,
          pendingStarts: pendingStarts.size,
          pendingToolCalls,
          toolsSettled,
          pendingSynthetic: syntheticCalls.length + syntheticTasks.size,
        },
        "Claude SDK session left non-resumable",
      );
    }
  } catch (cause) {
    const selfInterrupted =
      getReason() === "checkpoint_handoff" ||
      (getReason() === "yield_to_user" && yieldInterrupted);
    if (controller.signal.aborted) {
      reason = "aborted_via_error";
    } else if (selfInterrupted) {
      // We interrupted Claude Code ourselves (queued user message or a
      // synthetic yield-to-user tool). Its CLI then exits with an error result
      // (ede_diagnostic stop_reason=tool_use); that is the expected end of
      // the handoff, not a provider failure. Keep the handoff reason.
      log.info(
        { conversationId, reason: getReason(), err: String(cause) },
        "Claude SDK interrupt for handoff ended the stream (expected)",
      );
    } else {
      reason = "error";
      error =
        cause instanceof Error
          ? cause
          : terminalError("Claude subscription failed");
      await emit({
        type: "provider_error",
        error,
        actualProvider: "claude-agent-sdk",
      });
      await emit({ type: "error", error });
    }
  } finally {
    await flushFallbackUsage();
    input.end();
    if (deferredCompletion) {
      await emit({
        type: "message_complete",
        message: deferredCompletion,
        model,
        assistantTextVisibility: "private",
      });
      deferredCompletion = undefined;
    }
    for (const waiter of pendingStarts.values()) {
      waiter.reject(
        terminalError(
          "Claude subscription turn ended before the tool was admitted",
        ),
      );
    }
    pendingStarts.clear();
    query?.close();
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([
        ...bridges.map((item) => item.settle()),
        ...syntheticTasks,
      ]),
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, 2000);
      }),
    ]);
    if (graceTimer) {
      clearTimeout(graceTimer);
    }
    // Fill abandoned calls before releasing the turn. A late executor result
    // cannot mutate a new turn after this point.
    closed = true;
    for (const id of approvedCalls.keys()) {
      if (!completedCalls.has(id)) {
        const content =
          "The turn ended before this tool reported its result. It may have taken effect; check before retrying.";
        appendToolResult({
          type: "tool_result",
          tool_use_id: id,
          content,
          is_error: true,
        });
        await emit({
          type: "tool_result",
          toolUseId: id,
          content,
          isError: true,
          cancelled: true,
        });
      }
    }
    for (const item of bridges) {
      await item.dispose();
    }
    run.signal?.removeEventListener("abort", cancel);
    run.latencyTracker?.mark("call_complete");
  }
  return {
    history,
    newMessages,
    reason,
    error,
    exitReason: getReason() === "checkpoint_handoff" ? "handoff" : null,
  };
}
