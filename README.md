# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sillasill/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sillasill/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

A command-line tool that applies the edits AI models write to a tree of text
files. One invocation, one patch, four formats — unified diffs (often with
wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor
tool calls — matched at three tiers (exact, trailing whitespace, indentation)
and written all-or-nothing, as `SPEC.md` specifies.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, or `-`/absent for standard input.
- `--format` picks `unified`, `search-replace`, `v4a`, `json`, or `auto`
  (the default, which detects the format).
- `--check` reports what would change without writing anything.
- `--strict` matches lines exactly (tier 0 only).

Node 22, standard library only. `SPEC.md` is the whole contract; `NOTES.md`
records the design, the practice scores, and the adversarial cases tested.
`check.ts` runs the kit's practice set against `main.ts`.
