import { describe, expect, mock, test } from "bun:test";

import type { ModelInfo, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeSdkAuthResult } from "./auth.js";
import {
  ClaudeSdkDiscoveredModelSchema,
  createClaudeSdkModelDiscovery,
} from "./models.js";

type Dependencies = NonNullable<
  Parameters<typeof createClaudeSdkModelDiscovery>[0]
>;
type QueryParams = Parameters<NonNullable<Dependencies["query"]>>[0];

const request = { executablePath: "/installed/claude", cwd: "/workspace" };
const model: ModelInfo = {
  value: "sonnet",
  displayName: "Sonnet",
  description: "A model from the installed Claude Code",
};
const authenticated: Extract<ClaudeSdkAuthResult, { ok: true }> = {
  ok: true,
  executablePath: "/resolved/claude",
  env: { HOME: "/home/example", PATH: "/usr/bin" },
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(overrides: Dependencies = {}) {
  const close = mock(() => {});
  const supportedModels = mock(async (): Promise<ModelInfo[]> => [model]);
  const params: QueryParams[] = [];
  const inputReads: Promise<IteratorResult<SDKUserMessage>>[] = [];
  const query = mock((input: QueryParams) => {
    params.push(input);
    inputReads.push(input.prompt[Symbol.asyncIterator]().next());
    return { close, supportedModels };
  });
  const preflight = mock(
    async (): Promise<ClaudeSdkAuthResult> => authenticated,
  );
  const discover = createClaudeSdkModelDiscovery({
    query,
    preflight,
    ...overrides,
  });
  return {
    discover,
    query,
    preflight,
    params,
    inputReads,
    close,
    supportedModels,
  };
}

describe("Claude SDK model discovery", () => {
  test("uses native initialization without yielding any inference input", async () => {
    const f = fixture({ now: () => Date.UTC(2026, 0, 1) });
    let inputSettled = false;
    const nativeModel = {
      ...model,
      resolvedModel: "claude-sonnet-example",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsFastMode: false,
      supportsAutoMode: false,
      contextWindow: 123456,
    };
    f.supportedModels.mockImplementation(async () => {
      void f.inputReads[0]!.then(() => {
        inputSettled = true;
      });
      await Promise.resolve();
      expect(inputSettled).toBe(false);
      return [
        { ...nativeModel, supportedEffortLevels: ["low", "high", "xhigh"] },
      ];
    });

    const result = await f.discover(request);
    expect(result).toEqual({
      ok: true,
      fetchedAt: "2026-01-01T00:00:00.000Z",
      models: [
        {
          id: "sonnet",
          provider: "claude-agent-sdk",
          displayName: model.displayName,
          description: model.description,
          resolvedModel: nativeModel.resolvedModel,
          supportsEffort: true,
          supportedEffortLevels: ["low", "high", "xhigh"],
          supportsAdaptiveThinking: true,
          supportsFastMode: false,
          supportsAutoMode: false,
        },
      ],
    });
    const options = f.params[0]!.options;
    expect(options.pathToClaudeCodeExecutable).toBe(
      authenticated.executablePath,
    );
    expect(options.env).toEqual(authenticated.env);
    expect(options.cwd).toBe(request.cwd);
    expect(options.tools).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settingSources).toEqual([]);
    expect(options.settings).toEqual({
      disableAllHooks: true,
      autoMemoryEnabled: false,
    });
    expect(options.skills).toEqual([]);
    expect(options.plugins).toEqual([]);
    expect(options.persistSession).toBe(false);
    expect(options.model).toBeUndefined();
    expect(options.resume).toBeUndefined();
    expect(options.abortController?.signal.aborted).toBe(true);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(await f.inputReads[0]).toEqual({ done: true, value: undefined });
  });

  test("does not infer missing capability or token metadata", async () => {
    const f = fixture();
    const result = await f.discover(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models).toEqual([
        {
          id: model.value,
          provider: "claude-agent-sdk",
          displayName: model.displayName,
          description: model.description,
        },
      ]);
      expect(
        ClaudeSdkDiscoveredModelSchema.safeParse(result.models[0]).success,
      ).toBe(true);
    }
  });

  test("accepts an empty supported model list without fallback models", async () => {
    const f = fixture();
    f.supportedModels.mockResolvedValue([]);
    const result = await f.discover(request);
    expect(result.ok && result.models).toEqual([]);
  });

  test("reuses successful metadata briefly while rechecking auth", async () => {
    let now = 0;
    const f = fixture({ now: () => now, cacheTtlMs: 100 });
    const first = await f.discover(request);
    if (first.ok) {
      first.models[0]!.displayName = "Mutated by caller";
    }
    const second = await f.discover(request);
    expect(second.ok && second.models[0]!.displayName).toBe(model.displayName);
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.preflight).toHaveBeenCalledTimes(2);
    now = 100;
    await f.discover(request);
    expect(f.query).toHaveBeenCalledTimes(2);
  });

  test("refresh initializes a fresh query and never falls back after failure", async () => {
    const f = fixture();
    await f.discover(request);
    f.supportedModels.mockRejectedValueOnce(
      new Error("private native details"),
    );
    const failed = await f.discover({ ...request, refresh: true });
    expect(failed).toMatchObject({ ok: false, reason: "discovery_failed" });
    expect(JSON.stringify(failed)).not.toContain("private native details");
    expect(f.close).toHaveBeenCalledTimes(2);
    await f.discover(request);
    expect(f.query).toHaveBeenCalledTimes(3);
  });

  test("coalesces concurrent metadata requests including explicit refreshes", async () => {
    const answer = deferred<ModelInfo[]>();
    const started = deferred<void>();
    const f = fixture();
    f.supportedModels.mockImplementation(() => {
      started.resolve();
      return answer.promise;
    });
    const first = f.discover(request);
    await started.promise;
    const second = f.discover({ ...request, refresh: true });
    await Bun.sleep(0);
    expect(f.query).toHaveBeenCalledTimes(1);
    answer.resolve([model]);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  test("separates metadata by validated executable, working directory and environment", async () => {
    const f = fixture();
    await f.discover(request);
    f.preflight.mockResolvedValue({
      ...authenticated,
      executablePath: "/other/claude",
    });
    await f.discover(request);
    await f.discover({ ...request, cwd: "/other/workspace" });
    f.preflight.mockResolvedValue({
      ...authenticated,
      executablePath: "/other/claude",
      env: { ...authenticated.env, CLAUDE_CONFIG_DIR: "/other/config" },
    });
    await f.discover({ ...request, cwd: "/other/workspace" });
    expect(f.query).toHaveBeenCalledTimes(4);
  });

  test("an auth guard failure cannot use previously cached metadata", async () => {
    const f = fixture();
    await f.discover(request);
    const failure: ClaudeSdkAuthResult = {
      ok: false,
      reason: "environment_conflict",
      message: "Conflicting provider environment",
    };
    f.preflight.mockResolvedValue(failure);
    expect(await f.discover(request)).toEqual(failure);
    expect(f.query).toHaveBeenCalledTimes(1);
    f.preflight.mockResolvedValue(authenticated);
    await f.discover(request);
    expect(f.query).toHaveBeenCalledTimes(2);
  });

  test("auth failure also invalidates metadata still in flight before recovery", async () => {
    const oldAnswer = deferred<ModelInfo[]>();
    const started = deferred<void>();
    const f = fixture();
    f.supportedModels.mockImplementationOnce(() => {
      started.resolve();
      return oldAnswer.promise;
    });
    const original = f.discover(request);
    await started.promise;
    f.preflight.mockResolvedValueOnce({
      ok: false,
      reason: "subscription_required",
      message: "Subscription required",
    });
    expect(await f.discover(request)).toMatchObject({ ok: false });
    const recovered = await f.discover(request);
    expect(recovered.ok && recovered.models[0]!.displayName).toBe(
      model.displayName,
    );
    oldAnswer.resolve([{ ...model, displayName: "Before auth failure" }]);
    await original;
    const cached = await f.discover(request);
    expect(cached).toEqual(recovered);
    expect(f.query).toHaveBeenCalledTimes(2);
  });

  test("passes raw environment only to the shared preflight guard", async () => {
    const calls: Parameters<NonNullable<Dependencies["preflight"]>>[0][] = [];
    const f = fixture({
      preflight: async (options) => {
        calls.push(options);
        return authenticated;
      },
    });
    const env = { PATH: "/local/bin", VELLUM_UNRELATED_SETTING: "example" };
    await f.discover({ ...request, env });
    expect(calls[0]?.env).toBe(env);
    expect(calls[0]?.executablePath).toBe(request.executablePath);
    expect(calls[0]?.cwd).toBe(request.cwd);
    expect(calls[0]?.signal).toBeDefined();
    expect(f.params[0]?.options.env).toEqual(authenticated.env);
  });

  test("malformed subprocess metadata fails validation and closes the query", async () => {
    const f = fixture();
    // @ts-expect-error Deliberately invalid external subprocess metadata.
    f.supportedModels.mockResolvedValue([{ ...model, supportsEffort: "yes" }]);
    expect(await f.discover(request)).toMatchObject({
      ok: false,
      reason: "invalid_models",
    });
    expect(f.close).toHaveBeenCalledTimes(1);
    f.supportedModels.mockResolvedValue([
      // @ts-expect-error Deliberately unsupported external effort value.
      { ...model, supportedEffortLevels: ["extreme"] },
    ]);
    expect(await f.discover(request)).toMatchObject({
      ok: false,
      reason: "invalid_models",
    });
    expect(f.query).toHaveBeenCalledTimes(2);
  });

  test("query creation errors are safe and are not cached", async () => {
    const query = mock(() => {
      throw new Error("private native details");
    });
    const f = fixture({ query });
    const result = await f.discover(request);
    expect(result).toMatchObject({ ok: false, reason: "discovery_failed" });
    expect(JSON.stringify(result)).not.toContain("private native details");
    await f.discover(request);
    expect(query).toHaveBeenCalledTimes(2);
  });

  test("unexpected preflight rejection cannot launch the SDK or leak details", async () => {
    const f = fixture({
      preflight: async () => {
        throw new Error("private auth details");
      },
    });
    const result = await f.discover(request);
    expect(result).toMatchObject({ ok: false, reason: "discovery_failed" });
    expect(JSON.stringify(result)).not.toContain("private auth details");
    expect(f.query).not.toHaveBeenCalled();
  });

  test("a hung metadata request aborts, closes, and drains its zero-message input", async () => {
    const f = fixture({ timeoutMs: 30 });
    f.supportedModels.mockImplementation(() => new Promise(() => {}));
    expect(await f.discover(request)).toMatchObject({
      ok: false,
      reason: "discovery_timeout",
    });
    expect(f.params[0]!.options.abortController?.signal.aborted).toBe(true);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(await f.inputReads[0]).toEqual({ done: true, value: undefined });
  });

  test("a timed out preflight cannot launch a late query", async () => {
    const auth = deferred<ClaudeSdkAuthResult>();
    let signal: AbortSignal | undefined;
    const f = fixture({
      timeoutMs: 20,
      preflight: (options) => {
        signal = options.signal;
        return auth.promise;
      },
    });
    expect(await f.discover(request)).toMatchObject({
      ok: false,
      reason: "discovery_timeout",
    });
    expect(signal?.aborted).toBe(true);
    auth.resolve(authenticated);
    await Bun.sleep(0);
    expect(f.query).not.toHaveBeenCalled();
  });

  test("late metadata after timeout is not cached and retry creates a fresh query", async () => {
    const late = deferred<ModelInfo[]>();
    const f = fixture({ timeoutMs: 20 });
    f.supportedModels.mockImplementationOnce(() => late.promise);
    expect(await f.discover(request)).toMatchObject({
      ok: false,
      reason: "discovery_timeout",
    });
    late.resolve([{ ...model, displayName: "Late result" }]);
    await Bun.sleep(0);
    const retry = await f.discover(request);
    expect(retry.ok && retry.models[0]!.displayName).toBe(model.displayName);
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.close).toHaveBeenCalledTimes(2);
  });

  test("auth and initialization share one overall discovery deadline", async () => {
    const f = fixture({
      timeoutMs: 60,
      preflight: async () => {
        await Bun.sleep(40);
        return authenticated;
      },
    });
    f.supportedModels.mockImplementation(async () => {
      await Bun.sleep(40);
      return [model];
    });
    expect(await f.discover(request)).toMatchObject({
      ok: false,
      reason: "discovery_timeout",
    });
    expect(f.close).toHaveBeenCalledTimes(1);
  });
});
