/**
 * pi-statusline — compact one-line statusline for pi.
 *
 * Forked from @wierdbytes/pi-statusline (MIT), trimmed to the rendering
 * core: model/thinking, path, git, context, cost, tokens. Colors are
 * derived from the active pi theme at render time (see blocks.ts), so
 * the statusline follows `/theme` switches and custom user themes.
 *
 * What was dropped from the original: the settings modal, prompt stash,
 * notify chips/toasts, subagents bridge, and the fixed-editor
 * compositor. The layout + icon set are configurable via an optional
 * JSON file at ~/.pi/agent/pi-statusline.json:
 *
 *   {
 *     "iconSet": "nerd-font" | "plain" | "ascii" | "minimal" | "emoji",
 *     "layout": { "order": [...], "enabled": {...}, "separator": "│", ... }
 *   }
 */

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { Component, EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  composeStatusLine,
  paletteFromTheme,
  shortenModelName,
  type RenderInputs,
} from "./blocks.ts";
import { getGitStatus, invalidateGitStatus } from "./git-status.ts";
import { DEFAULT_ICON_SET, isIconSet, type IconSet } from "./icons.ts";
import { cloneDefaultLayout, normaliseLayoutConfig, type LayoutConfig } from "./layout-config.ts";

const PROMPT_PADDING = 0;

// ─────────────────────────────────────────────────────────────────────
// Optional JSON config (~/.pi/agent/pi-statusline.json)
// ─────────────────────────────────────────────────────────────────────

interface StatuslineConfig {
  layout: LayoutConfig;
  iconSet: IconSet;
}

function configPath(): string {
  return join(process.env.HOME || homedir(), ".pi", "agent", "pi-statusline.json");
}

function loadConfig(): StatuslineConfig {
  const fallback: StatuslineConfig = {
    layout: cloneDefaultLayout(),
    iconSet: DEFAULT_ICON_SET,
  };
  try {
    const path = configPath();
    if (!existsSync(path)) return fallback;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return {
      layout: normaliseLayoutConfig(raw?.layout),
      iconSet: isIconSet(raw?.iconSet) ? raw.iconSet : DEFAULT_ICON_SET,
    };
  } catch {
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Stats gathering (sums over the current session branch)
// ─────────────────────────────────────────────────────────────────────

function gatherStats(ctx: ExtensionContext) {
  let cost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let lastAssistant: AssistantMessage | undefined;

  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type === "message" && e.message.role === "assistant") {
      const m = e.message as AssistantMessage;
      cost += m.usage.cost.total;
      totalInput += m.usage.input;
      totalOutput += m.usage.output;
      totalCacheRead += m.usage.cacheRead;
      totalCacheWrite += m.usage.cacheWrite;
      if (
        m.usage.input + m.usage.output + m.usage.cacheRead + m.usage.cacheWrite > 0
      ) {
        lastAssistant = m;
      }
    }
  }

  return { cost, totalInput, totalOutput, totalCacheRead, totalCacheWrite, lastAssistant };
}

// ─────────────────────────────────────────────────────────────────────
// Widget render
// ─────────────────────────────────────────────────────────────────────

function renderStatusContent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: StatuslineConfig,
  width: number,
): string[] {
  const palette = paletteFromTheme(ctx.ui.theme);
  const stats = gatherStats(ctx);
  const contextWindow =
    ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const current = stats.lastAssistant
    ? stats.lastAssistant.usage.input +
      stats.lastAssistant.usage.cacheRead +
      stats.lastAssistant.usage.cacheWrite
    : 0;
  const git = getGitStatus(ctx.cwd);

  const model = ctx.model as Model<any> | undefined;
  const inputs: RenderInputs = {
    palette,
    cwd: ctx.cwd,
    branch: git.branch,
    dirty: git.dirty,
    current,
    contextWindow,
    cost: stats.cost,
    modelName: shortenModelName(ctx.model),
    thinkingLevel: pi.getThinkingLevel(),
    thinkingLevelMap: model?.thinkingLevelMap,
    modelReasoning: ctx.model?.reasoning ?? false,
    totalInput: stats.totalInput,
    totalOutput: stats.totalOutput,
    totalCacheRead: stats.totalCacheRead,
    totalCacheWrite: stats.totalCacheWrite,
    iconSet: config.iconSet,
    layout: config.layout,
  };
  const status = composeStatusLine(config.layout, inputs);

  const truncated = truncateToWidth(status, width);
  const fillWidth = Math.max(0, width - visibleWidth(truncated));
  return [truncated + `${palette.GRAY}${"─".repeat(fillWidth)}${palette.RESET}`];
}

// ─────────────────────────────────────────────────────────────────────
// Custom editor (strips top/bottom borders so the statusline row and
// the editor visually merge into a single cluster)
// ─────────────────────────────────────────────────────────────────────

function makeEditorFactory(
  setActiveTui: (tui: TUI | undefined) => void,
): (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent {
  return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
    setActiveTui(tui);

    class StatuslineEditor extends CustomEditor {
      constructor() {
        super(tui, theme, keybindings, { paddingX: PROMPT_PADDING });
      }

      setPaddingX(_value: number): void {
        super.setPaddingX(PROMPT_PADDING);
      }

      render(width: number): string[] {
        const lines = super.render(width);
        if (lines.length === 0) return lines;

        const stripAnsi = (s: string) =>
          s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "");
        const isBorder = (s: string) => /^[─━]+\s*$/.test(s);

        if (isBorder(stripAnsi(lines[0]))) lines.shift();

        for (let i = lines.length - 1; i >= 0; i--) {
          if (isBorder(stripAnsi(lines[i]))) {
            lines.splice(i, 1);
            break;
          }
        }

        return lines;
      }
    }

    return new StatuslineEditor();
  };
}

class EmptyFooter implements Component {
  render(): string[] {
    return [];
  }
  invalidate(): void {}
}

// ─────────────────────────────────────────────────────────────────────
// Extension entry
// ─────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let activeTui: TUI | undefined;
  let config: StatuslineConfig = loadConfig();

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    config = loadConfig();

    ctx.ui.setWidget(
      "pi-statusline",
      () => ({
        dispose() {},
        invalidate() {},
        render(width: number): string[] {
          return renderStatusContent(pi, ctx, config, width);
        },
      }),
      { placement: "aboveEditor" },
    );
    ctx.ui.setEditorComponent(makeEditorFactory((tui) => {
      activeTui = tui;
    }));
    ctx.ui.setFooter(() => new EmptyFooter());
    activeTui?.requestRender();
  });

  pi.on("session_shutdown", async () => {
    activeTui = undefined;
  });

  // Token/cost stats change at the end of each turn.
  pi.on("agent_end", async () => {
    activeTui?.requestRender();
  });

  // Tool calls may change git state (files written, branch switched).
  pi.on("tool_result", async () => {
    invalidateGitStatus();
    activeTui?.requestRender();
  });

  pi.on("thinking_level_select", async () => {
    activeTui?.requestRender();
  });
}
