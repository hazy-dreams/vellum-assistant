/**
 * The read side of Linq's v3 partner API, for the gateway.
 *
 * The gateway only listens. It reads lines, chats and messages to catch up,
 * and it manages the one webhook subscription the relay listener points at.
 * Sending, typing, reactions and edits are the assistant's transport and live
 * there, next to the delivery state they have to agree with.
 *
 * Every call is one request with a bounded timeout and no retry. The callers
 * are loops with their own pacing (the poller's interval, the relay's
 * backoff), and a retry here would hide a failing vendor from the code that
 * decides how hard to lean on it.
 */

import { fetchImpl, type FetchInit } from "../../fetch.js";

const LINQ_API_BASE_URL = "https://api.linqapp.com/api/partner";

/** Webhook payload version every subscription is pinned to. */
export const LINQ_WEBHOOK_VERSION = "2026-02-03";

const REQUEST_TIMEOUT_MS = 15_000;

export type LinqFetch = (url: string, init?: FetchInit) => Promise<Response>;

/** A non-2xx answer, with the status kept so callers can tell auth from load. */
export class LinqApiError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
    /** Linq's error body, truncated. Never contains the token. */
    readonly detail: string,
  ) {
    super(`Linq ${operation} failed with ${status}`);
    this.name = "LinqApiError";
  }

  /** The token is wrong or revoked. Retrying cannot help; a human can. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface LinqPhoneNumber {
  readonly id: string;
  readonly phone_number: string;
  readonly line_status?: string | null;
}

export interface LinqChatSummary {
  readonly id: string;
  readonly is_group?: boolean | null;
  readonly updated_at?: string | null;
}

export interface LinqPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | undefined;
}

export interface LinqWebhookSubscription {
  readonly id: string;
  readonly target_url: string;
  /** Present only on the create response; Linq cannot show it again. */
  readonly signing_secret?: string;
}

export interface LinqClientOptions {
  readonly token: string;
  readonly baseUrl?: string;
  readonly fetch?: LinqFetch;
}

export class LinqClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetch: LinqFetch;

  constructor(options: LinqClientOptions) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? LINQ_API_BASE_URL).replace(/\/+$/, "");
    this.fetch = options.fetch ?? fetchImpl;
  }

  /** The lines on this account. A shared line account has exactly one. */
  async listPhoneNumbers(): Promise<readonly LinqPhoneNumber[]> {
    const body = await this.request(
      "GET",
      "/v3/phone_numbers",
      "listPhoneNumbers",
    );
    return arrayField<LinqPhoneNumber>(body, "phone_numbers");
  }

  /** One page of chats on `line`, most recently active first. */
  async listChats(
    line: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<LinqPage<LinqChatSummary>> {
    const query = new URLSearchParams({ from: line });
    query.set("limit", String(options?.limit ?? 50));
    if (options?.cursor) query.set("cursor", options.cursor);
    const body = await this.request("GET", `/v3/chats?${query}`, "listChats");
    return {
      items: arrayField<LinqChatSummary>(body, "chats"),
      nextCursor: cursorField(body),
    };
  }

  /**
   * One page of a chat's messages, newest first. Items are left raw: the
   * normalizer owns their schema, so one odd message cannot fail the page.
   */
  async listMessages(
    chatId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<LinqPage<unknown>> {
    const query = new URLSearchParams({ limit: String(options?.limit ?? 50) });
    if (options?.cursor) query.set("cursor", options.cursor);
    const body = await this.request(
      "GET",
      `/v3/chats/${encodeURIComponent(chatId)}/messages?${query}`,
      "listMessages",
    );
    return {
      items: arrayField<unknown>(body, "messages"),
      nextCursor: cursorField(body),
    };
  }

  async createWebhookSubscription(input: {
    targetUrl: string;
    events: readonly string[];
    phoneNumbers?: readonly string[];
  }): Promise<LinqWebhookSubscription> {
    const body = await this.request(
      "POST",
      "/v3/webhook-subscriptions",
      "createWebhookSubscription",
      {
        target_url: input.targetUrl,
        subscribed_events: input.events,
        ...(input.phoneNumbers ? { phone_numbers: input.phoneNumbers } : {}),
      },
    );
    return subscriptionOf(body);
  }

  async updateWebhookTarget(id: string, targetUrl: string): Promise<void> {
    await this.request(
      "PUT",
      `/v3/webhook-subscriptions/${encodeURIComponent(id)}`,
      "updateWebhookSubscription",
      { target_url: targetUrl },
    );
  }

  /** Delete a subscription. An already-gone subscription counts as deleted. */
  async deleteWebhookSubscription(id: string): Promise<void> {
    try {
      await this.request(
        "DELETE",
        `/v3/webhook-subscriptions/${encodeURIComponent(id)}`,
        "deleteWebhookSubscription",
      );
    } catch (err) {
      if (err instanceof LinqApiError && err.status === 404) return;
      throw err;
    }
  }

  private async request(
    method: string,
    path: string,
    operation: string,
    json?: unknown,
  ): Promise<unknown> {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new LinqApiError(response.status, operation, detail);
    }
    if (response.status === 204) return undefined;
    const text = await response.text();
    return text.length === 0 ? undefined : (JSON.parse(text) as unknown);
  }
}

function arrayField<T>(body: unknown, key: string): T[] {
  if (body && typeof body === "object" && key in body) {
    const value = (body as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as T[];
  }
  throw new LinqApiError(200, `read ${key}`, "response had no array field");
}

function cursorField(body: unknown): string | undefined {
  const cursor = (body as { next_cursor?: unknown } | undefined)?.next_cursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

function subscriptionOf(body: unknown): LinqWebhookSubscription {
  const value = body as Partial<LinqWebhookSubscription> | undefined;
  if (
    !value ||
    typeof value.id !== "string" ||
    typeof value.target_url !== "string"
  ) {
    throw new LinqApiError(200, "read subscription", "response had no id");
  }
  return {
    id: value.id,
    target_url: value.target_url,
    ...(typeof value.signing_secret === "string"
      ? { signing_secret: value.signing_secret }
      : {}),
  };
}
