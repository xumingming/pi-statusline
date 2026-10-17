import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import {
  composeStatusLine,
  findBaselineCost,
  type BlockId,
  formatTokens,
  modelCostRatio,
  normaliseCostBaseline,
  paletteFromTheme,
  shortenModelName,
  shortenPath,
  type ModelCostRates,
  type Palette,
  type RenderInputs,
} from "../blocks.ts";
import { cloneDefaultLayout, normaliseLayoutConfig } from "../layout-config.ts";

/** Deterministic test palette: each slot renders as `<slot>`, reset as `</>`. */
const TEST_PALETTE: Palette = {
  ERROR: "<error>",
  WARNING: "<warning>",
  SUCCESS: "<success>",
  CYAN: "<cyan>",
  BLUE: "<blue>",
  PURPLE: "<purple>",
  ACCENT: "<accent>",
  GRAY: "<gray>",
  RESET: "</>",
  THINK: {
    off: "<thinkOff>",
    minimal: "<thinkMinimal>",
    low: "<thinkLow>",
    medium: "<thinkMedium>",
    high: "<thinkHigh>",
    xhigh: "<thinkXhigh>",
    max: "<thinkMax>",
  },
};

function makeInputs(overrides: Partial<RenderInputs> = {}): RenderInputs {
  return {
    palette: TEST_PALETTE,
    cwd: "/Users/abei/Code/spark",
    branch: "master",
    dirty: false,
    current: 127000,
    contextWindow: 1053000, // threshold = 1020000 after the 33k buffer
    cost: 2.02,
    modelName: "Kimi K3",
    thinkingLevel: "high",
    thinkingLevelMap: undefined,
    modelReasoning: true,
    totalInput: 639000,
    totalOutput: 88000,
    totalCacheRead: 6300000,
    totalCacheWrite: 0,
    throughput: null,
    kimiUsage: null,
    goUsage: null,
    cursorUsage: null,
    modelCost: null,
    baselineCost: null,
    iconSet: "ascii",
    layout: cloneDefaultLayout(),
    ...overrides,
  };
}

test("paletteFromTheme maps semantic slots to theme tokens", () => {
  const requested: string[] = [];
  const fakeTheme = {
    getFgAnsi: (token: string) => {
      requested.push(token);
      return `[${token}]`;
    },
  } as unknown as Theme;

  const palette = paletteFromTheme(fakeTheme);

  assert.equal(palette.ERROR, "[error]");
  assert.equal(palette.WARNING, "[warning]");
  assert.equal(palette.SUCCESS, "[success]");
  assert.equal(palette.CYAN, "[syntaxType]");
  assert.equal(palette.BLUE, "[syntaxKeyword]");
  assert.equal(palette.PURPLE, "[customMessageLabel]");
  assert.equal(palette.ACCENT, "[accent]");
  assert.equal(palette.GRAY, "[dim]");
  assert.equal(palette.THINK.off, "[thinkingOff]");
  assert.equal(palette.THINK.high, "[thinkingHigh]");
  assert.equal(palette.THINK.max, "[thinkingMax]");
  assert.equal(palette.RESET, "\x1b[39m");
});

test("composeStatusLine joins all blocks with the separator", () => {
  const layout = cloneDefaultLayout();
  const line = composeStatusLine(layout, makeInputs());

  assert.ok(line.includes("[m] Kimi K3"), "model block");
  assert.ok(line.includes("<thinkHigh>"), "thinking level uses theme thinking color");
  assert.ok(line.includes("<purple>spark</>"), "path block");
  assert.ok(line.includes("<cyan>master <success>✓"), "clean git block");
  assert.ok(line.includes("12%"), "context percentage");
  assert.ok(line.includes("$2.02"), "cost block");
  assert.ok(line.includes("↑639k ↓88k R6.3M"), "token counters");
  assert.ok(!line.includes("W0"), "zero cache-write counter hidden");
  assert.ok(line.includes("<gray>│</>"), "separator is themed dim");
});

test("default order places cost, tokens, throughput right after git", () => {
  const layout = cloneDefaultLayout();
  const line = composeStatusLine(
    layout,
    makeInputs({ layout, throughput: { phase: "settled", tokensPerSec: 85.2 } }),
  );
  const pos = (needle: string) => line.indexOf(needle);
  assert.ok(pos("master") !== -1, "git renders");
  assert.ok(pos("$2.02") !== -1, "cost renders");
  assert.ok(pos("↑639k") !== -1, "tokens render");
  assert.ok(pos("[/s] 85/s") !== -1, "throughput renders");
  assert.ok(pos("12%") !== -1, "context renders");
  assert.ok(pos("master") < pos("$2.02"), "cost right after git");
  assert.ok(pos("$2.02") < pos("↑639k"), "tokens after cost");
  assert.ok(pos("↑639k") < pos("[/s] 85/s"), "throughput after tokens");
  assert.ok(pos("[/s] 85/s") < pos("12%"), "context after throughput");
});

test("throughput block: live estimate marked ~, settled dim, 0/s shown when no rate", () => {
  const layout = cloneDefaultLayout();

  const noState = composeStatusLine(layout, makeInputs({ throughput: null }));
  assert.ok(!noState.includes("[/s]"), "no block when the state is null");

  const zero = composeStatusLine(
    layout,
    makeInputs({ throughput: { phase: "settled", tokensPerSec: 0 } }),
  );
  assert.ok(zero.includes("<gray>[/s] 0/s</>"), "no measurable rate renders dim 0/s");

  const live = composeStatusLine(
    layout,
    makeInputs({ throughput: { phase: "streaming", tokensPerSec: 47.4 } }),
  );
  assert.ok(live.includes("<cyan>[/s] ~47/s"), "live estimate uses cyan + ~ prefix");

  const settled = composeStatusLine(
    layout,
    makeInputs({ throughput: { phase: "settled", tokensPerSec: 85.2 } }),
  );
  assert.ok(settled.includes("<gray>[/s] 85/s"), "settled value is dim without ~");
});

test("git block disappears outside a repo, dirty marker uses error color", () => {
  const layout = cloneDefaultLayout();
  const noRepo = composeStatusLine(layout, makeInputs({ branch: null }));
  assert.ok(!noRepo.includes("master"), "no branch rendered");

  const dirty = composeStatusLine(layout, makeInputs({ dirty: true }));
  assert.ok(dirty.includes("<error>✗"), "dirty marker uses theme error color");
});

test("cost block hidden at zero, context hidden without a window", () => {
  const layout = cloneDefaultLayout();
  const line = composeStatusLine(
    layout,
    makeInputs({ cost: 0, contextWindow: 0, current: 0 }),
  );
  assert.ok(!line.includes("$"), "no cost block");
  assert.ok(!line.includes("%"), "no context block");
});

test("context bar shifts success -> warning -> error with fill level", () => {
  const layout = cloneDefaultLayout();
  const window = 1033000; // threshold = 1000000
  const at = (pct: number) =>
    composeStatusLine(layout, makeInputs({ contextWindow: window, current: pct * 10000 }));

  assert.ok(at(50).includes("<success>50%"), "low fill is success-colored");
  assert.ok(at(70).includes("<warning>70%"), "mid fill is warning-colored");
  assert.ok(at(90).includes("<error>90%"), "high fill is error-colored");
});

test("block visibility and ordering are honored", () => {
  const layout = normaliseLayoutConfig({
    order: ["git", "model"],
    enabled: { path: false, cost: false } as Record<BlockId, boolean>,
  });
  const line = composeStatusLine(layout, makeInputs());

  assert.ok(line.indexOf("master") < line.indexOf("Kimi K3"), "git before model");
  assert.ok(!line.includes("…/abei"), "path block disabled");
  assert.ok(!line.includes("$"), "cost block disabled");
  assert.ok(line.includes("12%"), "missing ids in order still render (appended)");
});

test("thinking segment hidden for non-reasoning models or when toggled off", () => {
  const layout = cloneDefaultLayout();
  const noReasoning = composeStatusLine(layout, makeInputs({ modelReasoning: false }));
  assert.ok(!noReasoning.includes("<thinkHigh>"), "no thinking for non-reasoning model");

  const toggled = normaliseLayoutConfig({ model: { showThinking: false } });
  const off = composeStatusLine(toggled, makeInputs({ layout: toggled }));
  assert.ok(!off.includes("<thinkHigh>"), "thinking sub-toggle off");
});

test("kimi usage blocks hidden without a snapshot, shown with data", () => {
  const layout = cloneDefaultLayout();
  const hidden = composeStatusLine(layout, makeInputs());
  assert.ok(!hidden.includes("5h"), "no 5h block without usage data");
  assert.ok(!hidden.includes("wk"), "no weekly block without usage data");

  const usage = {
    weekly: { label: "wk", used: 9, limit: 100 },
    fiveHour: { label: "5h", used: 43, limit: 100 },
    monthly: null,
  };
  const line = composeStatusLine(layout, makeInputs({ kimiUsage: usage }));
  assert.ok(line.includes("<gray>5h</> <success>43%</>"), "5h block with low fill");
  assert.ok(line.includes("<gray>wk</> <success>9%</>"), "weekly block with low fill");
  assert.ok(line.includes("\u2593"), "progress bar rendered");
});

test("kimi usage bars shift success -> warning -> error with fill level", () => {
  const layout = cloneDefaultLayout();
  const at = (used: number) =>
    composeStatusLine(
      layout,
      makeInputs({
        kimiUsage: { weekly: { label: "wk", used, limit: 100 }, fiveHour: null, monthly: null },
      }),
    );

  assert.ok(at(50).includes("<success>50%"), "low fill is success-colored");
  assert.ok(at(70).includes("<warning>70%"), "mid fill is warning-colored");
  assert.ok(at(90).includes("<error>90%"), "high fill is error-colored");
});

test("kimi weekly block shows when the window ends", () => {
  const layout = cloneDefaultLayout();
  const resetTime = "2026-08-15T07:01:18.219288Z";
  const d = new Date(resetTime);
  const pad = (n: number) => String(n).padStart(2, "0");
  const expected =
    `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const usage = {
    weekly: { label: "wk", used: 9, limit: 100, resetTime },
    fiveHour: null,
    monthly: null,
  };
  const line = composeStatusLine(layout, makeInputs({ kimiUsage: usage }));
  assert.ok(
    line.includes(`<gray>ends ${expected}</>`),
    "weekly block shows local reset time",
  );

  const noReset = composeStatusLine(
    layout,
    makeInputs({
      kimiUsage: { weekly: { label: "wk", used: 9, limit: 100 }, fiveHour: null, monthly: null },
    }),
  );
  assert.ok(!noReset.includes("ends"), "no ends segment without resetTime");

  const badReset = composeStatusLine(
    layout,
    makeInputs({
      kimiUsage: {
        weekly: { label: "wk", used: 9, limit: 100, resetTime: "not-a-date" },
        fiveHour: null,
        monthly: null,
      },
    }),
  );
  assert.ok(!badReset.includes("ends"), "no ends segment for invalid resetTime");
});

test("kimi usage blocks can be disabled via layout", () => {
  const layout = normaliseLayoutConfig({
    enabled: { "kimi-5h": false, "kimi-weekly": false } as Record<BlockId, boolean>,
  });
  const usage = {
    weekly: { label: "wk", used: 9, limit: 100 },
    fiveHour: { label: "5h", used: 43, limit: 100 },
    monthly: { label: "mo", used: 4, limit: 100 },
  };
  const line = composeStatusLine(layout, makeInputs({ kimiUsage: usage, layout }));
  assert.ok(!line.includes("43%"), "5h block disabled");
  assert.ok(!line.includes("9%"), "weekly block disabled");
  assert.ok(line.includes("<gray>mo</> <success>4%</>"), "monthly block still enabled");
});

test("kimi monthly block shows fill and end time", () => {
  const layout = cloneDefaultLayout();
  const resetTime = "2026-11-15T00:00:00Z";
  const d = new Date(resetTime);
  const pad = (n: number) => String(n).padStart(2, "0");
  const expected =
    `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const usage = {
    weekly: null,
    fiveHour: null,
    monthly: { label: "mo", used: 4, limit: 100, resetTime },
  };
  const line = composeStatusLine(layout, makeInputs({ kimiUsage: usage }));
  assert.ok(line.includes("<gray>mo</> <success>4%</>"), "monthly block with low fill");
  assert.ok(
    line.includes(`<gray>ends ${expected}</>`),
    "monthly block shows local reset time",
  );

  const noReset = composeStatusLine(
    layout,
    makeInputs({
      kimiUsage: { weekly: null, fiveHour: null, monthly: { label: "mo", used: 4, limit: 100 } },
    }),
  );
  assert.ok(!noReset.includes("ends"), "no ends segment without resetTime");
});

test("go usage bars appear only with an opencode-go snapshot and only when enabled", () => {
  const layout = cloneDefaultLayout();
  const hidden = composeStatusLine(layout, makeInputs());
  assert.ok(!hidden.includes("5h"), "no 5h block without usage data");
  assert.ok(!hidden.includes("wk"), "no weekly block without usage data");

  const usage = {
    rolling: { label: "5h", percent: 1 },
    weekly: { label: "wk", percent: 0 },
    monthly: { label: "mo", percent: 0 },
  };
  const line = composeStatusLine(layout, makeInputs({ goUsage: usage }));
  assert.ok(line.includes("<gray>5h</> <success>1%</>"), "5h block with low fill");
  assert.ok(line.includes("<gray>wk</> <success>0%</>"), "weekly block with low fill");
  assert.ok(line.includes("<gray>mo</> <success>0%</>"), "monthly block rendered");
  assert.ok(line.includes("\u2593"), "progress bar rendered");
});

test("go usage bars shift success -> warning -> error with fill level", () => {
  const layout = cloneDefaultLayout();
  const at = (percent: number) =>
    composeStatusLine(
      layout,
      makeInputs({ goUsage: { rolling: { label: "5h", percent }, weekly: null, monthly: null } }),
    );

  assert.ok(at(50).includes("<success>50%"), "low fill is success-colored");
  assert.ok(at(70).includes("<warning>70%"), "mid fill is warning-colored");
  assert.ok(at(90).includes("<error>90%"), "high fill is error-colored");
});

test("go weekly block shows when the window ends", () => {
  const layout = cloneDefaultLayout();
  const resetsAt = "2026-08-24T00:00:00.520Z";
  const d = new Date(resetsAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const expected =
    `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const usage = {
    rolling: null,
    weekly: { label: "wk", percent: 3, resetsAt },
    monthly: null,
  };
  const line = composeStatusLine(layout, makeInputs({ goUsage: usage }));
  assert.ok(
    line.includes(`<gray>ends ${expected}</>`),
    "weekly block shows local reset time",
  );
});

test("go usage blocks can be disabled via layout", () => {
  const layout = normaliseLayoutConfig({
    enabled: { "go-5h": false, "go-weekly": false, "go-monthly": false } as Record<
      BlockId,
      boolean
    >,
  });
  const usage = {
    rolling: { label: "5h", percent: 37 },
    weekly: { label: "wk", percent: 24 },
    monthly: { label: "mo", percent: 9 },
  };
  const line = composeStatusLine(layout, makeInputs({ goUsage: usage, layout }));
  assert.ok(!line.includes("37%"), "5h block disabled");
  assert.ok(!line.includes("24%"), "weekly block disabled");
  assert.ok(!line.includes("9%"), "monthly block disabled");
});

test("path block renders only the directory name by default", () => {
  const layout = cloneDefaultLayout();
  const line = composeStatusLine(layout, makeInputs({ layout }));
  assert.ok(line.includes("<purple>spark</>"), "basename rendered in purple");
  assert.ok(!line.includes("…/abei"), "no ancestor segments shown");
});

test("path block shows parent segments with path.segments = 3", () => {
  const layout = normaliseLayoutConfig({ path: { segments: 3 } });
  const line = composeStatusLine(layout, makeInputs({ layout }));
  assert.ok(
    line.includes("…/abei/Code</><purple>/spark"),
    "parent segments in gray, basename purple",
  );
});

test("path.segments is clamped to 1..3 and defaults to 1", () => {
  const defaults = normaliseLayoutConfig(undefined);
  assert.equal(defaults.path.segments, 1, "default is 1");

  const outOfRange = normaliseLayoutConfig({ path: { segments: 9 } });
  assert.equal(outOfRange.path.segments, 3, "clamped down to 3");

  const zero = normaliseLayoutConfig({ path: { segments: 0 } });
  assert.equal(zero.path.segments, 1, "zero clamped up to 1");

  const negative = normaliseLayoutConfig({ path: { segments: -2 } });
  assert.equal(negative.path.segments, 1, "negative clamped up to 1");

  const nonNumber = normaliseLayoutConfig({
    path: { segments: "short" } as unknown as { segments: number },
  });
  assert.equal(nonNumber.path.segments, 1, "non-number falls back to default");
});

test("go and cursor usage bars round fractional percents to integers", () => {
  const layout = cloneDefaultLayout();
  const frac = 1.3629629629629632;
  const goLine = composeStatusLine(
    layout,
    makeInputs({
      goUsage: { rolling: { label: "5h", percent: frac }, weekly: null, monthly: null },
    }),
  );
  assert.ok(goLine.includes("<success>1%"), "go bar shows rounded percent");

  const cursorLine = composeStatusLine(
    layout,
    makeInputs({
      cursorUsage: { total: { label: "cur", percent: frac }, auto: null, api: null },
    }),
  );
  assert.ok(cursorLine.includes("<success>1%"), "cursor bar shows rounded percent");
  assert.ok(!cursorLine.includes("1.362"), "fractional digits not shown in percent");
});

test("format helpers", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(639000), "639k");
  assert.equal(formatTokens(6300000), "6.3M");
  assert.equal(shortenPath("/Users/abei/Code/spark"), "spark");
  assert.equal(shortenPath("/tmp/x"), "x");
  assert.equal(shortenPath("/tmp/x", 3), "/tmp/x");
  assert.equal(shortenPath("/Users/abei/Code/spark", 1), "spark");
  assert.equal(shortenPath("/Users/abei/Code/spark", 2), "…/Code/spark");
  assert.equal(shortenPath("/Users/abei/Code/spark", 3), "…/abei/Code/spark");
  assert.equal(shortenModelName({ name: "Claude Opus 4.7" }), "Opus 4.7");
  assert.equal(shortenModelName({ id: "anthropic/claude-opus" }), "claude-opus");
});

const FLASH: ModelCostRates = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 };
const HAIKU_55: ModelCostRates = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };
const GROK_43: ModelCostRates = { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 };
const GROK_47: ModelCostRates = { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 };
const SONNET_5: ModelCostRates = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const GPT_54: ModelCostRates = { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 };
const OPUS_48: ModelCostRates = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const FABLE_5: ModelCostRates = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

test("cost multiple is one significant figure versus deepseek-flash", () => {
  const label = (cost: ModelCostRates) => modelCostRatio(cost, FLASH)?.label;
  assert.equal(label(FLASH), "1x");
  assert.equal(label(HAIKU_55), "0.5x");
  assert.equal(label(GROK_43), "4x");
  assert.equal(label(GROK_47), "10x");
  assert.equal(label(SONNET_5), "9x");
  // ~13 rounds to one significant figure, same rule as 23 -> 20 and 46 -> 50.
  assert.equal(label(GPT_54), "10x");
  assert.equal(label(OPUS_48), "20x");
  assert.equal(label(FABLE_5), "50x");
  assert.equal(modelCostRatio(GROK_47, FLASH)?.value, 10);
});

test("zero cacheRead is charged at the input rate", () => {
  const uncached = { input: 1.25, output: 2.5, cacheRead: 0, cacheWrite: 0 };
  assert.equal(modelCostRatio(uncached, FLASH)?.label, "10x");
});

test("cost multiple hidden when either side is unpriced", () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const writeOnly = { input: 0, output: 0, cacheRead: 0, cacheWrite: 5 };
  assert.equal(modelCostRatio(zero, FLASH), null);
  assert.equal(modelCostRatio(writeOnly, FLASH), null);
  assert.equal(modelCostRatio(GROK_47, zero), null);
  assert.equal(modelCostRatio(null, FLASH), null);
  assert.equal(modelCostRatio(GROK_47, null), null);
});

test("cost baseline id falls back unless it is a model id or provider/id", () => {
  assert.equal(normaliseCostBaseline(undefined), "deepseek-flash");
  assert.equal(normaliseCostBaseline(12), "deepseek-flash");
  assert.equal(normaliseCostBaseline(""), "deepseek-flash");
  assert.equal(normaliseCostBaseline("  "), "deepseek-flash");
  assert.equal(normaliseCostBaseline("has space"), "deepseek-flash");
  assert.equal(normaliseCostBaseline("  grok-4.7  "), "grok-4.7");
  assert.equal(normaliseCostBaseline("deepseek/deepseek-flash"), "deepseek/deepseek-flash");
});

test("baseline lookup prefers priced deepseek, and provider/id pins one entry", () => {
  const flash = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 };
  const other = { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 };
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const models = [
    { id: "deepseek-flash", provider: "cursor", cost: other },
    { id: "deepseek-flash", provider: "deepseek", cost: zero },
    { id: "deepseek-flash", provider: "deepseek", cost: flash },
    { id: "grok-4.7", provider: "opencode-go", cost: other },
  ];
  assert.deepEqual(findBaselineCost(models, "deepseek-flash"), flash);
  assert.deepEqual(findBaselineCost(models, "cursor/deepseek-flash"), other);
  assert.equal(findBaselineCost(models, "missing"), null);
  assert.equal(findBaselineCost(models, "nope/deepseek-flash"), null);
});

test("model block shows the cost multiple after the name and before thinking", () => {
  const layout = cloneDefaultLayout();
  const line = composeStatusLine(
    layout,
    makeInputs({
      modelName: "Grok 4.7",
      modelCost: GROK_47,
      baselineCost: FLASH,
    }),
  );
  assert.match(line, /\[m\] Grok 4\.7<\/> <warning>10x<\/>/);
  assert.ok(line.indexOf("10x") < line.indexOf("<thinkHigh>"), "multiple before thinking");
  assert.ok(!line.includes("[10x]"), "no brackets around the multiple");
  assert.ok(!line.includes("10x]"), "no closing bracket after the multiple");
});

test("cost multiple color follows 4x / 20x thresholds", () => {
  const layout = cloneDefaultLayout();
  const at = (name: string, cost: ModelCostRates) =>
    composeStatusLine(
      layout,
      makeInputs({ modelName: name, modelCost: cost, baselineCost: FLASH, modelReasoning: false }),
    );

  assert.match(at("Haiku 5.5", HAIKU_55), /<gray>0\.5x<\/>/);
  assert.match(at("Grok 4.3", GROK_43), /<gray>4x<\/>/);
  assert.match(at("Opus 4.8", OPUS_48), /<warning>20x<\/>/);
  assert.match(at("Fable 5", FABLE_5), /<error>50x<\/>/);
});

test("cost multiple stays when thinking is hidden, and hides with no price", () => {
  const layout = normaliseLayoutConfig({ model: { showThinking: false } });
  const shown = composeStatusLine(
    layout,
    makeInputs({ layout, modelName: "Grok 4.7", modelCost: GROK_47, baselineCost: FLASH }),
  );
  assert.match(shown, /Grok 4\.7<\/> <warning>10x<\/>/);
  assert.ok(!shown.includes("<thinkHigh>"), "thinking still off");

  const unpriced = composeStatusLine(
    layout,
    makeInputs({
      layout,
      modelName: "Grok 4.7",
      modelCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      baselineCost: FLASH,
    }),
  );
  assert.ok(!unpriced.includes("10x"), "unpriced model draws no multiple");
  assert.ok(!unpriced.includes("x</>"), "no multiple label");
});

test("cost multiple hides while a subscription quota bar is showing", () => {
  const layout = cloneDefaultLayout();
  const priced = {
    modelName: "Kimi K3",
    modelCost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
    baselineCost: FLASH,
  };
  const kimi = composeStatusLine(
    layout,
    makeInputs({
      ...priced,
      kimiUsage: {
        weekly: { label: "wk", used: 9, limit: 100 },
        fiveHour: { label: "5h", used: 43, limit: 100 },
        monthly: null,
      },
    }),
  );
  assert.ok(kimi.includes("5h"), "quota bar is showing");
  assert.ok(!kimi.includes("x</>"), "no multiple beside a kimi bar");

  const kimiMonthly = composeStatusLine(
    layout,
    makeInputs({
      ...priced,
      kimiUsage: {
        weekly: null,
        fiveHour: null,
        monthly: { label: "mo", used: 4, limit: 100 },
      },
    }),
  );
  assert.ok(kimiMonthly.includes("mo"), "monthly quota bar is showing");
  assert.ok(!kimiMonthly.includes("x</>"), "no multiple beside a kimi monthly bar");

  const go = composeStatusLine(
    layout,
    makeInputs({
      ...priced,
      modelName: "Grok 4.7",
      goUsage: {
        rolling: { label: "5h", percent: 1 },
        weekly: null,
        monthly: null,
      },
    }),
  );
  assert.ok(!go.includes("10x"), "no multiple beside a go bar");

  const cursor = composeStatusLine(
    layout,
    makeInputs({
      ...priced,
      modelName: "Grok 4.7",
      cursorUsage: { total: { label: "cur", percent: 12 }, auto: null, api: null },
    }),
  );
  assert.ok(!cursor.includes("10x"), "no multiple beside a cursor bar");

  const disabled = normaliseLayoutConfig({
    enabled: { "kimi-5h": false, "kimi-weekly": false, "kimi-monthly": false } as Record<
      BlockId,
      boolean
    >,
  });
  const fallback = composeStatusLine(
    disabled,
    makeInputs({
      ...priced,
      layout: disabled,
      kimiUsage: {
        weekly: { label: "wk", used: 9, limit: 100 },
        fiveHour: { label: "5h", used: 43, limit: 100 },
        monthly: { label: "mo", used: 4, limit: 100 },
      },
    }),
  );
  assert.ok(!fallback.includes("43%"), "quota bars disabled");
  assert.match(fallback, /<warning>10x<\/>/, "multiple returns when the bars are off");
});
