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
    from winpty import PtyProcess
except ImportError as exc:  # pragma: no cover - tooling-only dependency
    raise SystemExit("pywinpty is required: python -m pip install pywinpty") from exc

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]")
SIDEBAR_COLS = 46


def strip_ansi(raw: str) -> str:
    return ANSI.sub("", raw)


class Screen:
    """Collects PTY output in a background thread."""

    def __init__(self, proc):
        self.proc = proc
        self.buf: list[str] = []
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        while not self.stop.is_set() and self.proc.isalive():
            try:
                chunk = self.proc.read(65536)
            except Exception:
                break
            if chunk:
                self.buf.append(chunk)
            else:
                time.sleep(0.05)

    def wait(self, seconds: float) -> None:
        time.sleep(seconds)

    def take(self) -> str:
        raw = "".join(self.buf)
        self.buf.clear()
        return strip_ansi(raw)

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
    return Screen(proc)


def sidebar_column(text: str, width: int) -> list[str]:
    """Right-hand sidebar column of the last captured frame."""
    lines = text.split("\n")
    start = None
    for index, line in enumerate(lines):
        if "GOAL X" in line or "No goal focused" in line or "Goal X not detected" in line:
            start = max(0, index - 2)
    if start is None:
        start = max(0, len(lines) - 50)
    column = []
    for line in lines[start : start + 30]:
        column.append(line[max(0, width - SIDEBAR_COLS) : width].rstrip())
    return column


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
    parser.add_argument("--session", required=True)
    parser.add_argument("--goals", required=True)
    parser.add_argument("--atelier", required=True)
    parser.add_argument("--cwd", default=os.getcwd())
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
        json.dumps({"packages": ["npm:pi-goal-x", args.atelier], "theme": "dark"}), encoding="utf-8"
    )
    (agent / "pi-atelier.json").write_text(
        json.dumps({"preset": "goalfocus", "sidebarWidth": 32}), encoding="utf-8"
    )
    auth = Path.home() / ".pi/agent/auth.json"
    if auth.exists():
        shutil.copy2(auth, agent / "auth.json")
    session = work / "session.jsonl"
    shutil.copy2(args.session, session)

    env = dict(os.environ)
    env["PI_CODING_AGENT_DIR"] = str(agent)
    env["PI_GOAL_ROOT"] = str(goals)
    env.pop("NO_COLOR", None)

    focus_line = None
    for line in reversed(session.read_text(encoding="utf-8").splitlines()):
        if "pi-goal-focus" not in line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        data = entry.get("data")
        if isinstance(data, dict) and isinstance(data.get("focusedGoalId"), str):
            focus_line = data["focusedGoalId"]
            break
    if not focus_line:
        raise SystemExit("session copy has no pi-goal-focus entry")
    focused = focus_line
    path = goal_file(goals, focused)
    rewrite_goal(path, lambda r: r.update(status="paused", autoContinue=False))
    record = json.loads(path.read_text(encoding="utf-8").split("\n\n", 1)[0])
    if not record.get("taskList", {}).get("tasks"):
        raise SystemExit("focused goal has no task list to walk")

    frames: list[tuple[str, list[str]]] = []
    probes: dict[str, bool] = {}

    def expect(name: str, text: str, needles: list[str]) -> None:
        probes[name] = all(needle in text for needle in needles)
        if not probes[name]:
            missing = [needle for needle in needles if needle not in text]
            print(f"MISS {name}: {missing}")

    # 1-2: startup, focused goal, task change (same process).
    screen = spawn(env, args.cli, args.node, args.cwd, str(session), 150, 45)
    screen.wait(16)
    first = screen.take()
    frames.append(("01-focused-goal", sidebar_column(first, 150)))
    expect("focused goal", first, ["GOAL X", "PAUSED", "Progress"])

    def add_task(r):
        r["taskList"]["tasks"].append({"id": "live-task", "title": "Live scenario task", "status": "pending"})

    rewrite_goal(path, add_task)
    screen.wait(5)
    second = screen.take() or first
    frames.append(("02-task-change", sidebar_column(second, 150)))
    expect("task change", second, ["Progress", "live-task"])

    def complete_task(r):
        for task in r["taskList"]["tasks"]:
            if task["id"] == "live-task":
                task["status"] = "complete"

    rewrite_goal(path, complete_task)
    screen.wait(5)
    second_b = screen.take() or second
    frames.append(("02b-task-completed", sidebar_column(second_b, 150)))
    expect("task completed", second_b, ["Progress"])

    append_event(goals, {"type": "audit_started", "goalId": focused, "at": "2026-01-01T00:00:00.000Z"})
    screen.wait(5)
    third = screen.take()
    frames.append(("03-audit-running", sidebar_column(third or first, 150)))
    expect("audit running", third or first, ["AUDITOR", "PENDING"])

    append_event(goals, {"type": "audit_result", "goalId": focused, "verdict": "approved",
                         "report": "<approved/>", "at": "2026-01-01T00:01:00.000Z"})
    screen.wait(5)
    fourth = screen.take()
    frames.append(("04-approved", sidebar_column(fourth or first, 150)))
    expect("approved", fourth or first, ["APPROVED"])

    append_event(goals, {"type": "audit_result", "goalId": focused, "verdict": "disapproved",
                         "report": "- replay invariant missing", "at": "2026-01-01T00:02:00.000Z"})
    screen.wait(5)
    fifth = screen.take()
    frames.append(("05-changes-requested", sidebar_column(fifth or first, 150)))
    expect("changes requested", fifth or first, ["CHANGES NEEDED"])
    screen.close()

    # 6: goal switch — focus a second goal in a fresh process.
    second_goal = "live-goal-b"
    template = json.loads(path.read_text(encoding="utf-8").split("\n\n", 1)[0])
    template.update(id=second_goal, objective="Second live goal", status="paused", autoContinue=False)
    (goals / f"active_goal_2026010100000000_{second_goal}.md").write_text(json.dumps(template), encoding="utf-8")
    append_focus(session, second_goal)
    screen = spawn(env, args.cli, args.node, args.cwd, str(session), 150, 45)
    screen.wait(16)
    sixth = screen.take()
    frames.append(("06-goal-switch", sidebar_column(sixth, 150)))
    expect("goal switch", sixth, ["Second live goal"])
    screen.close()

    # 7: session reload — same process inputs again.
    screen = spawn(env, args.cli, args.node, args.cwd, str(session), 150, 45)
    screen.wait(16)
    seventh = screen.take()
    frames.append(("07-session-reload", sidebar_column(seventh, 150)))
    expect("session reload", seventh, ["Second live goal"])
    screen.close()

    # 8: resize — narrow and short terminals.
    for width, height, label in ((100, 30, "08-resize-100x30"), (120, 40, "09-resize-120x40")):
        screen = spawn(env, args.cli, args.node, args.cwd, str(session), width, height)
        screen.wait(16)
        eighth = screen.take()
        frames.append((label, sidebar_column(eighth, width)))
        expect(label, eighth, ["GOAL X"])
        screen.close()

    for name, lines in frames:
        (out / f"{name}.txt").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
        render_png(lines, out / f"{name}.png", f"live Pi 1.4.0 TUI · {name}")

    with open(out / "results.json", "w", encoding="utf-8", newline="\n") as handle:
        json.dump(probes, handle, indent=2)
    for name, ok in probes.items():
        print(f"{'PASS' if ok else 'FAIL'} {name}")
    return 0 if all(probes.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
