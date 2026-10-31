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
`EPERM` unless Developer Mode is on. The numbers above were produced by applying a two-line
junction fallback to `scripts/lib/source-sandbox.mjs` for the run only and then restoring the file, so
no upstream tooling file is modified in the branch. To reproduce on Windows, apply the same
temporary change, or run the benchmark under WSL/Developer Mode.

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
- One `readdir` per refresh lists the goal files, once to count open goals and once to locate the
  focused record by parsing candidates until the id matches (the record name includes the id, but
  the directory is still listed). No goal *content* is read for goals that are not focused: the
  scan stops at the first id match and the parse cache is keyed by `(mtime, size)`.
- No model requests, no prompt injection, no new runtime dependency.
