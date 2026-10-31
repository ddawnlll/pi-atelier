# Final handoff

## Repository

| Item | Value |
|---|---|
| Fork | https://github.com/ddawnlll/pi-atelier |
| Branch | `feat/pi-goal-x-integration` |
| Code commit | the branch head at the time of writing (installed pin == branch head == `origin`); this file is committed in the immediately following docs-only commit, so `git rev-parse --short HEAD^` is the code commit it describes |
| Upstream base | `93025f2` — pi-atelier 0.18.0, MIT |
| Changed files | filled in the docs-only commit that follows the code commit (see below) |
| Remotes | `origin` = fork, `upstream` = michaelmjhhhh/pi-atelier |
| Installed pin | read from `pi list`; equals `git rev-parse HEAD` in the installed checkout |

## Implementation

Files added: `src/goalx.ts` (read-only adapter), `src/goalx-panel.ts` (row renderer),
`tests/goalx*.test.ts`, `tests/goal-preset.test.ts`, `tests/extension-goalx.test.ts`,
`tests/e2e-*.test.ts`, `scripts/goalx-widget-hide.mjs`, `scripts/win-symlink-shim.mjs`,
`scripts/e2e/live-tui-scenario.py`, `docs/goalx/*`.

Files changed: `extensions/index.ts` (reader lifecycle + panel publication), `src/sidebar.ts`
(goal panel drop rank), `src/config.ts` / `src/display.ts` / `src/sidebar-panels.ts`
(`goalfocus` preset + layout), `package.json` (two additive `bench:*:win` scripts),
`README.md` (one section). Upstream tooling files are byte-identical to upstream.

Integration mechanism: session `pi-goal-focus` entries for focus, the focused goal record for
tasks, the append-only ledger for audit history. Read-only, no Goal X imports, no model calls.

Auditor integration: `audit_started` → `AUDITOR · VERIFYING` + `Decision: PENDING`;
`audit_result` → approved / changes-requested / error with the report's findings; `audit_skipped`.
Only the decision check is ever claimed, because it is the only per-check fact persisted.

Goal X modified: **no**. Original widget: retained by default (criterion 9's documented fallback);
`scripts/goalx-widget-hide.mjs` is optional tooling, disabled by default, not part of the
integration's on/off state.

## Validation

- `npm run typecheck` pass · `npm run format:check` pass (92 files) · `npm run check:pack` pass
  (38 files) · `npm test` **571 passed / 3 failed / 2 skipped** (the 3 are the pre-existing Windows
  failures recorded in `bench/BASELINE.md`, reproduced on upstream before any change).
- Benchmark: baseline 3.1619 / 1.8922 / 3.5070 ms; branch 2.4435 / 1.7163 / 3.6750 ms
  (`npm run bench:sidebar`) and 1.6491 / 0.9688 / 2.2758 ms (`npm run bench:sidebar:win`).
  No regression; the harness does not exercise the Goal X panel (see `performance.md`).
- Live isolated Pi 1.4.0 ConPTY run: 18/18 checks pass (pyte screen, border-anchored panel
  extraction, synthetic goals, explicit vs inferred current task, transition frames required to
  differ), frames and PNGs in
  `live-scenario/`; results in `live-scenario/results.json`.
- Real data: session focus + real goal root → `focused: true`, goal `mvwwza7q-3aqnje`, 13/13,
  `audit: disapproved`, no warnings.

## Installation

Active source: `git:github.com/ddawnlll/pi-atelier@<pin>` (one Atelier instance; all other packages
preserved). Config: `~/.pi/agent/pi-atelier.json` = `{"preset":"goalfocus","sidebarWidth":32}`.
Backups: `~/.pi/agent/backups/pi-atelier-goalx-*`. Rollback was executed and verified
(fork → upstream → fork). Activation takes effect on the next safe Pi start.

## Limitations

1. No live per-check audit progress (Goal X does not persist it); labelled, never invented.
2. The duplicate Goal X widget stays visible unless the optional shim is installed; no supported
   Atelier-side toggle exists in Goal X 0.34.1.
3. PNG artifacts are renderings of real captured TUI text, not screen grabs.
4. Three pre-existing Windows test failures remain (untouched upstream tests).

## Verdict

**PASS** on the functional acceptance criteria, verified by executed gates, a live isolated-Pi
lifecycle walk, real-data parsing and a verified install/rollback. The four limitations above are
documented residuals, not unverified claims.
