import { describe, it, expect } from 'vitest';
import { parseDbmlx } from './parser';

// ─── Inline ref [add] / [drop] annotations ───────────────────────────────────
// Syntax: "add ref: > target.col" or "drop ref: > target.col" as a single comma
// item inside a column setting bracket. Standalone "add"/"drop" items remain
// column-level annotations and are unaffected.

describe('parseDbmlx — inline ref [add] / [drop]', () => {
  it('[add ref: > target.id] sets refChange=add on the ref', () => {
    const src = `
Table orders {
  user_id int [add ref: > users.id]
}
Table users { id int [pk] }`;
    const { schema } = parseDbmlx(src);
    const ref = schema?.refs[0];
    expect(ref).toBeDefined();
    expect(ref!.refChange).toBe('add');
  });

  it('[drop ref: > target.id] sets refChange=drop on the ref', () => {
    const src = `
Table orders {
  user_id int [drop ref: > users.id]
}
Table users { id int [pk] }`;
    const { schema } = parseDbmlx(src);
    const ref = schema?.refs[0];
    expect(ref).toBeDefined();
    expect(ref!.refChange).toBe('drop');
  });

  it('does not set column change when only the ref is annotated', () => {
    const src = `
Table orders {
  user_id int [add ref: > users.id]
}
Table users { id int [pk] }`;
    const { schema } = parseDbmlx(src);
    const table = schema?.tables.find((t) => t.tableName === 'orders');
    expect(table?.columnChanges?.['user_id']).toBeUndefined();
  });

  it('standalone [add] after ref: is still a column annotation (backward compat)', () => {
    // Existing pattern: [pk, ref: - target.id, add] — "add" is a separate item → column add
    const src = `
Table orders {
  user_id int [pk, ref: > users.id, add]
}
Table users { id int [pk] }`;
    const { schema } = parseDbmlx(src);
    const table = schema?.tables.find((t) => t.tableName === 'orders');
    expect(table?.columnChanges?.['user_id']?.kind).toBe('add');
    const ref = schema?.refs[0];
    expect(ref?.refChange).toBeUndefined();
  });

  it('column [add] and inline [drop ref:] are independent', () => {
    // [add, drop ref: > target] — column add + ref drop in one bracket
    const src = `
Table orders {
  user_id int [add, drop ref: > users.id]
}
Table users { id int [pk] }`;
    const { schema } = parseDbmlx(src);
    const table = schema?.tables.find((t) => t.tableName === 'orders');
    expect(table?.columnChanges?.['user_id']?.kind).toBe('add');
    const ref = schema?.refs[0];
    expect(ref?.refChange).toBe('drop');
  });

  it('two annotated inline refs on same column (ref migration)', () => {
    // [add ref: > a.id, drop ref: > b.id] in a single bracket
    const src = `
Table orders {
  user_id int [add ref: > users.id, drop ref: > old_users.id]
}
Table users { id int [pk] }
Table old_users { id int [pk] }`;
    const { schema } = parseDbmlx(src);
    const addRef = schema?.refs.find((r) =>
      r.source.table === 'public.users' || r.target.table === 'public.users');
    const dropRef = schema?.refs.find((r) =>
      r.source.table === 'public.old_users' || r.target.table === 'public.old_users');
    expect(addRef?.refChange).toBe('add');
    expect(dropRef?.refChange).toBe('drop');
  });

  it('unannotated inline ref has no refChange', () => {
    const src = `
Table orders {
  user_id int [ref: > users.id]
}
Table users { id int [pk] }`;
    const { schema } = parseDbmlx(src);
    expect(schema?.refs[0]?.refChange).toBeUndefined();
  });
});
