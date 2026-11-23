// mend — applies an AI-written edit to a tree of text files.
//
// Supported patch shapes: unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON tool calls, and the mend CLI itself. Run `node main.ts`
// with no arguments in the tree to patch, or give a patch path (or `-`
// for stdin). When MAKEFUN_ENV_URL is set, main.ts hands over to the
// trial runner instead of patching anything.

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------- types

type EditResult = { kind: "ok"; changes: FileChange[] } | { kind: "fail"; failures: Failure[] };

type Failure = { code: string; path: string };

type FileChange = { kind: "A" | "D" | "M"; path: string } | { kind: "R"; from: string; to: string };

type FileState = { brk: string; lines: string[]; ends: boolean; raw?: string };

type Tree = Map<string, FileState>;

type Tier = 0 | 1 | 2;

// A parsed edit is a small object the applier can run against a tree.
type Edit =
  | { type: "create"; path: string; lines: string[]; ends: boolean; raw?: string }
  | { type: "delete"; path: string }
  | { type: "change"; path: string; hunks: Hunk[]; via: "unified" | "sr" | "v4a" }
  | { type: "move"; path: string; to: string; hunks: Hunk[]; via: "unified" | "v4a" }
  | { type: "str_replace"; path: string; oldStr: string; newStr: string }
  | { type: "insert"; path: string; insertLine: number; newStr: string };

type Hunk = {
  old: string[];
  neu: string[];
  ctxOld: number[]; // indices into old that are context lines
  ctxNew: number[]; // indices into neu that are context lines (same order)
  at: number | null; // unified @@ start line (1-based), null for others
  end: boolean; // anchored to end of file (v4a End of File)
  noBreak: boolean; // unified `\` marker: result ends without a line break
  anchor: string | null; // v4a @@ anchor text (null = no anchor)
};

// ------------------------------------------------------------ small utils

function fatalLine(line: string, code: number): never {
  process.stdout.write(line + "\n");
  process.exit(code);
}

function splitPatchLines(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts.map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p));
}

function splitTextLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p));
}

function trimBoth(s: string): string {
  return s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

function trimRight(s: string): string {
  return s.replace(/[ \t]+$/, "");
}

function trimLeft(s: string): string {
  return s.replace(/^[ \t]+/, "");
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : "";
}

function isBlank(s: string): boolean {
  return trimBoth(s) === "";
}

function isSafePath(p: string): boolean {
  if (p === "") return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// ------------------------------------------------------------- file model

function parseFile(text: string): FileState {
  if (text === "") return { brk: "\n", lines: [], ends: false };
  const firstLf = text.indexOf("\n");
  const brk = firstLf > 0 && text[firstLf - 1] === "\r" ? "\r\n" : "\n";
  const ends = text.endsWith(brk);
  const body = ends ? text.slice(0, text.length - brk.length) : text;
  const lines = body === "" ? [] : body.split(brk);
  return { brk, lines, ends };
}

function writeFile(state: FileState): string {
  if (state.raw !== undefined) return state.raw;
  if (state.lines.length === 0) return "";
  return state.lines.join(state.brk) + (state.ends ? state.brk : "");
}

function cloneState(s: FileState): FileState {
  return { brk: s.brk, lines: [...s.lines], ends: s.ends, raw: s.raw };
}

function cloneTree(t: Tree): Tree {
  const out: Tree = new Map();
  for (const [k, v] of t) out.set(k, cloneState(v));
  return out;
}

// ------------------------------------------------------------ tier matching

function lineEqAt(tier: Tier, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimRight(a) === trimRight(b);
  return trimBoth(a) === trimBoth(b);
}

function occurrencesAt(lines: string[], old: string[], tier: Tier, from: number): number[] {
  const found: number[] = [];
  if (old.length === 0) return found;
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (!lineEqAt(tier, lines[i + j], old[j])) { ok = false; break; }
    }
    if (ok) found.push(i);
  }
  return found;
}

// First tier at which old occurs at least once at/after `from` (-1: none).
function firstTier(lines: string[], old: string[], from: number, strict: boolean): Tier | -1 {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    if (occurrencesAt(lines, old, t, from).length > 0) return t;
  }
  return -1;
}

// Build the replacement lines for a matched span. Context lines come
// from the file itself; at tier 2 the other new lines are re-indented
// from the old block's leading whitespace to the file's.
function buildNew(hunk: Hunk, fileLines: string[], at: number, tier: Tier): string[] {
  const out: string[] = [];
  const fileLead = fileLines.length > at ? leadWs(fileLines[at]) : "";
  const oldLead = hunk.old.length > 0 ? leadWs(hunk.old[0]) : "";
  const ctxMap = new Map<number, number>();
  hunk.ctxNew.forEach((neuIdx, k) => ctxMap.set(neuIdx, hunk.ctxOld[k]));
  for (let i = 0; i < hunk.neu.length; i++) {
    const line = hunk.neu[i];
    if (ctxMap.has(i)) {
      out.push(fileLines[at + ctxMap.get(i)!]);
      continue;
    }
    if (tier === 2 && line !== "" && trimBoth(line) !== "" && line.startsWith(oldLead)) {
      out.push(fileLead + line.slice(oldLead.length));
    } else {
      out.push(line);
    }
  }
  return out;
}


// ---------------------------------------------------------- unified diffs

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(.*) b\/(.*)$/;

function headerPath(text: string): string | null {
  const t = trimBoth(text);
  if (t === "/dev/null") return null;
  if (t.startsWith("a/") || t.startsWith("b/")) return t.slice(2);
  return t;
}

// Text after `--- ` / `+++ `: up to the first tab, surrounding spaces off.
function splitHeaderPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf("\t");
  return trimBoth(tab >= 0 ? rest.slice(0, tab) : rest);
}

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const dg = DIFF_GIT.exec(line);
    const pairHere = line.startsWith("--- ") && i + 1 < n && lines[i + 1].startsWith("+++ ");
    if (line.startsWith("diff --git ") && !dg) fatalLine(`error: parse ${i + 1}`, 2);
    if (line.startsWith("@@")) fatalLine(`error: parse ${i + 1}`, 2);
    if (!dg && !pairHere) { i++; continue; }

    // --- section header ---
    let gitOld: string | null = null;
    let gitNew: string | null = null;
    if (dg) { gitOld = dg[1]; gitNew = dg[2]; i++; }
    let pairOld: string | null = null;
    let pairNew: string | null = null;
    let renOld: string | null = null;
    let renNew: string | null = null;
    let isCreate = false;
    let isDelete = false;
    if (pairHere) {
      pairOld = headerPath(splitHeaderPath(lines[i]));
      pairNew = headerPath(splitHeaderPath(lines[i + 1]));
      i += 2;
    }
    while (i < n) {
      const h = lines[i];
      if (HUNK_HEAD.test(h)) break;
      if (h.startsWith("@@")) fatalLine(`error: parse ${i + 1}`, 2);
      if (h.startsWith("diff --git ")) break;
      if (h.startsWith("--- ") && i + 1 < n && lines[i + 1].startsWith("+++ ")) {
        if (pairOld !== null || pairNew !== null) break; // new section
        pairOld = headerPath(splitHeaderPath(h));
        pairNew = headerPath(splitHeaderPath(lines[i + 1]));
        i += 2;
        continue;
      }
      if (h.startsWith("--- ")) fatalLine(`error: parse ${i + 2}`, 2);
      if (h.startsWith("rename from ")) renOld = trimBoth(h.slice("rename from ".length));
      else if (h.startsWith("rename to ")) renNew = trimBoth(h.slice("rename to ".length));
      else if (h.startsWith("new file mode")) isCreate = true;
      else if (h.startsWith("deleted file mode")) isDelete = true;
      i++;
    }
    const oldPath = pairOld !== null || pairNew !== null
      ? pairOld
      : renOld !== null || renNew !== null
        ? renOld
        : gitOld;
    const newPath = pairOld !== null || pairNew !== null
      ? pairNew
      : renOld !== null || renNew !== null
        ? renNew
        : gitNew;
    if (oldPath === null && newPath === null) {
      // A section naming no file at all: skip it.
      continue;
    }
    if (oldPath === null) isCreate = true;
    if (newPath === null) isDelete = true;

    // --- hunks ---
    const hunks: Hunk[] = [];
    while (i < n && HUNK_HEAD.test(lines[i])) {
      const m = HUNK_HEAD.exec(lines[i])!;
      const at = parseInt(m[1], 10);
      i++;
      const body: string[] = [];
      while (i < n) {
        const b = lines[i];
        if (b.startsWith("diff --git ")) break;
        if (b.startsWith("--- ") && i + 1 < n && lines[i + 1].startsWith("+++ ")) break;
        if (b === "" || b.startsWith(" ") || b.startsWith("-") || b.startsWith("+") || b.startsWith("\\")) {
          body.push(b);
          i++;
        } else break;
      }
      while (body.length && body[body.length - 1] === "") body.pop();
      const hunk: Hunk = { old: [], neu: [], ctxOld: [], ctxNew: [], at, end: false, noBreak: false, anchor: null };
      for (const b of body) {
        if (b === "") {
          // An empty body line is a context line whose text is empty.
          hunk.ctxOld.push(hunk.old.length);
          hunk.ctxNew.push(hunk.neu.length);
          hunk.old.push("");
          hunk.neu.push("");
        } else if (b.startsWith(" ")) {
          const t = b.slice(1);
          hunk.ctxOld.push(hunk.old.length);
          hunk.ctxNew.push(hunk.neu.length);
          hunk.old.push(t);
          hunk.neu.push(t);
        } else if (b.startsWith("-")) {
          hunk.old.push(b.slice(1));
        } else if (b.startsWith("+")) {
          hunk.neu.push(b.slice(1));
        }
        // `\` lines carry no text of their own.
      }
      // A `\` line after the hunk's last context or `+` line means the
      // result ends without a line break.
      if (body.length >= 2 && body[body.length - 1].startsWith("\\")) {
        const prev = body[body.length - 2];
        if (prev.startsWith(" ") || prev.startsWith("+")) hunk.noBreak = true;
      }
      hunks.push(hunk);
    }

    if (isCreate && newPath !== null) {
      const created: string[] = [];
      for (const h of hunks) {
        // Only `+` lines make up a created file; context lines in a
        // create hunk are ignored.
        const ctxSet = new Set(h.ctxNew);
        h.neu.forEach((l, idx) => { if (!ctxSet.has(idx)) created.push(l); });
      }
      const last = hunks[hunks.length - 1];
      edits.push({ type: "create", path: newPath, lines: created, ends: !(last && last.noBreak) });
    } else if (isDelete && oldPath !== null) {
      edits.push({ type: "delete", path: oldPath });
    } else if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      edits.push({ type: "move", path: oldPath, to: newPath, hunks, via: "unified" });
    } else if (oldPath !== null) {
      edits.push({ type: "change", path: oldPath, hunks, via: "unified" });
    }
  }
  return edits;
}

// --------------------------------------------------- SEARCH/REPLACE blocks

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevPath: string | null = null;
  let prevEnd = -1; // index of the previous block's REPLACE line
  while (i < n) {
    if (trimRight(lines[i]) !== "<<<<<<< SEARCH") { i++; continue; }
    const searchLine = i;
    // Path: nearest line before SEARCH, after the previous block, that is
    // not blank and does not start with three backticks.
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const t = trimBoth(lines[j]);
      if (t === "") continue;
      if (t.startsWith("```")) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) fatalLine(`error: parse ${searchLine + 1}`, 2);
    // Find ======= then >>>>>>> REPLACE, stopping at the next SEARCH.
    let eq = -1;
    let rep = -1;
    for (let j = searchLine + 1; j < n; j++) {
      const t = trimRight(lines[j]);
      if (t === "<<<<<<< SEARCH") break;
      if (eq < 0 && t === "=======") { eq = j; continue; }
      if (eq >= 0 && t === ">>>>>>> REPLACE") { rep = j; break; }
    }
    if (eq < 0 || rep < 0) fatalLine(`error: parse ${searchLine + 1}`, 2);
    const old = lines.slice(searchLine + 1, eq);
    const neu = lines.slice(eq + 1, rep);
    if (old.length === 0) {
      edits.push({ type: "create", path, lines: neu, ends: true });
    } else {
      edits.push({
        type: "change",
        path,
        hunks: [{ old, neu, ctxOld: [], ctxNew: [], at: null, end: false, noBreak: false, anchor: null }],
        via: "sr",
      });
    }
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------- V4A patches

function parseV4a(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let first = -1;
  let last = -1;
  for (let k = 0; k < n; k++) {
    if (!isBlank(lines[k])) { if (first < 0) first = k; last = k; }
  }
  if (first < 0 || trimBoth(lines[first]) !== "*** Begin Patch") {
    fatalLine(`error: parse ${first < 0 ? 1 : first + 1}`, 2);
  }
  if (trimBoth(lines[last]) !== "*** End Patch") {
    fatalLine(`error: parse ${n + 1}`, 2);
  }
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i])) { i++; continue; }
    const line = lines[i];
    const addM = /^\*\*\* Add File: (.*)$/.exec(line);
    const delM = /^\*\*\* Delete File: (.*)$/.exec(line);
    const updM = /^\*\*\* Update File: (.*)$/.exec(line);
    if (!addM && !delM && !updM) fatalLine(`error: parse ${i + 1}`, 2);
    const kind = addM ? "add" : delM ? "delete" : "update";
    const path = trimBoth((addM || delM || updM)![1]);
    const sectionLine = i;
    i++;
    if (kind === "add") {
      const created: string[] = [];
      while (i < last) {
        const l = lines[i];
        if (l.startsWith("*** Add File: ") || l.startsWith("*** Delete File: ") || l.startsWith("*** Update File: ") || l === "*** End Patch") break;
        if (l.startsWith("+")) created.push(l.slice(1));
        else if (l === "") created.push("");
        else fatalLine(`error: parse ${i + 1}`, 2);
        i++;
      }
      while (created.length && created[created.length - 1] === "") created.pop();
      edits.push({ type: "create", path, lines: created, ends: true });
    } else if (kind === "delete") {
      edits.push({ type: "delete", path });
    } else {
      // Update: optional `*** Move to:` first, then chunks.
      let moveTo: string | null = null;
      if (i < last && lines[i].startsWith("*** Move to: ")) {
        moveTo = trimBoth(lines[i].slice("*** Move to: ".length));
        i++;
      }
      const chunks: Hunk[] = [];
      let firstChunk = true;
      while (i < last) {
        if (isBlank(lines[i])) { i++; continue; }
        const l = lines[i];
        if (l.startsWith("*** Add File: ") || l.startsWith("*** Delete File: ") || l.startsWith("*** Update File: ") || l === "*** End Patch") break;
        if (l.startsWith("*** End of File")) fatalLine(`error: parse ${i + 1}`, 2);
        let anchor: string | null = null;
        if (l.startsWith("@@")) {
          anchor = trimBoth(l.slice(2));
          i++;
        } else if (!firstChunk) {
          fatalLine(`error: parse ${i + 1}`, 2);
        }
        // Body lines until a section start, End Patch, @@, or End of File.
        const body: string[] = [];
        let endOfFile = false;
        while (i < last) {
          const b = lines[i];
          if (b.startsWith("*** Add File: ") || b.startsWith("*** Delete File: ") || b.startsWith("*** Update File: ") || b === "*** End Patch") break;
          if (b.startsWith("@@")) break;
          if (b.startsWith("*** End of File")) { endOfFile = true; i++; break; }
          if (b === "" || b.startsWith(" ") || b.startsWith("-") || b.startsWith("+")) {
            body.push(b);
            i++;
          } else {
            fatalLine(`error: parse ${i + 1}`, 2);
          }
        }
        if (!endOfFile) {
          while (body.length && isBlank(body[body.length - 1])) body.pop();
        }
        const hunk: Hunk = { old: [], neu: [], ctxOld: [], ctxNew: [], at: null, end: endOfFile, noBreak: false, anchor };
        for (const b of body) {
          if (b === "") {
            // An empty body line is a context line whose text is empty.
            hunk.ctxOld.push(hunk.old.length);
            hunk.ctxNew.push(hunk.neu.length);
            hunk.old.push("");
            hunk.neu.push("");
          } else if (b.startsWith(" ")) {
            const t = b.slice(1);
            hunk.ctxOld.push(hunk.old.length);
            hunk.ctxNew.push(hunk.neu.length);
            hunk.old.push(t);
            hunk.neu.push(t);
          } else if (b.startsWith("-")) {
            hunk.old.push(b.slice(1));
          } else if (b.startsWith("+")) {
            hunk.neu.push(b.slice(1));
          }
        }
        chunks.push(hunk);
        firstChunk = false;
        if (endOfFile) {
          // After End of File, only a new section may follow.
          continue;
        }
      }
      if (chunks.length === 0 && moveTo === null) {
        fatalLine(`error: parse ${sectionLine + 1}`, 2);
      }
      if (moveTo !== null) {
        edits.push({ type: "move", path, to: moveTo, hunks: chunks, via: "v4a" });
      } else {
        edits.push({ type: "change", path, hunks: chunks, via: "v4a" });
      }
    }
  }
  return edits;
}

// ---------------------------------------------------------------- JSON edits

function parseJsonEdit(obj: unknown, parseLine: number): Edit {
  const bad = (): never => fatalLine(`error: parse ${parseLine}`, 2);
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) bad();
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== "string" || typeof o.command !== "string") bad();
  const path = o.path as string;
  if (o.command === "create") {
    if (typeof o.file_text !== "string") bad();
    return { type: "create", path, lines: [], ends: false, raw: o.file_text as string };
  }
  if (o.command === "str_replace") {
    if (typeof o.old_str !== "string" || (o.old_str as string) === "") bad();
    if (o.new_str !== undefined && typeof o.new_str !== "string") bad();
    return {
      type: "str_replace",
      path,
      oldStr: o.old_str as string,
      newStr: (o.new_str as string | undefined) ?? "",
    };
  }
  if (o.command === "insert") {
    if (typeof o.insert_line !== "number" || !Number.isInteger(o.insert_line)) bad();
    if (typeof o.new_str !== "string") bad();
    return { type: "insert", path, insertLine: o.insert_line as number, newStr: o.new_str as string };
  }
  bad();
}

function parseJson(text: string, lines: string[]): Edit[] {
  // Line where the first non-whitespace character sits.
  let firstNonWs = -1;
  for (let k = 0; k < text.length; k++) {
    if (text[k] !== " " && text[k] !== "\t" && text[k] !== "\n" && text[k] !== "\r") { firstNonWs = k; break; }
  }
  if (firstNonWs < 0) fatalLine("error: parse 1", 2);
  const startLine = text.slice(0, firstNonWs).split("\n").length;
  if (text[firstNonWs] === "[") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      fatalLine(`error: parse ${startLine}`, 2);
    }
    if (!Array.isArray(parsed)) fatalLine(`error: parse ${startLine}`, 2);
    const edits: Edit[] = [];
    for (const item of parsed) edits.push(parseJsonEdit(item, startLine));
    if (edits.length === 0) fatalLine("error: parse 1", 2);
    return edits;
  }
  const edits: Edit[] = [];
  for (let k = 0; k < lines.length; k++) {
    if (isBlank(lines[k])) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[k]);
    } catch {
      fatalLine(`error: parse ${k + 1}`, 2);
    }
    edits.push(parseJsonEdit(obj, k + 1));
  }
  if (edits.length === 0) fatalLine("error: parse 1", 2);
  return edits;
}

// ------------------------------------------------------- format detection

function detectFormat(lines: string[]): "unified" | "search-replace" | "v4a" | "json" {
  let firstNonBlank = -1;
  for (let k = 0; k < lines.length; k++) {
    if (!isBlank(lines[k])) { firstNonBlank = k; break; }
  }
  if (firstNonBlank < 0) fatalLine("error: format", 2);
  const first = trimBoth(lines[firstNonBlank]);
  if (first === "*** Begin Patch") return "v4a";
  const firstChar = lines[firstNonBlank].trimStart()[0];
  if (firstChar === "[" || firstChar === "{") return "json";
  for (const l of lines) {
    if (trimRight(l) === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (l.startsWith("diff --git ")) return "unified";
    if (l.startsWith("--- ") && k + 1 < lines.length && lines[k + 1].startsWith("+++ ")) return "unified";
  }
  fatalLine("error: format", 2);
}

// ------------------------------------------------------------- the applier

// Apply one hunk list to a file's lines. `mode` picks the occurrence rule:
// "unified" takes the occurrence nearest to the hunk's @@ line (drift
// adjusted); "v4a" takes the first at/after the cursor and honours
// anchors and end-of-file marks; "sr" needs exactly one occurrence.
// Returns the new lines + new ends flag, or a failure code.
function applyHunks(
  hunks: Hunk[],
  file: FileState,
  mode: "unified" | "v4a" | "sr",
  strict: boolean,
): { lines: string[]; ends: boolean } | { code: string } {
  let lines = [...file.lines];
  let ends = file.ends;
  let drift = 0;
  let cursor = 0;
  for (const hunk of hunks) {
    // Anchor: move the cursor just past the anchor line.
    if (mode === "v4a" && hunk.anchor !== null && hunk.anchor !== "") {
      const tiers: Tier[] = strict ? [0] : [0, 1, 2];
      let found = -1;
      for (const t of tiers) {
        const occ = occurrencesAt(lines, [hunk.anchor], t, cursor);
        if (occ.length > 0) { found = occ[0]; break; }
      }
      if (found < 0) return { code: "no-match" };
      cursor = found + 1;
    }
    if (hunk.old.length === 0) {
      // Pure insertion.
      let pos: number;
      if (mode === "unified") {
        pos = Math.max(0, Math.min(lines.length, (hunk.at ?? 1) + drift));
      } else if (mode === "v4a" && hunk.end) {
        pos = lines.length;
      } else {
        pos = cursor;
      }
      const insertedAtEnd = pos === lines.length;
      const neu = buildNew(hunk, lines, pos, 0);
      lines = [...lines.slice(0, pos), ...neu, ...lines.slice(pos)];
      // A unified insertion at the end sets the final break (unless the
      // hunk carries a `\` marker); otherwise the break stays as it was.
      if (mode === "unified" && insertedAtEnd) ends = !hunk.noBreak;
      if (mode === "v4a") cursor = pos + neu.length;
      drift += neu.length;
      continue;
    }
    const tier = firstTier(lines, hunk.old, mode === "v4a" ? cursor : 0, strict);
    if (tier === -1) return { code: "no-match" };
    let occs = occurrencesAt(lines, hunk.old, tier, mode === "v4a" ? cursor : 0);
    if (mode === "v4a" && hunk.end) {
      occs = occs.filter((o) => o + hunk.old.length === lines.length);
      if (occs.length === 0) return { code: "no-match" };
    }
    if (occs.length === 0) return { code: "no-match" };
    let at: number;
    if (mode === "sr") {
      if (occs.length > 1) return { code: "ambiguous" };
      at = occs[0];
    } else if (mode === "unified") {
      const want = (hunk.at ?? 1) - 1 + drift;
      at = occs[0];
      let best = Math.abs(occs[0] - want);
      for (const o of occs) {
        const d = Math.abs(o - want);
        if (d < best) { best = d; at = o; }
      }
    } else {
      at = occs[0];
    }
    const neu = buildNew(hunk, lines, at, tier);
    const runsToEnd = at + hunk.old.length === lines.length;
    lines = [...lines.slice(0, at), ...neu, ...lines.slice(at + hunk.old.length)];
    if (mode === "unified" && runsToEnd) ends = !hunk.noBreak;
    if (mode === "v4a") cursor = at + neu.length;
    drift += neu.length - hunk.old.length;
  }
  return { lines, ends };
}

// Apply one edit to the working tree. Returns null on success or the
// failure to report. A failed edit leaves the tree untouched.
function applyEdit(edit: Edit, tree: Tree, strict: boolean): Failure | null {
  const paths: string[] = [edit.path];
  if (edit.type === "move") paths.push(edit.to);
  for (const p of paths) {
    if (!isSafePath(p)) return { code: "unsafe", path: p };
  }
  switch (edit.type) {
    case "create": {
      if (tree.has(edit.path)) return { code: "exists", path: edit.path };
      if (edit.raw !== undefined) {
        tree.set(edit.path, { ...parseFile(edit.raw), raw: edit.raw });
      } else {
        tree.set(edit.path, { brk: "\n", lines: [...edit.lines], ends: edit.ends });
      }
      return null;
    }
    case "delete": {
      if (!tree.has(edit.path)) return { code: "missing", path: edit.path };
      tree.delete(edit.path);
      return null;
    }
    case "change": {
      const file = tree.get(edit.path);
      if (!file) return { code: "missing", path: edit.path };
      const res = applyHunks(edit.hunks, file, edit.via, strict);
      if ("code" in res) return { code: res.code, path: edit.path };
      tree.set(edit.path, { brk: file.brk, lines: res.lines, ends: res.ends });
      return null;
    }
    case "move": {
      const file = tree.get(edit.path);
      if (!file) return { code: "missing", path: edit.path };
      if (tree.has(edit.to)) return { code: "exists", path: edit.to };
      const res = applyHunks(edit.hunks, file, edit.via, strict);
      if ("code" in res) return { code: res.code, path: edit.path };
      tree.delete(edit.path);
      tree.set(edit.to, { brk: file.brk, lines: res.lines, ends: res.ends });
      return null;
    }
    case "str_replace": {
      const file = tree.get(edit.path);
      if (!file) return { code: "missing", path: edit.path };
      const isCrlf = file.brk === "\r\n";
      let text = writeFile(file);
      let oldStr = edit.oldStr;
      let newStr = edit.newStr;
      if (isCrlf) {
        text = text.split("\r\n").join("\n");
        oldStr = oldStr.split("\r\n").join("\n");
        newStr = newStr.split("\r\n").join("\n");
      }
      let count = 0;
      let first = -1;
      let idx = text.indexOf(oldStr);
      while (idx >= 0) {
        count++;
        if (first < 0) first = idx;
        idx = text.indexOf(oldStr, idx + 1);
      }
      if (count === 0) return { code: "no-match", path: edit.path };
      if (count > 1) return { code: "ambiguous", path: edit.path };
      const out = text.slice(0, first) + newStr + text.slice(first + oldStr.length);
      const finalText = isCrlf ? out.split("\n").join("\r\n") : out;
      tree.set(edit.path, parseFile(finalText));
      return null;
    }
    case "insert": {
      const file = tree.get(edit.path);
      if (!file) return { code: "missing", path: edit.path };
      if (edit.insertLine < 0 || edit.insertLine > file.lines.length) {
        return { code: "no-match", path: edit.path };
      }
      const added = splitTextLines(edit.newStr);
      const lines = [...file.lines];
      lines.splice(edit.insertLine, 0, ...added);
      tree.set(edit.path, { brk: file.brk, lines, ends: file.ends });
      return null;
    }
  }
}

// ------------------------------------------------------------ CLI and tree

import { readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";

const FORMAT_NAMES = new Set(["unified", "search-replace", "v4a", "json", "auto"]);

function loadTree(root: string): Tree {
  const tree: Tree = new Map();
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) {
        const rel = relative(root, p).split(sep).join("/");
        tree.set(rel, parseFile(readFileSync(p, "utf8")));
      }
    }
  };
  walk(root);
  return tree;
}

function parseArgs(argv: string[]): { format: string; check: boolean; strict: boolean; patch: string | null } {
  let format = "auto";
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let positional: string[] = [];
  let afterDashDash = false;
  for (const arg of argv) {
    if (!afterDashDash && arg === "--") { afterDashDash = true; continue; }
    if (!afterDashDash && arg.startsWith("-") && arg !== "-") {
      if (arg.startsWith("--format=")) {
        if (seenFormat) fatalLine("error: usage", 2);
        seenFormat = true;
        const v = arg.slice("--format=".length);
        if (!FORMAT_NAMES.has(v)) fatalLine("error: usage", 2);
        format = v;
      } else if (arg === "--check") {
        if (seenCheck) fatalLine("error: usage", 2);
        seenCheck = true;
        check = true;
      } else if (arg === "--strict") {
        if (seenStrict) fatalLine("error: usage", 2);
        seenStrict = true;
        strict = true;
      } else {
        fatalLine("error: usage", 2);
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) fatalLine("error: usage", 2);
  return { format, check, strict, patch: positional.length === 1 ? positional[0] : null };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  // Read the patch (exit 2: no-patch) before anything else.
  let patchText: string;
  if (opts.patch === null || opts.patch === "-") {
    patchText = readFileSync(0, "utf8");
  } else {
    try {
      patchText = readFileSync(opts.patch, "utf8");
    } catch {
      fatalLine("error: no-patch", 2);
    }
  }

  const lines = splitPatchLines(patchText);
  const format = opts.format === "auto" ? detectFormat(lines) : opts.format;
  let edits: Edit[];
  if (format === "unified") edits = parseUnified(lines);
  else if (format === "search-replace") edits = parseSearchReplace(lines);
  else if (format === "v4a") edits = parseV4a(lines);
  else edits = parseJson(patchText, lines);
  if (edits.length === 0) fatalLine("error: parse 1", 2);

  const tree = loadTree(process.cwd());
  const before = new Map<string, string>();
  for (const [p, s] of tree) before.set(p, writeFile(s));

  const failures: Failure[] = [];
  const moves: Array<[string, string]> = [];
  for (const edit of edits) {
    const fail = applyEdit(edit, tree, opts.strict);
    if (fail) {
      failures.push(fail);
    } else if (edit.type === "move") {
      moves.push([edit.path, edit.to]);
    }
  }

  if (failures.length > 0) {
    const out: string[] = [];
    for (const f of failures) out.push(`error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    process.stdout.write(out.join("\n") + "\n");
    process.exit(1);
  }

  // Diff the tree before/after to list changes.
  const deleted = new Set<string>();
  const added = new Set<string>();
  const modified = new Set<string>();
  for (const [p, bytes] of before) {
    if (!tree.has(p)) deleted.add(p);
    else if (writeFile(tree.get(p)!) !== bytes) modified.add(p);
  }
  for (const p of tree.keys()) {
    if (!before.has(p)) added.add(p);
  }
  const outLines: Array<{ key: string; text: string }> = [];
  const usedMoves: Array<[string, string]> = [];
  for (const [oldP, newP] of moves) {
    if (deleted.has(oldP) && added.has(newP)) {
      deleted.delete(oldP);
      added.delete(newP);
      usedMoves.push([oldP, newP]);
    }
  }
  for (const p of deleted) outLines.push({ key: p, text: `D ${p}` });
  for (const p of added) outLines.push({ key: p, text: `A ${p}` });
  for (const p of modified) outLines.push({ key: p, text: `M ${p}` });
  for (const [oldP, newP] of usedMoves) outLines.push({ key: newP, text: `R ${oldP} -> ${newP}` });
  outLines.sort((a, b) => byteOrder(a.key, b.key));

  const total = outLines.length;
  const out: string[] = outLines.map((l) => l.text);
  out.push(total === 1 ? "ok: 1 file" : `ok: ${total} files`);

  // Write first, print after: a failed write must never be followed by
  // an `ok:` line.
  if (!opts.check) {
    for (const p of deleted) {
      rmSync(join(process.cwd(), p), { force: true });
    }
    for (const [oldP] of usedMoves) {
      rmSync(join(process.cwd(), oldP), { force: true });
    }
    for (const p of added) {
      const full = join(process.cwd(), p);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, writeFile(tree.get(p)!), "utf8");
    }
    for (const p of modified) {
      writeFileSync(join(process.cwd(), p), writeFile(tree.get(p)!), "utf8");
    }
    for (const [oldP, newP] of usedMoves) {
      const full = join(process.cwd(), newP);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, writeFile(tree.get(newP)!), "utf8");
    }
  }
  process.stdout.write(out.join("\n") + "\n");
  process.exit(0);
}

// ------------------------------------------------------------- entry point

try {
  if (process.env.MAKEFUN_ENV_URL) {
    const runner = await import("./runner.ts");
    await runner.runTrials();
    process.exit(0);
  } else {
    main();
  }
} catch (err) {
  if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EPIPE") {
    process.exit(0);
  }
  process.stderr.write(String(err && (err as Error).stack ? (err as Error).stack : err) + "\n");
  process.stdout.write("error: parse 1\n");
  process.exit(2);
}
