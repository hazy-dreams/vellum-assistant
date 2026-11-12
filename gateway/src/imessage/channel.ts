/**
 * The iMessage home channel's inbound half, as one lifecycle.
 *
 * Exists while a `linq:api_token` credential does, exactly like the Discord
 * gateway client: storing the token starts it, rotating the token restarts
 * it, removing the token stops it. Nothing here sends; replies leave through
 * the assistant's iMessage transport via `/deliver/imessage`.
 *
 *   relay (real time) ──┐
 *                       ├─► ingress: normalize → dedup claim → gate → assistant
 *   poller (catch-up) ──┘
 *
 * The poller runs on every relay connect, every five minutes while the relay
 * is healthy, and every twenty seconds while it is not, so a dead relay
 * degrades the channel to slow rather than deaf.
 */

import type { Logger } from "pino";

import type { GatewayConfig } from "../config.js";
import { createConversationTaskQueue } from "../channels/conversation-queue.js";
import { LinqApiError, LinqClient } from "./linq/client.js";
import { createLinqIngress } from "./linq/ingress.js";
import { fromWebhookEnvelope } from "./linq/normalize.js";
import { LinqPoller } from "./linq/poller.js";
import { LinqRelayListener } from "./linq/relay.js";
import { LinqStateFile } from "./linq/state.js";

const POLL_WHILE_RELAY_HEALTHY_MS = 5 * 60_000;
const POLL_WHILE_RELAY_DOWN_MS = 20_000;
/** A message the relay could not hand over gets a quick second chance. */
const POLL_AFTER_RETRY_MS = 5_000;

export interface IMessageChannelOptions {
  readonly config: GatewayConfig;
  readonly log: Logger;
  readonly token: string;
  /** Directory for the non-secret state file. */
  readonly stateDir: string;
  readonly notifyRecordActivity: () => void;
  /** Pin the line when an account has several. Defaults to the only one. */
  readonly line?: string;
  readonly client?: LinqClient;
}

export class IMessageChannel {
  private readonly options: IMessageChannelOptions;
  private readonly client: LinqClient;
  private relay: LinqRelayListener | null = null;
  private poller: LinqPoller | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(options: IMessageChannelOptions) {
    this.options = options;
    this.client = options.client ?? new LinqClient({ token: options.token });
  }

  async start(): Promise<void> {
    const { log } = this.options;
    const line = await this.resolveLine();
    if (!line || this.stopped) return;

    const state = LinqStateFile.at(this.options.stateDir, line);
    const ingress = createLinqIngress({
      config: this.options.config,
      log,
      queue: createConversationTaskQueue(),
      notifyRecordActivity: this.options.notifyRecordActivity,
    });

    this.poller = new LinqPoller({
      client: this.client,
      line,
      store: state,
      log,
      onInbound: ingress,
    });

    this.relay = new LinqRelayListener({
      client: this.client,
      token: this.options.token,
      line,
      store: state,
      log,
      onEvent: (envelope) => {
        const inbound = fromWebhookEnvelope(envelope);
        if (inbound === "ignored") return;
        if (!inbound) {
          log.warn("Verified Linq event did not match the message schema");
          return;
        }
        void ingress(inbound).then((outcome) => {
          if (outcome === "retry") this.schedulePoll(POLL_AFTER_RETRY_MS);
        });
      },
      onConnected: () => this.schedulePoll(0),
      onDisconnected: () => this.schedulePoll(POLL_WHILE_RELAY_DOWN_MS),
      onAuthFailure: () => void this.stop(),
    });

    log.info({ line: maskLine(line) }, "iMessage channel starting on Linq");
    await this.relay.start();
    // The relay's onConnected polls; if it did not connect, start the loop.
    if (!this.pollTimer) this.schedulePoll(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    const relay = this.relay;
    this.relay = null;
    this.poller = null;
    await relay?.stop();
  }

  /** Our line: the pinned one, or the account's only one. */
  private async resolveLine(): Promise<string | undefined> {
    const { log } = this.options;
    let numbers;
    try {
      numbers = await this.client.listPhoneNumbers();
    } catch (err) {
      log.error(
        { err },
        err instanceof LinqApiError && err.isAuthFailure
          ? "Linq refused the API token; iMessage channel not started"
          : "Could not read Linq lines; iMessage channel not started",
      );
      return undefined;
    }
    const pinned = this.options.line;
    if (pinned) {
      if (numbers.some((n) => n.phone_number === pinned)) return pinned;
      log.error(
        { line: maskLine(pinned) },
        "Pinned iMessage line is not on this Linq account",
      );
      return undefined;
    }
    if (numbers.length === 1) return numbers[0]!.phone_number;
    log.error(
      { lines: numbers.length },
      "Linq account has no single line; set imessage.line to choose one",
    );
    return undefined;
  }

  /** (Re)arm the poll timer to fire in `delayMs`, then keep the cadence. */
  private schedulePoll(delayMs: number): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.runPoll();
    }, delayMs);
  }

  private async runPoll(): Promise<void> {
    const poller = this.poller;
    if (!poller || this.stopped) return;
    try {
      await poller.poll();
    } catch (err) {
      if (err instanceof LinqApiError && err.isAuthFailure) {
        this.options.log.error(
          "Linq refused the API token; stopping iMessage channel",
        );
        await this.stop();
        return;
      }
      this.options.log.warn({ err }, "Linq catch-up poll failed");
    }
    if (!this.pollTimer) {
      this.schedulePoll(
        this.relay?.connected
          ? POLL_WHILE_RELAY_HEALTHY_MS
          : POLL_WHILE_RELAY_DOWN_MS,
      );
    }
  }
}

/** Last four digits only. The line is ours, but logs travel. */
function maskLine(line: string): string {
  return `…${line.slice(-4)}`;
}
