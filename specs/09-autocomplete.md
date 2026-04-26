# 09 — Auto-completion Requirements

Requirements for a correct, smart auto-completion in the dbmlx language server.
Use this as a checklist when implementing or auditing completion providers.

---

## A. Text insertion mechanics

These are the most common source of "idiot" completions.

| # | Requirement | How to fix |
|---|---|---|
| A1 | **No trigger-char doubling** — typing `"` then accepting a completion must not produce `""item""` | Set `item.range` to cover the typed `"`, or set `insertText` to `item"` (content + closing only) |
| A2 | **No dot duplication** — after `.` the insertText must not start with `.` | Strip leading `.` from insertText, or set range to include the typed `.` |
| A3 | **No colon duplication** — after `:` the insertText must not start with `:` | Same pattern as A2 |
| A4 | **Correct replace range** — `item.range` must span the full partial token already typed, not just the trigger | If user typed `use`, range covers `use` so it's replaced, not appended |
| A5 | **Closing-pair awareness** — if the editor already auto-inserted `"` or `]`, don't insert another | Check the character after the cursor before building insertText |

---

## B. Context-gating

Completions must only appear in positions where they make sense.

| # | Position | What to offer |
|---|---|---|
| B1 | Top-level scope | `Table`, `Ref`, `Enum`, `TableGroup`, `DiagramView`, `!include`, `Project` |
| B2 | `Table` header line (before `{`) | `[add]`, `[drop]`, `[modify: name=""]` annotation snippets |
| B3 | Column definition line — name position | Nothing (user is naming a column) |
| B4 | Column definition line — type position | SQL types (`int`, `varchar(n)`, `uuid`, etc.), enum names |
| B5 | Column settings bracket `[...]` | Setting keywords: `pk`, `not null`, `unique`, `null`, `increment`, `default:`, `ref:`, `note:`, `add`, `drop`, `modify:` |
| B6 | `Ref:` line | Schema/table/column chain (see section C) |
| B7 | Inline `ref:` inside `[...]` | Direction operators, then schema/table/column chain |
| B8 | `Indexes { }` block | Column names of the current table; `pk`, `unique`, `name:`, `add`, `drop` |
| B9 | `DiagramView { }` block | `Tables {`, `TableGroups {`, `Schemas {` keywords |
| B10 | Inside `Tables { }` | Table names |
| B11 | Inside `TableGroups { }` | TableGroup names |
| B12 | Inside `Schemas { }` | Schema names |
| B13 | Inside `//` comment | **Nothing** |
| B14 | Inside string value (`'...'`, `"..."`, `` `...` ``) | **Nothing** |

---

## C. Ref completion chain

The full chain must trigger automatically after each pick — no `Ctrl+Space` required.

```
Ref: │                          → schema names (or unqualified table names)
Ref: schema.│                  → table names in that schema
Ref: schema.table.│            → column names of that table
Ref: schema.table.col │        → operators: >  <  -  <>
Ref: schema.table.col > │      → right-side schema names
Ref: schema.table.col > sch.│  → right-side table names
...and so on
```

Same chain applies to inline `[ref: │]` inside column settings.

Additional chain rules:

| # | Rule |
|---|---|
| C1 | After operator is picked, immediately offer right-side schema names |
| C2 | Unqualified table names (no schema prefix) must also appear at each table-name step |
| C3 | Composite FK: after `orders.(`, offer column names of `orders`; after a column, offer `,` or `)` continuation |
| C4 | `!include "│"` — offer file paths relative to the current file |

---

## D. Relevance and ranking

| # | Requirement |
|---|---|
| D1 | `item.preselect = true` on the single most likely item |
| D2 | Use `sortText` to order: most-likely first, then alphabetical within a category |
| D3 | Schema-filtered — don't show all tables from all schemas when context makes one schema obvious |
| D4 | Deprioritize or exclude already-used items (e.g. column already in the same `Indexes` line) |

---

## E. Item quality

| # | Requirement |
|---|---|
| E1 | **`CompletionItemKind`** set correctly: `Keyword` for settings, `Class`/`Module` for tables, `Field` for columns, `Snippet` for templates, `EnumMember` for enum values |
| E2 | **`documentation`** populated on every item — what it does + a short example |
| E3 | **`detail`** set for context hints — e.g. column type shown next to column name |
| E4 | **Snippets with tab stops** for multi-part constructs (see examples below) |
| E5 | **`filterText`** set when the label contains quotes/decoration but the user is typing without them — e.g. label `"my_table"`, filterText `my_table` |
| E6 | **`commitCharacters`** set where appropriate (e.g. `.` commits a table name and immediately starts column completion) |

### Snippet examples

```
Table ${1:name} {\n\t${0}\n}
Ref: ${1:table}.${2:col} > ${3:table}.${4:col}
[modify: name="${1:old_name}", type="${2:old_type}"]
DiagramView ${1:name} {\n\tTables { ${0} }\n}
!include "${1:path}"
```

---

## F. Robustness

| # | Requirement |
|---|---|
| F1 | **Works with parse errors** — document is often mid-edit and invalid; fall back to regex/line-scanning if the AST is broken |
| F2 | **Works with `!include`** — table/column names from included files are available |
| F3 | **Schema-qualified and unqualified names both work** — `users` and `public.users` resolve to the same table |
| F4 | **Quoted identifiers** — names with spaces return as `"name with spaces"`; the replace range covers the full `"..."` token |
| F5 | **Large schemas** — completions must not block the LSP thread; pre-index the workspace on file change |

---

## G. Known bugs to fix (as of April 2026)

- [x] **A1/A4** — Quote-token detection covers unclosed `"<partial>` (parity-based), so accepting completions never produces `""item""` or `""schema".pub`
- [x] **B13/B14** — `isInsideStringOrComment()` guard returns no completions inside `//`, `'…'`, or `` `…` ``
- [x] **C2** — `Ref:` and right-side-of-operator positions now offer schema names AND unqualified `"tableName"` items
- [x] **D1/D2** — `preselect` on PK columns and `public` schema; `sortText` ranks PKs before non-PKs and curated keyword order
- [x] **D4** — Indexes and composite-FK tuples deduplicate columns already mentioned earlier on the line
- [x] **E5** — All quoted items set `filterText` to the unquoted form
- [x] Pure helpers (`computeQuoteReplaceRange`, `classifyBracket`, `classifyRefStep`, `usedColumnsOnLine`, …) extracted to `completionContext.ts` with 35 unit tests
- [ ] **E6** — `commitCharacters` so typing `.` after a table-name suggestion commits and immediately triggers column completion
- [ ] Confirm completions still work when `!include`'d files have parse errors (F1+F2)

---

## References

- [VSCode CompletionItem API](https://code.visualstudio.com/api/references/vscode-api#CompletionItem) — `range`, `insertText`, `filterText`, `sortText`, `preselect`
- [LSP Completion spec §3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_completion) — `textEdit`, `insertTextFormat`, `commitCharacters`
- Rule: never set `insertTextFormat: PlainText` with snippet syntax in `insertText` — be explicit with `InsertTextFormat.Snippet`
- Rule: `filterText` must match what the user types, not the display label
