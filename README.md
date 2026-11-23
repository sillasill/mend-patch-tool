# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sillasill/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sillasill/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an AI-written edit to a tree of text files — unified
diffs, SEARCH/REPLACE blocks, V4A patches, and JSON tool calls —
and is careful about the things AI-written patches usually get
wrong: line numbers that drift, indentation that does not match the
file, and edits that name files that are not there.

Built for the [make.fun bounty "Build mend"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
($100, closes 24 Nov 2026).

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

The working directory is the tree to patch. `PATCH` is a path
relative to that directory; when it is absent, or `-`, the patch is
read from standard input. `--format` picks the shape explicitly
(`unified`, `search-replace`, `v4a`, `json`, `auto`);
`--check` runs everything but writes nothing; `--strict` only
accepts lines that match exactly.

Exit 0 prints one line per changed path (`A`/`D`/`M`/`R`) and
`ok: <n> files`. Exit 1 lists the failed edits and prints
`failed: <k> of <n> edits` — nothing is written. Exit 2 means the
patch itself is unusable (`error: usage` / `no-patch` / `format` /
`parse <N>`).

See [SPEC.md](SPEC.md) for the full rules and [NOTES.md](NOTES.md)
for design notes and verification results.

## Verification

- Practice trials (kit): 100/100 on all three, score 1000.
- Adversarial cases (`node check.ts`): 108/108.
- Deterministic: two full practice runs byte-identical.

## License

MIT — see [LICENSE](LICENSE).
