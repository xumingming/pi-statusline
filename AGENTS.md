# pi-statusline — Project Instructions

Theme-adaptive statusline extension for the pi coding agent. Renders a
compact one-line status row above the editor; all colors come from the
active pi theme at render time.

## Layout

- `index.ts` — extension entry: widget registration, stats gathering,
  custom editor (border stripping), event wiring.
- `blocks.ts` — per-block renderers + `composeStatusLine`. Blocks are
  pure functions of `RenderInputs`; "" means "skip me".
- `layout-config.ts` — block order/visibility/sub-toggles and their
  normalisation against defaults.
- `icons.ts` — icon-set registry (nerd-font / plain / ascii / minimal /
  emoji).
- `git-status.ts` — git branch/dirty with TTL cache.
- `kimi-usage.ts` — Kimi Coding `/usages` quota windows (5h + weekly)
  with TTL cache.
- `test/` — `node:test` unit tests.

## Definition of Done

After any code change, run all three:

1. `npx tsc --noEmit` — typecheck.
2. `node --test` — unit tests (note: `node --test test/` does NOT work
   on Node 22; use plain `node --test` or pass explicit file paths).
3. Non-ASCII spot check for newly added characters — the established
   set (box-drawing `─│`, bar glyphs `▓░`, arrows `↑↓`, `✓✗`, `…`,
   em-dash in comments) is fine; don't introduce new ones casually.

There is no linter configured; match the existing style (2-space
indent, double quotes, semicolons, JSDoc on exported symbols).

## Conventions

- **Adding a block**: add its id to `KNOWN_BLOCK_IDS` in `blocks.ts`,
  write a renderer, register it in `BLOCK_RENDERERS`, add the
  `enabled` default in `layout-config.ts`, and cover it with tests.
  Layout normalisation auto-appends new ids to existing user configs.
- **Colors**: never hardcode ANSI codes in renderers — always go
  through the `Palette` from `paletteFromTheme`.
- **External I/O** (git, HTTP): follow the stale-while-revalidate
  pattern — a synchronous getter returning the TTL-cached value that
  kicks off a background refresh, with an update listener so the
  widget repaints when fresh data lands. Never block render on I/O.
- **Tests**: add the test first when fixing a bug; verify it fails
  before applying the fix.

## Sensitive Information Check (required before every commit)

This project handles Kimi OAuth credentials **at runtime only** —
nothing credential-shaped may ever be committed. Before `git add`,
scan the pending diff:

```bash
git diff > /tmp/diff.txt   # plus contents of any new untracked files
grep -nE "eyJ[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]|Bearer [A-Za-z0-9]" /tmp/diff.txt
```

The scan must come back empty. Also check for real account
identifiers (user ids, token ids, device ids) if a fixture was
derived from a live API response.

Rules:

- Credentials are read at runtime from `~/.pi/agent/auth.json` or env
  vars (`KIMI_API_KEY`). Never hardcode tokens, keys, or real account
  ids in source, tests, fixtures, or docs.
- Test fixtures based on live API responses must be sanitized:
  replace user ids / token ids / device ids with placeholders (e.g.
  `"u1"`) and use clearly fictional timestamps.
- `~/.pi/agent/auth.json` itself must never be added to the repo
  (it lives outside the project; keep it that way).
