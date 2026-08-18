/**
 * pi-statusline — per-block renderers + composer.
 *
 * Forked from @wierdbytes/pi-statusline (MIT) with two changes:
 *
 *   1. Colors come from a `Palette` derived from the active pi theme
 *      (see `paletteFromTheme`) instead of hardcoded Tokyo Night Storm
 *      ANSI constants, so the statusline follows `/theme` switches.
 *   2. Trimmed to the core blocks: model, path, git, context, cost,
 *      tokens, throughput — plus Kimi subscription usage bars
 *      (kimi-5h, kimi-weekly) fed by kimi-usage.ts and OpenCode Go
 *      usage bars (go-5h, go-weekly, go-monthly) fed by go-usage.ts.
 *      The notify-chips
 *      and stash blocks (which depended on the events bus / stash
 *      feature of the original) are dropped.
 *
 * Each `BlockRenderer` is a pure function that turns the shared
 * `RenderInputs` bundle into an ANSI string with **no leading or
 * trailing separator and no leading space**. An empty string means
 * "skip me" (e.g. git block outside a repo).
 *
 * `composeStatusLine` walks `layout.order`, calls each renderer whose
 * `enabled` flag is on, drops empty results, and joins the remaining
 * pieces with the configured separator glyph wrapped in spaces.
 */

import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { basename, dirname } from "node:path";

import { resolveIcon, type IconSet } from "./icons.ts";
import type { KimiWindowUsage, KimiUsageSnapshot } from "./kimi-usage.ts";
import type { GoUsageSnapshot, GoWindowUsage } from "./go-usage.ts";
import type { LayoutConfig } from "./layout-config.ts";
import type { ThroughputState } from "./throughput.ts";

// ─────────────────────────────────────────────────────────────────────
// Palette (derived from the active pi theme)
// ─────────────────────────────────────────────────────────────────────

/**
 * Semantic color slots used by the block renderers. Values are raw
 * ANSI foreground prefixes obtained from `Theme.getFgAnsi`, so they
 * adapt to whichever theme is active (including custom user themes).
 *
 * Slot → theme token mapping:
 *   ERROR   → error               WARNING → warning
 *   SUCCESS → success             CYAN    → syntaxType
 *   BLUE    → syntaxKeyword       PURPLE  → customMessageLabel
 *   ACCENT  → accent              GRAY    → dim
 *   THINK.* → thinkingOff … thinkingMax (1:1)
 */
export interface Palette {
  ERROR: string;
  WARNING: string;
  SUCCESS: string;
  CYAN: string;
  BLUE: string;
  PURPLE: string;
  ACCENT: string;
  GRAY: string;
  /** Foreground-only reset, matching what `Theme.fg` appends. */
  RESET: string;
  /** Thinking level → ANSI prefix. Unknown levels fall back to GRAY. */
  THINK: Record<string, string>;
}

/** Build a palette from the active theme. Cheap; call per render so
 *  live theme reloads are picked up without caching concerns. */
export function paletteFromTheme(theme: Theme): Palette {
  return {
    ERROR: theme.getFgAnsi("error"),
    WARNING: theme.getFgAnsi("warning"),
    SUCCESS: theme.getFgAnsi("success"),
    CYAN: theme.getFgAnsi("syntaxType"),
    BLUE: theme.getFgAnsi("syntaxKeyword"),
    PURPLE: theme.getFgAnsi("customMessageLabel"),
    ACCENT: theme.getFgAnsi("accent"),
    GRAY: theme.getFgAnsi("dim"),
    RESET: "\x1b[39m",
    THINK: {
      off: theme.getFgAnsi("thinkingOff"),
      minimal: theme.getFgAnsi("thinkingMinimal"),
      low: theme.getFgAnsi("thinkingLow"),
      medium: theme.getFgAnsi("thinkingMedium"),
      high: theme.getFgAnsi("thinkingHigh"),
      xhigh: theme.getFgAnsi("thinkingXhigh"),
      max: theme.getFgAnsi("thinkingMax"),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const AUTOCOMPACT_BUFFER = 33000;
const BAR_WIDTH = 10;

const THINK_LABELS: Record<string, string> = {
  off: "off",
  minimal: "min",
  low: "low",
  medium: "med",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

const STANDARD_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

// ─────────────────────────────────────────────────────────────────────
// Generic format helpers
// ─────────────────────────────────────────────────────────────────────

export function shortenPath(cwd: string, segments = 1): string {
  const take = Math.min(3, Math.max(1, Math.floor(segments)));
  const parts = cwd.split("/");
  if (parts.length <= take) return cwd;
  const tail = parts.slice(-take);
  return take === 1 ? tail[0] : `…/${tail.join("/")}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${Math.round(n / 1000000)}M`;
}

export function formatCost(cost: number): string {
  return cost.toFixed(2);
}

export function shortenModelName(model: { id?: string; name?: string } | undefined): string {
  let name = model?.name || model?.id || "no-model";
  if (name.startsWith("Claude ")) name = name.slice(7);
  if (name.startsWith("anthropic/")) name = name.slice("anthropic/".length);
  return name;
}

export function resolveThinkingLabel(
  thinkingLevel: string,
  thinkingLevelMap: ThinkingLevelMap | undefined,
): string {
  const mapped = thinkingLevelMap?.[thinkingLevel as keyof ThinkingLevelMap];
  // Provider maps describe API translation as well as presentation. A map
  // such as `minimal → low` must not rename the level the user selected.
  // Keep only genuinely custom display values (`max`, token budgets, etc.).
  if (
    typeof mapped === "string" &&
    mapped.length > 0 &&
    !STANDARD_THINKING_LEVELS.has(mapped)
  ) {
    return mapped;
  }
  return THINK_LABELS[thinkingLevel] ?? thinkingLevel;
}

function buildBar(pct: number, pctColor: string, palette: Palette): string {
  const clamped = Math.max(0, Math.min(100, pct));
  let filled = Math.floor((clamped * BAR_WIDTH) / 100);
  if (filled > BAR_WIDTH) filled = BAR_WIDTH;
  if (filled < 0) filled = 0;
  const empty = BAR_WIDTH - filled;
  return `${pctColor}${"▓".repeat(filled)}${palette.GRAY}${"░".repeat(empty)}${palette.RESET}`;
}

function pctColorFor(pct: number, palette: Palette): string {
  if (pct > 80) return palette.ERROR;
  if (pct > 60) return palette.WARNING;
  return palette.SUCCESS;
}

// ─────────────────────────────────────────────────────────────────────
// Block registry
// ─────────────────────────────────────────────────────────────────────

/** Stable list of all known block ids. Add to this when adding a
 *  new renderer and the layout normalisation picks it up automatically. */
export const KNOWN_BLOCK_IDS = [
  "model",
  "path",
  "git",
  "cost",
  "tokens",
  "throughput",
  "context",
  "kimi-5h",
  "kimi-weekly",
  "go-5h",
  "go-weekly",
  "go-monthly",
] as const;

export type BlockId = (typeof KNOWN_BLOCK_IDS)[number];

/** Runtime set used by config normalisation. */
export const KNOWN_BLOCK_ID_SET: ReadonlySet<BlockId> = new Set(KNOWN_BLOCK_IDS);

/** Shared bundle every block renderer reads from. */
export interface RenderInputs {
  palette: Palette;
  cwd: string;
  branch: string | null;
  dirty: boolean;
  current: number;
  contextWindow: number;
  cost: number;
  modelName: string;
  thinkingLevel: string;
  thinkingLevelMap: ThinkingLevelMap | undefined;
  modelReasoning: boolean;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  /** Output-token rate for the current/last response; null when idle
   *  or too early in a stream to estimate. */
  throughput: ThroughputState | null;
  /** Kimi subscription usage windows; null when the active model is
   *  not served by Kimi or no snapshot has loaded yet. */
  kimiUsage: KimiUsageSnapshot | null;
  /** OpenCode Go subscription usage windows; null when the active
   *  model is not served by OpenCode Go or no snapshot has loaded. */
  goUsage: GoUsageSnapshot | null;
  iconSet: IconSet;
  layout: LayoutConfig;
}

export type BlockRenderer = (inputs: RenderInputs) => string;

// ─────────────────────────────────────────────────────────────────────
// Per-block renderers
// ─────────────────────────────────────────────────────────────────────

/**
 * `model` block — icon + display name, with an optional inline
 * thinking-level segment attached when (a) the active model is
 * reasoning-capable and (b) `layout.model.showThinking === true`.
 * Thinking lives inside this block on purpose: it's logically tied to
 * the model and never gets its own separator.
 */
const renderModel: BlockRenderer = (inputs) => {
  const p = inputs.palette;
  const head = `${p.ACCENT}${resolveIcon(inputs.iconSet, "model")} ${inputs.modelName}${p.RESET}`;
  if (!inputs.modelReasoning || !inputs.layout.model.showThinking) return head;
  const label = resolveThinkingLabel(inputs.thinkingLevel, inputs.thinkingLevelMap);
  const icon = resolveIcon(inputs.iconSet, "thinking");
  const color = p.THINK[inputs.thinkingLevel] ?? p.GRAY;
  return `${head} ${color}${icon} ${label}${p.RESET}`;
};

/** `path` block — `…/parent/dir` with the current directory accented;
 *  with `layout.path.segments = 1` only the directory name is shown. */
const renderPath: BlockRenderer = (inputs) => {
  const p = inputs.palette;
  const segments = inputs.layout.path.segments;
  const shortDir = shortenPath(inputs.cwd, segments);
  const dirParent = dirname(shortDir);
  const dirName = basename(shortDir) || shortDir;
  if (segments <= 1) return `${p.PURPLE}${dirName}${p.RESET}`;
  return `${p.GRAY}${dirParent}${p.RESET}${p.PURPLE}/${dirName}${p.RESET}`;
};

/** `git` block — branch + clean/dirty mark; empty outside a repo. */
const renderGit: BlockRenderer = (inputs) => {
  const p = inputs.palette;
  if (!inputs.branch) return "";
  const mark = inputs.dirty ? `${p.ERROR}✗${p.RESET}` : `${p.SUCCESS}✓${p.RESET}`;
  return `${p.CYAN}${inputs.branch} ${mark}`;
};

/** `context` block — `pct%: used[bar]remaining`; empty when no context window. */
const renderContext: BlockRenderer = (inputs) => {
  const p = inputs.palette;
  if (inputs.contextWindow <= 0) return "";
  const threshold = Math.max(1, inputs.contextWindow - AUTOCOMPACT_BUFFER);
  let pct = Math.floor((inputs.current * 100) / threshold);
  let remaining = threshold - inputs.current;
  if (remaining < 0) {
    remaining = 0;
    pct = 100;
  }
  if (pct < 0) pct = 0;
  const color = pctColorFor(pct, p);
  const bar = buildBar(pct, color, p);
  return (
    `${color}${pct}%${p.RESET}: ${formatTokens(inputs.current)}` +
    `${p.GRAY}[${p.RESET}${bar}${p.GRAY}]${p.RESET}${formatTokens(remaining)}`
  );
};

/**
 * Shared renderer for the Kimi usage-window blocks: a dim label, the
 * used percentage colored by fill level, and a progress bar. Returns
 * "" when the window has no usable data.
 */
function renderUsageWindow(row: KimiWindowUsage, palette: Palette): string {
  const p = palette;
  if (row.limit <= 0) return `${p.GRAY}${row.label} ${row.used}${p.RESET}`;
  const pct = Math.min(100, Math.floor((Math.max(0, row.used) * 100) / row.limit));
  const color = pctColorFor(pct, p);
  const bar = buildBar(pct, color, p);
  return (
    `${p.GRAY}${row.label}${p.RESET} ${color}${pct}%${p.RESET} ` +
    `${p.GRAY}[${p.RESET}${bar}${p.GRAY}]${p.RESET}`
  );
}

/** `kimi-5h` block — current short rate-limit window (typically 5h). */
const renderKimiFiveHour: BlockRenderer = (inputs) => {
  const row = inputs.kimiUsage?.fiveHour;
  if (!row) return "";
  return renderUsageWindow(row, inputs.palette);
};

/**
 * Format a weekly-window reset instant as local `MM-DD HH:mm`.
 * Returns "" when the payload carried no (or an unparseable)
 * resetTime, so the block silently keeps its bar-only shape.
 */
function formatResetTime(resetTime: string | undefined): string {
  if (!resetTime) return "";
  const ms = new Date(resetTime).getTime();
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** `kimi-weekly` block — weekly quota window plus its end time. */
const renderKimiWeekly: BlockRenderer = (inputs) => {
  const row = inputs.kimiUsage?.weekly;
  if (!row) return "";
  const p = inputs.palette;
  const base = renderUsageWindow(row, p);
  const reset = formatResetTime(row.resetTime);
  if (!reset) return base;
  return `${base} ${p.GRAY}ends ${reset}${p.RESET}`;
};

/**
 * Shared renderer for the OpenCode Go usage-window blocks: a dim
 * label, the fill percent colored by level, and a progress bar. The
 * Go API exposes the fill directly (`percent`), unlike Kimi's
 * used/limit pair, so the bar is driven by that percentage.
 */
function renderGoWindow(row: GoWindowUsage, palette: Palette): string {
  const p = palette;
  const pct = Math.min(100, Math.max(0, row.percent));
  const color = pctColorFor(pct, p);
  const bar = buildBar(pct, color, p);
  return (
    `${p.GRAY}${row.label}${p.RESET} ${color}${pct}%${p.RESET} ` +
    `${p.GRAY}[${p.RESET}${bar}${p.GRAY}]${p.RESET}`
  );
}

/** `go-5h` block — OpenCode Go rolling 5-hour window. */
const renderGoFiveHour: BlockRenderer = (inputs) => {
  const row = inputs.goUsage?.rolling;
  if (!row) return "";
  return renderGoWindow(row, inputs.palette);
};

/** `go-weekly` block — OpenCode Go weekly window plus its end time. */
const renderGoWeekly: BlockRenderer = (inputs) => {
  const row = inputs.goUsage?.weekly;
  if (!row) return "";
  const p = inputs.palette;
  const base = renderGoWindow(row, p);
  const reset = formatResetTime(row.resetsAt);
  if (!reset) return base;
  return `${base} ${p.GRAY}ends ${reset}${p.RESET}`;
};

/** `go-monthly` block — OpenCode Go monthly window. */
const renderGoMonthly: BlockRenderer = (inputs) => {
  const row = inputs.goUsage?.monthly;
  if (!row) return "";
  return renderGoWindow(row, inputs.palette);
};

/** `cost` block — session total in USD; empty when zero. */
const renderCost: BlockRenderer = (inputs) => {
  const p = inputs.palette;
  if (inputs.cost <= 0) return "";
  return `${p.GRAY}\$${formatCost(inputs.cost)}${p.RESET}`;
};

/**
 * `tokens` block — `↑in ↓out R W`. Each counter is gated by both the
 * sub-toggle in `layout.tokens.*` AND a `> 0` check, so disabling a
 * counter hides it even when usage exists. Returns "" when every
 * gated counter is empty.
 */
const renderTokens: BlockRenderer = (inputs) => {
  const p = inputs.palette;
  const t = inputs.layout.tokens;
  const segments: string[] = [];
  if (t.input && inputs.totalInput > 0) segments.push(`↑${formatTokens(inputs.totalInput)}`);
  if (t.output && inputs.totalOutput > 0) segments.push(`↓${formatTokens(inputs.totalOutput)}`);
  if (t.cacheRead && inputs.totalCacheRead > 0) segments.push(`R${formatTokens(inputs.totalCacheRead)}`);
  if (t.cacheWrite && inputs.totalCacheWrite > 0) segments.push(`W${formatTokens(inputs.totalCacheWrite)}`);
  if (segments.length === 0) return "";
  return `${p.GRAY}${segments.join(" ")}${p.RESET}`;
};

/**
 * `throughput` block — output tokens/sec for the current or last
 * response. Live estimates (chars-based, while streaming) carry a "~"
 * prefix and the accent-adjacent cyan; settled values derived from real
 * usage are dim like the other counters. Empty when idle.
 */
const renderThroughput: BlockRenderer = (inputs) => {
  const t = inputs.throughput;
  if (!t || t.tokensPerSec <= 0) return "";
  const p = inputs.palette;
  const icon = resolveIcon(inputs.iconSet, "throughput");
  const rate = formatTokens(Math.round(t.tokensPerSec));
  if (t.phase === "streaming") return `${p.CYAN}${icon} ~${rate}/s${p.RESET}`;
  return `${p.GRAY}${icon} ${rate}/s${p.RESET}`;
};

/** Registry consulted by `composeStatusLine`. */
export const BLOCK_RENDERERS: Record<BlockId, BlockRenderer> = {
  model: renderModel,
  path: renderPath,
  git: renderGit,
  context: renderContext,
  "kimi-5h": renderKimiFiveHour,
  "kimi-weekly": renderKimiWeekly,
  "go-5h": renderGoFiveHour,
  "go-weekly": renderGoWeekly,
  "go-monthly": renderGoMonthly,
  cost: renderCost,
  tokens: renderTokens,
  throughput: renderThroughput,
};

// ─────────────────────────────────────────────────────────────────────
// Composer
// ─────────────────────────────────────────────────────────────────────

/**
 * Walk `layout.order`, render each enabled block, drop empty results,
 * and join with the configured separator glyph wrapped in spaces. The
 * leading `─ ` divider is always first; a trailing space caps the row
 * so subsequent truncation logic in the widget matches the historical
 * output's tail.
 */
export function composeStatusLine(layout: LayoutConfig, inputs: RenderInputs): string {
  const p = inputs.palette;
  const parts: string[] = [];
  for (const id of layout.order) {
    if (!layout.enabled[id]) continue;
    const renderer = BLOCK_RENDERERS[id];
    if (!renderer) continue;
    const piece = renderer(inputs);
    if (piece.length === 0) continue;
    parts.push(piece);
  }
  const sep = ` ${p.GRAY}${layout.separator}${p.RESET} `;
  return `${p.GRAY}─${p.RESET} ${parts.join(sep)} `;
}
