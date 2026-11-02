import { z } from "zod";

import { formatToolInputError } from "../shared/zod-tool-schema.js";
import type { OwnerInfo } from "../types.js";

/** Bound compatibility decoding; normal typed arrays need no JSON decoding. */
export const MAX_ENCODED_CREDENTIAL_LIST_CHARS = 64 * 1024;

/**
 * Model-input schema, the single source for both runtime validation (via
 * `TOOL_INPUT_SCHEMAS`) and the tool's advertised `input_schema`. Credential
 * references accept one bounded JSON-array decoding, then validate strictly:
 * invalid supplied credentials must never become an unauthenticated command.
 * Other optional fields retain their existing fallback behavior: timeout to
 * the configured default, network mode to "off", background to foreground,
 * and activity is status-only. No new coercion is added to those fields.
 */
export const shellInputSchema = z.looseObject({
  command: z.string().min(1).describe("The shell command to execute"),
  activity: z
    .string()
    .describe(
      'Brief non-technical explanation of what this command does and why, shown to a non-technical user in the permission prompt. Avoid jargon and technical terms. Good: "to check if a required program is installed on your computer". Bad: "to check if gcloud CLI is installed". Good: "to download a helper program". Bad: "to run npm install".',
    )
    .optional()
    .catch(undefined),
  timeout_seconds: z
    .number()
    .describe(
      "Optional timeout in seconds. Defaults to the configured default (120s). Cannot exceed the configured maximum.",
    )
    .optional()
    .catch(undefined),
  network_mode: z
    .enum(["off", "proxied"])
    .describe(
      'Network access mode for the command. "off" (default) blocks network access; "proxied" routes traffic through the credential proxy.',
    )
    .optional()
    .catch(undefined),
  credential_ids: z
    .preprocess(
      (value) => {
        // One explicitly supported representation, not recursive coercion.
        // Returning an invalid value lets the strict inner schema reject it.
        if (
          typeof value !== "string" ||
          value.length > MAX_ENCODED_CREDENTIAL_LIST_CHARS
        ) {
          return value;
        }
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      },
      z.array(z.string().min(1)).optional(),
    )
    .describe(
      'Optional list of credential IDs to inject via the proxy when network_mode is "proxied".',
    ),
  background: z
    .boolean()
    .describe(
      "Run the command in the background. The tool returns immediately with a background tool ID. When the process exits, its output is delivered to the conversation as a wake.",
    )
    .optional()
    .catch(undefined),
});

/**
 * Canonicalize built-in bash BEFORE risk classification or approval identity.
 * Shared by execution, direct gate callers and grant producers/consumers.
 * Extension overrides retain their own contract. No mutation of raw/native
 * tool history, credential lookup, permission check or other side effect.
 */
export function prepareBuiltinShellInput(
  name: string,
  input: Record<string, unknown>,
  owner: Pick<OwnerInfo, "kind"> | undefined,
):
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; message: string } {
  if (name !== "bash" || owner?.kind !== "default") {
    return { ok: true, data: input };
  }
  const parsed = shellInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: `${formatToolInputError(name, parsed.error)} No command was executed.`,
    };
  }
  return { ok: true, data: parsed.data };
}
