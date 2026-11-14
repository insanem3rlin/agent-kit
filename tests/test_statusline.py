"""The status line reads no credentials and starts no usage lookup unless the
user enabled it in <config>/statusline.json."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "adapters/claude-code/statusline.py"


def run(tmp_path, config=None, home_files=None):
    home = tmp_path / "home"
    cfg = tmp_path / "config"
    state = tmp_path / "state"
    for d in (home, cfg):
        d.mkdir(exist_ok=True)
    for rel, text in (home_files or {}).items():
        f = home / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text)
    if config is not None:
        (cfg / "statusline.json").write_text(json.dumps(config))
    # a dead proxy: the detached usage refresh must never reach the real endpoint from a test
    env = dict(os.environ, HOME=str(home), AGENT_KIT_CONFIG=str(cfg), AGENT_KIT_STATE=str(state),
               HTTPS_PROXY="http://127.0.0.1:9", https_proxy="http://127.0.0.1:9")
    r = subprocess.run([sys.executable, str(SCRIPT)], input='{"model":{"display_name":"M"}}',
                       capture_output=True, text=True, env=env, timeout=20)
    return r, state


def test_default_shows_context_only_and_touches_nothing(tmp_path):
    creds = {".claude/.credentials.json": json.dumps({"claudeAiOauth": {"accessToken": "t"}})}
    r, state = run(tmp_path, home_files=creds)
    assert r.returncode == 0
    assert "M" in r.stdout and "0/280.0k" in r.stdout
    assert "5h" not in r.stdout
    time.sleep(0.3)
    assert not state.exists()          # no cache, no refresh attempt, no lookup started


def test_context_limit_from_config(tmp_path):
    r, _ = run(tmp_path, config={"context_limit": 500000})
    assert "0/500.0k" in r.stdout and "5h" not in r.stdout


def test_usage_segment_appears_once_enabled(tmp_path):
    token_file = tmp_path / "token.txt"
    token_file.write_text("placeholder\n")
    r, state = run(tmp_path, config={"usage_credentials": str(token_file)})
    assert r.returncode == 0 and "5h" in r.stdout
    assert (state / "statusline-usage.attempt").exists()


def test_broken_config_falls_back_to_defaults(tmp_path):
    cfg = tmp_path / "config"
    cfg.mkdir()
    (cfg / "statusline.json").write_text("{not json")
    r, _ = run(tmp_path)
    assert r.returncode == 0 and "0/280.0k" in r.stdout and "5h" not in r.stdout
