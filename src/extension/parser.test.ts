import { describe, it, expect } from 'vitest';
import { parseDbmlx, stripDbmlxExtensions } from './parser';

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

// ─── Column [modify:] annotations ────────────────────────────────────────────

describe('parseDbmlx — column [modify:]', () => {
  it('extracts fromName and fromType', () => {
    const src = `
Table users {
  user_login text [modify: name="username", type="varchar(50)"]
}`;
    const { schema } = parseDbmlx(src);
    const change = schema?.tables[0]?.columnChanges?.['user_login'];
    expect(change?.kind).toBe('modify');
    if (change?.kind !== 'modify') return;
    expect(change.fromName).toBe('username');
    expect(change.fromType).toBe('varchar(50)');
  });

  it('extracts fromPk, fromNotNull, fromUnique boolean flags', () => {
    const src = `
Table users {
  id int [pk, not null, modify: pk=false, not_null=false, unique=true]
}`;
    const { schema } = parseDbmlx(src);
    const change = schema?.tables[0]?.columnChanges?.['id'];
    expect(change?.kind).toBe('modify');
    if (change?.kind !== 'modify') return;
    expect(change.fromPk).toBe(false);
    expect(change.fromNotNull).toBe(false);
    expect(change.fromUnique).toBe(true);
  });

  it('extracts fromDefault', () => {
    const src = `
Table users {
  status varchar [default: 'active', modify: default="inactive"]
}`;
    const { schema } = parseDbmlx(src);
    const change = schema?.tables[0]?.columnChanges?.['status'];
    expect(change?.kind).toBe('modify');
    if (change?.kind !== 'modify') return;
    expect(change.fromDefault).toBe('inactive');
  });

  it('extracts fromIncrement', () => {
    const src = `
Table users {
  id int [pk, increment, modify: increment=false]
}`;
    const { schema } = parseDbmlx(src);
    const change = schema?.tables[0]?.columnChanges?.['id'];
    expect(change?.kind).toBe('modify');
    if (change?.kind !== 'modify') return;
    expect(change.fromIncrement).toBe(false);
  });

  it('does not set columnChanges for unmodified columns', () => {
    const src = `
Table users {
  id int [pk]
  name varchar [modify: type="text"]
}`;
    const { schema } = parseDbmlx(src);
    const table = schema?.tables[0];
    expect(table?.columnChanges?.['id']).toBeUndefined();
    expect(table?.columnChanges?.['name']?.kind).toBe('modify');
  });

  it('[modify:] column is still parsed by @dbml/core (strip only removes annotation)', () => {
    const src = `
Table users {
  email varchar(255) [not null, modify: type="text"]
}`;
    const { schema } = parseDbmlx(src);
    const col = schema?.tables[0]?.columns.find((c) => c.name === 'email');
    expect(col).toBeDefined();
    expect(col?.type).toBe('varchar(255)');
    expect(col?.notNull).toBeTruthy();
  });
});

// ─── Table-level [add] / [drop] / [modify:] ──────────────────────────────────

describe('parseDbmlx — table-level annotations', () => {
  it('[add] on table header sets tableChange=add', () => {
    const src = `
Table audit_log [add] {
  id int [pk]
}`;
    const { schema } = parseDbmlx(src);
    const table = schema?.tables.find((t) => t.tableName === 'audit_log');
    expect(table?.tableChange).toBe('add');
  });

  it('[drop] on table header sets tableChange=drop', () => {
    const src = `
Table old_cache [drop] {
  id int [pk]
}`;
    const { schema } = parseDbmlx(src);
    const table = schema?.tables.find((t) => t.tableName === 'old_cache');
    expect(table?.tableChange).toBe('drop');
  });

  it('[modify: name="old_name"] sets tableChange=modify and tableFromName', () => {
    const src = `
Table new_users [modify: name="users"] {
  id int [pk]
}`;
    const { schema } = parseDbmlx(src);
    const table = schema?.tables.find((t) => t.tableName === 'new_users');
    expect(table?.tableChange).toBe('modify');
    expect(table?.tableFromName).toBe('users');
  });

  it('table without annotation has no tableChange', () => {
    const src = `Table plain { id int [pk] }`;
    const { schema } = parseDbmlx(src);
    const table = schema?.tables.find((t) => t.tableName === 'plain');
    expect(table?.tableChange).toBeUndefined();
    expect(table?.tableFromName).toBeUndefined();
  });

  it('table annotation does not bleed into columns', () => {
    const src = `
Table audit_log [add] {
  id int [pk]
  created_at timestamp
}`;
    const { schema } = parseDbmlx(src);
    const table = schema?.tables.find((t) => t.tableName === 'audit_log');
    expect(Object.keys(table?.columnChanges ?? {})).toHaveLength(0);
  });
});

// ─── Top-level Ref [add] / [drop] ────────────────────────────────────────────

describe('parseDbmlx — top-level Ref annotations', () => {
  it('Ref [add] sets refChange=add', () => {
    const src = `
Table orders { user_id int }
Table users { id int [pk] }
Ref: orders.user_id > users.id [add]`;
    const { schema } = parseDbmlx(src);
    const ref = schema?.refs[0];
    expect(ref?.refChange).toBe('add');
  });

  it('Ref [drop] sets refChange=drop', () => {
    const src = `
Table orders { user_id int }
Table users { id int [pk] }
Ref: orders.user_id > users.id [drop]`;
    const { schema } = parseDbmlx(src);
    const ref = schema?.refs[0];
    expect(ref?.refChange).toBe('drop');
  });

  it('named Ref with [add] preserves the ref name', () => {
    const src = `
Table orders { user_id int }
Table users { id int [pk] }
Ref fk_orders_users: orders.user_id > users.id [add]`;
    const { schema } = parseDbmlx(src);
    const ref = schema?.refs[0];
    expect(ref?.refChange).toBe('add');
    expect(ref?.name).toBe('fk_orders_users');
  });

  it('unannotated top-level Ref has no refChange', () => {
    const src = `
Table orders { user_id int }
Table users { id int [pk] }
Ref: orders.user_id > users.id`;
    const { schema } = parseDbmlx(src);
    expect(schema?.refs[0]?.refChange).toBeUndefined();
  });
});

// ─── Index [add] / [drop] ────────────────────────────────────────────────────

describe('parseDbmlx — index annotations', () => {
  it('simple index [add] sets indexChanges kind=add', () => {
    const src = `
Table users {
  id int [pk]
  email varchar
  indexes {
    email [add, unique]
  }
}`;
    const { schema } = parseDbmlx(src);
    const table = schema?.tables.find((t) => t.tableName === 'users');
    expect(table?.indexChanges).toHaveLength(1);
    expect(table?.indexChanges?.[0]?.kind).toBe('add');
    expect(table?.indexChanges?.[0]?.columns).toEqual(['email']);
  });

  it('composite index [add] captures all columns', () => {
    const src = `
Table users {
  id int [pk]
  first_name varchar
  last_name varchar
  indexes {
    (first_name, last_name) [add]
  }
}`;
    const { schema } = parseDbmlx(src);
    const table = schema?.tables.find((t) => t.tableName === 'users');
    expect(table?.indexChanges?.[0]?.columns).toEqual(['first_name', 'last_name']);
    expect(table?.indexChanges?.[0]?.kind).toBe('add');
  });

  it('index [drop] sets indexChanges kind=drop', () => {
    const src = `
Table users {
  id int [pk]
  email varchar
  indexes {
    email [drop]
  }
}`;
    const { schema } = parseDbmlx(src);
    const table = schema?.tables.find((t) => t.tableName === 'users');
    expect(table?.indexChanges?.[0]?.kind).toBe('drop');
    expect(table?.indexChanges?.[0]?.columns).toEqual(['email']);
  });

  it('unannotated indexes have no indexChanges', () => {
    const src = `
Table users {
  id int [pk]
  email varchar [unique]
  indexes {
    email [unique]
  }
}`;
    const { schema } = parseDbmlx(src);
    const table = schema?.tables.find((t) => t.tableName === 'users');
    expect(table?.indexChanges ?? []).toHaveLength(0);
  });
});

// ─── DiagramView extraction ───────────────────────────────────────────────────

describe('parseDbmlx — DiagramView', () => {
  it('extracts view name and Tables section', () => {
    const src = `
Table users { id int [pk] }
DiagramView auth_context {
  Tables { users }
}`;
    const { schema } = parseDbmlx(src);
    expect(schema?.views).toHaveLength(1);
    expect(schema?.views[0]?.name).toBe('auth_context');
    expect(schema?.views[0]?.tables).toEqual(['users']);
  });

  it('extracts TableGroups and Schemas sections', () => {
    const src = `
DiagramView billing_view {
  TableGroups { billing }
  Schemas { public }
}`;
    const { schema } = parseDbmlx(src);
    const view = schema?.views[0];
    expect(view?.tableGroups).toEqual(['billing']);
    expect(view?.schemas).toEqual(['public']);
  });

  it('DiagramView is stripped before @dbml/core parsing (no parse error)', () => {
    const src = `
Table users { id int [pk] }
DiagramView my_view {
  Tables { users }
}`;
    const { schema, error } = parseDbmlx(src);
    expect(error).toBeNull();
    expect(schema).toBeDefined();
  });

  it('Tables { * } → null (wildcard, no filter)', () => {
    const src = `
DiagramView all_view {
  Tables { * }
}`;
    const { schema } = parseDbmlx(src);
    const view = schema?.views[0];
    // '*' is parsed as wildcard — empty array means "include all"
    expect(view?.tables).toEqual([]);
  });

  it('omitted section is null', () => {
    const src = `
DiagramView tables_only {
  Tables { users }
}`;
    const { schema } = parseDbmlx(src);
    const view = schema?.views[0];
    expect(view?.tableGroups).toBeNull();
    expect(view?.schemas).toBeNull();
  });

  it('multiple DiagramViews are all captured', () => {
    const src = `
DiagramView view_a { Tables { a } }
DiagramView view_b { Schemas { public } }`;
    const { schema } = parseDbmlx(src);
    expect(schema?.views).toHaveLength(2);
    expect(schema?.views.map((v) => v.name)).toEqual(['view_a', 'view_b']);
  });
});

// ─── General parsing ──────────────────────────────────────────────────────────

describe('parseDbmlx — basic table and column parsing', () => {
  it('parses table name and schema as qualified name', () => {
    const src = `Table users { id int [pk] }`;
    const { schema } = parseDbmlx(src);
    const table = schema?.tables.find((t) => t.tableName === 'users');
    expect(table?.name).toBe('public.users');
    expect(table?.schemaName).toBe('public');
  });

  it('assigns schema from schema-qualified table syntax', () => {
    const src = `
Table "auth"."accounts" {
  id int [pk]
}`;
    const { schema } = parseDbmlx(src);
    const table = schema?.tables.find((t) => t.tableName === 'accounts');
    expect(table?.schemaName).toBe('auth');
    expect(table?.name).toBe('auth.accounts');
  });

  it('parses column pk, not null, unique, increment flags', () => {
    const src = `
Table users {
  id int [pk, increment]
  email varchar [unique, not null]
}`;
    const { schema } = parseDbmlx(src);
    const table = schema?.tables.find((t) => t.tableName === 'users');
    const id = table?.columns.find((c) => c.name === 'id');
    const email = table?.columns.find((c) => c.name === 'email');
    expect(id?.pk).toBeTruthy();
    expect(id?.increment).toBeTruthy();
    expect(email?.unique).toBeTruthy();
    expect(email?.notNull).toBeTruthy();
  });

  it('parses column default value', () => {
    const src = `
Table users {
  status varchar [default: 'active']
  score int [default: 0]
}`;
    const { schema } = parseDbmlx(src);
    const table = schema?.tables.find((t) => t.tableName === 'users');
    const status = table?.columns.find((c) => c.name === 'status');
    const score = table?.columns.find((c) => c.name === 'score');
    expect(status?.default).toBeTruthy(); // value is truthy
    expect(score?.default).toBe('0');
  });

  it('maps TableGroup membership to groupName on tables', () => {
    const src = `
Table orders { id int [pk] }
Table invoices { id int [pk] }
TableGroup billing {
  orders
  invoices
}`;
    const { schema } = parseDbmlx(src);
    const orders = schema?.tables.find((t) => t.tableName === 'orders');
    const invoices = schema?.tables.find((t) => t.tableName === 'invoices');
    expect(orders?.groupName).toBe('billing');
    expect(invoices?.groupName).toBe('billing');
  });

  it('tables not in a group have groupName=null', () => {
    const src = `Table users { id int [pk] }`;
    const { schema } = parseDbmlx(src);
    expect(schema?.tables[0]?.groupName).toBeNull();
  });

  it('tables are sorted alphabetically by qualified name', () => {
    const src = `
Table zebra { id int }
Table alpha { id int }`;
    const { schema } = parseDbmlx(src);
    const names = schema?.tables.map((t) => t.tableName);
    expect(names).toEqual(['alpha', 'zebra']);
  });

  it('returns error object on parse failure', () => {
    const { schema, error } = parseDbmlx('Table broken {{{');
    expect(schema).toBeNull();
    expect(error).toBeDefined();
    expect(typeof error?.message).toBe('string');
  });

  it('schema is null and error is non-null on invalid DBML', () => {
    const { schema, error } = parseDbmlx('not valid dbml at all %%%');
    expect(schema).toBeNull();
    expect(error).not.toBeNull();
  });
});

// ─── stripDbmlxExtensions ────────────────────────────────────────────────────

describe('stripDbmlxExtensions', () => {
  it('removes DiagramView blocks', () => {
    const src = `
Table users { id int [pk] }
DiagramView my_view { Tables { users } }`;
    const stripped = stripDbmlxExtensions(src);
    expect(stripped).not.toContain('DiagramView');
    expect(stripped).toContain('Table users');
  });

  it('removes [add] annotations from columns', () => {
    const src = `
Table users {
  new_col varchar [add]
}`;
    const stripped = stripDbmlxExtensions(src);
    expect(stripped).not.toContain('[add]');
    expect(stripped).toContain('new_col varchar');
  });

  it('removes [modify:] annotations from columns', () => {
    const src = `
Table users {
  email text [modify: name="username"]
}`;
    const stripped = stripDbmlxExtensions(src);
    expect(stripped).not.toContain('modify:');
  });

  it('keeps standard column settings intact', () => {
    const src = `
Table users {
  id int [pk, not null, increment]
}`;
    const stripped = stripDbmlxExtensions(src);
    expect(stripped).toContain('[pk, not null, increment]');
  });
});
