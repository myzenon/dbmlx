// Generates a synthetic DBML file with ~5000 tables across multiple "bounded contexts".
// Usage: node scripts/gen-huge-fixture.mjs > test/fixtures/huge.dbml

const CONTEXTS = [
  'billing', 'catalog', 'identity', 'orders', 'inventory', 'shipping',
  'payments', 'analytics', 'notifications', 'audit', 'auth', 'reporting',
  'logistics', 'pricing', 'loyalty', 'risk', 'messaging', 'crm',
  'content', 'search',
];
const TABLES_PER_CONTEXT = 250; // 20 * 250 = 5000
const COLUMNS_PER_TABLE = 8;

const out = [];
out.push('// huge.dbml — generated fixture for perf testing (~5000 tables)\n');

for (const ctx of CONTEXTS) {
  for (let i = 0; i < TABLES_PER_CONTEXT; i++) {
    const tableName = `${ctx}_t${String(i).padStart(4, '0')}`;
    out.push(`Table ${tableName} {`);
    out.push(`  id int [pk, increment]`);
    for (let c = 0; c < COLUMNS_PER_TABLE - 1; c++) {
      const colName = pickCol(c);
      const colType = pickType(c);
      out.push(`  ${colName} ${colType}`);
    }
    out.push(`}`);
    out.push('');
  }
}

// Add some refs: for every 5th table, ref to the previous one in the same ctx.
for (const ctx of CONTEXTS) {
  for (let i = 1; i < TABLES_PER_CONTEXT; i += 5) {
    const from = `${ctx}_t${String(i).padStart(4, '0')}`;
    const to = `${ctx}_t${String(i - 1).padStart(4, '0')}`;
    out.push(`Ref: ${from}.parent_id > ${to}.id`);
  }
}
out.push('');

// TableGroups (one per context)
for (const ctx of CONTEXTS) {
  out.push(`TableGroup ${ctx} {`);
  for (let i = 0; i < TABLES_PER_CONTEXT; i++) {
    out.push(`  ${ctx}_t${String(i).padStart(4, '0')}`);
  }
  out.push(`}`);
  out.push('');
}

process.stdout.write(out.join('\n'));

function pickCol(i) {
  const names = ['parent_id', 'name', 'description', 'status', 'created_at', 'updated_at', 'amount', 'code'];
  return names[i % names.length];
}
function pickType(i) {
  const types = ['int', 'varchar', 'text', 'varchar', 'timestamp', 'timestamp', 'int', 'varchar'];
  return types[i % types.length];
}
