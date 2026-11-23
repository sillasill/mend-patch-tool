# mend — build notes (rebuild, in-window)

Entry for `hidden-spec-cli-01-run-20261122` ($100, deadline 24 Nov 2026 21:00 WIB).
Rebuilt 22 Nov 2026 in a session started AFTER the competition opened
(21:00 WIB), so its transcript is submittable — the first build session
started before opening and its bundle cannot be entered. Every file in this
directory was written fresh in the rebuild session (main.ts in five write
calls); nothing was copied from the pre-opening draft. Not submitted; no repo
created here — the main agent handles repo/push/submit after verification.

## Files

- `main.ts` — the CLI (938 lines, written in this session; the command line,
  output, safe paths, format detection, JSON edits and atomic write follow the
  kit starter's shape, sections 1–4, 9, 10 of SPEC.md; the three-tier line
  matcher and the unified / SEARCH-REPLACE / V4A readers, sections 5–8, plus
  the `R old -> new` move line, are the entry's own code).
- `runner.ts`, `check.ts`, `LICENSE`, `SPEC.md` — kit starter files, written
  out in this session and sha256-verified byte-identical to the kit
  (SPEC.md 2b5421da..., LICENSE c31b3812..., runner.ts f946f8b6...,
  check.ts 5432f692...).
- `README.md` — short readme (badges / GitHub About still to be added at repo
  creation, per the bounty requirements).

## Scores (rebuild, verified in this session)

- Practice set (kit `program/generator/practice.json`, 100 checks):
  `node check.ts <practice.json>` → **100 of 100 passed, practice score 1000**
  (unified 30/30, search_replace 20/20, v4a 20/20, json 15/15, cli 15/15).
- Full local trial through the kit's own env server + scorer
  (`practice/trial-0`, `program/env/server.mjs` + `program/scorer/score.mjs`):
  **score 1000, working 1, passed 100**, same per-group counts.
- Adversarial suite (106 hand-computed checks from SPEC.md sentences the
  practice set does not cover; builder + data at
  `~/workspace/makefun/dev/hidden-spec-cli-adv/`): **106 of 106 passed**.
- Determinism: the same patch run twice in fresh directories gives
  byte-identical exit code, stdout and files.

## Design

- Files are kept as `{lines, br, final}` (own line break CRLF/LF, whether it
  ends with one); edits work on lines and render back with the file's own
  break, so CRLF and no-trailing-newline files round-trip.
- Matching: tier 0 exact, tier 1 trailing spaces/tabs stripped, tier 2 both
  sides stripped; first tier with an occurrence wins. Context lines are
  written as the file's own matched line; at tier 2 other new lines are
  re-indented from O's first line to the file's first matched line.
- Unified: nearest occurrence to `A - 1 + d` (ties: earlier); empty O inserts
  after `A + d` lines; final break follows the `\`-after-last-context/`+` rule;
  a second `---`/`+++` pair inside a header re-names the paths (last wins)
  and does not start a new section; deletion hunks are parsed but not applied.
- SEARCH/REPLACE: path is the nearest non-blank, non-fence line before
  `SEARCH` (else the previous block's path); old lines must occur exactly
  once at their tier.
- V4A: anchor search then cursor-based chunk application; `*** End of File`
  restricts a chunk to an occurrence ending at the last line; blank lines at
  a section's end are stripped; a `*** Move to:` with no chunks is a pure move.
- Moves are reported as one `R old -> new` line (sorted by the new path),
  collapsing chains (A→B→C prints `R A -> C`); a move whose old path did not
  exist before the patch prints `A` instead (create-then-move).
- Failed edits roll back their own changes; when any edit fails nothing is
  written (exit 1, all failures listed in patch order).

## Adversarial cases tested (106, all passing)

Wrong-line-number nearest picks with the `d` offset; `\` after a `-` line
only (final break stays on); creation with/without `\` and with context
lines (only `+` lines used); hunk-less sections; malformed `diff --git` /
`@@` / header `---`; move exists/missing/no-match, chains, move-then-edit,
create-then-move, move-then-recreate; byte-order output sorting; `--check`
with a creation; rename-only sections; deletion hunks ignored; empty hunk
bodies; CRLF + no-EOL combinations; tier-2 re-indent; unsafe paths
(`..`, `\`, empty); S/R path reuse, fence-only path, tier-0-beats-tier-1,
strict whitespace; V4A missing Begin/End, bad lines, no-chunk updates,
move-only, EOF chunks (empty and anchored), anchor tiers, cursor order,
trailing-blank Add files, empty Add files; JSON overlapping `old_str`,
insert into empty/at-end files, array faults, bad commands, CRLF `new_str`;
CLI duplicates, `--` handling, empty patches per `--format`, detection
priority (S/R beats unified).

## Judgment calls (spec sentences with more than one plausible reading)

These follow the letter of SPEC.md as written; they are the main residual
risk if the house reference reads them differently:

1. A `\` line after a `-` line (not after the hunk's last context/`+` line)
   does **not** remove the final line break (tested: deleting the last line
   of a no-trailing-newline file yields a file ending with a break).
2. Only literally empty (`''`) lines are stripped from the end of a unified
   hunk body; a trailing `' '` context line stays a body line.
3. A second `---`/`+++` pair inside a section header re-names the paths
   (last wins) instead of starting a new section.
4. A deletion section's malformed `@@` line is a parse error (hunks are
   parsed, just not applied).
5. For an end-of-file V4A chunk, the tier is chosen among occurrences that
   end at the last line (the EOF restriction applies during tier selection).
6. A blank line between two V4A chunks is a body line (empty context) of
   the first chunk, not ignored.
7. A V4A `*** End of File` line is matched exactly (no surrounding-whitespace
   trim), unlike Begin/End Patch, where the spec explicitly says trimmed.

## Not yet tested

- Behaviour on a patch naming a path that is a directory in the tree
  (the reference skeleton treats it as missing; writes would then fail the
  same way in both).
- Extremely large files / pathological occurrence counts (files in checks
  are small; matching is O(lines × old-lines) per tier).

## Verification commands run

```
node check.ts <kit>/program/generator/practice.json
# 100 of 100 passed: practice score 1000

# local end-to-end trial (trial-0 checks via program/env/server.mjs,
# scored with program/scorer/score.mjs):
# 100 of 100 checks answered
# score 1000 working 1 passed 100
# unified 30 search_replace 20 v4a 20 json 15 cli 15

node check.ts ~/workspace/makefun/dev/hidden-spec-cli-adv/adv.json
# 106 of 106 passed
```
