# Notes on the mend rewrite

This entry was written from scratch in one session, from the SPEC
alone — no earlier implementation was read, copied, or retyped. The
previous rebuild failed the kit check `thinking_reproduces` (2.8%
authored) because that session had read the draft's files first; this
rewrite exists to fix that.

## How it is built

- `main.ts` — the mend CLI (Node 22, standard library only). The
  tree is held as a map from path to `{brk, lines, ends}` plus an
  optional `raw` override so a JSON `create` stays byte for byte.
  Parsers for the four shapes produce small edit objects; one
  applier runs them against a working copy of the tree; the output
  is computed by diffing the tree before and after, so a file that
  ends up exactly as it started is never listed.
- `runner.ts` — the trial runner. When `MAKEFUN_ENV_URL` is set,
  `main.ts` hands over to it: it GETs `/checks`, runs
  `node main.ts` once per check in a fresh directory holding exactly
  that check's files (with the check's stdin, without
  `MAKEFUN_ENV_URL`, 10 s limit, timed out as exit 124), and POSTs
  the results in batches of at most 100.
- `check.ts` — local verification: the kit's 3 practice trials, 108
  hand-built adversarial cases with hand-computed outcomes, and a
  determinism run (the whole practice suite twice, byte-identical).

## Verification (23 Nov 2026, local, Node v24.22.1)

- Practice: trial-0, trial-1, trial-2 each **100/100, score 1000**
  (unified 30/30, search_replace 20/20, v4a 20/20, json 15/15,
  cli 15/15).
- Adversarial: **108/108**.
- Determinism: **yes** (two full practice runs byte-identical).

## Judgment calls (where the SPEC leaves room)

- **Empty body lines are context lines.** A hunk/chunk body line
  that is empty is a context line whose text is empty. (Found by
  the practice trials: patches whose hunks contain a truly empty
  line only match when that line is part of `O`.)
- **A lone `--- ` line inside a hunk body is an old line.** §6 ends
  a body at a `--- ` line *followed by* `+++ `; the qualifier is
  there because a `--- ` line otherwise looks like a `-` body line,
  so a lone one is consumed as one (old line `-- …`).
- **Trailing blank lines.** In V4A, blank lines (empty or only
  whitespace) at the end of a chunk are not part of it (§8); in
  unified diffs, only truly empty lines at the end of a body are
  not part of it (§6 says "empty", §8 says "blank" — the words
  differ on purpose). End-of-file V4A chunks are never stripped:
  a trailing empty line there can be the file's own last line.
- **Format detection is literal (§4).** A patch that is only a
  hunk (`@@ …`) or only `*** Update File: …` is `error: format`,
  not a parse error — the shape rules only run once a shape has
  been detected. The `parse 1` rule for a hunk before any section
  (or a V4A patch whose first line is not `*** Begin Patch`) fires
  when the patch *is* detected as that shape, or when `--format`
  names it (the kit's own practice check c094 proves the latter).
- **SEARCH/REPLACE matches whole lines**, like every other shape
  (§5) — a block's old text must be complete lines of the file,
  not a substring.
- **Chained moves.** A move is reported as `R old -> new` only
  when the old path is deleted and the new path is added in the
  final diff; a move whose target is moved again degrades to a `D`
  plus an `A` line.
- **Unexpected internal errors** print `error: parse 1` on stdout
  and exit 2, so the CLI never dies silently mid-trial.
- **Output is printed only after the write succeeds**, so a failed
  write can never be followed by an `ok:` line.
