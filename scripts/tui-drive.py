#!/usr/bin/env python3
"""
Drive the front door inside a real pseudo-terminal (RFA-0.7 sect. 13.7).

The unit tests render components headless; this is the other half: `rfa` in an
actual pty, keys sent on a schedule, the painted screen read back. It found the
bug no headless test could (a select that only fired on CHANGE left the
onboarding stuck on its own default). Python's stdlib has a pty; Node's does
not, which is why the one non-TypeScript file in scripts/ is this one.

  python3 scripts/tui-drive.py --smoke        both scenarios against temp directories, exit 1 on a miss
  python3 scripts/tui-drive.py <dir> dashboard '[[1500,"2"],[600,"q"]]'
  python3 scripts/tui-drive.py <dir> init '[[1500,"<CR>"],...]'

Keys are JSON pairs of [delay_ms, text]; <CR>, <ESC> and <C-c> stand for the
control bytes. The CLI runs from this checkout through tsx.
"""
import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, "src", "cli", "main.ts")
TSX = subprocess.check_output(["node", "-p", 'require.resolve("tsx",{paths:[process.argv[1]]})', ROOT], text=True).strip()
COLS, ROWS = 120, 38


def drive(target, script, keys, extra_args=(), tail=60, quiet=False, env=None):
    argv = ["node", "--import", TSX, CLI, "--dir", target] + list(script) + list(extra_args)
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLUMNS"] = str(COLS)
        os.environ["LINES"] = str(ROWS)
        os.environ.update(env or {})
        os.execvp(argv[0], argv)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    out = b""
    t0 = time.time()
    i = 0
    due = t0 + keys[0][0] / 1000 if keys else None
    deadline = t0 + sum(k[0] for k in keys) / 1000 + 6
    alive = True
    while time.time() < deadline and alive:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                chunk = os.read(fd, 65536)
                if not chunk:
                    alive = False
                out += chunk
            except OSError:
                alive = False
        if due and time.time() >= due:
            k = keys[i][1]
            if k.startswith("<RESIZE:"):
                # "<RESIZE:cols,rows>": change the pty's window and tell the child, as a terminal would.
                c, r = k[len("<RESIZE:"):-1].split(",")
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(r), int(c), 0, 0))
                os.kill(pid, signal.SIGWINCH)
            else:
                k = k.replace("<ESC>", "\x1b").replace("<CR>", "\r").replace("<C-c>", "\x03")
                os.write(fd, k.encode())
            i += 1
            due = time.time() + keys[i][0] / 1000 if i < len(keys) else None
        try:
            wpid, _ = os.waitpid(pid, os.WNOHANG)
            if wpid == pid:
                alive = False
        except ChildProcessError:
            alive = False
    try:
        os.kill(pid, signal.SIGKILL)
    except Exception:
        pass
    text = out.decode("utf8", "replace")
    plain = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", text)
    plain = re.sub(r"\x1b\][^\x07]*\x07", "", plain)
    plain = re.sub(r"\x1b[()][A-Z0-9]", "", plain)
    lines = [l.rstrip() for l in plain.split("\n") if l.strip()]
    if not quiet:
        print(f"bytes={len(out)} nonblank_lines={len(lines)} exited={'yes' if not alive else 'killed'}")
        print("--- tail of what was painted ---")
        print("\n".join(lines[-tail:]))
    return plain


def headless(target, *args):
    return subprocess.run(["node", "--import", TSX, CLI, "--dir", target, *args], capture_output=True, text=True, timeout=120)


def free_port():
    import socket

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def smoke():
    failures = []
    base = tempfile.mkdtemp(prefix="rfa-tui-smoke-")
    try:
        # 1. the dashboard over a provisioned directory with nothing running
        d = os.path.join(base, "dash")
        os.makedirs(d)
        r = headless(d, "init", "--yes", "--no-start", "--name", "smoke", "--port", str(free_port()), "--human", "paul", "--agent", "spec-expert", "--room", "protocol", "--json")
        if r.returncode != 0:
            failures.append(f"headless init failed: {r.stderr[-400:]}")
        painted = drive(d, ["dashboard"], [[1800, "2"], [600, "3"], [600, "4"], [600, "5"], [600, "6"], [900, "7"], [1500, "1"], [600, "?"], [600, " "], [600, "a"], [900, "<ESC>"], [600, ":"], [700, "agent re"], [900, "<ESC>"], [800, "<RESIZE:160,50>"], [1200, "<RESIZE:80,30>"], [1200, "q"]], quiet=True)
        # `spec-expert-01`, the scaffolded pack's OWN eval case, was on this list
        # until 2026-08-30. It has not painted since 177a56d (2026-08-23) made
        # every scaffolded case ship inert as `case.yaml.example`, and case
        # discovery reads `case.yaml` only (src/evals/runner.ts), so the tab is
        # right and the assertion was stale. It had been red for a week.
        for want in ["1 Overview", "2 Agents", "3 Rooms", "4 Approvals", "5 Feed", "6 Evals", "spec-expert", "protocol", "not running · press u", "keys", "runs: rfa agent reflect <name>", "pending approvals", "feed ·", "review queue", "no observability store yet", "the gate", "7 Tasks", "tasks · protocol", "no tasks in protocol yet", "ask · protocol"]:
            if want not in painted:
                failures.append(f"dashboard never painted: {want!r}")
        borders = [len(l.rstrip()) for l in painted.split("\n") if "╭" in l]
        if not any(w >= 150 for w in borders):
            failures.append("dashboard did not widen to the 160-column terminal")
        if not any(w <= 80 for w in borders[-12:]):
            failures.append("dashboard did not narrow to the 80-column terminal")
        # the walkthrough: the describe-first intake (a dummy key makes the screen
        # deterministic on any machine; a BLANK submit spends nothing and falls
        # through to the questions), then an answerer with every default,
        # knowledge later, bound to the room
        smoke_key = {"ANTHROPIC_API_KEY": "tui-smoke-dummy"}
        painted = drive(d, ["agent", "new"], [[1800, "<CR>"], [700, "helper"], [400, "<CR>"], [900, "<CR>"], [900, "j"], [300, "j"], [400, "<CR>"], [900, "<CR>"], [900, "<CR>"], [600, "<CR>"], [900, "<CR>"], [600, "<CR>"], [600, "<CR>"], [900, "<CR>"], [900, "<CR>"], [2500, "<CR>"]], quiet=True, env=smoke_key)
        for want in ["Describe the agent", "Name the agent", "What kind of agent?", "What does it answer from?", "Which model?", "The capability it advertises", "Budgets", "Which room does it serve in?", "Create it?", "agent.md", "helper is ready"]:
            if want not in painted:
                failures.append(f"walkthrough never painted: {want!r}")
        if not os.path.exists(os.path.join(d, "agents", "helper", "agent.md")):
            failures.append("walkthrough did not write agents/helper/agent.md")
        # F9 pinned: a bare NAME on a terminal enters the walkthrough with the
        # name pre-filled instead of scaffolding silently with defaults
        painted = drive(d, ["agent", "new", "helper2"], [[1800, "<CR>"], [700, "<CR>"], [900, "<C-c>"]], quiet=True, env=smoke_key)
        for want in ["name: helper2", "Name the agent", "What kind of agent?"]:
            if want not in painted:
                failures.append(f"bare-name walkthrough never painted: {want!r}")
        if os.path.exists(os.path.join(d, "agents", "helper2")):
            failures.append("a bare name on a terminal scaffolded silently (F9 regressed)")
        # the edit walkthrough over the pack just made: the settings list, the model changed, applied
        painted = drive(d, ["agent", "edit", "helper"], [[1800, "j"], [400, "<CR>"], [900, "j"], [400, "<CR>"], [900, "<CR>"], [2500, "<CR>"]], quiet=True)
        for want in ["edit helper", "What do you want to change?", "Which model?", "1 pending", "apply 1 change", "haiku → sonnet", "helper edited"]:
            if want not in painted:
                failures.append(f"edit walkthrough never painted: {want!r}")
        with open(os.path.join(d, "agents", "helper", "agent.md")) as f:
            if "model: sonnet" not in f.read():
                failures.append("edit walkthrough did not write model: sonnet")
        # 2. the onboarding with every default and 'not yet' for the start
        o = os.path.join(base, "onboard")
        os.makedirs(o)
        painted = drive(o, ["init"], [[1800, "<CR>"], [2500, "<CR>"], [900, "<CR>"], [900, "<CR>"], [900, "<CR>"], [900, "<CR>"], [900, "<CR>"], [900, "<CR>"], [900, "<CR>"], [900, "j"], [500, "<CR>"], [7000, "q"]], extra_args=["--port", str(free_port())], quiet=True)
        for want in ["Rooms for Agents", "This machine is ready", "better-sqlite3 opens a database", "Run a hub here", "Name this hub", "Your name", "Your first agent?", "A room for it", "Start the hub and the supervisor now?", "rfa.json", "human principal", "your hub directory is ready", "Your human key, shown once"]:
            if want not in painted:
                failures.append(f"onboarding never painted: {want!r}")
        for f in ["rfa.json", ".rfa/secrets.json", ".rfa/rooms.json", "agents/spec-expert/agent.md", "policies/gate.json", "evals/rubric.md", "evals/cases/protocol-ask-cycle/case.yaml"]:
            if not os.path.exists(os.path.join(o, f)):
                failures.append(f"onboarding did not write {f}")
    finally:
        shutil.rmtree(base, ignore_errors=True)
    if failures:
        print("TUI SMOKE FAIL")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("TUI SMOKE PASS: dashboard (7 tabs, help, palette, two resizes), the walkthroughs (describe-first intake skipped onto an answerer end to end, a bare name pre-filling the questions instead of scaffolding, then the model edited) and the onboarding (checks, defaults, provisioning, done screen) painted what they should")
    return 0


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--smoke":
        sys.exit(smoke())
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(2)
    target, script, keys = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
    extra = sys.argv[4:]
    drive(target, [script] if script != "bare" else [], keys, extra_args=extra)
