# Performance notes and measurements

## Measured

`npm run bench:sidebar` (Node v26.5.0, win32/x64, width 40, height 40, 3 warmups, 10 samples;
median ms to render the sidebar):

| Panels | Baseline (`upstream/main` 93025f2) | This branch |
|---|---|---|
| 0 | 3.1619 ms | 2.4435 ms |
| 8 | 1.8922 ms | 1.7163 ms |
| 64 | 3.5070 ms | 3.6750 ms |

These are two runs on a busy Windows machine, so treat them as rough parity, not a speed-up. The
benchmark renders Atelier's own panel set and therefore does **not** measure the new Goal X panel;
the panel's cost is bounded structurally instead (below).

Raw data: `docs/goalx/bench/baseline-sidebar.json`, `docs/goalx/bench/after-sidebar.json`.

Windows note: upstream's benchmark harness creates a directory symlink, which Windows rejects with
`EPERM` unless Developer Mode is on. This branch leaves `scripts/lib/source-sandbox.mjs` byte-identical
to upstream and ships `scripts/win-symlink-shim.mjs` instead, preloaded by `npm run bench:sidebar:win`.
A run with that command recorded 1.6491 / 0.9688 / 2.2758 ms at 0/8/64 panels
(`docs/goalx/bench/after-sidebar-win.json`), consistent with `npm run bench:sidebar` elsewhere.

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
- One `readdir` per refresh counts open goals, and `loadFocusedGoal` lists the directory again and
  reads + parses each active goal file until the id matches; there is **no per-file parse cache**,
  only the whole-view `(ledger mtime, size)` stamp. The cost is one file read per goal until the
  focused record is reached, on a stamp change only.
- No model requests, no prompt injection, no new runtime dependency.
