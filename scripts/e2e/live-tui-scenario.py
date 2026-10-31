#!/usr/bin/env python
"""Live TUI scenario walk for the Pi Atelier x Pi Goal X integration.

Runs the installed Pi in a real sized ConPTY (pywinpty), with an isolated agent
directory that loads pi-goal-x plus this Atelier fork, a read-only COPY of a real
session (so session focus resolves), and PI_GOAL_ROOT pointed at a COPY of the
goal root where the focused goal is paused. Nothing real is written: only the
copies are edited, and only between captures.

Walks: startup -> task change -> audit started -> approved -> rejected ->
goal switch -> session reload -> resize, saving one text frame per step plus a
PNG rendering of each frame.

Usage:
  python scripts/e2e/live-tui-scenario.py --out docs/goalx/live-scenario \
      --session <session.jsonl> --goals <goal-root> --atelier <installed fork>
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import threading
import time
from pathlib import Path

try:
    import pyte
    from winpty import PtyProcess
except ImportError as exc:  # pragma: no cover - tooling-only dependencies
    raise SystemExit(
        "pywinpty and pyte are required: python -m pip install pywinpty pyte"
    ) from exc

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]")
SIDEBAR_COLS = 46


def strip_ansi(raw: str) -> str:
    return ANSI.sub("", raw)


class Screen:
    """Feeds the PTY stream through a terminal emulator and exposes the current screen.

    Reading the byte stream directly is unreliable for a diffing TUI: incremental repaints are not
    line-ordered, so slicing the stream can mix old and new frames. pyte keeps a real screen grid,
    which is what the user sees.
    """

    def __init__(self, proc, width: int, height: int):
        self.proc = proc
        self.screen = pyte.Screen(width, height)
        self.stream = pyte.Stream(self.screen)
        self.raw: list[str] = []
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        while not self.stop.is_set() and self.proc.isalive():
            try:
                chunk = self.proc.read(65536)
            except Exception:
                break
            if not chunk:
                time.sleep(0.05)
                continue
            self.raw.append(chunk)
            try:
                self.stream.feed(chunk)
            except Exception:
                pass

    def wait(self, seconds: float) -> None:
        time.sleep(seconds)

    def take(self) -> str:
        """Current rendered screen (no ANSI; one string per row)."""
        rows = list(self.screen.display)
        self.raw.clear()
        return "\n".join(row.rstrip() for row in rows)

    def close(self):
        self.stop.set()
        try:
            self.proc.terminate(force=True)
        except Exception:
            pass
        self.thread.join(timeout=3)


def spawn(env, cli, node, cwd, session, width, height):
    proc = PtyProcess.spawn(
        [node, cli, "--offline", "--session", session, "--tui-mode", "regular",
         "--model", "deepseek-v4.1-flash"],
        dimensions=(height, width), cwd=cwd, env=env,
    )
    return Screen(proc, width, height)


def sidebar_block(text: str) -> list[str]:
    """Extracts Atelier's GOAL X panel by its own border, not by a fixed offset.

    Returns [] when the panel is not on screen, so a probe can never be satisfied by
    transcript text that merely mentions the panel.
    """
    lines = text.split("\n")
    starts = [i for i, line in enumerate(lines) if "╭" in line and "GOAL X" in line]
    if not starts:
        return []
    start = starts[-1]
    border = lines[start].index("╭")
    block: list[str] = []
    for line in lines[start : start + 40]:
        if not line.strip():
            if block:
                break
            continue
        block.append(line[border:].rstrip())
        if "╰" in line[border:]:
            break
    return block


def sidebar_column(text: str) -> list[str]:
    """Kept for callers that only need the panel body."""
    return sidebar_block(text)


def render_png(lines: list[str], path: Path, title: str) -> None:
    from PIL import Image, ImageDraw, ImageFont

    font = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 14)
    line_height, pad = 19, 16
    width = 16 + max((len(line) for line in lines), default=40) * 9
    height = pad * 2 + line_height * (len(lines) + 2)
    image = Image.new("RGB", (max(420, width), height), (11, 14, 21))
    draw = ImageDraw.Draw(image)
    draw.text((pad, pad), title, fill=(107, 200, 237), font=font)
    for index, line in enumerate(lines):
        draw.text((pad, pad + line_height * (index + 1)), line, fill=(214, 220, 233), font=font)
    path.write_bytes(b"")
    image.save(path)


def goal_file(root: Path, goal_id: str) -> Path:
    matches = [Path(p) for p in glob.glob(str(root / "active_goal_*.md")) if goal_id in p]
    if not matches:
        raise SystemExit(f"no active goal file for {goal_id}")
    return matches[0]


def rewrite_goal(path: Path, mutate) -> None:
    record = json.loads(path.read_text(encoding="utf-8").split("\n\n", 1)[0])
    mutate(record)
    path.write_text(json.dumps(record), encoding="utf-8", newline="\n")


def append_event(root: Path, event: dict) -> None:
    with open(root / "goal_events.jsonl", "a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(event) + "\n")


def append_focus(session: Path, goal_id: str) -> None:
    """Appends a focus entry as the new leaf of the session tree."""
    last_id = None
    for line in reversed(session.read_text(encoding="utf-8").splitlines()):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(entry.get("id"), str):
            last_id = entry["id"]
            break
    entry = {
        "type": "custom",
        "customType": "pi-goal-focus",
        "data": {"version": 1, "focusedGoalId": goal_id, "reason": "selected"},
        "id": f"live-focus-{goal_id}",
        **({"parentId": last_id} if last_id else {}),
        "timestamp": "2026-01-01T00:00:00.000Z",
    }
    with open(session, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(entry) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--session", default=None, help="real session jsonl (a copy is used)")
    parser.add_argument("--goals", default=None, help="goal root (copied; only the copy is edited)")
    parser.add_argument("--atelier", default=None, help="this checkout; defaults to the repo root")
    parser.add_argument("--cwd", default=None, help="session cwd (defaults to the session header)")
    parser.add_argument("--node", default=shutil.which("node") or "node")
    parser.add_argument("--cli", default=None)
    args = parser.parse_args()

    if not args.cli:
        candidates = [
            Path(shutil.which("node") or "").parent
            / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
            Path(shutil.which("pi") or "").parent
            / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
        ]
        found = next((path for path in candidates if path.exists()), None)
        if found is None:
            raise SystemExit("cannot locate the Pi CLI; pass --cli <cli.js>")
        args.cli = str(found)

    repo_root = Path(__file__).resolve().parents[2]
    if not args.atelier:
        args.atelier = str(repo_root)
    atelier = Path(args.atelier)
    if not (atelier / "package.json").exists():
        # Accept a git package spec by resolving where pi keeps git packages.
        spec = args.atelier.removeprefix("git:").removeprefix("https://").removeprefix("http://")
        spec = spec.split("@")[0].rstrip("/")
        candidate = Path.home() / ".pi/agent/git" / spec
        if (candidate / "package.json").exists():
            atelier = candidate
        else:
            raise SystemExit(f"cannot resolve --atelier {args.atelier!r}; pass the checkout path")
    if not args.session:
        sessions = sorted(
            Path.home().glob(".pi/agent/sessions/**/*.jsonl"), key=lambda item: item.stat().st_mtime
        )
        if not sessions:
            raise SystemExit("no session file found; pass --session")
        args.session = str(sessions[-1])
    session_cwd = None
    try:
        header = json.loads(Path(args.session).read_text(encoding="utf-8").splitlines()[0])
        if isinstance(header.get("cwd"), str):
            session_cwd = header["cwd"]
    except Exception:
        session_cwd = None
    if session_cwd and not args.cwd:
        args.cwd = session_cwd
    if not args.goals:
        # The session's recorded cwd owns the goal root; fall back to the process cwd, then the checkout.
        candidates = []
        if session_cwd:
            candidates.append(Path(session_cwd) / ".pi/goals")
        candidates += [Path(args.cwd) / ".pi/goals", Path.cwd() / ".pi/goals", repo_root / ".pi/goals"]
        found = next((c for c in candidates if c.exists()), None)
        if found is None:
            raise SystemExit("no goal root found; pass --goals")
        args.goals = str(found)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    work = out / ".work"
    if work.exists():
        shutil.rmtree(work)
    goals = work / "goals"
    agent = work / "agent"
    shutil.copytree(args.goals, goals)
    agent.mkdir(parents=True)
    (agent / "settings.json").write_text(
        json.dumps({"packages": ["npm:pi-goal-x", str(atelier)], "theme": "dark"}), encoding="utf-8"
    )
    (agent / "pi-atelier.json").write_text(
        json.dumps({"preset": "goalfocus", "sidebarWidth": 32}), encoding="utf-8"
    )
    auth = Path.home() / ".pi/agent/auth.json"
    if auth.exists():
        shutil.copy2(auth, agent / "auth.json")
    session = work / "session.jsonl"
    shutil.copy2(args.session, session)

    if not args.cwd:
        args.cwd = os.getcwd()

    env = dict(os.environ)
    env["PI_CODING_AGENT_DIR"] = str(agent)
    env["PI_GOAL_ROOT"] = str(goals)
    env.pop("NO_COLOR", None)

    def write_goal(goal_id: str, objective: str, tasks: list[dict]) -> Path:
        record = {
            "version": 3,
            "id": goal_id,
            "objective": objective,
            "status": "paused",
            "autoContinue": False,
            "usage": {"tokensUsed": 10, "activeSeconds": 5},
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "taskList": {"tasks": tasks, "blockCompletion": True,
                         "proposedAt": "2026-01-01T00:00:00.000Z"},
        }
        target = goals / f"active_goal_2026010100000000_{goal_id}.md"
        target.write_text(json.dumps(record), encoding="utf-8", newline="\n")
        return target

    # Synthetic goals only: no real objective or record is reused.
    tasks_a = [
        {"id": "task-1", "title": "First task", "status": "complete"},
        {"id": "task-2", "title": "Second task", "status": "pending"},
    ]
    path_a = write_goal("live-goal-a", "Synthetic live goal", tasks_a)
    write_goal("live-goal-b", "Second live goal", [
        {"id": "task-1", "title": "B task", "status": "pending"},
    ])
    write_goal("live-goal-c", "Returned live goal", [
        {"id": "task-1", "title": "C task", "status": "pending"},
    ])
    append_focus(session, "live-goal-a")

    frames: list[tuple[str, list[str]]] = []
    probes: dict[str, bool] = {}

    def capture(name: str, text: str, needles: list[str], width: int = 150) -> str:
        block = sidebar_block(text)
        column = "\n".join(block)
        frames.append((name, block or ["<GOAL X panel not found>"]))
        ok = bool(block) and all(needle in column for needle in needles)
        probes[name] = ok
        if not ok:
            missing = [needle for needle in needles if needle not in column]
            print(f"MISS {name}: {missing}".encode("ascii", "backslashreplace").decode("ascii"))
        return column

    def update_goal(goal_path: Path, mutate) -> None:
        record = json.loads(goal_path.read_text(encoding="utf-8").split("\n\n", 1)[0])
        mutate(record)
        goal_path.write_text(json.dumps(record), encoding="utf-8", newline="\n")

    # 1: startup + focused synthetic goal.
    screen = spawn(env, args.cli, args.node, args.cwd, str(session), 150, 45)
    screen.wait(16)
    baseline = screen.take()
    capture("01-focused-goal", baseline, ["GOAL X", "PAUSED", "Synthetic live goal", "Progress 1/2"])

    # 2: task change (record only; Goal X would also append a task_started event).
    update_goal(path_a, lambda r: r["taskList"]["tasks"].append(
        {"id": "live-task", "title": "Live task", "status": "pending"}))
    append_event(goals, {"type": "task_started", "goalId": "live-goal-a", "taskId": "live-task",
                         "at": "2026-01-01T00:00:01.000Z"})
    screen.wait(6)
    capture("02-task-change", screen.take(), ["Live task", "Progress 1/3"])

    # 3: task completion.
    def complete(record):
        for task in record["taskList"]["tasks"]:
            if task["id"] == "live-task":
                task["status"] = "complete"

    update_goal(path_a, complete)
    append_event(goals, {"type": "task_complete", "goalId": "live-goal-a", "taskId": "live-task",
                         "evidence": "live scenario", "at": "2026-01-01T00:00:02.000Z"})
    screen.wait(6)
    capture("03-task-completed", screen.take(), ["Progress 2/3"])

    # 3b-3c: explicit vs inferred current task.
    def set_current(record):
        record["taskList"]["tasks"].append(
            {"id": "live-task-2", "title": "Focused task", "status": "pending"})
        record["currentTaskId"] = "live-task-2"

    update_goal(path_a, set_current)
    append_event(goals, {"type": "task_started", "goalId": "live-goal-a", "taskId": "live-task-2",
                         "at": "2026-01-01T00:00:02.500Z"})
    screen.wait(6)
    capture("03b-explicit-current-task", screen.take(), ["▶ live-task", "Focused task"])

    def clear_current(record):
        record.pop("currentTaskId", None)

    update_goal(path_a, clear_current)
    screen.wait(6)
    capture("03c-inferred-current-task", screen.take(), ["inferred focus"])

    # 4-6: audit lifecycle.
    append_event(goals, {"type": "audit_started", "goalId": "live-goal-a", "at": "2026-01-01T00:00:03.000Z"})
    screen.wait(6)
    capture("04-audit-running", screen.take(), ["AUDITOR", "PENDING", "Checks: not persisted"])

    append_event(goals, {"type": "audit_result", "goalId": "live-goal-a", "verdict": "approved",
                         "report": "<approved/>", "at": "2026-01-01T00:00:04.000Z"})
    screen.wait(6)
    capture("05-approved", screen.take(), ["APPROVED"])

    append_event(goals, {"type": "audit_result", "goalId": "live-goal-a", "verdict": "disapproved",
                         "report": "- replay invariant missing", "at": "2026-01-01T00:00:05.000Z"})
    screen.wait(6)
    capture("06-changes-requested", screen.take(), ["CHANGES NEEDED", "replay invariant"])
    screen.close()

    # 7: return to goal mode (no audit history for goal C).
    append_focus(session, "live-goal-c")
    screen = spawn(env, args.cli, args.node, args.cwd, str(session), 150, 45)
    screen.wait(16)
    column = capture("07-return-to-goal-mode", screen.take(), ["Returned live goal", "Progress"])
    probes["07-no-audit"] = "AUDIT" not in column
    screen.close()

    # 8: goal switch.
    append_focus(session, "live-goal-b")
    screen = spawn(env, args.cli, args.node, args.cwd, str(session), 150, 45)
    screen.wait(16)
    capture("08-goal-switch", screen.take(), ["Second live goal"])
    screen.close()

    # 9: session reload (same inputs again).
    screen = spawn(env, args.cli, args.node, args.cwd, str(session), 150, 45)
    screen.wait(16)
    capture("09-session-reload", screen.take(), ["Second live goal"])
    screen.close()

    # 10-11: resize.
    for width, height, label in ((100, 30, "10-resize-100x30"), (120, 40, "11-resize-120x40")):
        screen = spawn(env, args.cli, args.node, args.cwd, str(session), width, height)
        screen.wait(16)
        capture(label, screen.take(), ["GOAL X", "Second live goal"])
        screen.close()

    # Transition frames must actually differ, so a stale panel cannot pass.
    import hashlib

    digests = {name: hashlib.md5("\n".join(lines).encode()).hexdigest() for name, lines in frames}
    for older, newer in (("01-focused-goal", "02-task-change"), ("02-task-change", "03-task-completed"),
                         ("04-audit-running", "05-approved"), ("05-approved", "06-changes-requested")):
        probes[f"frame-differs:{older}->{newer}"] = digests[older] != digests[newer]
    for name in sorted(probes):
        if not probes[name]:
            print(f"FAIL {name}")

    for name, lines in frames:
        (out / f"{name}.txt").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
        render_png(lines, out / f"{name}.png", f"live Pi 1.4.0 TUI · {name}")

    with open(out / "results.json", "w", encoding="utf-8", newline="\n") as handle:
        json.dump(probes, handle, indent=2)
    for name, ok in probes.items():
        print(("PASS " if ok else "FAIL ") + name)
    return 0 if all(probes.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
