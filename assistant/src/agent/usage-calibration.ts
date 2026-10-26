import { recordEstimate } from "../context/estimator-calibration.js";
import { getCalibrationProviderKey } from "../context/token-estimator.js";
import type { Provider } from "../providers/types.js";
import type { AgentEvent } from "./loop.js";

/** Pair one prompt's raw estimate with its cache-inclusive input usage. */
export function recordUsageEstimate(
  provider: Provider,
  event: Extract<AgentEvent, { type: "usage" }>,
): void {
  if (
    event.estimatedInputTokens === undefined ||
    event.estimatedInputTokens <= 0 ||
    (event.llmCallCount ?? 1) !== 1
  ) {
    return;
  }
  const key =
    getCalibrationProviderKey(provider) || (event.actualProvider ?? "");
  if (key.length > 0) {
    recordEstimate(
      key,
      event.model,
      event.estimatedInputTokens,
      event.inputTokens,
    );
  }
}
