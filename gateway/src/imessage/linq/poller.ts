/**
 * Catch-up polling for the Linq line.
 *
 * The relay is fast but forgetful: whatever Linq delivered while the socket
 * was down went to a connection that no longer exists. The poller is the
 * memory. It reads every one-to-one chat that moved since a durable
 * watermark, walks each chat's messages back to that watermark, and hands
 * them over oldest first. It runs on every relay (re)connect, on a slow timer
 * while the relay is healthy, and on a fast one while it is not.
 *
 * ## The watermark
 *
 * A timestamp, not a cursor: Linq's cursors page backwards from "now", so
 * they cannot say "everything after X". The watermark is the newest
 * `created_at` this line has fully handled. A message whose handoff failed
 * holds it back, so the next pass sees that message again. Reads reach a
 * little behind it, because "updated since" and "created since" are two
 * clocks; the gateway's dedup claim makes the overlap free.
 *
 * The first run on a line records "now" and reads nothing. Connecting the
 * channel should not replay the line's history into the conversation.
 */

import type { Logger } from "pino";

import type { LinqClient } from "./client.js";
import { fromPolledMessage, type LinqInbound } from "./normalize.js";

/** How far behind the watermark each pass reads. */
const POLL_OVERLAP_MS = 2 * 60_000;

/** Bounds on one pass, so one pathological line cannot pin the gateway. */
const MAX_CHAT_PAGES = 3;
const MAX_MESSAGE_PAGES = 5;

export interface PollWatermarkStore {
  loadWatermark(): string | undefined;
  saveWatermark(iso: string): void;
}

/**
 * What became of one handed-over message. `retry` means it never reached the
 * assistant and must be seen again; everything else is final, including a
 * drop or a refusal.
 */
export type InboundOutcome = "handled" | "retry";

export interface LinqPollerOptions {
  readonly client: LinqClient;
  readonly line: string;
  readonly store: PollWatermarkStore;
  readonly log: Logger;
  readonly onInbound: (inbound: LinqInbound) => Promise<InboundOutcome>;
  readonly now?: () => number;
}

export class LinqPoller {
  private readonly options: LinqPollerOptions;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(options: LinqPollerOptions) {
    this.options = options;
  }

  /**
   * Run one pass. Calls that arrive mid-pass fold into one follow-up pass,
   * so a burst of reconnects costs at most two.
   */
  poll(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async pass(): Promise<void> {
    const { store, log } = this.options;
    const now = this.options.now?.() ?? Date.now();
    const watermark = store.loadWatermark();
    if (!watermark) {
      store.saveWatermark(new Date(now).toISOString());
      log.info("Linq poller initialized; history before now is not replayed");
      return;
    }
    const watermarkMs = Date.parse(watermark);
    const sinceMs = watermarkMs - POLL_OVERLAP_MS;

    const messages: LinqInbound[] = [];
    for (const chatId of await this.activeChatIds(sinceMs)) {
      messages.push(...(await this.messagesSince(chatId, sinceMs)));
    }
    messages.sort((a, b) => timeOf(a) - timeOf(b));

    let advanceTo = watermarkMs;
    let heldBack = false;
    for (const inbound of messages) {
      const outcome = await this.options.onInbound(inbound);
      if (outcome === "retry") {
        heldBack = true;
        break;
      }
      if (!heldBack) advanceTo = Math.max(advanceTo, timeOf(inbound));
    }
    if (advanceTo > watermarkMs) {
      store.saveWatermark(new Date(Math.min(advanceTo, now)).toISOString());
    }
  }

  /** One-to-one chats on the line that moved since `sinceMs`. */
  private async activeChatIds(sinceMs: number): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_CHAT_PAGES; page++) {
      const result = await this.options.client.listChats(this.options.line, {
        ...(cursor ? { cursor } : {}),
      });
      let reachedOld = false;
      for (const chat of result.items) {
        const updated = chat.updated_at ? Date.parse(chat.updated_at) : NaN;
        if (Number.isFinite(updated) && updated < sinceMs) {
          reachedOld = true;
          continue;
        }
        if (chat.is_group === true) continue;
        ids.push(chat.id);
      }
      cursor = result.nextCursor;
      if (reachedOld || !cursor) break;
    }
    return ids;
  }

  /** A chat's inbound messages created at or after `sinceMs`. */
  private async messagesSince(
    chatId: string,
    sinceMs: number,
  ): Promise<LinqInbound[]> {
    const found: LinqInbound[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
      const result = await this.options.client.listMessages(chatId, {
        ...(cursor ? { cursor } : {}),
      });
      let reachedOld = false;
      for (const raw of result.items) {
        const inbound = fromPolledMessage(raw);
        if (!inbound) {
          this.options.log.warn(
            { chatId },
            "Skipped an unreadable Linq message",
          );
          continue;
        }
        if (timeOf(inbound) < sinceMs) {
          reachedOld = true;
          continue;
        }
        if (!inbound.isFromMe) found.push(inbound);
      }
      cursor = result.nextCursor;
      if (reachedOld || !cursor) break;
    }
    return found;
  }
}

/** When a message happened, for ordering and the watermark. */
function timeOf(inbound: LinqInbound): number {
  const created = (inbound.raw as { created_at?: unknown }).created_at;
  const stamp = typeof created === "string" ? created : inbound.sentAt;
  const ms = stamp ? Date.parse(stamp) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}
