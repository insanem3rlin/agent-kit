import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "opponent.py"


class Env:
    def __init__(self, tmp_path):
        self.cfg = tmp_path / "cfg"
        self.bin = tmp_path / "bin"
        self.bin.mkdir()
        self.home = tmp_path / "home"
        self.home.mkdir()

    def stub(self, name, body="exit 0"):
        p = self.bin / name
        p.write_text("#!/bin/sh\n" + body + "\n")
        p.chmod(0o755)

    def run(self, *args):
        env = {"PATH": str(self.bin), "HOME": str(self.home), "AGENT_KIT_CONFIG": str(self.cfg)}
        r = subprocess.run([sys.executable, str(SCRIPT), *args], env=env, capture_output=True, text=True)
        return r


@pytest.fixture
def env(tmp_path):
    return Env(tmp_path)


def test_detect_lists_only_installed_known_clis(env):
    env.stub("claude")
    env.stub("codex")
    env.stub("unrelated")
    r = env.run("detect")
    assert r.returncode == 0
    found = {c["cli"]: c for c in json.loads(r.stdout)["available"]}
    assert set(found) == {"claude", "codex"}
    assert found["claude"]["vendor"] == "Anthropic"
    assert found["codex"]["vendor"] == "OpenAI"


def test_detect_empty(env):
    assert json.loads(env.run("detect").stdout)["available"] == []


def test_detect_hermes_vendor_from_configured_model(env):
    env.stub("hermes", "printf 'default: claude-sonnet-4\\nprovider: openrouter\\n'")
    c = json.loads(env.run("detect").stdout)["available"][0]
    assert c["cli"] == "hermes" and c["vendor"] == "Anthropic" and c["model"] == "claude-sonnet-4"


def test_detect_hermes_vendor_from_provider_when_model_opaque(env):
    env.stub("hermes", "printf 'default: terra-9\\nprovider: openai-codex\\n'")
    c = json.loads(env.run("detect").stdout)["available"][0]
    assert c["vendor"] == "OpenAI"


def test_detect_opencode_vendor_from_config(env):
    env.stub("opencode")
    d = env.home / ".config" / "opencode"
    d.mkdir(parents=True)
    (d / "opencode.json").write_text(json.dumps({"model": "google/gemini-3-pro"}))
    c = json.loads(env.run("detect").stdout)["available"][0]
    assert c["vendor"] == "Google" and c["model"] == "google/gemini-3-pro"


def test_detect_unknown_vendor_is_null(env):
    env.stub("opencode")
    c = json.loads(env.run("detect").stdout)["available"][0]
    assert c["vendor"] is None


def test_get_absent_then_set_get_reset(env):
    assert json.loads(env.run("get").stdout) == {"configured": False}
    r = env.run("set", "--cli", "codex", "--own-vendor", "Anthropic")
    assert r.returncode == 0
    saved = json.loads((env.cfg / "debate-opponent.json").read_text())
    assert saved == {"cli": "codex", "model": None, "vendor": "OpenAI"}
    got = json.loads(env.run("get", "--own-vendor", "Anthropic").stdout)
    assert got["configured"] is True and got["cli"] == "codex" and got["same_vendor"] is False
    assert json.loads(env.run("reset").stdout)["removed"] is True
    assert not (env.cfg / "debate-opponent.json").exists()
    assert json.loads(env.run("reset").stdout)["removed"] is False


def test_set_refuses_same_vendor(env):
    r = env.run("set", "--cli", "claude", "--own-vendor", "anthropic")
    assert r.returncode == 2
    assert not (env.cfg / "debate-opponent.json").exists()


def test_get_flags_same_vendor(env):
    env.cfg.mkdir()
    (env.cfg / "debate-opponent.json").write_text(json.dumps({"cli": "claude", "model": None, "vendor": "Anthropic"}))
    assert json.loads(env.run("get", "--own-vendor", "Anthropic").stdout)["same_vendor"] is True


def test_set_rejects_unknown_cli_and_unknown_vendor(env):
    assert env.run("set", "--cli", "bogus").returncode == 2
    env.stub("opencode")
    assert env.run("set", "--cli", "opencode").returncode == 2  # vendor not resolvable
    r = env.run("set", "--cli", "opencode", "--vendor", "Mistral", "--model", "m/x")
    assert r.returncode == 0
    assert json.loads((env.cfg / "debate-opponent.json").read_text())["model"] == "m/x"


def test_corrupt_state_file_reported(env):
    env.cfg.mkdir()
    (env.cfg / "debate-opponent.json").write_text("{nope")
    assert json.loads(env.run("get").stdout) == {"configured": False, "error": "unreadable state file"}
