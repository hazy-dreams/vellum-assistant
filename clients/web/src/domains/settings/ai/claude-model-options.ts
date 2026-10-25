import type { InferenceModelsDiscoverPostResponse } from "@/generated/daemon/types.gen";

export type ClaudeDiscoveredModel =
  InferenceModelsDiscoverPostResponse["models"][number];
export type ClaudeModelOption = Pick<
  ClaudeDiscoveredModel,
  "id" | "displayName"
>;

/** A saved selection survives login failures and changes to the discovered list. */
export function claudeModelOptions(
  models: readonly ClaudeModelOption[],
  selected?: ClaudeModelOption,
): readonly ClaudeModelOption[] {
  if (!selected?.id || models.some((model) => model.id === selected.id)) {
    return models;
  }
  const displayName = models.some(
    (model) => model.displayName === selected.displayName,
  )
    ? selected.id
    : selected.displayName;
  return [...models, { ...selected, displayName }];
}

export function claudeModelEffortLevels(
  model: ClaudeDiscoveredModel | undefined,
) {
  return model?.supportsEffort === true
    ? (model.supportedEffortLevels ?? [])
    : [];
}

export function findClaudeModel(
  models: readonly ClaudeDiscoveredModel[],
  id: string,
): ClaudeDiscoveredModel | undefined {
  return (
    models.find((model) => model.id === id) ??
    models.find((model) => model.resolvedModel === id)
  );
}
