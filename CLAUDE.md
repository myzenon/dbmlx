# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**DBML Extension** (`dbmlx`) is a VSCode extension that visualizes `.dbmlx` schema files as interactive diagrams with persistent, Git-friendly layouts. DDD-aware: `TableGroup` maps to bounded contexts (collapse/hide).

`.dbmlx` is a superset of DBML: adds `!include`, `DiagramView`, and migration diff annotations:
- `[add]` — column or whole table is new (green + `+NEW` badge)
- `[drop]` — column or whole table removed (red strikethrough + `DROP` badge)
- `[modify: key=value, ...]` — column changed; keys: `name`, `type`, `default`, `pk`, `not_null`, `unique`, `increment` (all store the **old** value)
- `Ref: a.col > b.col [add]` / `[drop]` — top-level ref is new/dropped (shown as green/red line)
- `col type [add ref: > target.col]` — inline ref is new; `[drop ref: > target.col]` — inline ref dropped
  - `add`/`drop` must be a **prefix of the ref item** (no comma between): `[pk, add ref: > t.id]`
  - Standalone `[add]` or trailing `, add` after a ref remain column-level (backward compat)
  - Ref migration (drop old + add new): `[add ref: > new.id, drop ref: > old.id]`

`[add]`/`[drop]` on the `Table` declaration line marks the whole table.

Key differentiators: layout in sidecar `.layout.json` (stable JSON, Git-friendly), `TableGroup` collapse/hide, viewport culling + LOD for 5000+ tables at 60fps.

## Commands

```bash
pnpm install          # install deps (pnpm only — never npm/yarn)
pnpm run build        # build extension host + webview
pnpm run watch:extension   # esbuild --watch
pnpm run watch:webview     # vite --watch
pnpm run typecheck    # type check only
pnpm run test         # vitest one-shot
pnpm run test:watch   # vitest interactive
pnpm run package      # build .vsix
# F5 in VSCode → Extension Development Host
```

## Architecture

Two isolated runtimes communicating via `postMessage` (types in `src/shared/types.ts`):
- **Extension Host** (`src/extension/`): parses dbmlx, reads/writes layout JSON, file watchers
- **Webview** (`src/webview/`): Preact rendering, spatial index, viewport culling, drag, LOD, edge routing

### Key files

| File | Purpose |
|---|---|
| `src/extension/panel.ts` | `DiagramPanel` singleton per file — webview lifecycle |
| `src/extension/parser.ts` | `@dbml/core` wrapper; returns `{schema, error}` |
| `src/extension/layoutStore.ts` | Atomic read/write of `.layout.json`; stable-ordered JSON |
| `src/webview/state/store.ts` | Zustand store; granular selectors |
| `src/webview/render/spatialIndex.ts` | 512×512px grid bucketing; `insert/remove/query(bbox)` |
| `src/webview/render/edgeRouter.ts` | Manhattan ortho routing (max 2 elbows); source- and target-side convergence merges FK lines that share an endpoint column into a trunk with a junction dot |
| `src/webview/render/lod.ts` | Zoom thresholds: `full` ≥0.6, `header` 0.3–0.6, `rect` <0.3 |
| `src/webview/drag/dragController.ts` | Direct DOM mutation during drag; commits to store on `pointerup` |
| `src/webview/layout/autoLayout.ts` | Dagre top-down; runs only for tables lacking a saved position |
| `src/webview/groups/groupPanel.tsx` | Group list UI; collapse/hide toggles; color swatch is the color picker |

### Table header action icons

`.ddd-table__actions` (absolute, right edge of header) fades in on `.is-hovered` (set on `TableNode` outer div). Three buttons: **ⓘ info** (click-to-toggle tooltip with full/rename name), **go-to-definition**, **palette**. Names >20 chars are mid-truncated via `midTruncate()`; rename diffs truncate each side to 10.

### Layout file format

Keys alphabetically sorted, integers for coords, `collapsed: false`/`hidden: false` omitted, colors only when custom. Written atomically (tmp → rename). Roundtrip must be byte-identical.

## Export sync rule — MANDATORY

`src/webview/render/exportSvg.ts` is a **standalone SVG/PNG path** — does NOT share Preact components. Every visual change to the live diagram **must** be mirrored in `exportSvg.ts` in the same task. Missed twice, caused bugs.

**Keep in sync:** table heights (`tableActualHeight(t)`), column Y positions (`colRowY(t, ci)`), all column visual states (add/drop/modify, PK icons, badges), edge bboxes in `bboxOf`, table decorations, edge markers/cardinality labels, convergence junction dots (`convergeJunction`).

**Trigger:** any change to `tableNode.tsx`, `edgeLayer.tsx`, `edgeRouter.ts`, or any new visual state on tables/columns/edges.

## Notes

- **pnpm only** — never npm or yarn
- `@dbml/core` runs in extension host only — not in webview
- `@dagrejs/dagre` runs in webview only
- Drag uses direct DOM mutation — do not move into the render cycle
- Spatial index must never rebuild on viewport change — only on `schema` or `positions` changes
- Specs in `specs/` are written in Spanish
