import { createHmac } from "node:crypto";

import { describe, expect, it } from "bun:test";
import pino from "pino";

import { LinqApiError, type LinqClient } from "./client.js";
import {
  LinqRelayListener,
  type RelaySocketLike,
  type RelaySubscriptionStore,
} from "./relay.js";

const LINE = "+12025551234";
const SECRET = `whsec_${Buffer.from("relay-test-signing-key-32-bytes!").toString("base64")}`;
const NOW_MS = Date.parse("2026-11-12T06:00:00.000Z");
const log = pino({ level: "silent" });

type Listener = (event: { data?: unknown; code?: number }) => void;

/** A relay socket that answers `init` with the next connection id. */
class FakeSocket implements RelaySocketLike {
  readonly sent: string[] = [];
  closedWith: number | undefined;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string,
    private readonly connectionId: string | { closeCode: number },
  ) {
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(data);
    const answer = this.connectionId;
    queueMicrotask(() =>
      typeof answer === "string"
        ? this.emit("message", {
            data: JSON.stringify({ connectionId: answer }),
          })
        : this.emit("close", { code: answer.closeCode }),
    );
  }

  close(code?: number): void {
    this.closedWith = code;
  }

  emit(type: string, event: { data?: unknown; code?: number }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function fakeClient(options?: { updateStatus?: number }) {
  const calls: string[] = [];
  let created = 0;
  const client = {
    createWebhookSubscription: async (input: {
      targetUrl: string;
      events: readonly string[];
      phoneNumbers?: readonly string[];
    }) => {
      created++;
      calls.push(
        `create ${input.targetUrl} ${input.events.join(",")} ${input.phoneNumbers?.join(",")}`,
      );
      return {
        id: `sub-${created}`,
        target_url: input.targetUrl,
        signing_secret: SECRET,
      };
    },
    updateWebhookTarget: async (id: string, url: string) => {
      calls.push(`update ${id} ${url}`);
      if (options?.updateStatus) {
        throw new LinqApiError(
          options.updateStatus,
          "updateWebhookSubscription",
          "",
        );
      }
    },
    deleteWebhookSubscription: async (id: string) => {
      calls.push(`delete ${id}`);
    },
  };
  return { client: client as unknown as LinqClient, calls };
}

function memoryStore(
  initial?: string,
): RelaySubscriptionStore & { id?: string } {
  const store = {
    id: initial,
    loadSubscriptionId: () => store.id,
    saveSubscriptionId: (id: string | undefined) => {
      store.id = id;
    },
  };
  return store;
}

function signedFrame(
  payload: string,
  options?: { secret?: string; timestampMs?: number },
): string {
  const id = "msg_2b0c1d";
  const timestamp = String(Math.floor((options?.timestampMs ?? NOW_MS) / 1000));
  const key = Buffer.from(
    (options?.secret ?? SECRET).slice("whsec_".length),
    "base64",
  );
  const signature = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");
  return JSON.stringify({
    payload,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
  });
}

/** Let queued microtasks and zero-delay timers run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function harness(options?: {
  connectionIds?: (string | { closeCode: number })[];
  orphan?: string;
  updateStatus?: number;
}) {
  const sockets: FakeSocket[] = [];
  const ids = [...(options?.connectionIds ?? ["conn-1", "conn-2", "conn-3"])];
  const { client, calls } = fakeClient({ updateStatus: options?.updateStatus });
  const store = memoryStore(options?.orphan);
  const events: unknown[] = [];
  const lifecycle: string[] = [];
  const listener = new LinqRelayListener({
    client,
    token: "linq_test_token",
    line: LINE,
    store,
    log,
    onEvent: (envelope) => events.push(envelope),
    onConnected: () => lifecycle.push("connected"),
    onDisconnected: () => lifecycle.push("disconnected"),
    onAuthFailure: () => lifecycle.push("auth-failure"),
    wsUrl: "wss://relay.test/prod",
    relayUrl: "https://webhook.test",
    createSocket: (url) => {
      const socket = new FakeSocket(url, ids.shift() ?? "conn-x");
      sockets.push(socket);
      return socket;
    },
    now: () => NOW_MS,
    random: () => 0,
  });
  return { listener, sockets, calls, store, events, lifecycle };
}

describe("LinqRelayListener", () => {
  it("connects, subscribes this line through the relay and reports live", async () => {
    const h = harness();
    await h.listener.start();

    expect(h.sockets[0]!.url).toBe(
      "wss://relay.test/prod?token=linq_test_token",
    );
    expect(JSON.parse(h.sockets[0]!.sent[0]!)).toEqual({ action: "init" });
    expect(h.calls).toEqual([
      `create https://webhook.test/relay/conn-1?format=signed&version=2026-02-03 message.received ${LINE}`,
    ]);
    expect(h.store.id).toBe("sub-1");
    expect(h.lifecycle).toEqual(["connected"]);
    expect(h.listener.connected).toBe(true);
    await h.listener.stop();
  });

  it("deletes a subscription orphaned by a previous run before subscribing", async () => {
    const h = harness({ orphan: "sub-old" });
    await h.listener.start();
    expect(h.calls[0]).toBe("delete sub-old");
    expect(h.calls[1]).toStartWith("create ");
    await h.listener.stop();
  });

  it("passes on a delivery only once its signature verifies", async () => {
    const h = harness();
    await h.listener.start();
    const socket = h.sockets[0]!;
    const envelope = {
      event_type: "message.received",
      event_id: "e1",
      data: {},
    };

    socket.emit("message", { data: signedFrame(JSON.stringify(envelope)) });
    expect(h.events).toEqual([envelope]);

    const forged = `whsec_${Buffer.from("someone-else-entirely-32-bytes!!").toString("base64")}`;
    socket.emit("message", {
      data: signedFrame(JSON.stringify(envelope), { secret: forged }),
    });
    socket.emit("message", {
      data: signedFrame(JSON.stringify(envelope), {
        timestampMs: NOW_MS - 10 * 60_000,
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({ payload: JSON.stringify(envelope) }),
    });
    socket.emit("message", { data: "not json" });
    expect(h.events).toHaveLength(1);
    await h.listener.stop();
  });

  it("reconnects after a drop and re-aims the same subscription", async () => {
    const h = harness();
    await h.listener.start();
    h.sockets[0]!.emit("close", { code: 1001 });
    await settle();

    expect(h.lifecycle).toEqual(["connected", "disconnected", "connected"]);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toBe(
      "update sub-1 https://webhook.test/relay/conn-2?format=signed&version=2026-02-03",
    );
    expect(h.listener.connected).toBe(true);
    await h.listener.stop();
  });

  it("makes a new subscription when the old one was deleted out from under it", async () => {
    const h = harness({ updateStatus: 404 });
    await h.listener.start();
    h.sockets[0]!.emit("close", { code: 1001 });
    await settle();

    expect(h.calls[2]).toStartWith("create https://webhook.test/relay/conn-2");
    expect(h.store.id).toBe("sub-2");
    await h.listener.stop();
  });

  it("stops for good when the relay refuses the token", async () => {
    const h = harness({ connectionIds: [{ closeCode: 4001 }] });
    await h.listener.start();
    await settle();

    expect(h.lifecycle).toEqual(["auth-failure"]);
    expect(h.sockets).toHaveLength(1);
    expect(h.calls).toEqual([]);
  });

  it("deletes its subscription and forgets it on stop", async () => {
    const h = harness();
    await h.listener.start();
    await h.listener.stop();

    expect(h.calls.at(-1)).toBe("delete sub-1");
    expect(h.store.id).toBeUndefined();
    expect(h.sockets[0]!.closedWith).toBe(1000);
    expect(h.listener.connected).toBe(false);
  });
});
