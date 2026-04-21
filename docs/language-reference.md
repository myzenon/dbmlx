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

### `[modify:]` keys

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
| `[modify: ...]` | Column was changed. Write new state on the line; record old values inside `modify:`. | Two-row display: original (muted strikethrough) → new (amber) |

### Table-level annotations

`[add]` and `[drop]` can also appear on the `Table` declaration line to mark an entire table as new or removed:

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
```

| Annotation | Meaning | Visual |
|---|---|---|
| `Table name [add] { ... }` | Entire table being created in this migration | Green border, `+NEW` badge |
| `Table name [drop] { ... }` | Entire table being removed in this migration | Red border, dimmed, `DROP` badge |

- Annotations are stripped before passing to the underlying DBML parser — they never cause parse errors.
- `[add]` and `[drop]` can be combined with standard column settings: `[not null, add]`, `[pk, drop]`.
- Hover over `[add]`, `[drop]`, or `[modify:]` in the editor for inline documentation.

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
