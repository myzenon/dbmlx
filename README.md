# DBMLX: Database Visual and Design

**DBMLX** (`.dbmlx`) is a VSCode extension for designing, visualizing, and managing database schemas as interactive diagrams. It introduces **Database Markup Language Extension** — a superset of the DBML format with first-class support for multi-file projects, DDD bounded contexts, custom diagram views, and migration diff annotations.

Your schema stays in plain text. The extension reads it, renders it, and persists your layout alongside it — reviewable in Git, portable across teams.

> Uses [`@dbml/core`](https://github.com/holistics/dbml) (Apache-2.0) as the underlying parser.

→ **[Full language reference](docs/language-reference.md)** — complete syntax, all constructs, migration diffs, DiagramView, layout format.

---

## Install

**[Install from VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=si-zenon.dbmlx)** — or download a `.vsix` from [GitHub Releases](https://github.com/myzenon/dbmlx/releases) and install manually:

```bash
code --install-extension dbmlx-<version>.vsix
```

Open any `.dbmlx` file, then run **`DBMLX: Open Diagram`** from the command palette, or click the icon in the editor title bar.

> Opening a module file (one referenced by `!include`) automatically opens the root file's diagram.

---

## The .dbmlx Language

`.dbmlx` is a superset of standard DBML. All valid DBML is valid `.dbmlx`. On top of that, dbmlx adds:

### `!include` — multi-file schemas

Split large schemas across files. The extension stitches them before parsing.

```dbmlx
!include "auth/users.dbmlx"
!include "billing/invoices.dbmlx"

Ref: users.id < invoices.user_id
```

### `DiagramView` — named filtered views

Define multiple views of the same schema without duplicating anything.

```dbmlx
DiagramView auth_context {
  TableGroups { auth }
}

DiagramView billing_overview {
  Tables { orders, invoices, payments }
}
```

### Migration diff annotations

Annotate columns to visualize a schema migration as a before/after diff directly in the diagram. Write the column in its **new** (post-migration) state, and record the original values in the annotation.

```dbmlx
Table orders {
  id           int           [pk]
  status       varchar(50)
  amount       decimal(10,2) [add]                                           // new column
  total        decimal       [drop]                                          // removed column
  customer_id  int           [modify: name="customer", type="varchar(100)"]  // renamed + retyped
  user_id      int           [pk, not null, modify: name="uid", pk=false, not_null=false]
  // ↑ was "uid", non-pk, nullable → now "user_id", pk, not null
}
```

- `[add]` — rendered with a green accent (column) or green border + `+NEW` badge (table)
- `[drop]` — rendered with a red strikethrough (column) or red border + `DROP` badge (table)
- `[modify: ...]` / `[before: ...]` — two-row display: original (strikethrough) → new (amber). `before:` is a clearer alias for `modify:`. All keys are optional.

Refs can be annotated too — top-level with `[add]`/`[drop]` after the endpoint pair, inline with `add ref:` / `drop ref:` as a prefixed item:

```dbmlx
Ref: orders.user_id > users.id [add]            // new FK — shown as green line (toggle on)
Ref: orders.old_id > legacy.id [drop]           // removed FK — shown as red dashed line

Table orders {
  user_id    int  [add ref: > users.id]          // new inline FK
  tenant_id  int  [add ref: > tenants.id, drop ref: > old_tenants.id]  // ref migration
  domain_id  int  [pk, ref: > domains.id, add]  // "add" here = column-level (standalone item)
}
```

`[add]`, `[drop]`, and `[modify: name="old"]` / `[before: name="old"]` work on the `Table` declaration line too:

```dbmlx
Table audit_log [add] {                    // new table — green border + +NEW badge
  id int [pk]
}
Table old_cache [drop] {                   // removed table — red border + DROP badge
  id int [pk]
}
Table new_users [modify: name="users"] {   // renamed table — amber border, old→new name in header
  id int [pk]
}
```

`modify:` / `before:` keys — write the column in its new state, record old values in the annotation:

| Key | Format | Records |
|---|---|---|
| `name` | `name="old"` | previous column name |
| `type` | `type="old"` | previous column type |
| `default` | `default="old"` | previous default value |
| `pk` | `pk=true\|false` | pk status before the change |
| `not_null` | `not_null=true\|false` | not-null status before |
| `unique` | `unique=true\|false` | unique status before |
| `increment` | `increment=true\|false` | auto-increment status before |

All `modify:`/`before:` keys combine freely with standard column settings in any order: `[pk, not null, before: name="old", pk=false]`.

---

## Features

### Interactive diagram

- Every `Table`, `Ref`, and `TableGroup` renders as positioned nodes with Manhattan-routed edges.
- Each FK edge exits from the **source column row** and enters at the **target column row** — not the table midpoint.
- **Drag** tables freely. Positions are saved to a sidecar `.dbmlx.layout.json` after a 300ms debounce.
- **Multi-select**: click-drag on empty space for marquee. `Shift`+marquee extends selection. Drag any selected table to move the group.
- **Drag the middle segment** of any edge to reroute it. The offset persists in the layout file.
- Cardinality markers: crow's-foot for many (`*`), bar for one (`1`).

### DDD-aware bounded contexts

The **Table Groups** panel (top-left of the diagram) lists all `TableGroup`s plus a **No Group** entry for ungrouped tables.

- **Collapse** a group to a single summary node — edges route to/from it.
- **Hide** a group to remove it and all its edges from the diagram.
- **Hide all ungrouped** tables via the No Group row's eye button.
- Assign custom colors per group by clicking the color swatch, or per table via the palette icon that appears on header hover.
- Search by group or table name — matching groups expand automatically.
- **Click a group name** to focus the viewport on that group's tables.
- **Annotation filter chips** — filter the list to tables with migration changes:
  - `+NEW` — tables with `[add]` annotation
  - `DROP` — tables with `[drop]` annotation
  - `DIFF` — tables that have any column-level diff annotation (`[add]`, `[drop]`, `[modify:]`, or `[before:]`)
  - Chips combine with the search query (OR logic within chips). A colored dot on each table row indicates its annotation state.

### Diagram Views

Switch between named views from the toolbar. Each view filters tables, groups, and schemas independently and has its own layout file.

### Layout persistence

Positions, viewport, group state, and edge offsets live in `schema.dbmlx.layout.json` next to your schema:

```json
{
  "version": 1,
  "viewport": { "x": 0, "y": 0, "zoom": 1.0 },
  "tables": { "public.users": { "x": 120, "y": 80 } },
  "groups": { "billing": { "collapsed": true, "color": "#D0E8FF" } }
}
```

Keys are alphabetically sorted, integers for coordinates, defaults omitted — **minimal, reviewable Git diffs**.

### Performance

- Spatial index + viewport culling: only visible tables render.
- LOD rendering: full detail at ≥60% zoom, header-only at 30–60%, bounding box below 30%.
- Targets **60fps pan/zoom with 5000+ tables**.

### LSP intelligence

Full language server features for `.dbmlx` files:

| Feature | Details |
|---|---|
| **Hover** | Table schema with column diff state; keyword docs for every construct including `[add]`, `[drop]`, `[modify:]`, `[before:]` |
| **Go-to-definition** | Jump to table or **column** definition; `!include` → open included file |
| **Document symbols** | Outline panel lists all tables and columns |
| **Completions** | Table names, column names, SQL types, settings, ref operators, diff annotations, `!include` file paths; `Ref:` completions chain automatically: schema → table → column → operator → right-side schema/table/column without `Ctrl+Space`; composite FK tuple syntax supported |
| **CodeLens** | "Focus in diagram" link above each `Table` definition — click to pan and zoom the open diagram to that table, un-hiding its group if needed |
| **Code actions** | Convert between top-level `Ref:` and inline `[ref: ...]` (both directions). Lightbulb on a `Ref:` line offers attaching to either endpoint, FK side first by convention. Lightbulb on a column with `[ref: ...]` lifts it to a top-level `Ref:` (FK on right). Migration annotations (`[add]`/`[drop]`) round-trip; composite refs are not convertible (DBML inline refs are single-column). |
| **Formatting** | Auto-format on save — consistent indentation, idempotent |
| **Diagnostics** | Parse errors shown as squiggles with line/column |

### Diagram toolbar

The actions panel (bottom of the diagram) provides view toggles:

| Toggle | Default | Effect |
|---|---|---|
| **PK/FK only** | Off | Show only primary key and foreign key columns |
| **Table Groups** | On | Show group boundary boxes; auto-arrange respects group clusters |
| **Cardinality** | On | Show 1/N labels on relation lines |
| **Merge Lines** | On | Merge FK lines that share the same endpoint column into a single trunk with a junction dot |

### Column hover highlight

Hover any column in the diagram to instantly highlight all FK relationships involving that column:

- The hovered column and all connected columns across tables get an amber background.
- Related edges turn yellow and thicken; unrelated edges dim to near-invisible.
- Junction dots on merged trunk lines follow the same highlight/dim state.

### Edge hover tooltip

Hover any relation line to see a tooltip showing `source.col → target.col` and the cardinality (`N : 1`, `1 : 1`, etc.).

### Auto-arrange

Four layout algorithms available from the arrange button (⟳):

| Algorithm | Best for |
|---|---|
| **Top-down** | Most diagrams — relationships flow top to bottom |
| **Left-right** | Long lineage chains, ETL pipelines |
| **Snowflake** | Dense graphs, data warehouses |
| **Compact** | Schemas with few relationships |

When **Table Groups** is enabled, auto-arrange clusters tables from the same group together.

### Export

- **SVG / PNG**: full fidelity — tables, edges, markers, cardinality labels, group containers, migration diff colors.
- **SQL**: export the schema to MySQL, PostgreSQL, or SQL Server DDL.
- **Import from SQL**: convert MySQL, PostgreSQL, or SQL Server DDL to `.dbmlx`.

Run the relevant command from the command palette or use the export buttons in the diagram toolbar.

---

## Commands

| Command | Shortcut |
|---|---|
| DBMLX: Open Diagram | — |
| DBMLX: Auto Re-arrange Diagram | — |
| DBMLX: Fit to Content | `Ctrl+1` / `Cmd+1` |
| DBMLX: Reset View | `Ctrl+0` / `Cmd+0` |
| DBMLX: Zoom In | `Ctrl+=` / `Cmd+=` |
| DBMLX: Zoom Out | `Ctrl+-` / `Cmd+-` |
| DBMLX: Export Diagram as SVG | — |
| DBMLX: Export Diagram as PNG | — |
| DBMLX: Export Schema to SQL | — |
| DBMLX: Import Schema from SQL | — |
| DBMLX: Focus Table in Diagram | — (use CodeLens link above `Table` definition) |

---

## Layout file

The sidecar `schema.dbmlx.layout.json` is intentionally human-readable and Git-friendly:

- **Stable key ordering** — no noisy diffs when positions don't change.
- **Integers only** for coordinates — no floating-point drift.
- **Defaults omitted** — `collapsed: false` and `hidden: false` are not written.
- **Atomic writes** — tmp file → rename, no partial writes.
- **Per-view files** — named views get their own `schema.dbmlx.<viewName>.layout.json`.

Commit this file alongside your schema. Your team sees the same diagram layout on checkout.

---

## Credits

- Forked from [TWulfZ/dddbml](https://github.com/TWulfZ/dddbml) — original Git-friendly DBML diagram renderer.
- DBML language and `@dbml/core` parser by [Holistics](https://github.com/holistics/dbml) (Apache-2.0).
- Layout engine: [`@dagrejs/dagre`](https://github.com/dagrejs/dagre).
- Rendered with [Preact](https://preactjs.com/) + [Zustand](https://zustand-demo.pmnd.rs/).
- LSP intelligence, migration diff visualization, SQL import/export, diagram views, and all extended features built with [Claude Code](https://claude.ai/code) by Anthropic.
