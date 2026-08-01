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
