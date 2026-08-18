# pi-statusline

Theme-adaptive statusline for [pi](https://github.com/earendil-works/pi).
Forked from [`@wierdbytes/pi-statusline`](https://github.com/wierdbytes/pi-wierd-stuff) (MIT),
trimmed to the rendering core, with colors derived from the **active pi
theme** instead of a hardcoded palette — the statusline follows `/theme`
switches and custom user themes.

Renders a compact one-line status row above the editor, with the editor's
top/bottom borders stripped so the two visually merge:

```
─ 🤖 Kimi K3 🧠 high │ …/abei/Code/spark │ master ✓ │ 12%: 127k[▓░░░░░░░░░]893k │ 5h 43%[▓▓▓▓░░░░░░] │ wk 9%[▓░░░░░░░░░] │ $2.02 │ ↑639k ↓88k R6.3M
```

Blocks (left to right, all auto-hide when irrelevant):

- **Model** — icon + display name, with an inline thinking-level segment
  for reasoning-capable models. Thinking colors use the theme's
  `thinkingOff`…`thinkingMax` tokens.
- **Path** — last three segments of `cwd`, current directory accented.
- **Git** — branch + clean/dirty marker (`✓` success / `✗` error).
- **Context** — percentage of the usable context window before
  autocompaction (33k buffer reserved), with a progress bar that shifts
  success → warning → error as it fills.
- **Kimi 5h / Kimi weekly** — Kimi Coding subscription quota windows
  (short rate-limit window and weekly window), shown only when the
  active model is served by Kimi. Polled from the `/usages` API once a
  minute using the `kimi-coding` OAuth token from `~/.pi/agent/auth.json`.
- **Go 5h / Go weekly / Go monthly** — OpenCode Go plan quota windows
  (rolling 5h, weekly, monthly), shown only when the active model is
  served by the `opencode-go` provider. Polled from the `/usage` API
  once a minute using the `opencode-go` API key from
  `~/.pi/agent/auth.json`; the weekly block also shows when the window
  ends.
- **Cost** — session total in USD when greater than zero.
- **Tokens** — cumulative `↑input ↓output R{cacheRead} W{cacheWrite}`.
- **Throughput** — output tokens/sec. While a response streams this is
  a live estimate from streamed text length (marked `~`, cyan) since
  providers only report usage at the end; once the response finishes
  the real `usage.output` over the streaming time is shown (dim) until
  the next response starts.

## What changed vs. the original

- **Theme-adaptive colors.** The original hardcoded Tokyo Night Storm ANSI
  constants; here every color comes from `Theme.getFgAnsi(...)` at render
  time (see `paletteFromTheme` in `blocks.ts`).
- **Trimmed scope.** Dropped the settings modal, prompt stash, notify
  chips/toasts, subagents bridge, and the fixed-editor compositor. The
  `thinking=max` rainbow gradient was simplified to the theme's solid
  `thinkingMax` color.

## Theme token mapping

| Slot | Theme token | Used for |
|---|---|---|
| `ERROR` | `error` | dirty git marker, context bar > 80% |
| `WARNING` | `warning` | context bar > 60% |
| `SUCCESS` | `success` | clean git marker, context bar ≤ 60% |
| `CYAN` | `syntaxType` | git branch, live throughput |
| `BLUE` | `syntaxKeyword` | (reserved) |
| `PURPLE` | `customMessageLabel` | current directory |
| `ACCENT` | `accent` | model name |
| `GRAY` | `dim` | separators, path parents, cost, tokens, settled throughput |
| `THINK.*` | `thinkingOff`…`thinkingMax` | thinking-level segment |

## Install

Add the local path to `~/.pi/agent/settings.json` (loaded without copying;
restart pi after edits):

```json
{
  "packages": ["~/Code/pi-statusline"]
}
```

## Configuration (optional)

`~/.pi/agent/pi-statusline.json`:

```json
{
  "iconSet": "nerd-font",
  "layout": {
    "order": ["model", "path", "git", "context", "kimi-5h", "kimi-weekly", "cost", "tokens", "throughput"],
    "enabled": { "cost": false },
    "separator": "│",
    "model": { "showThinking": true },
    "tokens": { "input": true, "output": true, "cacheRead": true, "cacheWrite": true }
  }
}
```

`iconSet`: `nerd-font` (default), `plain`, `ascii`, `minimal`, `emoji`.
Missing/invalid fields fall back to defaults; unknown block ids are dropped
and missing ones appended.

## Development

```bash
npm install
npx tsc --noEmit        # typecheck
node --test             # unit tests
```
