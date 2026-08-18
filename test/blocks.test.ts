import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import {
  composeStatusLine,
  type BlockId,
  formatTokens,
  paletteFromTheme,
  shortenModelName,
  shortenPath,
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
  assert.ok(line.includes("…/abei/Code</><purple>/spark"), "path block");
  assert.ok(line.includes("<cyan>master <success>✓"), "clean git block");
  assert.ok(line.includes("12%"), "context percentage");
  assert.ok(line.includes("$2.02"), "cost block");
  assert.ok(line.includes("↑639k ↓88k R6.3M"), "token counters");
  assert.ok(!line.includes("W0"), "zero cache-write counter hidden");
  assert.ok(line.includes("<gray>│</>"), "separator is themed dim");
});

test("throughput block: live estimate marked ~, settled dim, hidden when null", () => {
  const layout = cloneDefaultLayout();

  const hidden = composeStatusLine(layout, makeInputs({ throughput: null }));
  assert.ok(!hidden.includes("[/s]"), "no throughput block when idle");

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
        kimiUsage: { weekly: { label: "wk", used, limit: 100 }, fiveHour: null },
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
  };
  const line = composeStatusLine(layout, makeInputs({ kimiUsage: usage }));
  assert.ok(
    line.includes(`<gray>ends ${expected}</>`),
    "weekly block shows local reset time",
  );

  const noReset = composeStatusLine(
    layout,
    makeInputs({
      kimiUsage: { weekly: { label: "wk", used: 9, limit: 100 }, fiveHour: null },
    }),
  );
  assert.ok(!noReset.includes("ends"), "no ends segment without resetTime");

  const badReset = composeStatusLine(
    layout,
    makeInputs({
      kimiUsage: {
        weekly: { label: "wk", used: 9, limit: 100, resetTime: "not-a-date" },
        fiveHour: null,
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
  };
  const line = composeStatusLine(layout, makeInputs({ kimiUsage: usage, layout }));
  assert.ok(!line.includes("43%"), "5h block disabled");
  assert.ok(!line.includes("9%"), "weekly block disabled");
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

test("format helpers", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(639000), "639k");
  assert.equal(formatTokens(6300000), "6.3M");
  assert.equal(shortenPath("/Users/abei/Code/spark"), "…/abei/Code/spark");
  assert.equal(shortenPath("/tmp/x"), "/tmp/x");
  assert.equal(shortenModelName({ name: "Claude Opus 4.7" }), "Opus 4.7");
  assert.equal(shortenModelName({ id: "anthropic/claude-opus" }), "claude-opus");
});
