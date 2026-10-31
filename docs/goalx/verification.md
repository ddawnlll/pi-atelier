# Verification matrix

Everything below was executed on this machine (Windows 11, Node 26.5.0, Pi 1.4.0) at the commit that
contains this file. Nothing here is estimated.

## Automated

| Layer | Suite | Covers |
|---|---|---|
| Adapter | `tests/goalx.test.ts` (32) | goal-file parsing and corruption, **session `pi-goal-focus` focus** (created, switched, explicitly unfocused, malformed), ledger focus never used, current task explicit vs inferred vs nested, top-level progress, audit phases, repeated/out-of-order audit events, external/session storage root, malformed ledger lines, bounded tail read, stat-keyed cache, watcher debounce and dispose |
| Rendering | `tests/goalx-panel.test.ts` (16) | status/objective/progress/current/upcoming/completed, inferred label, paused/blocked reasons, subtasks, 24-row cap, sanitized control sequences, no fabricated audit checks or percentages, widths 24-60 × heights 12-70 |
| Sidebar | `tests/goalx-ui.test.ts` (6) | both load orders, unknown contribution, unload/reload, plain vs colored, small heights, width bounds |
| Preset | `tests/goal-preset.test.ts` (6) | hidden-but-present redundant panels, goal-first order, single source for metrics/model, other presets unchanged, explicit layout wins, revert |
| Extension lifecycle | `tests/extension-goalx.test.ts` (9) | mounts the real extension through `session_start` → sidebar mount → in-session events with a real Goal X storage layout: focused goal renders, editorial preset untouched, pool of several goals shows only the focused one, focus change and unfocus, Goal X absent, long titles stay inside width, shutdown + reload, **no new or overridden shortcuts**, stable height across repeated events |
| Widget shim | `tests/goalx-widget-shim.test.ts` (5) | patch, idempotence, byte-exact revert, unsupported version guard |
| End-to-end (opt-in) | `tests/e2e-goalx.test.ts` | full lifecycle on a temp storage layout, rendered frames in `transcript.txt` |
| Real data (opt-in) | `tests/e2e-real-data.test.ts` | the actual `~/.pi/goals` and the actual session file |

### Real-data result (this machine)

```
root       C:/Users/dresden/Documents/src/.pi/goals
focused    true            <- from the session pi-goal-focus entry, not the ledger
goalId     mvwwza7q-3aqnje
tasks      13/13 (100%)
audit      disapproved     <- the real auditor rejection
warnings   []
```

### Full gate results

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run format:check` | pass (86 files) |
| `npm run check:pack` | pass (38 files) |
| `npm test` | 568 passed, 3 failed, 2 skipped — the 3 are the pre-existing Windows baseline failures (`run-activity` POSIX-home assertions, `subagent-usage` symlink `EPERM`) reproduced on `upstream/main` |
| `npm run check` | `typecheck`, `format:check` (89 files), `test`, `check:pack` all pass individually. `check:audit` needs registry access and was not part of the recorded run |
| `npm run bench:sidebar` | no regression (see `performance.md`) |

### Isolated Pi process

Two runs, both against the **installed host** (Pi 1.4.0), with an isolated
`PI_CODING_AGENT_DIR` containing `pi-goal-x` and this fork:

1. `pi --mode rpc --no-session --offline` + `get_state` — the package imports and the RPC command
   succeeds with empty stderr. Note that Atelier returns early from `session_start` when
   `ctx.mode !== "tui"`, so this run proves loading, **not** sidebar mounting.
2. `winpty -Xallow-non-tty node <host cli.js> --offline --no-session --tui-mode regular` with a
   configured model, driving `/goal-focus <id>` — a real TUI process started, Atelier's rail
   rendered (model `deepseek-v4.1-flash`, thinking level, repo, context %, cost, `F6`), and the
   session exited cleanly. The captured frame contains the rail but **not** the sidebar panel body:
   the pseudo-terminal had no size (`cols/rows == 0` per libwinpty), so no split pane was laid out.

3. **Live focused-goal sidebar (sized ConPTY).** `pywinpty` opened a real 150x45 pseudo-terminal and
   started the installed Pi 1.4.0 with an isolated agent dir (pi-goal-x + this fork,
   `pi-atelier.json` = `goalfocus`), a read-only copy of a real session (so session focus resolves)
   and `PI_GOAL_ROOT` pointed at a copy of the goal root whose focused goal was set to `paused`, so
   no agent or auditor run could start. Capture: `docs/goalx/live-tui-frame.txt` — the sidebar
   rendered `GOAL X`, `PAUSED`, the real objective, `Progress 13/13 · 100%`, `✓ 13 done · 10 hidden`,
   the completed task rows and `AUDIT · CHANGES NEEDED`, next to `CONTEXT`. This satisfies the
   "sidebar verified with a test goal" criterion in a live process.

### Live scenario walk (isolated Pi, real TUI)

`scripts/e2e/live-tui-scenario.py` drives the installed Pi 1.4.0 in a sized ConPTY against a copy of
a real session and a paused copy of the goal root (nothing real is written), and walks the whole
lifecycle in the running TUI. Result: **10/10 steps pass** —

| Step | Observed |
|---|---|
| 01 focused goal | `GOAL X`, `PAUSED`, `Progress`, real objective |
| 02 task change | new `live-task` appears in the panel |
| 02b task completed | progress row updates |
| 03 audit running | `AUDITOR · VERIFYING`, `Decision: PENDING` |
| 04 approved | `AUDIT · APPROVED`, `Decision: APPROVED` |
| 05 changes requested | `AUDIT · CHANGES NEEDED` |
| 06 goal switch | panel switches to the second focused goal |
| 07 session reload | panel renders the focused goal again |
| 08-09 resize | 100x30 and 120x40 both render `GOAL X` |

Frames and PNG renderings of the captured frames: `docs/goalx/live-scenario/` (plus
`results.json`). The PNGs are images generated from the real captured text, labelled as such.

### Still not covered by a live TUI

Pixel-level fidelity of a *photographic* screenshot (the PNGs are renderings of captured text, not
screen grabs), and the widget-hidden state, which needs a restart and remains unit-tested.

## Reproduce

```bash
npm ci
npm run typecheck && npm run format:check && npm test && npm run check:pack
npm run bench:sidebar
PI_E2E=1 npx vitest run tests/e2e-goalx.test.ts
PI_REAL_GOALS_ROOT=<repo>/.pi/goals PI_REAL_SESSION=<session.jsonl> npx vitest run tests/e2e-real-data.test.ts
```

## Not verified automatically

- **Interactive TUI painting.** No headless screen capture was available, so colours, borders and
  live repaint were verified through the real renderer output (`transcript.txt`, the extension-level
  suite) rather than a screenshot. This is the one criterion that needs a human eye at a terminal.
- **Goal X's live auditor progress stream.** Not persisted by Goal X; the panel deliberately shows
  only ledger-backed state and labels the gap.
- **The above-editor widget staying hidden in a live session.** The shim is unit tested and the
  guard is inert by default, but toggling it requires a Pi restart, so it was not exercised live.
