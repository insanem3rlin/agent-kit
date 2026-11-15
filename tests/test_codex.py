"""The Codex adapter: role agents in ~/.codex/agents, the context7 hook in
~/.codex/hooks.json, and the hook's reading of apply_patch payloads."""
import json
import os
import subprocess
import sys

import pytest

from conftest import REPO

AGENTS = ("implementer", "researcher", "reviewer")


def test_codex_agents_say_what_the_claude_agents_say():
    tomllib = pytest.importorskip("tomllib")       # Python 3.11+
    for name in AGENTS:
        md = (REPO / f"adapters/claude-code/agents/{name}.md").read_text(encoding="utf-8")
        body = md.split("---\n", 2)[2].strip()
        t = tomllib.loads((REPO / f"adapters/codex/agents/{name}.toml").read_text(encoding="utf-8"))
        assert t["name"] == name and t["description"] and t["model"]
        assert t["developer_instructions"].strip() == body


def test_install_links_agents_and_merges_hook(env):
    env.tool(".codex")
    hp = env.home / ".codex/hooks.json"
    mine = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "mine"}]}]}}
    hp.write_text(json.dumps(mine))
    r = env.run("install", "--no-pull")
    assert r.returncode == 0, r.stdout + r.stderr
    for name in AGENTS:
        assert (env.home / f".codex/agents/{name}.toml").is_symlink()
    h = json.loads(hp.read_text())
    assert h["hooks"]["Stop"] == mine["hooks"]["Stop"]
    post = h["hooks"]["PostToolUse"]
    assert len(post) == 1 and "apply_patch" in post[0]["matcher"]
    assert post[0]["hooks"][0]["command"].endswith("hooks/context7_reminder.py")
    assert env.run("sync", "--no-pull").returncode == 0
    assert len(json.loads(hp.read_text())["hooks"]["PostToolUse"]) == 1     # no double entry
    r = env.run("doctor")
    assert r.returncode == 0 and "ok researcher.toml" in r.stdout, r.stdout

    r = env.run("uninstall")
    assert r.returncode == 0, r.stdout + r.stderr
    assert json.loads(hp.read_text()) == mine
    assert not any(p.is_symlink() for p in (env.home / ".codex/agents").glob("*"))


def test_hooks_file_the_kit_created_is_removed(env):
    env.tool(".codex")
    assert env.run("install", "--no-pull").returncode == 0
    assert (env.home / ".codex/hooks.json").is_file()
    assert env.run("uninstall").returncode == 0
    assert not (env.home / ".codex/hooks.json").exists()


def test_claude_only_machine_gets_no_codex_files(env):
    env.tool(".claude")
    assert env.run("install", "--no-pull").returncode == 0
    assert not (env.home / ".codex").exists()


def hook(tmp_path, patch):
    payload = {"session_id": "s1", "cwd": str(tmp_path), "hook_event_name": "PostToolUse",
               "tool_name": "apply_patch", "tool_input": {"command": patch}}
    r = subprocess.run([sys.executable, str(REPO / "hooks/context7_reminder.py")],
                       input=json.dumps(payload), capture_output=True, text=True,
                       env=dict(os.environ, AGENT_KIT_STATE=str(tmp_path / "state")))
    assert r.returncode == 0, r.stderr
    return r.stdout


def test_hook_reads_apply_patch(tmp_path):
    patch = ("*** Begin Patch\n"
             "*** Add File: app/main.py\n+import requests\n+import os\n"
             "*** Update File: web/view.ts\n@@ ctx\n-old\n+import React from 'react'\n"
             "*** Update File: tests/test_x.py\n+import pytest\n"
             "*** End Patch\n")
    ctx = json.loads(hook(tmp_path, patch))["hookSpecificOutput"]["additionalContext"]
    assert "(react, requests)" in ctx


def test_hook_resolves_patch_paths_against_session_cwd(tmp_path):
    (tmp_path / "app").mkdir()
    (tmp_path / "app/helpers.py").write_text("")
    # the hook runs from the test's cwd, not tmp_path; a sibling module is not third-party
    assert hook(tmp_path, "*** Begin Patch\n*** Add File: app/main.py\n+import helpers\n*** End Patch\n") == ""


def test_hook_follows_move_to(tmp_path):
    patch = ("*** Begin Patch\n*** Update File: tests/old.py\n*** Move to: app/new.py\n"
             "@@\n+import requests\n*** End Patch\n")
    assert "(requests)" in hook(tmp_path, patch)


def test_hook_quiet_for_stdlib_patch(tmp_path):
    assert hook(tmp_path, "*** Begin Patch\n*** Add File: a.py\n+import json\n*** End Patch\n") == ""
