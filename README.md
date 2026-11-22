# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mertazyzik/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mertazyzik/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a command-line tool that applies AI-written edits to a tree of text files. It reads all four formats AI models write — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON — against one written specification, SPEC.md. It finds the edited lines even when the model drifted whitespace or indentation, and it changes every file or nothing at all (atomic).

## Run it

```sh
node main.ts fix.patch
```

`node main.ts [--format=NAME] [--check] [--strict] [PATCH]` — PATCH is the patch file, or `-`/absent for standard input. Node 22, standard library only, no install step. `main.ts` implements SPEC.md sections 1–10; `runner.ts` is the kit's trial runner, kept as it is.

---

<sub>Entered on [make.fun](https://make.fun/?ref=fhhc70yr&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
