#!/usr/bin/env python3
"""Context7 reminder — shared detection + the Claude Code hook.

Enforces the AGENTS.md 'Documentation lookup' rule: when an edit introduces a
third-party import, remind the agent to pull real docs via the context7 skill
instead of writing an API from memory.

Run as a script it is the Claude Code PostToolUse hook (wired in the Claude
Code settings file): it reads the tool payload on stdin and returns the
reminder as hookSpecificOutput.additionalContext.

Imported as a module it is the detection half of other tools' plugins, which
reach in for ``libs_from_edit`` and ``REMINDER`` so every agent applies
identical rules. Keep it dependency-free and importable — a plugin may load it
by path.

Per-session state lives in ``context7-hook/`` under ``$AGENT_KIT_STATE``
(default ``~/.local/state/agent-kit``).
"""

import json
import os
import re
import sys
import time
from pathlib import Path

STATE_DIR = Path(os.environ.get("AGENT_KIT_STATE") or Path.home() / ".local" / "state" / "agent-kit") / "context7-hook"
STATE_TTL_SECONDS = 7 * 24 * 3600

PY_SUFFIXES = {".py", ".pyi"}
JS_SUFFIXES = {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".svelte", ".vue"}

PY_IMPORT = re.compile(r"^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import\b|import\s+([A-Za-z_][\w.]*))")
JS_IMPORT = re.compile(r"""(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]""")

# sys.stdlib_module_names exists from Python 3.10 only; older interpreters use
# the builtin names plus this list of common standard-library top-level modules.
_STDLIB_FALLBACK = frozenset(sys.builtin_module_names) | frozenset("""
abc argparse array ast asyncio atexit base64 bisect builtins bz2 calendar cgi cmd
codecs collections colorsys concurrent configparser contextlib contextvars copy
csv ctypes dataclasses datetime decimal difflib dis email encodings enum errno
faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt
getpass gettext glob graphlib gzip hashlib heapq hmac html http imaplib imp
importlib inspect io ipaddress itertools json keyword linecache locale logging
lzma mailbox math mimetypes mmap multiprocessing netrc numbers operator os
pathlib pdb pickle pkgutil platform plistlib poplib posixpath pprint profile
pstats pty pwd queue quopri random re readline reprlib resource runpy sched
secrets select selectors shelve shlex shutil signal site smtplib socket
socketserver sqlite3 ssl stat statistics string stringprep struct subprocess
symtable sys sysconfig syslog tarfile telnetlib tempfile termios textwrap
threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc
tty turtle types typing unicodedata unittest urllib uu uuid venv warnings wave
weakref webbrowser winreg xml xmlrpc zipapp zipfile zipimport zlib zoneinfo
""".split())
STDLIB = getattr(sys, "stdlib_module_names", None) or _STDLIB_FALLBACK

PY_EXTRA_SKIP = {"__future__", "typing_extensions", "setuptools", "pkg_resources"}
JS_SKIP_PREFIX = (".", "/", "#", "~", "node:", "bun:", "@/", "$")

REMINDER = (
    "This edit adds third-party imports ({libs}). Per AGENTS.md, consult current "
    "docs via the context7 skill before writing further against these APIs — do "
    "not write signatures from memory."
)


# --------------------------------------------------------------------------- detection

def is_test(path: str) -> bool:
    p = path.replace("\\", "/").lower()
    parts = p.split("/")
    name = parts[-1] if parts else ""
    return (
        any(seg in {"tests", "test", "__tests__", "spec", "e2e", "fixtures"} for seg in parts)
        or name.startswith(("test_", "conftest"))
        or re.search(r"\.(test|spec)\.[jt]sx?$", name) is not None
    )


def local_module(name: str, roots: list) -> bool:
    for root in roots:
        try:
            if (root / f"{name}.py").exists() or (root / name / "__init__.py").exists():
                return True
        except OSError:
            pass
    return False


def added_lines(tool_input: dict) -> str:
    """Text this call introduced: new content minus what was already there.

    Covers Claude Code (content / new_string / edits / new_source) and other tools
    (write_file -> content, patch -> old_string + new_string) in one pass.
    """
    chunks = []
    if content := tool_input.get("content"):
        chunks.append(str(content))
    if new := tool_input.get("new_string"):
        old = set(str(tool_input.get("old_string") or "").splitlines())
        chunks.extend(l for l in str(new).splitlines() if l not in old)
    if new_src := tool_input.get("new_source"):
        chunks.append(str(new_src))
    for edit in tool_input.get("edits") or []:
        if not isinstance(edit, dict):
            continue
        old = set(str(edit.get("old_string") or "").splitlines())
        chunks.extend(l for l in str(edit.get("new_string") or "").splitlines() if l not in old)
    return "\n".join(chunks)


def extract(text: str, suffix: str, roots: list) -> set:
    libs = set()
    if suffix in PY_SUFFIXES:
        for line in text.splitlines():
            m = PY_IMPORT.match(line)
            if not m:
                continue
            top = (m.group(1) or m.group(2) or "").split(".")[0]
            if not top or top in STDLIB or top in PY_EXTRA_SKIP:
                continue
            if local_module(top, roots):
                continue
            libs.add(top)
    elif suffix in JS_SUFFIXES:
        for spec in JS_IMPORT.findall(text):
            if not spec or spec.startswith(JS_SKIP_PREFIX):
                continue
            parts = spec.split("/")
            libs.add("/".join(parts[:2]) if spec.startswith("@") else parts[0])
    return libs


def libs_from_edit(data: dict) -> set:
    """Third-party libs newly imported by this tool call, or an empty set.

    ``data`` is the Claude Code hook payload; other tools' plugins synthesise the
    same shape from their own kwargs.
    """
    tool_input = data.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        return set()

    # A failed or blocked write teaches the model nothing — stay quiet.
    extra = data.get("extra") or {}
    if isinstance(extra, dict) and extra.get("status") not in (None, "", "ok"):
        return set()

    file_path = (
        tool_input.get("file_path")        # Claude Code Edit/Write
        or tool_input.get("path")          # other tools' write_file / patch
        or tool_input.get("notebook_path")
        or ""
    )
    if not file_path or is_test(str(file_path)):
        return set()

    suffix = Path(str(file_path)).suffix.lower()
    if suffix not in PY_SUFFIXES | JS_SUFFIXES:
        return set()

    cwd = data.get("cwd") or os.getcwd()
    roots = [Path(str(file_path)).parent, Path(cwd), Path(cwd) / "src"]
    return extract(added_lines(tool_input), suffix, roots)


# --------------------------------------------------------------------------- claude code

def _state_path(session: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_-]", "", session or "") or "nosession"
    return STATE_DIR / f"{safe[:64]}.json"


def _load_seen(session: str) -> set:
    try:
        raw = json.loads(_state_path(session).read_text())
    except Exception:
        return set()
    if isinstance(raw, dict):
        raw = raw.get("seen") or []
    return set(raw) if isinstance(raw, list) else set()


def _save_seen(session: str, seen: set) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        p = _state_path(session)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(sorted(seen)))
        os.replace(tmp, p)
        _prune()
    except OSError:
        pass


def _prune() -> None:
    """Drop state files older than the TTL so the dir can't grow forever."""
    cutoff = time.time() - STATE_TTL_SECONDS
    try:
        for f in STATE_DIR.glob("*.json"):
            if f.stat().st_mtime < cutoff:
                f.unlink(missing_ok=True)
    except OSError:
        pass


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    if not isinstance(data, dict):
        return

    libs = libs_from_edit(data)
    if not libs:
        return

    session = data.get("session_id") or ""
    seen = _load_seen(session)
    fresh = sorted(libs - seen)
    if not fresh:
        return
    _save_seen(session, seen | libs)

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": REMINDER.format(libs=", ".join(fresh)),
        }
    }))


if __name__ == "__main__":
    main()
