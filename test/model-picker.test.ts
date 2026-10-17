import assert from "node:assert/strict";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";

import {
  buildModelOptions,
  filterModelOptions,
  registerModelPicker,
  visibleWindow,
  type ModelOption,
} from "../model-picker.ts";
import type { ModelCostRates } from "../blocks.ts";

const FLASH: ModelCostRates = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 };
const GROK_47: ModelCostRates = { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 };

function makeModel(provider: string, id: string, cost?: ModelCostRates): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 10000,
  };
}

test("buildModelOptions labels each row with id, provider and multiple", () => {
  const options = buildModelOptions(
    [makeModel("xai", "grok-4.7", GROK_47), makeModel("deepseek", "deepseek-flash", FLASH)],
    FLASH,
  );
  assert.deepEqual(
    options.map((o) => o.label),
    ["deepseek-flash [deepseek] (1x)", "grok-4.7 [xai] (10x)"],
  );
});

test("buildModelOptions marks the current model first and omits unpriced multiples", () => {
  const current = makeModel("xai", "grok-4.7", GROK_47);
  const options = buildModelOptions(
    [makeModel("deepseek", "deepseek-flash", FLASH), current, makeModel("cursor", "default")],
    FLASH,
    current,
  );
  assert.equal(options[0]?.label, "* grok-4.7 [xai] (10x)", "current model leads");
  assert.ok(
    options.every((o, i) => i === 0 || !o.label.startsWith("* ")),
    "only the current model is marked",
  );
  assert.ok(
    options.some((o) => o.label === "default [cursor]"),
    "unpriced model lists no multiple",
  );
});

test("buildModelOptions tolerates an unpriced baseline", () => {
  const options = buildModelOptions([makeModel("xai", "grok-4.7", GROK_47)], null);
  assert.equal(options[0]?.label, "grok-4.7 [xai]");
});

test("filterModelOptions matches provider/id and name, case-insensitively", () => {
  const options: ModelOption[] = [
    { label: "grok-4.7 [xai] (10x)", model: makeModel("xai", "grok-4.7", GROK_47) },
    { label: "deepseek-flash [deepseek] (1x)", model: makeModel("deepseek", "deepseek-flash", FLASH) },
  ];
  assert.equal(filterModelOptions(options, "GROK")[0]?.label, "grok-4.7 [xai] (10x)");
  assert.equal(filterModelOptions(options, "deepseek")[0]?.model.id, "deepseek-flash");
  assert.equal(filterModelOptions(options, "nope").length, 0);
  assert.equal(filterModelOptions(options, "  ").length, 2, "blank query keeps all");
});

test("visibleWindow slides to follow the selection", () => {
  // Short lists show everything from row 0.
  assert.deepEqual(visibleWindow(5, 3, 10), { start: 0, end: 5 });
  // The selection stays centered until the window hits the end.
  assert.deepEqual(visibleWindow(30, 0, 10), { start: 0, end: 10 });
  assert.deepEqual(visibleWindow(30, 5, 10), { start: 0, end: 10 });
  assert.deepEqual(visibleWindow(30, 8, 10), { start: 3, end: 13 });
  assert.deepEqual(visibleWindow(30, 25, 10), { start: 20, end: 30 });
  // The last rows are always fully visible.
  assert.deepEqual(visibleWindow(30, 29, 10), { start: 20, end: 30 });
});

test("registerModelPicker selects a model via pi.setModel", async () => {
  const grok = makeModel("xai", "grok-4.7", GROK_47);
  const flash = makeModel("deepseek", "deepseek-flash", FLASH);
  let registered:
    | { name: string; description: string; handler: (args: string, ctx: unknown) => Promise<void> }
    | undefined;
  let setModelCalls = 0;
  const notifications: string[] = [];
  const fakePi = {
    registerCommand(name: string, opts: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
      registered = { name, ...opts };
    },
    setModel: async (model: unknown) => {
      setModelCalls += 1;
      return model === grok;
    },
  };
  registerModelPicker(fakePi as never, () => "deepseek-flash", (() => ({})) as never, () => {});
  assert.equal(registered?.name, "model-with-pricing-multiplier");

  const fakeCtx = {
    hasUI: true,
    model: undefined,
    modelRegistry: {
      getAll: () => [grok, flash],
      getAvailable: () => [grok, flash],
    },
    ui: {
      select: async (_title: string, labels: string[]) => labels[1],
      notify: (message: string) => notifications.push(message),
    },
  };
  // Sorted: deepseek-flash first, grok second — picking row 1 is grok.
  await registered!.handler("", fakeCtx as never);

  assert.equal(setModelCalls, 1, "setModel called once");
  assert.equal(notifications.length, 0, "no warning on success");
});

test("registerModelPicker notifies when auth is missing, and on no matches", async () => {
  const flash = makeModel("deepseek", "deepseek-flash", FLASH);
  let registered:
    | { handler: (args: string, ctx: unknown) => Promise<void> }
    | undefined;
  const notifications: string[] = [];
  const fakePi = {
    registerCommand(_name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      registered = opts;
    },
    setModel: async () => false,
  };
  registerModelPicker(fakePi as never, () => "deepseek-flash", (() => ({})) as never, () => {});

  const fakeCtx = {
    hasUI: true,
    model: undefined,
    modelRegistry: {
      getAll: () => [flash],
      getAvailable: () => [flash],
    },
    ui: {
      select: async (_title: string, labels: string[]) => labels[0],
      notify: (message: string) => notifications.push(message),
    },
  };
  await registered!.handler("", fakeCtx as never);
  assert.match(notifications[0] ?? "", /Auth is not configured/, "auth failure warns");

  notifications.length = 0;
  await registered!.handler("zzz", fakeCtx as never);
  assert.match(notifications[0] ?? "", /No available models match/, "no-match warns");
});

test("registerModelPicker is a no-op without a UI", async () => {
  let registered:
    | { handler: (args: string, ctx: unknown) => Promise<void> }
    | undefined;
  let setModelCalls = 0;
  const fakePi = {
    registerCommand(_name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      registered = opts;
    },
    setModel: async () => {
      setModelCalls += 1;
      return true;
    },
  };
  registerModelPicker(fakePi as never, () => "deepseek-flash", (() => ({})) as never, () => {});
  await registered!.handler("", { hasUI: false } as never);
  assert.equal(setModelCalls, 0, "never touches the model");
});
