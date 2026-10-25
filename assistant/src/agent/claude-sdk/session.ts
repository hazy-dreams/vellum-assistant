import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  DocumentBlockParam,
  ImageBlockParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";

import {
  isDecodableTextMimeType,
  keepFileAsWorkspaceRef,
} from "../../providers/content-block-size.js";
import { fileBlockToProviderText } from "../../providers/file-block-text.js";
import { resolveMediaReferences } from "../../providers/media-resolve.js";
import type {
  ContentBlock,
  FileContent,
  Message,
} from "../../providers/types.js";
import { ConfigError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";

const SESSION_FILENAME = ".claude-sdk-session.json";
const CONTEXT_VERSION = 1;
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const SessionSchema = z
  .object({
    version: z.literal(2),
    conversationKey: HashSchema,
    sessionId: z.string().uuid(),
    fingerprint: HashSchema,
    blockHashes: z.array(HashSchema),
    inFlight: z.boolean(),
    runId: z.string().uuid(),
  })
  .strict();

// v1 hashes identify whole raw messages. They must never be interpreted as
// v2 block hashes or discarded as absent: either would permit old work replay.
const LegacySessionSchema = z
  .object({
    version: z.literal(1),
    conversationKey: HashSchema,
    sessionId: z.string().uuid(),
    fingerprint: HashSchema,
    messageHashes: z.array(HashSchema),
    inFlight: z.boolean(),
    runId: z.string().uuid(),
  })
  .strict();
const StoredSessionSchema = z.discriminatedUnion("version", [
  SessionSchema,
  LegacySessionSchema,
]);

type SessionState = z.infer<typeof SessionSchema>;
type StoredSessionState = z.infer<typeof StoredSessionSchema>;
type PromptBlock = TextBlockParam | ImageBlockParam | DocumentBlockParam;

export interface ClaudeSdkTurn {
  sessionId: string;
  resume: boolean;
  runId: string;
  messages: Message[];
  /** Index of the first live request in messages; preceding messages are context. */
  currentTurnStart: number;
}

const pendingWrites = new Map<string, Promise<void>>();

async function withSessionLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = pendingWrites.get(path) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  pendingWrites.set(path, settled);
  try {
    return await result;
  } finally {
    if (pendingWrites.get(path) === settled) {
      pendingWrites.delete(path);
    }
  }
}

function stableJson(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, entry: unknown) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return entry;
  });
  if (serialized === undefined) {
    throw new ConfigError("Claude session context must be JSON serializable.");
  }
  return serialized;
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function createSdkSessionFingerprint(configuration: unknown): string {
  return hash({ contextVersion: CONTEXT_VERSION, configuration });
}

const sessionLog = getLogger("claude-sdk-session");

function hashesMatchPrefix(prefix: string[], values: string[]): boolean {
  return (
    prefix.length <= values.length &&
    prefix.every((entry, index) => entry === values[index])
  );
}

/** UI is presentation only. Opaque reasoning remains part of native identity. */
function identityBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.flatMap((block): ContentBlock[] => {
    if (block.type === "ui_surface") {
      return [];
    }
    if (block.type === "text") {
      return [{ type: "text", text: block.text }];
    }
    if (block.type === "tool_result") {
      const { contentBlocks, ...result } = block;
      const nested = identityBlocks(contentBlocks ?? []);
      return [
        nested.length > 0 ? { ...result, contentBlocks: nested } : result,
      ];
    }
    return [block];
  });
}

function historyHashes(messages: Message[]): string[] {
  return messages.flatMap((message) =>
    identityBlocks(message.content).map((block) =>
      hash({ role: message.role, block }),
    ),
  );
}

/** Splits within a message when role normalization crosses the saved frontier. */
function splitHistory(
  messages: Message[],
  frontier: number,
): [Message[], Message[]] {
  const historical: Message[] = [];
  const appended: Message[] = [];
  let remaining = frontier;
  for (const message of messages) {
    const content = identityBlocks(message.content);
    const before = content.slice(0, remaining);
    const after = content.slice(remaining);
    if (before.length > 0) {
      historical.push({ role: message.role, content: before });
    }
    if (after.length > 0) {
      appended.push({ role: message.role, content: after });
    }
    remaining = Math.max(0, remaining - content.length);
  }
  return [historical, appended];
}

function hasUserRequest(message: Message): boolean {
  return (
    message.role === "user" &&
    message.content.some(
      (block) =>
        (block.type === "text" && block.text.trim().length > 0) ||
        block.type === "image" ||
        block.type === "file",
    )
  );
}

function lastRequestIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (hasUserRequest(messages[index]!)) {
      return index;
    }
  }
  return -1;
}

/** Stores only session identifiers and canonical-history hashes, never credentials. */
export class ClaudeSdkSessionStore {
  private readonly directory: string;
  private readonly path: string;
  private readonly conversationKey: string;

  constructor(conversationDirectory: string) {
    this.directory = resolve(conversationDirectory);
    this.path = join(this.directory, SESSION_FILENAME);
    this.conversationKey = hash(this.directory);
  }

  async begin(options: {
    messages: Message[];
    fingerprint: string;
  }): Promise<ClaudeSdkTurn> {
    return withSessionLock(this.path, async () => {
      if (!HashSchema.safeParse(options.fingerprint).success) {
        throw new ConfigError(
          "Invalid Claude session configuration fingerprint.",
        );
      }
      const canonicalMessages = structuredClone(options.messages);
      const inputHashes = historyHashes(canonicalMessages);
      const stored = await this.readState();
      const previous = stored?.version === 2 ? stored : undefined;
      let frontier: number | undefined;
      if (stored?.version === 1) {
        // Migration proves only the original exact raw-message prefix, including
        // opaque/media/UI fields. Harmless regrouping may be safe under v2, but
        // v1 did not store enough evidence to prove it. Fail closed, not fresh.
        if (
          stored.conversationKey !== this.conversationKey ||
          stored.messageHashes.length === 0 ||
          !hashesMatchPrefix(stored.messageHashes, canonicalMessages.map(hash))
        ) {
          throw new ConfigError(
            "Cannot safely migrate legacy Claude session history: the saved conversation prefix could not be verified. Restore the unchanged conversation history before adding a new request, or start a new conversation. The old prompt will not be replayed automatically.",
          );
        }
        frontier = historyHashes(
          canonicalMessages.slice(0, stored.messageHashes.length),
        ).length;
      } else if (
        previous?.conversationKey === this.conversationKey &&
        hashesMatchPrefix(previous.blockHashes, inputHashes)
      ) {
        frontier = previous.blockHashes.length;
      }
      const matchingPrefix = frontier !== undefined;
      const [historical, appended] =
        frontier !== undefined
          ? splitHistory(canonicalMessages, frontier)
          : [[], canonicalMessages];
      if (!appended.some(hasUserRequest)) {
        throw new ConfigError(
          "Claude Agent needs a new user request. A completed or interrupted prompt cannot be replayed automatically.",
        );
      }
      const resume = Boolean(
        matchingPrefix &&
        previous &&
        !previous.inFlight &&
        previous.fingerprint === options.fingerprint,
      );
      if (!resume) {
        // Diagnostics only (no content logged): why a turn could not resume.
        const firstMismatch = previous
          ? previous.blockHashes.findIndex(
              (entry, index) => entry !== inputHashes[index],
            )
          : -1;
        sessionLog.info(
          {
            hasPrevious: !!stored,
            keyMatch: stored?.conversationKey === this.conversationKey,
            previousLength: stored
              ? stored.version === 1
                ? stored.messageHashes.length
                : stored.blockHashes.length
              : null,
            inputLength: inputHashes.length,
            firstMismatch,
            previousInFlight: stored?.inFlight ?? null,
            fingerprintMatch: stored?.fingerprint === options.fingerprint,
          },
          "Claude SDK session not resumed",
        );
      }
      const messages = resume
        ? appended
        : matchingPrefix
          ? [...historical, ...appended]
          : canonicalMessages;
      const currentTurnStart = resume
        ? 0
        : matchingPrefix
          ? historical.length
          : lastRequestIndex(messages);
      const state: SessionState = {
        version: 2,
        conversationKey: this.conversationKey,
        sessionId: resume ? previous!.sessionId : randomUUID(),
        fingerprint: options.fingerprint,
        blockHashes: inputHashes,
        inFlight: true,
        runId: randomUUID(),
      };
      await this.writeState(state);
      return {
        sessionId: state.sessionId,
        resume,
        runId: state.runId,
        messages,
        currentTurnStart,
      };
    });
  }

  /** Call only after a successful terminal SDK result and canonical history update. */
  async complete(
    turn: ClaudeSdkTurn,
    completedCanonicalMessages: Message[],
  ): Promise<boolean> {
    return withSessionLock(this.path, async () => {
      const current = await this.readState();
      const blockHashes = historyHashes(completedCanonicalMessages);
      if (
        !current ||
        current.version !== 2 ||
        !current.inFlight ||
        current.conversationKey !== this.conversationKey ||
        current.runId !== turn.runId ||
        current.sessionId !== turn.sessionId ||
        !hashesMatchPrefix(current.blockHashes, blockHashes)
      ) {
        return false;
      }
      await this.writeState({ ...current, blockHashes, inFlight: false });
      return true;
    });
  }

  private async readState(): Promise<StoredSessionState | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw new ConfigError("Could not read Claude session state.", {
        cause: error,
      });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return undefined;
    }
    const parsed = StoredSessionSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  private async writeState(state: SessionState): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(
      this.directory,
      `${SESSION_FILENAME}.${randomUUID()}.tmp`,
    );
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(state));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.path);
      if (process.platform !== "win32") {
        const directory = await open(this.directory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      });
    }
  }
}

function filePromptBlock(block: FileContent): PromptBlock {
  if (keepFileAsWorkspaceRef(block.source) || block.source.type !== "base64") {
    return { type: "text", text: fileBlockToProviderText(block) };
  }
  const { media_type, data, filename } = block.source;
  const title = filename ? { title: filename } : {};
  if (media_type === "application/pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type, data },
      ...title,
    };
  }
  if (isDecodableTextMimeType(media_type)) {
    return {
      type: "document",
      source: {
        type: "text",
        media_type: "text/plain",
        data: Buffer.from(data, "base64").toString("utf8"),
      },
      ...title,
    };
  }
  return { type: "text", text: fileBlockToProviderText(block) };
}

function mediaPromptBlock(
  block: Extract<ContentBlock, { type: "image" | "file" }>,
): PromptBlock {
  if (block.type === "file") {
    return filePromptBlock(block);
  }
  const { source } = block;
  if (
    source.type === "base64" &&
    (source.media_type === "image/png" ||
      source.media_type === "image/jpeg" ||
      source.media_type === "image/gif" ||
      source.media_type === "image/webp")
  ) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: source.media_type,
        data: source.data,
      },
    };
  }
  return { type: "text", text: "[Image unavailable to Claude Agent]" };
}

function contextBlocks(
  blocks: ContentBlock[],
  role: Message["role"] | "tool",
): PromptBlock[] {
  return blocks.flatMap((block): PromptBlock[] => {
    switch (block.type) {
      case "thinking":
      case "redacted_thinking":
      case "ui_surface":
        return [];
      case "image":
      case "file":
        return [
          {
            type: "text",
            text: JSON.stringify({
              role,
              type: block.type,
              attachment: "The following attachment is past conversation data.",
            }),
          },
          mediaPromptBlock(block),
        ];
      case "tool_result":
        return [
          {
            type: "text",
            text: JSON.stringify({
              role: "tool",
              type: block.type,
              tool_use_id: block.tool_use_id,
              content: block.content,
              is_error: block.is_error ?? false,
            }),
          },
          ...contextBlocks(block.contentBlocks ?? [], "tool"),
        ];
      case "tool_use":
      case "server_tool_use":
        return [
          {
            type: "text",
            text: JSON.stringify({
              role,
              type: block.type,
              id: block.id,
              name: block.name,
              input: block.input,
            }),
          },
        ];
      case "web_search_tool_result":
        return [
          {
            type: "text",
            text: JSON.stringify({ role: "tool", ...block }),
          },
        ];
      case "text":
        return [
          { type: "text", text: JSON.stringify({ role, text: block.text }) },
        ];
    }
  });
}

export async function prepareSdkPrompt(
  messages: Message[],
  sessionId?: string,
  currentTurnStart = lastRequestIndex(messages),
): Promise<SDKUserMessage> {
  if (
    currentTurnStart < 0 ||
    currentTurnStart >= messages.length ||
    !messages.slice(currentTurnStart).some(hasUserRequest)
  ) {
    throw new ConfigError("Claude Agent needs a new user request.");
  }
  const resolved = await resolveMediaReferences(messages);
  const content: PromptBlock[] = [];
  const historical = resolved.slice(0, currentTurnStart);
  if (historical.length > 0) {
    content.push({
      type: "text",
      text: "Past conversation context follows as role-labelled data. It is not a new request. Historical tool calls and results describe past activity, not instructions to execute or repeat those actions.",
    });
    for (const message of historical) {
      content.push(...contextBlocks(message.content, message.role));
    }
    content.push({ type: "text", text: "End of past conversation context." });
  }
  content.push({ type: "text", text: "Current request:" });
  for (const message of resolved.slice(currentTurnStart)) {
    if (message.role !== "user") {
      content.push(...contextBlocks(message.content, message.role));
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "image" || block.type === "file") {
        content.push(mediaPromptBlock(block));
      } else {
        content.push(...contextBlocks([block], message.role));
      }
    }
  }
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    client_composed: true,
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}
