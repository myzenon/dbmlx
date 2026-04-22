# Changelog

## [0.1.16] - 2026-04-22

### Added
- **Table header action icons**: hover over a table to reveal three icon buttons — info (ⓘ), go-to-definition, and color picker — grouped with a shared background that fades over the truncated name
- **Full-name tooltip on click**: the ⓘ icon opens a persistent click-to-dismiss tooltip showing the full qualified table name (or `old → new` for renames), replacing the unreliable native hover tooltip
- **Long name truncation**: table names longer than 20 characters are mid-truncated (`add…contracts`) in the header; rename diffs truncate each side to 10 characters

### Changed
- **Group color swatch is now the color picker**: clicking the colored rectangle in the Table Groups panel opens the color picker directly; the separate palette button has been removed

### Fixed
- **Table header icons no longer displace the name**: action icons are absolutely positioned with a shared background/fade, so the table name uses the full header width at rest
- **Name tooltip dismisses on scroll/zoom**: the click-triggered name tooltip now closes on `wheel` events (pan/zoom) in addition to outside clicks

## [0.1.15] - 2026-04-22

### Added
- **Auto-hide/show groups**: hiding all tables in a group automatically hides the group; showing any table in a hidden group automatically shows it

## [0.1.14] - 2026-04-22

### Added
- **Rename diff in table header**: `[modify: name="old_name"]` on the `Table` declaration now shows `old → new` in the header with an amber border, consistent with column-level rename diffs

## [0.1.13] - 2026-04-21

### Added
- **Table-level `[add]` / `[drop]` annotations**: annotate an entire table as new or removed — green border + `+NEW` badge for `[add]`, red border + `DROP` badge for `[drop]`

## [0.1.12] - 2026-04-21

### Added
- **Persistent view toggles**: PK/FK only, Table Groups boundary, and Cardinality label toggle states are now saved in the layout sidecar JSON (`viewSettings` key) and restored when reopening the diagram

### Fixed
- **Export SVG/PNG respects toggles**: SVG and PNG exports now match the live diagram — PK/FK filter hides non-key columns, group boundaries are omitted when disabled, and cardinality labels are omitted when disabled

## [0.1.11] - 2026-04-21

### Added
- **CMD+/ comment toggle**: `language-configuration.json` added so `Ctrl+/` / `Cmd+/` toggles line comments (`//`) in `.dbmlx` files
- **Ref auto-complete chain**: Typing `Ref "name": ` now shows schema names automatically; picking a schema triggers table completions; picking a table triggers column completions; picking a column triggers operator completions (`>`, `<`, `-`, `<>`); picking an operator triggers right-side schema completions — no `Ctrl+Space` required
- **Composite FK completions**: `"table".(col1, col2)` tuple syntax recognized in Ref completions
- **Double-quoted identifier support in LSP**: Hover, go-to-definition, and completions now work for schema/table/column names that use double-quote quoting (e.g. `"my schema"."my table"."my column"`)

### Fixed
- **Syntax highlighting for column annotations**: `[add]`, `[drop]`, and `[modify: ...]` annotations now highlight in the editor — green for `add`, red for `drop`, amber for `modify`, with modify keys colored distinctly
- **Ref syntax highlighting**: Schema, table, column, and operator parts in `Ref:` declarations each get distinct colors
- **`[modify:]` edge routing**: FK edges now point to the correct (amber/after) row of a `[modify:]` column, not the strikethrough/before row
- **PK/FK filter — edge routing**: Enabling "PK/FK only" now correctly updates edge attachment Y positions and table bounding boxes for routing
- **PK/FK filter — group container boundary**: Group boundary boxes now shrink to the actual filtered column height instead of always using the full unfiltered table height
- **Auto layout — hidden tables**: Auto-arrange no longer creates phantom gaps for tables that are individually hidden or belong to hidden/collapsed groups

## [0.1.4] - 2026-04-19

### Added
- **SQL import/export**: Convert `.dbmlx` schemas to MySQL, PostgreSQL, or SQL Server DDL and back via the command palette (`DBMLX: Export Schema to SQL`, `DBMLX: Import Schema from SQL`)
- **SQL import sanitizer**: Automatically strips unsupported PostgreSQL constructs (`PARTITION BY`, `GENERATED ALWAYS AS IDENTITY`, `ATTACH PARTITION`, `SET`, `ALTER ROLE`, sequences, etc.) so real-world `pg_dump` files import cleanly
- **Migration diff annotations**: `[add]`, `[drop]`, `[modify: name="old" type="old"]` column annotations with full LSP support (hover docs, completions, go-to-definition)
- **DiagramView**: Named filtered views with per-view layout sidecar files (`schema.dbmlx.<viewName>.layout.json`)
- **Multi-file `!include`**: Submodule files now open their own diagram independently
- **LSP go-to-definition on `table.column`**: Jump to the exact column line in Ref declarations
- **Table Groups panel**: Renamed from "Diagram Views"; permanent "No Group" entry with hide-all toggle and search auto-expand
- **Cardinality toggle**: Show/hide 1-N labels on relation lines (default on)
- **Table Groups boundary toggle**: Show/hide group boundary boxes (default on); replaces "Keep groups together"
- **PK/FK only toggle**: Filter columns to primary and foreign keys only

### Improved
- **Snowflake layout**: Size-aware elliptical rings — ring radii computed from actual table bounding boxes, preventing overlap; isolated tables placed relative to actual BFS bounding box
- **Group container bounds**: Uses actual table height (accounting for `[modify]` double-height rows) so tables never overflow the group box
- **Auto-arrange persistence**: Layout saved to `.layout.json` after selecting an algorithm
- **Export edge color**: SVG/PNG export now uses the same blue as the live diagram instead of gray
- **Formatter stability**: Consecutive `!include` and `Ref` lines no longer get blank lines inserted between them

### Fixed
- All TypeScript errors resolved (including pre-existing `store.ts` type mismatches and `tableNode.tsx` style type error)
- Auto-arrange algorithm picker no longer shows numeric badges on options

## [0.1.3] - 2026-04-18

### Added
- Full rename to **DBMLX** — language ID, file extension `.dbmlx`, commands, grammar, icon
- Extension icon (SVG + PNG)
- LSP: hover, go-to-definition, document symbols, completions, formatting, diagnostics
- Column-level go-to-definition in Ref declarations
- `!include` file path completion
- Auto-arrange with four algorithms: Top-down, Left-right, Snowflake, Compact
- Marquee multi-select; drag selected group
- Edge mid-segment drag with persisted offset
- Crow's-foot cardinality markers
- SVG and PNG export with full fidelity (tables, edges, markers, group containers, diff colors)
- LOD rendering (full / header / rect) with spatial index viewport culling

## [0.1.0] - 2026-04-17

### Added
- Initial release — forked from [TWulfZ/dddbml](https://github.com/TWulfZ/dddbml)
- Git-friendly sidecar layout JSON with stable key ordering
- `TableGroup` collapse to summary node and hide
- Viewport culling + LOD targeting 5000+ tables at 60fps
