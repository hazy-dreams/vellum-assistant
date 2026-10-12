import { SEND_USER_MESSAGE_TOOL_NAME } from "../config/send-user-message-constants.js";

/**
 * The user-facing message a `send_user_message` block carries, or null when
 * the block is not one or carries nothing usable.
 *
 * One predicate for the two readers that must agree: what gets streamed to the
 * user, and what counts as having told them the outcome. A call whose
 * `message` is blank or not a string is rejected by the executor and streams
 * nothing, so counting it as delivery would suppress the raw-text fallback on
 * a later turn and leave the user with no reply at all.
 */
export function deliveredUserMessage(block: {
  type: string;
  name?: string;
  input?: Record<string, unknown>;
}): string | null {
  if (block.type !== "tool_use" || block.name !== SEND_USER_MESSAGE_TOOL_NAME) {
    return null;
  }
  const message = block.input?.["message"];
  return typeof message === "string" && message.trim().length > 0
    ? message
    : null;
}

/**
 * Whether a response reported the OUTCOME of the work before it: it called
 * tools, and every one of them delivered a message to the user.
 *
 * `undefined` when the response called no tools, which is the terminal one and
 * leaves the answer where the last tool-bearing response left it.
 *
 * One rule, read by the loop's own fallback decision and handed to the
 * `post-model-call` hook chain on the context, so the plugin that owns the
 * nudge cannot reach a different answer than the loop that owns the fallback.
 * A plugin cannot import this (plugins are self-contained), so the host
 * computes it and passes the answer.
 */
export function reportsOutcomeToUser(
  toolUseBlocks: ReadonlyArray<{
    type: string;
    name?: string;
    input?: Record<string, unknown>;
  }>,
): boolean | undefined {
  if (toolUseBlocks.length === 0) {
    return undefined;
  }
  return toolUseBlocks.every((block) => deliveredUserMessage(block) !== null);
}
