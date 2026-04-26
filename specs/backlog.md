# Feature Backlog

Items deferred from the April 2026 improvement session. Implement when ready.

---

## #4 — Multi-select + group move

**What:** Shift-click or drag-lasso to select multiple tables, then drag them as a unit.

**Why:** The most common layout frustration after auto-arrange — rearranging clusters requires moving each table individually.

**Scope:**
- Multi-select already works via lasso (shift-drag) and shift-click — selection state is in `store.ts`.
- Drag system (`dragController.ts`) currently moves one table at a time via direct DOM mutation.
- Need to extend `startDrag` to move all selected tables together: on `pointerdown` of a selected table, move every table in `store.getState().selection` by the same delta.
- Commit all positions on `pointerup` via `setPositionsBatch`.
- Visual: selected tables show a blue outline already (`.ddd-table--selected`).

**Files to touch:** `src/webview/drag/dragController.ts`, possibly `src/webview/render/tableNode.tsx`.

---

## #5 — Extension bundle size investigation

**What:** The esbuild output (`dist/extension/extension.js`) is ~10.6 MB with a ⚠️ warning. Investigate root cause and reduce.

**Why:** Faster install, faster extension host startup, smaller `.vsix` artifact.

**Approach:**
1. Run `esbuild --metafile=meta.json ...` to get a module-level breakdown.
2. Identify the largest contributors (likely `@dbml/core` + its parser dependencies).
3. Options:
   - Tree-shake unused `@dbml/core` exports.
   - Move heavy parser deps to a lazy `require()` so they load only on first parse.
   - Evaluate if any bundled polyfills or duplicate modules exist.

**Files to touch:** `package.json` build scripts; possibly `src/extension/parser.ts` for lazy loading.
