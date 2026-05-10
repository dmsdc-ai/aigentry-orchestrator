#!/usr/bin/env python3
"""
session-layout.py — Arrange telepty sessions in a centered grid layout.

The orchestrator session is always placed at the center of the grid.
All sessions get equal screen area. Rows and columns are balanced.
Uses System Events AppleScript for window positioning on macOS.
"""

import json
import math
import subprocess
import sys
import re


def run(cmd, **kwargs):
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def get_screen_bounds():
    """Get usable screen area (excluding menu bar)."""
    r = run(["osascript", "-e",
             'tell application "Finder" to get bounds of window of desktop'])
    if r.returncode != 0:
        return (0, 25, 1800, 1169)
    parts = [int(x.strip()) for x in r.stdout.strip().split(",")]
    return (parts[0], parts[1] + 25, parts[2], parts[3])


def get_telepty_sessions():
    """Get active telepty session IDs."""
    r = run(["telepty", "list"])
    if r.returncode != 0:
        print("Error: telepty daemon not running", file=sys.stderr)
        sys.exit(1)

    sessions = []
    for line in r.stdout.splitlines():
        m = re.search(r"ID:\s*\x1b\[36m(\S+)\x1b\[0m", line)
        if not m:
            m = re.search(r"ID:\s*(\S+)", line)
        if m:
            sessions.append(m.group(1))
    return sessions


def get_kitty_window_names():
    """Get kitty window names via System Events, mapped to session IDs."""
    r = run(["osascript", "-e", '''
        tell application "System Events"
            tell process "kitty"
                set winNames to {}
                repeat with w in windows
                    set end of winNames to name of w
                end repeat
            end tell
        end tell
        return winNames
    '''])
    if r.returncode != 0:
        print("Error: cannot get kitty windows via System Events", file=sys.stderr)
        sys.exit(1)

    names = [n.strip() for n in r.stdout.strip().split(",")]

    # Map: session_id -> System Events window index (1-based)
    win_map = {}
    for idx, name in enumerate(names):
        # Match session ID from window title like "⚡ aigentry-xxx-claude | ..."
        # or "⚡ telepty :: aigentry-xxx-claude | ..."
        for pattern in [r"telepty\s*::\s*(\S+-claude)", r"⚡\s*(\S+-claude)"]:
            m = re.search(pattern, name)
            if m:
                sid = m.group(1)
                if sid not in win_map:
                    win_map[sid] = idx + 1  # 1-based index for AppleScript
                break

    return win_map, names


def calculate_grid(n):
    """Calculate optimal rows x cols for n items, preferring wider layouts."""
    if n <= 1:
        return 1, 1
    if n <= 2:
        return 1, 2
    if n <= 3:
        return 1, 3
    if n <= 4:
        return 2, 2

    cols = math.ceil(math.sqrt(n))
    rows = math.ceil(n / cols)

    if rows > cols:
        rows, cols = cols, rows

    return rows, cols


def find_center_index(rows, cols):
    """Find the center cell index in a rows x cols grid."""
    center_row = rows // 2
    center_col = cols // 2
    return center_row * cols + center_col


def arrange_sessions(sessions, orchestrator_id):
    """Order sessions so orchestrator is at the center of the grid."""
    n = len(sessions)
    rows, cols = calculate_grid(n)
    center_idx = find_center_index(rows, cols)

    others = [s for s in sessions if s != orchestrator_id]

    ordered = []
    orch_placed = False
    other_idx = 0

    for i in range(rows * cols):
        if i == center_idx and not orch_placed:
            ordered.append(orchestrator_id)
            orch_placed = True
        elif other_idx < len(others):
            ordered.append(others[other_idx])
            other_idx += 1
        else:
            ordered.append(None)

    if not orch_placed:
        ordered[center_idx] = orchestrator_id

    return ordered, rows, cols


def position_windows(ordered, rows, cols, win_map):
    """Position kitty windows using System Events AppleScript."""
    x0, y0, screen_w, screen_h = get_screen_bounds()
    usable_w = screen_w - x0
    usable_h = screen_h - y0

    cell_w = usable_w // cols
    cell_h = usable_h // rows

    gap = 2

    positioned = 0
    skipped = []

    for i, session_id in enumerate(ordered):
        if session_id is None:
            continue

        win_idx = win_map.get(session_id)
        if win_idx is None:
            skipped.append(session_id)
            continue

        row = i // cols
        col = i % cols

        wx = x0 + col * cell_w + gap
        wy = y0 + row * cell_h + gap
        ww = cell_w - gap * 2
        wh = cell_h - gap * 2

        applescript = f'''
            tell application "System Events"
                tell process "kitty"
                    set position of window {win_idx} to {{{wx}, {wy}}}
                    set size of window {win_idx} to {{{ww}, {wh}}}
                end tell
            end tell
        '''

        r = run(["osascript", "-e", applescript])
        if r.returncode == 0:
            positioned += 1
            print(f"  [{session_id.replace('aigentry-','').replace('-claude','')}] → row={row} col={col} pos=({wx},{wy}) size=({ww}x{wh})")
        else:
            skipped.append(session_id)
            print(f"  FAILED: {session_id} (win_idx={win_idx}): {r.stderr.strip()}")

    return positioned, skipped


def main():
    orchestrator_id = "aigentry-orchestrator-claude"
    for arg in sys.argv[1:]:
        if arg.startswith("--orchestrator="):
            orchestrator_id = arg.split("=", 1)[1]
        elif arg == "--help":
            print("Usage: session-layout.py [--orchestrator=<session-id>]")
            print("  Arranges telepty sessions in a grid with orchestrator at center.")
            sys.exit(0)

    # 1. Get sessions
    sessions = get_telepty_sessions()
    if not sessions:
        print("No active telepty sessions found.")
        sys.exit(1)

    print(f"Found {len(sessions)} sessions")

    if orchestrator_id not in sessions:
        print(f"Warning: orchestrator '{orchestrator_id}' not in session list")
        orchestrator_id = sessions[0]

    # 2. Get kitty windows via System Events
    win_map, win_names = get_kitty_window_names()
    print(f"Mapped {len(win_map)} sessions to kitty windows (total kitty windows: {len(win_names)})")

    # 3. Calculate layout — use only sessions that have a kitty window
    mapped_sessions = [s for s in sessions if s in win_map]
    if orchestrator_id not in mapped_sessions and orchestrator_id in sessions:
        print(f"Warning: orchestrator has no kitty window")
    ordered, rows, cols = arrange_sessions(mapped_sessions, orchestrator_id)
    print(f"Grid: {rows}x{cols} (center: {orchestrator_id})")

    # 4. Position
    print(f"\nPositioning:")
    positioned, skipped = position_windows(ordered, rows, cols, win_map)
    print(f"\nPositioned: {positioned} windows")

    if skipped:
        print(f"Skipped: {', '.join(skipped)}")

    # 5. Print layout map
    print(f"\nLayout ({rows}x{cols}):")
    for r in range(rows):
        row_items = []
        for c in range(cols):
            idx = r * cols + c
            sid = ordered[idx] if idx < len(ordered) else None
            if sid == orchestrator_id:
                row_items.append(f"[*{sid.replace('aigentry-','').replace('-claude','')}*]")
            elif sid:
                row_items.append(f"[{sid.replace('aigentry-','').replace('-claude','')}]")
            else:
                row_items.append("[      ]")
        print("  " + "  ".join(row_items))


if __name__ == "__main__":
    main()
