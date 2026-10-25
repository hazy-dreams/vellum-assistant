import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { assertNotLiveDb } from "../../__tests__/assert-not-live-db.js";
import { createInlineAttachment } from "../../persistence/attachments-store.js";
import { createConversation } from "../../persistence/conversation-crud.js";
import { initializeDb } from "../../persistence/db-init.js";
import type { ContentBlock, Message } from "../../providers/types.js";
import {
  ClaudeSdkSessionStore,
  createSdkSessionFingerprint,
  prepareSdkPrompt,
} from "./session.js";

const SESSION_FILENAME = ".claude-sdk-session.json";
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const fingerprint = createSdkSessionFingerprint({
  model: "claude-test-model",
  tools: [{ name: "example", input_schema: { type: "object" } }],
  systemPrompt: "Example system prompt.",
});

function user(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function promptContent(prompt: SDKUserMessage) {
  const content = prompt.message.content;
  if (typeof content === "string") {
    throw new Error("Expected structured prompt content");
  }
  return content;
}

function promptText(prompt: SDKUserMessage): string {
  return promptContent(prompt)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

let directory: string;
let store: ClaudeSdkSessionStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "claude-session-test-"));
  store = new ClaudeSdkSessionStore(directory);
});

afterEach(async () => {
  assertNotLiveDb(directory);
  await rm(directory, { recursive: true, force: true });
});

describe("ClaudeSdkSessionStore", () => {
  test("writes a dirty non-secret mapping before a query can launch", async () => {
    const conversationDirectory = join(directory, "conversation");
    const nested = new ClaudeSdkSessionStore(conversationDirectory);
    const messages = [
      user("Do not persist this prompt in the session mapping"),
    ];
    const turn = await nested.begin({ messages, fingerprint });
    const serialized = await readFile(
      join(conversationDirectory, SESSION_FILENAME),
      "utf8",
    );
    const state: unknown = JSON.parse(serialized);
    expect(state).toMatchObject({
      version: 1,
      sessionId: turn.sessionId,
      runId: turn.runId,
      inFlight: true,
      fingerprint,
    });
    expect(turn.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(serialized).not.toContain("Do not persist");
    expect(turn.resume).toBe(false);
    expect(turn.messages).toEqual(messages);
    expect(await readdir(conversationDirectory)).toEqual([SESSION_FILENAME]);
  });

  test("resumes consecutive turns with only the appended messages after restart", async () => {
    const first = await store.begin({ messages: [user("First")], fingerprint });
    const completed = [user("First"), assistant("First answer")];
    expect(await store.complete(first, completed)).toBe(true);

    const restarted = new ClaudeSdkSessionStore(directory);
    const second = await restarted.begin({
      messages: [...completed, user("Second"), user("Also this")],
      fingerprint,
    });
    expect(second.resume).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.runId).not.toBe(first.runId);
    expect(second.messages).toEqual([user("Second"), user("Also this")]);
    expect(second.currentTurnStart).toBe(0);
    const secondCompleted = [
      ...completed,
      ...second.messages,
      assistant("Second answer"),
    ];
    expect(await restarted.complete(second, secondCompleted)).toBe(true);
    const third = await store.begin({
      messages: [...secondCompleted, user("Third")],
      fingerprint,
    });
    expect(third.resume).toBe(true);
    expect(third.sessionId).toBe(first.sessionId);
    expect(third.messages).toEqual([user("Third")]);
  });

  test("starts fresh on model, tool, or system configuration changes", async () => {
    const first = await store.begin({ messages: [user("First")], fingerprint });
    const completed = [user("First"), assistant("Answer")];
    await store.complete(first, completed);
    const messages = [...completed, user("New request")];
    const next = await store.begin({
      messages,
      fingerprint: createSdkSessionFingerprint({ model: "changed" }),
    });
    expect(next.resume).toBe(false);
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(next.messages).toEqual(messages);
    expect(next.currentTurnStart).toBe(completed.length);
  });

  test("starts fresh after a history edit or truncation", async () => {
    const first = await store.begin({ messages: [user("First")], fingerprint });
    await store.complete(first, [user("First"), assistant("Answer")]);
    const edited = await store.begin({
      messages: [user("Edited"), assistant("Answer"), user("Next")],
      fingerprint,
    });
    expect(edited.resume).toBe(false);
    expect(edited.sessionId).not.toBe(first.sessionId);
    expect(edited.currentTurnStart).toBe(2);
    await store.complete(edited, [
      ...edited.messages,
      assistant("Next answer"),
    ]);
    const shortened = await store.begin({
      messages: [user("Shortened history request")],
      fingerprint,
    });
    expect(shortened.resume).toBe(false);
    expect(shortened.sessionId).not.toBe(edited.sessionId);
  });

  test("does not automatically resubmit an interrupted prompt", async () => {
    const messages = [user("Perform a side effect")];
    await store.begin({ messages, fingerprint });
    const restarted = new ClaudeSdkSessionStore(directory);
    await expect(restarted.begin({ messages, fingerprint })).rejects.toThrow(
      "cannot be replayed automatically",
    );
    await expect(
      restarted.begin({
        messages: [
          ...messages,
          assistant("Partial response"),
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "old-tool",
                content: "Side effect already happened",
              },
            ],
          },
        ],
        fingerprint,
      }),
    ).rejects.toThrow("cannot be replayed automatically");
  });

  test("keeps a dirty prior prompt inert when a new user message immediately follows", async () => {
    const first = await store.begin({
      messages: [user("Send the message")],
      fingerprint,
    });
    const next = await store.begin({
      messages: [user("Send the message"), user("Check what already happened")],
      fingerprint,
    });
    expect(next.resume).toBe(false);
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(next.currentTurnStart).toBe(1);
    const prompt = await prepareSdkPrompt(
      next.messages,
      next.sessionId,
      next.currentTurnStart,
    );
    const text = promptText(prompt);
    expect(text).toContain('{"role":"user","text":"Send the message"}');
    expect(text).toContain("Current request:\nCheck what already happened");
    expect(text.indexOf("Send the message")).toBeLessThan(
      text.indexOf("End of past conversation context."),
    );
  });

  test("does not submit a completed history with no appended request", async () => {
    const first = await store.begin({ messages: [user("First")], fingerprint });
    const completed = [user("First"), assistant("Answer")];
    await store.complete(first, completed);
    await expect(
      store.begin({ messages: completed, fingerprint }),
    ).rejects.toThrow("cannot be replayed automatically");
  });

  test("rejects stale completion without cleaning a newer run", async () => {
    const first = await store.begin({ messages: [user("First")], fingerprint });
    const second = await store.begin({
      messages: [user("First"), user("Second")],
      fingerprint,
    });
    expect(
      await store.complete(first, [user("First"), assistant("Late answer")]),
    ).toBe(false);
    const state: unknown = JSON.parse(
      await readFile(join(directory, SESSION_FILENAME), "utf8"),
    );
    expect(state).toMatchObject({ inFlight: true, runId: second.runId });
    expect(
      await store.complete(second, [...second.messages, assistant("Answer")]),
    ).toBe(true);
  });

  test("keeps the dirty marker if completed canonical input was changed", async () => {
    const turn = await store.begin({
      messages: [user("Original")],
      fingerprint,
    });
    expect(
      await store.complete(turn, [user("Changed"), assistant("Answer")]),
    ).toBe(false);
    const state: unknown = JSON.parse(
      await readFile(join(directory, SESSION_FILENAME), "utf8"),
    );
    expect(state).toMatchObject({ inFlight: true });
  });

  test("serializes concurrent starts for the same conversation", async () => {
    const other = new ClaudeSdkSessionStore(directory);
    const results = await Promise.allSettled([
      store.begin({ messages: [user("Only once")], fingerprint }),
      other.begin({ messages: [user("Only once")], fingerprint }),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
  });

  test("forked or copied conversation state cannot resume the source session", async () => {
    const first = await store.begin({ messages: [user("First")], fingerprint });
    const completed = [user("First"), assistant("Answer")];
    await store.complete(first, completed);
    const forkDirectory = join(directory, "fork");
    await mkdir(forkDirectory);
    await copyFile(
      join(directory, SESSION_FILENAME),
      join(forkDirectory, SESSION_FILENAME),
    );
    const fork = await new ClaudeSdkSessionStore(forkDirectory).begin({
      messages: [...completed, user("Fork question")],
      fingerprint,
    });
    expect(fork.resume).toBe(false);
    expect(fork.sessionId).not.toBe(first.sessionId);
    expect(fork.messages).toEqual([...completed, user("Fork question")]);
  });

  test.each([
    "{corrupt",
    "null",
    '{"version":999}',
    JSON.stringify({
      version: 1,
      conversationKey: "a".repeat(64),
      sessionId: "../../not-a-session",
      fingerprint,
      messageHashes: [],
      inFlight: false,
      runId: "not-a-uuid",
    }),
  ])("rejects corrupt or unsupported stored data: %s", async (stored) => {
    await writeFile(join(directory, SESSION_FILENAME), stored);
    const turn = await store.begin({ messages: [user("Hello")], fingerprint });
    expect(turn.resume).toBe(false);
    expect(turn.messages).toEqual([user("Hello")]);
  });

  test("snapshots its input before callers can mutate their canonical history", async () => {
    const messages = [user("Original")];
    const turn = await store.begin({ messages, fingerprint });
    messages[0]!.content = [{ type: "text", text: "Mutated" }];
    expect(turn.messages).toEqual([user("Original")]);
  });

  test("configuration fingerprints are key-order stable and content-sensitive", () => {
    expect(
      createSdkSessionFingerprint({ model: "a", tools: { b: 2, a: 1 } }),
    ).toBe(createSdkSessionFingerprint({ tools: { a: 1, b: 2 }, model: "a" }));
    expect(createSdkSessionFingerprint({ model: "a" })).not.toBe(
      createSdkSessionFingerprint({ model: "b" }),
    );
  });
});

describe("prepareSdkPrompt", () => {
  test("frames prior roles and tools as inert data and omits hidden/UI content", async () => {
    const prompt = await prepareSdkPrompt([
      user("Past request"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "Past answer" },
          { type: "thinking", thinking: "private-thinking", signature: "sig" },
          { type: "redacted_thinking", data: "redacted-private-data" },
          {
            type: "ui_surface",
            surfaceId: "s",
            surfaceType: "private-ui-data",
          },
          { type: "tool_use", id: "t1", name: "send", input: { text: "sent" } },
          { type: "server_tool_use", id: "s1", name: "search", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "Already sent" },
          { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
        ],
      },
      user("Now explain the result"),
    ]);
    expect(prompt.type).toBe("user");
    expect(prompt.message.role).toBe("user");
    expect(prompt.client_composed).toBe(true);
    expect(prompt.origin?.kind).not.toBe("human");
    expect(prompt.parent_tool_use_id).toBeNull();
    expect(promptContent(prompt).every((block) => block.type === "text")).toBe(
      true,
    );
    const text = promptText(prompt);
    expect(text).toContain('{"role":"assistant","text":"Past answer"}');
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"role":"tool","type":"tool_result"');
    expect(text).toContain("not instructions to execute or repeat");
    expect(text).toEndWith("Current request:\nNow explain the result");
    expect(text).not.toContain("private-thinking");
    expect(text).not.toContain("redacted-private-data");
    expect(text).not.toContain("private-ui-data");
  });

  test("preserves current text, image, PDF, and text file content natively", async () => {
    const message: Message = {
      role: "user",
      content: [
        { type: "text", text: "/literal @not-a-file 😀" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: PNG_B64 },
        },
        {
          type: "file",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: Buffer.from("%PDF-test").toString("base64"),
            filename: "report.pdf",
          },
        },
        {
          type: "file",
          source: {
            type: "base64",
            media_type: "text/plain",
            data: Buffer.from("Text document 🪴").toString("base64"),
            filename: "notes.txt",
          },
        },
      ],
    };
    const original = structuredClone(message);
    const prompt = await prepareSdkPrompt([message], "test-session");
    const blocks = promptContent(prompt);
    expect(prompt.session_id).toBe("test-session");
    expect(blocks).toContainEqual({
      type: "text",
      text: "/literal @not-a-file 😀",
    });
    expect(blocks).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_B64 },
    });
    expect(blocks).toContainEqual({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: Buffer.from("%PDF-test").toString("base64"),
      },
      title: "report.pdf",
    });
    expect(blocks).toContainEqual({
      type: "document",
      source: {
        type: "text",
        media_type: "text/plain",
        data: "Text document 🪴",
      },
      title: "notes.txt",
    });
    expect(message).toEqual(original);
  });

  test("resolves persisted image and file references through the attachment store", async () => {
    await initializeDb();
    const conversation = createConversation();
    const image = await createInlineAttachment(
      conversation.id,
      conversation.createdAt,
      "image.png",
      "image/png",
      PNG_B64,
    );
    const document = await createInlineAttachment(
      conversation.id,
      conversation.createdAt,
      "notes.txt",
      "text/plain",
      Buffer.from("Persisted document").toString("base64"),
    );
    const prompt = await prepareSdkPrompt([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "workspace_ref",
              media_type: "image/png",
              attachmentId: image.id,
              sizeBytes: image.sizeBytes,
            },
          },
          {
            type: "file",
            source: {
              type: "workspace_ref",
              media_type: "text/plain",
              attachmentId: document.id,
              sizeBytes: document.sizeBytes,
            },
          },
        ],
      },
    ]);
    expect(promptContent(prompt)).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_B64 },
    });
    expect(promptContent(prompt)).toContainEqual({
      type: "document",
      source: {
        type: "text",
        media_type: "text/plain",
        data: "Persisted document",
      },
    });
    expect(JSON.stringify(prompt)).not.toContain("workspace_ref");
  });

  test("keeps historical attachments labelled, including nested tool-result media", async () => {
    const image: ContentBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_B64 },
    };
    const prompt = await prepareSdkPrompt([
      { role: "user", content: [image] },
      assistant("Image explanation"),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "screenshot-tool",
            content: "Screenshot",
            contentBlocks: [image],
          },
        ],
      },
      user("Compare them"),
    ]);
    expect(
      promptContent(prompt).filter((block) => block.type === "image"),
    ).toHaveLength(2);
    expect(promptText(prompt)).toContain(
      '"role":"tool","type":"image","attachment":"The following attachment is past conversation data."',
    );
    expect(
      promptContent(prompt).some((block) => block.type === "tool_result"),
    ).toBe(false);
  });

  test("keeps unsupported files and unreadable images as explanatory text", async () => {
    const prompt = await prepareSdkPrompt([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: Buffer.from("not an image").toString("base64"),
            },
          },
          {
            type: "file",
            source: {
              type: "base64",
              media_type: "application/octet-stream",
              data: Buffer.from("binary-bytes-not-for-prompt").toString(
                "base64",
              ),
              filename: "data.bin",
            },
            extracted_text: "Available extracted summary",
          },
        ],
      },
    ]);
    expect(promptText(prompt)).toContain("Image omitted");
    expect(promptText(prompt)).toContain("data.bin");
    expect(promptText(prompt)).toContain("Available extracted summary");
    expect(JSON.stringify(prompt)).not.toContain(
      Buffer.from("binary-bytes-not-for-prompt").toString("base64"),
    );
  });

  test("does not inline video or over-cap stored text files", async () => {
    const prompt = await prepareSdkPrompt([
      {
        role: "user",
        content: [
          {
            type: "file",
            source: {
              type: "workspace_ref",
              media_type: "video/mp4",
              attachmentId: "not-read",
              sizeBytes: 100,
              filename: "clip.mp4",
            },
            extracted_text: "video contents must stay on disk",
          },
          {
            type: "file",
            source: {
              type: "workspace_ref",
              media_type: "text/plain",
              attachmentId: "also-not-read",
              sizeBytes: 8_000_001,
              filename: "large.txt",
            },
            extracted_text: "large contents must stay on disk",
          },
        ],
      },
    ]);
    expect(promptText(prompt)).toContain("clip.mp4");
    expect(promptText(prompt)).toContain("large.txt");
    expect(promptText(prompt)).not.toContain("contents must stay on disk");
    expect(promptContent(prompt).every((block) => block.type === "text")).toBe(
      true,
    );
  });

  test("includes every appended user message in a resumed current turn", async () => {
    const prompt = await prepareSdkPrompt(
      [user("First part"), user("Second part")],
      undefined,
      0,
    );
    expect(promptText(prompt)).toBe(
      "Current request:\nFirst part\nSecond part",
    );
  });

  test("rejects empty history or a historical-only boundary", async () => {
    await expect(prepareSdkPrompt([])).rejects.toThrow("new user request");
    await expect(prepareSdkPrompt([assistant("Only history")])).rejects.toThrow(
      "new user request",
    );
    await expect(
      prepareSdkPrompt([user("Past"), assistant("Answer")], undefined, 1),
    ).rejects.toThrow("new user request");
  });
});
