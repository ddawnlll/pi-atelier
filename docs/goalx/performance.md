# Performance notes and measurements

## Measured

`npm run bench:sidebar` (Node v26.5.0, win32/x64, width 40, height 40, 3 warmups, 10 samples;
median ms to render the sidebar):

| Panels | Baseline (`upstream/main` 93025f2) | This branch |
|---|---|---|
| 0 | 1.0651 ms | 1.0609 ms |
| 8 | 0.7250 ms | 0.6829 ms |
| 64 | 0.9960 ms | 1.2363 ms |

Both runs used the same command (`npm run bench:sidebar`, which preloads the Windows junction shim)
against the same checkout, one via `--ref upstream/main`. The 0- and 8-panel cases are unchanged or
faster; the 64-panel case measured slower in this pair, and repeated runs on this machine varied by
more than that difference (an earlier `bench:sidebar:win` run measured 1.6491 / 0.9688 / 2.2758 ms
and an earlier pair 3.1619 / 1.8922 / 3.5070 ms), so treat all of these as noise-level parity
rather than a speed-up or a regression. The benchmark renders Atelier's own panel set and therefore
does **not** measure the Goal X panel; the panel's cost is bounded structurally instead (below).

Raw data: `docs/goalx/bench/baseline-sidebar.json`, `docs/goalx/bench/after-sidebar.json`.

Windows note: upstream's benchmark harness creates a directory symlink, which Windows rejects with
`EPERM` unless Developer Mode is on. This branch leaves `scripts/lib/source-sandbox.mjs` byte-identical
to upstream and ships `scripts/win-symlink-shim.mjs` instead. `npm run bench:sidebar` and
`npm run bench:workspace` preload that shim (it is inert off Windows and falls back to a junction
only on `EPERM`); `bench:sidebar:posix` / `bench:workspace:posix` run the unmodified commands.

## Render-path discipline

- Goal X data is read through `createGoalXReader`, which memoizes by the ledger's `(mtime, size)`
  plus the current session focus id. A repeated `view()` costs one `stat` plus a session-branch
  scan, and no file parsing.
- The panel is rebuilt only when a render is *already* being requested
  (`requestAllRenders` and the reader's debounced `fs.watch` callback). That is one stat round per
  render request, not per frame. There is no polling loop; the watcher timer is `unref`'d and
  cleared on dispose.
- `SidebarPanelRegistry.register` compares contributions and returns without calling `onChange`
  when the content is identical, so an unchanged view cannot schedule another render.
- The ledger read is bounded (512 KiB tail, configurable) and only parsed on stamp change.
## Cost of the Goal X panel itself

`npm run bench:goalx` renders the same 32x40 sidebar snapshot with and without the contributed panel
(5 warm-ups, 30 samples, same source sandbox):

| Scenario | Median |
|---|---|
| Default layout, no contribution | 0.8898 ms |
| Default layout + Goal X panel | 0.9228 ms |
| Goal-focused layout (panel + CONTEXT + WORKSPACE) | 0.664 ms |

Adding the panel costs about **0.033 ms per render**, and the goal-focused layout is faster than
the default layout because it renders eight fewer panels. Data: `docs/goalx/bench/goalx-panel.json`.

- The view is memoized on the ledger `(mtime, size)`, the session focus id and the focused record's
  own `(mtime, size)`. A goal-record edit alone therefore refreshes the panel: `tests/goalx.test.ts`
  proves progress moves from 1/2 to 2/3 with no ledger write.
- `loadFocusedGoal` lists the directory and reads + parses each active goal file until the id
  matches; there is **no per-file parse cache**. That cost is paid only when the stamp pair changes,
  not on every render.
- No model requests, no prompt injection, no new runtime dependency.
