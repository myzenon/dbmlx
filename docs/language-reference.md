# .dbmlx Language Reference

`.dbmlx` is a superset of [DBML](https://dbml.dbdiagram.io/docs/). Every valid DBML file is valid `.dbmlx`. The extensions add multi-file inclusion, custom diagram views, and migration diff annotations.

---

## Table of Contents

1. [Core DBML Syntax](#1-core-dbml-syntax)
2. [Refs](#2-refs)
3. [Enums](#3-enums)
4. [TableGroups](#4-tablegroups)
5. [Notes](#5-notes)
6. [!include — multi-file schemas](#6-include--multi-file-schemas)
7. [DiagramView — named filtered views](#7-diagramview--named-filtered-views)
8. [Migration diff annotations](#8-migration-diff-annotations)
9. [Layout sidecar file](#9-layout-sidecar-file)

---

## 1. Core DBML Syntax

### Table

```dbmlx
Table schema.table_name [headercolor: "#hex"] {
  column_name  type  [settings]
  ...

  indexes {
    (col1, col2) [name: "idx_name", unique]
    col3         [name: "idx_col3"]
  }

  Note: 'Free-form table description'
}
```

**Schema prefix is optional.** `Table users` is equivalent to `Table public.users`.

### Column settings

| Setting | Meaning |
|---|---|
| `[pk]` | Primary key |
| `[primary key]` | Primary key (long form) |
| `[unique]` | Unique constraint |
| `[not null]` | NOT NULL |
| `[null]` | Nullable (explicit) |
| `[increment]` | Auto-increment / SERIAL |
| `[default: value]` | Default — use `'string'`, `123`, `` `now()` `` for expressions |
| `[ref: > other.id]` | Inline ref (see §2) |
| `[note: 'text']` | Column-level note |

### Common types

`int`, `integer`, `bigint`, `smallint`, `float`, `double`, `decimal(p,s)`,
`boolean`, `bool`, `varchar(n)`, `char(n)`, `text`, `uuid`, `date`, `datetime`,
`timestamp`, `timestamptz`, `json`, `jsonb`, `blob`

Types are passed through to the diagram as-is; any string is accepted.

---

## 2. Refs

Define foreign-key relationships. Can appear at the top level or inside a table.

```dbmlx
// Top-level
Ref ref_name: table_a.col > table_b.col   // many-to-one
Ref: table_a.col < table_b.col            // one-to-many
Ref: table_a.col - table_b.col            // one-to-one
Ref: table_a.col <> table_b.col           // many-to-many

// Composite FK
Ref: orders.(user_id, tenant_id) > users.(id, tenant_id)

// Inline (inside Table block)
Table orders {
  user_id  int  [ref: > users.id]
}
```

| Operator | Meaning |
|---|---|
| `>` | Many-to-one (FK side → PK side) |
| `<` | One-to-many |
| `-` | One-to-one |
| `<>` | Many-to-many |

**Completions**: Typing `Ref "name": ` triggers schema-name completions automatically. Picking a schema immediately suggests tables; picking a table suggests columns; picking a column suggests operators; picking an operator suggests the right-side schema — the full chain triggers without `Ctrl+Space`.

**Code actions** (lightbulb / `Ctrl+.`):
- On a top-level `Ref:` line — *Convert Ref → inline*: rewrites the Ref as an inline `[ref: ...]` on either endpoint. Two options appear; the FK-convention side is listed first (right side for `<`, left side for `>`). Migration annotations (`[add]`/`[drop]`) become `[add ref: ...]`/`[drop ref: ...]` on the inline; other settings (`delete: cascade` etc.) are carried over. Disabled with a reason when the column lives in an `!include`d file, or when the Ref uses composite `(c1, c2)` tuple syntax (composite refs have no inline form).
- On a column line with `[ref: ...]` — *Lift to top-level*: rewrites the inline ref as a new `Ref:` line right after the table block. Uses the FK-on-right convention: when inline op is `>`, the lifted Ref flips order and operator so the FK column ends up on the right. One action per inline ref on the line (a ref-migration column with `[add ref: > new, drop ref: > old]` produces two separate lift actions).

### Ref migration annotations

Mark a ref as being added or dropped in a migration. See §8 for full details.

```dbmlx
// Top-level ref — add [add] or [drop] after the endpoint pair
Ref: orders.user_id > users.id [add]     // new FK — shown as green line (when enabled)
Ref: orders.legacy_id > old.id [drop]    // FK being removed — shown as red dashed line

// Inline ref — prefix the ref: clause with add or drop (no comma between)
Table orders {
  user_id      int  [add ref: > users.id]       // new FK
  old_ref_id   int  [drop ref: > legacy.id]     // FK being removed
  domain_id    int  [pk, ref: > domains.id, add] // ← "add" here is column-level (standalone item)

  // Ref migration: drop old FK, add new one — both in a single bracket
  tenant_id    int  [add ref: > tenants.id, drop ref: > old_tenants.id]
}
```

**Rule for inline refs**: `add ref:` / `drop ref:` (keyword + space + `ref:`, no comma between) is a ref-level annotation. A standalone `add` or `drop` item elsewhere in the bracket remains a column-level annotation — existing code is unaffected.

**Visual side effect — FK-holder marked as modified**: a ref with `[add]`/`[drop]` (top-level Ref or inline) flags the FK-holding table (the `*`-side, i.e. the table that owns the foreign-key column) as a modified table — amber left accent + numeric count badge in the header. The referenced "PK side" table is left unchanged. For 1:1 / many-to-many refs (no single FK holder) both endpoint tables are flagged. The Table Groups panel "modified" filter picks them up too.

---

## 3. Enums

```dbmlx
Enum job_status {
  created   [note: 'Newly created']
  running
  done
  failure
}

Table jobs {
  status  job_status
}
```

---

## 4. TableGroups

Groups map to DDD bounded contexts in the diagram. Groups can be collapsed to a single summary node or hidden entirely.

```dbmlx
TableGroup billing {
  orders
  invoices
  payments
}

TableGroup auth {
  users
  sessions
  roles
}
```

Tables inside a group are referenced by their unqualified name. Schema-qualified names (`public.users`) also work.

---

## 5. Notes

```dbmlx
// Table note
Table users {
  Note: 'Stores all registered users'
  id  int  [pk]
  email  varchar(255)  [note: 'Must be unique across tenants']
}

// Project-level note
Project my_project {
  Note: 'Main application schema'
}
```

---

## 6. `!include` — multi-file schemas

Split large schemas across files. Paths are relative to the including file.

```dbmlx
// schema.dbmlx
!include "auth/users.dbmlx"
!include "billing/invoices.dbmlx"
!include "shared/enums.dbmlx"

Ref: users.id < invoices.user_id
```

- Includes are resolved before parsing — the stitched source is passed to the parser as a unit.
- Circular includes are not detected; avoid them.
- Go-to-definition on a `table.column` reference (e.g. in a `Ref:` line) jumps to the **column definition line** inside the table, not just the table header.
- Go-to-definition on an `!include` path opens the included file.
- File completion triggers automatically after typing `!include "`.
- Opening a module file with **DBMLX: Open Diagram** automatically redirects to the root file's diagram.

---

## 7. `DiagramView` — named filtered views

Define multiple views of the same schema. Views filter which tables appear; the underlying schema is unchanged. Each view has its own layout file (see §9).

```dbmlx
DiagramView auth_context {
  Tables { users, sessions, roles }
}

DiagramView billing_overview {
  TableGroups { billing }
}

DiagramView tenant_schema {
  Schemas { tenant }
}

DiagramView everything {
  Tables { * }
}
```

### Sections

| Section | Value | Meaning |
|---|---|---|
| `Tables { ... }` | comma/newline-separated table names | Show only these tables |
| `TableGroups { ... }` | group names | Show all tables belonging to these groups |
| `Schemas { ... }` | schema names (e.g. `public`, `tenant`) | Show all tables in these schemas |

- Multiple sections in one view are **unioned** — a table is shown if it matches any section.
- A view with no sections (or `*` wildcard) shows all tables.
- Views are selected from the diagram view switcher in the toolbar.
- Each view has its own layout sidecar file (see §9).
- Switching views loads a separate layout file automatically.

---

## 8. Migration diff annotations

Annotate columns to visualize a schema migration as a before/after diff in the diagram.

### Key principle

Write the column in its **new (post-migration) state** — the name and type as they will exist after the migration. Use the `[modify:]` annotation to record what the column was *before*.

This means `Ref` and `indexes` reference the **new** column name, which is correct for the post-migration schema.

### Syntax

```dbmlx
Table orders {
  id           int           [pk]
  status       varchar(50)

  amount       decimal(10,2) [add]
  // ↑ new column being added — write it as it will exist after migration

  total        decimal       [drop]
  // ↑ column being removed — write it as it exists now (before migration)

  customer_id  int           [modify: name="customer", type="varchar(100)"]
  // ↑ renamed + retyped: write the NEW name and type on the line,
  //   record the original name/type inside [modify:]

  email        varchar(255)  [modify: type="varchar(100)"]
  // ↑ type change only — name= omitted because name is unchanged

  user_id      int           [pk, not null, modify: name="uid", pk=false, not_null=false]
  // ↑ constraint changes: was "uid", non-pk, nullable → now "user_id", pk, not null
  //   before row shows old name + no PK icon + no NN badge
  //   after row shows new name + PK icon + NN badge

  score        float         [modify: default="0.0", unique=true]
  // ↑ default removed, unique constraint dropped

  description  text          [not null, drop]
  // ↑ [drop] combines with other standard settings
}

// Refs use the new column name
Ref: orders.customer_id > customers.id
```

### `[modify:]` / `[before:]` keys

`[before:]` is a clearer alias for `[modify:]` — both accept the same keys and produce identical output. Use whichever reads better to you; `[modify:]` is kept for backward compatibility.

All keys are optional. Omit any key whose value did not change. Keys can appear in any order and combine freely with standard column settings (`pk`, `not null`, `unique`, etc.).

| Key | Format | Records |
|---|---|---|
| `name` | `name="old_name"` | column name before the migration |
| `type` | `type="old_type"` | column type before the migration |
| `default` | `default="old_val"` | default value before the migration |
| `pk` | `pk=true\|false` | pk status before (`true` = was pk, `false` = was not pk) |
| `not_null` | `not_null=true\|false` | not-null status before |
| `unique` | `unique=true\|false` | unique status before |
| `increment` | `increment=true\|false` | auto-increment status before |

The before/after diff display uses these values:
- **Before row** (strikethrough): old name, old type, icons/badges from old pk/not_null/unique. Falls back to current column values for any key not specified.
- **After row** (amber): current column name, type, and settings as written on the line.

### Column-level rules

| Annotation | Meaning | Visual |
|---|---|---|
| `[add]` | Column being added. Does not exist before migration. | Green accent |
| `[drop]` | Column being removed. Will not exist after migration. | Red strikethrough |
| `[modify: ...]` / `[before: ...]` | Column was changed. Write new state on the line; record old values inside `modify:`/`before:`. | Two-row display: original (muted strikethrough) → new (amber) |

### Index-level annotations

`[add]` and `[drop]` can appear on index lines inside `Indexes { }` blocks to annotate PK index changes:

```dbmlx
Table orders {
  domain_id  int  [pk]      // standalone pk — unchanged
  user_id    int             // not pk after migration

  Indexes {
    (domain_id, user_id) [pk, drop]
    // ↑ composite PK index being dropped.
    //   domain_id still has its standalone [pk], so it stays a PK.
    //   user_id had pk only via this index — loses PK status, shown with a red key icon.

    domain_id [pk, add]
    // ↑ new PK index being added — affected columns gain a green key icon.
  }
}
```

**Semantics:**
- `[drop]` on an index — the index is removed from the post-migration schema. Any column whose `pk` status came **only** from that index (not from a standalone `[pk]`) loses PK status and shows a **red key icon**.
- `[add]` on an index — the index is new in the post-migration schema. Columns that gain PK status show a **green key icon**.
- A column with both a standalone `[pk]` and a dropped composite index keeps its PK status from the standalone flag — the red icon is suppressed.

The `[modify: pk=false]` column annotation follows the same color convention: when a column gains PK in the migration (`fromPk=false`, column has `[pk]`), the "after" row key icon is **green**.

| Annotation | Scope | Visual |
|---|---|---|
| `(cols) [pk, drop]` inside `Indexes {}` | Index being removed | Affected columns show red key icon |
| `(cols) [pk, add]` inside `Indexes {}` | Index being added | Affected columns show green key icon |
| `[pk, modify: pk=false]` on a column | Column gaining PK | "After" row key icon is green |

### Table-level annotations

`[add]`, `[drop]`, and `[modify: name="old"]` / `[before: name="old"]` can appear on the `Table` declaration line:

```dbmlx
Table audit_log [add] {
  id          int           [pk, increment]
  event       varchar(255)
  created_at  timestamp
}
// ↑ entire table is being added — green border + +NEW badge

Table old_sessions [drop] {
  id       int  [pk]
  token    text
  user_id  int
}
// ↑ entire table is being removed — red border, dimmed columns, DROP badge

Table new_users [modify: name="users"] {
  id    int           [pk]
  email varchar(255)
}
// ↑ table is being renamed — amber border, old name (strikethrough) + new name (amber) in header
// Write the NEW name on the Table line; record the old name with name="old_name"
// Refs and indexes reference the new name
```

| Annotation | Meaning | Visual |
|---|---|---|
| `Table name [add] { ... }` | Entire table being created in this migration | Green border, `+NEW` badge |
| `Table name [drop] { ... }` | Entire table being removed in this migration | Red border, dimmed, `DROP` badge |
| `Table new_name [modify: name="old_name"] { ... }` | Table is being renamed | Amber border, before→after name diff in header |
| `Table new_name [before: name="old_name"] { ... }` | Same as above (`before:` alias) | Amber border, before→after name diff in header |

- Annotations are stripped before passing to the underlying DBML parser — they never cause parse errors.
- `[add]` and `[drop]` can be combined with standard column settings: `[not null, add]`, `[pk, drop]`.
- Hover over `[add]`, `[drop]`, `[modify:]`, or `[before:]` in the editor for inline documentation.

---

## 9. Layout sidecar file

The diagram stores table positions, viewport state, group state, and edge offsets in a sidecar JSON file next to the schema.

### File naming

| View | Sidecar file |
|---|---|
| Default (all tables) | `schema.dbmlx.layout.json` |
| Named view `auth_context` | `schema.dbmlx.auth_context.layout.json` |

### Format

```json
{
  "version": 1,
  "viewport": { "x": 0, "y": 0, "zoom": 1.0 },
  "viewSettings": {
    "mergeConvergentEdges": false
  },
  "tables": {
    "public.orders": { "x": 120, "y": 80 },
    "public.users":  { "x": 400, "y": 80, "hidden": true, "color": "#D0E8FF" }
  },
  "groups": {
    "billing": { "collapsed": true, "color": "#D0E8FF" },
    "auth":    {}
  },
  "edges": {
    "public.orders(user_id)->public.users(id)": { "dx": 0, "dy": 20 }
  }
}
```

### Properties

**`viewSettings`** — diagram display toggles (omitted when all defaults):
- `showOnlyPkFk` — show only PK/FK columns; omitted when `false` (default off)
- `showGroupBoundary` — show group boundary boxes; omitted when `true` (default on)
- `showCardinalityLabels` — show 1/N labels on edges; omitted when `true` (default on)
- `mergeConvergentEdges` — merge FK lines sharing an endpoint into a trunk; omitted when `true` (default on)
- `showDropRefs` — show `[drop]`-annotated refs as red dashed lines; omitted when `false` (default off)
- `colorizeAddRefs` — color `[add]`-annotated refs green; omitted when `false` (default off)

**`tables`** — keyed by qualified name `schema.table`:
- `x`, `y` — integer pixel coordinates
- `hidden` — omitted when `false`
- `color` — custom hex color; omitted when default

**`groups`** — keyed by group name:
- `collapsed` — omitted when `false`
- `hidden` — omitted when `false`
- `color` — custom hex color; omitted when default

**`edges`** — keyed by ref ID; values are drag offsets applied to the middle segment:
- `dx`, `dy` — integer pixel deltas; entry omitted when both are zero

Keys are alphabetically sorted at all levels. Coordinates are integers. `false` values and zero edge offsets are omitted — this keeps Git diffs minimal.

Commit this file alongside your schema so teammates see the same diagram on checkout.
