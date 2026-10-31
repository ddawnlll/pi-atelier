# Pi Goal X integration

Atelier can show **what the agent is currently trying to accomplish**: the focused Goal X goal, its
lifecycle status, task progress, the current task (explicit or Goal X's documented inferred
fallback), upcoming/completed tasks, and the independent auditor's real verdict.

Atelier is a **presentation layer only**. Goal X keeps ownership of goals, tasks, focus, evidence,
scheduling and audit verdicts.

## What it does

- Reads the session's `pi-goal-focus` entry for focus (Goal X stores focus in the session
  transcript, not in the project ledger), then the focused goal record and the append-only ledger
  from Goal X's storage root (default `<cwd>/.pi/goals`, overridable through `goalsRoot` /
  `PI_GOAL_ROOT`).
- Publishes a `goalx:goal` sidebar panel through Atelier's existing `pi-atelier:sidebar-panels`
  protocol.
- Never writes Goal X files, never calls a model, never imports Goal X's internal modules.
- Stays inert when Goal X is absent or when the session has no focused goal. A goal is **never
  auto-selected** just because it is the only one in the pool, and another session's focus never
  becomes this session's focus.

## Enabling the goal-focused layout

```jsonc
// ~/.pi/agent/pi-atelier.json  (or <project>/.pi/pi-atelier.json)
{
  "preset": "goalfocus",   // hides AGENT/ACTIVITY/ALERTS/TODOS/PREFILL/USAGE/SUBAGENTS/TOOLS
  "sidebarWidth": 32       // useful range is roughly 30-34 columns
}
```

`goalfocus` puts the Goal X panel first and keeps `CONTEXT` + `WORKSPACE` compact. The hidden panels
are **still installed** — enable any of them again under `/atelier` → Settings → Sidebar, or with an
explicit `sidebarPanelLayout`:

```jsonc
{
  "sidebarPanelLayout": [
    { "id": "goalx:goal", "visible": true },
    { "id": "context", "visible": true },
    { "id": "agent", "visible": true },
    { "id": "workspace", "visible": true }
  ]
}
```

An explicit `sidebarPanelLayout` always wins over the preset, so existing customisations survive.
Switching back to `editorial`, `minimal` or `classic` restores the original panel layout.

## Configuration reference

| Setting | Where | Default | Effect |
|---|---|---|---|
| `preset` | `pi-atelier.json` | `editorial` | `goalfocus` selects the goal-first panel and rail layout |
| `sidebarWidth` | `pi-atelier.json` | 36 | sidebar columns; 30-34 recommended with the goal panel |
| `sidebarPanelLayout` | `pi-atelier.json` | all built-ins | explicit panel order/visibility, overrides the preset |
| `goalsRoot` | `pi-goal-x-settings.json` | `<cwd>/.pi/goals` | Goal X storage root the adapter reads |
| `PI_GOAL_ROOT` | environment | — | overrides `goalsRoot` |
| `PI_GOAL_HIDE_COMPACT_WIDGET` | environment | unset | `1` hides Goal X's above-editor widget **after** the optional shim is installed |

## What is shown

| Source | Display |
|---|---|
| `GoalRecord.status` | `RUNNING` / `PAUSED` / `BLOCKED` / `BUDGET LIMITED` / `COMPLETE` |
| top-level tasks (`complete` + `skipped`) | `Progress 4/6 · 67%` plus an 8-cell meter |
| `currentTaskId` | `▶ task-5 Title` — confirmed focus |
| first pending task fallback | `~ task-5 Title` + `inferred focus` — never presented as executing |
| `subtasks` | `subtasks 1/2` and the next pending subtask |
| `pauseReason` / `pauseSuggestedAction` | `Paused:` / `Blocker:` rows |
| `audit_started` | `AUDITOR · VERIFYING`, `Checks: not persisted`, `Decision: PENDING` |
| `audit_result: approved` | `AUDIT · APPROVED`, `Decision: APPROVED`, `Goal complete` |
| `audit_result: disapproved` | `AUDIT · CHANGES NEEDED`, up to three findings, `Goal remains open` |
| `audit_result: error` | `AUDIT · ERROR` plus the report's first line |
| `audit_skipped` | `AUDIT · SKIPPED` plus the recorded reason |

### Honesty rules

- No percentage is invented. Goal X persists no intermediate audit progress, so the panel never
  shows an audit percentage; it says the check detail is not persisted instead.
- Only the **decision** check is ever reported, because the verdict is the only per-check fact
  Goal X records. Other stages are never marked passed or failed.
- A pending decision is never rendered as approved. Approved/changes-requested/error come only
  from an `audit_result` ledger event.
- A pending task is never marked as executing: explicit and inferred focus are visually distinct.
- All titles, objectives and audit text are treated as untrusted: terminal control sequences are
  stripped before rendering.

## Duplicate Goal X widget

Goal X's above-editor widget is **kept by default**. Goal X 0.34.1 has no setting to hide the
focused-goal widget, and pi's widget keys have no cross-extension visibility API. See
[widget-suppression.md](./widget-suppression.md) for the opt-in, reversible shim
(`scripts/goalx-widget-hide.mjs`).

## Keyboard behaviour

No new bindings. F6 control centre, Goal X's dashboard/task shortcuts, and every other extension's
shortcuts are untouched.

## Performance

See [performance.md](./performance.md). Summary: one `stat` plus a session-branch scan per render
request, parsing only when the ledger stamp changes, no timers in the render path, no model
requests, no new dependencies.

## Tests

```bash
npm test                                   # unit + integration (Windows: 3 pre-existing failures)
PI_E2E=1 npx vitest run tests/e2e-goalx.test.ts        # full lifecycle on a temp storage layout
PI_REAL_GOALS_ROOT=~/.pi/goals PI_REAL_SESSION=<session.jsonl> npx vitest run tests/e2e-real-data.test.ts
npm run bench:sidebar:win                  # Windows benchmark (junction shim, upstream tooling untouched)
```

`tests/goalx.test.ts` covers parsing, session focus, current-task semantics, progress and audit
derivation. `tests/extension-goalx.test.ts` mounts the real extension and reads the rendered sidebar.
`tests/goalx-panel.test.ts` covers rendering and width behaviour. `tests/goalx-ui.test.ts` covers
load order, unload/reload, plain vs colored rendering and small heights. `tests/goal-preset.test.ts`
covers the layout preset. `tests/goalx-widget-shim.test.ts` covers the optional widget patch.

## Known limitations

1. **No live per-check audit progress.** Goal X keeps auditor progress in memory only. The panel
   shows ledger-backed state (started → verdict) and labels the missing detail instead of guessing.
   A future Goal X event publisher (option B) would close this gap without changing Atelier.
2. **Audit summary stays in the conversation.** The sidebar is compact by design; the full auditor
   report remains Goal X's own dashboard/notification.
3. **Widget is not hidden automatically** (see above).
4. **Audit stage detail is unavailable.** Goal X persists start + verdict only; no per-check or
   workspace-inspection signal exists to display.
5. **Attribution of findings** follows Goal X's deterministic extraction: findings are bullets or
   leading lines from the report, capped at three. Vague prose is not converted into pass/fail.
6. **Windows baseline failures** in `npm test` (`run-activity` POSIX-home assertions and a
   `subagent-usage` symlink `EPERM`) exist upstream and are unrelated to this integration.

## Upstream sync

```bash
git fetch upstream
git rebase upstream/main        # fork only adds src/goalx*.ts, docs/goalx, scripts/goalx-*, tests
npm ci && npm test
```

Conflicts are limited to `src/config.ts` (preset wiring), `src/sidebar.ts` (goal panel drop rank),
`src/display.ts` + `src/sidebar-panels.ts` (layout constants) and `extensions/index.ts` (reader
lifecycle).

## Install and rollback

```powershell
# install this fork (pinned)
pi remove https://github.com/michaelmjhhhh/pi-atelier
pi install git:github.com/ddawnlll/pi-atelier@<commit>

# roll back to upstream
pi remove git:github.com/ddawnlll/pi-atelier@<commit>
pi install https://github.com/michaelmjhhhh/pi-atelier
Remove-Item ~/.pi/agent/pi-atelier.json   # drop the goalfocus preset
```

Back up `~/.pi/agent/settings.json` before changing packages. No Goal X state is touched by install
or rollback.
