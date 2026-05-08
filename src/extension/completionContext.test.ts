import { describe, it, expect } from 'vitest';
import {
  isInsideStringOrComment,
  findUnclosedQuoteOpen,
  computeQuoteReplaceRange,
  computeQuoteReplaceRangeDot,
  classifyBracket,
  classifyRefStep,
  usedColumnsOnLine,
  isRefLine,
  extractRefPrefix,
} from './completionContext';

// ─── B13/B14: comment / string-value detection ──────────────────────────────

describe('isInsideStringOrComment', () => {
  it('returns false for plain text', () => {
    expect(isInsideStringOrComment('  user_id int [pk')).toBe(false);
  });

  it('returns true after //', () => {
    expect(isInsideStringOrComment('  user_id int // some')).toBe(true);
  });

  it('returns true inside single-quoted string', () => {
    expect(isInsideStringOrComment("Note: 'hello wor")).toBe(true);
  });

  it('returns false after a closed single-quoted string', () => {
    expect(isInsideStringOrComment("Note: 'hello' more")).toBe(false);
  });

  it('returns true inside backtick expression', () => {
    expect(isInsideStringOrComment('default: `now(')).toBe(true);
  });

  it('does NOT flag double-quote (used for identifiers)', () => {
    expect(isInsideStringOrComment('Ref: "pub')).toBe(false);
    expect(isInsideStringOrComment('"public"."users".')).toBe(false);
  });

  it('// inside a string is not a comment', () => {
    expect(isInsideStringOrComment("Note: 'http://example.com")).toBe(true);
    expect(isInsideStringOrComment("Note: 'http://example.com'")).toBe(false);
  });
});

// ─── A1: unclosed quote detection ───────────────────────────────────────────

describe('findUnclosedQuoteOpen', () => {
  it('finds the position of an unclosed quote', () => {
    expect(findUnclosedQuoteOpen('Ref: "pub')).toEqual({ openCol: 5 });
  });

  it('returns null for a closed pair', () => {
    expect(findUnclosedQuoteOpen('Ref: "public".')).toBeNull();
  });

  it('finds the second unclosed quote', () => {
    expect(findUnclosedQuoteOpen('Ref: "public"."pu')).toEqual({ openCol: 14 });
  });

  it('returns null when no quote present', () => {
    expect(findUnclosedQuoteOpen('Ref: schema.table')).toBeNull();
  });
});

describe('computeQuoteReplaceRange', () => {
  it('covers an unclosed " with cursor at end (no auto-close)', () => {
    const line = 'Ref: "pub';
    expect(computeQuoteReplaceRange(line, line.length)).toEqual({ startCol: 5, endCol: 9 });
  });

  it('swallows VS Code\'s auto-inserted closing "', () => {
    // Cursor is between auto-inserted `""`
    const line = 'Ref: ""';
    expect(computeQuoteReplaceRange(line, 6)).toEqual({ startCol: 5, endCol: 7 });
  });

  it('handles a partial second-segment identifier', () => {
    const line = 'Ref: "public"."pu';
    expect(computeQuoteReplaceRange(line, line.length)).toEqual({ startCol: 14, endCol: 17 });
  });

  it('returns null when not in a quote token', () => {
    expect(computeQuoteReplaceRange('Ref: schema.', 12)).toBeNull();
  });
});

describe('computeQuoteReplaceRangeDot', () => {
  it('includes a trailing . after the closing quote', () => {
    const line = 'Ref: "".';
    expect(computeQuoteReplaceRangeDot(line, 6)).toEqual({ startCol: 5, endCol: 8 });
  });

  it('falls back to the regular range when no trailing dot', () => {
    const line = 'Ref: ""';
    expect(computeQuoteReplaceRangeDot(line, 6)).toEqual({ startCol: 5, endCol: 7 });
  });
});

// ─── B5/B7: bracket classification ──────────────────────────────────────────

describe('classifyBracket', () => {
  it('settings for plain bracket content', () => {
    expect(classifyBracket('pk, ').kind).toBe('settings');
    expect(classifyBracket('').kind).toBe('settings');
  });

  it('modify-keys when last keyword is modify:', () => {
    expect(classifyBracket('modify: n').kind).toBe('modify-keys');
    expect(classifyBracket('pk, modify: name="x", ').kind).toBe('modify-keys');
  });

  it('modify-keys when last keyword is before: (alias)', () => {
    expect(classifyBracket('before: n').kind).toBe('modify-keys');
    expect(classifyBracket('pk, before: name="x", ').kind).toBe('modify-keys');
    expect(classifyBracket('ref: > users.id, before: name="x", ').kind).toBe('modify-keys');
  });

  it('ref-operator right after ref:', () => {
    expect(classifyBracket('ref:').kind).toBe('ref-operator');
    expect(classifyBracket('ref: ').kind).toBe('ref-operator');
    expect(classifyBracket('add ref: ').kind).toBe('ref-operator');
    expect(classifyBracket('drop ref: ').kind).toBe('ref-operator');
  });

  it('ref-table-column right after ref operator', () => {
    expect(classifyBracket('ref: > ').kind).toBe('ref-table-column');
    expect(classifyBracket('ref: > us').kind).toBe('ref-table-column');
    expect(classifyBracket('add ref: > ').kind).toBe('ref-table-column');
  });

  it('settings after a complete ref item + comma', () => {
    expect(classifyBracket('ref: > users.id, ').kind).toBe('settings');
    expect(classifyBracket('add ref: > users.id, ').kind).toBe('settings');
    expect(classifyBracket('pk, ref: > users.id, ').kind).toBe('settings');
  });

  it('handles 3-segment schema-qualified targets', () => {
    // `schema.table.col` style — targetRe must allow ≥ 1 dotted segment after the head
    expect(classifyBracket('ref: > "ai_system"."domains"."id", ').kind).toBe('settings');
    expect(classifyBracket('pk, ref: - "ai_system"."domains"."id", ').kind).toBe('settings');
    expect(classifyBracket('ref: > "ai_system"."domains"."id"').kind).toBe('ref-table-column');
  });

  it('modify after ref still classifies as modify-keys', () => {
    expect(classifyBracket('ref: > users.id, modify: name="x", ').kind).toBe('modify-keys');
  });
});

// ─── C: ref step detection ──────────────────────────────────────────────────

describe('classifyRefStep', () => {
  it('left-empty after Ref:', () => {
    expect(classifyRefStep('')?.kind).toBe('left-empty');
    expect(classifyRefStep(' ')?.kind).toBe('left-empty');
    expect(classifyRefStep('"')?.kind).toBe('left-empty');
  });

  it('operator step after a complete table.col', () => {
    expect(classifyRefStep('users.id')?.kind).toBe('operator');
    expect(classifyRefStep('users.id ')?.kind).toBe('operator');
    expect(classifyRefStep('"public"."users".id')?.kind).toBe('operator');
    expect(classifyRefStep('"ai_system"."domains"."id"')?.kind).toBe('operator');
    expect(classifyRefStep('"ai_system"."domains"."id" ')?.kind).toBe('operator');
  });

  it('right-empty after operator', () => {
    expect(classifyRefStep('users.id > ')?.kind).toBe('right-empty');
    expect(classifyRefStep('users.id < "')?.kind).toBe('right-empty');
    expect(classifyRefStep('users.id <> ')?.kind).toBe('right-empty');
  });

  it('returns null for mid-token states (handled by dotMatch)', () => {
    expect(classifyRefStep('users.')).toBeNull();
    expect(classifyRefStep('users.id > schema.')).toBeNull();
  });
});

// ─── D4: indexes-line dedupe ────────────────────────────────────────────────

describe('usedColumnsOnLine', () => {
  it('returns columns inside a composite tuple', () => {
    expect(usedColumnsOnLine('(domain_id, user_id, ')).toEqual(['domain_id', 'user_id']);
  });

  it('returns columns from a comma list', () => {
    expect(usedColumnsOnLine('  domain_id, ')).toEqual(['domain_id']);
  });

  it('handles quoted columns', () => {
    expect(usedColumnsOnLine('  "with space", "another", ')).toEqual(['with space', 'another']);
  });

  it('stops at the [ settings bracket', () => {
    expect(usedColumnsOnLine('(a, b) [name: "idx_')).toEqual(['a', 'b']);
  });

  it('returns empty when no comma present', () => {
    expect(usedColumnsOnLine('  domain_id')).toEqual([]);
  });
});

// ─── B6: ref-line detection ─────────────────────────────────────────────────

describe('isRefLine / extractRefPrefix', () => {
  it('matches Ref:', () => {
    expect(isRefLine('Ref: ')).toBe(true);
    expect(isRefLine('  Ref: users.')).toBe(true);
    expect(isRefLine('Ref "fk_orders": users.id > orders.user_id')).toBe(true);
  });

  it('rejects non-ref lines', () => {
    expect(isRefLine('Table users {')).toBe(false);
    expect(isRefLine('  user_id int [ref: > users.id]')).toBe(false); // inline, inside bracket
  });

  it('extractRefPrefix returns text after the colon', () => {
    expect(extractRefPrefix('Ref: users.')).toBe('users.');
    expect(extractRefPrefix('Ref "fk": users.id > ')).toBe('users.id > ');
    expect(extractRefPrefix('Table users {')).toBeNull();
  });
});
