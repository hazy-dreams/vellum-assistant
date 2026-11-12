import { describe, expect, it } from "bun:test";

import type { GatewayInboundEvent } from "../../channels/inbound-event.js";
import {
  canonicalHandle,
  fromPolledMessage,
  fromWebhookEnvelope,
  normalizeLinqInbound,
  transportOf,
  type IMessageNormalization,
  type LinqInbound,
} from "./normalize.js";

const LINE = "+12025551234";
const RAMON = "+12025559876";
const RECEIVED_AT = new Date("2026-11-12T05:00:00.000Z");

/** Linq's documented `message.received` example, version 2026-02-03. */
function receivedEnvelope(overrides?: {
  eventType?: string;
  isGroup?: boolean;
  service?: string | null;
  senderHandle?: string;
  senderIsMe?: boolean;
  direction?: string;
  parts?: unknown[];
}): unknown {
  return {
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: overrides?.eventType ?? "message.received",
    event_id: "2915e81c-5068-4796-ace2-21d2c94ad298",
    created_at: "2026-02-05T19:31:13.736444093Z",
    trace_id: "8af9171a45022df2eb74ba4e4c83be0f",
    partner_id: "your-partner-id",
    data: {
      chat: {
        id: "8f392755-6865-4b18-880a-227f9d8b458f",
        is_group: overrides?.isGroup ?? false,
        owner_handle: {
          handle: LINE,
          id: "6d6c617f-187a-4dcd-a0d5-988347a8c092",
          is_me: true,
          joined_at: "2026-01-04T05:48:51.321469Z",
          left_at: null,
          service: "iMessage",
          status: "active",
        },
        health_status: { status: "HEALTHY" },
      },
      id: "89e3566e-1d13-49e5-a8ee-48490d5bfeb7",
      direction: overrides?.direction ?? "inbound",
      sender_handle: {
        handle: overrides?.senderHandle ?? RAMON,
        id: "e604375a-5913-483a-8278-c631e8f0ffda",
        is_me: overrides?.senderIsMe ?? false,
        joined_at: "2026-01-04T05:48:51.321469Z",
        left_at: null,
        service: "iMessage",
        status: "active",
      },
      parts: overrides?.parts ?? [{ type: "text", value: "Hello!" }],
      effect: null,
      reply_to: null,
      sent_at: "2026-02-05T19:31:13.074Z",
      delivered_at: null,
      read_at: null,
      service:
        overrides?.service === undefined ? "iMessage" : overrides.service,
    },
  };
}

/** A `Message` as `GET /v3/chats/{chatId}/messages` returns it. */
function polledMessage(overrides?: Record<string, unknown>): unknown {
  return {
    id: "89e3566e-1d13-49e5-a8ee-48490d5bfeb7",
    chat_id: "8f392755-6865-4b18-880a-227f9d8b458f",
    service: "iMessage",
    preferred_service: null,
    from: RAMON,
    from_handle: {
      id: "e604375a-5913-483a-8278-c631e8f0ffda",
      handle: RAMON,
      service: "iMessage",
      joined_at: "2026-01-04T05:48:51.321469Z",
    },
    parts: [{ type: "text", value: "Hello!" }],
    is_from_me: false,
    is_delivered: false,
    is_read: false,
    delivery_status: "delivered",
    created_at: "2026-02-05T19:31:12.892Z",
    updated_at: "2026-02-05T19:31:13.712Z",
    sent_at: "2026-02-05T19:31:13.074Z",
    ...overrides,
  };
}

function inboundOf(raw: unknown): LinqInbound {
  const inbound = fromWebhookEnvelope(raw);
  if (inbound === undefined || inbound === "ignored") {
    throw new Error(`expected a message, got ${String(inbound)}`);
  }
  return inbound;
}

function eventOf(result: IMessageNormalization): GatewayInboundEvent {
  if (result.dropped) {
    throw new Error(`expected an event, got drop: ${result.reason}`);
  }
  return result.event;
}

describe("canonicalHandle", () => {
  it("keeps E.164 numbers and strips formatting", () => {
    expect(canonicalHandle("+12025559876")).toBe("+12025559876");
    expect(canonicalHandle(" +1 (202) 555-9876 ")).toBe("+12025559876");
  });

  it("lowercases Apple ID emails", () => {
    expect(canonicalHandle("Ramon@Example.com")).toBe("ramon@example.com");
  });

  it("refuses shapes it cannot vouch for rather than guessing", () => {
    expect(canonicalHandle("2025559876")).toBeUndefined();
    expect(canonicalHandle("+0123")).toBeUndefined();
    expect(canonicalHandle("not a handle")).toBeUndefined();
    expect(canonicalHandle("")).toBeUndefined();
  });
});

describe("transportOf", () => {
  it("reads only an explicit iMessage as iMessage", () => {
    expect(transportOf("iMessage")).toBe("imessage");
    expect(transportOf("RCS")).toBe("rcs");
    expect(transportOf("SMS")).toBe("sms");
    expect(transportOf(undefined)).toBe("sms");
  });
});

describe("fromWebhookEnvelope", () => {
  it("ignores well-formed events that are not received messages", () => {
    expect(
      fromWebhookEnvelope(receivedEnvelope({ eventType: "message.delivered" })),
    ).toBe("ignored");
  });

  it("rejects malformed payloads", () => {
    expect(fromWebhookEnvelope({})).toBeUndefined();
    expect(
      fromWebhookEnvelope({
        event_type: "message.received",
        event_id: "e1",
        data: { id: "m1" },
      }),
    ).toBeUndefined();
  });
});

describe("normalizeLinqInbound", () => {
  it("normalizes Linq's documented message.received example", () => {
    const event = eventOf(
      normalizeLinqInbound(inboundOf(receivedEnvelope()), RECEIVED_AT),
    );
    expect(event.sourceChannel).toBe("imessage");
    expect(event.receivedAt).toBe(RECEIVED_AT.toISOString());
    expect(event.message).toEqual({
      eventKind: "message",
      content: "Hello!",
      conversationExternalId: "8f392755-6865-4b18-880a-227f9d8b458f",
      externalMessageId: "89e3566e-1d13-49e5-a8ee-48490d5bfeb7",
    });
    expect(event.actor).toEqual({ actorExternalId: RAMON });
    expect(event.source.chatType).toBe("imessage");
    expect(event.source.conversationType).toBe("dm");
  });

  it("produces the same event whether a message was polled or pushed", () => {
    const pushed = eventOf(
      normalizeLinqInbound(inboundOf(receivedEnvelope()), RECEIVED_AT),
    );
    const polledInbound = fromPolledMessage(polledMessage());
    expect(polledInbound).toBeDefined();
    const polled = eventOf(normalizeLinqInbound(polledInbound!, RECEIVED_AT));
    expect(polled.message).toEqual(pushed.message);
    expect(polled.actor).toEqual(pushed.actor);
    expect(polled.source.chatType).toBe(pushed.source.chatType);
  });

  it("marks SMS and service-less messages as the spoofable transport", () => {
    const sms = eventOf(
      normalizeLinqInbound(inboundOf(receivedEnvelope({ service: "SMS" }))),
    );
    expect(sms.source.chatType).toBe("sms");

    const polled = fromPolledMessage(
      polledMessage({
        service: null,
        from_handle: { id: "h", handle: RAMON, service: "SMS", joined_at: "x" },
      }),
    );
    expect(eventOf(normalizeLinqInbound(polled!)).source.chatType).toBe("sms");
  });

  it("drops our own outbound echoes", () => {
    expect(
      normalizeLinqInbound(
        inboundOf(
          receivedEnvelope({ direction: "outbound", senderIsMe: true }),
        ),
      ),
    ).toEqual({ dropped: true, reason: "from_me" });
    expect(
      normalizeLinqInbound(
        fromPolledMessage(polledMessage({ is_from_me: true }))!,
      ),
    ).toEqual({ dropped: true, reason: "from_me" });
  });

  it("drops group chats", () => {
    expect(
      normalizeLinqInbound(inboundOf(receivedEnvelope({ isGroup: true }))),
    ).toEqual({ dropped: true, reason: "group_chat" });
  });

  it("drops senders whose handle cannot be a trust identity", () => {
    expect(
      normalizeLinqInbound(
        inboundOf(receivedEnvelope({ senderHandle: "short-code-1234" })),
      ),
    ).toEqual({ dropped: true, reason: "unsupported_handle" });
  });

  it("joins text parts and carries media as attachments", () => {
    const event = eventOf(
      normalizeLinqInbound(
        inboundOf(
          receivedEnvelope({
            parts: [
              { type: "text", value: "look at luna" },
              {
                type: "media",
                id: "f13dda7d",
                url: "https://cdn.linqapp.com/attachments/f13dda7d/photo.jpg",
                filename: "photo.jpg",
                mime_type: "image/jpeg",
                size_bytes: 245678,
              },
              { type: "text", value: "she is so round" },
              { type: "link", value: "https://example.com" },
            ],
          }),
        ),
      ),
    );
    expect(event.message.content).toBe("look at luna\n\nshe is so round");
    expect(event.message.attachments).toEqual([
      {
        type: "image",
        fileId: "https://cdn.linqapp.com/attachments/f13dda7d/photo.jpg",
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        fileSize: 245678,
      },
    ]);
  });

  it("drops messages with nothing to say", () => {
    expect(
      normalizeLinqInbound(
        inboundOf(receivedEnvelope({ parts: [{ type: "text", value: "  " }] })),
      ),
    ).toEqual({ dropped: true, reason: "empty" });
  });
});

describe("captured live delivery", () => {
  /**
   * A real `message.received` captured from the relay on 2026-11-12, with the
   * phone numbers, ids and device hash replaced. It differs from the documented
   * example in ways that matter to a tolerant parser: every part carries five
   * extra null fields, and the top level adds device and retention fields the
   * reference does not list.
   */
  const captured = {
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: "message.received",
    event_id: "74ae21ac-0000-4000-8000-000000000001",
    created_at: "2026-11-12T05:58:08.478796709Z",
    trace_id: "a9ae8992a17a95c27b318b4ee8ec73aa",
    partner_id: "00000000-0000-4000-8000-000000000002",
    data: {
      chat: {
        health_status: {
          doc_url:
            "https://docs.linqapp.com/channel/imessage/guides/chats/chat-health#healthy",
          status: "HEALTHY",
          updated_at: "2026-11-12T05:58:08.470575Z",
        },
        id: "d76cfe6b-0000-4000-8000-000000000003",
        is_group: false,
        owner_handle: {
          handle: LINE,
          id: "c029be0a-0000-4000-8000-000000000004",
          is_me: true,
          joined_at: "2026-11-12T05:58:08.39163Z",
          left_at: null,
          line_type: "iMessage",
          service: "iMessage",
          status: "active",
        },
      },
      delivered_at: null,
      device_first_seen_at: "2026-11-12T05:58:08.440588Z",
      device_id: "0".repeat(64),
      device_status: "first_contact",
      direction: "inbound",
      effect: null,
      id: "97ffdc12-0000-4000-8000-000000000005",
      idempotency_key: null,
      parts: [
        {
          inline_stickers: null,
          mention: null,
          mention_range: null,
          mentions: null,
          text_decorations: null,
          type: "text",
          value: "Hi",
        },
      ],
      preferred_service: null,
      read_at: null,
      reply_to: null,
      sender_handle: {
        handle: RAMON,
        id: "098c55d0-0000-4000-8000-000000000006",
        is_me: false,
        joined_at: "2026-11-12T05:58:08.39163Z",
        left_at: null,
        service: "iMessage",
        status: "active",
      },
      sent_at: "2026-11-12T05:58:04.513Z",
      service: "iMessage",
      zero_retention: false,
    },
  };

  it("normalizes to an iMessage DM from the sender handle", () => {
    const inbound = fromWebhookEnvelope(captured);
    if (!inbound || inbound === "ignored") throw new Error("not read");
    const result = normalizeLinqInbound(inbound, RECEIVED_AT);
    if (result.dropped) throw new Error(`dropped: ${result.reason}`);
    expect(result.event.actor.actorExternalId).toBe(RAMON);
    expect(result.event.message.content).toBe("Hi");
    expect(result.event.message.conversationExternalId).toBe(
      "d76cfe6b-0000-4000-8000-000000000003",
    );
    expect(result.event.message.externalMessageId).toBe(
      "97ffdc12-0000-4000-8000-000000000005",
    );
    expect(result.event.source.chatType).toBe("imessage");
  });
});
