// mend: applies the edits AI models write to a tree of text files, as SPEC.md
// specifies. Four formats: unified diffs (often with wrong line numbers),
// SEARCH/REPLACE blocks, V4A patches and JSON text-editor tool calls.
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.
//
// The command line, output and exit codes, safe paths, format detection,
// JSON edits and the all-or-nothing write follow the kit starter's shape
// (SPEC.md sections 1-4, 9, 10). Line matching at three tiers and the
// unified, SEARCH/REPLACE and V4A readers (sections 5-8) are written here,
// as is the `R old -> new` output line for a move edit.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the single line to print. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed each, and without
 *  the empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** A file as its lines, its own line break, and whether it ends with one. */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function renderFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimTrail(s);
  return trimBoth(s);
}

/** Positions at or after `from` where O occurs in `lines` at `tier`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length - from) return out;
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (normLine(lines[i + k]!, tier) !== normLine(o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs at or after
 *  `from`, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(lines, o, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** The first tier at which O occurs at or after `from`, taking for an
 *  end-of-file chunk only occurrences that end at the file's last line. */
function findTierEof(lines: string[], o: string[], strict: boolean, from: number, eof: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    let occ = occurrences(lines, o, tier, from);
    if (eof) occ = occ.filter((pos) => pos + o.length === lines.length);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** The first line at or after `from` equal to `anchor` at the first tier
 *  where one is; -1 when there is none. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (normLine(lines[i]!, tier) === normLine(anchor, tier)) return i;
    }
  }
  return -1;
}

/** One line of an old/new pair: a context line, or a line only the old
 *  (or only the new) side has. */
interface OLItem {
  text: string;
  ctx: boolean;
}

/** Replace the matched lines at `pos` by N: a context line is written as the
 *  file's own matched line, never the patch's; at tier 2 every other line of
 *  N is re-indented from O's first line's leading whitespace to the file's
 *  first matched line's. */
function replaceLines(lines: string[], pos: number, o: OLItem[], n: OLItem[], tier: number): string[] {
  const oCtx: number[] = [];
  o.forEach((it, idx) => {
    if (it.ctx) oCtx.push(idx);
  });
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWs(lines[pos]!);
    p = leadingWs(o[0]!.text);
  }
  const out: string[] = [];
  let ci = 0;
  for (const it of n) {
    if (it.ctx) {
      out.push(lines[pos + oCtx[ci]!]!);
      ci += 1;
    } else if (tier === 2) {
      const line = it.text;
      if (line !== '' && !/^[ \t]+$/.test(line) && line.startsWith(p)) out.push(f + line.slice(p.length));
      else out.push(line);
    } else {
      out.push(it.text);
    }
  }
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + o.length)];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 *  the rest read from disk; `moves` holds the successful move edits. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
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

/** The format of a patch, by SPEC.md section 4. */
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

/* ---- Unified diffs (SPEC.md section 6) ---- */

interface Hunk {
  a: number;
  body: string[];
  o: OLItem[];
  n: OLItem[];
}

interface Section {
  oldPath: string;
  newPath: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a `--- ` or `+++ ` line names: after the four characters, up to
 *  the first tab, surrounding spaces removed, one leading `a/` or `b/`
 *  removed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function makeHunk(a: number, body: string[]): Hunk {
  const o: OLItem[] = [];
  const n: OLItem[] = [];
  for (const l of body) {
    if (l === '' || l[0] === ' ') {
      const t = l === '' ? '' : l.slice(1);
      o.push({ text: t, ctx: true });
      n.push({ text: t, ctx: true });
    } else if (l[0] === '-') o.push({ text: l.slice(1), ctx: false });
    else if (l[0] === '+') n.push({ text: l.slice(1), ctx: false });
  }
  return { a, body, o, n };
}

/** A hunk's body: the lines after its header that start with ` `, `-`, `+`
 *  or `\`, or are empty. It ends at the first other line, at a `diff --git `
 *  line, at a `--- ` line followed by a `+++ ` line, or at the next hunk
 *  header; empty lines at its end are not part of it. */
function collectHunkBody(lines: string[], j: number): { body: string[]; next: number } {
  const body: string[] = [];
  let k = j;
  while (k < lines.length) {
    const l = lines[k]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      k += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: k };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLast(body: string[]): boolean {
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const l = body[k]!;
    if (l === '' || l[0] === ' ' || l[0] === '+') {
      return k + 1 < body.length && body[k + 1]![0] === '\\';
    }
  }
  return false;
}

/** Apply one hunk to a file's lines. `d` is the sum over this section's
 *  hunks applied so far of (N's length minus O's length). */
function applyHunk(file: FileModel, hunk: Hunk, d: number, strict: boolean, path: string): FileModel {
  if (hunk.o.length > 0) {
    const found = findTier(file.lines, hunk.o.map((it) => it.text), strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let pos = found.occ[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
    const lines = replaceLines(file.lines, pos, hunk.o, hunk.n, found.tier);
    let final = file.final;
    if (pos + hunk.o.length === file.lines.length) final = !backslashAfterLast(hunk.body);
    return { lines, br: file.br, final };
  }
  const idx = Math.min(Math.max(hunk.a + d, 0), file.lines.length);
  const lines = [...file.lines.slice(0, idx), ...hunk.n.map((it) => it.text), ...file.lines.slice(idx)];
  let final = file.final;
  if (idx === file.lines.length) final = !backslashAfterLast(hunk.body);
  return { lines, br: file.br, final };
}

/** Read one section's header and hunks, starting at `i`; returns the index
 *  of the first line past the section. */
function parseSectionRest(lines: string[], i: number, sec: Section, gitOld: string | null, gitNew: string | null): number {
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let inHeader = true;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (!inHeader) break;
      pairOld = headerPath(line);
      pairNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (inHeader && line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const { body, next } = collectHunkBody(lines, i + 1);
      sec.hunks.push(makeHunk(Number(m[1]), body));
      i = next;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('rename from ')) renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (pairOld !== null) {
    sec.oldPath = pairOld;
    sec.newPath = pairNew!;
  } else {
    if (renameFrom !== null) sec.oldPath = renameFrom;
    else if (gitOld !== null) sec.oldPath = gitOld;
    if (renameTo !== null) sec.newPath = renameTo;
    else if (gitNew !== null) sec.newPath = gitNew;
  }
  if (sec.oldPath === '' && sec.newPath !== '') sec.oldPath = sec.newPath;
  if (sec.newPath === '' && sec.oldPath !== '') sec.newPath = sec.oldPath;
  return i;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = { oldPath: '', newPath: '', newFile: false, deletedFile: false, hunks: [] };
      i = parseSectionRest(lines, i + 1, sec, m[1]!, m[2]!);
      sections.push(sec);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = { oldPath: '', newPath: '', newFile: false, deletedFile: false, hunks: [] };
      i = parseSectionRest(lines, i, sec, null, null);
      sections.push(sec);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldPath = sec.oldPath;
    const newPath = sec.newPath;
    if (oldPath === '/dev/null' || sec.newFile) {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const l of h.body) if (l[0] === '+') plus.push(l.slice(1));
      }
      let noFinal = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        const body = sec.hunks[hi]!.body;
        for (let k = body.length - 1; k >= 0; k -= 1) {
          if (body[k]![0] === '+') {
            noFinal = k + 1 < body.length && body[k + 1]![0] === '\\';
            break outer;
          }
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
      return;
    }
    if (newPath === '/dev/null' || sec.deletedFile) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath !== newPath) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      let file = parseFile(before);
      let d = 0;
      for (const h of sec.hunks) {
        file = applyHunk(file, h, d, strict, oldPath);
        d += h.n.length - h.o.length;
      }
      tree.now.set(newPath, renderFile(file));
      tree.now.set(oldPath, null);
      tree.moves.push([oldPath, newPath]);
      return;
    }
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    let file = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      file = applyHunk(file, h, d, strict, oldPath);
      d += h.n.length - h.o.length;
    }
    tree.now.set(oldPath, renderFile(file));
  };
}

/* ---- SEARCH/REPLACE blocks (SPEC.md section 7) ---- */

interface SRBlock {
  path: string;
  old: string[];
  new: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevReplace = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevReplace; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    blocks.push({ path, old: lines.slice(s + 1, eq), new: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.new.length === 0 ? '' : b.new.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const file = parseFile(before);
    const found = findTier(file.lines, b.old, strict, 0);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const pos = found.occ[0]!;
    const lines = replaceLines(
      file.lines,
      pos,
      b.old.map((t) => ({ text: t, ctx: false })),
      b.new.map((t) => ({ text: t, ctx: false })),
      found.tier,
    );
    tree.now.set(p, renderFile({ lines, br: file.br, final: file.final }));
  };
}

/* ---- V4A patches (SPEC.md section 8) ---- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: OLItem[];
  n: OLItem[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

const V4A_START = (l: string): 'add' | 'delete' | 'update' | null => {
  if (l.startsWith('*** Add File: ') || l === '*** Add File:') return 'add';
  if (l.startsWith('*** Delete File: ') || l === '*** Delete File:') return 'delete';
  if (l.startsWith('*** Update File: ') || l === '*** Update File:') return 'update';
  return null;
};

function parseV4aUpdate(path: string, raw: string[], headerIdx: number): VSection {
  let moveTo: string | null = null;
  let k = 0;
  if (raw.length > 0 && (raw[0]!.startsWith('*** Move to: ') || raw[0]! === '*** Move to:')) {
    moveTo = raw[0]!.slice('*** Move to:'.length).trim();
    k = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  const lineNo = (idx: number): number => headerIdx + 2 + idx;
  const flush = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  while (k < raw.length) {
    const l = raw[k]!;
    if (l.startsWith('@@')) {
      flush();
      const a = l.slice(2).trim();
      cur = { anchor: a === '' ? null : a, eof: false, o: [], n: [] };
      k += 1;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo(k)}`);
      cur.eof = true;
      flush();
      k += 1;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo(k)}`);
        cur = { anchor: null, eof: false, o: [], n: [] };
      }
      if (l === '' || l[0] === ' ') {
        const t = l === '' ? '' : l.slice(1);
        cur.o.push({ text: t, ctx: true });
        cur.n.push({ text: t, ctx: true });
      } else if (l[0] === '-') cur.o.push({ text: l.slice(1), ctx: false });
      else cur.n.push({ text: l.slice(1), ctx: false });
      k += 1;
      continue;
    }
    throw new Exit2(`error: parse ${lineNo(k)}`);
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerIdx + 1}`);
  return { kind: 'update', path, lines: [], moveTo, chunks };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = V4A_START(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? '*** Add File:' : kind === 'delete' ? '*** Delete File:' : '*** Update File:';
    const path = line.slice(prefix.length).trim();
    const raw: string[] = [];
    let j = i + 1;
    while (j < last) {
      if (V4A_START(lines[j]!) !== null) break;
      raw.push(lines[j]!);
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l !== '' && !l.startsWith('+')) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      sections.push({ kind, path, lines: raw.map((l) => (l === '' ? '' : l.slice(1))), moveTo: null, chunks: [] });
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k += 1) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      sections.push({ kind, path, lines: [], moveTo: null, chunks: [] });
    } else {
      sections.push(parseV4aUpdate(path, raw, i));
    }
    i = j;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = s.path;
    if (s.kind === 'add') {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (!safe(p)) throw new Fail('unsafe', p);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let file = parseFile(before);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const idx = findAnchor(file.lines, chunk.anchor, cursor, strict);
        if (idx < 0) throw new Fail('no-match', p);
        cursor = idx + 1;
      }
      if (chunk.o.length === 0) {
        const at = chunk.eof ? file.lines.length : cursor;
        const lines = [...file.lines.slice(0, at), ...chunk.n.map((it) => it.text), ...file.lines.slice(at)];
        file = { lines, br: file.br, final: file.final };
        cursor = at + chunk.n.length;
        continue;
      }
      const found = findTierEof(file.lines, chunk.o.map((it) => it.text), strict, cursor, chunk.eof);
      if (found === null) throw new Fail('no-match', p);
      const pos = found.occ[0]!;
      const lines = replaceLines(file.lines, pos, chunk.o, chunk.n, found.tier);
      file = { lines, br: file.br, final: file.final };
      cursor = pos + chunk.n.length;
    }
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, renderFile(file));
      tree.now.set(p, null);
      tree.moves.push([p, s.moveTo]);
    } else {
      tree.now.set(p, renderFile(file));
    }
  };
}

/* ---- JSON edits (SPEC.md section 9) ---- */

/** One JSON edit object, or null when it is not one. */
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

/* ---- Driver (SPEC.md sections 1, 2 and 10) ---- */

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
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // One line per changed path, in byte order. A move whose old path existed
  // before and is gone after, and whose new path did not exist before and
  // does after, is one `R old -> new` line (sorting by the new path) in
  // place of that pair's `D` and `A` lines.
  interface Row {
    sort: string;
    line: string;
  }
  const rows: Row[] = [];
  const moved = new Set<string>();
  const next = new Map<string, string>();
  for (const [o, n] of tree.moves) if (!next.has(o)) next.set(o, n);
  const resolveEnd = (o: string): string | null => {
    let cur = o;
    const seen = new Set<string>([o]);
    while (next.has(cur)) {
      const nx = next.get(cur)!;
      if (nx === o || seen.has(nx)) return null;
      seen.add(nx);
      cur = nx;
    }
    return cur;
  };
  for (const [o] of tree.moves) {
    const end = resolveEnd(o);
    if (end === null) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(end) === null && tree.get(end) !== null) {
      rows.push({ sort: end, line: `R ${o} -> ${end}` });
      moved.add(o);
      moved.add(end);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ sort: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.sort, b.sort));
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
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
