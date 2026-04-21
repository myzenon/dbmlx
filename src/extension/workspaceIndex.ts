import * as vscode from 'vscode';
import { parseDbmlx } from './parser';
import type { ParseError, QualifiedName, Schema } from '../shared/types';

export interface SymbolLocation {
  uri: vscode.Uri;
  line: number; // 0-indexed, in the original source file
}

/** Raw file data — source + include list, no parsing. */
interface RawFile {
  uri: vscode.Uri;
  source: string;
  includes: vscode.Uri[]; // direct !include references
}

/** A contiguous segment of lines from one source file within a stitched document. */
interface Span {
  uri: vscode.Uri;
  stitchStart: number; // first line in stitched content
  lineCount: number;
  localStart: number;  // corresponding first line in the source file
}

/** Result of stitching a root file + all its transitive includes. */
interface StitchedRoot {
  uri: vscode.Uri;
  content: string;
  spans: Span[];
  schema: Schema | null;
  error: ParseError | null;
  /** Which source file the error came from (mapped via spans). */
  errorUri: vscode.Uri | null;
  /** Local 1-indexed line within errorUri (differs from error.line when includes are involved). */
  errorLocalLine: number | null;
}

export interface ResolvedSchema {
  schema: Schema;
  errors: Map<string, { uri: vscode.Uri; error: ParseError }>;
}

const INCLUDE_RE = /^(?:\/\/|!)include\s+"([^"]+)"/;
const TABLE_DEF_RE = /^\s*[Tt]able\s+([\w."]+(?:\.[\w."]+)?)\s*(?:[Aa]s\s+\w+)?\s*(?:\[[^\]]*\])?\s*\{/;

export class WorkspaceIndex implements vscode.Disposable {
  /** Raw source + includes per file, populated by scanning. */
  private readonly raw = new Map<string, RawFile>();
  /** Stitched+parsed result per root file. */
  private readonly roots = new Map<string, StitchedRoot>();
  /**
   * Last successfully parsed Schema per root URI.
   * LSP providers (completion, hover, definition) fall back to this when the
   * current parse fails (e.g. while the user is mid-way through typing a Ref
   * or a new column). Diagnostics still reflect the actual error.
   */
  private readonly bestSchemas = new Map<string, Schema>();
  /** Table → source file + line (from regex scan, not @dbml/core). */
  private readonly tableLocations = new Map<QualifiedName, SymbolLocation>();
  /** "schema.table\0col" → source file + line for column definitions. */
  private readonly columnLocations = new Map<string, SymbolLocation>();

  private readonly _onChange = new vscode.EventEmitter<vscode.Uri>();
  public readonly onChange: vscode.Event<vscode.Uri> = this._onChange.event;
  private readonly disposables: vscode.Disposable[] = [this._onChange];

  private readonly _diagCollection = vscode.languages.createDiagnosticCollection('dbmlx');
  private _typingTimer: ReturnType<typeof setTimeout> | null = null;
  // Serialise all rebuild calls so concurrent FS/save/typing events never
  // interleave a roots.clear() with a consumer reading roots.
  private _rebuildChain: Promise<void> = Promise.resolve();

  // ── Lifecycle ────────────────────────────────────────────────────────────

  static async create(context: vscode.ExtensionContext): Promise<WorkspaceIndex> {
    const idx = new WorkspaceIndex();
    await idx.init(context);
    context.subscriptions.push(idx);
    return idx;
  }

  private async init(context: vscode.ExtensionContext): Promise<void> {
    context.subscriptions.push(this._diagCollection);

    const uris = await vscode.workspace.findFiles('**/*.dbmlx', '**/node_modules/**');
    await Promise.all(uris.map((u) => this.scanFile(u)));
    await this.rebuild(undefined);

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.dbmlx');
    watcher.onDidChange(async (u) => {
      // Skip if this URI was already synced from the in-memory document (save
      // event) — getText() is authoritative; avoid an extra disk read race.
      await this.scanFile(u);
      await this.rebuild(u);
    });
    watcher.onDidCreate(async (u) => {
      await this.scanFile(u);
      await this.rebuild(u);
    });
    watcher.onDidDelete(async (u) => {
      this.raw.delete(u.toString());
      this.bestSchemas.delete(u.toString());
      await this.rebuild(u);
    });
    this.disposables.push(watcher);

    // Authoritative save trigger: uses in-memory text (doc.getText()), avoiding
    // macOS FS-watcher timing issues where the file may not be on disk yet.
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (!doc.uri.fsPath.endsWith('.dbmlx')) return;
        this.applyInMemory(doc);
        await this.rebuild(doc.uri);
      }),
    );

    // Live typing: update diagnostics as the user types (debounced 400 ms).
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!e.document.uri.fsPath.endsWith('.dbmlx')) return;
        if (e.contentChanges.length === 0) return;
        if (this._typingTimer) clearTimeout(this._typingTimer);
        this._typingTimer = setTimeout(() => {
          this._typingTimer = null;
          const doc = e.document;
          this.applyInMemory(doc);
          void this.rebuild(doc.uri);
        }, 400);
      }),
    );
  }

  public dispose(): void {
    if (this._typingTimer) { clearTimeout(this._typingTimer); this._typingTimer = null; }
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  /** Apply in-memory document text to raw without reading from disk. */
  private applyInMemory(doc: vscode.TextDocument): void {
    const source = doc.getText();
    const includes = extractIncludes(source, doc.uri);
    this.raw.set(doc.uri.toString(), { uri: doc.uri, source, includes });
  }

  /**
   * Serialised rebuild: queues a rebuild so concurrent triggers (FS watcher +
   * save + typing) never interleave a roots.clear() with a consumer reading roots.
   */
  private async rebuild(changedUri: vscode.Uri | undefined): Promise<void> {
    this._rebuildChain = this._rebuildChain.then(() => this._doRebuild(changedUri));
    return this._rebuildChain;
  }

  private async _doRebuild(changedUri: vscode.Uri | undefined): Promise<void> {
    await this.rebuildRoots();
    this.rebuildLocationTable();
    this._refreshDiagnostics();
    if (changedUri) this._onChange.fire(changedUri);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Returns the merged Schema for rootUri (stitched + parsed as one document).
   * This is what DiagramPanel uses — all tables from all included files visible.
   */
  public getResolvedSchema(rootUri: vscode.Uri): ResolvedSchema {
    const errors = new Map<string, { uri: vscode.Uri; error: ParseError }>();

    let root = this.roots.get(rootUri.toString());

    // Module file (included by another root) — parse it standalone on demand
    if (!root && this.raw.has(rootUri.toString())) {
      const stitched = stitchContent(rootUri, this.raw, new Set());
      const result = parseDbmlx(stitched.content);
      if (result.error) {
        errors.set(rootUri.toString(), { uri: rootUri, error: result.error });
        return { schema: { tables: [], refs: [], groups: [], views: [] }, errors };
      }
      return { schema: result.schema ?? { tables: [], refs: [], groups: [], views: [] }, errors };
    }

    if (!root) {
      return { schema: { tables: [], refs: [], groups: [], views: [] }, errors };
    }
    if (root.error && root.errorUri) {
      errors.set(root.errorUri.toString(), { uri: root.errorUri, error: root.error });
    }
    return { schema: root.schema ?? { tables: [], refs: [], groups: [], views: [] }, errors };
  }

  public getFileError(uri: vscode.Uri): ParseError | null {
    for (const root of this.roots.values()) {
      if (root.errorUri?.fsPath !== uri.fsPath) continue;
      if (!root.error) return null;
      // Remap the stitched line number to the local file line so the squiggle
      // lands at the right position even when !include is involved.
      const localLine = root.errorLocalLine ?? root.error.line;
      const message = localLine != null && root.error.line != null
        ? root.error.message.replace(`(line ${root.error.line})`, `(line ${localLine})`)
        : root.error.message;
      return { ...root.error, line: localLine, message };
    }
    return null;
  }

  public getAllUris(): vscode.Uri[] {
    return [...this.raw.values()].map((f) => f.uri);
  }

  public getTableLocation(name: QualifiedName): SymbolLocation | undefined {
    return this.tableLocations.get(name);
  }

  public getColumnLocation(table: QualifiedName, col: string): SymbolLocation | undefined {
    return this.columnLocations.get(`${table}\0${col}`);
  }

  /** Returns the fully-stitched (includes resolved) DBML source for a root file, or null if not found. */
  public getStitchedContent(uri: vscode.Uri): string | null {
    return this.roots.get(uri.toString())?.content ?? null;
  }

  public getAllTableNames(): QualifiedName[] {
    return [...this.tableLocations.keys()];
  }

  /**
   * Returns table names visible from `uri` — tables defined in uri itself plus
   * every file it transitively !include-s. Used for scoped completion.
   */
  public getVisibleTableNames(uri: vscode.Uri): QualifiedName[] {
    const reachable = this.reachableUris(uri);
    return [...this.tableLocations.entries()]
      .filter(([, loc]) => reachable.has(loc.uri.toString()))
      .map(([name]) => name);
  }

  private reachableUris(uri: vscode.Uri): Set<string> {
    const visited = new Set<string>();
    const stack: vscode.Uri[] = [uri];
    while (stack.length) {
      const u = stack.pop()!;
      const key = u.toString();
      if (visited.has(key)) continue;
      visited.add(key);
      const file = this.raw.get(key);
      if (file) for (const inc of file.includes) stack.push(inc);
    }
    return visited;
  }

  public getTable(name: QualifiedName): import('../shared/types').Table | undefined {
    for (const root of this.roots.values()) {
      if (!root.schema) continue;
      const t = root.schema.tables.find((tb) => tb.name === name);
      if (t) return t;
    }
    // Fall back to last good schemas — keeps LSP working while the file has a
    // transient parse error (e.g. mid-edit, incomplete Ref statement).
    for (const schema of this.bestSchemas.values()) {
      const t = schema.tables.find((tb) => tb.name === name);
      if (t) return t;
    }
    return undefined;
  }

  public getTablesInFile(uri: vscode.Uri): Array<{ name: QualifiedName; line: number }> {
    const fp = uri.fsPath;
    const result: Array<{ name: QualifiedName; line: number }> = [];
    for (const [name, loc] of this.tableLocations) {
      if (loc.uri.fsPath === fp) result.push({ name, line: loc.line });
    }
    return result;
  }

  public getGroupNames(uri: vscode.Uri): string[] {
    const names = new Set<string>();
    let found = false;
    for (const root of this.roots.values()) {
      if (!root.schema) continue;
      const reachable = this.reachableUris(root.uri);
      if (!reachable.has(uri.toString())) continue;
      for (const g of root.schema.groups) names.add(g.name);
      found = true;
    }
    if (!found) {
      for (const schema of this.bestSchemas.values()) {
        for (const g of schema.groups) names.add(g.name);
      }
    }
    return [...names].sort();
  }

  public getSchemaNames(uri: vscode.Uri): string[] {
    const reachable = this.reachableUris(uri);
    const names = new Set<string>();
    for (const [name, loc] of this.tableLocations) {
      if (!reachable.has(loc.uri.toString())) continue;
      const dot = name.indexOf('.');
      if (dot > 0) names.add(name.substring(0, dot));
    }
    return [...names].sort();
  }

  public isIncludedFile(uri: vscode.Uri): boolean {
    const fp = uri.fsPath;
    for (const f of this.raw.values()) {
      if (f.includes.some((u) => u.fsPath === fp)) return true;
    }
    return false;
  }

  /**
   * If uri is a module file (!include'd by another), returns the URI of the
   * root file that (transitively) includes it. Returns the uri itself if it
   * is already a root. Useful for opening the full diagram from a module file.
   */
  public resolveRootUri(uri: vscode.Uri): vscode.Uri {
    const fp = uri.fsPath;
    // Already a root
    if (this.roots.has(uri.toString())) return uri;
    // BFS: find which root transitively includes this file
    for (const root of this.roots.values()) {
      const visited = new Set<string>();
      const queue: vscode.Uri[] = [root.uri];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (visited.has(cur.toString())) continue;
        visited.add(cur.toString());
        const raw = this.raw.get(cur.toString());
        if (!raw) continue;
        for (const inc of raw.includes) {
          if (inc.fsPath === fp) return root.uri;
          queue.push(inc);
        }
      }
    }
    return uri; // not found, treat as root
  }

  // ── Scanning & stitching ─────────────────────────────────────────────────

  /** Phase 1: read file, extract includes — no @dbml/core yet. */
  private async scanFile(uri: vscode.Uri): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const source = new TextDecoder('utf-8').decode(bytes);
      const includes = extractIncludes(source, uri);
      this.raw.set(uri.toString(), { uri, source, includes });
    } catch {
      this.raw.delete(uri.toString());
    }
  }

  /**
   * Phase 2: for every root file (not included by anyone), stitch all its
   * transitive includes into one DBML string and parse it once.
   * @dbml/core sees a complete schema → no "Cannot find Table" errors.
   */
  private async rebuildRoots(): Promise<void> {
    this.roots.clear();
    for (const f of this.raw.values()) {
      if (!this.isIncludedFile(f.uri)) {
        const stitched = stitchContent(f.uri, this.raw, new Set());
        const result = parseDbmlx(stitched.content);
        let errorUri: vscode.Uri | null = null;
        let errorLocalLine: number | null = null;
        if (result.error) {
          const mapped = mapLineToLocal(result.error.line ?? 1, stitched.spans);
          errorUri = mapped?.uri ?? f.uri;
          errorLocalLine = mapped?.localLine ?? result.error.line ?? null;
        } else if (result.schema) {
          // Persist the last good schema so LSP can still serve completions/hover
          // while the user is mid-edit and the file temporarily fails to parse.
          this.bestSchemas.set(f.uri.toString(), result.schema);
        }
        this.roots.set(f.uri.toString(), {
          uri: f.uri,
          content: stitched.content,
          spans: stitched.spans,
          schema: result.error ? null : result.schema,
          error: result.error,
          errorUri,
          errorLocalLine,
        });
      }
    }
  }

  /** Update the VSCode diagnostic collection to match the current roots state. */
  private _refreshDiagnostics(): void {
    this._diagCollection.clear();
    for (const root of this.roots.values()) {
      if (!root.error || !root.errorUri) continue;
      const localLine = root.errorLocalLine ?? root.error.line;
      const col = root.error.column ?? 1;
      const message =
        localLine != null && root.error.line != null
          ? root.error.message.replace(`(line ${root.error.line})`, `(line ${localLine})`)
          : root.error.message;
      const range = new vscode.Range(
        Math.max(0, (localLine ?? 1) - 1),
        Math.max(0, col - 1),
        Math.max(0, (localLine ?? 1) - 1),
        Math.max(0, col),
      );
      const diag = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
      diag.source = 'dbmlx';
      this._diagCollection.set(root.errorUri, [diag]);
    }
  }

  /** Phase 3: regex-scan each file individually for table + column definition lines. */
  private rebuildLocationTable(): void {
    this.tableLocations.clear();
    this.columnLocations.clear();

    const COL_RE = /^\s{1,}(?:"([^"]+)"|(\w+))\s+\S/;
    const SKIP_RE = /^\s*(indexes|note|Note)\s*[:{]/;

    for (const f of this.raw.values()) {
      const lines = f.source.split(/\r?\n/);
      let currentQn: QualifiedName | null = null;
      let depth = 0;
      let tableBodyDepth = -1;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';

        const tableMatch = TABLE_DEF_RE.exec(line);
        if (tableMatch && depth === 0) {
          const ident = tableMatch[1]!.replace(/"/g, '');
          const parts = ident.split('.');
          const schema = parts.length > 1 ? parts[0]! : 'public';
          const table = parts.length > 1 ? parts.slice(1).join('.') : ident;
          const qn: QualifiedName = `${schema}.${table}`;
          if (!this.tableLocations.has(qn)) {
            this.tableLocations.set(qn, { uri: f.uri, line: i });
          }
          currentQn = qn;
          tableBodyDepth = depth + (line.includes('{') ? 1 : 0);
        }

        const opens = (line.match(/\{/g) ?? []).length;
        const closes = (line.match(/\}/g) ?? []).length;
        depth += opens - closes;

        if (currentQn && depth === tableBodyDepth && !tableMatch && !SKIP_RE.test(line)) {
          const colMatch = COL_RE.exec(line);
          if (colMatch) {
            const col = (colMatch[1] ?? colMatch[2])!;
            const key = `${currentQn}\0${col}`;
            if (!this.columnLocations.has(key)) {
              this.columnLocations.set(key, { uri: f.uri, line: i });
            }
          }
        }

        if (currentQn && depth < tableBodyDepth) {
          currentQn = null;
          tableBodyDepth = -1;
        }
      }
    }
  }
}

// ── Stitching helpers ─────────────────────────────────────────────────────

interface StitchResult {
  content: string;
  spans: Span[];
}

/**
 * Recursively inlines !include directives, building one flat DBML string.
 * Tracks which source file each line came from so errors can be attributed.
 */
function stitchContent(
  uri: vscode.Uri,
  raw: Map<string, RawFile>,
  visited: Set<string>,
): StitchResult {
  const key = uri.toString();
  if (visited.has(key)) return { content: '', spans: [] };
  visited.add(key);

  const file = raw.get(key);
  if (!file) return { content: '', spans: [] };

  const baseDir = vscode.Uri.joinPath(uri, '..');
  const fileLines = file.source.split(/\r?\n/);
  const outputLines: string[] = [];
  const spans: Span[] = [];

  let segLocalStart = 0;   // local line in this file where current segment began
  let segStitchStart = 0;  // stitched line where current segment began

  const flushSegment = () => {
    const count = outputLines.length - segStitchStart;
    if (count > 0) spans.push({ uri, stitchStart: segStitchStart, lineCount: count, localStart: segLocalStart });
  };

  for (let localLine = 0; localLine < fileLines.length; localLine++) {
    const line = fileLines[localLine]!;
    const m = INCLUDE_RE.exec(line);
    if (m) {
      // Flush current segment of this file before inserting included content
      flushSegment();

      // Replace the !include line with a blank (keeps line numbers stable in this file)
      outputLines.push('');

      // Recursively stitch the included file
      const incUri = vscode.Uri.joinPath(baseDir, m[1]!);
      const sub = stitchContent(incUri, raw, visited);
      const offset = outputLines.length;
      for (const s of sub.spans) {
        spans.push({ ...s, stitchStart: s.stitchStart + offset });
      }
      if (sub.content) {
        for (const l of sub.content.split(/\r?\n/)) outputLines.push(l);
      }

      // Start new segment for the remainder of this file
      segStitchStart = outputLines.length;
      segLocalStart = localLine + 1;
    } else {
      outputLines.push(line);
    }
  }

  flushSegment();
  return { content: outputLines.join('\n'), spans };
}

function extractIncludes(source: string, baseUri: vscode.Uri): vscode.Uri[] {
  const baseDir = vscode.Uri.joinPath(baseUri, '..');
  const out: vscode.Uri[] = [];
  for (const line of source.split(/\r?\n/)) {
    const m = INCLUDE_RE.exec(line);
    if (m) out.push(vscode.Uri.joinPath(baseDir, m[1]!));
  }
  return out;
}

/** Map a 1-indexed stitched line to the originating source file and its local 1-indexed line. */
function mapLineToLocal(
  stitchLine: number,
  spans: Span[],
): { uri: vscode.Uri; localLine: number } | undefined {
  const idx = stitchLine - 1; // convert to 0-indexed
  for (const s of spans) {
    if (idx >= s.stitchStart && idx < s.stitchStart + s.lineCount) {
      return { uri: s.uri, localLine: s.localStart + (idx - s.stitchStart) + 1 };
    }
  }
  return undefined;
}
