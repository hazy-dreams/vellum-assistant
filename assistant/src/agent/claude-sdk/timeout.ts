/**
 * Configure Claude Code's own API-request and streaming-idle deadlines. These
 * belong to model requests, not the whole agent session or its MCP tool waits.
 * Claude Code clamps idle watchdogs independently (event: at least 5 minutes;
 * byte: 10 seconds to 30 minutes), so this is not a host-side turn deadline.
 * https://code.claude.com/docs/en/network-config#streaming-idle-watchdogs
 */
export function claudeSdkTimeoutEnvironment(
  timeoutMs: number,
): NodeJS.ProcessEnv {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Claude provider timeout must be a positive finite number");
  }
  // Avoid overflowing the native request timer. Never mutate process.env.
  const value = String(
    Math.min(2_147_483_647, Math.max(1, Math.round(timeoutMs))),
  );
  return {
    API_TIMEOUT_MS: value,
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: value,
    CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: value,
  };
}
