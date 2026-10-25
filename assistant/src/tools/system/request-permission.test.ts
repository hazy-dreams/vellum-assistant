import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";
import type { QuestionRequestEvent } from "../../api/events/question-request.js";
import {
  buildBatchEntries,
  type QuestionBatchSubmission,
} from "../../permissions/question-prompter.js";
import * as pendingInteractions from "../../runtime/pending-interactions.js";
import type { ToolContext } from "../types.js";

// Exercise the real QuestionPrompter and registry. Only event transport and
// guardian-request promotion are isolated: these tests simulate user answers,
// not an actual connected client, OS settings change, or delivery receipt.
const realEventHub = await import("../../runtime/assistant-event-hub.js");
const questionEvents: QuestionRequestEvent[] = [];
mock.module("../../runtime/assistant-event-hub.js", () => ({
  ...realEventHub,
  broadcastMessage: (event: { type: string }) => {
    if (event.type === "question_request") {
      questionEvents.push(event as QuestionRequestEvent);
    }
  },
}));
mock.module("../../permissions/question-guardian-request.js", () => ({
  createGuardianRequestForQuestion: async () => {},
  settlePromotedQuestionRequest: () => {},
}));

const { requestSystemPermissionTool, resolveSystemPermissionSettingsUrl } =
  await import("./request-permission.js");

const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  conversationId: "system-permission-lifecycle",
  workingDir: "/tmp",
  toolUseId: "outer-system-permission-call",
  trustClass: "guardian",
  clientOs: "macos",
  supportsDynamicUi: true,
  ...overrides,
});

beforeEach(() => {
  questionEvents.length = 0;
  setConfig("timeouts", { questionResponseTimeoutSec: 0.1 });
});

afterEach(() => {
  for (const entry of pendingInteractions.getByConversation(
    context().conversationId,
  )) {
    entry.rpcResolve?.({ entries: [], overall: "aborted" });
  }
});

function expectPending() {
  expect(questionEvents).toHaveLength(1);
  const event = questionEvents[0]!;
  const pending = pendingInteractions.get(event.requestId);
  expect(pending?.kind).toBe("question");
  expect(pending?.conversationId).toBe(context().conversationId);
  expect(event.toolUseId).toBe("outer-system-permission-call");
  expect(pending?.toolUseId).toBe(event.toolUseId);
  // Reconnect/history can rehydrate the card on the OUTER permission call.
  expect(pending?.questionDetails?.entries).toEqual(event.questions);
  return event;
}

function submit(
  event: QuestionRequestEvent,
  submission: QuestionBatchSubmission,
) {
  const pending = pendingInteractions.get(event.requestId)!;
  const ids = event.questions.map((q) => q.id);
  const entries = buildBatchEntries(
    ids,
    (qid, oid) =>
      event.questions
        .find((q) => q.id === qid)!
        .options.some((o) => o.id === oid),
    new Set(ids),
    [submission],
  );
  pendingInteractions.resolve(event.requestId, "answered");
  pending.rpcResolve?.({ entries, overall: "completed" });
}

const outcomes = [
  "done",
  "not_now",
  "skipped",
  "free_text",
  "closed",
  "aborted",
  "timed_out",
] as const;

describe.each([false, true])(
  "request_system_permission real lifecycle (interactive=%s)",
  (isInteractive) => {
    test.each([...outcomes])(
      "waits for %s without inferring an OS grant",
      async (outcome) => {
        const ac = new AbortController();
        const ctx = context({ isInteractive, signal: ac.signal });
        let settled = false;
        const promise = requestSystemPermissionTool
          .execute(
            { permission_type: "camera", activity: "Join the video call" },
            ctx,
          )
          .then((result) => {
            settled = true;
            return result;
          });
        const event = expectPending();
        await Bun.sleep(1);
        expect(settled).toBe(false);
        expect(ctx.isInteractive).toBe(isInteractive);
        expect(event.questions[0]?.question).toContain("Camera");
        expect(event.questions[0]?.description).toContain(
          "Join the video call",
        );
        expect(event.questions[0]?.description).toContain(
          "System Settings > Privacy & Security > Camera",
        );
        expect(event.questions[0]?.description).toContain(
          "x-apple.systempreferences",
        );
        expect(event.questions[0]?.options).toEqual([
          { id: "done", label: "Done" },
          { id: "not_now", label: "Not now" },
        ]);

        if (outcome === "done" || outcome === "not_now") {
          submit(event, {
            questionId: "q1",
            kind: "option",
            optionId: outcome,
          });
        } else if (outcome === "free_text") {
          submit(event, {
            questionId: "q1",
            kind: "free_text",
            text: "It is already enabled, but the call still fails",
          });
        } else if (outcome === "skipped") {
          submit(event, { questionId: "q1", kind: "skip" });
        } else if (outcome === "closed") {
          pendingInteractions.get(event.requestId)!.rpcResolve?.({
            entries: [{ questionId: "q1", decision: "skipped" }],
            overall: "closed",
          });
        } else if (outcome === "aborted") {
          ac.abort();
        }
        const result = await promise;
        expect(pendingInteractions.get(event.requestId)).toBeUndefined();
        expect(ctx.isInteractive).toBe(isInteractive);
        expect(result.content).toContain("not verified");
        expect(result.content).toContain("retry the original operation");
        expect(result.content).not.toContain("The user has been asked");

        if (outcome === "timed_out" || outcome === "aborted") {
          expect(result.isError).toBe(true);
          expect(result.answeredQuestion).toBeUndefined();
          expect(result.content).toContain(
            outcome === "timed_out" ? "timeout" : "aborted",
          );
        } else {
          expect(result.answeredQuestion?.requestId).toBe(event.requestId);
          expect(result.answeredQuestion?.questions).toEqual(event.questions);
          expect(result.answeredQuestion?.overall).toBe(
            outcome === "closed" ? "closed" : "completed",
          );
          expect(result.isError).toBe(
            outcome !== "done" && outcome !== "free_text",
          );
          if (outcome === "done" || outcome === "not_now") {
            expect(result.answeredQuestion?.responses).toEqual([
              { questionId: "q1", decision: "option", optionId: outcome },
            ]);
            expect(result.content).toContain(
              outcome === "done" ? "Done" : "Not now",
            );
          } else if (outcome === "free_text") {
            expect(result.answeredQuestion?.responses[0]?.text).toBe(
              "It is already enabled, but the call still fails",
            );
            expect(result.content).toContain(
              "It is already enabled, but the call still fails",
            );
          } else {
            expect(result.answeredQuestion?.responses).toEqual([
              { questionId: "q1", decision: "skipped" },
            ]);
            expect(result.content.toLowerCase()).toContain(
              outcome === "closed" ? "closed" : "skipped",
            );
          }
        }
      },
    );
  },
);

describe("request_system_permission platform and fallback gates", () => {
  test.each([
    undefined,
    "unknown",
    "trusted_contact",
    "unverified_contact",
  ] as const)(
    "unknown/non-owner background %s does not claim delivery",
    async (trustClass) => {
      const result = await requestSystemPermissionTool.execute(
        { permission_type: "microphone" },
        context({ isInteractive: false, trustClass }),
      );
      expect(result.isError).toBe(true);
      expect(result.answeredQuestion).toBeUndefined();
      expect(result.content).toContain("No permission request was delivered");
      expect(result.content).not.toContain("reasonable defaults");
      expect(questionEvents).toHaveLength(0);
      expect(
        pendingInteractions.getByConversation(context().conversationId),
      ).toHaveLength(0);
    },
  );

  test("unsupported channel returns a truthful text fallback, not success/delivery", async () => {
    const result = await requestSystemPermissionTool.execute(
      { permission_type: "full_disk_access" },
      context({
        isInteractive: false,
        supportsDynamicUi: false,
        supportsGuardianQuestionCards: false,
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.answeredQuestion).toBeUndefined();
    expect(result.content).toContain("No permission request was delivered");
    expect(result.content).toContain(
      "Present this question to the user as a plain-text message",
    );
    expect(result.content).toContain("Full Disk Access");
    expect(questionEvents).toHaveLength(0);
  });

  test.each([true, false])(
    "legacy native macOS interface gets truthful fallback without an unsupported question (interactive=%s)",
    async (isInteractive) => {
      const result = await requestSystemPermissionTool.execute(
        { permission_type: "full_disk_access" },
        context({
          isInteractive,
          transportInterface: "macos",
          supportsDynamicUi: true,
        }),
      );
      expect(result.isError).toBe(true);
      expect(result.answeredQuestion).toBeUndefined();
      expect(result.content).toContain("cannot display this question");
      expect(result.content).toContain("Full Disk Access");
      expect(result.content).toContain("not verified");
      expect(questionEvents).toHaveLength(0);
    },
  );

  test("card-capable background channel still waits for the human", async () => {
    const promise = requestSystemPermissionTool.execute(
      { permission_type: "microphone" },
      context({
        isInteractive: false,
        supportsDynamicUi: false,
        supportsGuardianQuestionCards: true,
      }),
    );
    const event = expectPending();
    submit(event, { questionId: "q1", kind: "option", optionId: "not_now" });
    expect((await promise).isError).toBe(true);
  });

  test.each(["microphone", "screen_recording"])(
    "supported Windows %s prompts with Windows guidance",
    async (permission_type) => {
      const promise = requestSystemPermissionTool.execute(
        { permission_type },
        context({ clientOs: "windows" }),
      );
      const event = expectPending();
      expect(event.description).toContain(
        "Windows Settings > Privacy & security",
      );
      expect(event.description).toContain("ms-settings:");
      expect(event.description).not.toContain("x-apple");
      submit(event, { questionId: "q1", kind: "option", optionId: "done" });
      expect((await promise).content).toContain("not verified");
    },
  );

  test.each([
    "camera",
    "full_disk_access",
    "accessibility",
    "calendar",
    "contacts",
    "photos",
    "location",
  ])(
    "unsupported Windows %s creates no pending request",
    async (permission_type) => {
      const result = await requestSystemPermissionTool.execute(
        { permission_type },
        context({ clientOs: "windows" }),
      );
      expect(result.isError).toBe(true);
      expect(questionEvents).toHaveLength(0);
      expect(
        pendingInteractions.getByConversation(context().conversationId),
      ).toHaveLength(0);
    },
  );

  test.each(["linux", "ios", "android", "web"] as const)(
    "unsupported OS %s creates no pending request",
    async (clientOs) => {
      const result = await requestSystemPermissionTool.execute(
        { permission_type: "camera" },
        context({ clientOs }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("cannot be requested");
      expect(questionEvents).toHaveLength(0);
      expect(
        pendingInteractions.getByConversation(context().conversationId),
      ).toHaveLength(0);
    },
  );

  test("invalid input creates no pending request", async () => {
    const result = await requestSystemPermissionTool.execute(
      { permission_type: "sudo" },
      context(),
    );
    expect(result.isError).toBe(true);
    expect(questionEvents).toHaveLength(0);
  });

  test("already-aborted request creates no pending prompt and is not success", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await requestSystemPermissionTool.execute(
      { permission_type: "camera" },
      context({ signal: ac.signal }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("aborted");
    expect(result.content).toContain("not verified");
    expect(questionEvents).toHaveLength(0);
  });

  test("preserves the historical absent-OS macOS URL default", () => {
    expect(resolveSystemPermissionSettingsUrl("camera", undefined)).toContain(
      "x-apple.systempreferences",
    );
    expect(resolveSystemPermissionSettingsUrl("microphone", "windows")).toBe(
      "ms-settings:privacy-microphone",
    );
    expect(
      resolveSystemPermissionSettingsUrl("camera", "windows"),
    ).toBeUndefined();
  });

  test("does not advertise automatic Settings opening or change the model-input contract", () => {
    expect(requestSystemPermissionTool.description).not.toContain(
      "clickable button",
    );
    expect(requestSystemPermissionTool.input_schema).toMatchObject({
      required: ["permission_type", "activity"],
    });
  });
});
