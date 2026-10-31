# Pi Goal X integration — source research

Verified against the installed packages on this machine.

| Component | Location | Version |
|---|---|---|
| Pi Atelier | `~/.pi/agent/git/github.com/michaelmjhhhh/pi-atelier` (git package in `settings.json` → `packages`) | 0.17.0 installed, fork base 0.18.0 |
| Pi Goal X | `~/.pi/agent/npm/node_modules/pi-goal-x` (npm package) | 0.34.1 (latest on npm) |

The generic `dist` and `extensions` entries in the user's extension list are **not** Atelier:
Atelier is loaded from the git clone directory above, which is why it never appeared next to the
npm package names.

## Atelier sidebar contribution protocol

- Channel: `pi-atelier:sidebar-panels`, `SIDEBAR_PANEL_PROTOCOL_VERSION = 1` (`src/sidebar-panels.ts`).
- Public helper: `registerSidebarPanel(pi, panel, source)` → `{ update(), dispose() }`; also
  `createSidebarPanelRegistry({ events, onChange })` used by the extension itself.
- Contribution shape: `{ id: "<ns>:<id>", title, rows: (string | {text, role})[], keyValues?, role? }`.
- Bounds enforced by Atelier: 64 panels, 24 rows, 160 visible chars/row, 48 char title, roles from
  a fixed palette set; all text passes `sanitizeInline` (ANSI/control stripping).
- Order/visibility come only from `config.sidebarPanelLayout`; built-ins live in
  `BUILTIN_SIDEBAR_PANEL_IDS`, contributed panels keep their saved slot and stay hidden until
  enabled. Contributed rows are painted by Atelier with its own palette — no hardcoded ANSI.
- Rendering: `src/sidebar.ts` `builtinPanels`/contributed branch → `composeGroups` (height budget,
  `DROP_RANK`) → `renderGroups` → `panelRows` (border + title + width clipping).

## Goal X authoritative state (read-only)

- Goal records: `<goalsRoot>/active_goal_<ts>_<id>.md` — a JSON object followed by a markdown body;
  `parseGoalFile` in `storage/goal-files.ts` splits at the balanced JSON object end.
- `GoalRecord` (`goal-record.ts`): `id`, `objective`, `status` (`active|paused|blocked|budget_limited|complete`),
  `pauseReason`, `pauseSuggestedAction`, `autoContinue`, `usage{tokensUsed,activeSeconds}`,
  `currentTaskId`, `taskList{tasks,blockCompletion}`, `revision`, `tokenBudget`.
- `GoalTask` (`goal-record.ts`): `id`, `title`, `status` (`pending|complete|skipped`), `subtasks`,
  `evidence`, `verificationContract`, `completedAt`, `skippedAt`, `skipReason`.
- Focus: not a file — reconstructed from the ledger. `storage/goal-root.ts` resolves the root from
  `goalsRoot` / `PI_GOAL_ROOT`, and `.goal-ledger-checkpoint.json` carries `focusedGoalId`.
- Ledger: `<goalsRoot>/goal_events.jsonl`, one `GoalLedgerEvent` per line (`goal-ledger.ts`), including
  `goal_focused`, `goal_unfocused`, `task_started`, `task_complete`, `audit_started`,
  `audit_result{verdict,report}`, `audit_skipped`, `completion_requested`, `goal_completed`.

### Documented current-task fallback (mirrored, not re-invented)

`deriveCurrentTask()` in `widgets/goal-dashboard-model.ts`:

1. Use `currentTaskId` only when it references an **existing pending** task (top-level or nested).
2. Otherwise infer the first pending task in tree order and mark it `inferred`.
3. Progress counts **top-level** tasks where status is `complete` or `skipped`
   (`deriveTopLevelTaskProgress`).

### Auditor

- Live progress (`AuditorProgress`) is **in-memory only**; nothing intermediate is persisted.
- Persisted signals: `audit_started` (with provider/model/thinkingLevel), then
  `audit_result{verdict: approved|disapproved|error, report}` or `audit_skipped{reason}`.
- `widgets/auditor-dashboard-model.ts` derives the five check stages from live percentage bands
  (objective ≥20, verification ≥40, tasks ≥60, workspace ≥80, decision ≥80) — those bands are
  **stage-based estimates**, not measured check results.
- Verdict card derivation (`deriveAuditResultCard`) defines the canonical approved/error/findings copy.

## Decision

Option A — a read-only adapter in the Atelier fork:

- Reads the goal root (respecting `goalsRoot` / `PI_GOAL_ROOT` and session cwd), the focused goal
  record, and the ledger tail.
- Never writes Goal X files, never calls a model, never imports Goal X internals at runtime
  (its module graph is not a published API surface); parsing is stat-keyed and bounded.
- Refreshes on Pi lifecycle events plus a debounced `fs.watch` of the goals directory, with full
  cleanup on dispose.
- Because live auditor progress is not persisted, the panel reports only ledger-backed audit state
  and explicitly labels the gap instead of inventing percentages.

Option B (a Goal X event publisher) is therefore not needed and is left out of scope.

## Duplicate above-editor widget

`goal-state.ts` calls `ctx.ui.setWidget("goal", ..., { placement: "aboveEditor" })`. Goal X 0.34.1
(latest) exposes `hideUnfocusedBanner` for the *unfocused* banner only; there is no setting for the
focused-goal widget, and pi's widget keys are global with no cross-extension visibility API.
Clearing another extension's widget would strand Goal X's `widgetRegistered` flag and is exactly the
unsafe global patch the mission forbids. A minimal upstream patch is documented in
`docs/goalx/widget-suppression.md` instead of being applied silently.
