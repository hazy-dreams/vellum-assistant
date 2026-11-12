import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import pino from "pino";

import "../../__tests__/test-preload.js";
import { createConversationTaskQueue } from "../../channels/conversation-queue.js";
import type { GatewayConfig } from "../../config.js";
import {
  getGatewayDb,
  initGatewayDb,
  resetGatewayDb,
} from "../../db/connection.js";
import { inboundSeenEvents } from "../../db/schema.js";
import type {
  HandleInboundOptions,
  InboundResult,
} from "../../handlers/handle-inbound.js";
import type { GatewayInboundEvent } from "../../types.js";
import { createLinqIngress, reachedAnOutcome } from "./ingress.js";
import type { LinqInbound } from "./normalize.js";

const RAMON = "+12025559876";
const config = {
  gatewayInternalBaseUrl: "http://gateway.test",
} as GatewayConfig;
const log = pino({ level: "silent" });

function inbound(overrides?: Partial<LinqInbound>): LinqInbound {
  return {
    messageId: "msg-1",
    chatId: "chat-1",
    isGroup: false,
    isFromMe: false,
    handle: RAMON,
    service: "iMessage",
    parts: [{ type: "text", value: "hi juno" }],
    sentAt: "2026-11-12T05:58:04.513Z",
    raw: {},
    ...overrides,
  };
}

function harness(
  result: InboundResult | Error = { forwarded: true, rejected: false },
) {
  const calls: {
    event: GatewayInboundEvent;
    options?: HandleInboundOptions;
  }[] = [];
  let next = result;
  const ingress = createLinqIngress({
    config,
    log,
    queue: createConversationTaskQueue(),
    notifyRecordActivity: () => {},
    deliver: async (_config, event, options) => {
      calls.push({ event, options });
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return {
    ingress,
    calls,
    setResult: (r: InboundResult | Error) => {
      next = r;
    },
  };
}

beforeAll(async () => {
  resetGatewayDb();
  await initGatewayDb();
});

afterAll(() => {
  resetGatewayDb();
});

beforeEach(() => {
  getGatewayDb().delete(inboundSeenEvents).run();
});

describe("Linq ingress", () => {
  it("hands an iMessage to the gateway pipeline with the iMessage reply route", async () => {
    const h = harness();
    expect(await h.ingress(inbound())).toBe("handled");

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.event.message.content).toBe("hi juno");
    expect(h.calls[0]!.options).toEqual({
      replyCallbackUrl: "http://gateway.test/deliver/imessage",
    });
  });

  it("marks a message that fell back to SMS as an unauthenticated sender", async () => {
    const h = harness();
    await h.ingress(inbound({ service: "SMS" }));
    expect(h.calls[0]!.options?.senderAuthenticated).toBe(false);
  });

  it("hands the same Linq message over once, however many paths find it", async () => {
    const h = harness();
    expect(await h.ingress(inbound())).toBe("handled");
    expect(await h.ingress(inbound())).toBe("handled");
    expect(h.calls).toHaveLength(1);
  });

  it("asks for a retry, and allows one, when the runtime forward failed", async () => {
    const h = harness({ forwarded: false, rejected: false });
    expect(await h.ingress(inbound())).toBe("retry");

    h.setResult({ forwarded: true, rejected: false });
    expect(await h.ingress(inbound())).toBe("handled");
    expect(h.calls).toHaveLength(2);
  });

  it("asks for a retry when the pipeline throws", async () => {
    const h = harness(new Error("circuit open"));
    expect(await h.ingress(inbound())).toBe("retry");
  });

  it("treats a refusal as final", async () => {
    const h = harness({
      forwarded: false,
      rejected: true,
      rejectionReason: "x",
    });
    expect(await h.ingress(inbound())).toBe("handled");
    expect(await h.ingress(inbound())).toBe("handled");
    expect(h.calls).toHaveLength(1);
  });

  it("drops our own echoes and group chats without touching the pipeline", async () => {
    const h = harness();
    expect(await h.ingress(inbound({ isFromMe: true }))).toBe("handled");
    expect(await h.ingress(inbound({ messageId: "g", isGroup: true }))).toBe(
      "handled",
    );
    expect(h.calls).toHaveLength(0);
  });
});

describe("reachedAnOutcome", () => {
  it("reads a quiet forward failure as no outcome and everything else as one", () => {
    expect(reachedAnOutcome({ forwarded: false, rejected: false })).toBe(false);
    expect(reachedAnOutcome({ forwarded: true, rejected: false })).toBe(true);
    expect(reachedAnOutcome({ forwarded: false, rejected: true })).toBe(true);
    expect(
      reachedAnOutcome({
        forwarded: false,
        rejected: false,
        verificationIntercepted: true,
      }),
    ).toBe(true);
    expect(
      reachedAnOutcome({
        forwarded: false,
        rejected: false,
        inviteIntercepted: true,
      }),
    ).toBe(true);
  });
});
