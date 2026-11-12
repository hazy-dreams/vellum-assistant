/**
 * Tolerant Zod schemas for the slice of Linq's v3 partner API the iMessage
 * channel reads.
 *
 * Source of truth is Linq's published OpenAPI contract
 * (`https://cdn.linqapp.com/openapi/linq-api-v3.yaml`) and the webhook event
 * reference for `webhook_version` 2026-02-03. Only fields the channel acts on
 * are required; everything else is optional or passed through, so a vendor
 * adding a field degrades nothing and a vendor dropping one we never needed
 * does not drop a message.
 */

import { z } from "zod";

/**
 * The transport a message actually travelled on. Linq falls back from
 * iMessage to RCS and SMS per recipient, and that difference is a trust
 * difference: SMS sender ids are spoofable, iMessage identities are not.
 */
export const LinqServiceSchema = z.enum(["iMessage", "SMS", "RCS"]);
export type LinqService = z.infer<typeof LinqServiceSchema>;

export const LinqHandleSchema = z
  .object({
    id: z.string().optional(),
    handle: z.string().min(1),
    service: LinqServiceSchema.nullish(),
    is_me: z.boolean().nullish(),
    status: z.string().nullish(),
  })
  .passthrough();
export type LinqHandle = z.infer<typeof LinqHandleSchema>;

const LinqTextPartSchema = z
  .object({ type: z.literal("text"), value: z.string() })
  .passthrough();

const LinqMediaPartSchema = z
  .object({
    type: z.literal("media"),
    id: z.string().optional(),
    url: z.string().optional(),
    filename: z.string().nullish(),
    mime_type: z.string().nullish(),
    size_bytes: z.number().nullish(),
  })
  .passthrough();

/**
 * Parts the channel does not render yet (links, iMessage app cards, app
 * clips) are kept as an opaque `other` so one unfamiliar part never fails the
 * whole message.
 */
const LinqOtherPartSchema = z
  .object({ type: z.string() })
  .passthrough()
  .transform((part) => ({ ...part, type: "other" as const, kind: part.type }));

export const LinqPartSchema = z.union([
  LinqTextPartSchema,
  LinqMediaPartSchema,
  LinqOtherPartSchema,
]);
export type LinqPart = z.infer<typeof LinqPartSchema>;

/**
 * A message as `GET /v3/chats/{chatId}/messages` returns it (the `Message`
 * component). The poller reads this shape.
 */
export const LinqMessageSchema = z
  .object({
    id: z.string().min(1),
    chat_id: z.string().min(1),
    is_from_me: z.boolean(),
    service: LinqServiceSchema.nullish(),
    from: z.string().nullish(),
    from_handle: LinqHandleSchema.nullish(),
    parts: z.array(LinqPartSchema).nullish(),
    created_at: z.string(),
    sent_at: z.string().nullish(),
  })
  .passthrough();
export type LinqMessage = z.infer<typeof LinqMessageSchema>;

export const LinqGetMessagesResultSchema = z
  .object({
    messages: z.array(z.unknown()),
    next_cursor: z.string().nullish(),
  })
  .passthrough();

export const LinqChatSchema = z
  .object({
    id: z.string().min(1),
    is_group: z.boolean().nullish(),
  })
  .passthrough();

export const LinqListChatsResultSchema = z
  .object({
    chats: z.array(z.unknown()),
    next_cursor: z.string().nullish(),
  })
  .passthrough();

/**
 * `data` of a `message.received` webhook on version 2026-02-03. The
 * subscription URL pins `?version=2026-02-03` so this is the shape that
 * arrives; the 2025-01-01 shape is not accepted.
 */
export const LinqReceivedDataSchema = z
  .object({
    id: z.string().min(1),
    direction: z.string().optional(),
    chat: LinqChatSchema,
    sender_handle: LinqHandleSchema,
    parts: z.array(LinqPartSchema).nullish(),
    service: LinqServiceSchema.nullish(),
    sent_at: z.string().nullish(),
  })
  .passthrough();
export type LinqReceivedData = z.infer<typeof LinqReceivedDataSchema>;

export const LinqWebhookEnvelopeSchema = z
  .object({
    api_version: z.string().optional(),
    webhook_version: z.string().optional(),
    event_type: z.string().min(1),
    event_id: z.string().min(1),
    created_at: z.string().optional(),
    data: z.unknown(),
  })
  .passthrough();
export type LinqWebhookEnvelope = z.infer<typeof LinqWebhookEnvelopeSchema>;
