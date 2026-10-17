/**
 * pi-statusline — `/model-with-pricing-multiplier` companion model picker.
 *
 * The built-in `/model` selector renders hard-coded rows and cannot be
 * decorated, so this module registers a parallel
 * `/model-with-pricing-multiplier` command listing every available chat
 * model as `<id> [<provider>] (<cost multiple>)`, current model first.
 * In the TUI the picker is a custom editor (see PickerEditor) with a
 * windowed list, fuzzy search, and arrow-key navigation — the generic
 * ui.select() dialog renders every row and overflows with long catalogs.
 * In RPC mode it falls back to ui.select(). Picking a row switches the
 * session model via `pi.setModel()`.
 */

import {
  CustomEditor,
  type ExtensionAPI,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { fuzzyFilter, truncateToWidth } from "@earendil-works/pi-tui";

import {
  findBaselineCost,
  modelCostRatio,
  paletteFromTheme,
  readModelCostRates,
  type ModelCostRates,
  type Palette,
} from "./blocks.ts";

/** Rows shown at once; the window slides to follow the selection. */
const MAX_VISIBLE = 10;

/** Same shape pi's `setEditorComponent` expects; not re-exported by the package. */
type EditorFactory = (
  tui: TUI,
  theme: EditorTheme,
  keybindings: KeybindingsManager,
) => EditorComponent;

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

/** Visible slice of a list of `length` rows when row `selected` is highlighted. */
export function visibleWindow(
  length: number,
  selected: number,
  maxVisible: number,
): { start: number; end: number } {
  const start = Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), length - maxVisible));
  return { start, end: Math.min(start + maxVisible, length) };
}

/**
 * Fuzzy-filter rows the same way `/model` ranks its list: characters
 * in order, whitespace/slash tokens all must match, best first.
 */
export function fuzzyFilterLabels(labels: readonly string[], query: string): string[] {
  const q = query.trim();
  if (!q) return [...labels];
  return fuzzyFilter([...labels], q, (label) => label);
}

interface PickerCallbacks {
  onPick(label: string): void;
  /** Restore the normal editor and repaint; called on pick and cancel. */
  onClose(): void;
}

/**
 * Editor swapped in while the picker is open. Renders a windowed list
 * that follows the selection, buffers printable keys as a filter, and
 * swallows everything else so no text editing leaks through.
 */
class PickerEditor extends CustomEditor {
  private kb: KeybindingsManager;
  private query = "";
  private visible: string[];
  private selectedIndex = 0;
  private pickerTitle: string;
  private allLabels: string[];
  private palette: Palette;
  private callbacks: PickerCallbacks;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    pickerTitle: string,
    allLabels: string[],
    palette: Palette,
    callbacks: PickerCallbacks,
  ) {
    super(tui, theme, keybindings, { paddingX: 0 });
    this.kb = keybindings;
    this.pickerTitle = pickerTitle;
    this.allLabels = allLabels;
    this.palette = palette;
    this.callbacks = callbacks;
    this.visible = allLabels;
  }

  handleInput(data: string): void {
    if (this.kb.matches(data, "tui.select.up")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (this.kb.matches(data, "tui.select.down")) {
      this.selectedIndex = Math.min(this.visible.length - 1, this.selectedIndex + 1);
    } else if (this.kb.matches(data, "tui.select.confirm") || data === "\n") {
      const label = this.visible[this.selectedIndex];
      this.callbacks.onClose();
      if (label !== undefined) this.callbacks.onPick(label);
      return;
    } else if (this.kb.matches(data, "tui.select.cancel")) {
      this.callbacks.onClose();
      return;
    } else if (data === "\x7f" || data === "\b") {
      if (this.query) this.refilter(this.query.slice(0, -1));
    } else if (data.length === 1 && data >= " ") {
      this.refilter(this.query + data);
    }
    this.tui.requestRender();
  }

  private refilter(query: string): void {
    this.query = query;
    this.visible = fuzzyFilterLabels(this.allLabels, query);
    this.selectedIndex = 0;
  }

  render(width: number): string[] {
    const p = this.palette;
    const position = this.visible.length
      ? `(${this.selectedIndex + 1}/${this.visible.length})`
      : "(0/0)";
    const filter = this.query ? `  filter: ${this.query}` : "";
    const lines = [
      `${p.ACCENT}${this.pickerTitle}${p.RESET}${filter} ${p.GRAY}${position}${p.RESET}`,
    ];
    const { start, end } = visibleWindow(this.visible.length, this.selectedIndex, MAX_VISIBLE);
    for (let i = start; i < end; i++) {
      const row = i === this.selectedIndex ? `→ ${this.visible[i]}` : `  ${this.visible[i]}`;
      const colored =
        i === this.selectedIndex
          ? `${p.ACCENT}${row}${p.RESET}`
          : `${p.GRAY}${row}${p.RESET}`;
      lines.push(truncateToWidth(colored, width));
    }
    if (this.visible.length === 0) lines.push(`${p.GRAY}  no matching models${p.RESET}`);
    lines.push(`${p.GRAY}type to fuzzy search, ↑↓ move, Enter select, Esc cancel${p.RESET}`);
    return lines;
  }
}

/**
 * Register the `/model-with-pricing-multiplier` command. `getCostBaseline`
 * supplies the configured baseline id (default `deepseek-flash`) at
 * invocation time, so a config reload is picked up without restarting.
 * `editorFactory` + `repaint` restore the statusline editor when the
 * picker closes.
 */
export function registerModelPicker(
  pi: ExtensionAPI,
  getCostBaseline: () => string,
  editorFactory: EditorFactory,
  repaint: () => void,
): void {
  pi.registerCommand("model-with-pricing-multiplier", {
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
      const title = `Select model — multiple vs ${baseline}`;
      const labels = options.map((o) => o.label);

      const pick = async (label: string) => {
        const option = options.find((o) => o.label === label);
        if (!option) return;
        const ok = await pi.setModel(option.model);
        if (!ok) {
          ctx.ui.notify(`Auth is not configured for [${option.model.provider}]`, "warning");
        }
      };
      const finish = () => {
        ctx.ui.setEditorComponent((tui, theme, keybindings) => {
          const editor = editorFactory(tui, theme, keybindings);
          tui.setFocus(editor);
          return editor;
        });
        repaint();
      };

      if (ctx.mode !== "tui") {
        const picked = await ctx.ui.select(title, labels);
        if (picked !== undefined) await pick(picked);
        return;
      }
      const palette = paletteFromTheme(ctx.ui.theme);
      ctx.ui.setEditorComponent((tui, theme, keybindings) => {
        const editor = new PickerEditor(tui, theme, keybindings, title, labels, palette, {
          onPick: (label) => void pick(label),
          onClose: finish,
        });
        tui.setFocus(editor);
        return editor;
      });
      repaint();
    },
  });
}
