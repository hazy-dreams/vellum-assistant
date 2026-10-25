import { createHash, randomUUID } from "node:crypto";
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
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { assertNotLiveDb } from "../../__tests__/assert-not-live-db.js";
import { createInlineAttachment } from "../../persistence/attachments-store.js";
import { createConversation } from "../../persistence/conversation-crud.js";
import { initializeDb } from "../../persistence/db-init.js";
import type { ContentBlock, Message } from "../../providers/types.js";
import { ConfigError } from "../../util/errors.js";
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
      version: 2,
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

  test.each(["decoration", "standalone", "empty"])(
    "resumes across %s UI-only history changes without resending old content",
    async (kind) => {
      const first = await store.begin({
        messages: [user("First")],
        fingerprint,
      });
      const completed = [user("First"), assistant("Answer")];
      expect(await store.complete(first, completed)).toBe(true);
      const changed = structuredClone(completed);
      const ui: ContentBlock = {
        type: "ui_surface",
        surfaceId: "card",
        surfaceType: "progress",
        data: { state: "complete" },
      };
      if (kind === "decoration") {
        changed[1]!.content.unshift(ui);
      } else {
        changed.splice(1, 0, {
          role: "assistant",
          content: kind === "empty" ? [] : [ui],
        });
      }
      const next = await store.begin({
        messages: [...changed, user("Next")],
        fingerprint,
      });
      expect(next.resume).toBe(true);
      expect(next.sessionId).toBe(first.sessionId);
      expect(next.messages).toEqual([user("Next")]);
    },
  );

  test("completion tolerates same-role regrouping and UI-only decoration", async () => {
    const first = await store.begin({
      messages: [user("First"), user("More")],
      fingerprint,
    });
    expect(
      await store.complete(first, [
        {
          role: "user",
          content: [...user("First").content, ...user("More").content],
        },
        assistant("Answer one"),
        assistant("Answer two"),
      ]),
    ).toBe(true);
    const next = await store.begin({
      messages: [
        user("First"),
        user("More"),
        {
          role: "assistant",
          content: [
            ...assistant("Answer one").content,
            ...assistant("Answer two").content,
            { type: "ui_surface", surfaceId: "card", surfaceType: "card" },
          ],
        },
        user("Next"),
      ],
      fingerprint,
    });
    expect(next.resume).toBe(true);
    expect(next.messages).toEqual([user("Next")]);
  });

  test.each(["clean", "dirty", "fingerprint"])(
    "splits a same-role message crossing the old/new frontier (%s)",
    async (mode) => {
      const first = await store.begin({
        messages: [user("Old request")],
        fingerprint,
      });
      if (mode !== "dirty") {
        expect(await store.complete(first, [user("Old request")])).toBe(true);
      }
      const messages: Message[] = [
        {
          role: "user",
          content: [
            ...user("Old request").content,
            { type: "ui_surface", surfaceId: "card", surfaceType: "card" },
            ...user("New request").content,
          ],
        },
      ];
      const next = await store.begin({
        messages,
        fingerprint:
          mode === "fingerprint"
            ? createSdkSessionFingerprint({ model: "changed" })
            : fingerprint,
      });
      expect(next.resume).toBe(mode === "clean");
      const text = promptText(
        await prepareSdkPrompt(
          next.messages,
          next.sessionId,
          next.currentTurnStart,
        ),
      );
      expect(text.slice(text.indexOf("Current request:"))).toBe(
        "Current request:\nNew request",
      );
      if (mode === "clean") {
        expect(next.messages).toEqual([user("New request")]);
      } else {
        expect(text).toContain('{"role":"user","text":"Old request"}');
        expect(next.sessionId).not.toBe(first.sessionId);
      }
    },
  );

  test("excludes an old tool-only tail merged with the new request", async () => {
    const call: ContentBlock = {
      type: "tool_use",
      id: "sent",
      name: "send",
      input: { text: "once" },
    };
    const result: ContentBlock = {
      type: "tool_result",
      tool_use_id: "sent",
      content: "Already sent",
    };
    const completed: Message[] = [
      user("Send"),
      { role: "assistant", content: [call] },
      { role: "user", content: [result] },
    ];
    const first = await store.begin({ messages: [user("Send")], fingerprint });
    expect(await store.complete(first, completed)).toBe(true);
    const next = await store.begin({
      messages: [
        ...completed.slice(0, 2),
        { role: "user", content: [result, ...user("Explain").content] },
      ],
      fingerprint,
    });
    expect(next.resume).toBe(true);
    expect(next.messages).toEqual([user("Explain")]);
    expect(
      JSON.stringify(await prepareSdkPrompt(next.messages, next.sessionId, 0)),
    ).not.toContain("Already sent");
  });

  test.each(["clean", "dirty"])(
    "does not fabricate a request from UI-only regrouping (%s)",
    async (mode) => {
      const first = await store.begin({
        messages: [user("Historical request")],
        fingerprint,
      });
      if (mode === "clean") {
        await store.complete(first, [
          user("Historical request"),
          assistant("Answer"),
        ]);
      }
      const messages: Message[] = [
        user("Historical request"),
        ...(mode === "clean" ? [assistant("Answer")] : []),
        {
          role: "user",
          content: [
            { type: "ui_surface", surfaceId: "card", surfaceType: "card" },
          ],
        },
      ];
      await expect(store.begin({ messages, fingerprint })).rejects.toThrow(
        "cannot be replayed automatically",
      );
    },
  );

  test.each(["thinking", "redacted_thinking"] as const)(
    "keeps opaque %s as a native-history edit guard",
    async (kind) => {
      const hidden: ContentBlock =
        kind === "thinking"
          ? { type: "thinking", thinking: "opaque", signature: "signature" }
          : { type: "redacted_thinking", data: "opaque" };
      const completed: Message[] = [
        user("First"),
        {
          role: "assistant",
          content: [hidden, ...assistant("Answer").content],
        },
      ];
      const first = await store.begin({
        messages: [user("First")],
        fingerprint,
      });
      expect(await store.complete(first, completed)).toBe(true);
      const changed = structuredClone(completed);
      changed[1]!.content.shift();
      const next = await store.begin({
        messages: [...changed, user("Next")],
        fingerprint,
      });
      expect(next.resume).toBe(false);
    },
  );

  // Authentic ca17637c v1 hashes: stable JSON of each WHOLE raw message,
  // not v2 role-labelled blocks. Keep this independent of the new projection.
  function legacyHash(value: unknown): string {
    const serialized = JSON.stringify(value, (_key, entry: unknown) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        return Object.fromEntries(
          Object.entries(entry).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        );
      }
      return entry;
    });
    return createHash("sha256").update(serialized!).digest("hex");
  }

  async function writeLegacy(messages: Message[], inFlight: boolean) {
    const legacy = {
      version: 1,
      conversationKey: legacyHash(resolve(directory)),
      sessionId: randomUUID(),
      fingerprint,
      messageHashes: messages.map(legacyHash),
      inFlight,
      runId: randomUUID(),
    };
    await writeFile(join(directory, SESSION_FILENAME), JSON.stringify(legacy));
    return legacy;
  }

  test.each([false, true])(
    "genuine v1 unchanged history cannot replay (inFlight=%s)",
    async (inFlight) => {
      const messages = [user("Old request"), assistant("Old answer")];
      const legacy = await writeLegacy(messages, inFlight);
      await expect(store.begin({ messages, fingerprint })).rejects.toThrow(
        "completed or interrupted prompt cannot be replayed",
      );
      expect(
        JSON.parse(await readFile(join(directory, SESSION_FILENAME), "utf8")),
      ).toEqual(legacy);
    },
  );

  test.each([false, true])(
    "genuine v1 appended request rebuilds once with old effects inert (inFlight=%s)",
    async (inFlight) => {
      const historical: Message[] = [
        user("Old request"),
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "old-effect",
              name: "write_file",
              input: { path: "old.txt" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "old-effect",
              content: "written",
            },
          ],
        },
        assistant("Old answer"),
      ];
      const legacy = await writeLegacy(historical, inFlight);
      const messages = [...historical, user("New request")];
      const next = await store.begin({ messages, fingerprint });
      expect(next.resume).toBe(false);
      expect(next.sessionId).not.toBe(legacy.sessionId);
      expect(next.currentTurnStart).toBe(historical.length);
      const text = promptText(
        await prepareSdkPrompt(next.messages, undefined, next.currentTurnStart),
      );
      const [past, live] = text.split("Current request:");
      expect(past).toContain('"text":"Old request"');
      expect(past).toContain('"name":"write_file"');
      expect(live).toBe("\nNew request");
      const state = JSON.parse(
        await readFile(join(directory, SESSION_FILENAME), "utf8"),
      );
      expect(state).toMatchObject({
        version: 2,
        inFlight: true,
        sessionId: next.sessionId,
      });
      expect(state).not.toHaveProperty("messageHashes");
      expect(state.blockHashes).toHaveLength(5);
      // A stale pre-upgrade completion cannot clean the migrated run.
      expect(
        await store.complete(
          { ...next, sessionId: legacy.sessionId, runId: legacy.runId },
          messages,
        ),
      ).toBe(false);
      expect(
        await store.complete(next, [...messages, assistant("New answer")]),
      ).toBe(true);
      const resumed = await store.begin({
        messages: [...messages, assistant("New answer"), user("Third")],
        fingerprint,
      });
      expect(resumed.resume).toBe(true);
      expect(resumed.sessionId).toBe(next.sessionId);
      expect(resumed.messages).toEqual([user("Third")]);
    },
  );

  test("genuine dirty v1 user-only frontier rejects replay and keeps old user text inert on rebuild", async () => {
    const historical = [user("Interrupted request")];
    const legacy = await writeLegacy(historical, true);
    await expect(
      store.begin({ messages: historical, fingerprint }),
    ).rejects.toThrow("cannot be replayed");
    const next = await store.begin({
      messages: [...historical, user("Genuinely new request")],
      fingerprint: createSdkSessionFingerprint({ model: "changed" }),
    });
    expect(next.resume).toBe(false);
    expect(next.sessionId).not.toBe(legacy.sessionId);
    expect(next.currentTurnStart).toBe(1);
    const [past, live] = promptText(
      await prepareSdkPrompt(next.messages, undefined, next.currentTurnStart),
    ).split("Current request:");
    expect(past).toContain('"text":"Interrupted request"');
    expect(live).toBe("\nGenuinely new request");
  });

  test("genuine v1 UI/tool-only append is not a new request", async () => {
    const historical = [user("Old request"), assistant("Answer")];
    const legacy = await writeLegacy(historical, false);
    await expect(
      store.begin({
        messages: [
          ...historical,
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "old-effect",
                content: "done",
              },
              { type: "ui_surface", surfaceId: "card", surfaceType: "card" },
            ],
          },
        ],
        fingerprint,
      }),
    ).rejects.toThrow("cannot be replayed");
    expect(
      JSON.parse(await readFile(join(directory, SESSION_FILENAME), "utf8")),
    ).toEqual(legacy);
  });

  test("concurrent genuine v1 migration cannot admit the same appended request twice", async () => {
    const historical = [user("Old request"), assistant("Answer")];
    await writeLegacy(historical, false);
    const options = {
      messages: [...historical, user("New request")],
      fingerprint,
    };
    const [first, second] = await Promise.allSettled([
      store.begin(options),
      new ClaudeSdkSessionStore(directory).begin(options),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(second.reason).toBeInstanceOf(ConfigError);
    }
  });

  test.each([
    "changed",
    "regrouped",
    "ui",
    "opaque",
    "media",
    "role",
    "copied",
    "empty",
    "v2 hashes",
  ])(
    "genuine v1 unproved prefix fails closed without replacing state (%s)",
    async (kind) => {
      const historical: Message[] = [
        user("Old request"),
        user("More"),
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "opaque", signature: "signature" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: PNG_B64,
              },
            },
            ...assistant("Answer").content,
          ],
        },
      ];
      const legacy = await writeLegacy(historical, false);
      let changed = structuredClone(historical);
      if (kind === "changed") {
        changed[0] = user("Changed");
      }
      if (kind === "regrouped") {
        changed = [
          {
            role: "user",
            content: [...historical[0]!.content, ...historical[1]!.content],
          },
          historical[2]!,
        ];
      }
      if (kind === "ui") {
        changed[2]!.content.push({
          type: "ui_surface",
          surfaceId: "card",
          surfaceType: "card",
        });
      }
      if (kind === "opaque") {
        changed[2]!.content.shift();
      }
      if (kind === "media") {
        changed[2]!.content.splice(1, 1);
      }
      if (kind === "role") {
        changed[0]!.role = "assistant";
      }
      if (kind === "copied") {
        legacy.conversationKey = "a".repeat(64);
      }
      if (kind === "empty") {
        legacy.messageHashes = [];
      }
      if (kind === "v2 hashes") {
        legacy.messageHashes = historical.flatMap((message) =>
          message.content.map((block) =>
            legacyHash({ role: message.role, block }),
          ),
        );
      }
      await writeFile(
        join(directory, SESSION_FILENAME),
        JSON.stringify(legacy),
      );
      const attempt = store.begin({
        messages: [...changed, user("New request")],
        fingerprint,
      });
      await expect(attempt).rejects.toBeInstanceOf(ConfigError);
      await expect(attempt).rejects.toThrow(
        "Cannot safely migrate legacy Claude session history",
      );
      expect(
        JSON.parse(await readFile(join(directory, SESSION_FILENAME), "utf8")),
      ).toEqual(legacy);
    },
  );

  test("complete never rewrites a genuine legacy state as v2", async () => {
    const messages = [user("Old request")];
    const legacy = await writeLegacy(messages, true);
    expect(
      await store.complete(
        {
          sessionId: legacy.sessionId,
          runId: legacy.runId,
          resume: false,
          messages,
          currentTurnStart: 0,
        },
        [...messages, assistant("Answer")],
      ),
    ).toBe(false);
    expect(
      JSON.parse(await readFile(join(directory, SESSION_FILENAME), "utf8")),
    ).toEqual(legacy);
  });

  test.each([
    ["text", user("Changed")],
    ["role", assistant("Original")],
    [
      "empty text",
      {
        role: "user",
        content: [
          { type: "text", text: "Original" },
          { type: "text", text: " " },
        ],
      },
    ],
    [
      "tool args",
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool",
            name: "send",
            input: { text: "changed" },
          },
        ],
      },
    ],
    [
      "tool result",
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool", content: "changed" },
        ],
      },
    ],
    [
      "tool order",
      {
        role: "assistant",
        content: [
          { type: "text", text: "Answer" },
          {
            type: "tool_use",
            id: "tool",
            name: "send",
            input: { text: "original" },
          },
        ],
      },
    ],
    [
      "media bytes",
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "changed",
            },
          },
        ],
      },
    ],
    [
      "media reference",
      {
        role: "user",
        content: [
          {
            type: "file",
            source: {
              type: "workspace_ref",
              media_type: "text/plain",
              attachmentId: "other",
              sizeBytes: 3,
            },
          },
        ],
      },
    ],
    [
      "nested result media",
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool",
            content: "original",
            contentBlocks: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "changed",
                },
              },
            ],
          },
        ],
      },
    ],
    [
      "thinking signature",
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "opaque", signature: "changed" },
        ],
      },
    ],
  ] satisfies [string, Message][])(
    "rebuilds after meaningful %s edits",
    async (kind, edited) => {
      const original: Record<string, Message> = {
        text: user("Original"),
        role: user("Original"),
        "empty text": {
          role: "user",
          content: [...user("Original").content, { type: "text", text: "" }],
        },
        "tool args": {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool",
              name: "send",
              input: { text: "original" },
            },
          ],
        },
        "tool result": {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool", content: "original" },
          ],
        },
        "tool order": {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool",
              name: "send",
              input: { text: "original" },
            },
            { type: "text", text: "Answer" },
          ],
        },
        "media bytes": {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "original",
              },
            },
          ],
        },
        "media reference": {
          role: "user",
          content: [
            {
              type: "file",
              source: {
                type: "workspace_ref",
                media_type: "text/plain",
                attachmentId: "original",
                sizeBytes: 3,
              },
            },
          ],
        },
        "nested result media": {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool",
              content: "original",
              contentBlocks: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "original",
                  },
                },
              ],
            },
          ],
        },
        "thinking signature": {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "opaque", signature: "original" },
          ],
        },
      };
      const first = await store.begin({
        messages: [user("First")],
        fingerprint,
      });
      expect(
        await store.complete(first, [user("First"), original[kind]!]),
      ).toBe(true);
      const next = await store.begin({
        messages: [user("First"), edited, user("Next")],
        fingerprint,
      });
      expect(next.resume).toBe(false);
      expect(next.sessionId).not.toBe(first.sessionId);
      expect(next.currentTurnStart).toBe(2);
    },
  );

  test("nested UI decoration does not change a tool result identity", async () => {
    const result: ContentBlock = {
      type: "tool_result",
      tool_use_id: "tool",
      content: "Done",
      contentBlocks: [{ type: "text", text: "Detail" }],
    };
    const completed: Message[] = [
      user("First"),
      { role: "user", content: [result] },
    ];
    const first = await store.begin({ messages: [user("First")], fingerprint });
    expect(await store.complete(first, completed)).toBe(true);
    if (result.type === "tool_result") {
      result.contentBlocks!.push({
        type: "ui_surface",
        surfaceId: "card",
        surfaceType: "card",
      });
    }
    const next = await store.begin({
      messages: [...completed, user("Next")],
      fingerprint,
    });
    expect(next.resume).toBe(true);
    expect(next.messages).toEqual([user("Next")]);
  });

  test("UI-only nested tool result content is equivalent to absent rich content", async () => {
    const result: ContentBlock = {
      type: "tool_result",
      tool_use_id: "tool",
      content: "Done",
    };
    const first = await store.begin({ messages: [user("First")], fingerprint });
    expect(
      await store.complete(first, [
        user("First"),
        { role: "user", content: [result] },
      ]),
    ).toBe(true);
    const next = await store.begin({
      messages: [
        user("First"),
        {
          role: "user",
          content: [
            {
              ...result,
              contentBlocks: [
                { type: "ui_surface", surfaceId: "card", surfaceType: "card" },
              ],
            },
          ],
        },
        user("Next"),
      ],
      fingerprint,
    });
    expect(next.resume).toBe(true);
    expect(next.messages).toEqual([user("Next")]);
  });

  test("preserves exact adjacent text blocks and does not infer a split inside text", async () => {
    const first = await store.begin({ messages: [user("Old")], fingerprint });
    await store.complete(first, [user("Old")]);
    const next = await store.begin({ messages: [user("OldNew")], fingerprint });
    expect(next.resume).toBe(false);
    expect(next.messages).toEqual([user("OldNew")]);
  });

  test("serialized begin and completion cannot let stale normalized history clean a new run", async () => {
    const first = await store.begin({ messages: [user("Old")], fingerprint });
    const other = new ClaudeSdkSessionStore(directory);
    const second = await other.begin({
      messages: [
        {
          role: "user",
          content: [...user("Old").content, ...user("New").content],
        },
      ],
      fingerprint,
    });
    expect(await store.complete(first, [user("Old"), assistant("Late")])).toBe(
      false,
    );
    const state = JSON.parse(
      await readFile(join(directory, SESSION_FILENAME), "utf8"),
    );
    expect(state).toMatchObject({ runId: second.runId, inFlight: true });
    expect(
      await other.complete(second, [
        user("Old"),
        user("New"),
        assistant("Answer"),
      ]),
    ).toBe(true);
  });

  test("unchanged opaque reasoning survives regrouping without entering the next prompt", async () => {
    const thinking: ContentBlock = {
      type: "thinking",
      thinking: "opaque reasoning",
      signature: "signature",
    };
    const first = await store.begin({ messages: [user("First")], fingerprint });
    const completed: Message[] = [
      user("First"),
      { role: "assistant", content: [thinking] },
      assistant("Answer"),
    ];
    expect(await store.complete(first, completed)).toBe(true);
    const next = await store.begin({
      messages: [
        user("First"),
        {
          role: "assistant",
          content: [thinking, ...assistant("Answer").content],
        },
        user("Next"),
      ],
      fingerprint,
    });
    expect(next.resume).toBe(true);
    expect(next.messages).toEqual([user("Next")]);
    expect(
      JSON.stringify(await prepareSdkPrompt(next.messages, next.sessionId, 0)),
    ).not.toContain("opaque reasoning");
  });

  test("blank appended text and UI cannot turn a historical request into a live request", async () => {
    const first = await store.begin({
      messages: [user("Do it once")],
      fingerprint,
    });
    await store.complete(first, [user("Do it once")]);
    await expect(
      store.begin({
        messages: [
          {
            role: "user",
            content: [
              ...user("Do it once").content,
              { type: "text", text: "" },
              { type: "text", text: "   " },
              { type: "ui_surface", surfaceId: "card", surfaceType: "card" },
            ],
          },
        ],
        fingerprint,
      }),
    ).rejects.toThrow("cannot be replayed automatically");
  });

  test("reordered complete history blocks force fresh reconstruction", async () => {
    const first = await store.begin({ messages: [user("First")], fingerprint });
    await store.complete(first, [
      user("First"),
      assistant("One"),
      assistant("Two"),
    ]);
    const next = await store.begin({
      messages: [
        user("First"),
        assistant("Two"),
        assistant("One"),
        user("Next"),
      ],
      fingerprint,
    });
    expect(next.resume).toBe(false);
    expect(next.currentTurnStart).toBe(3);
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
