# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**DBML Extension** (`dbmlx`) is a VSCode extension that visualizes `.dbmlx` schema files as interactive diagrams with persistent, Git-friendly layouts. DDD-aware: `TableGroup` maps to bounded contexts (collapse/hide).

`.dbmlx` is a superset of DBML: adds `!include`, `DiagramView`, and migration diff annotations:
- `[add]` — column or whole table is new (green + `+NEW` badge)
- `[drop]` — column or whole table removed (red strikethrough + `DROP` badge)
- `[modify: key=value, ...]` — column changed; keys: `name`, `type`, `default`, `pk`, `not_null`, `unique`, `increment` (all store the **old** value)
- `[before: key=value, ...]` — explicit alias for `modify:`, same keys, same behavior; preferred for clarity
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

### Column hover highlight

`hoveredColKey: string | null` in Zustand store (`tableName + '\x1f' + colName`). Set on `pointerenter`/`pointerleave` in `ColumnRow`. `app.tsx` builds `colHighlights: Map<table, Set<col>>` (all connected FK endpoints) from `schema.refs`; passed as `highlightedCols` to each `TableNode`. `edgeLayer.tsx` computes `hlEdgeIds` and adds `ddd-edge-grp--hl` / `ddd-edge-grp--dim` classes to edges and junction circles. Pure CSS, no re-routing on hover.

### Edge hover tooltip

`hoveredEdgeRef: Ref | null` + `edgeTooltipPos` in Zustand store. Each edge `<g>` in `edgeLayer.tsx` has a wide transparent hit-area path (stroke-width 12, `pointer-events: stroke`) that calls `store.getState().setHoveredEdgeRef(ref, {x, y})` on mouse enter/move and clears on leave. `<EdgeTooltip>` in `app.tsx` renders a `position: fixed` div at the mouse position showing `source.col → target.col` and cardinality.

### CodeLens

`DbmlxCodeLensProvider` in `lspProviders.ts` scans each line for `TABLE_HEADER_RE` and emits a `$(go-to-file) Focus in diagram` lens. The command `dbmlx.focusTableInDiagram(rawName)` in `extension.ts` strips quotes, then calls `DiagramPanel.findTableAndPanel([stripped, public.${stripped}])` — which walks every open panel, asks each one's *own* resolved schema (`index.getResolvedSchema(panel.dbmlUri)`), and prefers the active panel. This works whether each diagram was opened on a root file or an `!include`d module file. The matched panel runs `focusTableInDiagram(table.name)` → `postMessage diagram:focusTable` → `focusTable()` in `viewport.ts`.

### Ref add/drop marks FK-holder as modified

`app.tsx` builds `refChangeCountByTable: Map<QualifiedName, number>` from `schema.refs`: each ref with `refChange` increments the count on the FK-holder side (endpoint with `relation === '*'`); 1:1 / M:M (no clear FK holder) increments both endpoints. Passed as `refChangeCount` to `TableNode`, where it's added to `Object.keys(columnChanges).length` to drive the amber `ddd-table--changed` border + numeric badge. `groupPanel.tsx` mirrors the logic for the "modified" annotation filter. `exportSvg.ts` mirrors it for PNG/SVG export.

### Group panel focus menu

`TableRow` in `groupPanel.tsx` — clicking the focus icon opens an inline `FocusMenu` (fixed-positioned popup, click-outside / Esc to close). Two items: *Focus in diagram* (`focusTable(name)`) and *Focus in code* (`postToHost({ type: 'command:reveal' })` — same path the in-diagram go-to-file icon uses). Clicking the table name itself still single-clicks to focus the diagram.

### DiagramView → Group panel sync

`app.tsx` computes `viewAllowed: Set<string> | null` (null = no active view) from `rawSchema` + `activeView`. This is passed to `<GroupPanel viewAllowed={viewAllowed}>`. `GroupPanel` and `GroupRow` use it to: hide groups with zero in-scope tables, show only in-scope tables within each group's list, and reflect the scoped count in the group badge. `filteredUngrouped` also applies the same filter. The underlying store schema is unchanged — view filtering is purely presentational.

### Ref ↔ inline ref Code Actions

Two providers in `lspProviders.ts` offer `RefactorRewrite` actions:

- `DbmlxRefConvertCodeActionProvider` — top-level `Ref:` line → inline `[ref:]`. Two options per Ref (left/right endpoint); ordered by FK convention (`<` op → right first; `>` op → left first). Disabled with reason when the target column lives in an `!include`d file (column not found in current file) or when the Ref uses composite tuple syntax `.(c1, c2)`. Migration `[add]`/`[drop]` annotations on the source Ref are mapped to `add ref:` / `drop ref:` prefixes on the resulting inline; other settings (`delete: cascade` etc.) are preserved alongside the ref clause.
- `DbmlxInlineRefLiftCodeActionProvider` — inline `[ref: …]` → new top-level `Ref:` line inserted after the table block's closing `}`. One action per inline ref item (so a ref-migration column with `[add ref: > new, drop ref: > old]` produces two actions). FK-on-right convention: when inline op is `>`, the lifted Ref flips both order and operator (`Ref: target < source`). Schema-qualified / quoted identifiers from the enclosing `Table` header and column declaration are preserved verbatim in the source endpoint.

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
