"""Tests for the context7 reminder hook (detection + Claude Code entry point)."""
import importlib.util
import io
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True

HOOK = Path(__file__).resolve().parent.parent / "context7_reminder.py"
spec = importlib.util.spec_from_file_location("context7_reminder", HOOK)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def payload(path, content, **extra):
    return {"tool_input": {"file_path": path, "content": content}, **extra}


def test_python_third_party_import_detected(tmp_path):
    data = payload(str(tmp_path / "app.py"), "import os\nimport requests\nfrom flask import Flask\n", cwd=str(tmp_path))
    assert mod.libs_from_edit(data) == {"requests", "flask"}


def test_stdlib_and_local_modules_skipped(tmp_path):
    (tmp_path / "helpers.py").write_text("")
    data = payload(str(tmp_path / "app.py"), "import json\nimport helpers\n", cwd=str(tmp_path))
    assert mod.libs_from_edit(data) == set()


def test_js_scoped_and_relative_imports(tmp_path):
    src = "import x from './x'\nimport {a} from '@scope/pkg/sub'\nconst r = require('react')\nimport fs from 'node:fs'\n"
    data = payload(str(tmp_path / "a.ts"), src, cwd=str(tmp_path))
    assert mod.libs_from_edit(data) == {"@scope/pkg", "react"}


def test_test_files_and_other_suffixes_ignored(tmp_path):
    assert mod.libs_from_edit(payload(str(tmp_path / "test_a.py"), "import requests\n")) == set()
    assert mod.libs_from_edit(payload(str(tmp_path / "a.md"), "import requests\n")) == set()


def test_failed_write_is_quiet(tmp_path):
    data = payload(str(tmp_path / "a.py"), "import requests\n", extra={"status": "error"})
    assert mod.libs_from_edit(data) == set()


def test_edit_only_counts_added_lines(tmp_path):
    data = {"tool_input": {"file_path": str(tmp_path / "a.py"),
                           "old_string": "import requests\n",
                           "new_string": "import requests\nimport httpx\n"},
            "cwd": str(tmp_path)}
    assert mod.libs_from_edit(data) == {"httpx"}


def test_main_reminds_once_per_session(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(mod, "STATE_DIR", tmp_path / "state")
    data = payload(str(tmp_path / "a.py"), "import requests\n", session_id="s1", cwd=str(tmp_path))
    for expect_output in (True, False):
        monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(data)))
        mod.main()
        out = capsys.readouterr().out
        assert bool(out) is expect_output
        if out:
            ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
            assert "requests" in ctx


def _load_fresh(name="c7_fresh"):
    sp = importlib.util.spec_from_file_location(name, HOOK)
    m = importlib.util.module_from_spec(sp)
    sp.loader.exec_module(m)
    return m


def test_state_dir_comes_from_agent_kit_state(monkeypatch):
    monkeypatch.setenv("AGENT_KIT_STATE", "/somewhere")
    monkeypatch.setenv("AGENT_KIT_HOME", "/the/checkout")
    assert _load_fresh().STATE_DIR == Path("/somewhere/context7-hook")


def test_state_dir_default_is_local_state(monkeypatch):
    monkeypatch.delenv("AGENT_KIT_STATE", raising=False)
    monkeypatch.setenv("AGENT_KIT_HOME", "/the/checkout")
    assert _load_fresh().STATE_DIR == Path.home() / ".local" / "state" / "agent-kit" / "context7-hook"


def test_stdlib_fallback_without_stdlib_module_names(tmp_path, monkeypatch):
    # Python 3.9 has no sys.stdlib_module_names; stdlib imports must stay quiet.
    monkeypatch.delattr(sys, "stdlib_module_names", raising=False)
    m = _load_fresh("c7_no_stdlib_names")
    src = "import json\nimport pathlib\nfrom collections import abc\nimport sys\nimport requests\n"
    data = payload(str(tmp_path / "a.py"), src, cwd=str(tmp_path))
    assert m.libs_from_edit(data) == {"requests"}
