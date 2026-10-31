# Installation record (this machine)

## Before

| Item | Value |
|---|---|
| Active Atelier | `https://github.com/michaelmjhhhh/pi-atelier`, git package at `~/.pi/agent/git/github.com/michaelmjhhhh/pi-atelier` |
| Version | 0.17.0 (`d4b76ad`) |
| Why it was not in the extension list | It is a **git** package in `settings.json` → `packages`; the generic `dist`/`extensions` entries are not Atelier |
| Goal X | `npm:pi-goal-x` 0.34.1 at `~/.pi/agent/npm/node_modules/pi-goal-x` |
| Backups | `~/.pi/agent/backups/pi-atelier-goalx-20261101-002945` (settings.json, npm package + lock, goal ledger checkpoint) and `pi-atelier-goalx-preinstall-20261101-004907` |

## After

| Item | Value |
|---|---|
| Active Atelier | `git:github.com/ddawnlll/pi-atelier@<pin>` → `~/.pi/agent/git/github.com/ddawnlll/pi-atelier` — read the pin from `pi list`; it always equals `git rev-parse HEAD` in the installed checkout |
| Instances | exactly one; the upstream git package was removed first |
| Other extensions | unchanged (`pi-observational-memory`, `@pi-plugins/speed`, `pi-goal-x`, `@tintinweb/pi-subagents`, `opensec-pi-todo`, `opensec-pi-fff`) |
| Preset | `~/.pi/agent/pi-atelier.json` → `{"preset":"goalfocus","sidebarWidth":32}` |
| Goal X detection | reads `~/.pi/goals` (real root) — verified read-only: available, 1 open goal, unfocused session correctly not auto-selected |

## Rollback (executed and verified)

```powershell
# The pin is the exact string `pi list` reports; read it, then use it verbatim.
$pin = ((pi list) | Select-String 'ddawnlll/pi-atelier@').ToString().Trim()
pi remove $pin
pi install https://github.com/michaelmjhhhh/pi-atelier
Remove-Item ~/.pi/agent/pi-atelier.json
```

This cycle was run in both directions: fork → upstream → fork. `pi list` reported the expected
single Atelier entry each time and all other packages stayed installed.

## Activation

The running Pi-Bolt session keeps the Atelier code it started with. The fork and the `goalfocus`
preset take effect on the **next safe Pi start**; no running agent or auditor was interrupted.

## Verification performed

- `pi list` resolves the fork from both `settings.json` and an isolated `PI_CODING_AGENT_DIR`.
- The installed checkout's `HEAD` equals the deployed pin and the branch head on GitHub
  (`gh api repos/ddawnlll/pi-atelier/commits/feat/pi-goal-x-integration --jq .sha`).
- The installed source is byte-identical to the commit whose tests, benchmark and end-to-end run
  are recorded in `performance.md` and `.bench-records/`.

## Not verified automatically

Interactive TUI rendering (colours, borders, live repaint) needs a terminal. The panel is verified
through Atelier's real `renderSidebarLines` at 24-60 columns in plain and coloured modes, and the
end-to-end scenario reproduces every Goal X lifecycle state, but no screenshot was captured.
