# Baseline gates, recorded before any change

Upstream `upstream/main` @ `93025f2` (pi-atelier 0.18.0), Windows 11, Node 26.5.0,
Windows Terminal / PowerShell. The checkout was normalized to LF because the repo has no
`.gitattributes` and `core.autocrlf=true` turned every file CRLF.

| Gate | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run format:check` | pass after LF normalization (73 CRLF errors before) |
| `npm run check:pack` | pass — 36 files |
| `npm test` | 490 passed / 3 failed (493, 25 files) |
| `npm run bench:sidebar` | 3.1619 / 1.8922 / 3.5070 ms at 0/8/64 panels |

Pre-existing Windows-only failures, reproduced before any edit and still failing after (unrelated
to this work):

1. `run-activity.test.ts > summarizeTool > shortens project-relative and home-relative paths`
2. `run-activity.test.ts > summarizeTool > normalizes paths before deciding whether they are project relative`
3. `subagent-usage.test.ts > uses project and explicit custom artifact locations…` — `EPERM: symlink`

Raw: `docs/goalx/bench/baseline-sidebar.json`.
