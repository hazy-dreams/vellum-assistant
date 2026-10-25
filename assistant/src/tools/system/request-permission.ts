import { z } from "zod";

import { RiskLevel } from "../../permissions/types.js";
import { askQuestionTool } from "../ask-question/ask-question-tool.js";
import {
  invalidToolInputResult,
  toToolInputSchema,
} from "../shared/zod-tool-schema.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

const PERMISSION_TYPES = [
  "full_disk_access",
  "accessibility",
  "screen_recording",
  "calendar",
  "contacts",
  "photos",
  "location",
  "microphone",
  "camera",
] as const;

type PermissionType = (typeof PERMISSION_TYPES)[number];

const MACOS_SETTINGS_URLS: Record<PermissionType, string> = {
  full_disk_access:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen_recording:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  calendar:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
  contacts:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts",
  photos:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Photos",
  location:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices",
  microphone:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  camera:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
};

// Only the pages the Windows desktop client can route through its
// permissions bridge; other kinds have no in-app remediation there yet.
const WINDOWS_SETTINGS_URLS: Partial<Record<PermissionType, string>> = {
  screen_recording: "ms-settings:privacy-graphicscaptureprogrammatic",
  microphone: "ms-settings:privacy-microphone",
};

export const resolveSystemPermissionSettingsUrl = (
  permType: PermissionType,
  clientOs: string | undefined,
): string | undefined => {
  if (clientOs === "windows") {
    return WINDOWS_SETTINGS_URLS[permType];
  }
  // Preserve the historical absent-OS macOS default, but do not offer macOS
  // remediation for a client explicitly reporting an unsupported platform.
  return clientOs === undefined || clientOs === "macos"
    ? MACOS_SETTINGS_URLS[permType]
    : undefined;
};

const FRIENDLY_NAMES: Record<PermissionType, string> = {
  full_disk_access: "Full Disk Access",
  accessibility: "Accessibility",
  screen_recording: "Screen Recording",
  calendar: "Calendar",
  contacts: "Contacts",
  photos: "Photos",
  location: "Location Services",
  microphone: "Microphone",
  camera: "Camera",
};

/**
 * Model-input schema, the single source for both runtime validation (via
 * `TOOL_INPUT_SCHEMAS`) and the advertised `input_schema` below. `activity`
 * is advertised-required to guide the model and is shown in the question
 * description when present, but stays runtime-optional via
 * `advertiseRequired`.
 */
export const requestSystemPermissionInputSchema = z.looseObject({
  permission_type: z
    .enum(PERMISSION_TYPES)
    .describe("The system permission (macOS or Windows) to request"),
  activity: z
    .string()
    .describe(
      "Short explanation of why this permission is needed (shown in the prompt)",
    )
    .optional()
    .catch(undefined),
});

export const requestSystemPermissionTool = {
  name: "request_system_permission",
  description:
    "Request a system permission via macOS System Settings or Windows Settings. " +
    "Use when a tool fails with a permission/access error (e.g. 'Operation not permitted', 'EACCES', sandbox denial). " +
    "Shows a question with the Settings location and waits for the user's response. " +
    "The user must open Settings and grant the permission themselves; this tool does not open Settings or grant permissions. " +
    "After Done, retry the original operation to verify access.",
  category: "system",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.High,

  input_schema: toToolInputSchema(requestSystemPermissionInputSchema, {
    advertiseRequired: ["activity"],
  }),

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const parsed = requestSystemPermissionInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidToolInputResult("request_system_permission", parsed.error);
    }
    const permType = parsed.data.permission_type;

    const friendly = FRIENDLY_NAMES[permType];
    const settingsUrl = resolveSystemPermissionSettingsUrl(
      permType,
      context.clientOs,
    );
    if (!settingsUrl) {
      return {
        content: `${friendly} cannot be requested in-app on ${context.clientOs}. No permission request was delivered. Ask the user to check the matching privacy settings on a supported macOS or Windows client; access remains unverified.`,
        isError: true,
      };
    }

    const verification =
      `${friendly} access is not verified. This tool does not open Settings or grant OS permissions. ` +
      "After the user reports completing the change, retry the original operation to verify access; a Done response alone is not proof of an OS grant.";
    // Match ask_question's non-owner background backstop, but never interpret
    // its reasonable-defaults fallback as consent to an OS permission change.
    if (context.isInteractive === false && context.trustClass !== "guardian") {
      return {
        content: `No permission request was delivered: no interactive owner is available on this turn. ${verification}`,
        isError: true,
      };
    }

    // Legacy native-macOS transport has no question_request renderer. A Mac
    // using the web/Electron renderer does, so use interface, not host OS.
    if (context.transportInterface === "macos") {
      return {
        content: `This native client cannot display this question. Ask the user to open System Settings > Privacy & Security > ${friendly}, or continue in the web app for the request card. Settings URI: ${settingsUrl}. No request card was delivered. ${verification}`,
        isError: true,
      };
    }

    const settingsLocation =
      context.clientOs === "windows"
        ? `Windows Settings > Privacy & security > ${friendly}`
        : `System Settings > Privacy & Security > ${friendly}`;
    // Delegate even when risk policy already auto-approved this tool call:
    // risk approval is not a human response or an OS grant. Passing the exact
    // context keeps pending/answered cards attached to the OUTER toolUseId.
    const questionResult = await askQuestionTool.execute(
      {
        questions: [
          {
            question: `Please grant ${friendly} in Settings, then choose Done.`,
            description: [
              parsed.data.activity,
              `Open ${settingsLocation} and enable access for the app that needs it.`,
              `Settings URI (open it yourself): ${settingsUrl}`,
              "Choose Not now if you do not want to change this permission, or describe what happened. Settings will not open automatically.",
            ]
              .filter(Boolean)
              .join("\n"),
            options: [
              { id: "done", label: "Done" },
              { id: "not_now", label: "Not now" },
            ],
          },
        ],
      },
      context,
    );

    const answer = questionResult.answeredQuestion;
    if (!answer) {
      // A text-channel fallback is an instruction to relay a question, not
      // evidence it was delivered. Abort/timeout similarly mean no response,
      // never a denial. Preserve the underlying diagnostic/fallback verbatim.
      return {
        ...questionResult,
        content: [
          questionResult.isError
            ? "No user response was recorded for this permission request."
            : "No permission request was delivered by this tool; the question must be relayed using the channel fallback below.",
          questionResult.content,
          verification,
        ].join("\n"),
        isError: true,
      };
    }

    const response = answer.responses[0];
    const hasUsableResponse =
      answer.overall === "completed" &&
      (response?.decision === "free_text" ||
        (response?.decision === "option" && response.optionId === "done"));
    return {
      ...questionResult,
      content: [questionResult.content, verification].join("\n"),
      // This describes whether a usable human response was recorded, NOT
      // whether the OS granted access. Skipping/closing is merely unresolved.
      isError: questionResult.isError || !hasUsableResponse,
    };
  },
} satisfies ToolDefinition;
