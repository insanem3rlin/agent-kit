"""The Gemini CLI and Cursor adapters."""
import json
import os
import subprocess
import sys

import pytest

from conftest import REPO

AGENTS = ("implementer", "researcher", "reviewer")


def front(path):
    _, head, body = path.read_text(encoding="utf-8").split("---\n", 2)
    keys = dict(l.split(": ", 1) for l in head.splitlines() if ": " in l)
    return keys, body.strip()


@pytest.mark.parametrize("tool", ["gemini", "cursor"])
def test_agents_say_what_the_claude_agents_say(tool):
    for name in AGENTS:
        _, body = front(REPO / f"adapters/claude-code/agents/{name}.md")
        keys, mine = front(REPO / f"adapters/{tool}/agents/{name}.md")
        assert keys["name"] == name and keys["description"] and keys["model"]
        assert mine == body
        if tool == "cursor":
            assert keys.get("readonly") == ("true" if name == "researcher" else "false")


def test_gemini_install(env):
    env.tool(".gemini")
    sp = env.home / ".gemini/settings.json"
    sp.write_text(json.dumps({"theme": "Dark"}))
    r = env.run("install", "--no-pull")
    assert r.returncode == 0, r.stdout + r.stderr
    rules = (REPO / "rules/AGENTS.md").read_text(encoding="utf-8").strip()
    assert rules in (env.home / ".gemini/GEMINI.md").read_text(encoding="utf-8")
    assert (env.home / ".agents/skills/alpha").is_symlink()
    for name in AGENTS:
        assert (env.home / f".gemini/agents/{name}.md").is_symlink()
    s = json.loads(sp.read_text())
    assert s["theme"] == "Dark"
    after = s["hooks"]["AfterTool"]
    assert len(after) == 1 and "write_file" in after[0]["matcher"]
    assert env.run("sync", "--no-pull").returncode == 0
    assert len(json.loads(sp.read_text())["hooks"]["AfterTool"]) == 1
    r = env.run("doctor")
    assert r.returncode == 0 and "ok researcher.md" in r.stdout, r.stdout

    assert env.run("uninstall").returncode == 0
    assert json.loads(sp.read_text()) == {"theme": "Dark"}
    assert not (env.home / ".gemini/GEMINI.md").exists()
    assert not any(p.is_symlink() for p in (env.home / ".gemini/agents").glob("*"))


def test_cursor_install(env):
    env.tool(".cursor")
    r = env.run("install", "--no-pull")
    assert r.returncode == 0, r.stdout + r.stderr
    assert (env.home / ".agents/skills/alpha").is_symlink()
    for name in AGENTS:
        assert (env.home / f".cursor/agents/{name}.md").is_symlink()
    # Cursor runs the Claude Code hooks itself and has no rules file on disk
    assert sorted(p.name for p in (env.home / ".cursor").iterdir()) == ["agents"]
    assert env.run("uninstall").returncode == 0
    assert not any(p.is_symlink() for p in (env.home / ".cursor/agents").glob("*"))


def test_hook_answers_gemini_with_its_event_name(tmp_path):
    payload = {"session_id": "g1", "cwd": str(tmp_path), "hook_event_name": "AfterTool",
               "tool_name": "write_file",
               "tool_input": {"file_path": str(tmp_path / "a.py"), "content": "import requests\n"}}
    r = subprocess.run([sys.executable, str(REPO / "hooks/context7_reminder.py")],
                       input=json.dumps(payload), capture_output=True, text=True,
                       env=dict(os.environ, AGENT_KIT_STATE=str(tmp_path / "state")))
    out = json.loads(r.stdout)["hookSpecificOutput"]
    assert out["hookEventName"] == "AfterTool" and "(requests)" in out["additionalContext"]
