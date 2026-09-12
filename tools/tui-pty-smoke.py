#!/usr/bin/env python3
"""Offline source/compiled TUI PTY acceptance smoke (stdlib only).
Usage: python3 tools/tui-pty-smoke.py /absolute/path/to/scrubbed-fixture.db
Build first with make build. Does not touch installed binaries or launch agents.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = str(Path(sys.argv[1]).resolve())

def smoke(command):
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    def resize(cols, rows):
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    resize(120, 40)
    env = {**os.environ, 'TERM': 'xterm-256color', 'CUSAGE_REFRESH': 'off', 'NO_COLOR': '1', 'DEV': 'false'}
    proc = subprocess.Popen(command + ['--db', DB, '--no-color'], cwd=ROOT, env=env,
                            stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    captured = bytearray()
    def drain(until=None, timeout=5):
        start = len(captured)
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                captured.extend(data)
            if until and until in captured[start:]:
                return
            if not until and proc.poll() is not None:
                return
        if until and until not in captured[start:]:
            raise AssertionError(f'Missing {until!r}: {captured[-4000:]!r}')
    try:
        drain(b'Recent sessions')
        assert b'\x1b[?1049h' in captured, 'alternate screen was not entered'
        assert b'Daily output tokens' in captured
        os.write(master, b'2')
        drain(b'matching')
        os.write(master, b'\r')
        drain(b'Session Detail')
        os.write(master, b'\x1b')
        drain(b'matching')
        os.write(master, b'1')
        drain(b'Recent sessions')
        resize(80, 24)
        proc.send_signal(signal.SIGWINCH)
        drain(b'Panel 5/5')
        os.write(master, b'\t')
        drain(b'Panel 1/5')
        resize(60, 18)
        proc.send_signal(signal.SIGWINCH)
        drain(b'Resize to at least')
        resize(120, 40)
        proc.send_signal(signal.SIGWINCH)
        drain(b'Recent sessions')
        os.write(master, b'q')
        drain(timeout=3)
        assert proc.wait(timeout=3) == 0
        assert b'\x1b[?1049l' in captured, 'alternate screen was not restored'
        assert b'\x1b[?25h' in captured, 'cursor was not restored'
        restored = termios.tcgetattr(slave)
        assert restored == original, 'terminal mode was not restored'
        print(f'PASS {command[0]}: startup, navigation, resize, quit, alternate screen, cursor, termios')
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        os.close(master)
        os.close(slave)

smoke(['bun', 'src/tui.ts'])
smoke([str(ROOT / 'dist/cusage-tui')])
