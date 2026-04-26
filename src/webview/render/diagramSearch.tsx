import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { useAppStore } from '../state/store';
import { focusTable } from './viewport';

export function DiagramSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchIdx, setMatchIdx] = useState(0);
  const schema = useAppStore((s) => s.schema);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.trim().toLowerCase();
    return schema.tables
      .filter((t) => t.tableName.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
      .map((t) => t.name);
  }, [query, schema.tables]);

  // Open on Ctrl+F / Cmd+F
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Focus input when opened
  useEffect(() => {
    if (open) setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
  }, [open]);

  // Auto-jump to first match as query changes
  useEffect(() => {
    setMatchIdx(0);
    if (matches.length > 0) focusTable(matches[0]!);
  }, [matches]);

  const close = () => { setOpen(false); setQuery(''); };

  const goTo = (delta: number) => {
    if (matches.length === 0) return;
    const next = ((matchIdx + delta) % matches.length + matches.length) % matches.length;
    setMatchIdx(next);
    focusTable(matches[next]!);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'Enter') { e.preventDefault(); goTo(e.shiftKey ? -1 : 1); }
  };

  if (!open) return null;

  return (
    <div class="ddd-search">
      <input
        ref={inputRef}
        class="ddd-search__input"
        type="text"
        placeholder="Find table…"
        value={query}
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        onKeyDown={handleKeyDown as (e: KeyboardEvent) => void}
      />
      {query.trim() ? (
        <span class="ddd-search__count">
          {matches.length === 0 ? 'No matches' : `${matchIdx + 1} / ${matches.length}`}
        </span>
      ) : null}
      <button class="ddd-search__close" onClick={close} title="Close (Esc)">×</button>
    </div>
  );
}
