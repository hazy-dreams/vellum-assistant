/** Owner background policy parity, using the real confirmation lifecycle.
 * Policy/classification and guardian delivery are isolated; no tool executes.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { RiskLevel } from "../permissions/types.js";
import type { Tool, ToolContext } from "../tools/types.js";
import {
  installThresholdReaderMock,
  resetThresholdReaderMock,
  thresholdReaderMock,
} from "./gateway-threshold-reader-mock.js";
import { setConfig } from "./helpers/set-config.js";

let dynamicSkillLoad = false;
let checkDecision: "allow" | "prompt" | "deny" | undefined;
let classifiedRisk = RiskLevel.High;
let matchType = "registry";
const policyContexts: unknown[] = [];
const outcomes: string[] = [];
const promotions: unknown[] = [];

mock.module("../permissions/checker.js", () => ({
  isDynamicSkillLoadInvocation: () => dynamicSkillLoad,
  classifyRisk: async () => ({
    level: classifiedRisk,
    reason: "test risk",
    scopeOptions: [],
    matchType,
  }),
  check: async (
    _name: string,
    _input: unknown,
    _dir: string,
    context: unknown,
  ) => {
    policyContexts.push(context);
    const ordinal: Record<string, number> = {
      none: -1,
      low: 0,
      medium: 1,
      high: 2,
    };
    return {
      decision:
        checkDecision ??
        (ordinal[classifiedRisk] <=
        ordinal[thresholdReaderMock.threshold ?? "low"]
          ? "allow"
          : "prompt"),
      reason: "policy verdict",
    };
  },
  generateScopeOptions: () => [],
}));
mock.module("../telemetry/tool-audit.js", () => ({
  recordToolDenied: () => {},
  recordToolPermissionPrompted: () => {},
  recordToolPermissionDecided: (_entry: unknown, outcome: string) =>
    outcomes.push(outcome),
}));
// Delivery is outside this focused test; the real prompter still registers,
// sends, waits, resolves, cancels and times out genuine confirmation requests.
mock.module("../permissions/confirmation-guardian-request.js", () => ({
  createGuardianRequestForConfirmation: async (...args: unknown[]) => {
    promotions.push(args);
  },
}));
mock.module("../tools/registry.js", () => ({ getToolOwner: () => undefined }));
installThresholdReaderMock();

import type { AssistantEvent } from "../api/index.js";
import { PermissionPrompter } from "../permissions/prompter.js";
import { PermissionChecker } from "../tools/permission-checker.js";

const tool: Tool = {
  name: "skill_load",
  description: "test",
  category: "skills",
  defaultRiskLevel: RiskLevel.High,
  executionTarget: "sandbox",
  input_schema: {},
  execute: async () => {
    throw new Error("checker must not execute tools");
  },
};
const prompters: PermissionPrompter[] = [];
function harness(overrides: Partial<ToolContext> = {}, name = "skill_load") {
  const context: ToolContext = {
    workingDir: "/tmp/project",
    conversationId: "parity-conversation",
    trustClass: "guardian",
    isInteractive: false,
    ...overrides,
  };
  const events: AssistantEvent[] = [];
  const prompter = new PermissionPrompter((event) => events.push(event));
  prompters.push(prompter);
  const checker = new PermissionChecker(prompter);
  let settled = false;
  const result = checker
    .checkPermission(
      name,
      { skill: "test-skill" },
      { ...tool, name },
      context,
      Date.now(),
      async () => undefined,
    )
    .then((decision) => {
      settled = true;
      return decision;
    });
  return { context, events, prompter, result, isSettled: () => settled };
}
async function waitForCheck() {
  // The checker/prompter chain uses only in-memory awaits in this fixture.
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}
function request(h: ReturnType<typeof harness>) {
  const event = h.events.find((event) => event.type === "confirmation_request");
  expect(event?.type).toBe("confirmation_request");
  if (!event || event.type !== "confirmation_request") {
    throw new Error("no real confirmation request");
  }
  return event;
}

beforeEach(() => {
  dynamicSkillLoad = false;
  checkDecision = undefined;
  classifiedRisk = RiskLevel.High;
  matchType = "registry";
  policyContexts.length = outcomes.length = promotions.length = 0;
  resetThresholdReaderMock();
  thresholdReaderMock.threshold = "medium";
  setConfig("timeouts", { permissionTimeoutSec: 60 });
});
afterEach(() => {
  for (const prompter of prompters.splice(0)) {
    prompter.denyAllPending();
  }
});
afterAll(() => mock.restore());

describe("owner policy independent of presence", () => {
  for (const isInteractive of [true, false]) {
    for (const dynamic of [false, true]) {
      for (const threshold of ["medium", "high"] as const) {
        test(`interactive=${isInteractive}, dynamic=${dynamic}, threshold=${threshold}`, async () => {
          dynamicSkillLoad = dynamic;
          thresholdReaderMock.threshold = threshold;
          const h = harness({ isInteractive });
          await waitForCheck();
          if (threshold === "medium") {
            const event = request(h);
            expect(h.isSettled()).toBe(false);
            expect(h.prompter.hasPendingRequest(event.requestId)).toBe(true);
            h.prompter.resolveConfirmation(event.requestId, "allow");
          } else {
            expect(h.events).toHaveLength(0);
          }
          const decision = await h.result;
          expect(decision.allowed).toBe(true);
          expect(decision.decision).toBe("allow");
          expect(decision.allowed && decision.wasPrompted).toBe(
            threshold === "medium" ? true : undefined,
          );
          expect(h.context.isInteractive).toBe(isInteractive);
          expect(policyContexts[0]).toMatchObject({
            executionContext: isInteractive ? "conversation" : "background",
            trustClass: "guardian",
          });
          expect(thresholdReaderMock.thresholdReads).toHaveLength(1);
        });
      }
    }
  }

  test("a prompt verdict is never overridden by a second, looser background threshold", async () => {
    checkDecision = "prompt";
    thresholdReaderMock.threshold = "high";
    const h = harness();
    await waitForCheck();
    const event = request(h);
    expect(h.isSettled()).toBe(false);
    h.prompter.resolveConfirmation(event.requestId, "deny");
    expect((await h.result).allowed).toBe(false);
    expect(outcomes).toEqual(["deny"]);
  });

  test("channel coordinates and original execution context are retained", async () => {
    const h = harness({
      executionChannel: "slack",
      channelPermissionChannelId: "C123",
      channelConversationType: "dm",
    });
    await waitForCheck();
    const event = request(h);
    h.prompter.resolveConfirmation(event.requestId, "allow");
    await h.result;
    expect(thresholdReaderMock.thresholdReads[0]).toMatchObject({
      executionContext: "background",
      cellQuery: {
        adapter: "slack",
        channelExternalId: "C123",
        contactType: "guardian",
      },
    });
  });
});

describe("genuine background permission lifecycle", () => {
  test("approval waits for an actual response then cleans the pending request", async () => {
    const h = harness();
    await waitForCheck();
    const event = request(h);
    expect(h.isSettled()).toBe(false);
    expect(promotions).toHaveLength(1);
    h.prompter.resolveConfirmation(event.requestId, "allow");
    expect(await h.result).toMatchObject({
      allowed: true,
      wasPrompted: true,
      approvalMode: "prompted",
      approvalReason: "user_approved",
    });
    expect(h.prompter.hasPending).toBe(false);
    expect(outcomes).toEqual(["allow"]);
  });
  test("human denial is not auto-approved", async () => {
    const h = harness();
    await waitForCheck();
    h.prompter.resolveConfirmation(request(h).requestId, "deny");
    expect(await h.result).toMatchObject({
      allowed: false,
      decision: "deny",
      approvalReason: "user_denied",
    });
    expect(h.prompter.hasPending).toBe(false);
  });
  test("abort abandons and cleans a pending prompt", async () => {
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    await waitForCheck();
    request(h);
    controller.abort();
    expect(await h.result).toMatchObject({
      allowed: false,
      approvalReason: "system_cancelled",
    });
    expect(h.prompter.hasPending).toBe(false);
    expect(outcomes).toEqual(["abandoned"]);
  });
  test("pre-aborted prompts are never surfaced", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ signal: controller.signal });
    expect(await h.result).toMatchObject({
      allowed: false,
      approvalReason: "system_cancelled",
    });
    expect(h.events).toHaveLength(0);
    expect(outcomes).toHaveLength(0);
  });
  test("timeout abandons without inventing a human denial", async () => {
    setConfig("timeouts", { permissionTimeoutSec: 0.03 });
    const h = harness();
    const decision = await h.result;
    request(h);
    expect(decision).toMatchObject({
      allowed: false,
      approvalReason: "timed_out",
    });
    expect(h.prompter.hasPending).toBe(false);
    expect(outcomes).toEqual(["abandoned"]);
  });
  test("a superseding message cancels the genuine wait", async () => {
    const h = harness();
    await waitForCheck();
    request(h);
    h.prompter.denyAllPending();
    expect(await h.result).toMatchObject({
      allowed: false,
      approvalReason: "system_cancelled",
    });
    expect(outcomes).toEqual(["abandoned"]);
  });
});

describe("unchanged authority and review boundaries", () => {
  for (const trustClass of [
    "trusted_contact",
    "unverified_contact",
    "unknown",
    undefined,
  ] as const) {
    test(`non-owner ${trustClass} still denies headless prompts`, async () => {
      const h = harness({ trustClass });
      expect(await h.result).toMatchObject({
        allowed: false,
        decision: "denied",
      });
      expect(h.events).toHaveLength(0);
      expect(policyContexts[0]).toMatchObject({ executionContext: "headless" });
    });
  }
  test("headless uncovered dynamic load remains denied even if policy says allow", async () => {
    dynamicSkillLoad = true;
    checkDecision = "allow";
    const h = harness({ trustClass: "trusted_contact" });
    expect((await h.result).allowed).toBe(false);
    expect(h.events).toHaveLength(0);
  });
  test("a covering dynamic trust rule retains the allow verdict", async () => {
    dynamicSkillLoad = true;
    matchType = "user_rule";
    checkDecision = "allow";
    const h = harness();
    expect((await h.result).allowed).toBe(true);
    expect(h.events).toHaveLength(0);
  });
  for (const isInteractive of [true, false]) {
    test(`explicit deny survives every promotion (interactive=${isInteractive})`, async () => {
      checkDecision = "deny";
      dynamicSkillLoad = true;
      thresholdReaderMock.threshold = "high";
      const h = harness(
        {
          isInteractive,
          forcePromptSideEffects: true,
          requireFreshApproval: true,
          isPlatformHosted: true,
        },
        "bash",
      );
      expect(await h.result).toMatchObject({
        allowed: false,
        decision: "denied",
      });
      expect(h.events).toHaveLength(0);
    });
    test(`forced side-effect review cannot auto-approve (interactive=${isInteractive})`, async () => {
      checkDecision = "allow";
      thresholdReaderMock.threshold = "high";
      const h = harness(
        { isInteractive, forcePromptSideEffects: true },
        "bash",
      );
      await waitForCheck();
      h.prompter.resolveConfirmation(request(h).requestId, "deny");
      expect((await h.result).allowed).toBe(false);
    });
    test(`fresh review promotes allow below Full Access (interactive=${isInteractive})`, async () => {
      checkDecision = "allow";
      const h = harness({ isInteractive, requireFreshApproval: true });
      await waitForCheck();
      const event = request(h);
      expect(event.persistentDecisionsAllowed).toBe(false);
      h.prompter.resolveConfirmation(event.requestId, "allow");
      const decision = await h.result;
      expect(decision.allowed && decision.wasPrompted).toBe(true);
    });
    test(`Full Access keeps existing fresh-review exception (interactive=${isInteractive})`, async () => {
      checkDecision = "allow";
      thresholdReaderMock.threshold = "high";
      const h = harness({ isInteractive, requireFreshApproval: true });
      expect((await h.result).allowed).toBe(true);
      expect(h.events).toHaveLength(0);
    });
    test(`read-only policy allow remains unprompted (interactive=${isInteractive})`, async () => {
      classifiedRisk = RiskLevel.Low;
      const h = harness({ isInteractive }, "file_read");
      expect((await h.result).allowed).toBe(true);
      expect(h.events).toHaveLength(0);
    });
  }
});
