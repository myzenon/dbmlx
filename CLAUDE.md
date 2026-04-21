# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**DBML Extension** (`dbmlx`) is a VSCode extension that visualizes `.dbmlx` database schema files as interactive diagrams with persistent, Git-friendly table layouts. It is DDD-aware: `TableGroup` in dbmlx maps to bounded contexts that can be collapsed or hidden.

The `.dbmlx` language is a superset of DBML: all standard DBML syntax is valid, plus `!include`, `DiagramView`, and migration diff annotations (`[add]`, `[drop]`, `[modify: ...]`).

Migration diff annotations — write column in its **new** state, record old values in the annotation:
- `[add]` — column or **entire table** is new (green accent / green border + `+NEW` badge)
- `[drop]` — column or **entire table** is removed (red strikethrough / red border + `DROP` badge)
- `[modify: key=value, ...]` — column was changed; before/after diff rendered in amber

`[add]`/`[drop]` on the `Table` declaration line marks the whole table:
```dbmlx
Table audit_log [add] { ... }   // whole table is new
Table old_cache [drop] { ... }  // whole table is removed
```

`modify:` keys (all optional, any order, combine freely with standard settings like `[pk, not null, modify: ...]`):

| Key | Format | Meaning |
|---|---|---|
| `name` | `name="old"` | column was named this before |
| `type` | `type="old"` | column had this type before |
| `default` | `default="old"` | column had this default before |
| `pk` | `pk=true\|false` | pk status before the change |
| `not_null` | `not_null=true\|false` | not-null status before |
| `unique` | `unique=true\|false` | unique status before |
| `increment` | `increment=true\|false` | auto-increment status before |

Key differentiators over existing extensions:
- Layout persisted in a sidecar `<name>.dbmlx.layout.json` with stable-ordered JSON (Git-friendly diffs)
- `TableGroup` collapse to single box-node + hide
- Viewport culling + LOD rendering targeting 5000+ tables at 60fps

## Commands

```bash
# Install dependencies (pnpm required)
pnpm install

# Build everything (extension host + webview)
pnpm run build

# Watch mode for development
pnpm run watch:extension   # esbuild --watch on extension host
pnpm run watch:webview     # vite --watch on webview

# Type checking only (no emit)
pnpm run typecheck

# Tests
pnpm run test              # vitest run (one-shot)
pnpm run test:watch        # vitest in interactive mode

# Package as .vsix
pnpm run package

# Launch dev environment
# Press F5 in VSCode to launch Extension Development Host
```

## Architecture

### Two isolated runtimes

```
Extension Host (Node.js)          Webview (Chromium sandbox)
  src/extension/                    src/webview/
  - Parses dbmlx (@dbml/core)       - Renders diagram (Preact)
  - Reads/writes layout JSON        - Spatial index + viewport culling
  - File system watchers            - Drag, LOD, edge routing
       ↕ postMessage (JSON)
  src/shared/types.ts  ← shared TypeScript types
```

The webview has no direct FS access. All I/O goes through `postMessage` typed in `src/shared/types.ts`.

### Host → Webview messages
- `schema:update` — parsed schema after dbmlx save
- `layout:loaded` — sidecar JSON on open
- `layout:external-change` — sidecar changed externally (git pull)
- `theme:change` — VSCode theme switch

### Webview → Host messages
- `ready` — webview initialized
- `layout:persist` — position deltas, debounced 300ms
- `command:reveal` — click table → go-to-definition in editor
- `error:log` — errors from webview to host

### Key files

| File | Purpose |
|---|---|
| `src/extension/panel.ts` | `DiagramPanel` singleton per file — webview lifecycle |
| `src/extension/parser.ts` | `@dbml/core` wrapper; returns `{schema, error}` |
| `src/extension/layoutStore.ts` | Atomic read/write of `.layout.json`; stable-ordered JSON |
| `src/webview/state/store.ts` | Zustand store; granular selectors |
| `src/webview/render/spatialIndex.ts` | 512×512px grid bucketing; `insert/remove/query(bbox)` |
| `src/webview/render/edgeRouter.ts` | Manhattan ortho routing (max 2 elbows) |
| `src/webview/render/lod.ts` | Zoom thresholds: `full` ≥0.6, `header` 0.3–0.6, `rect` <0.3 |
| `src/webview/drag/dragController.ts` | Direct DOM mutation during drag; commits to store on `pointerup` |
| `src/webview/layout/autoLayout.ts` | Dagre top-down; runs only for tables lacking a saved position |
| `src/webview/groups/groupPanel.tsx` | Group list UI; collapse/hide toggles |

### Layout file format

Sidecar `schema.dbmlx.layout.json` — keys alphabetically sorted, integers for coords, `collapsed: false` / `hidden: false` omitted, colors only written when custom. Written atomically (tmp → rename). Roundtrip must be byte-identical (tested).

```json
{
  "version": 1,
  "viewport": { "x": 0, "y": 0, "zoom": 1.0 },
  "tables": { "public.users": { "x": 120, "y": 80 } },
  "groups": { "billing": { "collapsed": true, "color": "#D0E8FF" } }
}
```

### Rendering pipeline

1. Schema update → store
2. New tables without positions → dagre auto-layout (effect, not render path)
3. `positions` or `schema` change → rebuild spatial index
4. Viewport change → query spatial index (bbox + 256px margin) → `visibleNames`
5. Render: filter `schema.tables` by `visibleNames`; `edgeLayer` filters refs similarly
6. LOD per table based on zoom; drag bypasses Preact via direct DOM mutation

### Performance targets

- 60fps pan/zoom with 5000 tables
- Webview bundle gzipped < 40KB (Preact not React, Zustand vanilla)
- Layout write < 50ms (atomic I/O)

## Test fixtures

| Fixture | Tables | Use |
|---|---|---|
| `test/fixtures/tiny.dbmlx` | 5 | smoke tests |
| `test/fixtures/medium.dbmlx` | ~200 | daily regression |
| `test/fixtures/huge.dbmlx` | ~5000 | stress test (generated) |

## Export sync rule — MANDATORY

`src/webview/render/exportSvg.ts` is a **completely standalone SVG/PNG rendering path** that does NOT share Preact components with the live webview. Every time the live diagram rendering changes, `exportSvg.ts` **must** be updated in the same task to match. This has been missed twice and caused bugs.

**What to keep in sync:**
- Table height: use `tableActualHeight(t)` (not `estimateSize(colCount)`) whenever rows have variable height
- Column Y positions: use `colRowY(t, ci)` (not `i * TABLE_ROW_H`) to accumulate variable-height rows
- All column visual states: migration diff (add/drop/modify), PK icons, badges, etc.
- Edge bounding boxes in `bboxOf` must use the actual table height — wrong height misaligns edge attachment points
- Table decorations: color accents, change badges, group containers
- Edge markers and cardinality labels

**Trigger:** Any change to `tableNode.tsx`, `edgeLayer.tsx`, `edgeRouter.ts`, or any new visual state on tables/columns/edges.

## Notes

- **pnpm only** — do not use npm or yarn
- `@dbml/core` runs in the extension host only; it is not bundled into the webview
- `@dagrejs/dagre` runs in the webview; keep it there; move to Web Worker only if initial layout causes jank
- Drag uses direct DOM mutation (`transform` style) and only calls the Zustand store on `pointerup` — do not move this logic into the render cycle
- Spatial index must never rebuild on viewport change (pan/zoom) — only on `schema` or `positions` changes
- The specs in `specs/` are written in Spanish; translations are summarized in this file
