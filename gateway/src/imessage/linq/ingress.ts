/**
 * The one door every Linq message walks through into the assistant.
 *
 * The relay and the poller both end here, so a message is gated, deduped
 * and handed over the same way whichever path found it first. The dedup
 * claim is the gateway's durable inbound store, keyed on Linq's message id:
 * the second path to arrive is answered as already handled.
 *
 * Trust follows transport. An iMessage sender is an Apple identity and keeps
 * whatever trust the contact graph gives it. A message that fell back to SMS
 * or RCS carries a sender id anyone can forge, so it reaches the gate marked
 * unauthenticated and is treated as a stranger, guardian number or not.
 */

import type { Logger } from "pino";

import type { GatewayConfig } from "../../config.js";
import type { ConversationTaskQueue } from "../../channels/conversation-queue.js";
import {
  commitInboundEvent,
  releaseInboundEvent,
  reserveInboundEvent,
} from "../../db/inbound-dedup-store.js";
import {
  handleInbound,
  type InboundResult,
} from "../../handlers/handle-inbound.js";
import { upsertContactChannel } from "../../verification/contact-helpers.js";
import type { InboundOutcome } from "./poller.js";
import { normalizeLinqInbound, type LinqInbound } from "./normalize.js";

export interface LinqIngressOptions {
  readonly config: GatewayConfig;
  readonly log: Logger;
  readonly queue: ConversationTaskQueue;
  readonly notifyRecordActivity: () => void;
  /** Injectable for tests; defaults to the real gateway pipeline. */
  readonly deliver?: typeof handleInbound;
}

/**
 * Whether the pipeline reached a decision about the message.
 *
 * `handleInbound` reports a failed runtime forward as a quiet
 * `{ forwarded: false, rejected: false }` rather than a throw. Every other
 * unforwarded result is a decision (refused, or consumed by a verification or
 * invite intercept) and sending the message again would change nothing.
 */
export function reachedAnOutcome(result: InboundResult): boolean {
  return (
    result.forwarded ||
    result.rejected ||
    result.verificationIntercepted === true ||
    result.inviteIntercepted === true
  );
}

export function createLinqIngress(
  options: LinqIngressOptions,
): (inbound: LinqInbound) => Promise<InboundOutcome> {
  const { config, log, queue } = options;
  const deliver = options.deliver ?? handleInbound;

  return (inbound) => {
    const result = normalizeLinqInbound(inbound);
    if (result.dropped) {
      if (result.reason !== "from_me") {
        log.info(
          { reason: result.reason, messageId: inbound.messageId },
          "Linq message dropped before the gate",
        );
      }
      return Promise.resolve("handled");
    }
    const event = result.event;
    const key = {
      sourceChannel: "imessage",
      externalChatId: event.message.conversationExternalId,
      externalMessageId: event.message.externalMessageId,
    };

    // Per chat, in arrival order: two texts sent a second apart must reach
    // the conversation in the order they were typed.
    return queue.enqueue(
      key.externalChatId,
      async (): Promise<InboundOutcome> => {
        if (!reserveInboundEvent(key)) return "handled";
        options.notifyRecordActivity();
        void upsertContactChannel({
          sourceChannel: "imessage",
          externalUserId: event.actor.actorExternalId,
          externalChatId: event.message.conversationExternalId,
        }).catch(() => {});

        let failure: unknown;
        try {
          const result = await deliver(config, event, {
            replyCallbackUrl: `${config.gatewayInternalBaseUrl}/deliver/imessage`,
            ...(event.source.chatType === "imessage"
              ? {}
              : { senderAuthenticated: false }),
          });
          if (!reachedAnOutcome(result)) failure = "runtime forward failed";
        } catch (err) {
          // A circuit-open runtime arrives as a throw; anything else is a bug
          // that should still not cost the message.
          failure = err;
        }
        if (failure !== undefined) {
          // Never reached the assistant. Release the claim so the next poll
          // pass, which this outcome also holds the watermark for, retries it.
          releaseInboundEvent(key);
          log.error(
            { err: failure, messageId: key.externalMessageId },
            "Linq message could not be handed to the assistant; will retry",
          );
          return "retry";
        }
        commitInboundEvent(key);
        return "handled";
      },
    );
  };
}
