# Duplicate Goal X widget: options and decision

Goal X renders a compact task widget **above the editor** for the focused goal:

```ts
// pi-goal-x/extensions/goal-state.ts
ctx.ui.setWidget(GOAL_WIDGET_KEY, factory, { placement: "aboveEditor" });
```

## Why Atelier cannot hide it

- Goal X 0.34.1 is the latest published version and exposes `hideUnfocusedBanner` /
  `hideUnfocusedPrompt` for the **unfocused** banner only. No focused-widget toggle exists.
- Pi's `ctx.ui.setWidget(key, …)` keys are global, with no cross-extension visibility API. An
  extension that calls `setWidget("goal", undefined)` strands Goal X's `widgetRegistered` flag, so
  Goal X never re-registers and the widget only returns after a session reload. That is exactly the
  unsafe global patch the mission rules out.
- Deleting or disabling Goal X to hide the widget would also remove the scheduler, task recording
  and the independent auditor.

## Decision

**The original widget is retained by default.** Nothing in the Atelier fork intercepts it.

## Opt-in shim (separately reviewable, disabled by default)

`scripts/goalx-widget-hide.mjs` inserts one guard at each registration site:

```ts
if (!widgetRegistered && process.env.PI_GOAL_HIDE_COMPACT_WIDGET !== "1") {
```

- Default behaviour (variable unset) is unchanged.
- The script backs the file up as `goal-state.ts.atelier-original` before writing, refuses
  versions other than 0.34.x, and `--revert` restores the backup byte for byte.
- Because it edits an installed package, remember it after `pi update` / a Goal X upgrade; re-run
  `--check` to see whether the guard survived.

```powershell
node scripts/goalx-widget-hide.mjs --check
node scripts/goalx-widget-hide.mjs              # install the guard
$env:PI_GOAL_HIDE_COMPACT_WIDGET = "1"          # hide the widget for the next session
node scripts/goalx-widget-hide.mjs --revert     # remove the guard entirely
```

The expanded dashboard, `/goal-*` commands, auditing and scheduling are untouched either way.
