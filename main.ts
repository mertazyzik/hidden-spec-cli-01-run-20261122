// main.ts is mend, the CLI SPEC.md specifies. It does all of SPEC.md sections 1 to 10: the command line, the
// output and exit codes, safe paths, format detection, line matching at three tiers (section 5), unified
// diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and
// the all-or-nothing write (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Shared context for the format parsers: strict matching, and the list of moves that succeeded. */
interface Ctx {
  strict: boolean;
  moves: Array<[string, string]>;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 5: files, lines and matching
// ---------------------------------------------------------------------------

/** A file's lines, its line break and whether it ends with one (section 3). */
interface FileState {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** 0-based positions where O occurs in F at `tier`, at or after `from`. */
function occurrences(O: string[], F: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = Math.max(0, from); i + O.length <= F.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!lineEq(O[j]!, F[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier (0, then 1, then 2; only 0 when strict) at which O occurs in F at or after `from`,
 * with every occurrence at that tier. With `eofOnly`, only occurrences ending at F's last line count.
 */
function findTier(
  O: string[],
  F: string[],
  strict: boolean,
  from = 0,
  eofOnly = false,
): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let pos = occurrences(O, F, t, from);
    if (eofOnly) pos = pos.filter((p) => p + O.length === F.length);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/**
 * Build the lines that replace a match: N's lines, where a context line (ctx[k] is its index in O) is
 * written as the file's own matched line, and at tier 2 every other non-blank line is re-indented from
 * O's first line's leading whitespace to the file's first matched line's (section 5).
 */
function buildNew(
  n: string[],
  ctx: Array<number | null>,
  F: string[],
  at: number,
  tier: number,
  O: string[],
): string[] {
  const out: string[] = [];
  const P = O.length > 0 ? leadOf(O[0]!) : '';
  const F0 = F[at] !== undefined ? leadOf(F[at]!) : '';
  for (let k = 0; k < n.length; k += 1) {
    const c = ctx[k];
    if (c !== null && c !== undefined) {
      out.push(F[at + c]!);
      continue;
    }
    let line = n[k]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(P)) line = F0 + line.slice(P.length);
    out.push(line);
  }
  return out;
}

/** Replace F's lines [at, at+k) by `rep`, keeping br and (unless overridden) the final break. */
function spliceLines(s: FileState, at: number, k: number, rep: string[], finalOverride: boolean | null): FileState {
  return {
    br: s.br,
    lines: [...s.lines.slice(0, at), ...rep, ...s.lines.slice(at + k)],
    final: finalOverride === null ? s.final : finalOverride,
  };
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface Hunk {
  /** The -A start (1-based old line number). */
  a: number;
  /** Old lines: context and `-` lines, in body order. */
  o: string[];
  /** New lines: context and `+` lines, in body order. */
  n: string[];
  /** For each line of n: its index in o when it is a context line, else null. */
  ctx: Array<number | null>;
  /** The `+` lines only, in body order (for creations). */
  plus: string[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNLChange: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noNLPlus: boolean;
}

interface Section {
  /** Null when the header names /dev/null. */
  oldPath: string | null;
  newPath: string | null;
  newMode: boolean;
  delMode: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path after `--- ` / `+++ `: text after four chars, up to the first tab, spaces removed. */
function gitPath(raw: string): string | null {
  const cut = raw.slice(4).split('\t')[0]!.trim();
  if (cut === '/dev/null') return null;
  if (cut.startsWith('a/') || cut.startsWith('b/')) return cut.slice(2);
  return cut;
}

/** Interpret one hunk body (already stripped of trailing empty lines) into a Hunk. */
function interpretBody(body: string[], a: number): Hunk {
  const o: string[] = [];
  const n: string[] = [];
  const ctx: Array<number | null> = [];
  const plus: string[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k += 1) {
    const l = body[k]!;
    if (l === '') {
      o.push('');
      n.push('');
      ctx.push(o.length - 1);
      lastCtxPlus = k;
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      o.push(t);
      n.push(t);
      ctx.push(o.length - 1);
      lastCtxPlus = k;
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push(l.slice(1));
      ctx.push(null);
      plus.push(l.slice(1));
      lastCtxPlus = k;
      lastPlus = k;
    }
    // A `\` line refers to the body line before it; it carries no content of its own.
  }
  const follows = (idx: number): boolean =>
    idx >= 0 && body[idx + 1] !== undefined && body[idx + 1]![0] === '\\';
  return { a, o, n, ctx, plus, noNLChange: follows(lastCtxPlus), noNLPlus: follows(lastPlus) };
}

/** Apply one section's hunks to a file's lines; throws Fail on the first hunk that fails. */
function applyHunks(sec: Section, st: FileState, strict: boolean, failPath: string): FileState {
  let d = 0;
  for (const h of sec.hunks) {
    if (h.o.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, st.lines.length));
      const atEnd = pos === st.lines.length;
      st = spliceLines(st, pos, 0, h.n, atEnd ? !h.noNLChange : null);
      d += h.n.length;
      continue;
    }
    const found = findTier(h.o, st.lines, strict);
    if (found === null) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const i = best;
    const k = h.o.length;
    const rep = buildNew(h.n, h.ctx, st.lines, i, found.tier, h.o);
    const toEnd = i + k === st.lines.length;
    st = spliceLines(st, i, k, rep, toEnd ? !h.noNLChange : null);
    d += h.n.length - h.o.length;
  }
  return st;
}

function unifiedEdit(sec: Section, ctx: Ctx): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = oldP === null || sec.newMode;
    const isDelete = !isCreate && (newP === null || sec.delMode);
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    // Every path the edit names is checked for safety before anything else about it.
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      const p = newP ?? '/dev/null';
      if (newP === null) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noNL = false;
      let anyPlus = false;
      for (const h of sec.hunks) {
        plus.push(...h.plus);
        if (h.plus.length > 0) {
          anyPlus = true;
          noNL = h.noNLPlus;
        }
      }
      tree.now.set(p, !anyPlus && plus.length === 0 ? '' : plus.join('\n') + (noNL ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldP!;
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (isMove) {
      const q = newP!;
      if (tree.get(q) !== null) throw new Fail('exists', q);
      const st = applyHunks(sec, splitFile(cur), ctx.strict, p);
      tree.now.set(p, null);
      tree.now.set(q, joinFile(st));
      ctx.moves.push([p, q]);
      return;
    }
    const st = applyHunks(sec, splitFile(cur), ctx.strict, p);
    tree.now.set(p, joinFile(st));
  };
}

function parseUnified(lines: string[], ctx: Ctx): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let hasPair = false;
  let i = 0;
  const n = lines.length;
  const startSection = (oldP: string | null, newP: string | null): void => {
    cur = { oldPath: oldP, newPath: newP, newMode: false, delMode: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
    hasPair = false;
  };
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (!inHeader && l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A bare section: the ---/+++ pair starts it and names its paths.
      const oldP = gitPath(l);
      const newP = gitPath(lines[i + 1]!);
      startSection(oldP, newP);
      hasPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      // Collect the hunk body.
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(interpretBody(body, Number(m[1])));
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) {
        const nxt = lines[i + 1];
        if (nxt === undefined || !nxt.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldPath = gitPath(l);
        cur.newPath = gitPath(nxt);
        hasPair = true;
        i += 2;
        continue;
      }
      if (l.startsWith('+++ ')) {
        // A lone +++ line names the new path.
        cur.newPath = gitPath(l);
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        if (!hasPair) cur.oldPath = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!hasPair) cur.newPath = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.newMode = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.delMode = true;
        i += 1;
        continue;
      }
      // index, old mode, new mode, similarity index, dissimilarity index, Index: and any other
      // line in a section's header are ignored.
      i += 1;
      continue;
    }
    // Outside bodies and headers, lines are ignored (prose, code fences).
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, ctx));
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], ctx: Ctx): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const st = splitFile(cur);
    const found = findTier(oldLines, st.lines, ctx.strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const rep = buildNew(newLines, newLines.map(() => null), st.lines, at, found.tier, oldLines);
    tree.now.set(path, joinFile(spliceLines(st, at, oldLines.length, rep, null)));
  };
}

function parseSR(lines: string[], ctx: Ctx): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j > prevReplaceEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = i + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let j = sep + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), ctx));
    prevPath = path;
    prevReplaceEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface VChunk {
  /** Null when the chunk has no anchor. */
  anchor: string | null;
  /** True when a `*** End of File` line ends this chunk. */
  eof: boolean;
  o: string[];
  n: string[];
  ctx: Array<number | null>;
}

const V4A_SECTION_RE = /^\*\*\* (Add File|Delete File|Update File):(.*)$/;

function v4aEdit(
  kind: 'add' | 'delete' | 'update',
  path: string,
  moveTo: string | null,
  chunks: VChunk[],
  ctx: Ctx,
): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    if (kind === 'add') {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const added: string[] = [];
      for (const ch of chunks) added.push(...ch.n);
      tree.now.set(path, added.length === 0 ? '' : added.join('\n') + '\n');
      return;
    }
    if (kind === 'delete') {
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let st = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier([ch.anchor], st.lines, ctx.strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? st.lines.length : cursor;
        st = spliceLines(st, pos, 0, ch.n, null);
        cursor = pos + ch.n.length;
        continue;
      }
      const found = findTier(ch.o, st.lines, ctx.strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const at = found.pos[0]!;
      const rep = buildNew(ch.n, ch.ctx, st.lines, at, found.tier, ch.o);
      st = spliceLines(st, at, ch.o.length, rep, null);
      cursor = at + rep.length;
    }
    const out = joinFile(st);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      ctx.moves.push([path, moveTo]);
      return;
    }
    tree.now.set(path, out);
  };
}

function parseV4a(lines: string[], ctx: Ctx): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const m = V4A_SECTION_RE.exec(l);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1] === 'Add File' ? 'add' : m[1] === 'Delete File' ? 'delete' : 'update';
    const path = m[2]!.trim();
    // Collect this section's lines: up to the next section start or *** End Patch.
    let j = i + 1;
    while (j < last && V4A_SECTION_RE.exec(lines[j]!) === null) j += 1;
    const raw = lines.slice(i + 1, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    // Line number (1-based) of raw[k].
    const rawNo = (k: number): number => i + 1 + k + 1;
    if (kind === 'add') {
      const added: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const rl = raw[k]!;
        if (rl === '') added.push('');
        else if (rl[0] === '+') added.push(rl.slice(1));
        else throw new Exit2(`error: parse ${rawNo(k)}`);
      }
      edits.push(
        v4aEdit('add', path, null, [{ anchor: null, eof: false, o: [], n: added, ctx: added.map(() => null) }], ctx),
      );
      i = j;
      continue;
    }
    if (kind === 'delete') {
      for (let k = 0; k < raw.length; k += 1) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${rawNo(k)}`);
      }
      edits.push(v4aEdit('delete', path, null, [], ctx));
      i = j;
      continue;
    }
    // Update: an optional `*** Move to:` first line, then chunks.
    let moveTo: string | null = null;
    let k = 0;
    if (raw.length > 0 && raw[0]!.startsWith('*** Move to:')) {
      moveTo = raw[0]!.slice(12).trim();
      k = 1;
    }
    const chunks: VChunk[] = [];
    let curChunk: { anchor: string | null; eof: boolean; body: string[] } | null = null;
    const closeChunk = (): void => {
      if (curChunk === null) return;
      const o: string[] = [];
      const nn: string[] = [];
      const cc: Array<number | null> = [];
      for (const bl of curChunk.body) {
        if (bl === '') {
          o.push('');
          nn.push('');
          cc.push(o.length - 1);
        } else if (bl[0] === ' ') {
          const t = bl.slice(1);
          o.push(t);
          nn.push(t);
          cc.push(o.length - 1);
        } else if (bl[0] === '-') {
          o.push(bl.slice(1));
        } else if (bl[0] === '+') {
          nn.push(bl.slice(1));
          cc.push(null);
        }
      }
      chunks.push({ anchor: curChunk.anchor, eof: curChunk.eof, o, n: nn, ctx: cc });
      curChunk = null;
    };
    for (; k < raw.length; k += 1) {
      const rl = raw[k]!;
      if (rl.startsWith('@@')) {
        closeChunk();
        const anchor = rl.slice(2).trim();
        curChunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
        continue;
      }
      if (rl.trim() === '*** End of File' && !rl.startsWith(' ')) {
        if (curChunk === null) {
          curChunk = { anchor: null, eof: true, body: [] };
          chunks.push({ anchor: null, eof: true, o: [], n: [], ctx: [] });
          curChunk = null;
        } else {
          curChunk.eof = true;
          closeChunk();
        }
        continue;
      }
      if (rl === '' || rl[0] === ' ' || rl[0] === '-' || rl[0] === '+') {
        if (curChunk === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${rawNo(k)}`);
          curChunk = { anchor: null, eof: false, body: [] };
        }
        curChunk.body.push(rl);
        continue;
      }
      throw new Exit2(`error: parse ${rawNo(k)}`);
    }
    closeChunk();
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(v4aEdit('update', path, moveTo, chunks, ctx));
    i = j;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 2 and 10: run, output and the all-or-nothing write
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  const ctx: Ctx = { strict, moves };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, ctx);
    else if (kind === 'search-replace') edits = parseSR(lines, ctx);
    else edits = parseV4a(lines, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  const entries: Array<{ key: string; line: string }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  // A move that succeeded replaces its D and A lines by one R line, sorted by the new path.
  // The pair qualifies only when the old path existed before the patch and is gone after it,
  // and the new path did not exist before the patch and is there after it (section 2).
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) === null || tree.get(oldP) !== null) continue;
    if (tree.original(newP) !== null || tree.get(newP) === null) continue;
    for (let k = entries.length - 1; k >= 0; k -= 1) {
      if (entries[k]!.key === oldP || entries[k]!.key === newP) entries.splice(k, 1);
    }
    entries.push({ key: newP, line: `R ${oldP} -> ${newP}` });
  }
  entries.sort((a, b) => byteOrder(a.key, b.key));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
