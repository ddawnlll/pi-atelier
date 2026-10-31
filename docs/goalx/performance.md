# Performance notes and measurements

## Measured

`npm run bench:sidebar` (Node v26.5.0, win32/x64, width 40, height 40, 3 warmups, 10 samples;
median ms to render the sidebar):

| Panels | Baseline (`upstream/main` 93025f2) | This branch | Delta |
|---|---|---|---|
| 0 | 1.5881 ms | 1.0779 ms | −0.51 ms |
| 8 | 1.2138 ms | 0.7237 ms | −0.49 ms |
| 64 | 1.4496 ms | 1.2382 ms | −0.21 ms |

The benchmark renders Atelier's own panel set, which this branch does not change, so the delta is
run-to-run variance rather than a speed-up. The relevant result is that adding the Goal X panel
costs **nothing measurable**: no new work is added to the render path.

Raw data: `.bench-records/baseline-sidebar.json`, `.bench-records/after-sidebar.json`.

## Render-path discipline

- Goal X data is read through `createGoalXReader`, which memoizes by `(mtime, size)` of the ledger
  and the ledger checkpoint. A repeated `view()` costs two `stat` calls and no parsing.
- The panel is rebuilt only when a render is *already* being requested
  (`requestAllRenders` and the reader's debounced `fs.watch` callback). There is no timer in the
  render path and no polling loop; the watcher timer is `unref`'d and cleared on dispose.
- `SidebarPanelRegistry.register` compares contributions and returns without calling `onChange`
  when the content is identical, so an unchanged view cannot schedule another render.
- The ledger read is bounded (512 KiB tail, configurable) and only parsed on stamp change.
- One `readdir` per refresh counts open goals; the focused record is read by exact name, never by
  scanning every goal file.
- No model requests, no prompt injection, no new runtime dependency.
