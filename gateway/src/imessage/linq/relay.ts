/**
 * Real-time Linq events without a public URL.
 *
 * Linq's own CLI (`linq webhooks listen`) receives webhooks on a machine
 * nobody can reach: it opens a WebSocket to a Linq-hosted relay, is handed a
 * connection id, and points an ordinary webhook subscription at
 * `https://webhook.linqapp.com/relay/<connectionId>?format=signed`. Linq's
 * dispatcher delivers there exactly as it would to a server, and the relay
 * pushes each delivery down the socket with its body and Standard Webhooks
 * headers intact. This module is that listener, built for a long-lived
 * gateway instead of a terminal session.
 *
 * ## Trust
 *
 * The relay is a pipe, not an authority. Every event is verified against the
 * subscription's own signing secret with the gateway's Standard Webhooks
 * verifier (five-minute replay window) before it is parsed, so a relay that
 * misroutes or invents a delivery is dropped. The secret is returned once, on
 * create, and is held only in memory: a restarted gateway makes a new
 * subscription rather than storing a webhook secret on disk.
 *
 * ## What it cannot promise
 *
 * A delivery made while the socket is down goes to a connection id that no
 * longer exists, and nothing guarantees Linq retries it. So the relay is the
 * fast path, never the only one. Every successful (re)connect fires
 * `onConnected`, which the channel answers with a catch-up poll; the poller
 * and the relay dedupe on the same Linq message id, so overlap costs nothing.
 *
 * ## Subscription hygiene
 *
 * A subscription is account state that outlives this process. Its id (not
 * its secret) is persisted, and the next start deletes whatever a crashed
 * predecessor left behind before creating its own. A reconnect within one
 * process re-targets the same subscription instead of creating another.
 */

import type { Logger } from "pino";

import { verifyDeclaredSignature } from "../../channels/ingress-verification.js";
import { ExponentialBackoff } from "../../util/exponential-backoff.js";
import {
  LINQ_WEBHOOK_VERSION,
  LinqApiError,
  type LinqClient,
} from "./client.js";

const LINQ_RELAY_WS_URL =
  "wss://9r8ugjg4s0.execute-api.us-east-1.amazonaws.com/prod";
const LINQ_RELAY_HTTP_URL = "https://webhook.linqapp.com";

/** Events the home channel acts on. Receipts and the rest stay unsubscribed. */
const RELAY_EVENTS = ["message.received"] as const;

/** How long the relay has to hand back a connection id. */
const CONNECT_TIMEOUT_MS = 10_000;

/** A connection that held this long counts as recovered for backoff. */
const STABLE_AFTER_MS = 60_000;

/** Close code the relay uses for a rejected token. */
const CLOSE_AUTH_FAILED = 4001;

const STANDARD_WEBHOOKS = {
  kind: "standard-webhooks",
  secret: { field: "signing_secret" },
} as const;

/** The surface of a WebSocket this listener uses, satisfiable by a fake. */
export interface RelaySocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void;
}

/** Where the id of our live subscription survives a restart. */
export interface RelaySubscriptionStore {
  loadSubscriptionId(): string | undefined;
  saveSubscriptionId(id: string | undefined): void;
}

export interface LinqRelayListenerOptions {
  readonly client: LinqClient;
  readonly token: string;
  /** Our Linq number, so the subscription carries only this line's events. */
  readonly line: string;
  readonly store: RelaySubscriptionStore;
  readonly log: Logger;
  /** A verified, parsed webhook envelope. */
  readonly onEvent: (envelope: unknown) => void;
  /** The relay is live; anything missed while it was not should be fetched. */
  readonly onConnected: () => void;
  /** The relay is down; the caller may poll harder until it returns. */
  readonly onDisconnected?: () => void;
  /** The token was refused. The listener has stopped and will not retry. */
  readonly onAuthFailure?: () => void;
  readonly wsUrl?: string;
  readonly relayUrl?: string;
  readonly createSocket?: (url: string) => RelaySocketLike;
  readonly now?: () => number;
  readonly random?: () => number;
}

export class LinqRelayListener {
  private readonly options: LinqRelayListenerOptions;
  private readonly backoff: ExponentialBackoff;
  private socket: RelaySocketLike | null = null;
  private subscriptionId: string | null = null;
  private signingSecret: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(options: LinqRelayListenerOptions) {
    this.options = options;
    this.backoff = new ExponentialBackoff({
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      jitter: { mode: "full" },
      ...(options.random ? { random: options.random } : {}),
    });
  }

  /** Clear any orphaned subscription, then connect. */
  async start(): Promise<void> {
    this.stopped = false;
    const orphan = this.options.store.loadSubscriptionId();
    if (orphan) {
      try {
        await this.options.client.deleteWebhookSubscription(orphan);
        this.options.log.info(
          { subscriptionId: orphan },
          "Deleted Linq relay subscription left by a previous run",
        );
      } catch (err) {
        // Not fatal: a leftover subscription only aims at a dead connection.
        this.options.log.warn(
          { err, subscriptionId: orphan },
          "Could not delete a leftover Linq relay subscription",
        );
      }
      this.options.store.saveSubscriptionId(undefined);
    }
    await this.connect();
  }

  /** Disconnect and delete the subscription. Safe to call more than once. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "stopping");
    const id = this.subscriptionId;
    this.subscriptionId = null;
    this.signingSecret = null;
    if (id) {
      try {
        await this.options.client.deleteWebhookSubscription(id);
      } catch (err) {
        this.options.log.warn(
          { err, subscriptionId: id },
          "Could not delete the Linq relay subscription on stop",
        );
        return; // Leave the id persisted so the next start removes it.
      }
    }
    this.options.store.saveSubscriptionId(undefined);
  }

  get connected(): boolean {
    return this.socket !== null && this.signingSecret !== null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let socket: RelaySocketLike;
    let connectionId: string;
    try {
      ({ socket, connectionId } = await this.openSocket());
    } catch (err) {
      if (err instanceof RelayAuthError) return this.failAuth();
      this.options.log.warn({ err }, "Linq relay connection failed");
      return this.scheduleReconnect();
    }
    if (this.stopped) {
      socket.close(1000, "stopping");
      return;
    }

    try {
      await this.aimSubscription(this.targetFor(connectionId));
    } catch (err) {
      socket.close(1000, "subscription failed");
      if (err instanceof LinqApiError && err.isAuthFailure) {
        return this.failAuth();
      }
      this.options.log.warn({ err }, "Could not point Linq webhooks at relay");
      return this.scheduleReconnect();
    }

    this.socket = socket;
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", (event) =>
      this.onClose(socket, event.code),
    );
    this.stableTimer = setTimeout(() => this.backoff.reset(), STABLE_AFTER_MS);
    this.options.log.info("Linq relay connected");
    this.options.onConnected();
  }

  /** Open the socket and wait for the relay to name the connection. */
  private openSocket(): Promise<{
    socket: RelaySocketLike;
    connectionId: string;
  }> {
    const base = this.options.wsUrl ?? LINQ_RELAY_WS_URL;
    // The relay authenticates the socket by a query token; it accepts nothing
    // else. The URL is built here and never logged.
    const url = `${base}?token=${encodeURIComponent(this.options.token)}`;
    const create =
      this.options.createSocket ??
      ((u: string) => new WebSocket(u) as unknown as RelaySocketLike);

    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = create(url);
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(
        () =>
          settle(() => {
            socket.close(1000, "timeout");
            reject(new Error("Linq relay did not answer init"));
          }),
        CONNECT_TIMEOUT_MS,
      );
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ action: "init" }));
      });
      socket.addEventListener("message", (event) => {
        const connectionId = connectionIdOf(event.data);
        if (connectionId) settle(() => resolve({ socket, connectionId }));
      });
      socket.addEventListener("error", () =>
        settle(() => reject(new Error("Linq relay socket error"))),
      );
      socket.addEventListener("close", (event) =>
        settle(() =>
          reject(
            event.code === CLOSE_AUTH_FAILED
              ? new RelayAuthError()
              : new Error(`Linq relay closed during init (${event.code})`),
          ),
        ),
      );
    });
  }

  private targetFor(connectionId: string): string {
    const base = (this.options.relayUrl ?? LINQ_RELAY_HTTP_URL).replace(
      /\/+$/,
      "",
    );
    const query = new URLSearchParams({
      format: "signed",
      version: LINQ_WEBHOOK_VERSION,
    });
    return `${base}/relay/${encodeURIComponent(connectionId)}?${query}`;
  }

  /** Re-target our subscription, or create it the first time. */
  private async aimSubscription(targetUrl: string): Promise<void> {
    if (this.subscriptionId && this.signingSecret) {
      try {
        await this.options.client.updateWebhookTarget(
          this.subscriptionId,
          targetUrl,
        );
        return;
      } catch (err) {
        if (!(err instanceof LinqApiError) || err.status !== 404) throw err;
        // Deleted out from under us: fall through and make a new one.
      }
    }
    const created = await this.options.client.createWebhookSubscription({
      targetUrl,
      events: RELAY_EVENTS,
      phoneNumbers: [this.options.line],
    });
    if (!created.signing_secret) {
      await this.options.client.deleteWebhookSubscription(created.id);
      throw new Error("Linq returned a subscription without a signing secret");
    }
    this.subscriptionId = created.id;
    this.signingSecret = created.signing_secret;
    this.options.store.saveSubscriptionId(created.id);
  }

  private onMessage(data: unknown): void {
    const secret = this.signingSecret;
    if (!secret || typeof data !== "string") return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      this.options.log.warn("Ignored an unparseable Linq relay frame");
      return;
    }
    if (connectionIdOf(data)) return;

    const delivery = signedDeliveryOf(frame);
    if (!delivery) {
      this.options.log.warn(
        "Ignored a Linq relay frame without signed headers",
      );
      return;
    }
    const verdict = verifyDeclaredSignature({
      verification: STANDARD_WEBHOOKS,
      headers: delivery.headers,
      body: new TextEncoder().encode(delivery.payload),
      secret,
      nowMs: this.options.now?.(),
    });
    if (!verdict.ok) {
      this.options.log.warn(
        { reason: verdict.reason },
        "Rejected a Linq relay delivery that failed verification",
      );
      return;
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(delivery.payload);
    } catch {
      this.options.log.warn("Verified Linq delivery was not JSON");
      return;
    }
    this.options.onEvent(envelope);
  }

  private onClose(socket: RelaySocketLike, code: number | undefined): void {
    if (this.socket !== socket) return; // An old socket we already replaced.
    this.socket = null;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
    if (this.stopped) return;
    if (code === CLOSE_AUTH_FAILED) {
      this.failAuth();
      return;
    }
    this.options.log.info({ code }, "Linq relay disconnected");
    this.options.onDisconnected?.();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoff.nextDelayMs();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private failAuth(): void {
    this.options.log.error(
      "Linq refused the API token; the iMessage relay is stopped until the credential changes",
    );
    void this.stop();
    this.options.onAuthFailure?.();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.reconnectTimer = null;
    this.stableTimer = null;
  }
}

class RelayAuthError extends Error {
  constructor() {
    super("Linq relay rejected the token");
    this.name = "RelayAuthError";
  }
}

function connectionIdOf(data: unknown): string | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = JSON.parse(data) as { connectionId?: unknown };
    return typeof parsed.connectionId === "string" && parsed.connectionId
      ? parsed.connectionId
      : undefined;
  } catch {
    return undefined;
  }
}

/** The body and Standard Webhooks headers a `format=signed` frame carries. */
function signedDeliveryOf(
  frame: unknown,
): { payload: string; headers: Headers } | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const { payload, headers } = frame as {
    payload?: unknown;
    headers?: unknown;
  };
  if (typeof payload !== "string" || !headers || typeof headers !== "object") {
    return undefined;
  }
  const out = new Headers();
  for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
    const value = (headers as Record<string, unknown>)[name];
    if (typeof value !== "string") return undefined;
    out.set(name, value);
  }
  return { payload, headers: out };
}
