# mend — specification

`mend` takes a patch written by an AI (or a human) and applies it to a
tree of text files. It understands four patch shapes — unified diffs,
SEARCH/REPLACE blocks, V4A patches, and JSON tool calls — and it is
careful about the things AI-written patches usually get wrong: line
numbers that drift, indentation that does not match the file, and
edits that name files that are not there.

## 1. Running it

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

The working directory is the tree to patch. `PATCH` is a path relative
to that directory; when it is absent, or when it is `-`, the patch is
read from standard input. `--format=NAME` picks the shape explicitly:
`unified`, `search-replace`, `v4a`, `json`, or `auto` (the default).
`--check` runs everything but writes nothing — the output and the exit
code are exactly what a real run would print. `--strict` only accepts
lines that match exactly. Options and the patch path may appear in any
order; `--` ends the options.

It is a usage error when an argument starts with `-` and is not `-`
and not one of the options above (before any `--`), when an option is
given twice, when `--format` names something outside the five names,
or when more than one positional argument is given.

## 2. What it prints, and how it exits

Standard output holds lines, each ended by `\n`, and nothing else.

**Exit 2 — the patch itself is unusable, nothing is written, exactly
one line:**

- `error: usage` — a usage error (§1).
- `error: no-patch` — the patch file cannot be read.
- `error: format` — with `auto`, no shape fits the text.
- `error: parse <N>` — the patch cannot be read in its shape, where
  `N` is the 1-based patch line the shape's section names. A patch
  with no edit at all is `error: parse 1`.

These are tried in that order: usage beats everything, and a parse
fault is reported before any file is looked at.

**Exit 1 — some edits failed, nothing is written.** One line
`error: <code> <path>` per failed edit, in patch order, then
`failed: <k> of <n> edits`. The codes:

- `no-match` — the lines or text are not in the file.
- `ambiguous` — they are there more than once and the shape gives no
  way to choose.
- `missing` — the edit changes, deletes, or moves a file that does
  not exist.
- `exists` — the edit creates a file, or moves to a path, that exists.
- `unsafe` — a path is not safe (§3). The line names the path as the
  patch wrote it, after any prefix §6 removes.

The path on an error line is the path the failure is about.

**Exit 0 — the tree is written.** One line per path whose state
changed, in byte order of paths (UTF-8), then `ok: <n> files` (or
`ok: 1 file`):

- `A <path>` — it did not exist, now it does.
- `D <path>` — it existed, now it does not.
- `M <path>` — it existed, still does, with other bytes.
- `R <old> -> <new>` — a file moved by a move edit that succeeded,
  when the old path existed before and not after, and the new path
  did not exist before and does after. It replaces that pair's `D`
  and `A` lines, and it sorts by `<new>`.

A file whose bytes after are its bytes before is not listed. A patch
that changes nothing prints only `ok: 0 files`.

## 3. Files, lines, paths

Files are UTF-8 text. A path is safe when it is not empty, does not
start with `/`, holds no `\`, and no `/`-separated segment is empty,
`.` or `..`. Directories are created as files need them.

A file's line break is CRLF when its first LF follows a CR, else LF.
Lines are the text split at that break. The file ends with a break
when the text ends with that break; the last empty piece is not a
line. An empty file has no lines and does not end with a break; a
file of no lines is written empty. A changed file is written back
with its own break between lines and a final one exactly when it
ended with one before the edit, unless §6 says otherwise for a
unified hunk. A created file is written with LF breaks and ends with
a break unless the shape says otherwise. A JSON `create` writes its
`file_text` byte for byte.

Patch lines are the text split at `\n`, each with one trailing `\r`
removed, without the empty piece after a final `\n`. Patch line
numbers count from 1.

## 4. Working out the shape (auto)

The first shape that fits wins. Blank means empty or only
whitespace.

1. The first non-blank line, surrounding whitespace removed, is
   `*** Begin Patch` — V4A.
2. The first non-whitespace character of the first non-blank line is
   `[` or `{` — JSON.
3. Some line, trailing whitespace removed, is `<<<<<<< SEARCH` —
   SEARCH/REPLACE.
4. Some line starts with `diff --git `, or some line starts with
   `--- ` and the next starts with `+++ ` — unified.

Otherwise `error: format`. A named `--format` is read as that shape
whatever the text holds.

## 5. Matching lines

Unified hunks, SEARCH/REPLACE blocks and V4A chunks name old lines
`O` (at least one) replaced by new lines `N`. `O` is found at the
first of three tiers at which it occurs at least once:

- tier 0 — every line equal;
- tier 1 — every line equal once trailing spaces/tabs are removed
  from both;
- tier 2 — every line equal once leading and trailing spaces/tabs
  are removed from both.

`--strict` tries tier 0 only. No tier means `no-match`. An occurrence
is a position `i` where `O`'s lines match file lines `i, i+1, …`;
occurrences may overlap. Each shape says which occurrence it takes
when there are several (§6–§8). `N` replaces the `k` matched lines.

A context line — a line of both `O` and `N` in a unified hunk or
V4A chunk — is written as the file's own matched line, never the
patch's. At tier 2 every other line of `N` is re-indented: let `F`
be the leading spaces/tabs of the file's first matched line and `P`
those of `O`'s first line; a line of `N` that is not empty and not
only whitespace, and starts with `P`, has that `P` replaced by `F`;
any other line is written as it is. At tiers 0 and 1 the lines of
`N` are written as they are.

## 6. Unified diffs

Sections start at `diff --git a/<X> b/<Y>` or at a `--- ` line
followed by a `+++ ` line that is not already part of a section's
header. Within a section, before its first hunk: `--- <path>` and
`+++ <path>` name the old/new path (the text after the four
characters, up to the first tab, surrounding spaces removed;
`/dev/null` means no file; a leading `a/` or `b/` is removed from
either); `rename from/to <path>` name old/new when no `---`/`+++`
pair does; `new file mode` means creation, `deleted file mode`
means deletion; the `diff --git` paths are used when nothing else
names one; `index`, `old mode`, `new mode`, `similarity index`,
`dissimilarity index`, `Index:` and any other line are ignored. A
`--- ` line not followed by a `+++ ` line, inside a section's
header, is `error: parse <the line after it>`. A `diff --git` line
not of the form above is `error: parse <its line>`.

Hunks start at `@@ -A[,B] +C[,D] @@`, optionally followed by text;
any other line starting with `@@` is `error: parse <its line>`,
and so is a hunk before any section. `B` and `D` are not used. A
hunk body is the lines after the header starting with ` `
(context), `-` (old), `+` (new) or `\`, or empty (an empty line is
a context line whose text is empty). A body ends at the first other
line, at a `diff --git ` line, at a `--- ` line followed by `+++ `,
or at the end of the patch; empty lines at the end of a body are
not part of it. Outside bodies, lines not part of a section header
are ignored (prose, code fences).

A section is one edit. Creation (old `/dev/null` or `new file
mode`): the new path must not exist, else `exists`; the file is
the `+` lines of all its hunks, in order. Deletion (new `/dev/null`
or `deleted file mode`): the old path must exist, else `missing`;
it is deleted and the hunks are not read. Move (old and new
differ): the old path exists, else `missing`, and the new path
does not, else `exists`; the hunks are applied to the old file's
lines, the result is written at the new path, and the old path is
deleted. Otherwise a change of the one path, which exists, else
`missing`.

Hunks apply in order, each to the result of the ones before. `O`
is the hunk's context + `-` lines, `N` is its context + `+` lines,
in body order. Let `d` be the sum over this section's hunks
applied so far of (len(`N`) − len(`O`)). When `O` is non-empty: of
the occurrences at the tier where `O` is found, take the one whose
0-based position is nearest to `A − 1 + d`; ties go to the earlier
one. When `O` is empty: `N` is inserted after the first `A + d`
lines (all of them when the file has fewer). A `\` line (as in
`\ No newline at end of file`) refers to the body line before it.
When a hunk's matched lines run to the end of the file (or, for
empty `O`, the insertion is at the end), the result ends with a
line break unless a `\` line follows the hunk's last context or
`+` line; when they do not, the file's final break stays as it was.
A created file ends with a line break unless a `\` line follows
its last `+` line. Any failure of a hunk fails the section with
that hunk's code, and the section changes nothing.

## 7. SEARCH/REPLACE blocks

A block is a `<path>` line, `<<<<<<< SEARCH`, old lines, `=======`,
new lines, `>>>>>>> REPLACE`. The three marker lines are matched
with trailing whitespace removed. The path is the nearest line
before the SEARCH line, and after the previous block's
`>>>>>>> REPLACE` line (or the start of the patch), that is not
blank and, surrounding whitespace removed, does not start with
three backticks; the path is that line with surrounding whitespace
removed. When there is no such line the block takes the previous
block's path; the first block with none is
`error: parse <its SEARCH line>`. A SEARCH line with no `=======`
and then `>>>>>>> REPLACE` after it is
`error: parse <the SEARCH line>`. Lines outside blocks are
otherwise ignored.

Each block is one edit, applied in order. Empty old lines mean
the file is created with the new lines, else `exists`. Otherwise
the file exists, else `missing`, and the old lines occur at their
tier exactly once, or the block fails with `ambiguous`; the new
lines replace them.

## 8. V4A patches

The first non-blank line is `*** Begin Patch`, else
`error: parse <that line>` (`error: parse 1` when there is none);
the last non-blank line is `*** End Patch`, else
`error: parse <the number of patch lines plus 1>`; both compared
with surrounding whitespace removed. Blank lines at the end of a
section (before the next section or `*** End Patch`) are not part
of it. Between them, sections start at `*** Add File: `,
`*** Delete File: `, `*** Update File: ` lines (the path is the
rest of the line, surrounding spaces removed). Blank lines between
sections are ignored. Any other line is
`error: parse <its line>`.

Add File lines start with `+` (the rest is a file line) or are
empty (an empty file line). Delete File has no lines. Update File
may have `*** Move to: <path>` as its first line, then chunks. A
chunk starts at an `@@` line (the text after `@@`, surrounding
spaces removed, is the anchor; empty text is no anchor) or, for
the first chunk, at a body line. Body lines start with ` `, `-`
or `+`, or are empty (an empty context line). A
`*** End of File` line ends a chunk and anchors it to the end of
the file. An Update File section with no chunk and no
`*** Move to:` is `error: parse <its Update File line>`.

Each section is one edit, applied in order. Add File: the path
does not exist, else `exists`; the file is the section's lines,
ended by a line break. Delete File: the path exists, else
`missing`; it is deleted. Update File: the path exists, else
`missing`; with Move to, the new path does not, else `exists`.
Chunks apply in order, the cursor starts at line 0. A chunk with
an anchor first finds the first line at or after the cursor equal
to the anchor at the first tier where one is (§5, both sides a
single line), else `no-match`; the cursor moves past it. `O` is
the chunk's context + `-` lines, `N` is its context + `+` lines.
The chunk takes the first occurrence of `O` at or after the
cursor, at the first tier with one; an end-of-file chunk takes
only an occurrence that ends at the file's last line. When `O` is
empty, `N` is inserted at the cursor, or at the end of the file
for an end-of-file chunk. The cursor then moves to just after the
lines written. With Move to, the result is written at the new
path and the old path is deleted.

## 9. JSON edits

The patch is either one JSON array of edit objects, or JSON Lines
(one edit object a line, blank lines ignored). Array form: any
fault is `error: parse <the line where the array starts>`; JSON
Lines form: a line that does not hold one valid edit object is
`error: parse <that line>`. An edit object has a string `path`
and a `command`; other keys are ignored.

- `{"command": "create", "path", "file_text"}`: the file does not
  exist, else `exists`; written with `file_text`'s bytes.
- `{"command": "str_replace", "path", "old_str", "new_str"}`:
  `old_str` is a non-empty string, `new_str` a string (absent
  means empty). The file exists, else `missing`. In a CRLF file,
  the file's text and both strings are read with every `\r\n` as
  `\n`, and the result is written back with `\r\n`. `old_str`
  occurs in the text exactly once (positions may overlap), else
  `no-match` or `ambiguous`; it is replaced by `new_str`. No
  tiers: the match is exact.
- `{"command": "insert", "path", "insert_line", "new_str"}`:
  `insert_line` is an integer, `new_str` a string. The file
  exists, else `missing`; `insert_line` runs from 0 to its number
  of lines, else `no-match`. `new_str`'s lines (split at `\n`,
  each with one trailing `\r` removed, without the empty piece
  after a final `\n`; an empty `new_str` has none) are inserted
  after line `insert_line` (0 is the top). The file's final break
  stays as it was.

A wrong command or a missing or mistyped key is a parse fault.

## 10. Order and atomicity

Edits apply in patch order to the tree as earlier edits left it:
a file created, changed, moved or deleted by an earlier edit is
seen so by a later one. Every path an edit names is checked for
safety before anything else about it. A failed edit changes
nothing, and the edits after it still run, so every failure is
reported. When any edit failed, no file is written (exit 1). When
none failed, every change is written (exit 0), or with `--check`
none is.
