import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setConfig } from "./helpers/set-config.js";
import {
  installIpcMock,
  mockIpcResponse,
} from "./helpers/gateway-classify-mock.js";
import type { QuestionRequestEvent } from "../api/events/question-request.js";

installIpcMock();
const events: QuestionRequestEvent[] = [];
const hub = await import("../runtime/assistant-event-hub.js");
mock.module("../runtime/assistant-event-hub.js", () => ({
  ...hub,
  broadcastMessage: (event: { type: string }) => {
    if (event.type === "question_request")
      events.push(event as QuestionRequestEvent);
  },
}));
mock.module("../permissions/question-guardian-request.js", () => ({
  createGuardianRequestForQuestion: async () => {},
  settlePromotedQuestionRequest: () => {},
}));
const { ToolExecutor } = await import("../tools/executor.js");
const { PermissionPrompter } = await import("../permissions/prompter.js");
const { requestSystemPermissionTool } =
  await import("../tools/system/request-permission.js");
const { __clearRegistryForTesting, registerTool } =
  await import("../tools/registry.js");
const { _clearGlobalCacheForTesting } =
  await import("../permissions/gateway-threshold-reader.js");
const pending = await import("../runtime/pending-interactions.js");

const conversationId = "system-request-real-executor";
beforeEach(() => {
  events.length = 0;
  __clearRegistryForTesting();
  registerTool(requestSystemPermissionTool);
  _clearGlobalCacheForTesting();
  mockIpcResponse("classify_risk", {
    risk: "high",
    reason: "system permission",
    matchType: "registry",
    scopeOptions: [],
  });
  mockIpcResponse("get_global_thresholds", {
    interactive: "high",
    autonomous: "high",
    headless: "none",
  });
  mockIpcResponse("get_conversation_threshold", { threshold: null });
  setConfig("timeouts", {
    toolExecutionTimeoutSec: 0.02,
    questionResponseTimeoutSec: 0.15,
  });
});
afterEach(() => {
  for (const entry of pending.getByConversation(conversationId))
    entry.rpcResolve?.({ entries: [], overall: "aborted" });
  __clearRegistryForTesting();
});

describe("system-permission full executor human wait", () => {
  for (const isInteractive of [true, false]) {
    for (const outcome of ["timeout", "abort"] as const) {
      test(`${isInteractive ? "foreground" : "owner background"} ${outcome} settles the real pending question`, async () => {
        const controller = new AbortController();
        const policyEvents: unknown[] = [];
        const executor = new ToolExecutor(
          new PermissionPrompter((e) => policyEvents.push(e)),
        );
        let settled = false;
        const resultPromise = executor
          .execute(
            "request_system_permission",
            { permission_type: "microphone" },
            {
              conversationId,
              workingDir: process.env.VELLUM_WORKSPACE_DIR!,
              toolUseId: "outer-system-call",
              trustClass: "guardian",
              isInteractive,
              clientOs: "macos",
              transportInterface: "web",
              supportsDynamicUi: true,
              signal: controller.signal,
            },
          )
          .then((result) => {
            settled = true;
            return result;
          });
        for (let i = 0; events.length === 0 && !settled && i < 100; i++)
          await Bun.sleep(2);
        expect(events).toHaveLength(1);
        expect(pending.get(events[0]!.requestId)?.toolUseId).toBe(
          "outer-system-call",
        );
        await Bun.sleep(35); // Beyond the deliberately shorter generic tool budget.
        expect(settled).toBe(false);
        expect(policyEvents).toHaveLength(0); // Full Access does not fake the actual human question.
        if (outcome === "abort") controller.abort();
        const result = await resultPromise;
        expect(result.isError).toBe(true);
        expect(result.content).toContain(
          outcome === "abort"
            ? "aborted"
            : "User did not respond within timeout",
        );
        expect(result.content).not.toContain("may still be running");
        expect(result.answeredQuestion).toBeUndefined();
        expect(pending.getByConversation(conversationId)).toHaveLength(0);
      });
    }
  }
});
