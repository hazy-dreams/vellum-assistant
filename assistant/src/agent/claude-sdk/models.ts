import { createHash } from "node:crypto";

import type {
  ModelInfo,
  Options,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { type ClaudeSdkAuthResult, preflightClaudeSdkAuth } from "./auth.js";

const DISCOVERY_TIMEOUT_MS = 15_000;
const MODEL_CACHE_TTL_MS = 5 * 60_000;

const SdkModelInfoSchema = z.object({
  value: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string(),
  resolvedModel: z.string().min(1).optional(),
  supportsEffort: z.boolean().optional(),
  supportedEffortLevels: z
    .array(z.enum(["low", "medium", "high", "xhigh", "max"]))
    .optional(),
  supportsAdaptiveThinking: z.boolean().optional(),
  supportsFastMode: z.boolean().optional(),
  supportsAutoMode: z.boolean().optional(),
}) satisfies z.ZodType<ModelInfo>;

export const ClaudeSdkDiscoveredModelSchema = SdkModelInfoSchema.omit({
  value: true,
}).extend({
  id: z.string().min(1),
  provider: z.literal("claude-agent-sdk"),
});

export type ClaudeSdkDiscoveredModel = z.infer<
  typeof ClaudeSdkDiscoveredModelSchema
>;

export type ClaudeSdkModelDiscoveryResult =
  | {
      ok: true;
      models: ClaudeSdkDiscoveredModel[];
      fetchedAt: string;
    }
  | Exclude<ClaudeSdkAuthResult, { ok: true }>
  | {
      ok: false;
      reason: "discovery_timeout" | "discovery_failed" | "invalid_models";
      message: string;
    };

interface DiscoveryOptions {
  executablePath: string;
  cwd: string;
  refresh?: boolean;
  env?: NodeJS.ProcessEnv;
}

type ModelQuery = Pick<Query, "supportedModels" | "close">;

interface DiscoveryDependencies {
  query?: (params: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: Options;
  }) => ModelQuery;
  preflight?: typeof preflightClaudeSdkAuth;
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
}

const timeoutResult = {
  ok: false,
  reason: "discovery_timeout",
  message: "Claude model discovery timed out. Check Claude Code and try again.",
} as const;

const failedResult = {
  ok: false,
  reason: "discovery_failed",
  message:
    "Claude models could not be discovered. Check the installed Claude Code and try again.",
} as const;

function discoveryKey(
  executablePath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  epoch: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        epoch,
        executablePath,
        cwd,
        Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");
}

/** A separate instance keeps mocked transports and their caches test-local. */
export function createClaudeSdkModelDiscovery(
  dependencies: DiscoveryDependencies = {},
): (options: DiscoveryOptions) => Promise<ClaudeSdkModelDiscoveryResult> {
  const now = dependencies.now ?? Date.now;
  const timeoutMs = dependencies.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const cacheTtlMs = dependencies.cacheTtlMs ?? MODEL_CACHE_TTL_MS;
  const inFlight = new Map<
    string,
    {
      options: DiscoveryOptions;
      promise: Promise<ClaudeSdkModelDiscoveryResult>;
    }
  >();
  let authEpoch = 0;
  let cache:
    | {
        key: string;
        expiresAt: number;
        result: Extract<ClaudeSdkModelDiscoveryResult, { ok: true }>;
      }
    | undefined;

  async function bounded<T>(
    run: (controller: AbortController) => Promise<T>,
    remainingMs: number,
  ): Promise<T | typeof timeoutResult | typeof failedResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(controller),
        new Promise<typeof timeoutResult>((resolve) => {
          timer = setTimeout(
            () => {
              resolve(timeoutResult);
              controller.abort();
            },
            Math.max(0, remainingMs),
          );
        }),
      ]);
    } catch {
      // Native errors can contain paths or environment details.
      return failedResult;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function loadModels(
    auth: Extract<ClaudeSdkAuthResult, { ok: true }>,
    cwd: string,
    remainingMs: number,
  ): Promise<ClaudeSdkModelDiscoveryResult> {
    let query: ModelQuery | undefined;
    let endInput: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      endInput = resolve;
    });
    // supportedModels waits for initialization. No user message is submitted,
    // and stdin stays open until metadata or the deadline ends the query.
    const prompt: AsyncIterable<SDKUserMessage> = {
      async *[Symbol.asyncIterator]() {
        await closed;
      },
    };
    try {
      return await bounded(async (controller) => {
        const sdkQuery =
          dependencies.query ??
          (await import("@anthropic-ai/claude-agent-sdk")).query;
        if (controller.signal.aborted) {
          return timeoutResult;
        }
        query = sdkQuery({
          prompt,
          options: {
            pathToClaudeCodeExecutable: auth.executablePath,
            cwd,
            env: auth.env,
            abortController: controller,
            tools: [],
            mcpServers: {},
            strictMcpConfig: true,
            settingSources: [],
            settings: { disableAllHooks: true, autoMemoryEnabled: false },
            skills: [],
            plugins: [],
            persistSession: false,
            permissionMode: "default",
            canUseTool: async () => ({
              behavior: "deny",
              message: "Tools are unavailable during model discovery.",
            }),
          },
        });
        const parsed = z
          .array(SdkModelInfoSchema)
          .safeParse(await query.supportedModels());
        if (!parsed.success) {
          return {
            ok: false,
            reason: "invalid_models",
            message:
              "Claude Code returned unsupported model metadata. Update Claude Code and try again.",
          } as const;
        }
        return {
          ok: true,
          models: parsed.data.map(({ value, ...metadata }) => ({
            id: value,
            provider: "claude-agent-sdk",
            ...metadata,
          })),
          fetchedAt: new Date(now()).toISOString(),
        } satisfies ClaudeSdkModelDiscoveryResult;
      }, remainingMs);
    } finally {
      endInput();
      try {
        query?.close();
      } catch {
        // The bounded operation also aborts the native transport.
      }
    }
  }

  async function discover(
    options: DiscoveryOptions,
    epoch: number,
    requestKey: string,
  ): Promise<ClaudeSdkModelDiscoveryResult> {
    try {
      const startedAt = performance.now();
      // Cached metadata must still pass the runtime's subscription and
      // provider-environment guard.
      const auth = await bounded(
        (controller) =>
          (dependencies.preflight ?? preflightClaudeSdkAuth)({
            executablePath: options.executablePath,
            cwd: options.cwd,
            env: options.env,
            signal: controller.signal,
          }),
        timeoutMs,
      );
      if (!auth.ok) {
        cache = undefined;
        authEpoch += 1;
        return auth;
      }
      const key = discoveryKey(
        auth.executablePath,
        options.cwd,
        auth.env,
        epoch,
      );
      if (options.refresh && cache?.key === key) {
        cache = undefined;
      }
      const remainingMs = timeoutMs - (performance.now() - startedAt);
      if (remainingMs <= 0) {
        return timeoutResult;
      }
      if (cache?.key === key && cache.expiresAt > now()) {
        return cache.result;
      }
      const result = await loadModels(auth, options.cwd, remainingMs);
      if (result.ok && epoch === authEpoch) {
        cache = { key, expiresAt: now() + cacheTtlMs, result };
      }
      return result;
    } finally {
      inFlight.delete(requestKey);
    }
  }

  return async (options) => {
    const request = { ...options, env: { ...(options.env ?? process.env) } };
    const epoch = authEpoch;
    const key = discoveryKey(
      request.executablePath,
      request.cwd,
      request.env,
      epoch,
    );
    let pending = inFlight.get(key);
    if (pending) {
      pending.options.refresh ||= request.refresh;
    } else {
      // Install the flight before preflight can launch any subprocesses.
      const promise = Promise.resolve().then(() =>
        discover(request, epoch, key),
      );
      pending = { options: request, promise };
      inFlight.set(key, pending);
    }
    return structuredClone(await pending.promise);
  };
}

export const discoverClaudeSdkModels = createClaudeSdkModelDiscovery();
