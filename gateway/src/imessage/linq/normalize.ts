/**
 * Linq message → gateway inbound event.
 *
 * The same message reaches us two ways: the poller reads it from
 * `GET /v3/chats/{chatId}/messages`, and a webhook delivers it inside a
 * `message.received` envelope. The two shapes differ only in where they put
 * the chat id and the sender, so each is first read into one {@link LinqInbound}
 * and then normalized once. Which door a message came through can never change
 * what it becomes, so polling and webhooks dedupe against each other on the same
 * `externalMessageId`.
 */

import type {
  GatewayInboundAttachment,
  GatewayInboundEvent,
} from "../../channels/inbound-event.js";
import {
  LinqMessageSchema,
  LinqReceivedDataSchema,
  LinqWebhookEnvelopeSchema,
  type LinqPart,
  type LinqService,
} from "./schemas.js";

/** One inbound message, independent of how it reached us. */
export interface LinqInbound {
  /** Linq's message id: one occurrence of one message. */
  readonly messageId: string;
  readonly chatId: string;
  readonly isGroup: boolean;
  readonly isFromMe: boolean;
  /** Sender handle as Linq spelled it. */
  readonly handle: string;
  /** The service the message travelled on, when Linq said. */
  readonly service: LinqService | undefined;
  readonly parts: readonly LinqPart[];
  readonly sentAt: string | undefined;
  /** The provider payload as received, kept for audit on the event. */
  readonly raw: Record<string, unknown>;
}

/**
 * The transport an inbound arrived on, in our vocabulary. It travels as
 * `source.chatType`, which is what admission reads. Only an explicit iMessage
 * is `imessage`; anything else, including an absent service, is treated as
 * the spoofable case.
 */
export type IMessageTransport = "imessage" | "rcs" | "sms";

export function transportOf(
  service: LinqService | undefined,
): IMessageTransport {
  if (service === "iMessage") return "imessage";
  if (service === "RCS") return "rcs";
  return "sms";
}

export type IMessageDropReason =
  | "malformed"
  | "not_received"
  | "from_me"
  | "group_chat"
  | "unsupported_handle"
  | "empty";

export type IMessageNormalization =
  | { readonly dropped: false; readonly event: GatewayInboundEvent }
  | { readonly dropped: true; readonly reason: IMessageDropReason };

/**
 * Canonical handle: E.164 for phone numbers, lowercased for Apple ID emails.
 *
 * Linq reports handles in E.164 already. This guards the two ways one person
 * could otherwise become two actors: a stray formatting character in a
 * number, or case in an email. A handle that is neither shape is refused
 * rather than guessed at, because it becomes a trust identity.
 */
export function canonicalHandle(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) {
    const email = trimmed.toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
  }
  const digits = trimmed.replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(digits)) return digits;
  return undefined;
}

/** Read a polled `Message` into a {@link LinqInbound}. */
export function fromPolledMessage(raw: unknown): LinqInbound | undefined {
  const parsed = LinqMessageSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const message = parsed.data;
  const handle = message.from_handle?.handle ?? message.from ?? undefined;
  if (!handle) return undefined;
  return {
    messageId: message.id,
    chatId: message.chat_id,
    // The message listing has no group flag; the poller only lists chats it
    // already classified as one-to-one, and passes that knowledge here.
    isGroup: false,
    isFromMe: message.is_from_me,
    handle,
    service: message.service ?? message.from_handle?.service ?? undefined,
    parts: message.parts ?? [],
    sentAt: message.sent_at ?? message.created_at,
    raw: message,
  };
}

/**
 * Read a webhook envelope into a {@link LinqInbound}. Returns `"ignored"` for
 * a well-formed event of another type (delivery receipts, typing, reactions
 * until they are wired), so the caller can acknowledge it without logging a
 * malformed delivery.
 */
export function fromWebhookEnvelope(
  raw: unknown,
): LinqInbound | "ignored" | undefined {
  const envelope = LinqWebhookEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return undefined;
  if (envelope.data.event_type !== "message.received") return "ignored";
  const data = LinqReceivedDataSchema.safeParse(envelope.data.data);
  if (!data.success) return undefined;
  const message = data.data;
  return {
    messageId: message.id,
    chatId: message.chat.id,
    isGroup: message.chat.is_group === true,
    isFromMe:
      message.direction === "outbound" || message.sender_handle.is_me === true,
    handle: message.sender_handle.handle,
    service: message.service ?? message.sender_handle.service ?? undefined,
    parts: message.parts ?? [],
    sentAt: message.sent_at ?? undefined,
    raw: envelope.data,
  };
}

function attachmentType(
  mimeType: string | null | undefined,
): GatewayInboundAttachment["type"] {
  if (!mimeType) return "document";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

/**
 * Turn one {@link LinqInbound} into the gateway's inbound event.
 *
 * Text parts are joined with blank lines, the way they read on the phone.
 * Media parts become attachments addressed by their CDN url; downloading
 * them is the ingress handler's job. Group chats and our own echoes are
 * dropped here: the home line is one-to-one by design.
 */
export function normalizeLinqInbound(
  inbound: LinqInbound,
  receivedAt: Date = new Date(),
): IMessageNormalization {
  if (inbound.isFromMe) return { dropped: true, reason: "from_me" };
  if (inbound.isGroup) return { dropped: true, reason: "group_chat" };

  const actorExternalId = canonicalHandle(inbound.handle);
  if (!actorExternalId) {
    return { dropped: true, reason: "unsupported_handle" };
  }

  const text: string[] = [];
  const attachments: GatewayInboundAttachment[] = [];
  for (const part of inbound.parts) {
    if (part.type === "text") {
      if (part.value.trim().length > 0) text.push(part.value);
    } else if (part.type === "media" && part.url) {
      attachments.push({
        type: attachmentType(part.mime_type),
        fileId: part.url,
        ...(part.filename ? { fileName: part.filename } : {}),
        ...(part.mime_type ? { mimeType: part.mime_type } : {}),
        ...(typeof part.size_bytes === "number"
          ? { fileSize: part.size_bytes }
          : {}),
      });
    }
  }

  const content = text.join("\n\n");
  if (content.length === 0 && attachments.length === 0) {
    return { dropped: true, reason: "empty" };
  }

  return {
    dropped: false,
    event: {
      version: "v1",
      sourceChannel: "imessage",
      receivedAt: receivedAt.toISOString(),
      message: {
        eventKind: "message",
        content,
        conversationExternalId: inbound.chatId,
        externalMessageId: inbound.messageId,
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      actor: { actorExternalId },
      source: {
        updateId: inbound.messageId,
        messageId: inbound.messageId,
        chatType: transportOf(inbound.service),
        conversationType: "dm",
        isDirectMessage: true,
      },
      raw: inbound.raw,
    },
  };
}
