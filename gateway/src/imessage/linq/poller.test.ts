import { describe, expect, it } from "bun:test";
import pino from "pino";

import type { LinqChatSummary, LinqClient, LinqPage } from "./client.js";
import type { LinqInbound } from "./normalize.js";
import {
  LinqPoller,
  type InboundOutcome,
  type PollWatermarkStore,
} from "./poller.js";

const LINE = "+12025551234";
const RAMON = "+12025559876";
const NOW = Date.parse("2026-11-12T06:00:00.000Z");
const log = pino({ level: "silent" });

const at = (minutesAgo: number) =>
  new Date(NOW - minutesAgo * 60_000).toISOString();

function message(id: string, minutesAgo: number, fromMe = false) {
  return {
    id,
    chat_id: "chat-1",
    is_from_me: fromMe,
    service: "iMessage",
    from: fromMe ? LINE : RAMON,
    parts: [{ type: "text", value: id }],
    created_at: at(minutesAgo),
    sent_at: at(minutesAgo),
  };
}

function fakeClient(
  chats: LinqChatSummary[],
  messages: Record<string, unknown[]>,
) {
  const client = {
    listChats: async (): Promise<LinqPage<LinqChatSummary>> => ({
      items: chats,
      nextCursor: undefined,
    }),
    listMessages: async (chatId: string): Promise<LinqPage<unknown>> => ({
      items: messages[chatId] ?? [],
      nextCursor: undefined,
    }),
  };
  return client as unknown as LinqClient;
}

function memoryStore(
  watermark?: string,
): PollWatermarkStore & { value?: string } {
  const store = {
    value: watermark,
    loadWatermark: () => store.value,
    saveWatermark: (iso: string) => {
      store.value = iso;
    },
  };
  return store;
}

function poller(
  client: LinqClient,
  store: PollWatermarkStore,
  decide: (inbound: LinqInbound) => InboundOutcome = () => "handled",
) {
  const seen: string[] = [];
  const instance = new LinqPoller({
    client,
    line: LINE,
    store,
    log,
    now: () => NOW,
    onInbound: async (inbound) => {
      seen.push(inbound.messageId);
      return decide(inbound);
    },
  });
  return { instance, seen };
}

describe("LinqPoller", () => {
  it("starts from now on a fresh line instead of replaying history", async () => {
    const store = memoryStore();
    const client = fakeClient([{ id: "chat-1", updated_at: at(1) }], {
      "chat-1": [message("old", 1)],
    });
    const { instance, seen } = poller(client, store);
    await instance.poll();

    expect(seen).toEqual([]);
    expect(store.value).toBe(new Date(NOW).toISOString());
  });

  it("hands over inbound messages since the watermark, oldest first", async () => {
    const store = memoryStore(at(30));
    const client = fakeClient([{ id: "chat-1", updated_at: at(1) }], {
      // Newest first, the way Linq pages them.
      "chat-1": [
        message("third", 1),
        message("mine", 2, true),
        message("second", 5),
        message("first", 20),
        message("before", 60),
      ],
    });
    const { instance, seen } = poller(client, store);
    await instance.poll();

    expect(seen).toEqual(["first", "second", "third"]);
    expect(store.value).toBe(at(1));
  });

  it("skips group chats and chats idle since the watermark", async () => {
    const store = memoryStore(at(30));
    const client = fakeClient(
      [
        { id: "group", is_group: true, updated_at: at(1) },
        { id: "chat-1", updated_at: at(2) },
        { id: "idle", updated_at: at(90) },
      ],
      {
        group: [message("group-msg", 1)],
        "chat-1": [message("dm", 2)],
        idle: [message("idle-msg", 90)],
      },
    );
    const { instance, seen } = poller(client, store);
    await instance.poll();
    expect(seen).toEqual(["dm"]);
  });

  it("holds the watermark at a message that could not be handed over", async () => {
    const store = memoryStore(at(30));
    const client = fakeClient([{ id: "chat-1", updated_at: at(1) }], {
      "chat-1": [message("c", 1), message("b", 5), message("a", 20)],
    });
    const { instance, seen } = poller(client, store, (inbound) =>
      inbound.messageId === "b" ? "retry" : "handled",
    );
    await instance.poll();

    // Stops at the failure so order is kept, and does not move past it.
    expect(seen).toEqual(["a", "b"]);
    expect(store.value).toBe(at(20));
  });

  it("folds overlapping calls into one follow-up pass", async () => {
    const store = memoryStore(at(30));
    let listings = 0;
    const client = {
      listChats: async () => {
        listings++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { items: [], nextCursor: undefined };
      },
      listMessages: async () => ({ items: [], nextCursor: undefined }),
    } as unknown as LinqClient;
    const { instance } = poller(client, store);

    await Promise.all([instance.poll(), instance.poll(), instance.poll()]);
    expect(listings).toBe(2);
  });
});
