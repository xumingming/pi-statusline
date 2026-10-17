/**
 * pi-statusline — `/mp` companion model picker.
 *
 * The built-in `/model` selector renders hard-coded rows and cannot be
 * decorated, so this module registers a parallel `/mp` command: a
 * `ctx.ui.select()` dialog listing every available chat model as
 * `<id> [<provider>] (<cost multiple>)`, with the current model first.
 * Picking a row switches the session model via `pi.setModel()`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

import {
  findBaselineCost,
  modelCostRatio,
  readModelCostRates,
  type ModelCostRates,
} from "./blocks.ts";

/** One selectable row: a display label and the model it stands for. */
export interface ModelOption {
  /** `<id> [<provider>]` plus ` (<multiple>)` when the model is priced. */
  label: string;
  model: Model<Api>;
}

/**
 * Build the sorted option list. The current model leads (marked with
 * `* `), then rows sort by `provider/id`. Unpriced models list no
 * multiple; unpriced baseline models are `1x` like any other model.
 */
export function buildModelOptions(
  models: readonly Model<Api>[],
  baselineCost: ModelCostRates | null,
  current?: Model<Api>,
): ModelOption[] {
  const isCurrent = (m: Model<Api>) =>
    !!current && m.provider === current.provider && m.id === current.id;
  const sorted = [...models].sort((a, b) => {
    if (isCurrent(a) !== isCurrent(b)) return isCurrent(a) ? -1 : 1;
    return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
  });
  return sorted.map((model) => {
    const ratio = modelCostRatio(readModelCostRates(model.cost), baselineCost);
    const multiple = ratio ? ` (${ratio.label})` : "";
    const marker = isCurrent(model) ? "* " : "";
    return { label: `${marker}${model.id} [${model.provider}]${multiple}`, model };
  });
}

/** Case-insensitive substring filter over `provider/id` and the name. */
export function filterModelOptions(
  options: readonly ModelOption[],
  query: string,
): ModelOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  return options.filter(({ model }) =>
    `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(q),
  );
}

/**
 * Register the `/mp` command. `getCostBaseline` supplies the configured
 * baseline id (default `deepseek-flash`) at invocation time, so a
 * config reload is picked up without restarting.
 */
export function registerModelPicker(
  pi: ExtensionAPI,
  getCostBaseline: () => string,
): void {
  pi.registerCommand("mp", {
    description: "Select a model, each row labeled with its cost multiple",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      let baselineCost: ModelCostRates | null = null;
      try {
        baselineCost = findBaselineCost(ctx.modelRegistry.getAll(), getCostBaseline());
      } catch {
        baselineCost = null;
      }
      const baseline = getCostBaseline();
      const all = buildModelOptions(ctx.modelRegistry.getAvailable(), baselineCost, ctx.model);
      const options = filterModelOptions(all, args);
      if (options.length === 0) {
        ctx.ui.notify(`No available models match "${args.trim()}"`, "warning");
        return;
      }
      const picked = await ctx.ui.select(
        `Select model — multiple vs ${baseline}`,
        options.map((o) => o.label),
      );
      const option = options.find((o) => o.label === picked);
      if (!option) return;
      const ok = await pi.setModel(option.model);
      if (!ok) {
        ctx.ui.notify(`Auth is not configured for [${option.model.provider}]`, "warning");
      }
    },
  });
}
